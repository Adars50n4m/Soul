/**
 * VoIPPushService.ts
 * 
 * Handles push notification registration and reception for incoming calls:
 * 
 * iOS:  Apple VoIP Push Notifications (APNs with PushKit)
 *       - Wakes the app even when killed
 *       - MUST display a CallKit UI within the push handler or iOS will throttle/kill the app
 *       - Uses `react-native-voip-push-notification` for PushKit integration
 * 
 * Android: Firebase Cloud Messaging (FCM) high-priority data messages
 *       - Uses `@react-native-firebase/messaging` for background/killed state handling
 *       - High-priority data-only messages bypass Doze mode
 *       - Triggers ConnectionService full-screen intent via RNCallKeep
 * 
 * ⚠️ SETUP REQUIRED:
 * 1. Install the native modules:
 *    npx expo install react-native-voip-push-notification @react-native-firebase/app @react-native-firebase/messaging
 * 2. Set VOIP_PUSH_ENABLED = true below
 * 3. Uncomment the require() lines in initializeIOS() and initializeAndroid()
 * 4. Rebuild the app (eas build)
 */

import { Platform } from 'react-native';
import type { IncomingCallPayload } from './NativeCallService';

// ─── Feature Flag ────────────────────────────────────────────────────────────
// Set to true AFTER installing the native modules and uncommenting the requires.
const VOIP_PUSH_ENABLED = false;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VoIPPushToken {
  platform: 'ios' | 'android';
  token: string;
  type: 'voip' | 'fcm';
}

type TokenHandler = (tokenInfo: VoIPPushToken) => void;

// ─── Service ─────────────────────────────────────────────────────────────────

class VoIPPushService {
  private initialized = false;
  private available = false;
  private voipToken: string | null = null;
  private fcmToken: string | null = null;
  private tokenHandlers: Set<TokenHandler> = new Set();

