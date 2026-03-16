import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { callService, CallSignal } from './CallService';
import * as ENV from '../config/env';

// Safe imports for WebRTC to prevent crashes in Expo Go
let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCIceCandidate: any;
let mediaDevices: any;
let MediaStream: any;

try {
    const webrtc = require('react-native-webrtc');
    RTCPeerConnection = webrtc.RTCPeerConnection;
    RTCSessionDescription = webrtc.RTCSessionDescription;
    RTCIceCandidate = webrtc.RTCIceCandidate;
    mediaDevices = webrtc.mediaDevices;
    MediaStream = webrtc.MediaStream;
} catch (e) {
    console.log('[WebRTCService] Native modules not available');
}

// STUN/TURN servers for NAT traversal
//
// WHY TURN IS CRITICAL:
//   - STUN alone only works when both devices are on the same network (WiFi ↔ WiFi)
//   - When either user is on 4G/5G or behind a strict NAT/firewall, STUN fails
//   - TURN relays media through the server as a fallback — this is what WhatsApp does
//
// CURRENT SETUP:
//   1. Google STUN (fast, for same-network / simple NAT)
//   2. Open Relay Project by Metered (free TURN — works on 4G/5G cross-network, no signup)
//   3. ENV-configured TURN (for production self-hosted / paid upgrade)
//
const ICE_SERVERS: any[] = [
  // ── STUN servers (fast, direct connection attempt first) ──────────────────
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },

  // ── Free TURN servers (Open Relay Project by Metered.ca) ─────────────────
  // These relay traffic when 4G/5G NAT blocks direct WebRTC connection.
  // Works globally — same as what WhatsApp/Telegram use for calls.
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turns:openrelay.metered.ca:443',  // TLS — punches through strict firewalls
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },

  // ── Production TURN Server (upgrade to your own for scale) ────────────────
  ...(ENV.TURN_SERVER && ENV.TURN_SERVER.length > 10 && !ENV.TURN_SERVER.includes('yourdomain') ? [{
    urls: ['turn:' + ENV.TURN_SERVER],
    username: ENV.TURN_USERNAME,
    credential: ENV.TURN_PASSWORD
  }] : []),

  // ── Backup Production TURN ────────────────────────────────────────────────
  ...(ENV.TURN_SERVER_2 && ENV.TURN_SERVER_2.length > 10 && !ENV.TURN_SERVER_2.includes('backup-turn') ? [{
    urls: ['turn:' + ENV.TURN_SERVER_2],
    username: ENV.TURN_USERNAME_2,
    credential: ENV.TURN_PASSWORD_2
  }] : []),
];

type CallType = 'audio' | 'video';
type CallState = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';

interface WebRTCCallbacks {
    onStateChange: (state: CallState) => void;
    onLocalStream: (stream: MediaStream | null) => void;
    onRemoteStream: (stream: MediaStream | null) => void;
    onError: (error: string) => void;
}

class WebRTCService {
    private peerConnection: RTCPeerConnection | null = null;
    private listeners: WebRTCCallbacks[] = [];
    private localStream: MediaStream | null = null;
    private remoteStream: MediaStream | null = null;
    private callType: CallType = 'audio';
    private callState: CallState = 'idle';
    private isInitiator: boolean = false;
    private partnerHasAccepted: boolean = false;
    private pendingCandidates: RTCIceCandidate[] = [];
    private pendingCandidatesMutex: boolean = false;
    private mediaStreamAttempted: boolean = false;
    private readonly MAX_PENDING_CANDIDATES = 50;

    // Recovery tracking
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private connectionWatchdog: NodeJS.Timeout | null = null;
    private trackMonitorTimer: NodeJS.Timeout | null = null;
    private lastDisconnectTime: number = 0;

    /**
     * Add a listener for WebRTC events
     */
    addListener(listener: WebRTCCallbacks): void {
        if (!this.listeners.includes(listener)) {
            this.listeners.push(listener);
            console.log(`[WebRTCService] Listener added. Total: ${this.listeners.length}`);
            
            // Immediately sync current state to new listener
            listener.onStateChange(this.callState);
            if (this.localStream) listener.onLocalStream(this.localStream);
            if (this.remoteStream) listener.onRemoteStream(this.remoteStream);
        }
    }

