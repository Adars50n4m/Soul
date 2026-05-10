import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';

export type TheaterAction =
    | 'play'
    | 'pause'
    | 'seek'
    | 'heartbeat'
    | 'sync'
    | 'end'
    | 'change_video';

export interface TheaterVideoMeta {
    videoId: string;
    mediaTitle?: string;
    channelTitle?: string;
    thumbnail?: string;
    durationSec?: number;
}

export interface TheaterPlaybackState {
    sessionId: string;
    isPlaying: boolean;
    /** Position in milliseconds */
    position: number;
    /** Sender wall-clock time when this state was emitted (ms) */
    updatedAt: number;
    /** User id of the broadcaster */
    updatedBy: string;
    action?: TheaterAction;
    /**
     * Only populated when action === 'change_video'. Carries the new YouTube
     * video the host wants everyone to switch to. Receivers swap their iframe's
     * videoId, reset position to 0, and the host's playing flag is honoured.
     */
    videoMeta?: TheaterVideoMeta;
}

export type TheaterSyncScope =
    | { type: 'none' }
    | { type: 'session'; sessionId: string };

type TheaterUpdateEvent =
    | 'update'
    | 'sync_request'
    | 'ping'
    | 'pong';

type TheaterUpdateCallback = (state: TheaterPlaybackState, eventType: TheaterUpdateEvent) => void;

export type TheaterSignalKind = 'offer' | 'answer' | 'ice';

export interface TheaterSignalPayload {
    sessionId: string;
    fromUserId: string;
    targetUserId: string;
    kind: TheaterSignalKind;
    sdp?: any;
    candidate?: any;
}

export interface TheaterPresencePayload {
    sessionId: string;
    fromUserId: string;
    /**
     * `join` — newcomer broadcasting they have entered the room.
     * `here` — existing peer's acknowledgement. Lets late joiners discover
     *          who is already in the room (postgres_changes-style state pull).
     * `leave` — explicit teardown.
     */
    kind: 'join' | 'here' | 'leave';
}

type TheaterSignalCallback = (payload: TheaterSignalPayload) => void;
type TheaterPresenceCallback = (payload: TheaterPresencePayload) => void;

export interface TheaterViewer {
    userId: string;
    joinedAt: number;
}

export type TheaterViewerListCallback = (viewers: TheaterViewer[]) => void;

const MAX_RETRIES = 3;

class TheaterSyncService {
    private onUpdate: TheaterUpdateCallback | null = null;
    private onSignal: TheaterSignalCallback | null = null;
    private onPresence: TheaterPresenceCallback | null = null;
    private onViewerList: TheaterViewerListCallback | null = null;
    private userId: string | null = null;
    private isInitialized = false;
    private channel: RealtimeChannel | null = null;
    private retryCount = 0;
    private retryTimeout: ReturnType<typeof setTimeout> | null = null;
    private errorHandled = false;
    private scope: TheaterSyncScope = { type: 'none' };
    private clockSynced = false;
    /**
     * Set when requestSync() is called before the realtime channel finishes
     * SUBSCRIBE. Without this the very first sync probe a guest sends after
     * joinSession() gets silently dropped by sendBroadcast() and the host
     * never knows there's a new viewer to catch up. Flushed on SUBSCRIBED.
     */
    private pendingSyncRequest = false;

    private isChannelReady(): boolean {
        return !!this.channel && this.channel.state === 'joined';
    }

    private sendBroadcast(
        event:
            | 'theater_update'
            | 'sync_request'
            | 'ping'
            | 'pong'
            | 'webrtc_signal'
            | 'webrtc_presence',
        payload: Record<string, any>,
    ): void {
        if (!this.isChannelReady()) return;
        this.channel!.send({
            type: 'broadcast',
            event,
            payload,
        }).catch((err) => {
            console.warn(`[TheaterSync] broadcast(${event}) failed:`, err);
        });
    }

    get sessionId(): string | null {
        return this.scope.type === 'session' ? this.scope.sessionId : null;
    }

    getCurrentScope(): TheaterSyncScope {
        return this.scope;
    }

    initialize(userId: string, callback: TheaterUpdateCallback): void {
        this.userId = userId;
        this.onUpdate = callback;
        this.isInitialized = true;
    }

    joinSession(sessionId: string): void {
        if (this.scope.type === 'session' && this.scope.sessionId === sessionId) return;
        this.scope = { type: 'session', sessionId };
        this.retryCount = 0;
        this.clockSynced = false;
        this.pendingSyncRequest = false;
        if (this.isInitialized) {
            this.setupBroadcastListener();
        }
    }

    leaveSession(sessionId?: string): void {
        if (this.scope.type !== 'session') return;
        if (sessionId && this.scope.sessionId !== sessionId) return;
        this.scope = { type: 'none' };
        this.clockSynced = false;
        this.pendingSyncRequest = false;
        this.pendingPresenceRequests = [];
        this.teardownChannel();
    }

    markClockSynced(): void {
        this.clockSynced = true;
    }

    isClockSynced(): boolean {
        return this.clockSynced;
    }

