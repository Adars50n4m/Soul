import { Platform } from 'react-native';
import * as Env from './env';
import { R2_CONFIG } from './r2';

// Configuration from centralized env.ts
export const SUPABASE_URL = Env.SUPABASE_URL;
export const SUPABASE_ANON_KEY = Env.SUPABASE_ANON_KEY;
export const SUPABASE_ENDPOINT = Env.SUPABASE_PROXY_URL;
export const SERVER_URL = Env.SERVER_URL;

console.log('[API Config] SUPABASE_ENDPOINT:', SUPABASE_ENDPOINT);
console.log('[API Config] SERVER_URL:', SERVER_URL);

export function getSupabaseUrl(): string {
    return SUPABASE_ENDPOINT;
}

// Tunnel bypass — include all common tunnel providers
const isTunnel = 
    SERVER_URL.includes('trycloudflare.com') || 
    SERVER_URL.includes('.loca.lt') || 
    SERVER_URL.includes('.localtunnel.me') || 
    SERVER_URL.includes('.ngrok-free.app');

export const serverFetch = (url: string, init?: RequestInit): Promise<Response> =>
    smartFetch(url, {
        ...init,
        headers: {
            ...(isTunnel ? { 'bypass-tunnel-reminder': 'true' } : {}),
            ...init?.headers,
        },
    });

/**
 * Enhanced fetch with automatic retries and exponential backoff.
 * Essential for mobile apps on flaky networks (WiFi -> LTE transitions).
 */
export async function smartFetch(
    url: string,
    init?: RequestInit,
    retries = 3,
    backoff = 1000
): Promise<Response> {
    try {
        const response = await fetch(url, init);
        
        // Retry on 5xx server errors or 429 rate limits, but NOT on 503 from a dead tunnel
        // (retrying a "Tunnel Unavailable" response won't help and adds ~7s of unnecessary delay)
        const isTunnelDown = response.status === 503 && isTunnel;
        if (retries > 0 && !isTunnelDown && (response.status >= 500 || response.status === 429)) {
            console.warn(`[Network] Retrying ${url} (${response.status})... ${retries} attempts left`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            return smartFetch(url, init, retries - 1, backoff * 2);
        }
        
        return response;
    } catch (error) {
        // Retry on network-level errors (DNS, timeout, connection lost)
        if (retries > 0) {
            console.warn(`[Network] Connection error for ${url}. Retrying in ${backoff}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, backoff));
            return smartFetch(url, init, retries - 1, backoff * 2);
        }
        throw error;
    }
}

/**
 * Robust JSON fetcher that safely handles:
 * 1. Non-200 responses
 * 2. Non-JSON payloads (proxy errors, HTML)
 * 3. Network timeouts/failures
 */
export async function safeFetchJson<T>(
    url: string,
    init?: RequestInit
): Promise<{ success: boolean; data?: T; error?: string }> {
    try {
        const response = await serverFetch(url, init);
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.warn(`[API] Expected JSON, got ${contentType}:`, text.substring(0, 100));
            return {
                success: false,
                error: `Server returned non-JSON response (${response.status}). Please check if the server is running.`
            };
        }

        const data = await response.json();
        
        if (!response.ok) {
            return { 
                success: false, 
                data: data as T, 
                error: (data as any).error || `Request failed with status ${response.status}`
            };
        }

        return { success: true, data: data as T };
    } catch (error: any) {
        console.warn(`[API] safeFetchJson failed for ${url}:`, error);
        return {
            success: false,
            error: error.message || 'Network request failed'
        };
    }
}

// JioSaavn API
export const SAAVN_API_URL = Env.MUSIC_API_URL;

// Get the API URL
export const getSaavnApiUrl = () => SAAVN_API_URL;

/**
 * Smart URL Proxy: Rewrites direct Supabase Storage URLs to use the Cloudflare Workers proxy.
 * This bypasses ISP-level blocks on the .supabase.co domain for images/videos.
 */
export function proxySupabaseUrl(url: string | null | undefined): string {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('file://')) return url;
    
    // Handle Supabase Storage URLs (legacy)
    if (url.includes('xuipxbyvsawhuldopvjn.supabase.co/storage/v1/object/public/')) {
        return url.replace(
            'https://xuipxbyvsawhuldopvjn.supabase.co',
            SUPABASE_ENDPOINT
        );
    }

    // Handle R2 keys (new)
    // Keys like 'user-id-timestamp.jpg' or 'avatars/uuid.jpg'
    if (!url.includes(':') && !url.startsWith('http')) {
        const publicBase = R2_CONFIG.PUBLIC_URL?.replace(/\/$/, '');
        if (publicBase) {
            return `${publicBase}/${url}`;
        }
    }

    return url;
}
