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

/**
 * Check current connectivity
 */
export const isOnline = async (): Promise<boolean> => {
  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    const state = await NetInfo.fetch();
    _isOnline = !!(state.isConnected && state.isInternetReachable !== false);
    return _isOnline;
  } catch {
    // NetInfo not available, assume online
    return true;
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
  subscribeToNetwork,
  onReconnect,
  startMonitoring,
  stopMonitoring,
};
