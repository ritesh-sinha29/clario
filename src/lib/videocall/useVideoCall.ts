import { useState, useCallback, useRef, useEffect } from 'react';
import { SupabaseService, Signal } from './supabaseService';
import { WebRTCService } from './webrtcService';
import { MediaService } from './mediaService';
import { supabase } from './supabaseClient';
import toast from 'react-hot-toast';

interface UseVideoCallProps {
  mentorId?: string;
  durationMinutes?: number;
}

export const useVideoCall = ({ mentorId, durationMinutes }: UseVideoCallProps = {}) => {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [connectionState, setConnectionState] = useState<RTCIceConnectionState>('new');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const webrtcServiceRef = useRef<WebRTCService | null>(null);
  const subscriptionRef = useRef<any>(null);

  // Initialize User ID
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) setUserId(data.user.id);
    });
  }, []);

  const cleanup = useCallback(() => {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    webrtcServiceRef.current?.close();
    webrtcServiceRef.current = null;
    if (subscriptionRef.current) {
      supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setRoomId(null);
    setConnectionState('closed');
  }, []); // Remove localStream dependency to prevent premature cleanup

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Initialize WebRTC and Signaling
  const initializeSession = useCallback(async (currentRoomId: string, currentUserId: string) => {
    try {
      // 1. Get Local Media with adaptive quality (Zoom-like)
      const stream = await MediaService.getUserMedia('hd'); // Can be 'hd', 'sd', or 'low'
      setLocalStream(stream);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // 2. Init WebRTC Service
      const webrtc = new WebRTCService();
      webrtcServiceRef.current = webrtc;
      await webrtc.initialize(stream);

      // Monitor connection state
      webrtc.getPeerConnection().oniceconnectionstatechange = () => {
        const state = webrtc.getPeerConnection().iceConnectionState;
        console.log('🔌 Hook: ICE Connection State:', state);
        setConnectionState(state);
      };

      // Handle Remote Track
      webrtc.onRemoteTrack((stream) => {
        console.log("✅ Remote stream received! Tracks:", stream.getTracks().length);
        setRemoteStream(stream);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
          // Explicitly try to play
          remoteVideoRef.current.play().catch(e => console.log("Play error (usually okay):", e));
          console.log("✅ Remote video element updated and playing");
        }
      });

      // Handle ICE Candidates -> Send to Supabase
      webrtc.onIceCandidate(async (candidate) => {
        if (candidate) {
          await SupabaseService.storeSignal({
            room_id: currentRoomId,
            sender_id: currentUserId,
            signal_type: 'ice',
            signal_data: candidate.toJSON(),
          });
        }
      });

      // 3. Subscribe to Signals
      const subscription = SupabaseService.subscribeToSignals(currentRoomId, async (signal) => {
        if (signal.sender_id === currentUserId) return; // Ignore own signals
        console.log(`📡 Signal received: ${signal.signal_type} from ${signal.sender_id}`);

        try {
          const pc = webrtc.getPeerConnection();
          const currentState = pc.signalingState;
          console.log(`🔍 Current Signaling State: ${currentState}`);

          if (signal.signal_type === 'offer') {
            // Handle Offer Collision (Glare)
            if (pc.signalingState !== 'stable') {
              console.warn(`⚠️ Glare detected! State is '${currentState}'. Rolling back to accept new offer...`);

              // Rollback local offer to accept incoming one (Polite Peer strategy)
              try {
                // @ts-ignore - 'rollback' is valid in spec but sometimes missing in TS types
                await pc.setLocalDescription({ type: 'rollback' });
                console.log("✅ Rolled back local offer");
              } catch (rollbackErr) {
                console.error("❌ Rollback failed:", rollbackErr);
                // If rollback fails, we might be stuck. But usually it works.
                return;
              }
            }

            console.log("📞 Processing incoming offer...");
            toast('Incoming call connection...', { icon: '📞' });

            // createAnswer will setRemoteDescription internally
            const answer = await webrtc.createAnswer(signal.signal_data);
            console.log("📞 Created answer, sending...");

            await SupabaseService.storeSignal({
              room_id: currentRoomId,
              sender_id: currentUserId,
              signal_type: 'answer',
              signal_data: answer,
            });
            console.log("📞 Answer sent!");
          } else if (signal.signal_type === 'answer') {
            // Only process answer if we're waiting for one
            if (pc.signalingState !== 'have-local-offer') {
              console.warn(`⚠️ Ignoring answer - state is '${pc.signalingState}', expected 'have-local-offer'`);
              return;
            }
            console.log("📞 Processing answer...");
            await webrtc.setRemoteDescription(signal.signal_data);
            console.log("📞 Remote description set from answer!");
          } else if (signal.signal_type === 'ice') {
            // console.log("🧊 Adding ICE candidate...");
            await webrtc.addIceCandidate(signal.signal_data).catch(e => console.error("❌ Add ICE Error:", e));
          }
        } catch (err) {
          console.error(`❌ Error processing signal ${signal.signal_type}:`, err);
        }
      });
      subscriptionRef.current = subscription;

      // 4. Check for existing offer (if we are joining)
      // Get signals (already filtered to last 2 mins by service)
      const signals = await SupabaseService.getSignals(currentRoomId);

      // Find the LATEST offer
      const offers = signals.filter(s => s.signal_type === 'offer');
      // Sort by created_at desc to get latest first
      offers.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const latestOffer = offers[0];

      if (!latestOffer) {
        // No offer found, so we create one (we are the caller)
        console.log("📞 No offer found, creating offer...");
        const offer = await webrtc.createOffer();
        await SupabaseService.storeSignal({
          room_id: currentRoomId,
          sender_id: currentUserId,
          signal_type: 'offer',
          signal_data: offer,
        });
        console.log("📞 Offer created and sent!");
      } else if (latestOffer.sender_id !== currentUserId) {
        // Offer exists from someone else (we are the callee), process it
        console.log(`📞 Found latest offer from ${latestOffer.sender_id} (${latestOffer.created_at})`);

        // Process the latest offer
        const answer = await webrtc.createAnswer(latestOffer.signal_data);
        await SupabaseService.storeSignal({
          room_id: currentRoomId,
          sender_id: currentUserId,
          signal_type: 'answer',
          signal_data: answer,
        });
        console.log("📞 Answer sent!");

        // Process ONLY ICE candidates that came AFTER the latest offer
        const offerTime = new Date(latestOffer.created_at).getTime();
        const relevantIce = signals.filter(s =>
          s.signal_type === 'ice' &&
          s.sender_id !== currentUserId &&
          new Date(s.created_at).getTime() >= offerTime
        );

        console.log(`🧊 Processing ${relevantIce.length} relevant ICE candidates (filtered from ${signals.length})`);
        for (const ice of relevantIce) {
          await webrtc.addIceCandidate(ice.signal_data);
        }
      } else {
        console.log("📞 Found our own latest offer, waiting for answer...");
      }
    } catch (err) {
      console.error('Initialization error:', err);
      throw err;
    }
  }, []);

  const joinSession = useCallback(async (existingRoomId: string) => {
    if (!userId) {
      // Try to get authenticated user
      const { data } = await supabase.auth.getUser();
      let currentUserId: string;

      if (data.user) {
        currentUserId = data.user.id;
        setUserId(currentUserId);
      } else {
        // No authenticated user - use stored guest ID or generate new one
        let storedGuestId = localStorage.getItem('clario_guest_id');
        if (!storedGuestId) {
          storedGuestId = `guest-${Math.random().toString(36).substring(2, 15)}`;
          localStorage.setItem('clario_guest_id', storedGuestId);
        }
        currentUserId = storedGuestId;
        setUserId(storedGuestId);
        console.log('Using guest ID:', storedGuestId);
      }

      return joinSessionWithUser(existingRoomId, currentUserId);
    }
    return joinSessionWithUser(existingRoomId, userId);
  }, [userId, initializeSession]);

  const joinSessionWithUser = async (targetRoomId: string, currentUserId: string) => {
    try {
      setIsLoading(true);
      setError(null);
      setRoomId(targetRoomId);

      await initializeSession(targetRoomId, currentUserId);

      toast.success('Joined session');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to join session';
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  const startSession = useCallback(async () => {
    // Get or create user ID
    let currentUserId = userId;
    if (!userId) {
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        currentUserId = data.user.id;
        setUserId(currentUserId);
      } else {
        // Generate temporary guest ID
        const tempId = `guest-${Math.random().toString(36).substring(2, 15)}`;
        currentUserId = tempId;
        setUserId(tempId);
        console.log('Using temporary guest ID:', tempId);
      }
    }

    if (!mentorId || !durationMinutes) {
      toast.error('Missing session details');
      return;
    }

    try {
      console.log('🚀 Starting session for user:', currentUserId);
      setIsLoading(true);
      setError(null);

      const room = await SupabaseService.createRoom(mentorId, durationMinutes);
      console.log('✅ Room created:', room.id);
      setRoomId(room.id);

      await initializeSession(room.id, currentUserId!);

      toast.success('Session started successfully');
      console.log('✅ Session started successfully');
      return room.id;
    } catch (err) {
      console.error('❌ Failed to start session:', err);
      const errorMsg = err instanceof Error ? err.message : 'Failed to start session';
      setError(errorMsg);
      toast.error(`Start failed: ${errorMsg}`);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [mentorId, durationMinutes, userId, initializeSession]);

  const endSession = useCallback(async () => {
    try {
      if (roomId) {
        await SupabaseService.updateRoomStatus(roomId, 'ended');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to end session';
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      cleanup();
    }
  }, [roomId, cleanup]);

  const leaveSession = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const toggleCamera = useCallback((enabled?: boolean) => {
    if (localStream) {
      const newState = enabled !== undefined ? enabled : !isCameraOn;
      MediaService.toggleVideo(localStream, newState);
      setIsCameraOn(newState);
      toast.success(newState ? 'Camera on' : 'Camera off');
    }
  }, [localStream, isCameraOn]);

  const toggleMicrophone = useCallback((enabled?: boolean) => {
    if (localStream) {
      const newState = enabled !== undefined ? enabled : !isMicOn;
      MediaService.toggleAudio(localStream, newState);
      setIsMicOn(newState);
      toast.success(newState ? 'Microphone on' : 'Microphone off');
    }
  }, [localStream, isMicOn]);

  const shareScreen = useCallback(async () => {
    try {
      console.log("📺 Starting screen share...");
      const screenStream = await MediaService.getScreenMedia();
      const screenTrack = screenStream.getVideoTracks()[0];
      console.log("📺 Got screen track:", screenTrack?.label);

      // Update local video to show the screen
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
      }

      if (webrtcServiceRef.current) {
        const pc = webrtcServiceRef.current.getPeerConnection();
        if (!pc) {
          console.error("❌ No peer connection");
          toast.error("Not connected to a call yet");
          return;
        }

        const senders = pc.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === 'video');
        console.log("📺 Video sender found:", !!videoSender);

        if (videoSender) {
          // Replace existing video track with screen
          await videoSender.replaceTrack(screenTrack);
        } else {
          // No video track - add screen track as new
          console.log("📺 Adding screen as new track");
          pc.addTrack(screenTrack, screenStream);
        }

        setIsScreenSharing(true);
        toast.success('Screen sharing started');

        // When user stops sharing via browser UI
        screenTrack.onended = async () => {
          console.log("📺 Screen share ended by user");
          if (localStream && localVideoRef.current) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoSender && videoTrack) {
              await videoSender.replaceTrack(videoTrack);
            }
            localVideoRef.current.srcObject = localStream;
          }
          setIsScreenSharing(false);
          toast.success('Screen sharing stopped');
        };
      } else {
        console.error("❌ WebRTC service not initialized");
        toast.error("Not connected to a call yet");
      }
    } catch (err) {
      console.error("❌ Screen share error:", err);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        toast.error('Screen sharing cancelled');
      } else {
        toast.error('Failed to share screen');
      }
    }
  }, [localStream, localVideoRef]);

  const stopScreenShare = useCallback(async () => {
    try {
      if (localStream && webrtcServiceRef.current) {
        const videoTrack = localStream.getVideoTracks()[0];
        const pc = webrtcServiceRef.current.getPeerConnection();
        const senders = await pc.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === 'video');

        if (videoSender && videoTrack) {
          await videoSender.replaceTrack(videoTrack);
          setIsScreenSharing(false);
          toast.success('Screen sharing stopped');
        }
      }
    } catch (err) {
      toast.error('Failed to stop screen sharing');
    }
  }, [localStream]);

  const sendChatMessage = useCallback(async (message: string) => {
    if (!roomId || !userId) return;
    try {
      await SupabaseService.sendMessage({
        room_id: roomId,
        user_id: userId,
        user_name: 'User', // TODO: Fetch real name
        message,
      });
    } catch (err) {
      toast.error('Failed to send message');
    }
  }, [roomId, userId]);

  const updateTypingStatus = useCallback(async (isTyping: boolean) => {
    if (!roomId || !userId) return;
    try {
      await SupabaseService.updateTypingStatus(roomId, userId, isTyping, 'User');
    } catch (err) {
      console.error('Failed to update typing status:', err);
    }
  }, [roomId, userId]);

  return {
    roomId,
    userId,
    isLoading,
    error,
    localStream,
    remoteStream,
    localVideoRef,
    remoteVideoRef,
    isCameraOn,
    isMicOn,
    isScreenSharing,
    connectionState,
    joinSession,
    startSession,
    endSession,
    leaveSession,
    toggleCamera,
    toggleMicrophone,
    shareScreen,
    stopScreenShare,
    sendChatMessage,
    updateTypingStatus,
  };
};
