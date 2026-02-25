/**
 * NativeCallService.ts
 * 
 * Bridge between the native calling UI (iOS CallKit / Android ConnectionService)
 * and the existing WebRTCService + CallService.
 * 
 * Uses `react-native-callkeep` (RNCallKeep) which provides a unified API for:
 *   - iOS: CallKit (native full-screen incoming call UI)
 *   - Android: ConnectionService + Self-Managed (full-screen intent on lock screen)
 * 
 * ⚠️ IMPORTANT: `react-native-callkeep` must be installed before this service
 * becomes functional. Without it, all methods gracefully no-op.
 * 
 * Install: npx expo install react-native-callkeep
 */

import { Platform, AppState, AppStateStatus } from 'react-native';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IncomingCallPayload {
  callId: string;
  callerId: string;
  callerName: string;
  callType: 'audio' | 'video';
  roomId: string;
}

export type NativeCallAction = 'answer' | 'end' | 'mute' | 'unmute' | 'hold' | 'unhold' | 'dtmf';

export type NativeCallEventHandler = (action: NativeCallAction, callId: string, payload?: any) => void;

// ─── Safe module loader ──────────────────────────────────────────────────────

/**
 * Attempt to load RNCallKeep. Returns null if not installed.
 * This is called lazily (inside initialize()) so Metro won't fail at bundle time
 * if the module isn't in node_modules — the require() is inside a function that
 * is only called at runtime.
 * 
 * NOTE: Metro DOES statically resolve require() even inside functions.
 * If react-native-callkeep is NOT installed, you must remove or comment out
 * the require() line below, or install the package.
 * 
 * For development without the package, set NATIVE_CALLING_ENABLED = false.
 */
const NATIVE_CALLING_ENABLED = true; // Set to true after installing react-native-callkeep