    /**
     * Remove a listener
     */
    removeListener(listener: WebRTCCallbacks): void {
        this.listeners = this.listeners.filter(l => l !== listener);
        console.log(`[WebRTCService] Listener removed. Total: ${this.listeners.length}`);
    }

    /**
     * @deprecated Use addListener
     */
    initialize(callbacks: WebRTCCallbacks, isInitiator: boolean): void {
        this.isInitiator = isInitiator;
        this.addListener(callbacks);
        console.log(`[WebRTCService] Initializing (Compatible Mode). Role: ${isInitiator ? 'Initiator' : 'Receiver'}`);

        if (!this.peerConnection) {
            this.localStream = null;
            this.mediaStreamAttempted = false;
            this.remoteStream = null;
            this.partnerHasAccepted = false;
            this.setState('idle');
            this.pendingCandidates = [];
        }
    }

    /**
     * @deprecated Use addListener/removeListener
     */
    setCallbacks(callbacks: WebRTCCallbacks | null): void {
        if (callbacks) {
            this.addListener(callbacks);
        }
    }

    /**
     * Set the role of this device (initiator/caller or receiver/callee)
     */
    setInitiator(val: boolean): void {
        this.isInitiator = val;
    }

    /**
     * Get current local stream
     */
    getLocalStream(): MediaStream | null {
        return this.localStream;
    }

    /**
     * Get current remote stream
     */
    getRemoteStream(): MediaStream | null {
        return this.remoteStream;
    }

    /**
     * Check if a call is currently active
     */
    isCallActive(): boolean {
        return !!this.peerConnection && (this.callState === 'connected' || this.callState === 'connecting' || this.callState === 'ringing');
    }

    /**
     * Prepare for a call (get media permissions and stream)
     */
    async prepareCall(callType: CallType): Promise<void> {
        this.callType = callType;
        // Get local media stream
        await this.getMediaStream();
    }

    async startCall(): Promise<void> {
        if (this.isCallActive() && this.isInitiator) {
            console.log('[WebRTCService] startCall ignored: Call already active as Initiator.');
            return;
        }

        try {
            console.log('[WebRTCService] Starting call as Initiator');
            this.isInitiator = true;
            this.setState('ringing');

            // Ensure media is ready (if not already and hasn't failed yet)
            if (!this.localStream && !this.mediaStreamAttempted) {
                await this.prepareCall(this.callType);
            }

            // Create peer connection
            await this.createPeerConnection();

            // We wait for 'call-accepted' from the partner.
            console.log('[WebRTCService] ✅ Call initiated, waiting for partner to accept...');
            
            // If the partner accepted the call so fast that we received it before startCall finished:
            if (this.partnerHasAccepted) {
                console.log('[WebRTCService] ⚡ Partner already accepted before startCall finished. Generating offer instantly.');
                await this.onCallAccepted();
            }
        } catch (error: any) {
            console.error('[WebRTCService] ❌ Failed to start call:', error);
            this.broadcast('onError', `Failed to start call: ${error.message}`);
            this.endCall('start-failed');
        }
    }

    /**
     * Triggered when the initiator receives 'call-accepted'
     */
    async onCallAccepted(): Promise<void> {
        this.partnerHasAccepted = true;
        console.log(`[WebRTCService] onCallAccepted called. peerConnection: ${!!this.peerConnection}, isInitiator: ${this.isInitiator}`);
        
        if (this.isInitiator && this.peerConnection) {
            // Guard: don't create multiple offers if it gets called twice somehow
            if (this.peerConnection.signalingState !== 'stable') {
                console.log('[WebRTCService] Already creating offer or not stable, ignoring duplicate onCallAccepted.');
                return;
            }
            
            console.log('[WebRTCService] Partner accepted call, creating offer...');
            this.setState('connecting');
            await this.createOffer();
        } else {
            console.log('[WebRTCService] ⏳ Partner accepted but we are not ready. Offer will generate when startCall completes.');
        }
    }

