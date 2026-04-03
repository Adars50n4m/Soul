/**
 * WebSocketErrorHandler.ts
 *
 * Handles WebSocket errors gracefully to prevent native crashes.
 *
 * The native crash (RCTWebSocketModule) occurs when:
 * 1. Metro reloads the app
 * 2. WebSocket connections are interrupted
 * 3. The native layer sends a nil error object
 *
 * This module provides:
 * - Safe WebSocket wrapper with error boundaries
 * - Global error handler for unhandled WebSocket errors
 * - Cleanup helpers for app reload/shutdown
 */

const ORIGINAL_CONSOLE_ERROR_KEY = '__soulSyncOriginalConsoleError';
const CONSOLE_ERROR_PATCHED_KEY = '__soulSyncConsoleErrorPatched';
const CONSOLE_ERROR_IN_FLIGHT_KEY = '__soulSyncConsoleErrorInFlight';

type GlobalConsoleState = typeof globalThis & {
  [ORIGINAL_CONSOLE_ERROR_KEY]?: typeof console.error;
  [CONSOLE_ERROR_PATCHED_KEY]?: boolean;
  [CONSOLE_ERROR_IN_FLIGHT_KEY]?: boolean;
};

/**
 * Safe wrapper for RCTWebSocketModule to prevent nil error crashes
 */
class WebSocketErrorHandler {
  private static instance: WebSocketErrorHandler;
  private isShuttingDown = false;
  private originalConsoleError: typeof console.error;

  static getInstance(): WebSocketErrorHandler {
    if (!WebSocketErrorHandler.instance) {
      WebSocketErrorHandler.instance = new WebSocketErrorHandler();
    }
    return WebSocketErrorHandler.instance;
  }

  constructor() {
    this.originalConsoleError = this.resolveOriginalConsoleError();
    this.setupErrorHandlers();
  }

  private resolveOriginalConsoleError(): typeof console.error {
    const globalState = globalThis as GlobalConsoleState;
    if (!globalState[ORIGINAL_CONSOLE_ERROR_KEY]) {
      globalState[ORIGINAL_CONSOLE_ERROR_KEY] = console.error;
    }
    return globalState[ORIGINAL_CONSOLE_ERROR_KEY]!;
  }

  /**
   * Install global error handlers to catch WebSocket-related errors
   */
  private setupErrorHandlers(): void {
    const globalState = globalThis as GlobalConsoleState;
    if (globalState[CONSOLE_ERROR_PATCHED_KEY]) {
      return;
    }

    globalState[CONSOLE_ERROR_PATCHED_KEY] = true;

    // Patch console.error to filter WebSocket errors during shutdown
    console.error = (...args: any[]) => {
      // Re-entrancy guard: prevents recursive console.error loops during redbox render/update.
      if (globalState[CONSOLE_ERROR_IN_FLIGHT_KEY]) {
        this.originalConsoleError.apply(console, args);
        return;
      }

      globalState[CONSOLE_ERROR_IN_FLIGHT_KEY] = true;
      try {
      const message = args[0]?.toString() || '';
      
      // ALWAYS suppress connection-limit and channel errors (prevents red overlay)
      if (this.isSupabaseConnectionError(message)) {
        console.warn('[Suppressed]', message.substring(0, 80));
        return;
      }
      
      // Filter out WebSocket errors during app reload
      if (this.isShuttingDown && this.isWebSocketError(message)) {
        return;
      }
      
      this.originalConsoleError.apply(console, args);
      } finally {
        globalState[CONSOLE_ERROR_IN_FLIGHT_KEY] = false;
      }
    };

    // console.error is enough to catch most issues without risking native crashes
    // by patching global event handlers which might not exist in Hermes/Native environments.
  }

  /**
   * Check if an error message is WebSocket-related
   */
  private isWebSocketError(message: string): boolean {
    const wsPatterns = [
      'websocket',
      'WebSocket',
      'RCTWebSocket',
      'SocketRocket',
      'socket',
      'Network error',
      'Connection closed',
      'ECONNREFUSED',
      'ETIMEDOUT',
    ];
    
    return wsPatterns.some(pattern => 
      message.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Check if the error is a Supabase Realtime connection-limit error.
   * These should ALWAYS be suppressed from console.error to prevent the red overlay.
   */
  private isSupabaseConnectionError(message: string): boolean {
    const patterns = [
      'CHANNEL_ERROR',
      'connection limit',
      'Potential connection limit',
      'too many connections',
      'Both proxy and direct fetch failed', // Added to suppress intrusive network failure overlays
    ];
    return patterns.some(p => message.toLowerCase().includes(p.toLowerCase()));
  }

  /**
   * Mark the app as shutting down to suppress WebSocket errors
   * Call this before app reload or when unmounting the root component
   */
  setShuttingDown(shuttingDown: boolean = true): void {
    this.isShuttingDown = shuttingDown;
    console.log('[WebSocketErrorHandler] Shutdown state:', shuttingDown);
  }

  /**
   * Safely close all WebSocket connections before app reload
   */
  async cleanupWebSockets(): Promise<void> {
    this.setShuttingDown(true);
    
    try {
      // Give time for any pending WebSocket operations to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Close any global WebSocket instances
      if (typeof global !== 'undefined') {
        // @ts-ignore
        const sockets = global.__WebSocketInstances || [];
        sockets.forEach((ws: WebSocket) => {
          try {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.close(1000, 'App reloading');
            }
          } catch (e) {
            // Ignore errors during cleanup
          }
        });
      }
      
      console.log('[WebSocketErrorHandler] WebSocket cleanup completed');
    } catch (error) {
      console.log('[WebSocketErrorHandler] Cleanup error (non-critical):', error);
    }
  }

  /**
   * Create a WebSocket with enhanced error handling
   */
  createSafeWebSocket(url: string, protocols?: string | string[]): WebSocket {
    const ws = new WebSocket(url, protocols);
    
    // Store reference for cleanup
    if (typeof global !== 'undefined') {
      // @ts-ignore
      global.__WebSocketInstances = global.__WebSocketInstances || [];
      // @ts-ignore
      global.__WebSocketInstances.push(ws);
    }
    
    // Enhance error handler
    const originalOnError = ws.onerror;
    ws.onerror = (event: Event) => {
      if (this.isShuttingDown) {
        console.log('[WebSocketErrorHandler] Suppressed WebSocket error during shutdown');
        return;
      }
      
      if (originalOnError) {
        originalOnError.call(ws, event);
      }
    };
    
    // Enhance close handler for cleanup
    const originalOnClose = ws.onclose;
    ws.onclose = (event: CloseEvent) => {
      // Remove from tracked instances
      if (typeof global !== 'undefined') {
        // @ts-ignore
        const sockets = global.__WebSocketInstances || [];
        const index = sockets.indexOf(ws);
        if (index > -1) {
          sockets.splice(index, 1);
        }
      }
      
      if (originalOnClose) {
        originalOnClose.call(ws, event);
      }
    };
    
    return ws;
  }
}

// Export singleton instance
export const webSocketErrorHandler = WebSocketErrorHandler.getInstance();

// Export convenience functions
export const setShuttingDown = (value: boolean) => webSocketErrorHandler.setShuttingDown(value);
export const cleanupWebSockets = () => webSocketErrorHandler.cleanupWebSockets();
export const createSafeWebSocket = (url: string, protocols?: string | string[]) => 
  webSocketErrorHandler.createSafeWebSocket(url, protocols);

export default WebSocketErrorHandler;
