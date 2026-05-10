import { createClient } from '@supabase/supabase-js';
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

// Use the Cloudflare proxy as the Supabase client base URL. This makes both
// HTTP and Realtime WebSocket traffic go through the proxy, which is required
// on networks where direct *.supabase.co access is blocked or flaky.
const SUPABASE_CLIENT_URL = Env.SUPABASE_PROXY_URL || Env.SUPABASE_URL;

const toProxyUrl = (urlString: string): string => {
    if (urlString.startsWith(Env.SUPABASE_URL)) {
        return urlString.replace(Env.SUPABASE_URL, Env.SUPABASE_PROXY_URL);
    }
    return urlString;
};

const toDirectUrl = (urlString: string): string | null => {
    if (urlString.startsWith(Env.SUPABASE_PROXY_URL)) {
        return urlString.replace(Env.SUPABASE_PROXY_URL, Env.SUPABASE_URL);
    }
    return null;
};

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

// Map to track last error log time per endpoint to prevent spamming the console.
// Keyed by `METHOD path` (no query) so timestamp-paginated polls don't bypass the cooldown.
const lastErrorLogTime = new Map<string, number>();
const ERROR_LOG_COOLDOWN = 30000; // 30 seconds

const errorLogKey = (method: string, urlString: string): string => {
    // Strip query + hash so /rest/v1/call_signals?... collapses to one key
    const queryIdx = urlString.indexOf('?');
    const hashIdx = urlString.indexOf('#');
    let end = urlString.length;
    if (queryIdx >= 0) end = Math.min(end, queryIdx);
    if (hashIdx >= 0) end = Math.min(end, hashIdx);
    return `${method} ${urlString.slice(0, end)}`;
};

export const supabase = createClient(SUPABASE_CLIENT_URL, Env.SUPABASE_ANON_KEY, {
    auth: {
        storage: SupabaseSecureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
    },
    global: {
        fetch: async (url: RequestInfo | URL, options?: any) => {
            const urlString = typeof url === 'string' ? url : url.toString();

            // NOTE: We deliberately do NOT short-circuit on isOnlineCached()
            // here anymore. NetInfo on Android emulators (and some flaky
            // captive networks) frequently reports isInternetReachable=false
            // even when fetch() works fine — the early-throw was blocking
            // EVERY Supabase mutation and stranding messages in 'pending'
            // forever, even though the realtime channel was happily
            // SUBSCRIBED. If we're truly offline, the underlying fetch will
            // reject on its own, and the queue retry loop handles that.

            const proxied = toProxyUrl(urlString);
            const directFallbackUrl = toDirectUrl(proxied);
            const method = (options?.method || 'GET').toUpperCase();

            // Helper to log errors without spamming
            const logKey = errorLogKey(method, urlString);
            const logError = (msg: string, details?: any, isCritical = false) => {
                const now = Date.now();
                const lastLog = lastErrorLogTime.get(logKey) || 0;
                if (isCritical || (now - lastLog > ERROR_LOG_COOLDOWN)) {
                    lastErrorLogTime.set(logKey, now);
                    if (isCritical) console.error(msg, details);
                    else console.warn(msg, details);
                }
            };

            // Robust fetch with timeout and retry
            const fetchWithTimeout = async (targetUrl: string, targetOptions: any, timeoutMs = 15000, retryCount = 1): Promise<Response> => {
                let lastError: any;
                for (let i = 0; i <= retryCount; i++) {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    
                    try {
                        const response = await fetch(targetUrl, {
                            ...targetOptions,
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                        ProxyHealthTracker.markProxyUp();
                        return response;
                    } catch (err: any) {
                        clearTimeout(timeoutId);
                        lastError = err;
                        const isAbort = err.name === 'AbortError';
                        const isNetwork = err.message?.includes('Network request failed');

                        if (i < retryCount && (isAbort || isNetwork)) {
                            const delay = 500 * (i + 1);
                            logError(`[Supabase Fetch] ↻ Retry ${i+1}/${retryCount} for ${method} ${targetUrl} after ${isAbort ? 'timeout' : 'network error'}...`);
                            await new Promise(r => setTimeout(r, delay));
                            continue;
                        }
                        throw err;
                    }
                }
                throw lastError;
            };

            // 2. Try Proxied URL
            try {
                return await fetchWithTimeout(proxied, options, 15000, 1);
            } catch (error: any) {
                const isNetworkError = error.message?.includes('Network request failed') || error.name === 'AbortError';

                if (isNetworkError) {
                    logError(`[Supabase Fetch] ❌ ${method} ${proxied} failed: Network/Timeout`);

                    // 3. Fallback to Direct URL — always try, regardless of
                    // NetworkMonitor's cached `_isOnline`. On Android emulators
                    // and flaky cellular networks NetInfo can report
                    // isInternetReachable=false even when fetch() works, so
                    // gating the fallback on isOnlineCached() was the actual
                    // reason messages stayed pending forever once the proxy
                    // had a transient blip. If the device is truly offline,
                    // this fetch will reject and the queue retry handles it.
                    if (directFallbackUrl && directFallbackUrl !== proxied) {
                        try {
                            logError(`[Supabase Fetch] ↻ Falling back to direct: ${directFallbackUrl}`);
                            return await fetchWithTimeout(directFallbackUrl, options, 8000, 0);
                        } catch (directErr: any) {
                            logError(`[Supabase Fetch] ❌ Direct fallback failed for ${method} ${directFallbackUrl}`);
                            throw directErr;
                        }
                    }
                } else {
                    // Non-network errors (4xx, 5xx) should be logged once
                    logError(`[Supabase Fetch] ❌ ${method} ${proxied} failed:`, error.message);
                }

                throw error;
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
 * Uses the same base URL as the Supabase client.
 */
export const getRealtimeUrl = (): string => {
    return SUPABASE_CLIENT_URL
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://') + '/realtime/v1';
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
                try { ws.close(); } catch {}
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
