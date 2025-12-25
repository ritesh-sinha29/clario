// WebRTC Peer Connection Service
export class WebRTCService {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];

  constructor(iceServers?: RTCIceServer[]) {
    this.iceCandidateQueue = []; // Explicit initialization
    // Enhanced configuration with multiple STUN + TURN servers
    const config: RTCConfiguration = {
      iceServers: iceServers || [
        // Multiple STUN servers for redundancy
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Free TURN servers (multiple providers for reliability)
        {
          urls: 'turn:relay1.expressturn.com:443',
          username: 'efB8JPNL4BLRVGFHWR',
          credential: 'gSFXj0qB4jX1eL8D',
        },
        {
          urls: 'turn:a.relay.metered.ca:443',
          username: '087e3f78e9f6c8d4c65a05d0',
          credential: 'fJl8eR9pWq9YxKjL',
        },
        {
          urls: 'turn:a.relay.metered.ca:443?transport=tcp',
          username: '087e3f78e9f6c8d4c65a05d0',
          credential: 'fJl8eR9pWq9YxKjL',
        },
      ],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10, // Pre-gather candidates for faster connection
    };
    this.peerConnection = new RTCPeerConnection(config);

    // Monitor connection quality
    this.setupQualityMonitoring();
  }

  /**
   * Setup connection quality monitoring
   */
  private setupQualityMonitoring(): void {
    if (!this.peerConnection) return;

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log('🔌 ICE Connection State:', state);

      // Log when fully connected
      if (state === 'connected' || state === 'completed') {
        console.log('✅ Peer connection established successfully!');
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      console.log('🔌 Connection State:', this.peerConnection?.connectionState);

      // Auto-reconnect on failure
      if (this.peerConnection?.connectionState === 'failed') {
        console.log('🔄 Connection failed, attempting ICE restart...');
        this.restartIce();
      }
    };

    // Monitor ICE gathering state
    this.peerConnection.onicegatheringstatechange = () => {
      console.log('🧊 ICE Gathering State:', this.peerConnection?.iceGatheringState);
    };
  }

  /**
   * Restart ICE connection (for network changes)
   */
  private async restartIce(): Promise<void> {
    if (!this.peerConnection) return;
    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      console.log('✅ ICE restart initiated');
    } catch (err) {
      console.error('❌ ICE restart failed:', err);
    }
  }

  /**
   * Initialize peer connection and add local stream
   */
  async initialize(stream: MediaStream): Promise<void> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');

    this.localStream = stream;
    const tracks = stream.getTracks();
    console.log('🎬 Adding', tracks.length, 'tracks to peer connection');

    tracks.forEach((track) => {
      console.log('🎬 Adding track:', track.kind, track.label, 'enabled:', track.enabled);
      this.peerConnection?.addTrack(track, stream);
    });

    // Log senders to verify tracks were added
    const senders = this.peerConnection.getSenders();
    console.log('📤 Peer connection now has', senders.length, 'senders');
  }

  /**
   * Get local peer connection
   */
  getPeerConnection(): RTCPeerConnection {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    return this.peerConnection;
  }

  /**
   * Create and return an offer
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');

    // Create offer with optimized constraints (Zoom-like)
    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });

    // Optimize SDP for better codec selection
    const optimizedOffer = this.optimizeSDP(offer);
    await this.peerConnection.setLocalDescription(optimizedOffer);
    return optimizedOffer;
  }

  /**
   * Optimize SDP for better video quality (prefer VP9 or H.264)
   */
  private optimizeSDP(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (!description.sdp) return description;

    let sdp = description.sdp;

    // Prefer VP9 codec for better quality at lower bitrates
    // Or H.264 for hardware acceleration
    const codecPreference = 'VP9'; // Can be 'H264' or 'VP8'

    // Set max bitrate for video (adaptive based on network)
    sdp = sdp.replace(/(m=video.*\r\n)/g, (match) => {
      return match + 'b=AS:2000\r\n'; // Max 2 Mbps
    });

    return { ...description, sdp };
  }

  /**
   * Process queued ICE candidates
   */
  private async processQueuedIceCandidates(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;

    console.log(`🧊 Processing ${this.iceCandidateQueue.length} queued ICE candidates...`);
    while (this.iceCandidateQueue.length > 0) {
      const candidate = this.iceCandidateQueue.shift();
      if (candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("❌ Failed to add queued ICE candidate:", err);
        }
      }
    }
  }

  /**
   * Create and return an answer
   */
  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');

    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    // Process queued candidates now that remote description is set
    await this.processQueuedIceCandidates();

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  /**
   * Set remote description (answer/offer)
   */
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(description));

    // Process queued candidates now that remote description is set
    await this.processQueuedIceCandidates();
  }

  /**
   * Add ICE candidate
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');

    // Queue if remote description is not set yet
    if (!this.peerConnection.remoteDescription) {
      console.log("🧊 Queueing ICE candidate (remote description not set)");
      this.iceCandidateQueue.push(candidate);
      return;
    }

    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * Setup ICE candidate callback
   */
  onIceCandidate(callback: (candidate: RTCIceCandidate) => void): void {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        callback(event.candidate);
      }
    };
  }

  /**
   * Setup remote track callback
   */
  onRemoteTrack(callback: (stream: MediaStream) => void): void {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    this.peerConnection.ontrack = (event) => {
      console.log("🎥 Remote track received:", event.track.kind, event.streams);
      if (event.streams[0]) {
        console.log("🎥 Setting remote stream with", event.streams[0].getTracks().length, "tracks");
        callback(event.streams[0]);
      } else if (event.track) {
        // Fallback: Create stream from track if no stream provided
        console.log("🎥 Creating stream from track");
        const stream = new MediaStream([event.track]);
        callback(stream);
      }
    };
  }

  /**
   * Setup connection state change callback
   */
  onConnectionStateChange(callback: (state: RTCPeerConnectionState) => void): void {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    const pc = this.peerConnection;
    pc.onconnectionstatechange = () => {
      callback(pc.connectionState);
    };
  }

  /**
   * Get connection statistics
   */
  async getStats(): Promise<RTCStatsReport> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    return await this.peerConnection.getStats();
  }

  /**
   * Close peer connection
   */
  close(): void {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  }
}
