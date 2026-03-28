// mobile/services/ChatService.ts
// ─────────────────────────────────────────────────────────────────────────────
// CHAT SERVICE  (Network + Sync Layer)
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { SUPABASE_ENDPOINT } from '../config/api';
import { offlineService, type QueuedMessage, type MessageStatus } from './LocalDBService';
import { storageService } from './StorageService';
import { AppState, AppStateStatus } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { soulFolderService } from './SoulFolderService';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  sender_id: string;
  receiver_id: string;
  text: string;
  timestamp: string;
  status: MessageStatus;
  media?: {
    type: 'image' | 'video' | 'audio' | 'file' | 'status_reply';
    url: string;
    name?: string;
    caption?: string;
    thumbnail?: string;
    duration?: number;
  };
  reply_to?: string;
  reactions?: string[];
  localFileUri?: string;
}

type MessageCallback      = (message: ChatMessage) => void;
type StatusCallback       = (messageId: string, status: ChatMessage['status'], newId?: string) => void;
type NetworkStatusCallback = (isOnline: boolean) => void;
type UploadProgressCallback = (messageId: string, progress: number) => void;

// ─────────────────────────────────────────────────────────────────────────────
// RETRY CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRY_COUNT      = 5;
const MAX_TOTAL_RETRIES    = 10;
const MAX_REALTIME_RETRIES = 5;
const POLLING_INTERVAL_NORMAL = 30000;
const POLLING_INTERVAL_FALLBACK = 12000;
const INITIAL_RETRY_DELAY  = 1_000;   // 1 second
const MAX_RETRY_DELAY      = 60_000;  // 1 minute cap

const ACTIVE_POLL_INTERVAL = 2_000;   // 2 seconds
const IDLE_POLL_INTERVAL   = 3_000;   // 3 seconds
const REALTIME_POLL_INTERVAL = 30_000; // 30 seconds

class ChatService {
  private channel:              ReturnType<typeof supabase.channel> | null = null;
  private userId:               string | null = null;
  private partnerId:            string | null = null;
  private senderName:           string = 'Someone';

  private onNewMessage:         MessageCallback       | null = null;
  private onStatusUpdate:       StatusCallback        | null = null;
  private onNetworkStatusChange:NetworkStatusCallback | null = null;
  private onUploadProgressCb:   UploadProgressCallback| null = null;
  private onAcknowledgment:      ((messageId: string, status: 'delivered' | 'read', timestamp: string) => void) | null = null;
  private onDeleteMessage:       ((messageId: string) => void) | null = null;

  private isInitialized      = false;
  private isDeviceOnline     = true;
  private isServerReachable  = true;
  private isRealtimeConnected = false;

  private get isActuallyOnline(): boolean {
    return this.isDeviceOnline && this.isServerReachable;
  }
  private realtimeRetryCount:   number = 0;
  private realtimeRetryTimer:   ReturnType<typeof setTimeout> | null = null;
  private isReconnecting:       boolean = false;

  private processQueueTimer:    ReturnType<typeof setInterval> | null = null;
  private sendingIds:           Set<string> = new Set();
  private networkListenerCleanup: (() => void) | null = null;

  private pollTimer:            ReturnType<typeof setInterval> | null = null;
  private lastPollAt:           string | null = null;
  private isPolling:            boolean = false;
  private appStateListener:     any = null;
  private isRealtimeConnecting: boolean = false;

  async initialize(
    userId: string,
    partnerId: string,
    senderName: string,
    onMessage: MessageCallback,
    onStatus: StatusCallback,
    onNetworkStatus?: NetworkStatusCallback,
    onUploadProgress?: UploadProgressCallback,
    onAcknowledgment?: (messageId: string, status: 'delivered' | 'read', timestamp: string) => void,
    onDeleteMessage?: (messageId: string) => void
  ): Promise<void> {
    if (this.isInitialized && this.userId === userId && this.partnerId === partnerId) {
      return;
    }

    this.cleanup();

    this.userId      = userId;
    this.partnerId   = partnerId;
    this.senderName  = senderName;

    this.onNewMessage          = onMessage;
    this.onStatusUpdate        = onStatus;
    this.onNetworkStatusChange = onNetworkStatus ?? null;
    this.onUploadProgressCb    = onUploadProgress ?? null;
    this.onAcknowledgment      = onAcknowledgment ?? null;
    this.onDeleteMessage       = onDeleteMessage ?? null;

    this.isInitialized         = true;

    await this.setupNetworkListener();
    await this.fetchMissedMessages();
    await this.subscribeToRealtime();
    this.startMessagePolling();
  }

