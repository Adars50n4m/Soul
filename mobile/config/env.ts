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
const DEFAULT_TUNNEL = 'https://soulsync-v3-1772996787.loca.lt';
export const SERVER_URL = getEnvVar('EXPO_PUBLIC_SERVER_URL', DEFAULT_TUNNEL);

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
export const IS_DEV = __DEV__;
export const USE_R2 = getEnvVar('EXPO_PUBLIC_USE_R2', 'false') === 'true';

// 7. Connectivity Constants
export const CONNECTIVITY_TIMEOUT = 10000; // 10s
export const MAX_RETRY_ATTEMPTS = 5;

console.log('[Env] Initialized with SERVER_URL:', SERVER_URL);
console.log('[Env] Supabase Proxy active:', SUPABASE_PROXY_URL);
