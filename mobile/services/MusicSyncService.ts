import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Song } from '../types';

export interface PlaybackState {
    currentSong: Song | null;
    isPlaying: boolean;
    position: number;
    updatedAt: number;
    updatedBy: string;
    scheduledStartTime?: number;
}

type PlaybackUpdateCallback = (state: PlaybackState, eventType: 'update' | 'sync_request' | 'ping' | 'pong') => void;

const MAX_RETRIES = 3;

class MusicSyncService {
    private onUpdate: PlaybackUpdateCallback | null = null;
    private userId: string | null = null;
    private partnerId: string | null = null;
    private isInitialized: boolean = false;
    private channel: RealtimeChannel | null = null;
    private retryCount: number = 0;
    private retryTimeout: NodeJS.Timeout | null = null;
    private errorHandled: boolean = false;

    initialize(userId: string, callback: PlaybackUpdateCallback, partnerId?: string): void {
        this.userId = userId;
        this.onUpdate = callback;
        this.partnerId = partnerId || null;
        this.isInitialized = true;

        // DON'T connect if there's no partner — no one to sync with
        if (!this.partnerId) {
            console.log('[MusicSync] No partner set — skipping Realtime connection (saves a slot)');
            return;
        }

        this.setupBroadcastListener();
    }

    /** Call when partner changes (e.g. opening a chat with someone) */
    setPartner(partnerId: string): void {
        if (this.partnerId === partnerId) return;
        this.partnerId = partnerId;
        this.retryCount = 0;
        if (this.isInitialized) {
            this.setupBroadcastListener();
        }
    }

    private setupBroadcastListener(): void {
        if (!this.userId || !this.partnerId) return;

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        if (this.channel) {
            try { supabase.removeChannel(this.channel); } catch (_) {}
            this.channel = null;
        }

        if (this.retryCount >= MAX_RETRIES) {
            console.log(`[MusicSync] Paused after ${MAX_RETRIES} failures. Will retry on foreground.`);
            return;
        }

        this.errorHandled = false;

        const ids = [this.userId, this.partnerId].sort();
        const channelName = `music_sync_${ids[0]}_${ids[1]}`;

        console.log(`[MusicSync] Connecting: ${channelName} (attempt ${this.retryCount + 1}/${MAX_RETRIES})`);

        this.channel = supabase.channel(channelName, {
            config: { broadcast: { self: false } },
        });

        this.channel.on('broadcast', { event: 'playback_update' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.userId && state.updatedBy !== this.userId) {
                if (this.partnerId && state.updatedBy !== this.partnerId) return;
                this.onUpdate?.(state, 'update');
            }
        });

        this.channel.on('broadcast', { event: 'sync_request' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.userId && state.updatedBy !== this.userId) {
                if (this.partnerId && state.updatedBy !== this.partnerId) return;
                this.onUpdate?.(state, 'sync_request');
            }
        });

        this.channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.userId && state.updatedBy !== this.userId) {
                if (this.partnerId && state.updatedBy !== this.partnerId) return;
                this.onUpdate?.(state, 'ping');
            }
        });

        this.channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
            const state = payload as PlaybackState;
            if (this.userId && state.updatedBy !== this.userId) {
                if (this.partnerId && state.updatedBy !== this.partnerId) return;
                this.onUpdate?.(state, 'pong');
            }
        });

        const thisChannel = this.channel;

        this.channel.subscribe((status) => {
            // Ignore callbacks from channels we already replaced
            if (thisChannel !== this.channel) return;

            if (status === 'SUBSCRIBED') {
                console.log(`[MusicSync] ✅ Connected`);
                this.retryCount = 0;
                this.errorHandled = false;
                return;
            }

            // Only handle the FIRST error event per channel (Supabase fires CLOSED 100+ times)
            if (this.errorHandled) return;
            this.errorHandled = true;

            console.log(`[MusicSync] Channel ${status} — will retry later`);

            if (this.channel) {
                try { supabase.removeChannel(this.channel); } catch (_) {}
                this.channel = null;
            }

            this.retryCount++;
            if (this.retryCount >= MAX_RETRIES) {
                console.log(`[MusicSync] Paused. Will retry on foreground.`);
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
        if (!this.isInitialized || this.channel || !this.partnerId) return;
        this.retryCount = 0;
        this.setupBroadcastListener();
    }

    broadcastUpdate(state: Partial<PlaybackState>): void {
        if (!this.userId || !this.channel) return;

        const fullState: PlaybackState = {
            currentSong: null,
            isPlaying: false,
            position: 0,
            updatedAt: Date.now(),
            updatedBy: this.userId,
            ...state
        } as PlaybackState;

        // Ensure timestamp is ALWAYS fresh on broadcast
        fullState.updatedAt = Date.now();

        this.channel.send({
            type: 'broadcast',
            event: 'playback_update',
            payload: fullState,
        }).catch(() => {});
    }

    requestSync(): void {
        if (!this.userId || !this.channel) return;
        
        console.log('[MusicSync] 🔄 Requesting initial sync from partner');
        this.channel.send({
            type: 'broadcast',
            event: 'sync_request',
            payload: {
                updatedBy: this.userId,
                updatedAt: Date.now(),
            },
        }).catch(() => {});
    }

    sendPing(): void {
        if (!this.userId || !this.channel) return;
        this.channel.send({
            type: 'broadcast',
            event: 'ping',
            payload: {
                updatedBy: this.userId,
                updatedAt: Date.now(),
            },
        }).catch(() => {});
    }

    sendPong(pingTime: number): void {
        if (!this.userId || !this.channel) return;
        this.channel.send({
            type: 'broadcast',
            event: 'pong',
            payload: {
                updatedBy: this.userId,
                updatedAt: Date.now(),
                position: pingTime, // Use position field to store the original ping time
            },
        }).catch(() => {});
    }

    getConnectionStatus(): 'disconnected' | 'connecting' | 'connected' {
        return this.channel ? 'connected' : 'disconnected';
    }

    cleanup(): void {
        this.isInitialized = false;
        this.errorHandled = true;
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        if (this.channel) {
            try { supabase.removeChannel(this.channel); } catch (_) {}
            this.channel = null;
        }
        this.onUpdate = null;
        this.userId = null;
        this.partnerId = null;
        this.retryCount = 0;
    }
}

export const musicSyncService = new MusicSyncService();