    /**
     * Answer an incoming call
     */
    async answerCall(callType: CallType, offer: RTCSessionDescriptionInit): Promise<void> {
        try {
            if (this.peerConnection && this.peerConnection.signalingState !== 'stable') {
                console.log('[WebRTCService] Ignoring offer: signalingState is not stable:', this.peerConnection.signalingState);
                return;
            }

            this.callType = callType;
            this.isInitiator = false;
            this.setState('connecting');

            // Ensure media is ready (if not already and hasn't failed yet)
            if (!this.localStream && !this.mediaStreamAttempted) {
                await this.prepareCall(callType);
            }

            // Create peer connection
            await this.createPeerConnection();

            // Set remote description (offer)
            const remoteDesc = new RTCSessionDescription(offer as any);
            await this.peerConnection!.setRemoteDescription(remoteDesc as any);

            // Process pending ICE candidates
            await this.processPendingCandidates();

            // Create and send answer
            await this.createAnswer();
            console.log('[WebRTCService] ✅ Call answered successfully');

        } catch (error: any) {
            console.error('[WebRTCService] ❌ Failed to answer call:', error);
            this.broadcast('onError', `Failed to answer call: ${error.message}`);
            this.endCall('answer-failed');
        }
    }

    /**
     * Handle incoming WebRTC signals
     */
    async handleSignal(signal: CallSignal): Promise<void> {
        try {
            if (!this.peerConnection && signal.type !== 'offer') {
                console.log(`[WebRTCService] Ignoring ${signal.type}: no peer connection`);
                return;
            }

            switch (signal.type) {
                case 'offer':
                    console.log('Received WebRTC offer. Current state:', this.peerConnection?.signalingState);
                    await this.answerCall(signal.callType, signal.payload);
                    break;

                case 'answer':
                    console.log('Received WebRTC answer. Current state:', this.peerConnection?.signalingState);
                    if (this.peerConnection && signal.payload) {
                        // Guard: Only apply answer if we are expecting one
                        if (this.peerConnection.signalingState !== 'have-local-offer') {
                            console.log('[WebRTCService] Ignoring duplicate/invalid answer signal');
                            return;
                        }
                        const remoteDesc = new RTCSessionDescription(signal.payload);
                        await this.peerConnection.setRemoteDescription(remoteDesc);
                        await this.processPendingCandidates();
                    }
                    break;

                case 'ice-candidate':
                    if (signal.payload) {
                        try {
                            const candidate = new RTCIceCandidate(signal.payload);
                            console.log(`[WebRTCService] 🧊 Adding remote ICE candidate: ${candidate.candidate?.split(' ').slice(0, 3).join(' ')}...`);
                            if (this.peerConnection?.remoteDescription) {
                                await this.peerConnection.addIceCandidate(candidate);
                            } else {
                                // FIX #1: Limit pending candidates to prevent memory leak
                                if (this.pendingCandidates.length >= this.MAX_PENDING_CANDIDATES) {
                                    console.warn('[WebRTCService] ICE candidate queue full, dropping oldest candidate');
                                    this.pendingCandidates.shift();
                                }
                                this.pendingCandidates.push(candidate);
                                console.log(`[WebRTCService] 📦 Buffered candidate (Total: ${this.pendingCandidates.length})`);
                            }
                        } catch (e) {
                            console.warn('[WebRTCService] Failed to add ICE candidate:', e);
                        }
                    }
                    break;

                case 'call-end':
                    console.log('Remote user ended call');
                    this.endCall();
                    break;
            }
        } catch (error: any) {
            // Check for known "wrong state" errors and suppress them if state is already correct
            if (error.message?.includes('stable') && this.peerConnection?.signalingState === 'stable') {
                console.log('[WebRTCService] Suppressed safe signaling state error');
                return;
            }
            console.error('Failed to handle signal:', error);
            this.broadcast('onError', `Signal handling failed: ${error.message}`);
        }
    }

