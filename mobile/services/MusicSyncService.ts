import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Song } from '../types';

export type PlaybackAction =
    | 'play'
    | 'pause'
    | 'seek'
    | 'track-change'
    | 'heartbeat'
    | 'sync';

export interface PlaybackState {
    currentSong: Song | null;
    isPlaying: boolean;
    position: number;
    updatedAt: number;
    updatedBy: string;
    scheduledStartTime?: number;
    action?: PlaybackAction;
}

export type MusicSyncScope =
    | { type: 'none' }
    | { type: 'direct'; targetId: string }
    | { type: 'group'; targetId: string };

type PlaybackUpdateEvent =
    | 'update'
    | 'sync_request'
    | 'ping'
    | 'pong'
    | 'room_snapshot';

type PlaybackUpdateCallback = (state: PlaybackState, eventType: PlaybackUpdateEvent) => void;

const MAX_RETRIES = 3;

class MusicSyncService {
    private onUpdate: PlaybackUpdateCallback | null = null;
    private userId: string | null = null;
    private isInitialized = false;
    private channel: RealtimeChannel | null = null;
    private retryCount = 0;
    private retryTimeout: NodeJS.Timeout | null = null;
    private errorHandled = false;
    private scope: MusicSyncScope = { type: 'none' };
    // Tracks whether at least one ping→pong cycle has produced a usable
    // clock offset. Consumers (MusicContext) call markClockSynced() after
    // the first successful pong so playSong/togglePlayMusic know whether
    // it's safe to schedule a coordinated start time. Without this the
    // scheduledStartTime feature was always undefined and the two devices
    // played independently with whatever drift their wall clocks had.
    private clockSynced = false;

    private isChannelReady(): boolean {
        return !!this.channel && this.channel.state === 'joined';
    }

    private sendBroadcast(event: 'playback_update' | 'sync_request' | 'ping' | 'pong', payload: Record<string, any>): void {
        if (!this.isChannelReady()) return;

        // Surface broadcast failures so a dead channel or auth issue is
        // visible during diagnosis rather than silently dropping music
        // events. Pings/pongs fire every 15s so a non-throttled log is
        // fine here — if it spams, the channel is genuinely broken.
        this.channel!.send({
            type: 'broadcast',
            event,
            payload,
        }).catch((err) => {
            console.warn(`[MusicSync] broadcast(${event}) failed:`, err);
        });
    }

    get partnerId(): string | null {
        return this.scope.type === 'direct' ? this.scope.targetId : null;
    }

    getCurrentScope(): MusicSyncScope {
        return this.scope;
    }

    initialize(userId: string, callback: PlaybackUpdateCallback, partnerId?: string): void {
        this.userId = userId;
        this.onUpdate = callback;
        this.isInitialized = true;

        if (partnerId) {
            this.scope = { type: 'direct', targetId: partnerId };
            this.setupBroadcastListener();
            return;
        }

        this.scope = { type: 'none' };
        console.log('[MusicSync] No sync target set — idle');
    }

    setPartner(partnerId: string): void {
        if (this.scope.type === 'direct' && this.scope.targetId === partnerId) return;
        this.scope = { type: 'direct', targetId: partnerId };
        this.retryCount = 0;
        this.clockSynced = false;
        if (this.isInitialized) {
            this.setupBroadcastListener();
        }
    }

    clearPartner(): void {
        if (this.scope.type !== 'direct') return;
        this.scope = { type: 'none' };
        this.clockSynced = false;
        this.teardownChannel();
    }

    joinGroupRoom(groupId: string): void {
        if (this.scope.type === 'group' && this.scope.targetId === groupId) return;
        this.scope = { type: 'group', targetId: groupId };
        this.retryCount = 0;
        this.clockSynced = false;
        if (this.isInitialized) {
            this.setupBroadcastListener();
        }
    }

    leaveGroupRoom(groupId?: string): void {
        if (this.scope.type !== 'group') return;
        if (groupId && this.scope.targetId !== groupId) return;
        this.scope = { type: 'none' };
        this.clockSynced = false;
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

        if (this.scope.type === 'direct') {
            const ids = [this.userId, this.scope.targetId].sort();
            return `music_sync_${ids[0]}_${ids[1]}`;
        }

        if (this.scope.type === 'group') {
            return `group_music_room_${this.scope.targetId}`;
        }

        return null;
    }

    private isEventRelevant(state: PlaybackState): boolean {
        if (!this.userId) return false;
        if (state.updatedBy === this.userId) return false;

        if (this.scope.type === 'direct') {
            return state.updatedBy === this.scope.targetId;
        }

        return this.scope.type === 'group';
    }

    private teardownChannel(): void {
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        if (this.channel) {
            try { supabase.removeChannel(this.channel); } catch (e) { console.warn('[MusicSync] removeChannel failed:', e); }
            this.channel = null;
        }
        this.errorHandled = true;
    }

    private async emitGroupSnapshot(): Promise<void> {
        if (!this.userId || this.scope.type !== 'group') return;

        try {
            const { data, error } = await supabase
                .from('group_music_sessions')
                .select('current_song, is_playing, position_ms, updated_at, updated_by, scheduled_start_time_ms')
                .eq('group_id', this.scope.targetId)
                .maybeSingle();

            if (error || !data || !data.current_song) return;

            this.onUpdate?.({
                currentSong: data.current_song as Song,
                isPlaying: !!data.is_playing,
                position: Number(data.position_ms || 0),
                updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : Date.now(),
                updatedBy: data.updated_by,
                scheduledStartTime: data.scheduled_start_time_ms ? Number(data.scheduled_start_time_ms) : undefined,
            }, 'room_snapshot');
        } catch (error) {
            console.warn('[MusicSync] Failed to fetch room snapshot:', error);
        }
    }