  private async subscribeToRealtime(): Promise<void> {
    if (!this.userId) return;
    if (this.isRealtimeConnecting) return;

    this.isRealtimeConnecting = true;
    const channelName = `chat_${this.userId}`;

    if (this.channel) {
      try {
        await supabase.removeChannel(this.channel);
      } catch (e) {}
      this.channel = null;
    }

    this.channel = supabase.channel(channelName);

    this.channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        async (payload) => {
          const incoming = this.mapDbRowToChatMessage(payload.new);
          if (incoming.receiver_id !== this.userId) return;

          await offlineService.saveMessage(incoming.sender_id, {
            id:        incoming.id,
            sender:    'them',
            text:      incoming.text,
            timestamp: incoming.timestamp,
            status:    'delivered',
            media:     incoming.media,
            replyTo:   incoming.reply_to,
          });

          if (incoming.sender_id === this.partnerId) {
            this.onNewMessage?.(incoming);
            this.updateMessageStatusOnServer(incoming.id, 'delivered');
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        async (payload) => {
          const updated = payload.new as any;
          if (updated.sender !== this.userId) return;
          if (updated.status) {
            await offlineService.updateMessageStatus(updated.id.toString(), updated.status as MessageStatus);
            this.onStatusUpdate?.(updated.id.toString(), updated.status);
            if (updated.status === 'delivered' || updated.status === 'read') {
              const timestamp = updated.status === 'delivered' ? (updated.delivered_at || new Date().toISOString()) : (updated.read_at || new Date().toISOString());
              this.onAcknowledgment?.(updated.id.toString(), updated.status, timestamp);
            }
          }
        }
      )
      .on(
        'broadcast',
        { event: 'delete-message' },
        async (payload) => {
          const { messageId } = payload.payload;
          console.log(`[ChatService] Received delete broadcast for ${messageId}`);
          await offlineService.deleteMessage(messageId);
          this.onDeleteMessage?.(messageId);
        }
      )
      .subscribe((status, err) => {
        this.isRealtimeConnecting = false;
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true;
          this.realtimeRetryCount = 0;
          this.syncConnectivityState();
          this.startQueueProcessing();
          this.fetchMissedMessages();
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          this.isRealtimeConnected = false;
          this.syncConnectivityState();
          this.handleRealtimeReconnect();
        }
      });
  }

  private handleRealtimeReconnect() {
    if (this.isReconnecting) return;
    if (this.realtimeRetryCount >= MAX_REALTIME_RETRIES) {
      this.isRealtimeConnected = false;
      this.isReconnecting = false;
      this.startMessagePolling();
      return;
    }

    this.isReconnecting = true;
    if (this.realtimeRetryTimer) clearTimeout(this.realtimeRetryTimer);

    if (this.channel) {
      const oldChannel = this.channel;
      this.channel = null;
      supabase.removeChannel(oldChannel).catch(() => {});
    }

    const delay = Math.min(Math.pow(2, this.realtimeRetryCount) * 1000, 30000);
    this.realtimeRetryCount++;

    this.realtimeRetryTimer = setTimeout(async () => {
      this.isReconnecting = false;
      await this.subscribeToRealtime();
    }, delay);
  }

  public getConnectivityState() {
    return {
      isDeviceOnline: this.isDeviceOnline,
      isServerReachable: this.isServerReachable,
      isRealtimeConnected: this.isRealtimeConnected
    };
  }