    /**
     * End the current call
     */
    endCall(reason: string = 'manual'): void {
        console.log(`[WebRTCService] 🚨 endCall() called. Reason: ${reason}. Current state: ${this.callState}`);

        // Guard: prevent double-end
        if (this.callState === 'ended' || this.callState === 'idle') {
            console.log(`[WebRTCService] endCall() ignored (reason: ${reason}) - already ${this.callState}`);
            return;
        }

        // Mark state FIRST to prevent re-entrant calls
        this.setState('ended');

        // Stop local tracks
        if (this.localStream) {
            try {
                this.localStream.getTracks().forEach((track: any) => {
                    if (track && typeof track.stop === 'function') {
                        try {
                            track.stop();
                        } catch (e) {
                            console.warn('[WebRTCService] Error stopping track:', e);
                        }
                    }
                });
            } catch (e) {
                console.warn('[WebRTCService] Error getting tracks for stop:', e);
            }
            this.localStream = null;
        }

        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.remoteStream = null;
        this.pendingCandidates = [];
        this.partnerHasAccepted = false;
        this.isInitiator = false;

        // Notify listeners
        this.broadcast('onLocalStream', null);
        this.broadcast('onRemoteStream', null);

        // NOTE: Do NOT call callService.endCall() here.
        // The endCall signal is sent by AppContext.endCall() to avoid
        // a double-signal loop (AppContext -> webRTCService.endCall() -> callService.endCall() -> signal loop).

        // Reset state after short delay, but only if not cleaned up
        setTimeout(() => {
            if (this.listeners.length > 0 && this.callState === 'ended') {
                this.setState('idle');
            }
        }, 1000);
    }

