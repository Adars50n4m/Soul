import { Platform } from 'react-native';

export const NOTIF_ACTION_REPLY_MESSAGE = 'REPLY_MESSAGE';
export const NOTIF_ACTION_MARK_READ = 'MARK_READ';
export const NOTIF_ACTION_ACCEPT_CALL = 'ACCEPT_CALL';
export const NOTIF_ACTION_REJECT_CALL = 'REJECT_CALL';

export const NOTIF_CATEGORY_MESSAGE = 'MESSAGE_CATEGORY';
export const NOTIF_CATEGORY_CALL = 'CALL_CATEGORY';

type NotificationPayload =
  | {
      type: 'message';
      chatId: string;
      senderId: string;
      senderName: string;
      messageId?: string;
    }
  | {
      type: 'call';
      callId: string;
      callerId: string;
      callerName: string;
      callType: 'audio' | 'video';
    };

type NotificationResponseHandler = (
  actionIdentifier: string,
  payload: NotificationPayload,
  userText?: string
) => void;

class NotificationService {
  private initialized = false;
  private available = false;
  private responseSub: { remove: () => void } | null = null;
  private receiveSub: { remove: () => void } | null = null;
  private onResponse: NotificationResponseHandler | null = null;
  private callNotificationMap: Record<string, string> = {};

  private getNotificationsModule() {
    try {
      // Lazy load to avoid crashing when native module isn't linked in current runtime.
      // (e.g. Expo Go / stale dev client)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('expo-notifications');
    } catch (error) {
      return null;
    }
  }

  async initialize(onResponse: NotificationResponseHandler) {
    this.onResponse = onResponse;
    if (this.initialized) return;
    const Notifications = this.getNotificationsModule();
    if (!Notifications) {
      console.warn('[NotificationService] expo-notifications native module unavailable. Notifications disabled in this runtime.');
      this.available = false;
      this.initialized = true;
      return;
    }
    this.available = true;

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    await this.requestPermissions();
    await this.configureChannelsAndCategories();

    this.responseSub = Notifications.addNotificationResponseReceivedListener((response: any) => {
      const payload = response.notification.request.content.data as NotificationPayload;
      const actionIdentifier = response.actionIdentifier;
      const userText = (response as any)?.userText as string | undefined;

      if (!payload || !this.onResponse) return;
      this.onResponse(actionIdentifier, payload, userText);
    });

    this.receiveSub = Notifications.addNotificationReceivedListener((_event: any) => {
      // Reserved: can be used for in-app banners/sound routing if needed.
    });

    this.initialized = true;
  }

  cleanup() {
    this.responseSub?.remove();
    this.receiveSub?.remove();
    this.responseSub = null;
    this.receiveSub = null;
    this.initialized = false;
  }

  async showIncomingMessage(params: {
    chatId: string;
    senderId: string;
    senderName: string;
    text: string;
    messageId?: string;
  }) {
    if (!this.available) return;
    const Notifications = this.getNotificationsModule();
    if (!Notifications) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: params.senderName,
        body: params.text || 'New message',
        categoryIdentifier: NOTIF_CATEGORY_MESSAGE,
        sound: true,
        data: {
          type: 'message',
          chatId: params.chatId,
          senderId: params.senderId,
          senderName: params.senderName,
          messageId: params.messageId,
        } satisfies NotificationPayload,
      },
      trigger: null,
    });
  }

  async showIncomingCall(params: {
    callId: string;
    callerId: string;
    callerName: string;
    callType: 'audio' | 'video';
  }) {
    if (!this.available) return;
    const Notifications = this.getNotificationsModule();
    if (!Notifications) return;
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Incoming call',
        body: `${params.callerName} (${params.callType})`,
        categoryIdentifier: NOTIF_CATEGORY_CALL,
        sound: true,
        data: {
          type: 'call',
          callId: params.callId,
          callerId: params.callerId,
          callerName: params.callerName,
          callType: params.callType,
        } satisfies NotificationPayload,
      },
      trigger: null,
    });
    this.callNotificationMap[params.callId] = id;
  }

  async dismissCallNotification(callId?: string) {
    if (!this.available) return;
    const Notifications = this.getNotificationsModule();
    if (!Notifications) return;
    if (callId && this.callNotificationMap[callId]) {
      await Notifications.dismissNotificationAsync(this.callNotificationMap[callId]);
      delete this.callNotificationMap[callId];
      return;
    }

    const ids = Object.values(this.callNotificationMap);
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
    this.callNotificationMap = {};
  }

  private async requestPermissions() {
    const Notifications = this.getNotificationsModule();
    if (!Notifications) return;
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return;
    await Notifications.requestPermissionsAsync();
  }

  private async configureChannelsAndCategories() {
    const Notifications = this.getNotificationsModule();
    if (!Notifications) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        sound: 'default',
      });
    }

    await Notifications.setNotificationCategoryAsync(NOTIF_CATEGORY_MESSAGE, [
      {
        identifier: NOTIF_ACTION_REPLY_MESSAGE,
        buttonTitle: 'Reply',
        textInput: {
          submitButtonTitle: 'Send',
          placeholder: 'Type a reply...',
        },
      },
      {
        identifier: NOTIF_ACTION_MARK_READ,
        buttonTitle: 'Mark as read',
        options: {
          opensAppToForeground: false,
        },
      },
    ]);

    await Notifications.setNotificationCategoryAsync(NOTIF_CATEGORY_CALL, [
      {
        identifier: NOTIF_ACTION_ACCEPT_CALL,
        buttonTitle: 'Accept',
      },
      {
        identifier: NOTIF_ACTION_REJECT_CALL,
        buttonTitle: 'Reject',
        options: {
          isDestructive: true,
        },
      },
    ]);
  }
}

export const notificationService = new NotificationService();
