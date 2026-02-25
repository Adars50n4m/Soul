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

import { Platform } from 'react-native';
import { callService, CallSignal } from './CallService';

// STUN/TURN servers for NAT traversal
// STUN/TURN servers for NAT traversal
// IMPORTANT: For production (4G/5G), you MUST add a TURN server.
const ICE_SERVERS: RTCIceServer[] = [
    // Google STUN servers (Good for testing, but not for 4G/5G symmetric NAT)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },

    // OpenRelay Free TURN Servers (Fixes 4G/5G connection issues)
    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    // Add a public TURN server if possible, or ensure you are testing on WiFi.
    // For 4G/5G, you strictly need a TURN server.
    // {
    //    urls: 'turn:openrelay.metered.ca:80',
    //    username: 'openrelayproject',
    //    credential: 'openrelayproject'
    // }
    // --- PRODUCTION CONFIGURATION START ---
    // Uncomment and replace with your credentials (e.g. from Metered.ca or OpenRelay)
    /*
    {
        urls: 'turn:global.turn.metered.ca:80',
        username: 'YOUR_USERNAME',
        credential: 'YOUR_PASSWORD'
    },
    {
        urls: 'turn:global.turn.metered.ca:443',
        username: 'YOUR_USERNAME',
        credential: 'YOUR_PASSWORD'
    },
    */
    // --- PRODUCTION CONFIGURATION END ---
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
    private pendingCandidates: RTCIceCandidate[] = [];

    /**
     * Initialize WebRTC service with callbacks
     */
    initialize(callbacks: WebRTCCallbacks): void {
        this.callbacks = callbacks;
        
        // If we already have a peer connection, we are re-attaching (e.g. returning from PiP)
        if (this.peerConnection) {
            console.log('[WebRTCService] Re-attaching callbacks to existing call');
            this.callbacks.onStateChange(this.callState);
            if (this.localStream) this.callbacks.onLocalStream(this.localStream);
            if (this.remoteStream) this.callbacks.onRemoteStream(this.remoteStream);
        } else {
            this.setState('idle');
        }
    }

    /**
     * Update callbacks without resetting state (used for PiP/Minimize)
     */
    setCallbacks(callbacks: WebRTCCallbacks | null): void {
        this.callbacks = callbacks;
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

    /**
     * Start a call (as initiator)
     */
    async startCall(): Promise<void> {
        try {
            this.isInitiator = true;
            this.setState('ringing');

            // Ensure media is ready (if not already)
            if (!this.localStream) {
                await this.prepareCall(this.callType);
            }

            // Create peer connection
            await this.createPeerConnection();

            // We wait for 'call-accepted' from the partner.
            console.log('[WebRTCService] ✅ Call initiated, waiting for partner to accept...');
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
        console.log(`[WebRTCService] onCallAccepted called. peerConnection: ${!!this.peerConnection}, isInitiator: ${this.isInitiator}`);
        if (this.isInitiator && this.peerConnection) {
            console.log('[WebRTCService] Partner accepted call, creating offer...');
            this.setState('connecting');
            await this.createOffer();
        } else if (this.isInitiator) {
            console.warn('[WebRTCService] ⚠️ Partner accepted but peerConnection is not ready yet');
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

            // Ensure media is ready
            if (!this.localStream) {
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
        try {
            console.log('Getting media stream for', this.callType);

            const constraints: any = {
                audio: true,
                video: this.callType === 'video' ? {
                    facingMode: 'user',
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 },
                } : false,
            };

            this.localStream = await mediaDevices.getUserMedia(constraints) as MediaStream;
            this.callbacks?.onLocalStream(this.localStream);
            console.log('Local stream obtained successfully');

        } catch (error: any) {
            console.warn('[WebRTCService] ⚠️ getMediaStream failed:', error.message);
            
            // Simulator Fallback: If camera fails but it's a simulator, don't crash
            if (Platform.OS === 'ios' && error.message?.includes('found')) {
                console.log('[WebRTCService] 🛡️ Simulator detected or no camera found, proceeding with audio-only or black stream');
                // Try audio only as last resort
                try {
                    this.localStream = await mediaDevices.getUserMedia({ audio: true, video: false }) as MediaStream;
                    this.callbacks?.onLocalStream(this.localStream);
                    return;
                } catch (e) {
                    console.error('[WebRTCService] ❌ Audio also failed:', e);
                }
            }
            throw new Error(`Media access denied: ${error.message}`);
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

        // Handle connection state changes
        pc.addEventListener('connectionstatechange', () => {
            const state = pc.connectionState;
            console.log('[WebRTCService] Connection state:', state);

            switch (state) {
                case 'connected':
                    this.setState('connected');
                    break;
                case 'disconnected':
                    // 'disconnected' is a TRANSIENT, recoverable state.
                    // WebRTC will attempt to reconnect. Do NOT end the call here.
                    console.warn('[WebRTCService] Connection transiently disconnected. Waiting for recovery...');
                    break;
                case 'failed':
                case 'closed':
                    // 'failed' and 'closed' are final states indicating the connection is truly lost.
                    console.warn(`[WebRTCService] Connection permanently ${state}. Ending call.`);
                    this.endCall(`pc-state-${state}`);
                    break;
            }
        });

        // Handle ICE connection state
        pc.addEventListener('iceconnectionstatechange', () => {
            const iceState = pc.iceConnectionState;
            console.log('[WebRTCService] ICE state:', iceState);
            if (iceState === 'connected' || iceState === 'completed') {
                this.setState('connected');
            } else if (iceState === 'disconnected') {
                // 'disconnected' is transient – ICE will attempt to repair. Do NOT end call.
                console.warn('[WebRTCService] ICE transiently disconnected. Waiting for recovery...');
            } else if (iceState === 'failed') {
                console.error('[WebRTCService] ICE failed permanently. If on 4G/5G, a TURN server is required.');
                this.endCall();
            } else if (iceState === 'closed') {
                console.log('[WebRTCService] ICE closed.');
                this.endCall();
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

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        console.log('Sending answer...');
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