    /**
     * Toggle mute on local audio
     */
    toggleMute(): boolean {
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            if (audioTracks.length > 0) {
                const isCurrentlyEnabled = audioTracks[0].enabled;
                audioTracks.forEach((track: any) => {
                    track.enabled = !isCurrentlyEnabled;
                });
                return isCurrentlyEnabled; // Return true if now muted
            }
        }
        return false;
    }

    /**
     * Toggle local video
     */
    toggleVideo(): boolean {
        if (this.localStream && this.callType === 'video') {
            const videoTracks = this.localStream.getVideoTracks();
            if (videoTracks.length > 0) {
                const isCurrentlyEnabled = videoTracks[0].enabled;
                videoTracks.forEach((track: any) => {
                    track.enabled = !isCurrentlyEnabled;
                });
                return isCurrentlyEnabled; // Return true if video is now off
            }
        }
        return false;
    }

    /**
     * Switch camera (front/back)
     */
    async switchCamera(): Promise<void> {
        if (this.localStream && this.callType === 'video') {
            const videoTrack = this.localStream.getVideoTracks()[0] as any;
            if (videoTrack && videoTrack._switchCamera) {
                videoTrack._switchCamera();
            }
        }
    }

    /**
     * Get current call state
     */
    getState(): CallState {
        return this.callState;
    }

    getSignalingState(): string {
        return (this.peerConnection as any)?.signalingState || 'idle';
    }

    getIceConnectionState(): string {
        return (this.peerConnection as any)?.iceConnectionState || 'idle';
    }

    // Private methods

    private async getMediaStream(): Promise<void> {
        let timer: NodeJS.Timeout | null = null;
        try {
            console.log('Getting media stream for', this.callType);
            
            // Mark as attempted so we don't try again and cause a double 8-second delay
            this.mediaStreamAttempted = true;

            const constraints: any = {
                audio: true,
                video: this.callType === 'video' ? {
                    facingMode: 'user',
                } : false,
            };

            const mediaPromise = (mediaDevices.getUserMedia(constraints) as Promise<MediaStream>).then(res => {
                if (timer) clearTimeout(timer);
                return res;
            });
            
            // INCREASE TIMEOUT: 5s is too short for some hardware/permissions prompts
            const timeoutPromise = new Promise<MediaStream>((_, reject) => {
                timer = setTimeout(() => reject(new Error('getUserMedia timed out after 15 seconds')), 15000);
            });

            this.localStream = await Promise.race([mediaPromise, timeoutPromise]);
            
            // If we already have a PeerConnection, add these tracks NOW
            if (this.peerConnection && this.localStream) {
                console.log('[WebRTCService] Adding local tracks to existing PeerConnection');
                let tracksAdded = false;
                this.localStream.getTracks().forEach((track: any) => {
                    try {
                        this.peerConnection!.addTrack(track, this.localStream!);
                        tracksAdded = true;
                    } catch (e) {
                        console.warn('[WebRTCService] Failed to add track to existing PC:', e);
                    }
                });

                // CRITICAL: If we added tracks late, we MUST re-negotiate
                if (tracksAdded && this.peerConnection.signalingState === 'stable') {
                    console.log('[WebRTCService] 🔄 Late tracks added, triggering re-negotiation...');
                    this.createOffer().catch(e => console.warn('Late offer failed:', e));
                }
            }

            this.broadcast('onLocalStream', this.localStream);
            console.log('[WebRTCService] Local stream obtained successfully');

        } catch (error: any) {
            if (timer) clearTimeout(timer);
            const isSimulator = !Constants.isDevice;
            console.warn(`[WebRTCService] ⚠️ getMediaStream failed (Simulator=${isSimulator}):`, error.message);
            
            if (isSimulator && Platform.OS === 'ios') {
                console.log('[WebRTCService] 🛡️ Simulator detected. Avoiding audio hardware retry to prevent SIGABRT.');
                this.localStream = null;
                this.broadcast('onLocalStream', null);
                return;
            }
            
            // If the failure was a timeout or missing hardware, try audio-only fallback
            if ((Platform.OS === 'ios' || Platform.OS === 'android') && 
                (error.message?.includes('found') || error.message?.includes('time') || error.message?.includes('device'))) {
                
                console.log('[WebRTCService] 🛡️ Proceeding with audio-only fallback stream...');
                let audioTimer: NodeJS.Timeout | null = null;
                try {
                    const audioOnlyPromise = (mediaDevices.getUserMedia({ audio: true, video: false }) as Promise<MediaStream>).then(res => {
                        if (audioTimer) clearTimeout(audioTimer);
                        return res;
                    });
                    const audioTimeout = new Promise<MediaStream>((_, reject) => {
                        audioTimer = setTimeout(() => reject(new Error('Audio-only fallback also timed out')), 10000);
                    });
                    
                    this.localStream = await Promise.race([audioOnlyPromise, audioTimeout]);
                    
                    // If we already have a PeerConnection, add these tracks NOW
                    if (this.peerConnection && this.localStream) {
                        this.localStream.getTracks().forEach((track: any) => {
                            try { this.peerConnection!.addTrack(track, this.localStream!); } catch (e) {}
                        });
                    }

                    this.broadcast('onLocalStream', this.localStream);
                    return;
                } catch (e: any) {
                    if (audioTimer) clearTimeout(audioTimer);
                    console.warn('[WebRTCService] ⚠️ Audio fallback also failed or timed out:', e.message);
                }
            }
            
            // Critical fail-soft: even if NO media is available (Simulator/Busy Hardware), 
            // do NOT crash. Let signaling proceed so the call can at least connect.
            this.localStream = null;
            this.broadcast('onLocalStream', null);
            console.log('[WebRTCService] ⚠️ Proceeding with NO local stream. Signaling will still attempt to connect.');
        }
    }

    private async createPeerConnection(): Promise<void> {
        const config: RTCConfiguration = {
            iceServers: ICE_SERVERS,
        };

        if (!RTCPeerConnection) {
            console.error('RTCPeerConnection is not defined. Check react-native-webrtc installation.');
            throw new Error('WebRTC engine not available. You are likely using Expo Go. Please use a Development Build.');
        }

        this.peerConnection = new RTCPeerConnection(config);

        // MODERN APPROACH: Add transceivers immediately for Video calls
        // This ensures the SDP always includes video sections even if tracks arrive late.
        try {
            if (this.peerConnection.addTransceiver) {
                this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
                if (this.callType === 'video') {
                    this.peerConnection.addTransceiver('video', { direction: 'sendrecv' });
                }
                console.log('[WebRTCService] Transceivers added successfully');
            }
        } catch (e) {
            console.log('[WebRTCService] Transceivers not supported, falling back to addTrack');
        }

        // Add existing local tracks to connection
        if (this.localStream) {
            this.localStream.getTracks().forEach((track: any) => {
                try {
                    this.peerConnection!.addTrack(track, this.localStream!);
                } catch (e) {
                    console.warn('[WebRTCService] Error adding track during PC creation:', e);
                }
            });
        }

        // Cast peerConnection for event handlers (react-native-webrtc types)
        const pc = this.peerConnection as any;

        // Handle incoming tracks
        pc.addEventListener('track', (event: any) => {
            const kind = event.track?.kind;
            console.log(`[WebRTCService] 📡 Remote track received: ${kind}`);
            
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
            } else {
                console.warn('[WebRTCService] 📡 Track received but no streams found in event — creating local container');
                // Fallback: if we have a track but it's not in a stream, create one
                if (!this.remoteStream) {
                    this.remoteStream = new MediaStream();
                }
                this.remoteStream.addTrack(event.track);
            }

            if (this.remoteStream) {
                this.broadcast('onRemoteStream', this.remoteStream);
                
                // CRITICAL: Any remote media (audio or video) means we are effectively connected
                // to the other person, even if ICE is still in 'checking' phase.
                this.setState('connected');
                
                // FIX #13: Verify DTLS/SRTP encryption is established
                this.verifyEncryption();
            }
        });

        // Handle ICE candidates
        pc.addEventListener('icecandidate', (event: any) => {
            if (event.candidate) {
                const parts = event.candidate.candidate.split(' ');
                const type = parts[7] || 'unknown';
                console.log(`[WebRTCService] 🧊 Local ICE candidate generated: ${type} (${parts[0]} ${parts[1]} ${parts[2]})`);
                callService.sendIceCandidate(event.candidate);
            }
        });

        // Update connection state handler with recovery logic
        pc.addEventListener('connectionstatechange', () => {
            const state = pc.connectionState;
            console.log('[WebRTCService] 📶 Connection state changed:', state.toUpperCase());

            switch (state) {
                case 'connected':
                    this.setState('connected');
                    // Reset recovery attempts on successful reconnection
                    this.reconnectAttempts = 0;
                    if (this.reconnectTimeout) {
                        clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = null;
                    }
                    break;

                case 'disconnected':
                    // IMPORTANT: 'disconnected' is TRANSIENT state, NOT final
                    // WebRTC stack will automatically attempt to recover
                    this.lastDisconnectTime = Date.now();
                    console.warn('[WebRTCService] ⚠️ Connection transiently disconnected. Waiting for automatic recovery...');

                    // Give WebRTC 10 seconds to auto-recover before manual intervention
                    if (!this.reconnectTimeout) {
                        this.reconnectTimeout = setTimeout(() => {
                            // After 10 seconds, if still disconnected, attempt manual recovery
                            if (pc.connectionState === 'disconnected' && this.reconnectAttempts < this.maxReconnectAttempts) {
                                this.reconnectAttempts++;
                                console.log(`[WebRTCService] Attempting manual recovery (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
                                this.attemptRecovery();
                            } else if (pc.connectionState === 'disconnected') {
                                console.error('[WebRTCService] Max recovery attempts exceeded. Ending call.');
                                this.endCall('recovery-exhausted');
                            }
                        }, 10000);
                    }
                    break;

                case 'failed':
                case 'closed':
                    // 'failed' and 'closed' ARE FINAL states
                    console.warn(`[WebRTCService] Connection permanently ${state}. Ending call.`);
                    if (this.reconnectTimeout) {
                        clearTimeout(this.reconnectTimeout);
                        this.reconnectTimeout = null;
                    }
                    this.reconnectAttempts = 0;
                    this.endCall(`pc-state-${state}`);
                    break;
            }
        });

        // Add ICE connection state handler with recovery
        pc.addEventListener('iceconnectionstatechange', () => {
            const iceState = pc.iceConnectionState;
            console.log('[WebRTCService] 🧊 ICE state changed:', iceState);

            switch (iceState) {
                case 'connected':
                case 'completed':
                    // Once media is flowing (which we check in 'track' event), 
                    // ICE states like 'completed' just confirm stability.
                    this.setState('connected');
                    break;

                case 'disconnected':
                    // ICE layer disconnection is often transient
                    // Wait for auto-recovery before taking action
                    console.warn('[WebRTCService] ⚠️ ICE transiently disconnected. Waiting for auto-repair...');
                    break;

                case 'checking':
                    console.log('[WebRTCService] ICE is checking connection candidates...');
                    break;

                case 'failed':
                    console.warn('[WebRTCService] ❌ ICE connection failed');
                    console.warn('[WebRTCService] Note: On 4G/5G networks, ensure TURN server is configured');
                    // Don't immediately end - connectionstatechange handler will handle final failure
                    break;

                case 'closed':
                    console.log('[WebRTCService] ICE connection closed');
                    this.endCall('ice-closed');
                    break;
            }
        });

        console.log('Peer connection created');
    }

    private async createOffer(): Promise<void> {
        if (!this.peerConnection) return;

        // GUARD: If we are already in the middle of signaling, wait or ignore
        if (this.peerConnection.signalingState !== 'stable') {
            console.log(`[WebRTCService] createOffer ignored: signalingState is ${this.peerConnection.signalingState}`);
            return;
        }

        const offerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: this.callType === 'video',
            iceRestart: false
        };

        const offer = await this.peerConnection.createOffer(offerOptions);
        await this.peerConnection.setLocalDescription(offer);

        console.log('Sending offer...');
        callService.sendOffer(offer);
    }

    private async createAnswer(): Promise<void> {
        if (!this.peerConnection) return;

        const answerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: this.callType === 'video',
        };

        const answer = await this.peerConnection.createAnswer(answerOptions);
        await this.peerConnection.setLocalDescription(answer);

        console.log('[WebRTCService] Sending answer...');
        callService.sendAnswer(answer);
    }

    private async processPendingCandidates(): Promise<void> {
        // FIX #2: Prevent race condition with mutex
        if (this.pendingCandidatesMutex || !this.peerConnection) return;
        this.pendingCandidatesMutex = true;

        try {
            console.log(`Processing ${this.pendingCandidates.length} pending ICE candidates`);

            // Process all candidates and clear the queue
            const candidates = [...this.pendingCandidates];
            this.pendingCandidates = [];

            for (const candidate of candidates) {
                try {
                    await this.peerConnection.addIceCandidate(candidate);
                } catch (error) {
                    console.warn('Failed to add pending ICE candidate:', error);
                }
            }
        } finally {
            this.pendingCandidatesMutex = false;
        }
    }

    private setState(state: CallState): void {
        // PREVENT DOWNGRADE: If we are already connected, don't go back to connecting
        // unless the state is failed, ended, or idle.
        if (this.callState === 'connected' && state === 'connecting') {
            console.log('[WebRTCService] 🛡️ Ignoring state downgrade from connected to connecting');
            return;
        }

        console.log(`[WebRTCService] State change: ${this.callState} -> ${state}`);
        this.callState = state;
        
        // Force broadcast multiple times to ensure and handle any race conditions in listeners
        this.broadcast('onStateChange', state);
        if (state === 'connected') {
            // Also broadcast streams again to be absolutely sure
            this.broadcast('onLocalStream', this.localStream);
            this.broadcast('onRemoteStream', this.remoteStream);
        }

        // Start/Stop media tracking
        if (state === 'connected') {
            this.startTrackMonitoring();
        } else if (state === 'ended' || state === 'idle') {
            this.stopTrackMonitoring();
        }

        // Connection Watchdog: If we stay in 'connecting' too long, fail the call
        if (this.connectionWatchdog) {
            clearTimeout(this.connectionWatchdog);
            this.connectionWatchdog = null;
        }

        if (state === 'connecting') {
            this.connectionWatchdog = setTimeout(() => {
                if (this.callState === 'connecting') {
                    console.warn('[WebRTCService] 🚨 Connection watchdog timeout! Call failed to connect in 20s.');
                    this.endCall('connection-timeout');
                    this.broadcast('onError', 'Call connection timed out. Please check your network.');
                }
            }, 20000);
        }
    }

    private broadcast(method: string, data: any): void {
        this.listeners.forEach((listener: any) => {
            if (typeof listener[method] === 'function') {
                listener[method](data);
            }
        });
    }

    // FIX #13: Verify DTLS/SRTP encryption is established
    private async verifyEncryption(): Promise<void> {
        if (!this.peerConnection) return;

        try {
            const senders = this.peerConnection.getSenders();
            for (const sender of senders) {
                if (sender.transport) {
                    const state = sender.transport.state;
                    console.log('[WebRTCService] Sender transport state:', state);
                    if (state !== 'connected' && state !== 'new') {
                        console.warn('[WebRTCService] ⚠️ Encryption may not be properly established');
                    }
                }
            }
        } catch (error) {
            console.error('[WebRTCService] Error verifying encryption:', error);
        }
    }

    private stopTrackMonitoring(): void {
        if (this.trackMonitorTimer) {
            console.log('[WebRTCService] 🔍 Stopping media track monitor');
            clearInterval(this.trackMonitorTimer);
            this.trackMonitorTimer = null;
        }
    }

    private startTrackMonitoring(): void {
        this.stopTrackMonitoring();
        console.log('[WebRTCService] 🔍 Starting media track monitor');
        this.trackMonitorTimer = setInterval(() => {
            if (!this.peerConnection) {
                this.stopTrackMonitoring();
                return;
            }
            
            const localAudio = this.localStream?.getAudioTracks().length || 0;
            const remoteAudio = this.remoteStream?.getAudioTracks().length || 0;
            const remoteVideo = this.remoteStream?.getVideoTracks().length || 0;
            const iceState = this.getIceConnectionState();
            const sigState = this.getSignalingState();

            console.log(`[WebRTC_STATS] Role: ${this.isInitiator ? 'In' : 'Rx'} | ICE: ${iceState} | SIG: ${sigState} | Audio: L:${localAudio} R:${remoteAudio} | Video: R:${remoteVideo}`);
        }, 5000);
    }

    // Add recovery attempt method
    private async attemptRecovery(): Promise<void> {
        try {
            console.log('[WebRTCService] Attempting manual recovery...');
            
            if (!this.peerConnection) {
                console.log('[WebRTCService] No peer connection available');
                return;
            }
            
            // Strategy: ICE Restart
            // In modern WebRTC, we create a new offer with { iceRestart: true }
            if (this.isInitiator) {
                console.log('[WebRTCService] Initiating ICE Restart (creating new offer)...');
                const offerOptions = {
                    iceRestart: true,
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: this.callType === 'video',
                };
                const offer = await this.peerConnection.createOffer(offerOptions);
                await this.peerConnection.setLocalDescription(offer);
                callService.sendOffer(offer);
            } else {
                console.log('[WebRTCService] Waiting for Initiator to restart ICE...');
                // Callee usually waits, but can also trigger negotiationneeded
            }
            
            console.log('[WebRTCService] Recovery attempt initiated. Waiting for reconnection...');
            
        } catch (error) {
            console.error('[WebRTCService] Recovery attempt failed:', error);
        }
    }

    /**
     * Cleanup resources
     */
    cleanup(): void {
        this.listeners = []; // Clear all listeners
        this.endCall();
    }
}

export const webRTCService = new WebRTCService();
export type { CallState, CallType, WebRTCCallbacks };
