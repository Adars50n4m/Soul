import { Platform, PermissionsAndroid } from 'react-native';
import * as ENV from '../config/env';
import {
    theaterSyncService,
    TheaterSignalPayload,
    TheaterPresencePayload,
} from './TheaterSyncService';

// ─── react-native-webrtc lazy load ───────────────────────────────────────────
// Mirroring WebRTCService.ts: pull individual modules so we don't eagerly load
// RTCView from the package root (it can fail in builds where the video view
// manager is unavailable even when core peer connections work).
let RTCPeerConnection: any;
let RTCSessionDescription: any;
let RTCIceCandidate: any;
let mediaDevices: any;
let webRTCLoadError: string | null = null;

try {
    RTCPeerConnection = require('react-native-webrtc/lib/commonjs/RTCPeerConnection').default;
    RTCSessionDescription = require('react-native-webrtc/lib/commonjs/RTCSessionDescription').default;
    RTCIceCandidate = require('react-native-webrtc/lib/commonjs/RTCIceCandidate').default;
    mediaDevices = require('react-native-webrtc/lib/commonjs/MediaDevices').default;
} catch (e: any) {
    webRTCLoadError = e?.message || 'react-native-webrtc unavailable';
    console.warn('[TheaterRoom] WebRTC core modules failed to load:', webRTCLoadError);
}

// ─── ICE config ──────────────────────────────────────────────────────────────
const buildIceServers = (): any[] => {
    const servers: any[] = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];
    if (ENV.TURN_SERVER && ENV.TURN_USERNAME && ENV.TURN_PASSWORD) {
        servers.push({
            urls: `turn:${ENV.TURN_SERVER}`,
            username: ENV.TURN_USERNAME,
            credential: ENV.TURN_PASSWORD,
        });
    }
    if (ENV.TURN_SERVER_2 && ENV.TURN_USERNAME_2 && ENV.TURN_PASSWORD_2) {
        servers.push({
            urls: `turn:${ENV.TURN_SERVER_2}`,
            username: ENV.TURN_USERNAME_2,
            credential: ENV.TURN_PASSWORD_2,
        });
    }
    return servers;
};

const peerConnectionConfig = () => ({
    iceServers: buildIceServers(),
    sdpSemantics: 'unified-plan' as const,
    bundlePolicy: 'max-bundle' as const,
    rtcpMuxPolicy: 'require' as const,
    iceCandidatePoolSize: 4,
});

// ─── Permissions ─────────────────────────────────────────────────────────────
const ensureAndroidPermissions = async (camera: boolean, mic: boolean): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    const perms: any[] = [];
    if (mic) perms.push(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (camera) perms.push(PermissionsAndroid.PERMISSIONS.CAMERA);
    if (perms.length === 0) return true;
    try {
        const result = await PermissionsAndroid.requestMultiple(perms);
        return perms.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
    } catch (e) {
        console.warn('[TheaterRoom] Android permission request failed:', e);
        return false;
    }
};

// ─── Types ───────────────────────────────────────────────────────────────────
export interface TheaterRoomParticipant {
    userId: string;
    /** Most recent remote stream for this peer, if any. */
    stream: any | null;
    /** True if at least one of the remote tracks is currently enabled. */
    hasVideo: boolean;
    hasAudio: boolean;
    connectionState?: string;
}

export interface TheaterRoomState {
    inRoom: boolean;
    sessionId: string | null;
    localStream: any | null;
    cameraEnabled: boolean;
    micEnabled: boolean;
    /** Front camera by default; toggled via switchCamera. */
    cameraFacing: 'user' | 'environment';
    participants: Map<string, TheaterRoomParticipant>;
}

type RoomListener = (state: TheaterRoomState) => void;

// ─── Service ─────────────────────────────────────────────────────────────────
class TheaterRoomService {
    private userId: string | null = null;
    private sessionId: string | null = null;
    private peers: Map<string, any> = new Map();
    private participants: Map<string, TheaterRoomParticipant> = new Map();
    private localStream: any | null = null;
    private cameraEnabled = false;
    private micEnabled = false;
    private cameraFacing: 'user' | 'environment' = 'user';
    private listeners: Set<RoomListener> = new Set();
    private inRoom = false;

    isAvailable(): boolean {
        return !!RTCPeerConnection && !!mediaDevices;
    }

    getLoadError(): string | null {
        return webRTCLoadError;
    }

    subscribe(cb: RoomListener): () => void {
        this.listeners.add(cb);
        cb(this.snapshot());
        return () => { this.listeners.delete(cb); };
    }

    private emit(): void {
        const state = this.snapshot();
        this.listeners.forEach((cb) => {
            try { cb(state); } catch (err) { console.warn('[TheaterRoom] listener threw:', err); }
        });
    }

    private snapshot(): TheaterRoomState {
        return {
            inRoom: this.inRoom,
            sessionId: this.sessionId,
            localStream: this.localStream,
            cameraEnabled: this.cameraEnabled,
            micEnabled: this.micEnabled,
            cameraFacing: this.cameraFacing,
            participants: new Map(this.participants),
        };
    }

