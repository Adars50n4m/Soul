/**
 * NetworkMonitor — Real-time connectivity detection
 *
 * Detects online/offline state and triggers sync operations.
 * Uses @react-native-community/netinfo for reliable detection.
 */

import { AppState, AppStateStatus } from 'react-native';

type NetworkState = {
  isOnline: boolean;
  type: string; // "wifi" | "cellular" | "none" | "unknown"
};

type NetworkChangeCallback = (state: NetworkState) => void;

let _isOnline = true;
let _connectionType = 'unknown';
let _listeners: NetworkChangeCallback[] = [];
let _unsubscribe: (() => void) | null = null;
let _onReconnectCallbacks: (() => Promise<void> | void)[] = [];

// FIX #9: Add multiple endpoint health checks
const HEALTH_CHECK_ENDPOINTS = [
  { name: 'Supabase', url: 'https://.supabase.co', timeout: 5000 },
  { name: 'Cloudflare', url: 'https://cloudflare.com', timeout: 5000 },
];

interface HealthCheckResult {
  name: string;
  reachable: boolean;
  latency?: number;
}

/**
 * Check connectivity to multiple endpoints
 */
export const checkEndpoints = async (): Promise<HealthCheckResult[]> => {
  const results: HealthCheckResult[] = [];

  for (const endpoint of HEALTH_CHECK_ENDPOINTS) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), endpoint.timeout);

      const response = await fetch(endpoint.url, {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      results.push({
        name: endpoint.name,
        reachable: response.ok || response.status === 405, // 405 = Method Not Allowed but reachable
        latency: Date.now() - start,
      });
    } catch (error) {
      results.push({
        name: endpoint.name,
        reachable: false,
      });
    }
  }

  return results;
};

/**
 * Check current connectivity - FIX #12: Improved to handle errors properly
 */
export const isOnline = async (): Promise<boolean> => {
  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    const state = await NetInfo.fetch();
    const hasConnection = state.isConnected === true;
    const hasInternet = state.isInternetReachable !== false;

    // Only consider online if BOTH connection AND internet are available
    _isOnline = hasConnection && hasInternet;
    return _isOnline;
  } catch {
    // FIX #12: On error, don't assume online - check endpoints as fallback
    console.warn('[NetworkMonitor] NetInfo failed, checking endpoints...');
    const results = await checkEndpoints();
    // Consider online if at least one endpoint is reachable
    _isOnline = results.some(r => r.reachable);
    return _isOnline;
  }
};

/**
 * Get cached online status (synchronous, from last check)
 */
export const isOnlineCached = (): boolean => _isOnline;

/**
 * Subscribe to network changes (for UI banners, sync triggers)
 */
export const subscribeToNetwork = (onChange: NetworkChangeCallback): (() => void) => {
  _listeners.push(onChange);
  return () => {
    _listeners = _listeners.filter(l => l !== onChange);
  };
};

/**
 * Register a callback to run when device reconnects
 * Used by sync engine and upload queue processor
 */
export const onReconnect = (callback: () => Promise<void> | void): (() => void) => {
  _onReconnectCallbacks.push(callback);
  return () => {
    _onReconnectCallbacks = _onReconnectCallbacks.filter(c => c !== callback);
  };
};

/**
 * Start monitoring network changes
 * Call once on app startup
 */
export const startMonitoring = (): void => {
  if (_unsubscribe) return; // Already monitoring

  try {
    const NetInfo = require('@react-native-community/netinfo').default;

    _unsubscribe = NetInfo.addEventListener((state: any) => {
      const wasOnline = _isOnline;
      _isOnline = !!(state.isConnected && state.isInternetReachable !== false);
      _connectionType = state.type || 'unknown';

      const networkState: NetworkState = {
        isOnline: _isOnline,
        type: _connectionType,
      };

      // Notify UI listeners
      for (const listener of _listeners) {
        try {
          listener(networkState);
        } catch (e) {
          console.warn('[NetworkMonitor] Listener error:', e);
        }
      }

      // Trigger reconnect callbacks when going from offline → online
      if (!wasOnline && _isOnline) {
        console.log('[NetworkMonitor] 🟢 Back online — triggering sync...');
        for (const callback of _onReconnectCallbacks) {
          try {
            Promise.resolve(callback()).catch(e =>
              console.warn('[NetworkMonitor] Reconnect callback error:', e)
            );
          } catch (e) {
            console.warn('[NetworkMonitor] Reconnect callback error:', e);
          }
        }
      }

      if (wasOnline && !_isOnline) {
        console.log('[NetworkMonitor] 🔴 Went offline — queuing operations.');
      }
    });

    // Also listen for app foregrounding (connection often restores)
    const handleAppState = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        isOnline(); // Refresh cached state
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);

    // Store original unsubscribe and add app state cleanup
    const originalUnsubscribe = _unsubscribe;
    _unsubscribe = () => {
      originalUnsubscribe?.();
      sub.remove();
    };

    console.log('[NetworkMonitor] Started monitoring.');
  } catch (e) {
    console.warn('[NetworkMonitor] Failed to start (NetInfo not available):', e);
  }
};

/**
 * Stop monitoring (cleanup)
 */
export const stopMonitoring = (): void => {
  _unsubscribe?.();
  _unsubscribe = null;
  _listeners = [];
  _onReconnectCallbacks = [];
  console.log('[NetworkMonitor] Stopped.');
};

export const networkMonitor = {
  isOnline,
  isOnlineCached,
  checkEndpoints,
  subscribeToNetwork,
  onReconnect,
  startMonitoring,
  stopMonitoring,
};

// FIX #10: Connection state persistence
const CONNECTION_STATE_KEY = 'soulsync_connection_state';

export interface PersistedConnectionState {
  lastOnlineAt: string | null;
  lastSyncAt: string | null;
  pendingMessageCount: number;
}

export const saveConnectionState = async (state: PersistedConnectionState): Promise<void> => {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(CONNECTION_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[NetworkMonitor] Failed to save connection state:', error);
  }
};

export const loadConnectionState = async (): Promise<PersistedConnectionState | null> => {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const state = await AsyncStorage.getItem(CONNECTION_STATE_KEY);
    return state ? JSON.parse(state) : null;
  } catch (error) {
    console.warn('[NetworkMonitor] Failed to load connection state:', error);
    return null;
  }
};
