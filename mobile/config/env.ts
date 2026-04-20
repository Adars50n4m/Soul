import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Soul-4 Centralized Environment Configuration
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
export const SUPABASE_PROXY_URL = getEnvVar('EXPO_PUBLIC_SUPABASE_PROXY_URL', 'https://soul-supabase-proxy.adarshark.workers.dev');

// 3. App Server (Node.js/Localtunnel)
export const IS_DEV = __DEV__;
// Default to the Cloudflare Workers proxy so physical devices and standalone
// builds keep working even if .env wasn't bundled or dev-host resolution fails.
// Override for local dev by setting EXPO_PUBLIC_SERVER_URL=http://localhost:3000.
const DEFAULT_TUNNEL = 'https://soul-supabase-proxy.adarshark.workers.dev';
let resolvedServerUrl = getEnvVar('EXPO_PUBLIC_SERVER_URL', DEFAULT_TUNNEL);

const extractExpoDevHost = (): string | null => {
  const candidates = [
    Constants.expoConfig?.hostUri,
    (Constants as any).manifestData?.hostUri,
    (Constants.expoConfig as any)?.debuggerHost,
    (Constants as any).expoGoConfig?.debuggerHost,
    (Constants as any).manifest2?.extra?.expoClient?.hostUri,
    (Constants as any).linkingUri, // Fallback for some Expo versions
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      // Remove protocol if present (e.g. exp:// or http://)
      let host = candidate.replace(/^exp:\/\/|http:\/\/|https:\/\//, '');
      // Remove path and port (e.g. 192.168.1.5:8081/path -> 192.168.1.5)
      host = host.split(':')[0].split('/')[0];
      
      if (host && host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('::')) {
        return host;
      }
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
  const isRemote = resolvedServerUrl.includes('workers.dev') || resolvedServerUrl.includes('supabase.co');
  const debugHost = extractExpoDevHost();

  if (!isRemote) {
    if (Platform.OS !== 'android' && resolvedServerUrl.includes('10.0.2.2')) {
      resolvedServerUrl = debugHost
        ? `http://${debugHost}:3000`
        : DEFAULT_TUNNEL;
      console.log(`[Env] Rewriting Android emulator URL for ${Platform.OS}: ${resolvedServerUrl}`);
    }
    
    if (debugHost && debugHost !== 'localhost' && debugHost !== '127.0.0.1') {
      const localUrl = `http://${debugHost}:3000`;

      // Overwrite localhost/127.0.0.1 with the real host IP so physical devices can reach it.
      if (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('127.0.0.1')) {
        console.log(`[Env] Resolving SERVER_URL from ${resolvedServerUrl} to ${localUrl} (Expo Host)`);
        resolvedServerUrl = localUrl;
      }
    } else {
      // Fallback for when the debugger host is not available or is just "localhost".
      let fallbackIp = getEnvVar('EXPO_PUBLIC_HOST_IP', '');
      
      if (fallbackIp && fallbackIp.length > 0) {
          // If HOST_IP looks like an IP, wrap it in http:// and :3000. 
          // If it looks like a domain (proxy), use it as is if it's not handled by isRemote check above.
          resolvedServerUrl = fallbackIp.includes('.') && !/^[0-9.]+$/.test(fallbackIp)
            ? `https://${fallbackIp}`
            : `http://${fallbackIp}:3000`;
          console.log(`[Env] Using EXPO_PUBLIC_HOST_IP manual fallback: ${resolvedServerUrl}`);
      } else if (Platform.OS === 'android' && isAndroidEmulator()) {
          resolvedServerUrl = 'http://10.0.2.2:3000';
          console.log('[Env] Confirmed Android Emulator: Using 10.0.2.2 loopback');
      } else if (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('127.0.0.1')) {
          // We are on a physical device OR the host resolution failed. 
          console.warn('[Env] ⚠️ Physical device/DevClient detected but LAN IP unknown.');
          console.warn('[Env] 💡 Please set EXPO_PUBLIC_HOST_IP in your .env to your computer\'s IP (e.g. 192.168.1.5)');
      }
    }
  } else {
    console.log(`[Env] Using remote SERVER_URL in dev: ${resolvedServerUrl}`);
  }
}

// Physical-device safety net: if we somehow ended up with localhost/127.0.0.1
// on a real device (no Metro host, missing .env, stale release build, etc.),
// fall back to the cloud proxy instead of silently failing every network call.
const _isPhysicalDevice = (Constants as any)?.isDevice !== false;
if (_isPhysicalDevice && (resolvedServerUrl.includes('localhost') || resolvedServerUrl.includes('127.0.0.1'))) {
  console.warn(`[Env] ⚠️ Physical device resolved to ${resolvedServerUrl} — overriding with cloud proxy.`);
  resolvedServerUrl = DEFAULT_TUNNEL;
}

export const SERVER_URL = resolvedServerUrl;
console.log(`[Env] Final Connectivity URL: ${SERVER_URL}`);


// 4. Music API (JioSaavn)
export const MUSIC_API_URL = getEnvVar('EXPO_PUBLIC_MUSIC_API_URL', 'https://saavn.sumit.co/api');

// 5. Cloudflare R2 / Upload Worker
// Defaults are the real production URLs so physical devices / standalone
// builds still resolve media correctly when .env isn't bundled.
export const R2_WORKER_URL = getEnvVar('EXPO_PUBLIC_R2_WORKER_URL', 'https://soul-upload-worker.adarshark.workers.dev');
export const R2_PUBLIC_URL = getEnvVar('EXPO_PUBLIC_R2_PUBLIC_URL', 'https://pub-e61d644ab07147a8a1a45a3bbd84aa1d.r2.dev');

// 6. WebRTC TURN Servers
// Default: OpenRelay Project free TURN (works from any network, no signup)
// Override via .env for production self-hosted TURN
export const TURN_SERVER = getEnvVar('EXPO_PUBLIC_TURN_SERVER', 'openrelay.metered.ca:80');
export const TURN_USERNAME = getEnvVar('EXPO_PUBLIC_TURN_USERNAME', 'openrelayproject');
export const TURN_PASSWORD = getEnvVar('EXPO_PUBLIC_TURN_PASSWORD', 'openrelayproject');

export const TURN_SERVER_2 = getEnvVar('EXPO_PUBLIC_TURN_SERVER_2', 'openrelay.metered.ca:443');
export const TURN_USERNAME_2 = getEnvVar('EXPO_PUBLIC_TURN_USERNAME_2', 'openrelayproject');
export const TURN_PASSWORD_2 = getEnvVar('EXPO_PUBLIC_TURN_PASSWORD_2', 'openrelayproject');

// Metered.ca free TURN API key (fetches temp credentials at call time)
// Sign up: https://www.metered.ca/stun-turn → Dashboard → API Key
export const METERED_API_KEY = getEnvVar('EXPO_PUBLIC_METERED_API_KEY', '');
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
// Default to R2 ON because the proxy worker doesn't expose an upload route —
// physical devices without .env bundling must hit R2 directly.
export const USE_R2 = getEnvVar('EXPO_PUBLIC_USE_R2', 'true') === 'true';
export const VOIP_PUSH_ENABLED = getEnvVar('EXPO_PUBLIC_VOIP_PUSH_ENABLED', 'false') === 'true';

// 7. Connectivity Constants
export const CONNECTIVITY_TIMEOUT = 10000; // 10s
export const MAX_RETRY_ATTEMPTS = 5;

export const HOST_IP = getEnvVar('EXPO_PUBLIC_HOST_IP', '') || extractExpoDevHost() || '127.0.0.1';

console.log('[Env] Initialized with SERVER_URL:', SERVER_URL);
console.log('[Env] Host IP for Signaling:', HOST_IP);
console.log('[Env] Supabase Proxy active:', SUPABASE_PROXY_URL);
