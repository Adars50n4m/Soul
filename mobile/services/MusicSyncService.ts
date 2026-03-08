import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Song } from '../types';

export interface PlaybackState {
    currentSong: Song | null;
    isPlaying: boolean;
    position: number;
    updatedAt: number;
    updatedBy: string;
}

type PlaybackUpdateCallback = (state: PlaybackState) => void;

class MusicSyncService {
    private onUpdate: PlaybackUpdateCallback | null = null;
    private userId: string | null = null;
    private partnerId: string | null = null;
    private isInitialized: boolean = false;
    private channel: RealtimeChannel | null = null;

    initialize(userId: string, callback: PlaybackUpdateCallback, partnerId?: string): void {
        this.userId = userId;
        this.onUpdate = callback;
        this.partnerId = partnerId || null;
        this.isInitialized = true;

        this.setupBroadcastListener();
    }

    private setupBroadcastListener(): void {
        if (!this.userId) return;

        // Cleanup previous
        if (this.channel) {
            this.channel.unsubscribe();
        }

        // We use a shared channel for the "room" (current pair of users)
        // For simplicity in SoulSync, we can use a channel named after the user pair
        // Sort IDs to ensure both users join the same channel name
        const ids = [this.userId, this.partnerId].filter(Boolean).sort();
        const channelName = ids.length > 1 ? `music_sync_${ids[0]}_${ids[1]}` : `music_sync_${this.userId}`;
        
        console.log(`[MusicSync] Initializing Supabase Broadcast on channel: ${channelName}`);

        this.channel = supabase.channel(channelName, {
            config: { broadcast: { self: false } },
        });

        this.channel.on('broadcast', { event: 'playback_update' }, ({ payload }) => {
            const state = payload as PlaybackState;
            
            // Only sync if the update is from our partner and meant for us
            if (this.userId && state.updatedBy !== this.userId) {
                // If partnerId is set, only accept from them
                if (this.partnerId && state.updatedBy !== this.partnerId) {
                    return;
                }
                
                console.log('[MusicSync] Received remote update:', state.currentSong?.name);
                this.onUpdate?.(state);
            }
        });

        this.channel.subscribe((status) => {
            console.log(`[MusicSync] Broadcast status: ${status}`);
        });
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

        this.channel.send({
            type: 'broadcast',
            event: 'playback_update',
            payload: fullState,
        }).then((status) => {
            if (status !== 'ok') console.error('[MusicSync] Broadcast status:', status);
        });
    }

    getConnectionStatus(): 'disconnected' | 'connecting' | 'connected' {
        // Since Supabase Realtime is multiplexed, if supabase is connected, we're likely "connected"
        return this.isInitialized ? 'connected' : 'disconnected';
    }

    cleanup(): void {
        if (this.channel) {
            this.channel.unsubscribe();
            this.channel = null;
        }
        this.onUpdate = null;
        this.userId = null;
        this.partnerId = null;
        this.isInitialized = false;
    }
}

export const musicSyncService = new MusicSyncService();