function loadCallKeep(): any {
  if (!NATIVE_CALLING_ENABLED) return null;
  try {
    // Uncomment the line below AFTER running: npx expo install react-native-callkeep
    return require('react-native-callkeep').default;
  } catch (e) {
    console.log('[NativeCallService] react-native-callkeep not available');
    return null;
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

class NativeCallService {
  private initialized = false;
  private isReady = false;
  private RNCallKeep: any = null;
  private activeCallUUID: string | null = null;
  private pendingIncomingCall: IncomingCallPayload | null = null;
  private eventHandlers: Set<NativeCallEventHandler> = new Set();
  private appState: AppStateStatus = AppState.currentState;

  /**
   * Initialize CallKeep with platform-specific configuration.
   * Must be called once at app startup (e.g., in _layout.tsx or AppContext).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.RNCallKeep = loadCallKeep();

    if (!this.RNCallKeep) {
      console.log('[NativeCallService] Skipping init — RNCallKeep not available. Install react-native-callkeep and set NATIVE_CALLING_ENABLED = true');
      this.initialized = true;
      return;
    }

    const options = {
      ios: {
        appName: 'SoulSync',
        includesCallsInRecents: true,
        maximumCallGroups: 1,
        maximumCallsPerCallGroup: 1,
        supportsVideo: true,
      },
      android: {
        alertTitle: 'Permissions Required',
        alertDescription: 'SoulSync needs phone account permission to show incoming calls',
        cancelButton: 'Cancel',
        okButton: 'OK',
        selfManaged: true,
        additionalPermissions: [],
        foregroundService: {
          channelId: 'com.soulsync4.mobile.calls',
          channelName: 'SoulSync Calls',
          notificationTitle: 'SoulSync Call',
          notificationIcon: 'ic_launcher',
        },
      },
    };

    try {
      await this.RNCallKeep.setup(options);

      if (Platform.OS === 'android') {
        this.RNCallKeep.setAvailable(true);
        this.RNCallKeep.registerPhoneAccount();
        this.RNCallKeep.registerAndroidEvents();
        this.RNCallKeep.canMakeMultipleCalls(false);
      }

      this.registerEventListeners();
      AppState.addEventListener('change', this.handleAppStateChange);

      this.initialized = true;
      this.isReady = true;
      console.log('[NativeCallService] Initialized successfully');
    } catch (error) {
      this.initialized = true; // Still marked as initialized to avoid re-entry
      this.isReady = false;
      console.error('[NativeCallService] Setup failed:', error);
    }
  }

  /**
   * Display the native incoming call UI.
   */
  displayIncomingCall(payload: IncomingCallPayload): void {
    if (!this.RNCallKeep || !this.isReady) {
      console.log('[NativeCallService] Ignoring displayIncomingCall - not ready');
      return;
    }

    const { callId, callerName, callType } = payload;
    
    if (Platform.OS === 'ios' && !this.isValidUUID(callId)) {
        console.warn(`[NativeCallService] 🛑 Invalid UUID for CallKit: ${callId}. Skipping to prevent native crash.`);
        return;
    }

    this.activeCallUUID = callId;
    this.pendingIncomingCall = payload;

    console.log(`[NativeCallService] Displaying incoming ${callType} call from ${callerName} (${callId})`);

    try {
      this.RNCallKeep.displayIncomingCall(
        callId,
        payload.callerId,
        callerName,
        'generic',
        callType === 'video',
      );
    } catch (e) {
      console.error('[NativeCallService] Native displayIncomingCall crash prevented:', e);
    }
  }

  /**
   * Report that an outgoing call has started connecting.
   */
  startOutgoingCall(callId: string, callerName: string, callType: 'audio' | 'video'): void {
    if (!this.RNCallKeep || !this.isReady) {
      console.log('[NativeCallService] Ignoring startOutgoingCall - not ready');
      return;
    }

    if (Platform.OS === 'ios' && !this.isValidUUID(callId)) {
        console.warn(`[NativeCallService] 🛑 Invalid UUID for CallKit: ${callId}. Skipping to prevent native crash.`);
        return;
    }

    this.activeCallUUID = callId;

    try {
      this.RNCallKeep.startCall(callId, callerName, callerName, 'generic', callType === 'video');
      this.RNCallKeep.reportConnectingOutgoingCallWithUUID(callId);
    } catch (e) {
      console.error('[NativeCallService] Native startOutgoingCall crash prevented:', e);
    }
  }

  /**
   * Report that the call is now connected (media flowing).
   */
  reportCallConnected(callId?: string): void {
    if (!this.RNCallKeep) return;
    const uuid = callId || this.activeCallUUID;
    if (uuid) {
      this.RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
      this.RNCallKeep.setCurrentCallActive(uuid);
    }
  }

  /**
   * End the call in the native UI.
   */
  endNativeCall(callId?: string): void {
    if (!this.RNCallKeep) return;
    const uuid = callId || this.activeCallUUID;
    if (uuid) {
      console.log(`[NativeCallService] Ending native call: ${uuid}`);
      this.RNCallKeep.endCall(uuid);
      this.RNCallKeep.reportEndCallWithUUID(uuid, 6);
    }
    this.activeCallUUID = null;
    this.pendingIncomingCall = null;
  }

  /**
   * Reject an incoming call in the native UI.
   */
  rejectNativeCall(callId?: string): void {
    if (!this.RNCallKeep) return;
    const uuid = callId || this.activeCallUUID;
    if (uuid) {
      console.log(`[NativeCallService] Rejecting native call: ${uuid}`);
      this.RNCallKeep.rejectCall(uuid);
      this.RNCallKeep.reportEndCallWithUUID(uuid, 2);
    }
    this.activeCallUUID = null;
    this.pendingIncomingCall = null;
  }

  /**
   * Update the native call UI to reflect mute state.
   */
  setMuted(muted: boolean, callId?: string): void {
    if (!this.RNCallKeep) return;
    const uuid = callId || this.activeCallUUID;
    if (uuid) {
      this.RNCallKeep.setMutedCall(uuid, muted);
    }
  }

  /**
   * Update the native call UI to reflect hold state.
   */
  setOnHold(held: boolean, callId?: string): void {
    if (!this.RNCallKeep) return;
    const uuid = callId || this.activeCallUUID;
    if (uuid) {
      this.RNCallKeep.setOnHold(uuid, held);
    }
  }

  getPendingIncomingCall(): IncomingCallPayload | null {
    return this.pendingIncomingCall;
  }

  clearPendingIncomingCall(): void {
    this.pendingIncomingCall = null;
  }

  isAvailable(): boolean {
    return !!this.RNCallKeep && this.initialized && this.isReady;
  }

  private isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  addEventHandler(handler: NativeCallEventHandler): void {
    this.eventHandlers.add(handler);
  }

  removeEventHandler(handler: NativeCallEventHandler): void {
    this.eventHandlers.delete(handler);
  }

  // ─── Private: Event Listeners ────────────────────────────────────────────

  private registerEventListeners(): void {
    if (!this.RNCallKeep) return;

    this.RNCallKeep.addEventListener('answerCall', this.onAnswerCall);
    this.RNCallKeep.addEventListener('endCall', this.onEndCall);
    this.RNCallKeep.addEventListener('didDisplayIncomingCall', this.onDidDisplayIncomingCall);
    this.RNCallKeep.addEventListener('didActivateAudioSession', this.onDidActivateAudioSession);
    this.RNCallKeep.addEventListener('didDeactivateAudioSession', this.onDidDeactivateAudioSession);
    this.RNCallKeep.addEventListener('didPerformSetMutedCallAction', this.onToggleMute);
    this.RNCallKeep.addEventListener('didToggleHoldCallAction', this.onToggleHold);
    this.RNCallKeep.addEventListener('didPerformDTMFAction', this.onDTMF);
    this.RNCallKeep.addEventListener('didResetProvider', this.onProviderReset);
    this.RNCallKeep.addEventListener('checkReachability', this.onCheckReachability);

    console.log('[NativeCallService] Event listeners registered');
  }

  private onAnswerCall = ({ callUUID }: { callUUID: string }) => {
    console.log(`[NativeCallService] ✅ User ANSWERED call: ${callUUID}`);
    this.notifyHandlers('answer', callUUID, this.pendingIncomingCall);
    if (this.RNCallKeep) {
      this.RNCallKeep.setCurrentCallActive(callUUID);
      if (Platform.OS === 'android') {
        this.RNCallKeep.backToForeground();
      }
    }
  };

  private onEndCall = ({ callUUID }: { callUUID: string }) => {
    console.log(`[NativeCallService] ❌ User ENDED/DECLINED call: ${callUUID}`);
    this.notifyHandlers('end', callUUID);
    this.activeCallUUID = null;
    this.pendingIncomingCall = null;
  };

  private onDidDisplayIncomingCall = ({ callUUID, error }: { callUUID: string; error?: string }) => {
    if (error) {
      console.error(`[NativeCallService] Error displaying incoming call: ${error}`);
      this.activeCallUUID = null;
      this.pendingIncomingCall = null;
      return;
    }
    console.log(`[NativeCallService] Incoming call displayed: ${callUUID}`);
  };

  private onDidActivateAudioSession = () => {
    console.log('[NativeCallService] 🔊 Audio session activated');
  };

  private onDidDeactivateAudioSession = () => {
    console.log('[NativeCallService] 🔇 Audio session deactivated');
  };

  private onToggleMute = ({ muted, callUUID }: { muted: boolean; callUUID: string }) => {
    console.log(`[NativeCallService] 🔇 Mute toggled: ${muted} for ${callUUID}`);
    this.notifyHandlers(muted ? 'mute' : 'unmute', callUUID);
  };

  private onToggleHold = ({ hold, callUUID }: { hold: boolean; callUUID: string }) => {
    console.log(`[NativeCallService] ⏸ Hold toggled: ${hold} for ${callUUID}`);
    this.notifyHandlers(hold ? 'hold' : 'unhold', callUUID);
  };

  private onDTMF = ({ digits, callUUID }: { digits: string; callUUID: string }) => {
    console.log(`[NativeCallService] 🔢 DTMF: ${digits} for ${callUUID}`);
    this.notifyHandlers('dtmf', callUUID, { digits });
  };

  private onProviderReset = () => {
    console.log('[NativeCallService] Provider reset — ending all calls');
    if (this.activeCallUUID) {
      this.notifyHandlers('end', this.activeCallUUID);
      this.activeCallUUID = null;
      this.pendingIncomingCall = null;
    }
  };

  private onCheckReachability = () => {
    if (this.RNCallKeep) {
      this.RNCallKeep.setReachable();
    }
  };

  // Note: 'showIncomingCallUi' is not supported by the installed RNCallKeep version

  private handleAppStateChange = (nextAppState: AppStateStatus) => {
    this.appState = nextAppState;
  };

  private notifyHandlers(action: NativeCallAction, callId: string, payload?: any): void {
    this.eventHandlers.forEach(handler => {
      try {
        handler(action, callId, payload);
      } catch (error) {
        console.error(`[NativeCallService] Handler error for ${action}:`, error);
      }
    });
  }

  cleanup(): void {
    if (this.RNCallKeep) {
      this.RNCallKeep.removeEventListener('answerCall');
      this.RNCallKeep.removeEventListener('endCall');
      this.RNCallKeep.removeEventListener('didDisplayIncomingCall');
      this.RNCallKeep.removeEventListener('didActivateAudioSession');
      this.RNCallKeep.removeEventListener('didDeactivateAudioSession');
      this.RNCallKeep.removeEventListener('didPerformSetMutedCallAction');
      this.RNCallKeep.removeEventListener('didToggleHoldCallAction');
      this.RNCallKeep.removeEventListener('didPerformDTMFAction');
      this.RNCallKeep.removeEventListener('didResetProvider');
      this.RNCallKeep.removeEventListener('checkReachability');
    }
    this.eventHandlers.clear();
    this.activeCallUUID = null;
    this.pendingIncomingCall = null;
    this.RNCallKeep = null;
    this.initialized = false;
  }
}

export const nativeCallService = new NativeCallService();