    private buildChannelName(): string | null {
        if (!this.userId) return null;
        if (this.scope.type === 'session') {
            return `theater_${this.scope.sessionId}`;
        }
        return null;
    }

    private isEventRelevant(state: Partial<TheaterPlaybackState>): boolean {
        if (!this.userId) return false;
        if (!state || typeof state.updatedBy !== 'string') return false;
        if (state.updatedBy === this.userId) return false;
        return this.scope.type === 'session';
    }

    private teardownChannel(): void {
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        if (this.channel) {
            // Best-effort untrack so other viewers' presence rosters update
            // immediately instead of waiting for Supabase's presence timeout.
            try { void this.channel.untrack(); } catch {}
            try { supabase.removeChannel(this.channel); } catch (e) { console.warn('[TheaterSync] removeChannel failed:', e); }
            this.channel = null;
        }
        this.errorHandled = true;
        // Clear the viewer list locally so the UI doesn't keep stale entries
        // hanging around after we leave.
        try { this.onViewerList?.([]); } catch {}
    }

    private setupBroadcastListener(): void {
        const channelName = this.buildChannelName();
        if (!this.userId || !channelName) {
            this.teardownChannel();
            return;
        }

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        if (this.channel) {
            try { supabase.removeChannel(this.channel); } catch (e) { console.warn('[TheaterSync] removeChannel failed:', e); }
            this.channel = null;
        }

        if (this.retryCount >= MAX_RETRIES) {
            console.log(`[TheaterSync] Paused after ${MAX_RETRIES} failures. Will retry on foreground.`);
            return;
        }

        this.errorHandled = false;
        console.log(`[TheaterSync] Connecting: ${channelName} (attempt ${this.retryCount + 1}/${MAX_RETRIES})`);

        this.channel = supabase.channel(channelName, {
            config: {
                broadcast: { self: false },
                // `key` is what Supabase uses to dedupe presence rows for the
                // same user across reconnects — without it a flaky network
                // produces phantom viewers in the participant list.
                presence: { key: this.userId },
            },
        });

        // Real-time viewer presence — every device on this channel calls
        // channel.track() once SUBSCRIBED, and Supabase pushes us a fresh
        // membership snapshot on every join/leave. This is the source of
        // truth for "X watching" and the participant modal, independent of
        // whether the user has enabled cam/mic.
        const emitViewerList = () => {
            if (!this.channel || !this.onViewerList) return;
            try {
                const state = this.channel.presenceState() as Record<string, any[]>;
                const viewers: TheaterViewer[] = [];
                Object.values(state).forEach((entries) => {
                    entries.forEach((meta: any) => {
                        if (meta?.userId) {
                            viewers.push({
                                userId: String(meta.userId),
                                joinedAt: Number(meta.joinedAt) || Date.now(),
                            });
                        }
                    });
                });
                this.onViewerList(viewers);
            } catch (err) {
                console.warn('[TheaterSync] presenceState read failed:', err);
            }
        };
        this.channel.on('presence', { event: 'sync' }, emitViewerList);
        this.channel.on('presence', { event: 'join' }, emitViewerList);
        this.channel.on('presence', { event: 'leave' }, emitViewerList);

        this.channel.on('broadcast', { event: 'theater_update' }, ({ payload }) => {
            const state = payload as TheaterPlaybackState;
            console.log(`[TheaterSync] 📡 Received theater_update: action=${state.action}, isPlaying=${state.isPlaying}, pos=${state.position}`);
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'update');
            }
        });

        this.channel.on('broadcast', { event: 'sync_request' }, ({ payload }) => {
            const state = payload as TheaterPlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'sync_request');
            }
        });

        this.channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
            const state = payload as TheaterPlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'ping');
            }
        });

        this.channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
            const state = payload as TheaterPlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'pong');
            }
        });

        // WebRTC signaling — relayed verbatim. The room service owns peer
        // connection lifecycles; we just deliver the offer/answer/ice payloads
        // to whichever user the sender targeted.
        this.channel.on('broadcast', { event: 'webrtc_signal' }, ({ payload }) => {
            const signal = payload as TheaterSignalPayload;
            if (!signal || signal.fromUserId === this.userId) return;
            if (this.userId && signal.targetUserId && signal.targetUserId !== this.userId) return;
            this.onSignal?.(signal);
        });

        this.channel.on('broadcast', { event: 'webrtc_presence' }, ({ payload }) => {
            const presence = payload as TheaterPresencePayload;
            if (!presence || presence.fromUserId === this.userId) return;
            this.onPresence?.(presence);
        });

        const thisChannel = this.channel;

        this.channel.subscribe((status) => {
            if (thisChannel !== this.channel) return;

            if (status === 'SUBSCRIBED') {
                console.log('[TheaterSync] ✅ Connected');
                this.retryCount = 0;
                this.errorHandled = false;
                // Announce ourselves to the presence roster so the host's
                // viewer count and the participant modal pick us up. Track()
                // can only be called after SUBSCRIBED.
                if (this.userId) {
                    void this.channel?.track({
                        userId: this.userId,
                        joinedAt: Date.now(),
                    }).catch((err) =>
                        console.warn('[TheaterSync] track() failed:', err),
                    );
                }
                // Late guests buffer their requestSync() until we're actually
                // SUBSCRIBED — flush it now so the host responds with state.
                if (this.pendingSyncRequest) {
                    this.pendingSyncRequest = false;
                    this.requestSync();
                }
                while (this.pendingPresenceRequests.length > 0) {
                    const kind = this.pendingPresenceRequests.shift();
                    if (kind) this.sendPresence(kind);
                }
                return;
            }

            if (this.errorHandled) return;
            this.errorHandled = true;

            console.log(`[TheaterSync] Channel ${status} — will retry later`);
            this.teardownChannel();

            this.retryCount++;
            if (this.retryCount >= MAX_RETRIES) return;

            const delay = Math.min(5000 * Math.pow(2, this.retryCount), 60000);
            console.log(`[TheaterSync] Retry ${this.retryCount}/${MAX_RETRIES} in ${delay / 1000}s`);

            this.retryTimeout = setTimeout(() => {
                if (this.isInitialized && !this.channel) {
                    this.setupBroadcastListener();
                }
            }, delay);
        });
    }

    retryNow(): void {
        if (!this.isInitialized || this.channel || this.scope.type === 'none') return;
        this.retryCount = 0;
        this.setupBroadcastListener();
    }

    forceReconnect(): void {
        if (!this.isInitialized || this.scope.type === 'none') return;
        console.log('[TheaterSync] 🔁 forceReconnect');
        this.teardownChannel();
        this.retryCount = 0;
        this.setupBroadcastListener();
    }

    broadcastUpdate(state: Partial<TheaterPlaybackState>): void {
        if (!this.userId || this.scope.type !== 'session') return;

        const fullState: TheaterPlaybackState = {
            sessionId: this.scope.sessionId,
            isPlaying: false,
            position: 0,
            updatedAt: Date.now(),
            updatedBy: this.userId,
            ...state,
        } as TheaterPlaybackState;

        fullState.updatedAt = Date.now();
        this.sendBroadcast('theater_update', fullState as unknown as Record<string, any>);
    }

    requestSync(): void {
        if (!this.userId || this.scope.type !== 'session') return;
        if (!this.isChannelReady()) {
            // Channel still SUBSCRIBING — defer until the SUBSCRIBED callback
            // flushes us. Without this the very first sync the guest fires
            // (the one that tells the host "I'm here, send state") gets
            // silently swallowed by sendBroadcast and the guest stays stuck
            // until the next 1.5s heartbeat — which itself can be missed if
            // the iframe still isn't ready.
            this.pendingSyncRequest = true;
            return;
        }
        this.sendBroadcast('sync_request', {
            sessionId: this.scope.sessionId,
            updatedBy: this.userId,
            updatedAt: Date.now(),
        });
    }

    sendPing(): void {
        if (!this.userId || this.scope.type !== 'session') return;
        this.sendBroadcast('ping', {
            sessionId: this.scope.sessionId,
            updatedBy: this.userId,
            updatedAt: Date.now(),
        });
    }

    setSignalingHandlers(onSignal: TheaterSignalCallback | null, onPresence: TheaterPresenceCallback | null): void {
        this.onSignal = onSignal;
        this.onPresence = onPresence;
    }

    setViewerListHandler(cb: TheaterViewerListCallback | null): void {
        this.onViewerList = cb;
    }

    sendSignal(payload: Omit<TheaterSignalPayload, 'sessionId' | 'fromUserId'>): void {
        if (!this.userId || this.scope.type !== 'session') return;
        this.sendBroadcast('webrtc_signal', {
            sessionId: this.scope.sessionId,
            fromUserId: this.userId,
            ...payload,
        });
    }

    pendingPresenceRequests: ('join' | 'here' | 'leave')[] = [];

    sendPresence(kind: 'join' | 'here' | 'leave'): void {
        if (!this.userId || this.scope.type !== 'session') return;
        if (!this.isChannelReady()) {
            this.pendingPresenceRequests.push(kind);
            return;
        }
        this.sendBroadcast('webrtc_presence', {
            sessionId: this.scope.sessionId,
            fromUserId: this.userId,
            kind,
        });
    }

    sendPong(pingTime: number): void {
        if (!this.userId || this.scope.type !== 'session') return;
        this.sendBroadcast('pong', {
            sessionId: this.scope.sessionId,
            updatedBy: this.userId,
            updatedAt: Date.now(),
            // Echo the ping timestamp in `position` so the original sender
            // can compute RTT = now - position. Mirrors MusicSyncService.
            position: pingTime,
        });
    }

    getConnectionStatus(): 'disconnected' | 'connecting' | 'connected' {
        return this.channel ? 'connected' : 'disconnected';
    }

    cleanup(): void {
        this.isInitialized = false;
        this.errorHandled = true;
        this.teardownChannel();
        this.onUpdate = null;
        this.onSignal = null;
        this.onPresence = null;
        this.userId = null;
        this.scope = { type: 'none' };
        this.retryCount = 0;
        this.clockSynced = false;
    }
}

export const theaterSyncService = new TheaterSyncService();
