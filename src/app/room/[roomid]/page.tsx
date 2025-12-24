"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUserData } from "@/context/UserDataProvider";
import EmojiPicker from "emoji-picker-react";
import toast from "react-hot-toast";
import {
  FaMicrophone,
  FaMicrophoneSlash,
  FaVideo,
  FaVideoSlash,
  FaDesktop,
  FaPhoneSlash,
  FaShare,
  FaPaperclip,
} from "react-icons/fa";
import { SupabaseService, ChatMessage, TypingStatus } from "@/lib/videocall/supabaseService";
import { WebRTCService } from "@/lib/videocall/webrtcService";
import { MediaService } from "@/lib/videocall/mediaService";

interface RoomParams {
  roomid: string;
}

export default function RoomPage({ params }: { params: RoomParams }) {
  const router = useRouter();
  const { mentor } = useUserData();
  const roomId = params.roomid;

  // User info
  const userId = mentor?.id || `guest-${Math.floor(Math.random() * 999999)}`;
  const userName = mentor?.full_name || "Guest";

  // WebRTC & Media refs
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const webrtcServiceRef = useRef<WebRTCService | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  // Subscriptions
  const channelRef = useRef<any>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // State
  const [joined, setJoined] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showChatPanel, setShowChatPanel] = useState(true);
  
  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [remoteUser, setRemoteUser] = useState<TypingStatus | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [sessionTimer, setSessionTimer] = useState(0);
  const [debugInfo, setDebugInfo] = useState({
    roomId: "",
    userId: "",
    userName: "",
    connected: false,
    localStreamActive: false,
    remoteStreamActive: false,
  });

  // Auto-scroll to latest message
  useEffect(() => {
    const chatContainer = document.getElementById("chat-messages");
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }, [chatMessages]);

  // ===================================================================
  // 🚀 Initialize Room & WebRTC Connection
  // ===================================================================
  useEffect(() => {
    if (!roomId || sessionEnded) return;

    const initializeRoom = async () => {
      try {
        // REQUEST PERMISSIONS FIRST (before anything else)
        console.log("🔐 REQUESTING PERMISSIONS IMMEDIATELY...");
        
        let stream: MediaStream;
        try {
          // Request permissions directly and immediately
          stream = await MediaService.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          console.log("✅ PERMISSIONS GRANTED IMMEDIATELY!");
        } catch (mediaError: any) {
          console.error("❌ Permission denied or device error:", mediaError.name);
          
          let errorMsg = "Failed to access camera/microphone";
          if (mediaError.name === "NotAllowedError") {
            errorMsg = "❌ PERMISSION DENIED\n\nGrant camera/microphone access:\n1. Click 🎥 camera icon in address bar\n2. Select 'Allow'\n3. Refresh page";
          } else if (mediaError.name === "NotFoundError") {
            errorMsg = "❌ No camera/microphone found on device";
          } else if (mediaError.name === "NotReadableError") {
            errorMsg = "❌ Camera/Microphone in use by another app";
          }
          
          console.error(errorMsg);
          toast.error(errorMsg);
          throw mediaError;
        }
        
        localStreamRef.current = stream;
        console.log("✅ Local stream ready, tracks:", stream.getTracks().map(t => t.kind));

        // Auto-enable microphone and camera
        MediaService.toggleAudio(stream, true);
        MediaService.toggleVideo(stream, true);
        setIsAudioEnabled(true);
        setIsVideoEnabled(true);
        console.log("✅ Audio/Video auto-enabled");

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.play().catch((e) => {
            console.warn("Auto-play:", e.message);
          });
        }

        // Get room info
        const room = await SupabaseService.getRoom(roomId);
        if (room.status === "ended") {
          setSessionEnded(true);
          router.push("/");
          return;
        }

        // Initialize WebRTC
        const webrtcService = new WebRTCService([
          { urls: "stun:stun.l.google.com:19302" },
          {
            urls: "turn:global.relay.metered.ca:80",
            username: "openai",
            credential: "12345",
          },
        ]);

        await webrtcService.initialize(stream);
        webrtcServiceRef.current = webrtcService;

        // Handle remote stream
        webrtcService.onRemoteTrack((remoteStream) => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
          }
        });

        // Handle ICE candidates
        webrtcService.onIceCandidate(async (candidate) => {
          await SupabaseService.storeSignal({
            room_id: roomId,
            sender_id: userId,
            receiver_id: undefined,
            signal_type: "ice-candidate",
            signal_data: candidate.candidate,
          });
        });

        // Check if we should create offer or wait for answer
        const existingSignals = await SupabaseService.getSignals(roomId);
        if (existingSignals.length === 0) {
          const offer = await webrtcService.createOffer();
          await SupabaseService.storeSignal({
            room_id: roomId,
            sender_id: userId,
            receiver_id: undefined,
            signal_type: "offer",
            signal_data: offer,
          });
        }

        // Subscribe to signals
        subscribeToSignals();

        // Get chat history
        const history = await SupabaseService.getChatHistory(roomId);
        setChatMessages(history);

        // Subscribe to chat
        subscribeToChat();

        // Subscribe to typing status
        subscribeToTypingStatus();

        setJoined(true);
        
        console.log("✅ Room initialized!");
      } catch (error) {
        console.error("❌ Init error:", error);
        toast.error("Failed to initialize room");
      }
    };

    initializeRoom();

    return () => {
      cleanup();
    };
  }, [roomId]);

  // ===================================================================
  // 📡 WebRTC Signaling
  // ===================================================================
  const subscribeToSignals = () => {
    const subscription = SupabaseService.subscribeToSignals(roomId, async (signal) => {
      if (signal.sender_id === userId) return;

      try {
        if (signal.signal_type === "offer") {
          const answer = await webrtcServiceRef.current!.createAnswer(signal.signal_data);
          await SupabaseService.storeSignal({
            room_id: roomId,
            sender_id: userId,
            receiver_id: signal.sender_id,
            signal_type: "answer",
            signal_data: answer,
          });
        } else if (signal.signal_type === "answer") {
          await webrtcServiceRef.current!.setRemoteDescription(signal.signal_data);
        } else if (signal.signal_type === "ice-candidate") {
          await webrtcServiceRef.current!.addIceCandidate({
            candidate: signal.signal_data,
            sdpMLineIndex: 0,
            sdpMid: "0",
          });
        }
      } catch (error) {
        console.error("Error processing signal:", error);
      }
    });

    channelRef.current = subscription;
  };

  // ===================================================================
  // 💬 Chat
  // ===================================================================
  const subscribeToChat = () => {
    SupabaseService.subscribeToChat(roomId, (message) => {
      setChatMessages((prev) => [...prev, message]);
    });
  };

  const sendMessage = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
    }
    
    if (!newMessage.trim()) {
      console.warn("Message is empty");
      return;
    }

    try {
      console.log("Sending message:", newMessage);
      const msg = newMessage;
      setNewMessage("");
      
      // Add message to local chat immediately (optimistic update)
      const newMsg: ChatMessage = {
        id: Math.random().toString(),
        room_id: roomId,
        user_id: userId,
        user_name: userName,
        message: msg,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setChatMessages((prev) => [...prev, newMsg]);
      
      await SupabaseService.sendMessage({
        room_id: roomId,
        user_id: userId,
        user_name: userName,
        message: msg,
      });
      console.log("Message sent successfully");

      // Update typing status
      await SupabaseService.updateTypingStatus(roomId, userId, false, userName);
    } catch (error) {
      console.error("Error sending message:", error);
      toast.error("Failed to send message");
    }
  };

  const subscribeToTypingStatus = () => {
    SupabaseService.subscribeToTypingStatus(roomId, (status) => {
      if (status.user_id !== userId) {
        setRemoteUser(status);
      }
    });
  };

  const handleMessageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);

    // Update typing status
    clearTimeout(typingTimeoutRef.current!);
    try {
      await SupabaseService.updateTypingStatus(roomId, userId, true, userName);
    } catch (error) {
      console.error("Error updating typing status:", error);
    }

    typingTimeoutRef.current = setTimeout(async () => {
      try {
        await SupabaseService.updateTypingStatus(roomId, userId, false, userName);
      } catch (error) {
        console.error("Error clearing typing status:", error);
      }
    }, 2000);
  };

  // ===================================================================
  // 🎥 Media Controls
  // ===================================================================
  const toggleAudio = () => {
    if (!localStreamRef.current) {
      console.warn("⚠️ Waiting for local stream...");
      toast.error("Camera/Microphone still initializing...");
      return;
    }
    
    try {
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length === 0) {
        console.error("No audio tracks available");
        toast.error("No microphone available");
        return;
      }

      const enabled = !isAudioEnabled;
      MediaService.toggleAudio(localStreamRef.current, enabled);
      setIsAudioEnabled(enabled);
      console.log("🎤 Microphone toggled:", enabled ? "ON" : "OFF");
      toast.success(enabled ? "🎤 Mic ON" : "🔇 Mic OFF");
    } catch (error) {
      console.error("Error toggling audio:", error);
      toast.error("Failed to toggle microphone");
    }
  };

  const toggleVideo = () => {
    if (!localStreamRef.current) {
      console.warn("⚠️ Waiting for local stream...");
      toast.error("Camera/Microphone still initializing...");
      return;
    }
    
    try {
      const videoTracks = localStreamRef.current.getVideoTracks();
      if (videoTracks.length === 0) {
        console.error("No video tracks available");
        toast.error("No camera available");
        return;
      }

      const enabled = !isVideoEnabled;
      MediaService.toggleVideo(localStreamRef.current, enabled);
      setIsVideoEnabled(enabled);
      console.log("📹 Camera toggled:", enabled ? "ON" : "OFF");
      toast.success(enabled ? "📹 Camera ON" : "📷 Camera OFF");
    } catch (error) {
      console.error("Error toggling video:", error);
      toast.error("Failed to toggle camera");
    }
  };

  const toggleScreenShare = async () => {
    try {
      if (!isScreenSharing) {
        const screenStream = await MediaService.getScreenMedia();
        screenStreamRef.current = screenStream;

        const screenTrack = screenStream.getVideoTracks()[0];
        await MediaService.replaceTrack(
          webrtcServiceRef.current!.getPeerConnection(),
          screenStream,
          "video"
        );

        // Handle screen share stop
        screenTrack.onended = async () => {
          if (localStreamRef.current) {
            await MediaService.replaceTrack(
              webrtcServiceRef.current!.getPeerConnection(),
              localStreamRef.current,
              "video"
            );
          }
          setIsScreenSharing(false);
          toast.success("Screen share stopped");
        };

        setIsScreenSharing(true);
        toast.success("Screen sharing started");
      } else {
        if (screenStreamRef.current) {
          MediaService.stopTracks(screenStreamRef.current);
        }
        if (localStreamRef.current) {
          await MediaService.replaceTrack(
            webrtcServiceRef.current!.getPeerConnection(),
            localStreamRef.current,
            "video"
          );
        }
        setIsScreenSharing(false);
        toast.success("Screen share stopped");
      }
    } catch (error) {
      console.error("Screen share error:", error);
      toast.error("Failed to share screen");
    }
  };

  // ===================================================================
  // 🔴 End Session
  // ===================================================================
  const endSession = async () => {
    try {
      await SupabaseService.updateRoomStatus(roomId, "ended");
      cleanup();
      setSessionEnded(true);
      toast.success("Session ended");
      router.push("/");
    } catch (error) {
      toast.error("Failed to end session");
    }
  };

  const cleanup = () => {
    webrtcServiceRef.current?.close();
    if (localStreamRef.current) {
      MediaService.stopTracks(localStreamRef.current);
    }
    if (screenStreamRef.current) {
      MediaService.stopTracks(screenStreamRef.current);
    }
    if (channelRef.current) {
      channelRef.current.unsubscribe();
    }
  };

  // ===================================================================
  // 📱 UI Render
  // ===================================================================
  if (sessionEnded) {
    return (
      <div className="flex items-center justify-center h-screen bg-black text-white">
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4">Session Ended</h1>
          <p className="text-lg text-gray-400">Thank you for the mentoring session!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-black text-white">
      {/* Main Video Area */}
      <div className="flex-1 flex flex-col p-4">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-2xl font-bold">Room: {roomId}</h1>
        </div>

        {/* Video Container */}
        <div className="flex-1 relative bg-gray-900 rounded-lg overflow-hidden mb-4">
          {/* Remote Video (Large) */}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover bg-black"
          />
          


          {/* Local Video (Picture in Picture) */}
          {localStreamRef.current && (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="absolute bottom-4 right-4 w-48 h-32 bg-black rounded-lg border-2 border-white object-cover"
            />
          )}
          
          {!localStreamRef.current && joined && (
            <div className="absolute bottom-4 right-4 w-48 h-32 bg-gray-800 rounded-lg border-2 border-red-500 flex items-center justify-center">
              <div className="text-center text-red-400">
                <p className="text-sm">❌ Camera Not</p>
                <p className="text-sm">Available</p>
              </div>
            </div>
          )}

          {/* Control Bar */}
          <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex gap-4 bg-black bg-opacity-50 px-6 py-4 rounded-full">
            <button
              onClick={toggleAudio}
              disabled={!localStreamRef.current}
              className={`p-3 rounded-full transition ${
                !localStreamRef.current ? "bg-gray-600 cursor-not-allowed" :
                isAudioEnabled
                  ? "bg-blue-600 hover:bg-blue-700"
                  : "bg-red-600 hover:bg-red-700"
              }`}
              title={isAudioEnabled ? "Mute" : "Unmute"}
            >
              {isAudioEnabled ? <FaMicrophone /> : <FaMicrophoneSlash />}
            </button>

            <button
              onClick={toggleVideo}
              disabled={!localStreamRef.current}
              className={`p-3 rounded-full transition ${
                !localStreamRef.current ? "bg-gray-600 cursor-not-allowed" :
                isVideoEnabled
                  ? "bg-blue-600 hover:bg-blue-700"
                  : "bg-red-600 hover:bg-red-700"
              }`}
              title={isVideoEnabled ? "Stop Camera" : "Start Camera"}
            >
              {isVideoEnabled ? <FaVideo /> : <FaVideoSlash />}
            </button>

            <button
              onClick={toggleScreenShare}
              className={`p-3 rounded-full transition ${
                isScreenSharing
                  ? "bg-green-600 hover:bg-green-700"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
              title="Share Screen"
            >
              <FaDesktop />
            </button>

            <button
              onClick={endSession}
              className="p-3 rounded-full bg-red-600 hover:bg-red-700 transition"
              title="End Call"
            >
              <FaPhoneSlash />
            </button>
          </div>
        </div>
      </div>

      {/* Chat Panel */}
      {showChatPanel && (
        <div className="w-80 bg-gray-900 flex flex-col border-l border-gray-700">
          {/* Chat Header */}
          <div className="p-4 border-b border-gray-700">
            <h3 className="text-lg font-semibold">Chat</h3>
          </div>

          {/* Messages */}
          <div id="chat-messages" className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatMessages.length === 0 && (
              <p className="text-gray-500 text-center text-sm">No messages yet. Start chatting!</p>
            )}
            {chatMessages.map((msg, idx) => (
              <div key={msg.id || idx} className={`text-sm ${msg.user_id === userId ? 'text-right' : ''}`}>
                <p className={`font-semibold ${msg.user_id === userId ? 'text-green-400' : 'text-blue-400'}`}>
                  {msg.user_name}
                </p>
                <p className={`text-gray-300 break-words p-2 rounded ${msg.user_id === userId ? 'bg-green-900 bg-opacity-30' : 'bg-blue-900 bg-opacity-30'}`}>
                  {msg.message}
                </p>
              </div>
            ))}
            {remoteUser?.is_typing && (
              <div className="text-sm text-gray-500 italic">
                {remoteUser.user_name} is typing...
              </div>
            )}
          </div>

          {/* Emoji Picker */}
          {showEmojiPicker && (
            <div className="border-t border-gray-700 p-2">
              <EmojiPicker
                onEmojiClick={(emoji: any) => {
                  setNewMessage((prev) => prev + emoji.emoji);
                  setShowEmojiPicker(false);
                }}
              />
            </div>
          )}

          {/* Input Area */}
          <div className="border-t border-gray-700 p-4 space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={newMessage}
                onChange={handleMessageChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Type a message..."
                className="flex-1 bg-gray-800 text-white rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                className="p-2 hover:bg-gray-800 rounded transition"
              >
                😊
              </button>
            </div>
            <button
              type="button"
              onClick={(e) => sendMessage(e)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded py-2 text-sm font-semibold transition"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
