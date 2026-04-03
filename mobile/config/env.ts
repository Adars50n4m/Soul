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

const isAndroidEmulator = (): boolean => {
  const c: any = Constants as any;
  const rawModel = String(c?.platform?.android?.model || c?.deviceName || '').toLowerCase();
  const isLikelyEmulatorName =
    rawModel.includes('sdk') ||
    rawModel.includes('emulator') ||
    rawModel.includes('android sdk built for');

  return c?.isDevice === false || isLikelyEmulatorName;
};

// In dev mode, intelligently resolve the server URL to the developer's machine.
if (IS_DEV) {
  const debugHost = extractExpoDevHost();
  
  if (debugHost && debugHost !== 'localhost' && debugHost !== '127.0.0.1') {
    const localUrl = `http://${debugHost}:3000`;

    // Overwrite localhost/127.0.0.1 with the real host IP so physical devices can reach it.
    if (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('127.0.0.1')) {
      console.log(`[Env] Resolving SERVER_URL from ${resolvedServerUrl} to ${localUrl} (Expo Host)`);
      resolvedServerUrl = localUrl;
    }
  } else {
    // Fallback for when the debugger host is not available or is just "localhost".
    // Try EXPO_PUBLIC_HOST_IP first if explicitly set by the user in .env
    const fallbackIp = getEnvVar('EXPO_PUBLIC_HOST_IP', '');
    
    if (fallbackIp && fallbackIp.length > 0) {
        resolvedServerUrl = `http://${fallbackIp}:3000`;
        console.log(`[Env] Using EXPO_PUBLIC_HOST_IP manual fallback: ${resolvedServerUrl}`);
    } else if (Platform.OS === 'android' && isAndroidEmulator()) {
        resolvedServerUrl = 'http://10.0.2.2:3000';
        console.log('[Env] Confirmed Android Emulator: Using 10.0.2.2 loopback');
    } else if (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('127.0.0.1')) {
        // We are on a physical device OR the host resolution failed. 
        // Localhost will NEVER work on a real phone for a dev server.
        console.warn('[Env] ⚠️ Physical device/DevClient detected but LAN IP unknown.');
        console.warn('[Env] 💡 Please set EXPO_PUBLIC_HOST_IP in your .env to your computer\'s IP (e.g. 192.168.1.5)');
    }
  }
}
export const SERVER_URL = resolvedServerUrl;
console.log(`[Env] Final Connectivity URL: ${SERVER_URL}`);


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
const HAS_CUSTOM_TURN =
  (TURN_SERVER && TURN_SERVER.length > 10 && !TURN_SERVER.includes('yourdomain')) ||
  (TURN_SERVER_2 && TURN_SERVER_2.length > 10 && !TURN_SERVER_2.includes('backup-turn'));

// 6.1 Calling Reliability Flags
// Force relay-only mode in hostile NAT/carrier environments.
export const CALL_FORCE_RELAY = getEnvVar(
  'EXPO_PUBLIC_CALL_FORCE_RELAY',
  !IS_DEV && HAS_CUSTOM_TURN ? 'true' : 'false'
) === 'true';
// Warn loudly when custom TURN is not configured (needed for WhatsApp-like reliability at scale).
export const CALL_REQUIRE_CUSTOM_TURN = getEnvVar(
  'EXPO_PUBLIC_CALL_REQUIRE_CUSTOM_TURN',
  !IS_DEV ? 'true' : 'false'
) === 'true';

// 7. Feature Flags
export const USE_R2 = getEnvVar('EXPO_PUBLIC_USE_R2', 'true') === 'true';

// 7. Connectivity Constants
export const CONNECTIVITY_TIMEOUT = 10000; // 10s
export const MAX_RETRY_ATTEMPTS = 5;

console.log('[Env] Initialized with SERVER_URL:', SERVER_URL);
console.log('[Env] Supabase Proxy active:', SUPABASE_PROXY_URL);
