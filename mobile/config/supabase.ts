import { createClient } from '@supabase/supabase-js';
import * as Env from './env';

// Legacy ID mapping for transitioning to Supabase UUIDs
export const SHRI_ID = '4d28b137-66ff-4417-b451-b1a421e34b25';
export const HARI_ID = '02e52f08-6c1e-497f-93f6-b29c275b8ca4';

export const LEGACY_TO_UUID: Record<string, string> = {
    'shri': SHRI_ID,
    'hari': HARI_ID,
    'shri_id': SHRI_ID,
    'hari_id': HARI_ID,
};

// Use direct SUPABASE_URL so Realtime WebSocket connects directly (proxy can't handle WS upgrades).
// HTTP REST calls are routed through the Cloudflare proxy via custom fetch to bypass ISP blocks.
export const supabase = createClient(Env.SUPABASE_URL, Env.SUPABASE_ANON_KEY, {
    global: {
        fetch: (url: RequestInfo | URL, options?: RequestInit) => {
            // Rewrite direct Supabase HTTP calls → proxy URL (bypasses Jio/Airtel blocks)
            const urlString = typeof url === 'string' ? url : url.toString();
            const proxied = urlString.replace(Env.SUPABASE_URL, Env.SUPABASE_PROXY_URL);
            return fetch(proxied, options);
        },
    },
    realtime: {
        params: {
            eventsPerSecond: 10,
        },
    },
});

/**
 * Get the Realtime WebSocket URL for connectivity testing.
 * Always uses the direct Supabase URL since the proxy can't handle WebSocket.
 */
export const getRealtimeUrl = (): string => {
    return Env.SUPABASE_URL.replace('https://', 'wss://') + '/realtime/v1';
};

/**
 * Check if Supabase Realtime is reachable
 */
export const checkRealtimeConnectivity = async (): Promise<{ ok: boolean; error?: string }> => {
    const realtimeUrl = getRealtimeUrl();
    console.log(`[Supabase] Testing realtime connectivity: ${realtimeUrl}`);
    
    return new Promise((resolve) => {
        try {
            const ws = new WebSocket(realtimeUrl);
            const timeout = setTimeout(() => {
                ws.close();
                console.warn('[Supabase] Realtime connectivity check timed out');
                resolve({ ok: false, error: 'Connection timed out' });
            }, 10000);

            ws.onopen = () => {
                clearTimeout(timeout);
                ws.close();
                console.log(`[Supabase] ✅ Realtime endpoint (${realtimeUrl}) is reachable`);
                resolve({ ok: true });
            };

            ws.onerror = (e: any) => {
                clearTimeout(timeout);
                try { ws.close(); } catch (err) {}
                console.warn(`[Supabase] ❌ Realtime endpoint (${realtimeUrl}) unreachable:`, {
                    message: e?.message,
                    type: e?.type,
                    url: realtimeUrl
                });
                resolve({ ok: false, error: `WebSocket connection failed: ${e?.message || 'unknown error'}` });
            };
        } catch (e) {
            console.warn('[Supabase] ❌ WebSocket initialization failed:', e);
            resolve({ ok: false, error: 'WebSocket initialization failed' });
        }
    });
};

// Database types
export interface User {
    id: string;
    name: string;
    avatar?: string;
    status: 'online' | 'offline';
    last_seen?: string;
    created_at: string;
}

export interface Message {
    id: string;
    sender_id: string;
    receiver_id: string;
    text: string;
    media?: {
        type: 'image' | 'video' | 'audio';
        url: string;
        name?: string;
        thumbnail?: string;
    };
    timestamp: string;
    status: 'sent' | 'delivered' | 'read';
    reactions?: string[];
    reply_to?: string;
}

export interface FavoriteSong {
    id: string;
    user_id: string;
    song_id: string;
    song_name: string;
    song_artist: string;
    song_image: string;
    song_url: string;
    created_at: string;
}

// Database helpers
export const DatabaseService = {
    // Users
    async getUsers() {
        const { data, error } = await supabase.from('users').select('*');
        if (error) throw error;
        return data as User[];
    },

    async updateUserStatus(userId: string, status: 'online' | 'offline') {
        const { error } = await supabase
            .from('users')
            .update({ status, last_seen: new Date().toISOString() })
            .eq('id', userId);
        if (error) throw error;
    },

    // Messages
    async getMessages(userId1: string, userId2: string) {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender.eq.${userId1},receiver.eq.${userId2}),and(sender.eq.${userId2},receiver.eq.${userId1})`)
            .order('timestamp', { ascending: true });
        if (error) throw error;
        return data as Message[];
    },

    async sendMessage(message: Omit<Message, 'id' | 'timestamp'>) {
        const { data, error } = await supabase
            .from('messages')
            .insert([{ ...message, timestamp: new Date().toISOString() }])
            .select()
            .single();
        if (error) throw error;
        return data as Message;
    },

    // Favorites
    async getFavorites(userId: string) {
        const { data, error } = await supabase
            .from('favorite_songs')
            .select('*')
            .eq('user_id', userId);
        if (error) throw error;
        return data as FavoriteSong[];
    },

    async addFavorite(favorite: Omit<FavoriteSong, 'id' | 'created_at'>) {
        const { data, error } = await supabase
            .from('favorite_songs')
            .insert([{ ...favorite, created_at: new Date().toISOString() }])
            .select()
            .single();
        if (error) throw error;
        return data as FavoriteSong;
    },

    async removeFavorite(userId: string, songId: string) {
        const { error } = await supabase
            .from('favorite_songs')
            .delete()
            .eq('user_id', userId)
            .eq('song_id', songId);
        if (error) throw error;
    },

    // Real-time subscriptions
    subscribeToMessages(userId: string, callback: (message: Message) => void) {
        return supabase
            .channel('messages')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'messages',
            }, (payload) => callback(payload.new as Message))
            .subscribe();
    }
};
