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

import { Platform, AppState, AppStateStatus, NativeModules } from 'react-native';

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
 */
const NATIVE_CALLING_ENABLED = true;

function loadCallKeep(): any {
  if (!NATIVE_CALLING_ENABLED) return null;
  
  // Defensive check: RNCallKeep MUST exist in NativeModules to avoid fatal crash on require
  if (!NativeModules.RNCallKeep) {
    console.log('[NativeCallService] RNCallKeep native module not found in binary');
    return null;
  }

  try {
    const CallKeepModule = require('react-native-callkeep');
    // Try both .default and direct object for maximum compatibility with different Metro versions
    return CallKeepModule.default || CallKeepModule;
  } catch (e) {
    console.log('[NativeCallService] react-native-callkeep JS loading failed');
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
  private listenersRegistered = false;
  private callKeepSubscriptions: any[] = [];
  private appStateSubscription: any = null;

  /**
   * Initialize CallKeep with platform-specific configuration.
   * Must be called once at app startup (e.g., in _layout.tsx or AppContext).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.RNCallKeep = loadCallKeep();

    if (!this.RNCallKeep) {
      console.log('[NativeCallService] Skipping init — RNCallKeep not available.');
      this.initialized = true;
      return;
    }

    // Android 11+ (API 30+) requires READ_PHONE_NUMBERS for TelecomManager
    // This is a dangerous permission and MUST be requested at runtime
    if (Platform.OS === 'android') {
      try {
        // Only request permissions if the app is in the foreground to prevent crashes
        if (AppState.currentState !== 'active') {
          console.log('[NativeCallService] App not active, skipping permission request');
          return;
        }

        const { PermissionsAndroid } = require('react-native');
        const permissions = [
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          PermissionsAndroid.PERMISSIONS.CAMERA,
        ];

        // Only add READ_PHONE_NUMBERS if it exists (it was added in API 26)
        if (PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS) {
          permissions.push(PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS);
        }
        console.log('[NativeCallService] Requesting required permissions at runtime...');
        const granted = await PermissionsAndroid.requestMultiple(permissions);
        console.log('[NativeCallService] Permissions result:', granted);
      } catch (e) {
        console.warn('[NativeCallService] Failed to request permissions:', e);
      }
    }

    const options = {
      ios: {
        appName: 'Soul',
        includesCallsInRecents: true,
        maximumCallGroups: 1,
        maximumCallsPerCallGroup: 1,
        supportsVideo: true,
      },
      android: {
        alertTitle: 'Permissions required',
        alertDescription: 'This application needs to access your phone accounts',
        cancelButton: 'Cancel',
        okButton: 'ok',
        imageName: 'ic_launcher',
        selfManaged: true, // CRITICAL for VoIP apps on Android
        foregroundService: {
          channelId: 'com.soulsync4.mobile.calls',
          channelName: 'Soul Calls',
          notificationTitle: 'Soul Call',
          notificationIcon: 'ic_launcher',
        },
      },
    };

    try {
      if (!this.RNCallKeep) {
          console.warn('[NativeCallService] 🛑 RNCallKeep is NULL during setup attempt');
          return;
      }
      
      await this.RNCallKeep.setup(options);

      // Extra safety: Some versions of RNCallKeep might throw if setup fails silently
      this.isReady = true;

      if (Platform.OS === 'android' && this.RNCallKeep) {
        try {
          // Check for method existence before calling to prevent 'undefined is not a function' or property access errors
          if (typeof this.RNCallKeep.setAvailable === 'function') {
              this.RNCallKeep.setAvailable(true);
          }
          
          if (typeof this.RNCallKeep.registerPhoneAccount === 'function') {
              this.RNCallKeep.registerPhoneAccount();
          }
          
          if (typeof this.RNCallKeep.registerAndroidEvents === 'function') {
              this.RNCallKeep.registerAndroidEvents();
          }
          
          if (typeof this.RNCallKeep.canMakeMultipleCalls === 'function') {
              this.RNCallKeep.canMakeMultipleCalls(false);
          }
        } catch (e) {
          console.warn('[NativeCallService] ⚠️ Android-specific setup failed (non-fatal):', e);
        }
      }

      this.registerEventListeners();
      
      // Store AppState subscription for precise removal
      if (this.appStateSubscription) {
          try { this.appStateSubscription.remove(); } catch (e) {}
      }
      this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);

      this.initialized = true;
      this.isReady = true;
      console.log('[NativeCallService] Initialized successfully with selfManaged: true');
    } catch (error) {
      this.initialized = true;
      this.isReady = false;
      console.warn('[NativeCallService] Setup failed (non-fatal):', error);
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

    const { callId, callerName, callType, callerId } = payload;
    
    // Stricter guards for native params to prevent native crashes
    if (!callId || !callerName || !callerId) {
        console.warn('[NativeCallService] 🛑 Missing required params for displayIncomingCall:', { callId, callerName, callerId });
        return;
    }

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
        callerId,
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

    // Stricter guards for native params to prevent native crashes
    if (!callId || !callerName) {
        console.warn('[NativeCallService] 🛑 Missing required params for startOutgoingCall:', { callId, callerName });
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
  reportCallConnected(callId?: string, callType?: 'audio' | 'video'): void {
    if (!this.RNCallKeep) return;
    const uuid = callId || this.activeCallUUID;
    if (uuid) {
      this.RNCallKeep.reportConnectedOutgoingCallWithUUID(uuid);
      this.RNCallKeep.setCurrentCallActive(uuid);

      // FORCE AUDIO ROUTE: ensure speaker is on for video calls, earpiece for audio
      const route = callType === 'video' ? 'Speaker' : 'Phone';
      this.RNCallKeep.setAudioRoute(uuid, route);
      console.log(`[NativeCallService] Audio route set to ${route} for ${uuid}`);
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
    if (!this.RNCallKeep || this.listenersRegistered) return;

    // Use standard RNCallKeep API. Do not store and call .remove() on returned objects.
    this.RNCallKeep.addEventListener('didReceiveStartCallAction', this.onStartCallAction);
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

    this.listenersRegistered = true;
    console.log('[NativeCallService] Event listeners registered precisely');
  }

  private onStartCallAction = (data: any) => {
    console.log('[NativeCallService] 📞 Native start call action:', data);
    // Optional: handle if needed
  };

  private onAnswerCall = ({ callUUID }: { callUUID: string }) => {
    console.log(`[NativeCallService] ✅ User ANSWERED call: ${callUUID}`);
    this.notifyHandlers('answer', callUUID, this.pendingIncomingCall);
    if (this.RNCallKeep) {
      this.RNCallKeep.setCurrentCallActive(callUUID);
      
      // AUTO-ROUTE ON ANSWER
      const callType = this.pendingIncomingCall?.callType || 'audio';
      const route = callType === 'video' ? 'Speaker' : 'Phone';
      this.RNCallKeep.setAudioRoute(callUUID, route);

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
    // We explicitly DO NOT remove RNCallKeep listeners here.
    // react-native-callkeep's internal listener tracking can get out of sync with 
    // RCTEventEmitter during Fast Refresh or rapid unmount/remount cycles, leading 
    // to the fatal "Attempted to remove more RNCallKeep listeners than added" crash.
    // Since RNCallKeep is a global native module, it's safer to leave them attached.
    // The handlers will just gracefully no-op when `pendingIncomingCall` is null.
    console.log(`[NativeCallService] Skipping native CallKeep listener removal to prevent RCTEventEmitter crash`);


    // 2. Remove AppState listener
    if (this.appStateSubscription) {
      console.log('[NativeCallService] Removing AppState listener');
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }

    this.listenersRegistered = false;
    this.eventHandlers.clear();
    this.activeCallUUID = null;
    this.pendingIncomingCall = null;
    this.RNCallKeep = null;
    this.initialized = false;
    this.isReady = false;
    console.log('[NativeCallService] Cleanup complete and state reset');
  }
}

export const nativeCallService = new NativeCallService();