    private upsertParticipant(userId: string, patch: Partial<TheaterRoomParticipant>): void {
        const existing = this.participants.get(userId) || {
            userId,
            stream: null,
            hasVideo: false,
            hasAudio: false,
        };
        this.participants.set(userId, { ...existing, ...patch });
        this.emit();
    }

    private removeParticipant(userId: string): void {
        this.participants.delete(userId);
        const pc = this.peers.get(userId);
        if (pc) {
            try { pc.close(); } catch {}
            this.peers.delete(userId);
        }
        this.emit();
    }

    // ─── Room lifecycle ──────────────────────────────────────────────────────
    async joinRoom(sessionId: string, userId: string): Promise<void> {
        if (!this.isAvailable()) {
            console.warn('[TheaterRoom] WebRTC unavailable — joinRoom is a no-op');
            return;
        }
        if (this.inRoom && this.sessionId === sessionId) return;
        if (this.inRoom) this.leaveRoom();

        this.userId = userId;
        this.sessionId = sessionId;
        this.inRoom = true;

        theaterSyncService.setSignalingHandlers(
            (signal) => this.handleSignal(signal),
            (presence) => this.handlePresence(presence),
        );

        // Announce ourselves so existing peers can wake up and reply with `here`.
        theaterSyncService.sendPresence('join');
        this.emit();
    }

    leaveRoom(): void {
        if (!this.inRoom) return;
        try { theaterSyncService.sendPresence('leave'); } catch {}
        theaterSyncService.setSignalingHandlers(null, null);

        this.peers.forEach((pc) => { try { pc.close(); } catch {} });
        this.peers.clear();
        this.participants.clear();

        this.stopLocalTracks();

        this.inRoom = false;
        this.sessionId = null;
        this.userId = null;
        this.cameraEnabled = false;
        this.micEnabled = false;
        this.emit();
    }

    private stopLocalTracks(): void {
        if (this.localStream && typeof this.localStream.getTracks === 'function') {
            try {
                this.localStream.getTracks().forEach((t: any) => {
                    try { t.stop(); } catch {}
                });
            } catch {}
        }
        this.localStream = null;
    }

    // ─── Local media ─────────────────────────────────────────────────────────
    private async ensureLocalStream(want: { audio: boolean; video: boolean }): Promise<void> {
        if (!this.isAvailable()) throw new Error('WebRTC unavailable');

        const granted = await ensureAndroidPermissions(want.video, want.audio);
        if (!granted) throw new Error('Camera/Mic permission denied');

        const constraints: any = {
            audio: want.audio
                ? {
                      echoCancellation: true,
                      noiseSuppression: true,
                      autoGainControl: true,
                  }
                : false,
            video: want.video
                ? {
                      facingMode: this.cameraFacing,
                      width: { ideal: 640 },
                      height: { ideal: 480 },
                      frameRate: { ideal: 24, max: 30 },
                  }
                : false,
        };

        if (!this.localStream) {
            const stream = await mediaDevices.getUserMedia(constraints);
            this.localStream = stream;
            // Push tracks into every existing peer connection.
            this.peers.forEach((pc, userId) => {
                stream.getTracks().forEach((track: any) => {
                    try { pc.addTrack(track, stream); } catch (e) {
                        console.warn(`[TheaterRoom] addTrack to ${userId} failed:`, e);
                    }
                });
            });
            return;
        }

        // Stream exists — make sure the requested kinds are present.
        const haveAudio = this.localStream.getAudioTracks().length > 0;
        const haveVideo = this.localStream.getVideoTracks().length > 0;

        if (want.audio && !haveAudio) {
            const audioOnly = await mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
            audioOnly.getAudioTracks().forEach((track: any) => {
                this.localStream.addTrack(track);
                this.peers.forEach((pc) => { try { pc.addTrack(track, this.localStream); } catch {} });
            });
        }
        if (want.video && !haveVideo) {
            const videoOnly = await mediaDevices.getUserMedia({ audio: false, video: constraints.video });
            videoOnly.getVideoTracks().forEach((track: any) => {
                this.localStream.addTrack(track);
                this.peers.forEach((pc) => { try { pc.addTrack(track, this.localStream); } catch {} });
            });
        }
    }

    async enableMic(): Promise<void> {
        await this.ensureLocalStream({ audio: true, video: this.cameraEnabled });
        const audio = this.localStream?.getAudioTracks?.()[0];
        if (audio) audio.enabled = true;
        this.micEnabled = true;
        this.emit();
    }

    disableMic(): void {
        const audio = this.localStream?.getAudioTracks?.()[0];
        if (audio) audio.enabled = false;
        this.micEnabled = false;
        this.emit();
    }

    async enableCamera(): Promise<void> {
        await this.ensureLocalStream({ audio: this.micEnabled, video: true });
        const video = this.localStream?.getVideoTracks?.()[0];
        if (video) video.enabled = true;
        this.cameraEnabled = true;
        this.emit();
    }