  /**
   * Initialize push notification handling for the current platform.
   * Must be called early in app lifecycle (before any calls can arrive).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!VOIP_PUSH_ENABLED) {
      console.log('[VoIPPushService] Disabled — set VOIP_PUSH_ENABLED = true after installing native modules');
      this.initialized = true;
      return;
    }

    if (Platform.OS === 'ios') {
      await this.initializeIOS();
    } else if (Platform.OS === 'android') {
      await this.initializeAndroid();
    }

    this.initialized = true;
    console.log(`[VoIPPushService] Initialized (available: ${this.available})`);
  }

  // ─── iOS: VoIP Push (PushKit) ────────────────────────────────────────────

  private async initializeIOS(): Promise<void> {
    const VoipPushNotification = require('react-native-voip-push-notification').default;

    if (!VoipPushNotification) {
      console.log('[VoIPPushService] iOS VoIP push module not loaded');
      return;
    }

    this.available = true;
    const { nativeCallService } = require('./NativeCallService');

    VoipPushNotification.addEventListener('register', (token: string) => {
      console.log(`[VoIPPushService] 📱 iOS VoIP token received: ${token.substring(0, 20)}...`);
      this.voipToken = token;
      this.notifyTokenHandlers({ platform: 'ios', token, type: 'voip' });
    });

    VoipPushNotification.addEventListener('notification', (notification: any) => {
      console.log('[VoIPPushService] 📞 iOS VoIP push received:', JSON.stringify(notification));
      const payload = this.parseCallPayload(notification);
      if (payload) {
        nativeCallService.displayIncomingCall(payload);
      }
      VoipPushNotification.onVoipNotificationCompleted(notification.uuid);
    });

    VoipPushNotification.addEventListener('didLoadWithEvents', (events: any[]) => {
      if (!events || events.length === 0) return;
      console.log('[VoIPPushService] iOS app launched by VoIP push, events:', events.length);
      for (const event of events) {
        if (event.name === 'RNVoipPushRemoteNotificationsRegisteredEvent') {
          this.voipToken = event.data;
          this.notifyTokenHandlers({ platform: 'ios', token: event.data, type: 'voip' });
        }
        if (event.name === 'RNVoipPushRemoteNotificationReceivedEvent') {
          const payload = this.parseCallPayload(event.data);
          if (payload) {
            nativeCallService.displayIncomingCall(payload);
          }
        }
      }
    });

    VoipPushNotification.registerVoipToken();
    console.log('[VoIPPushService] iOS VoIP push listeners registered');
  }

  // ─── Android: FCM High-Priority Data Messages ────────────────────────────

  private async initializeAndroid(): Promise<void> {
    const firebaseModule = require('@react-native-firebase/messaging').default;
    const messaging = firebaseModule();

    if (!messaging) {
      console.log('[VoIPPushService] Android FCM module not loaded');
      return;
    }

    this.available = true;

    const authStatus = await messaging.requestPermission();
    const enabled =
      authStatus === firebaseModule.AuthorizationStatus.AUTHORIZED ||
      authStatus === firebaseModule.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.warn('[VoIPPushService] Android notification permission denied');
      return;
    }

    try {
      const token = await messaging.getToken();
      console.log(`[VoIPPushService] 📱 Android FCM token: ${token.substring(0, 20)}...`);
      this.fcmToken = token;
      this.notifyTokenHandlers({ platform: 'android', token, type: 'fcm' });
    } catch (error) {
      console.error('[VoIPPushService] Failed to get FCM token:', error);
    }

    messaging.onTokenRefresh((token: string) => {
      console.log('[VoIPPushService] FCM token refreshed');
      this.fcmToken = token;
      this.notifyTokenHandlers({ platform: 'android', token, type: 'fcm' });
    });

    messaging.onMessage(async (remoteMessage: any) => {
      console.log('[VoIPPushService] 📞 Android FCM foreground message:', remoteMessage.data);
      this.handleAndroidCallMessage(remoteMessage.data);
    });

    messaging.setBackgroundMessageHandler(async (remoteMessage: any) => {
      console.log('[VoIPPushService] 📞 Android FCM background message:', remoteMessage.data);
      this.handleAndroidCallMessage(remoteMessage.data);
    });

    console.log('[VoIPPushService] Android FCM listeners registered');
  }

  private handleAndroidCallMessage(data: any): void {
    if (!data || data.type !== 'incoming_call') return;

    const { nativeCallService } = require('./NativeCallService');

    const payload: IncomingCallPayload = {
      callId: data.callId || data.call_id,
      callerId: data.callerId || data.caller_id,
      callerName: data.callerName || data.caller_name || 'Unknown',
      callType: (data.callType || data.call_type || 'audio') as 'audio' | 'video',
      roomId: data.roomId || data.room_id || data.callId || data.call_id,
    };

    nativeCallService.displayIncomingCall(payload);
  }

  // ─── Shared Utilities ────────────────────────────────────────────────────

  private parseCallPayload(notification: any): IncomingCallPayload | null {
    try {
      const data = notification.data || notification.aps?.data || notification;
      const callId = data.callId || data.call_id || data.uuid;
      const callerId = data.callerId || data.caller_id;
      const callerName = data.callerName || data.caller_name || 'Unknown Caller';
      const callType = (data.callType || data.call_type || 'audio') as 'audio' | 'video';
      const roomId = data.roomId || data.room_id || callId;

      if (!callId || !callerId) {
        console.warn('[VoIPPushService] Invalid call payload — missing callId or callerId');
        return null;
      }

      return { callId, callerId, callerName, callType, roomId };
    } catch (error) {
      console.error('[VoIPPushService] Failed to parse call payload:', error);
      return null;
    }
  }

  getToken(): string | null {
    return Platform.OS === 'ios' ? this.voipToken : this.fcmToken;
  }

  getTokenType(): 'voip' | 'fcm' {
    return Platform.OS === 'ios' ? 'voip' : 'fcm';
  }

  onTokenReceived(handler: TokenHandler): void {
    this.tokenHandlers.add(handler);
    const token = this.getToken();
    if (token) {
      handler({
        platform: Platform.OS as 'ios' | 'android',
        token,
        type: this.getTokenType(),
      });
    }
  }

  removeTokenHandler(handler: TokenHandler): void {
    this.tokenHandlers.delete(handler);
  }

  private notifyTokenHandlers(tokenInfo: VoIPPushToken): void {
    this.tokenHandlers.forEach(handler => {
      try {
        handler(tokenInfo);
      } catch (error) {
        console.error('[VoIPPushService] Token handler error:', error);
      }
    });
  }

  isAvailable(): boolean {
    return this.available;
  }

  cleanup(): void {
    this.tokenHandlers.clear();
    this.initialized = false;
    this.available = false;
  }
}

export const voipPushService = new VoIPPushService();
