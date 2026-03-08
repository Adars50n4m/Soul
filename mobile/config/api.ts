import { Platform } from 'react-native';
import * as Env from './env';

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
        
        // Retry on 5xx server errors or 429 rate limits
        if (retries > 0 && (response.status >= 500 || response.status === 429)) {
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
    if (url.startsWith('data:')) return url;
    if (url.includes('xuipxbyvsawhuldopvjn.supabase.co/storage/v1/object/public/')) {
        return url.replace(
            'https://xuipxbyvsawhuldopvjn.supabase.co',
            SUPABASE_ENDPOINT
        );
    }
    return url;
}