    disableCamera(): void {
        const video = this.localStream?.getVideoTracks?.()[0];
        if (video) video.enabled = false;
        this.cameraEnabled = false;
        this.emit();
    }

    switchCamera(): void {
        const video = this.localStream?.getVideoTracks?.()[0];
        if (video && typeof video._switchCamera === 'function') {
            video._switchCamera();
            this.cameraFacing = this.cameraFacing === 'user' ? 'environment' : 'user';
            this.emit();
        }
    }

    // ─── Peer connection plumbing ────────────────────────────────────────────
    private getOrCreatePc(remoteUserId: string): any {
        let pc = this.peers.get(remoteUserId);
        if (pc) return pc;

        pc = new RTCPeerConnection(peerConnectionConfig());
        this.peers.set(remoteUserId, pc);

        // Push our existing local tracks to the new peer immediately.
        if (this.localStream) {
            this.localStream.getTracks().forEach((track: any) => {
                try { pc.addTrack(track, this.localStream); } catch {}
            });
        }

        pc.addEventListener('icecandidate', (event: any) => {
            if (event.candidate) {
                theaterSyncService.sendSignal({
                    targetUserId: remoteUserId,
                    kind: 'ice',
                    candidate: event.candidate.toJSON?.() || event.candidate,
                });
            }
        });

        pc.addEventListener('track', (event: any) => {
            // New remote track — attach the first stream we receive for this peer.
            const stream = event.streams && event.streams[0];
            this.upsertParticipant(remoteUserId, {
                stream: stream || this.participants.get(remoteUserId)?.stream || null,
                hasVideo: this.hasEnabledKind(stream, 'video'),
                hasAudio: this.hasEnabledKind(stream, 'audio'),
            });
        });

        pc.addEventListener('connectionstatechange', () => {
            this.upsertParticipant(remoteUserId, { connectionState: pc.connectionState });
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                this.removeParticipant(remoteUserId);
            }
        });

        return pc;
    }

    private hasEnabledKind(stream: any, kind: 'audio' | 'video'): boolean {
        if (!stream || typeof stream.getTracks !== 'function') return false;
        return stream.getTracks().some((t: any) => t.kind === kind && t.enabled !== false);
    }

    // ─── Signaling handlers ──────────────────────────────────────────────────
    private async handlePresence(presence: TheaterPresencePayload): Promise<void> {
        if (!this.inRoom || presence.sessionId !== this.sessionId) return;
        const remoteId = presence.fromUserId;
        if (!remoteId || remoteId === this.userId) return;

        if (presence.kind === 'leave') {
            this.removeParticipant(remoteId);
            return;
        }

        // `join` — fresh entrant. Acknowledge with `here` so they can discover
        // us, then attempt to dial them ourselves if our user id sorts greater
        // (glare-free deterministic offerer rule).
        // `here` — existing peer responding to our join. Same dial logic.
        const shouldIDial = !!this.userId && this.userId.localeCompare(remoteId) > 0;

        if (presence.kind === 'join') {
            try { theaterSyncService.sendPresence('here'); } catch {}
        }

        if (!this.peers.has(remoteId) && shouldIDial) {
            await this.dial(remoteId);
        }
    }

    private async handleSignal(signal: TheaterSignalPayload): Promise<void> {
        if (!this.inRoom || signal.sessionId !== this.sessionId) return;
        if (signal.targetUserId !== this.userId) return;
        const remoteId = signal.fromUserId;
        const pc = this.getOrCreatePc(remoteId);

        try {
            if (signal.kind === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                theaterSyncService.sendSignal({
                    targetUserId: remoteId,
                    kind: 'answer',
                    sdp: { type: answer.type, sdp: answer.sdp },
                });
                return;
            }
            if (signal.kind === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                return;
            }
            if (signal.kind === 'ice' && signal.candidate) {
                try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); }
                catch (e) { console.warn('[TheaterRoom] addIceCandidate failed:', e); }
                return;
            }
        } catch (err) {
            console.warn(`[TheaterRoom] signal handle failed (${signal.kind}):`, err);
        }
    }

    /**
     * Manually open an offer to a remote peer. Called when we are the
     * joining user and we have just received an existing peer's `here`
     * acknowledgement (delivered via handlePresence).
     */
    async dial(remoteUserId: string): Promise<void> {
        if (!this.inRoom) return;
        if (!remoteUserId || remoteUserId === this.userId) return;
        if (this.peers.has(remoteUserId)) return;
        const pc = this.getOrCreatePc(remoteUserId);
        try {
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);
            theaterSyncService.sendSignal({
                targetUserId: remoteUserId,
                kind: 'offer',
                sdp: { type: offer.type, sdp: offer.sdp },
            });
        } catch (err) {
            console.warn('[TheaterRoom] dial failed:', err);
            this.removeParticipant(remoteUserId);
        }
    }
}

export const theaterRoomService = new TheaterRoomService();
