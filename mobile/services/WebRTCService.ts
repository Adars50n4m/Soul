import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { callService, CallSignal } from './CallService';

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
// CURRENT SETUP: Metered's free open relay TURN servers
//   - Free tier: 500 MB/month (enough for testing and small user base)
//   - For production with many users, get your own TURN server:
//     → https://www.metered.ca/stun-turn (paid plans)
//     → https://www.twilio.com/docs/stun-turn (Twilio TURN)
//     → Self-hosted: coturn (open source)
//
const ICE_SERVERS: RTCIceServer[] = [
  // Primary STUN Servers (Free, works for WiFi/LAN)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  
  // Backup STUN Servers
  { urls: 'stun:stun4.l.google.com:19302' },
  
  // Production TURN Server (Paid, required for 4G/5G/Corporate networks)
  // Get credentials from: https://www.twilio.com/stun-turn or openrelay.net
  {
    urls: ['turn:' + (process.env.TURN_SERVER || 'turnserver.yourdomain.com:3478')],
    username: process.env.TURN_USERNAME || 'your_username',
    credential: process.env.TURN_PASSWORD || 'your_password'
  },
  
  // Alternative TURN Server (for redundancy)
  {
    urls: ['turn:' + (process.env.TURN_SERVER_2 || 'backup-turnserver.yourdomain.com:3478')],
    username: process.env.TURN_USERNAME_2 || 'backup_username',
    credential: process.env.TURN_PASSWORD_2 || 'backup_password'
  }
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
    private localStream: MediaStream | null = null;
    private remoteStream: MediaStream | null = null;
    private callType: CallType = 'audio';
    private callState: CallState = 'idle';
    private callbacks: WebRTCCallbacks | null = null;
    private isInitiator: boolean = false;
    private partnerHasAccepted: boolean = false;
    private pendingCandidates: RTCIceCandidate[] = [];
    private mediaStreamAttempted: boolean = false;

    // Recovery tracking
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private lastDisconnectTime: number = 0;

    /**
     * Initialize WebRTC service with callbacks
     */
    initialize(callbacks: WebRTCCallbacks, isInitiator: boolean): void {
        this.callbacks = callbacks;
        this.isInitiator = isInitiator;
        
        console.log(`[WebRTCService] Initializing. Role: ${isInitiator ? 'Initiator' : 'Receiver'}, CurrentPC: ${!!this.peerConnection}`);

        // If we already have a peer connection, we are re-attaching callbacks
        if (this.peerConnection) {
            console.log('[WebRTCService] Re-attaching callbacks to existing call');
            this.callbacks.onStateChange(this.callState);
            if (this.localStream) this.callbacks.onLocalStream(this.localStream);
            if (this.remoteStream) this.callbacks.onRemoteStream(this.remoteStream);
        } else {
            // Fresh call
            this.localStream = null;
            this.mediaStreamAttempted = false;
            this.remoteStream = null;
            this.partnerHasAccepted = false;
            this.setState('idle');
            this.pendingCandidates = [];
        }
    }

    /**
     * Update callbacks without resetting state (used for PiP/Minimize)
     */
    setCallbacks(callbacks: WebRTCCallbacks | null): void {
        this.callbacks = callbacks;
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
            this.callbacks?.onError(`Failed to start call: ${error.message}`);
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
            this.callbacks?.onError(`Failed to answer call: ${error.message}`);
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
                    // console.log('Received ICE candidate'); // Too noisy
                    if (signal.payload) {
                        const candidate = new RTCIceCandidate(signal.payload);
                        if (this.peerConnection?.remoteDescription) {
                            await this.peerConnection.addIceCandidate(candidate);
                        } else {
                            this.pendingCandidates.push(candidate);
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
            this.callbacks?.onError(`Signal handling failed: ${error.message}`);
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
            this.localStream.getTracks().forEach((track: any) => {
                track.stop();
            });
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

        // Notify callbacks
        if (this.callbacks) {
            this.callbacks.onLocalStream(null);
            this.callbacks.onRemoteStream(null);
        }

        // NOTE: Do NOT call callService.endCall() here.
        // The endCall signal is sent by AppContext.endCall() to avoid
        // a double-signal loop (AppContext -> webRTCService.endCall() -> callService.endCall() -> signal loop).

        this.setState('ended');

        // Reset state after short delay, but only if not cleaned up
        setTimeout(() => {
            if (this.callbacks) {
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
            
            const timeoutPromise = new Promise<MediaStream>((_, reject) => {
                timer = setTimeout(() => reject(new Error('getUserMedia timed out after 3 seconds')), 3000);
            });

            this.localStream = await Promise.race([mediaPromise, timeoutPromise]);
            this.callbacks?.onLocalStream(this.localStream);
            console.log('[WebRTCService] Local stream obtained successfully');

        } catch (error: any) {
            if (timer) clearTimeout(timer);
            const isSimulator = !Constants.isDevice;
            console.warn(`[WebRTCService] ⚠️ getMediaStream failed (Simulator=${isSimulator}):`, error.message);
            
            if (isSimulator && Platform.OS === 'ios') {
                console.log('[WebRTCService] 🛡️ Simulator detected. Avoiding audio hardware retry to prevent SIGABRT.');
                this.localStream = null;
                this.callbacks?.onLocalStream(null);
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
                        audioTimer = setTimeout(() => reject(new Error('Audio-only fallback also timed out')), 5000);
                    });
                    
                    this.localStream = await Promise.race([audioOnlyPromise, audioTimeout]);
                    this.callbacks?.onLocalStream(this.localStream);
                    return;
                } catch (e: any) {
                    if (audioTimer) clearTimeout(audioTimer);
                    console.warn('[WebRTCService] ⚠️ Audio fallback also failed or timed out:', e.message);
                }
            }
            
            // Critical fail-soft: even if NO media is available (Simulator/Busy Hardware), 
            // do NOT crash. Let signaling proceed so the call can at least connect.
            this.localStream = null;
            this.callbacks?.onLocalStream(null);
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

        // Add local tracks to connection
        if (this.localStream) {
            this.localStream.getTracks().forEach((track: any) => {
                this.peerConnection!.addTrack(track, this.localStream!);
            });
        }

        // Cast peerConnection for event handlers (react-native-webrtc types)
        const pc = this.peerConnection as any;

        // Handle incoming tracks
        pc.addEventListener('track', (event: any) => {
            console.log('Remote track received:', event.track?.kind);
            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
                this.callbacks?.onRemoteStream(this.remoteStream);
                this.setState('connected');
            }
        });

        // Handle ICE candidates
        pc.addEventListener('icecandidate', (event: any) => {
            if (event.candidate) {
                console.log('Sending ICE candidate');
                callService.sendIceCandidate(event.candidate);
            }
        });

        // Update connection state handler with recovery logic
        pc.addEventListener('connectionstatechange', () => {
            const state = pc.connectionState;
            console.log('[WebRTCService] Connection state:', state);

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
            console.log('[WebRTCService] ICE state:', iceState);

            switch (iceState) {
                case 'connected':
                case 'completed':
                    this.setState('connected');
                    this.reconnectAttempts = 0;
                    console.log('[WebRTCService] ✅ ICE connection established');
                    break;

                case 'disconnected':
                    // ICE layer disconnection is often transient
                    // Wait for auto-recovery before taking action
                    console.warn('[WebRTCService] ⚠️ ICE transiently disconnected. Waiting for auto-repair...');

                    // Give ICE 8 seconds to auto-repair
                    setTimeout(() => {
                        if (pc.iceConnectionState === 'disconnected') {
                            console.log('[WebRTCService] ICE still disconnected after 8 seconds. Checking connection state...');
                            // Don't end call yet - let connection state handler decide
                        }
                    }, 8000);
                    break;

                case 'checking':
                    console.log('[WebRTCService] ICE is checking connection candidates...');
                    break;

                case 'failed':
                    console.warn('[WebRTCService] ❌ ICE connection failed');
                    console.warn('[WebRTCService] Note: On 4G/5G networks, ensure TURN server is configured');
                    // Don't immediately end - connection state will handle it
                    break;

                case 'closed':
                    console.log('[WebRTCService] ICE connection closed');
                    this.reconnectAttempts = 0;
                    this.endCall('ice-closed');
                    break;
            }
        });

        console.log('Peer connection created');
    }

    private async createOffer(): Promise<void> {
        if (!this.peerConnection) return;

        const offerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: this.callType === 'video',
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
        if (!this.peerConnection) return;

        console.log(`Processing ${this.pendingCandidates.length} pending ICE candidates`);

        for (const candidate of this.pendingCandidates) {
            try {
                await this.peerConnection.addIceCandidate(candidate);
            } catch (error) {
                console.warn('Failed to add pending ICE candidate:', error);
            }
        }
        this.pendingCandidates = [];
    }

    private setState(state: CallState): void {
        this.callState = state;
        this.callbacks?.onStateChange(state);
    }

    // Add recovery attempt method
    private async attemptRecovery(): Promise<void> {
        try {
            console.log('[WebRTCService] Attempting manual recovery...');
            
            if (!this.peerConnection) {
                console.log('[WebRTCService] No peer connection available');
                return;
            }
            
            // Strategy 1: Restart ICE gathering (soft restart)
            if ('restartIce' in this.peerConnection) {
                console.log('[WebRTCService] Restarting ICE gathering...');
                await (this.peerConnection as any).restartIce();
            }
            
            // Strategy 2: Check local streams are still active
            if (this.localStream) {
                const audioTracks = this.localStream.getAudioTracks();
                const videoTracks = this.localStream.getVideoTracks();
                
                if (audioTracks.length === 0 || videoTracks.length === 0) {
                    console.log('[WebRTCService] Local stream tracks lost. Attempting to refresh...');
                    // Optionally re-get media here
                }
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
        this.callbacks = null; // Prevent further state updates
        this.endCall();
    }
}

export const webRTCService = new WebRTCService();
export type { CallState, CallType, WebRTCCallbacks };
