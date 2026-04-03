import { NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';
import { callService, CallSignal } from './CallService';
import * as ENV from '../config/env';

// Safe imports for WebRTC core modules.
// Importing the root package eagerly also loads RTCView, which can fail in
// builds where the video view manager is unavailable even if core calling works.
let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCIceCandidate: any;
let mediaDevices: any;
let MediaStream: any;
let webRTCCoreLoadError: string | null = null;
let webRTCNativeModule: any = null;
let webRTCNativeReady = false;

try {
    webRTCNativeModule = (NativeModules as any)?.WebRTCModule ?? null;
    webRTCNativeReady =
        !!webRTCNativeModule &&
        typeof webRTCNativeModule.peerConnectionInit === 'function' &&
        typeof webRTCNativeModule.getUserMedia === 'function';
    if (!webRTCNativeReady) {
        webRTCCoreLoadError =
            'WebRTC native module missing in this build. Rebuild Android/iOS dev client after prebuild.';
        console.log('[WebRTCService] WebRTC native module unavailable:', {
            hasModule: !!webRTCNativeModule,
            hasPeerConnectionInit: typeof webRTCNativeModule?.peerConnectionInit === 'function',
            hasGetUserMedia: typeof webRTCNativeModule?.getUserMedia === 'function',
        });
    }
} catch (e: any) {
    webRTCCoreLoadError = e?.message || 'unknown-native-module-error';
    console.log('[WebRTCService] Failed to inspect WebRTC native module:', webRTCCoreLoadError);
}

try {
    RTCPeerConnection = require('react-native-webrtc/lib/commonjs/RTCPeerConnection').default;
    RTCSessionDescription = require('react-native-webrtc/lib/commonjs/RTCSessionDescription').default;
    RTCIceCandidate = require('react-native-webrtc/lib/commonjs/RTCIceCandidate').default;
    mediaDevices = require('react-native-webrtc/lib/commonjs/MediaDevices').default;
    MediaStream = require('react-native-webrtc/lib/commonjs/MediaStream').default;
} catch (e: any) {
    webRTCCoreLoadError = webRTCCoreLoadError || e?.message || 'unknown';
    console.log('[WebRTCService] Native modules not available:', webRTCCoreLoadError);
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
const CUSTOM_TURN_SERVERS: any[] = [
  ...(ENV.TURN_SERVER && ENV.TURN_SERVER.length > 10 && !ENV.TURN_SERVER.includes('yourdomain') ? [{
    urls: ['turn:' + ENV.TURN_SERVER],
    username: ENV.TURN_USERNAME,
    credential: ENV.TURN_PASSWORD
  }] : []),
  ...(ENV.TURN_SERVER_2 && ENV.TURN_SERVER_2.length > 10 && !ENV.TURN_SERVER_2.includes('backup-turn') ? [{
    urls: ['turn:' + ENV.TURN_SERVER_2],
    username: ENV.TURN_USERNAME_2,
    credential: ENV.TURN_PASSWORD_2
  }] : []),
];

const OPEN_RELAY_TURN_SERVERS: any[] = [
  {
    urls: 'turns:openrelay.metered.ca:443',
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
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const ICE_SERVERS: any[] = [
  // Prefer your own TURN first for reliability and predictable capacity.
  ...CUSTOM_TURN_SERVERS,
  // Free TURN fallback.
  ...OPEN_RELAY_TURN_SERVERS,
  // STUN (used when direct path is available).
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const HAS_CUSTOM_TURN =
    CUSTOM_TURN_SERVERS.length > 0;

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
    private signalingRole: 'offerer' | 'answerer' | 'none' = 'none';

    // Recovery tracking
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private connectionWatchdog: NodeJS.Timeout | null = null;
    private trackMonitorTimer: NodeJS.Timeout | null = null;
    private lastDisconnectTime: number = 0;
    private lastRecoveryAttemptAt: number = 0;
    private readonly RECOVERY_COOLDOWN_MS = 12000;

    isAvailable(): boolean {
        return webRTCNativeReady
            && !!RTCPeerConnection
            && !!RTCSessionDescription
            && !!RTCIceCandidate
            && !!mediaDevices
            && !!MediaStream;
    }

    getAvailabilityError(): string {
        if (!webRTCNativeReady) {
            return webRTCCoreLoadError
                || 'WebRTC native module missing in current binary. Build a dev client with react-native-webrtc linked.';
        }
        return webRTCCoreLoadError || 'WebRTC core modules are unavailable in the current build.';
    }

    private ensureTurnReadinessOrThrow(): void {
        if (ENV.CALL_REQUIRE_CUSTOM_TURN && !HAS_CUSTOM_TURN) {
            const message =
                'Calling is blocked: custom TURN server is not configured. Set EXPO_PUBLIC_TURN_SERVER/USERNAME/PASSWORD.';
            console.error('[WebRTCService] ' + message);
            this.broadcast('onError', message);
            throw new Error(message);
        }
    }

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
            if (!this.isAvailable()) {
                const message = this.getAvailabilityError();
                this.broadcast('onError', message);
                throw new Error(message);
            }
            this.ensureTurnReadinessOrThrow();

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
            this.signalingRole = 'offerer';
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
            this.ensureTurnReadinessOrThrow();

            if (this.peerConnection && this.peerConnection.signalingState !== 'stable') {
                console.log('[WebRTCService] Ignoring offer: signalingState is not stable:', this.peerConnection.signalingState);
                return;
            }

            this.callType = callType;
            this.isInitiator = false;
            this.signalingRole = 'answerer';
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
        // [AUTO-CUT FIX] Ignore signals sent by OURSELVES (loopy signaling)
        const myId = callService.getUserId();
        if (myId) {
            const normalizedMyId = (myId || '').toString().toLowerCase();
            const normalizedSenderId = (signal.callerId || (signal as any).sender_id || '').toString().toLowerCase();
            
            // If sender is us, ignore everything except essential response types if needed
            // But normally, we never need to process our own broadcast echoes.
            if (normalizedMyId === normalizedSenderId) {
                return;
            }
        }

        try {
            if (!this.peerConnection && signal.type !== 'offer') {
                console.log(`[WebRTCService] Ignoring ${signal.type}: no peer connection`);
                return;
            }

            switch (signal.type) {
                case 'offer':
                    console.log('Received WebRTC offer. Current state:', this.peerConnection?.signalingState);
                    
                    // GLARE PROTECTION: If we both send an offer, the "polite" peer lets the other win.
                    // We define "polite" as having the alphabetically later ID.
                    if (this.peerConnection?.signalingState === 'have-local-offer') {
                        const myId = callService.getUserId() || '';
                        const partnerId = signal.callerId || '';
                        if (myId.toLowerCase() < partnerId.toLowerCase()) {
                            console.log('[WebRTCService] 🚨 Signaling glare! We are "impolite", keeping our offer.');
                            return;
                        } else {
                            console.log('[WebRTCService] 🚨 Signaling glare! We are "polite", rolling back our offer to accept theirs.');
                            await this.peerConnection.setLocalDescription({ type: 'rollback' } as any);
                        }
                    }
                    
                    await this.answerCall(signal.callType, signal.payload);
                    break;

                case 'answer':
                    console.log('Received WebRTC answer. Current state:', this.peerConnection?.signalingState);
                    if (this.peerConnection && signal.payload) {
                        // Guard: Only apply answer if we are expecting one
                        if (this.peerConnection.signalingState !== 'have-local-offer' || this.peerConnection.remoteDescription) {
                            console.log('[WebRTCService] Ignoring duplicate/invalid answer signal (state:', this.peerConnection.signalingState, ')');
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
        this.signalingRole = 'none';

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
     * Switch call media mode between audio and video during an active call.
     * This keeps the same room/session and triggers renegotiation.
     */
    async switchCallType(nextType: CallType): Promise<void> {
        if (nextType === this.callType) return;

        console.log(`[WebRTCService] Switching call mode: ${this.callType} -> ${nextType}`);

        if (!this.peerConnection) {
            this.callType = nextType;
            if (!this.localStream) {
                await this.prepareCall(nextType);
            }
            return;
        }

        if (nextType === 'video') {
            if (!mediaDevices?.getUserMedia) {
                throw new Error(this.getAvailabilityError());
            }

            if (!this.localStream) {
                this.callType = 'video';
                await this.getMediaStream();
            } else {
                const existingVideo = this.localStream.getVideoTracks();
                if (existingVideo.length === 0) {
                    const camStream = await mediaDevices.getUserMedia({
                        audio: false,
                        video: { facingMode: 'user' },
                    });
                    const videoTracks = camStream?.getVideoTracks?.() || [];
                    for (const track of videoTracks) {
                        track.enabled = true;
                        try { this.localStream.addTrack(track); } catch (_) {}
                        try { this.peerConnection.addTrack(track, this.localStream); } catch (_) {}
                    }
                } else {
                    existingVideo.forEach((track: any) => { track.enabled = true; });
                }
            }
        } else {
            // Downgrade to audio: remove local video tracks and related senders
            if (this.localStream) {
                const videoTracks = this.localStream.getVideoTracks();
                for (const track of videoTracks) {
                    try { track.enabled = false; } catch (_) {}
                    try { track.stop(); } catch (_) {}
                    try { this.localStream.removeTrack(track); } catch (_) {}
                }
            }

            try {
                const senders = this.peerConnection.getSenders?.() || [];
                for (const sender of senders) {
                    const senderTrack = sender?.track;
                    if (senderTrack?.kind === 'video') {
                        try { await sender.replaceTrack(null); } catch (_) {}
                        try { this.peerConnection.removeTrack(sender); } catch (_) {}
                    }
                }
            } catch (error) {
                console.warn('[WebRTCService] Failed to remove video sender during audio downgrade:', error);
            }
        }

        this.callType = nextType;
        this.broadcast('onLocalStream', this.localStream);

        // Trigger renegotiation from this side if we're in a stable state.
        if (this.peerConnection.signalingState === 'stable') {
            await this.createOffer();
        } else {
            console.log(`[WebRTCService] Skipping immediate renegotiation, signalingState=${this.peerConnection.signalingState}`);
        }
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

            if (!mediaDevices?.getUserMedia) {
                throw new Error(this.getAvailabilityError());
            }
            
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
            
            // CRITICAL: Explicitly enable tracks. Sometimes they are created in a disabled or muted state.
            this.localStream.getTracks().forEach(track => {
                track.enabled = true;
                console.log(`[WebRTCService] ✅ Local ${track.kind} track ready: ${track.id} (enabled: ${track.enabled})`);
            });
            
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
        if (!webRTCNativeReady) {
            throw new Error(this.getAvailabilityError());
        }
        const config: any = {
            iceServers: ICE_SERVERS,
            // FIX #13: Explicitly set sdpSemantics for better Android/modern-WebRTC compatibility
            sdpSemantics: 'unified-plan',
            // OPTIMIZATION: pre-fetch candidates to speed up initial connection by 1-2s
            iceCandidatePoolSize: 10,
            // Optional hardening for restrictive carrier networks.
            iceTransportPolicy: ENV.CALL_FORCE_RELAY ? 'relay' : 'all'
        };

        if (!RTCPeerConnection) {
            console.error('RTCPeerConnection is not defined. Check react-native-webrtc installation.');
            throw new Error('WebRTC engine not available. You are likely using Expo Go. Please use a Development Build.');
        }

        try {
            this.peerConnection = new RTCPeerConnection(config);
        } catch (pcError: any) {
            const msg = String(pcError?.message || pcError || 'unknown');
            if (msg.includes('peerConnectionInit') || msg.includes('null')) {
                throw new Error(
                    'WebRTC native module is not initialized in this app build. Please rebuild dev client (expo prebuild + expo run:android/ios).'
                );
            }
            throw pcError;
        }

        // UNIFIED PLAN TRACK MANAGEMENT
        // With 'unified-plan', we use addTrack to link tracks to streams correctly.
        // We avoid manual addTransceiver for basic 1:1 calls to prevent SDP bloat/conflicts,
        // as addTrack automatically creates the necessary transceivers.

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
            const track = event.track;
            
            // IGNORE if no track
            if (!track) return;

            console.log(`[WebRTCService] 📡 Remote track received: ${kind} | State: ${track.readyState} | Enabled: ${track.enabled}`);
            
            // CRITICAL: Explicitly enable the track. Sometimes they arrive disabled.
            try {
                if (track.enabled === false) {
                    console.log(`[WebRTCService] 🛠 Enabling disabled remote track: ${kind}`);
                    track.enabled = true;
                }
            } catch (e) {
                console.warn('[WebRTCService] Failed to explicitly enable track:', e);
            }

            if (event.streams && event.streams[0]) {
                this.remoteStream = event.streams[0];
                console.log(`[WebRTCService] 📡 Remote stream attached: ${this.remoteStream.id}`);
            } else {
                console.warn('[WebRTCService] 📡 Track received but no streams found in event — creating local container');
                // Fallback: if we have a track but it's not in a stream, create one
                if (!this.remoteStream) {
                    this.remoteStream = new MediaStream();
                }
                
                // Only add if not already present
                const tracks = this.remoteStream.getTracks();
                const exists = tracks.some((t: any) => t.id === track.id);
                if (!exists) {
                    this.remoteStream.addTrack(track);
                }
            }

            if (this.remoteStream) {
                // Double-check: ensure all tracks in the container are enabled and live
                this.remoteStream.getTracks().forEach((t: any) => {
                    if (!t.enabled) {
                        console.log(`[WebRTCService] 🛠 Auto-enabling track ${t.id} in stream container`);
                        t.enabled = true;
                    }
                });

                this.broadcast('onRemoteStream', this.remoteStream);
                
                // Any remote media means we are connected
                this.setState('connected');
                
                // Verify encryption
                this.verifyEncryption();
            }
        });

        // Handle ICE candidates
        pc.addEventListener('icecandidate', (event: any) => {
            if (!event.candidate) {
                console.log('[WebRTCService] ICE candidates collection finished (End-of-Candidates)');
                return;
            }
            
            // IGNORE mDNS candidates on Android/iOS as they often fail signaling
            if (event.candidate.candidate.includes('.local')) {
                console.log('[WebRTCService] Skipping mDNS candidate (unsupported on mobile signaling)');
                return;
            }

            const parts = event.candidate.candidate.split(' ');
            const type = parts[7] || 'unknown';
            console.log(`[WebRTCService] 🧊 Local ICE candidate generated: ${type} (${parts[0]} ${parts[1]} ${parts[2]})`);
            callService.sendIceCandidate(event.candidate);
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
            console.log('[WebRTCService] 📡 Connected! Broadcasting tracks. Local:', this.localStream?.getTracks().length, 'Remote:', this.remoteStream?.getTracks().length);
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
                    console.warn('[WebRTCService] 🚨 Connection watchdog timeout! Call failed to connect in 35s.');
                    this.endCall('connection-timeout');
                    this.broadcast('onError', 'Call connection failed. This is usually due to restrictive network firewalls.');
                }
            }, 35000); // Increased to 35s to allow for cellular TURN relay negotiation
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
        
        let counter = 0;
        this.trackMonitorTimer = setInterval(() => {
            if (!this.peerConnection) {
                this.stopTrackMonitoring();
                return;
            }
            
            counter++;
            const localAudio = this.localStream?.getAudioTracks() || [];
            const remoteAudio = this.remoteStream?.getAudioTracks() || [];
            const remoteVideo = this.remoteStream?.getVideoTracks() || [];
            const iceState = this.getIceConnectionState();
            const sigState = this.getSignalingState();

            const lAudioInfo = localAudio.map((t: any) => `${t.readyState}${t.enabled?'✔️':'❌'}${t.muted?'🔇':''}`).join(',');
            const rAudioInfo = remoteAudio.map((t: any) => `${t.readyState}${t.enabled?'✔️':'❌'}${t.muted?'🔇':''}`).join(',');

            // Log stats every 5s (standard) or every 2s for the first 10s of connection (aggressive)
            if (counter <= 5 || counter % 2 === 0) {
                console.log(`[WebRTC_STATS] Role: ${this.isInitiator ? 'In' : 'Rx'} | ICE: ${iceState} | SIG: ${sigState} | Audio-L: [${lAudioInfo}] Audio-R: [${rAudioInfo}] | Video-R: ${remoteVideo.length}`);
            }
            
            // AUTO-RECOVERY: If we are connected but have 0 remote audio tracks or they are muted after 6 seconds, 
            // it might be a signaling race condition or a codec mismatch.
            if (this.callState === 'connected' && counter > 3) {
                const hasNoAudio = remoteAudio.length === 0;
                const allMuted = remoteAudio.length > 0 && remoteAudio.every((t: any) => t.muted);
                
                if (hasNoAudio || allMuted) {
                    console.warn(`[WebRTCService] ⚠️ ${hasNoAudio ? '0 remote tracks' : 'Muted remote tracks'} detected! Attempting recovery...`);
                    // If we have transceivers, check their direction
                    try {
                        const transceivers = this.peerConnection.getTransceivers();
                        transceivers.forEach((tr: any) => {
                            if (tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'audio') {
                                if (!tr.receiver.track.enabled) tr.receiver.track.enabled = true;
                            }
                        });
                    } catch (e) {}

                    const now = Date.now();
                    if (now - this.lastRecoveryAttemptAt >= this.RECOVERY_COOLDOWN_MS) {
                        this.lastRecoveryAttemptAt = now;
                        this.attemptRecovery().catch((e) => {
                            console.warn('[WebRTCService] Recovery trigger from monitor failed:', e);
                        });
                    }
                }
            }
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
            
            if (typeof this.peerConnection.restartIce === 'function') {
                try {
                    this.peerConnection.restartIce();
                    console.log('[WebRTCService] restartIce() invoked');
                } catch (e) {
                    console.warn('[WebRTCService] restartIce() failed:', e);
                }
            }

            // Controlled renegotiation with ICE restart.
            if (this.peerConnection.signalingState === 'stable') {
                const offerOptions = {
                    iceRestart: true,
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: this.callType === 'video',
                };
                const offer = await this.peerConnection.createOffer(offerOptions);
                await this.peerConnection.setLocalDescription(offer);
                callService.sendOffer(offer);
            } else {
                console.log(`[WebRTCService] Skipping recovery offer, signalingState=${this.peerConnection.signalingState}`);
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
