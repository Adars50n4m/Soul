import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SupabaseSecureStorage } from './secureStorage';
import * as Env from './env';

// Legacy ID mapping for transitioning to Supabase UUIDs
export const SHRI_ID = 'f00f00f0-0000-0000-0000-000000000002';
export const HARI_ID = 'f00f00f0-0000-0000-0000-000000000001';

export const LEGACY_TO_UUID: Record<string, string> = {
    'shri': SHRI_ID,
    'hari': HARI_ID,
    'shri_id': SHRI_ID,
    'hari_id': HARI_ID,
};

// Use DIRECT Supabase URL as base — Realtime WebSocket REQUIRES direct connection.
// Cloudflare Workers CANNOT proxy WebSocket upgrade requests.
// HTTP REST calls are routed through the proxy via custom fetch to bypass ISP blocks.
/**
 * State manager for tracking Supabase Proxy health.
 * Prevents constant timeouts by skipping the proxy if it's recently failed.
 */
class ProxyHealthTracker {
    private static isProxyDown = false;
    private static lastFailureTime = 0;
    // Only skip proxy on mutations (writes). Reads always retry proxy because
    // direct *.supabase.co is ISP-blocked on Indian networks — skipping proxy
    // for reads causes a 2-min outage every time the proxy has a transient blip.
    private static SKIP_DURATION = 30000; // 30s (was 2min — too long for reads)

    static shouldTryProxy(isMutation = false): boolean {
        if (!this.isProxyDown) return true;
        if (!isMutation) return true; // reads always try proxy regardless of circuit state
        const now = Date.now();
        if (now - this.lastFailureTime > this.SKIP_DURATION) {
            this.isProxyDown = false;
            return true;
        }
        return false;
    }

    static markProxyDown() {
        this.isProxyDown = true;
        this.lastFailureTime = Date.now();
    }

    static markProxyUp() {
        this.isProxyDown = false;
    }
}

export const supabase = createClient(Env.SUPABASE_URL, Env.SUPABASE_ANON_KEY, {
    auth: {
        storage: SupabaseSecureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
    },
    global: {
        fetch: async (url: RequestInfo | URL, options?: any) => {
            const urlString = typeof url === 'string' ? url : url.toString();
            
            // Logic to rewrite direct Supabase URL to match the Proxy Worker subdomain
            const proxied = urlString.replace(Env.SUPABASE_URL, Env.SUPABASE_PROXY_URL);
            
            const method = (options?.method || 'GET').toUpperCase();
            const isMutation = method === 'POST' || method === 'PATCH' || method === 'DELETE';

            if (ProxyHealthTracker.shouldTryProxy(isMutation)) {
                try {
                    const controller = new AbortController();
                    const timeoutMs = isMutation ? 30000 : 12000;
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                    const response = await fetch(proxied, { ...options, signal: controller.signal });
                    clearTimeout(timeoutId);
                    ProxyHealthTracker.markProxyUp();
                    return response;
                } catch (proxyError: any) {
                    const isTimeout = proxyError.name === 'AbortError' || proxyError.message?.includes('aborted');
                    const isOffline = proxyError.message?.includes('Network request failed') || proxyError.message?.includes('failed to fetch');

                    // Only circuit-break for mutations — reads always retry proxy on next call
                    if (isMutation && (isOffline || isTimeout)) {
                        console.warn(`[Supabase] Proxy ${isTimeout ? 'timeout' : 'offline'} on mutation — circuit open for 30s`);
                        ProxyHealthTracker.markProxyDown();
                    } else {
                        console.debug(`[Supabase] Proxy failed on read: ${proxyError.message}. Falling back to direct.`);
                    }
                }
            }

            // Direct fallback (may be ISP-blocked on Indian networks — proxy is the preferred path)
            try {
                const fallbackOptions = { ...options };
                delete fallbackOptions.signal;
                return await fetch(urlString, fallbackOptions);
            } catch (directError: any) {
                // If direct also fails (ISP block), re-try proxy as last resort for reads
                if (!isMutation) {
                    try {
                        const retryOptions = { ...options };
                        delete retryOptions.signal;
                        return await fetch(proxied, retryOptions);
                    } catch {}
                }
                throw directError;
            }
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
