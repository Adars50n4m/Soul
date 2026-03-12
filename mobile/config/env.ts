import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * SoulSync-4 Centralized Environment Configuration
 * 
 * This file serves as the single source for all URLs, keys, and feature flags.
 * It intelligently selects values based on the environment (Dev, Prod, Mobile, Web).
 */

const getEnvVar = (name: string, fallback: string): string => {
  return process.env[name] || Constants.expoConfig?.extra?.[name] || fallback;
};

// 1. Supabase Config
const SUPABASE_BASE_URL = 'https://xuipxbyvsawhuldopvjn.supabase.co';
export const SUPABASE_URL = getEnvVar('EXPO_PUBLIC_SUPABASE_URL', SUPABASE_BASE_URL);
export const SUPABASE_ANON_KEY = getEnvVar('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_9cVY_6oQHMZnV9CaxmMs9Q_7QlUxqlD');

// 2. Gateway Proxy (Bypasses ISP blocks on Supabase)
export const SUPABASE_PROXY_URL = getEnvVar('EXPO_PUBLIC_SUPABASE_PROXY_URL', 'https://soulsync-supabase-proxy.adarshark.workers.dev');

// 3. App Server (Node.js/Localtunnel)
export const IS_DEV = __DEV__;
const DEFAULT_TUNNEL = 'http://localhost:3000';
let resolvedServerUrl = getEnvVar('EXPO_PUBLIC_SERVER_URL', DEFAULT_TUNNEL);

const extractExpoDevHost = (): string | null => {
  const candidates = [
    Constants.expoConfig?.hostUri,
    (Constants.expoConfig as any)?.debuggerHost,
    (Constants as any).expoGoConfig?.debuggerHost,
    (Constants as any).manifest2?.extra?.expoClient?.hostUri,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.split(':')[0];
    }
  }

  return null;
};

// In dev mode, intelligently resolve the server URL to the developer's machine.
if (IS_DEV) {
  const debugHost = extractExpoDevHost();
  
  if (debugHost) {
    const localUrl = `http://${debugHost}:3000`;

    // Overwrite localhost/10.0.2.2 with the real host IP so physical devices can reach it.
    if (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('10.0.2.2')) {
      console.log(`[Env] Resolving SERVER_URL for ${Platform.OS}: ${localUrl} (from Expo dev host)`);
      resolvedServerUrl = localUrl;
    }
  } else {
    // Fallback for older Expo versions or when the debugger host is not available.
    if (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('10.0.2.2')) {
      // EMERGENCY FALLBACK: If we can't find the debug host, but we're in DEV, 
      // we'll try to use a common pattern or a provided env var.
      const fallbackIp = getEnvVar('EXPO_PUBLIC_HOST_IP', null);
      if (fallbackIp) {
        resolvedServerUrl = `http://${fallbackIp}:3000`;
        console.log(`[Env] Using EXPO_PUBLIC_HOST_IP: ${resolvedServerUrl}`);
      } else {
        resolvedServerUrl = Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
        console.warn('[Env] No Expo dev host found. If you are on a physical device, set EXPO_PUBLIC_SERVER_URL to your LAN IP or tunnel URL.');
      }
    }
  }
}
export const SERVER_URL = resolvedServerUrl;
console.log(`[Env] FINAL SERVER_URL: ${SERVER_URL}`);


// 4. Music API (JioSaavn)
export const MUSIC_API_URL = getEnvVar('EXPO_PUBLIC_MUSIC_API_URL', 'https://saavn.sumit.co/api');

// 5. Cloudflare R2 / Upload Worker
export const R2_WORKER_URL = getEnvVar('EXPO_PUBLIC_R2_WORKER_URL', 'https://soulsync-upload-worker.adarshark.workers.dev');
export const R2_PUBLIC_URL = getEnvVar('EXPO_PUBLIC_R2_PUBLIC_URL', 'https://pub-XXXXXXXXXXXX.r2.dev');

// 6. WebRTC TURN Servers
export const TURN_SERVER = getEnvVar('EXPO_PUBLIC_TURN_SERVER', '');
export const TURN_USERNAME = getEnvVar('EXPO_PUBLIC_TURN_USERNAME', '');
export const TURN_PASSWORD = getEnvVar('EXPO_PUBLIC_TURN_PASSWORD', '');

export const TURN_SERVER_2 = getEnvVar('EXPO_PUBLIC_TURN_SERVER_2', '');
export const TURN_USERNAME_2 = getEnvVar('EXPO_PUBLIC_TURN_USERNAME_2', '');
export const TURN_PASSWORD_2 = getEnvVar('EXPO_PUBLIC_TURN_PASSWORD_2', '');

// 7. Feature Flags
export const USE_R2 = getEnvVar('EXPO_PUBLIC_USE_R2', 'false') === 'true';

// 7. Connectivity Constants
export const CONNECTIVITY_TIMEOUT = 10000; // 10s
export const MAX_RETRY_ATTEMPTS = 5;

console.log('[Env] Initialized with SERVER_URL:', SERVER_URL);
console.log('[Env] Supabase Proxy active:', SUPABASE_PROXY_URL);