    private async persistGroupState(state: PlaybackState): Promise<void> {
        if (!this.userId || this.scope.type !== 'group') return;

        try {
            await supabase
                .from('group_music_sessions')
                .upsert({
                    group_id: this.scope.targetId,
                    host_id: state.updatedBy,
                    current_song: state.currentSong,
                    is_playing: state.isPlaying,
                    position_ms: Math.round(state.position || 0),
                    scheduled_start_time_ms: state.scheduledStartTime ? Math.round(state.scheduledStartTime) : null,
                    updated_by: state.updatedBy,
                    updated_at: new Date(state.updatedAt).toISOString(),
                    last_heartbeat_at: new Date().toISOString(),
                }, { onConflict: 'group_id' });
        } catch (error) {
            console.warn('[MusicSync] Failed to persist group room state:', error);
        }
    }

    private setupBroadcastListener(): void {
        const channelName = this.buildChannelName();
        if (!this.userId || !channelName) {
            console.log('[MusicSync] No sync target set — skipping Realtime connection');
            this.teardownChannel();
            return;
        }

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        if (this.channel) {
            try { supabase.removeChannel(this.channel); } catch (e) { console.warn('[MusicSync] removeChannel failed:', e); }
            this.channel = null;
        }

        if (this.retryCount >= MAX_RETRIES) {
            console.log(`[MusicSync] Paused after ${MAX_RETRIES} failures. Will retry on foreground.`);
            return;
        }

        this.errorHandled = false;

        console.log(`[MusicSync] Connecting: ${channelName} (attempt ${this.retryCount + 1}/${MAX_RETRIES})`);

        this.channel = supabase.channel(channelName, {
            config: { broadcast: { self: false } },
        });

        this.channel.on('broadcast', { event: 'playback_update' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'update');
            }
        });

        this.channel.on('broadcast', { event: 'sync_request' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'sync_request');
            }
        });

        this.channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'ping');
            }
        });

        this.channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.isEventRelevant(state)) {
                this.onUpdate?.(state, 'pong');
            }
        });

        if (this.scope.type === 'group') {
            this.channel.on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'group_music_sessions',
                    filter: `group_id=eq.${this.scope.targetId}`,
                },
                () => {
                    void this.emitGroupSnapshot();
                }
            );
        }

        const thisChannel = this.channel;

        this.channel.subscribe((status) => {
            if (thisChannel !== this.channel) return;

            if (status === 'SUBSCRIBED') {
                console.log('[MusicSync] ✅ Connected');
                this.retryCount = 0;
                this.errorHandled = false;
                if (this.scope.type === 'group') {
                    void this.emitGroupSnapshot();
                }
                return;
            }

            if (this.errorHandled) return;
            this.errorHandled = true;

            console.log(`[MusicSync] Channel ${status} — will retry later`);
            this.teardownChannel();

            this.retryCount++;
            if (this.retryCount >= MAX_RETRIES) {
                console.log('[MusicSync] Paused. Will retry on foreground.');
                return;
            }

            const delay = Math.min(5000 * Math.pow(2, this.retryCount), 60000);
            console.log(`[MusicSync] Retry ${this.retryCount}/${MAX_RETRIES} in ${delay / 1000}s`);

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

    // Force-tear-down + re-subscribe even when a (possibly zombie) channel
    // exists. retryNow() bails out if `this.channel` is non-null, which is
    // the right behavior for transient errors but wrong for token refresh
    // and post-network-reconnect cases — there the channel object is still
    // around but the underlying socket is invalid. forceReconnect() handles
    // those by always tearing down first.
    forceReconnect(): void {
        if (!this.isInitialized || this.scope.type === 'none') return;
        console.log('[MusicSync] 🔁 forceReconnect — tearing down existing channel and re-subscribing');
        this.teardownChannel();
        this.retryCount = 0;
        this.setupBroadcastListener();
    }

    broadcastUpdate(state: Partial<PlaybackState>): void {
        if (!this.userId) return;

        const fullState: PlaybackState = {
            currentSong: null,
            isPlaying: false,
            position: 0,
            updatedAt: Date.now(),
            updatedBy: this.userId,
            ...state,
        } as PlaybackState;

        // Hard guard against null-song broadcasts. The receiving side
        // historically interpreted {currentSong: null, isPlaying: false} as
        // "partner stopped playback" and force-paused its own player, which
        // turned every transient empty-state broadcast (sync_request response
        // when no song loaded, lock-screen events that forgot currentSong)
        // into a cross-device pause loop. Refusing to send the message at the
        // service boundary makes the bug structurally impossible regardless
        // of which caller forgets to attach currentSong.
        if (!fullState.currentSong) {
            return;
        }

        fullState.updatedAt = Date.now();

        this.sendBroadcast('playback_update', fullState as unknown as Record<string, any>);

        if (this.scope.type === 'group') {
            void this.persistGroupState(fullState);
        }
    }

    requestSync(): void {
        if (!this.userId) return;

        if (this.scope.type === 'group') {
            console.log('[MusicSync] 🔄 Requesting room snapshot');
            void this.emitGroupSnapshot();
        }

        this.sendBroadcast('sync_request', {
            updatedBy: this.userId,
            updatedAt: Date.now(),
        });
    }

    sendPing(): void {
        if (!this.userId) return;
        this.sendBroadcast('ping', {
            updatedBy: this.userId,
            updatedAt: Date.now(),
        });
    }

    sendPong(pingTime: number): void {
        if (!this.userId) return;
        this.sendBroadcast('pong', {
            updatedBy: this.userId,
            updatedAt: Date.now(),
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
        this.userId = null;
        this.scope = { type: 'none' };
        this.retryCount = 0;
        this.clockSynced = false;
    }
}

export const musicSyncService = new MusicSyncService();