  private async setupNetworkListener(): Promise<void> {
    await this.checkConnectivity();
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        this.checkConnectivity();
        if (this.isInitialized) this.fetchMissedMessages();
      }
    };
    const subscription = AppState.addEventListener('change', handleAppState);
    const intervalId = setInterval(() => this.checkConnectivity(), 15_000);
    this.networkListenerCleanup = () => {
      subscription.remove();
      clearInterval(intervalId);
    };
  }

  private async checkConnectivity(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 8_000);
      await fetch(SUPABASE_ENDPOINT, { method: 'GET', signal: controller.signal, mode: 'no-cors', headers: { 'Cache-Control': 'no-cache' } });
      clearTimeout(timeoutId);
      this.isDeviceOnline = true;
      this.isServerReachable = true;
      this.syncConnectivityState();
      this.startQueueProcessing();
      return true;
    } catch (error: any) {
      this.isServerReachable = false;
      this.syncConnectivityState();
      this.stopQueueProcessing();
      return false;
    }
  }

  private syncConnectivityState(): void {
    const isActuallyOnline = this.isDeviceOnline && this.isServerReachable;
    this.onNetworkStatusChange?.(isActuallyOnline);
    if (isActuallyOnline) this.processQueue();
  }

  private syncConnected(): void {
    if (!this.isServerReachable || !this.isDeviceOnline) {
      this.isDeviceOnline = true;
      this.isServerReachable = true;
      this.syncConnectivityState();
    }
  }

  private startQueueProcessing(): void {
    if (this.processQueueTimer || !this.isActuallyOnline) return;
    this.processQueue();
  }

  private stopQueueProcessing(): void {
    if (this.processQueueTimer) {
      clearInterval(this.processQueueTimer as any);
      this.processQueueTimer = null;
    }
    this.sendingIds.clear();
  }

  private isProcessingQueue: boolean = false;
  private hasPendingProcessQueueTrigger: boolean = false;

  private async processQueue(): Promise<void> {
    if (!this.isActuallyOnline || this.isProcessingQueue) {
      if (this.isProcessingQueue) this.hasPendingProcessQueueTrigger = true;
      return;
    }

    this.isProcessingQueue = true;
    this.hasPendingProcessQueueTrigger = false;

    try {
      const pendingMessages = await offlineService.getPendingMessages();
      const pollInterval = this.isRealtimeConnected ? REALTIME_POLL_INTERVAL : IDLE_POLL_INTERVAL;
      const nextInterval = pendingMessages.length > 0 ? ACTIVE_POLL_INTERVAL : pollInterval;

      for (const message of pendingMessages) {
        if (this.sendingIds.has(message.id)) continue;
        await this.sendMessageToSupabase(message);
      }

      if (this.isActuallyOnline) {
        this.processQueueTimer = setTimeout(() => this.processQueue(), nextInterval) as any;
      }
    } catch (error) {
      if (this.isActuallyOnline) {
        this.processQueueTimer = setTimeout(() => this.processQueue(), REALTIME_POLL_INTERVAL) as any;
      }
    } finally {
      this.isProcessingQueue = false;
      if (this.hasPendingProcessQueueTrigger && this.isActuallyOnline) this.processQueue();
    }
  }

  private async sendMessageToSupabase(message: QueuedMessage): Promise<void> {
    if (!this.userId) return;
    this.sendingIds.add(message.id);

    try {
      let finalMediaUrl = message.media?.url;
      if (message.localFileUri && !finalMediaUrl && message.media) {
        finalMediaUrl = await storageService.uploadImage(message.localFileUri, 'chat-media', this.userId, (progress) => {
          this.onUploadProgressCb?.(message.id, progress);
        }) || undefined;
        if (finalMediaUrl) await offlineService.updateMessageMediaUrl(message.id, finalMediaUrl);
      }

      const expiresAt = new Date(Date.now() + 300000).toISOString();

      const { data, error } = await supabase
        .from('messages')
        .insert({
          id:            message.id.startsWith('temp_') ? undefined : message.id,
          sender:        this.userId,
          receiver:      message.chatId,
          text:          message.text,
          media_type:    message.media?.type    ?? null,
          media_url:     finalMediaUrl          ?? null,
          media_caption: message.media?.caption ?? null,
          media_thumbnail: message.media?.thumbnail ?? null,
          reply_to_id:   message.replyTo        ?? null,
          created_at:    message.timestamp,
          expires_at:    expiresAt,
          media_duration: message.media?.duration ?? null,
        })
        .select()
        .single();

      if (error) throw error;
      this.syncConnected();

      const serverId = data.id.toString();
      if (message.id !== serverId) await offlineService.updateMessageId(message.id, serverId);
      if (finalMediaUrl && finalMediaUrl !== message.media?.url) await offlineService.updateMessageMediaUrl(serverId, finalMediaUrl);
      
      await offlineService.updateMessageStatus(serverId, 'sent');
      await offlineService.removePendingSyncOpsForEntity('message', message.id);
      this.onStatusUpdate?.(message.id, 'sent', serverId);

      try {
        await supabase.functions.invoke('send-message-push', {
          body: { receiverId: message.chatId, senderId: this.userId, senderName: this.senderName, text: message.text, messageId: serverId },
        });
      } catch (_) {}

    } catch (error: any) {
      const newRetryCount = message.retryCount + 1;
      await offlineService.updateMessageRetry(message.id, newRetryCount, error?.message ?? 'Network error');
      if (newRetryCount >= MAX_RETRY_COUNT) {
        await offlineService.markMessageAsFailed(message.id, error?.message ?? 'Max retries exceeded');
        this.onStatusUpdate?.(message.id, 'failed');
      }
    } finally {
      this.sendingIds.delete(message.id);
    }
  }

  private async fetchMissedMessages(): Promise<void> {
    if (!this.userId || !this.partnerId) return;
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(`and(sender.eq.${this.partnerId},receiver.eq.${this.userId}),and(sender.eq.${this.userId},receiver.eq.${this.partnerId})`)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error || !data) {
        this.lastPollAt = new Date().toISOString();
        return;
      }
      this.syncConnected();
      this.lastPollAt = new Date().toISOString();
      const recentMessages = data.reverse();

      for (const row of recentMessages) {
        const msg = this.mapDbRowToChatMessage(row);
        if (msg.sender_id === this.userId && this.sendingIds.has(msg.id)) continue;

        const existing = await offlineService.getMessageById(msg.id);
        await offlineService.saveMessage(msg.sender_id === this.userId ? msg.receiver_id : msg.sender_id, {
          id: msg.id, sender: msg.sender_id === this.userId ? 'me' : 'them', text: msg.text, timestamp: msg.timestamp, status: msg.status, media: msg.media, replyTo: msg.reply_to,
        });
        if (!existing) this.onNewMessage?.(msg);
      }
    } catch (e) {
      console.warn('[ChatService] fetchMissedMessages error:', e);
    }
  }

  public async requestDeleteForEveryone(messageId: string): Promise<boolean> {
    if (!this.userId || !this.partnerId || !this.channel) return false;
    this.channel.send({ type: 'broadcast', event: 'delete-message', payload: { messageId } });
    const { error } = await supabase.from('messages').delete().eq('id', messageId);
    if (error) return false;
    return true;
  }

  async sendMessage(chatId: string, text: string, media?: ChatMessage['media'], replyTo?: string, localUri?: string): Promise<ChatMessage | null> {
    if (!this.userId) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        this.userId = user.id;
        this.senderName = user.user_metadata?.name ?? user.user_metadata?.display_name ?? this.senderName;
      }
    }

    const targetChatId = chatId || this.partnerId;
    if (!this.userId || !targetChatId) return null;

    const messageId = Crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // WHATSAPP PATTERN: Move media to 'Sent' folder immediately for local-first persistence
    let finalLocalUri = localUri;
    if (localUri && media) {
        try {
            // Use getDestinationPath with isSent = true to get the correct Soul/Media/.../Sent/ path
            const destPath = soulFolderService.getDestinationPath(media.type as any, true, localUri);
            await FileSystem.copyAsync({ from: localUri, to: destPath });
            finalLocalUri = destPath;
            console.log(`[ChatService] Media moved to local Sent folder: ${destPath}`);
        } catch (e) {
            console.warn('[ChatService] Failed to move media to Sent folder:', e);
        }
    }

    const queuedMsg: QueuedMessage = {
      id: messageId, chatId: targetChatId, sender: 'me', text, timestamp, status: 'pending', media: media ? { ...media } : undefined, replyTo, retryCount: 0, localFileUri: finalLocalUri,
    };

    try {
      await offlineService.savePendingMessage(targetChatId, queuedMsg);
      const idempotencyKey = `${this.userId}:${targetChatId}:${Date.now()}:${Crypto.randomUUID()}`;
      await offlineService.updateMessageIdempotencyKey(messageId, idempotencyKey);
    } catch (e) {}

    const uiMessage: ChatMessage = {
      id: messageId, sender_id: this.userId, receiver_id: targetChatId, text, timestamp, status: 'pending', media, reply_to: replyTo, localFileUri: finalLocalUri,
    };

    this.onNewMessage?.(uiMessage);
    if (this.isActuallyOnline) this.processQueue();
    return uiMessage;
  }

  async updateMessageStatusOnServer(messageId: string, status: 'delivered' | 'read'): Promise<void> {
    try {
      await supabase.from('messages').update({ status }).eq('id', messageId);
      this.syncConnected();
    } catch (_) {}
  }

  async markMessagesAsRead(messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    try {
      await supabase.from('messages').update({ status: 'read' }).in('id', messageIds);
      this.syncConnected();
      for (const id of messageIds) await offlineService.updateMessageStatus(id, 'read');
    } catch (_) {}
  }

  async retryMessage(messageId: string): Promise<void> {
    const message = await offlineService.getMessageById(messageId);
    if (!message) return;
    await offlineService.updateMessageRetry(messageId, 0);
    await offlineService.updateMessageStatus(messageId, 'pending');
    if (this.isActuallyOnline) this.processQueue();
  }

  getNetworkStatus(): boolean {
    return this.isActuallyOnline;
  }

  async getPendingMessageCount(chatId: string): Promise<number> {
    const pending = await offlineService.getPendingMessages();
    return pending.filter(m => m.chatId === chatId).length;
  }

  async clearServerMessages(userId: string, partnerId: string): Promise<void> {
    await supabase.from('messages').delete().or(`and(sender.eq.${userId},receiver.eq.${partnerId}),and(sender.eq.${partnerId},receiver.eq.${userId})`);
    await offlineService.clearChat(partnerId);
  }

  private mapDbRowToChatMessage(row: any): ChatMessage {
    return {
      id: row.id.toString(), sender_id: row.sender, receiver_id: row.receiver, text: row.text ?? '', timestamp: row.created_at, status: (row.status as ChatMessage['status']) ?? 'sent',
      media: row.media_url ? { type: row.media_type ?? 'image', url: row.media_url, caption: row.media_caption, thumbnail: row.media_thumbnail, duration: row.media_duration } : undefined,
      reply_to: row.reply_to_id ? row.reply_to_id.toString() : undefined, reactions: row.reaction ? [row.reaction] : undefined,
    };
  }

  private startMessagePolling(): void {
    const currentFrequency = this.isRealtimeConnected ? POLLING_INTERVAL_NORMAL : POLLING_INTERVAL_FALLBACK;
    if (this.pollTimer) return;
    if (!this.lastPollAt) this.lastPollAt = new Date().toISOString();

    this.pollTimer = setInterval(() => { if (AppState.currentState === 'active') this.pollForNewMessages(); }, currentFrequency) as any;

    if (!this.appStateListener) {
      this.appStateListener = AppState.addEventListener('change', (state) => {
        if (state === 'active') { this.pollForNewMessages(); this.checkConnectivity(); }
      });
    }
  }

  private stopMessagePolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer as any); this.pollTimer = null; }
    if (this.appStateListener) { this.appStateListener.remove(); this.appStateListener = null; }
  }

  private async pollForNewMessages(): Promise<void> {
    if (!this.userId || !this.partnerId || !this.lastPollAt || this.isPolling || !this.isActuallyOnline) return;
    this.isPolling = true;
    try {
      const { data, error } = await supabase.from('messages').select('*').or(`and(sender.eq.${this.partnerId},receiver.eq.${this.userId}),and(sender.eq.${this.userId},receiver.eq.${this.partnerId})`).gt('created_at', this.lastPollAt).order('created_at', { ascending: true });
      if (error) return;
      this.lastPollAt = data?.[data.length - 1]?.created_at || new Date().toISOString();
      if (!data) return;
      for (const row of data) {
        const msg = this.mapDbRowToChatMessage(row);
        const existing = await offlineService.getMessageById(msg.id);
        await offlineService.saveMessage(msg.sender_id === this.userId ? msg.receiver_id : msg.sender_id, {
          id: msg.id, sender: msg.sender_id === this.userId ? 'me' : 'them', text: msg.text, timestamp: msg.timestamp, status: msg.status, media: msg.media, replyTo: msg.reply_to,
        });
        if (!existing) this.onNewMessage?.(msg);
        if (msg.sender_id === this.partnerId) this.updateMessageStatusOnServer(msg.id, 'delivered');
      }
    } catch (_) {} finally { this.isPolling = false; }
  }

  cleanup(): void {
    this.stopQueueProcessing();
    this.stopMessagePolling();
    if (this.networkListenerCleanup) { this.networkListenerCleanup(); this.networkListenerCleanup = null; }
    if (this.channel) { const oldChannel = this.channel; this.channel = null; supabase.removeChannel(oldChannel).catch(() => {}); }
    this.isInitialized = false; this.userId = null; this.partnerId = null; this.isDeviceOnline = true; this.isServerReachable = true; this.lastPollAt = null;
    this.realtimeRetryCount = 0; this.isReconnecting = false; this.isRealtimeConnecting = false;
    if (this.realtimeRetryTimer) { clearTimeout(this.realtimeRetryTimer); this.realtimeRetryTimer = null; }
    this.sendingIds.clear();
  }
}

export const chatService = new ChatService();
