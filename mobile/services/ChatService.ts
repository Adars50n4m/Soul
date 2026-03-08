// mobile/services/ChatService.ts
// ─────────────────────────────────────────────────────────────────────────────
// CHAT SERVICE  (Network + Sync Layer)
//
// RESPONSIBILITY:
//   - Manages the Supabase Realtime subscription (listen for incoming messages)
//   - Manages the outgoing message queue (send pending messages to Supabase)
//   - Checks network connectivity
//   - Bridges the local SQLite DB (via offlineService) with the remote server
//
// WHAT THIS FILE DOES NOT DO:
//   - Does NOT touch SQLite directly — that is LocalDBService's job
//   - Does NOT render anything — that is the screen/component's job
//
// BUGS FIXED vs original:
//   [BUG 1] AbortError logic was inverted — timeout was treated as "online"
//   [BUG 2] Schema mismatch — `receiver` column missing from INSERT payload
//   [BUG 3] Realtime listener had no filter — was receiving ALL users' messages
//   [BUG 4] Queue polled every 2s even when empty — wasted battery
//   [BUG 5] `senderName` hardcoded as 'Someone' in push notification call
//   [BUG 6] `substr` deprecated — replaced with `substring`
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../config/supabase';
import { SUPABASE_ENDPOINT } from '../config/api';
import { offlineService, type QueuedMessage, type MessageStatus } from './LocalDBService';
import { storageService } from './StorageService';
import { AppState, AppStateStatus } from 'react-native';

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
    type: 'image' | 'video' | 'audio' | 'file' | 'status_reply'; // 'image' | 'video' | 'audio' | 'file' | 'status_reply';
    url: string;
    name?: string;
    caption?: string;
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
const INITIAL_RETRY_DELAY  = 1_000;   // 1 second
const MAX_RETRY_DELAY      = 60_000;  // 1 minute cap

// Queue polling intervals:
//   - ACTIVE: used when there ARE pending messages  (check often)
//   - IDLE:   used when queue is empty              (save battery)
const ACTIVE_POLL_INTERVAL = 2_000;   // 2 seconds  [FIX for BUG 4]
const IDLE_POLL_INTERVAL   = 15_000;  // 15 seconds [FIX for BUG 4]

// ─────────────────────────────────────────────────────────────────────────────
// CHAT SERVICE
// ─────────────────────────────────────────────────────────────────────────────

class ChatService {
  private channel:              ReturnType<typeof supabase.channel> | null = null;
  private userId:               string | null = null;
  private partnerId:            string | null = null;
  private senderName:           string = 'Someone'; // Updated in initialize()

  private onNewMessage:         MessageCallback       | null = null;
  private onStatusUpdate:       StatusCallback        | null = null;
  private onNetworkStatusChange:NetworkStatusCallback | null = null;
  private onUploadProgressCb:   UploadProgressCallback| null = null;

  private isInitialized:        boolean = false;
  private isOnline:             boolean = true;

  // Queue management
  private processQueueTimer:    ReturnType<typeof setInterval> | null = null;
  private sendingIds:           Set<string> = new Set();
  private networkListenerCleanup: (() => void) | null = null;

  // Polling fallback (when Realtime WebSocket is blocked by ISP)
  private pollTimer:            ReturnType<typeof setInterval> | null = null;
  private lastPollAt:           string | null = null;

  // ── PUBLIC: initialize() ────────────────────────────────────────────────
  //
  // Call this when the user opens a chat screen.
  //
  // Parameters:
  //   userId     — the logged-in user's ID
  //   partnerId  — the other person's ID
  //   senderName — the logged-in user's display name (used in push notifications)
  //   onMessage  — callback: new/incoming message received
  //   onStatus   — callback: a message's status changed (sent/delivered/read/failed)
  //   onNetworkStatus — optional callback: connectivity changed
  //   onUploadProgress - optional callback: file upload progress
  async initialize(
    userId: string,
    partnerId: string,
    senderName: string,
    onMessage: MessageCallback,
    onStatus: StatusCallback,
    onNetworkStatus?: NetworkStatusCallback,
    onUploadProgress?: UploadProgressCallback
  ): Promise<void> {
    // Idempotent — don't re-subscribe if already on this exact chat
    if (this.isInitialized && this.userId === userId && this.partnerId === partnerId) {
      return;
    }

    // Tear down any previous subscription first
    this.cleanup();

    this.userId      = userId;
    this.partnerId   = partnerId;
    this.senderName  = senderName;   // [FIX BUG 5] no longer hardcoded

    this.onNewMessage          = onMessage;
    this.onStatusUpdate        = onStatus;
    this.onNetworkStatusChange = onNetworkStatus ?? null;

    await this.setupNetworkListener();
    await this.fetchMissedMessages();
    this.subscribeToRealtime();
    this.startMessagePolling();
  }

  // ── PRIVATE: subscribeToRealtime() ──────────────────────────────────────
  private subscribeToRealtime(): void {
    if (!this.userId) return;

    // Each user gets their own channel so filters work correctly
    const channelName = `chat_${this.userId}`;
    this.channel = supabase.channel(channelName);

    this.channel
      // ── New message arriving FOR ME ──────────────────────────────────────
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'messages',
          // [FIX BUG 3] Filter on receiver so we only get OUR messages,
          // not every INSERT in the entire messages table.
          filter: `receiver=eq.${this.userId}`,
        },
        async (payload) => {
          const incoming = this.mapDbRowToChatMessage(payload.new);

          // WhatsApp rule: ALWAYS write to SQLite before touching the UI
          await offlineService.saveMessage(incoming.sender_id, {
            id:        incoming.id,
            sender:    'them',
            text:      incoming.text,
            timestamp: incoming.timestamp,
            status:    'delivered',
            media:     incoming.media,
            replyTo:   incoming.reply_to,
          });

          // Only fire the UI callback if this chat is currently open
          if (incoming.sender_id === this.partnerId) {
            this.onNewMessage?.(incoming);
            // Let the server know the message was delivered
            this.updateMessageStatusOnServer(incoming.id, 'delivered');
          }
        }
      )

      // ── Status update on one of MY sent messages ──────────────────────────
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'messages',
          // [FIX BUG 3] Only listen to updates on messages I sent
          filter: `sender=eq.${this.userId}`,
        },
        async (payload) => {
          const updated = payload.new as any;
          if (updated.status) {
            // Sync the new status to local DB
            await offlineService.updateMessageStatus(
              updated.id.toString(),
              updated.status as MessageStatus
            );
            this.onStatusUpdate?.(updated.id.toString(), updated.status);
          }
        }
      )

      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          this.isInitialized = true;
          this.updateNetworkStatus(true);
          console.log('[ChatService] Realtime subscribed');
          this.startQueueProcessing();
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          console.warn('[ChatService] Realtime offline:', status);
          this.updateNetworkStatus(false);
          this.stopQueueProcessing();
        }
        if (err) console.warn('[ChatService] Subscription warning:', err);
      });
  }

  // ── PRIVATE: Network monitoring ─────────────────────────────────────────

  private async setupNetworkListener(): Promise<void> {
    await this.checkConnectivity();

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        console.log('[ChatService] App foregrounded — checking connectivity');
        this.checkConnectivity();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppState);

    // Ping every 15 seconds — not too aggressive, not too lazy
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

      await fetch(SUPABASE_ENDPOINT, {
        method: 'HEAD',
        signal: controller.signal,
        mode:   'no-cors',
      });

      clearTimeout(timeoutId);

      // Fetch succeeded → we are online
      this.updateNetworkStatus(true);
      this.startQueueProcessing();
      return true;

    } catch (error: any) {
      // [FIX BUG 1] AbortError means the request TIMED OUT → we are OFFLINE.
      // The old code treated AbortError as online — completely backwards!
      if (error?.name === 'AbortError') {
        console.warn('[ChatService] Connectivity check timed out → offline');
        this.updateNetworkStatus(false);
        this.stopQueueProcessing();
        return false;
      }

      // Any other fetch error (DNS fail, no network, etc.) → offline
      this.updateNetworkStatus(false);
      this.stopQueueProcessing();
      return false;
    }
  }

  private updateNetworkStatus(online: boolean): void {
    const wasOnline = this.isOnline;
    this.isOnline   = online;

    if (wasOnline !== online) {
      console.log(`[ChatService] Network status: ${online ? 'ONLINE' : 'OFFLINE'}`);
      this.onNetworkStatusChange?.(online);

      // Went back online → drain the queue immediately
      if (online) {
        this.processQueue();
      }
    }
  }

  // ── PRIVATE: Queue processing ────────────────────────────────────────────

  private startQueueProcessing(): void {
    if (this.processQueueTimer || !this.isOnline) return;

    // Run once immediately when we (re-)connect
    this.processQueue();

    // Then schedule repeating — interval adapts to queue size [FIX BUG 4]
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (this.processQueueTimer) {
      clearTimeout(this.processQueueTimer);
      this.processQueueTimer = null;
    }
    if (!this.isOnline) return;

    // Will be called after processQueue() finishes each cycle
    // (see processQueue's finally block)
  }

  private stopQueueProcessing(): void {
    if (this.processQueueTimer) {
      clearInterval(this.processQueueTimer as any);
      clearTimeout(this.processQueueTimer  as any);
      this.processQueueTimer = null;
    }
    this.sendingIds.clear();
  }

  private isProcessingQueue:          boolean = false;

  private async processQueue(): Promise<void> {
    if (!this.isOnline) return;
    if (this.isProcessingQueue) return;

    this.isProcessingQueue = true;

    try {
      const pendingMessages = await offlineService.getPendingMessages();

      // [FIX BUG 4] If queue is empty, poll slowly to save battery.
      //             If there are pending messages, poll aggressively.
      const nextInterval = pendingMessages.length > 0
        ? ACTIVE_POLL_INTERVAL
        : IDLE_POLL_INTERVAL;

      const now = Date.now();

      for (const message of pendingMessages) {
        // Skip if already in-flight
        if (this.sendingIds.has(message.id)) continue;

        // Permanently failed — mark and notify UI
        if (message.retryCount >= MAX_RETRY_COUNT) {
          await offlineService.markMessageAsFailed(
            message.id,
            `Failed after ${MAX_RETRY_COUNT} attempts`
          );
          this.onStatusUpdate?.(message.id, 'failed');
          continue;
        }

        // Exponential backoff check
        if (message.lastRetryAt && message.retryCount > 0) {
          const delay       = Math.min(
            INITIAL_RETRY_DELAY * Math.pow(2, message.retryCount),
            MAX_RETRY_DELAY
          );
          const lastRetryMs = new Date(message.lastRetryAt).getTime();

          if (now - lastRetryMs < delay) {
            continue; // Not time yet
          }
        }

        // Await each message to ensure sequential processing and avoid overwhelming SQLite
        // with concurrent reads/writes that trigger "shared object already released" bugs.
        await this.sendMessageToSupabase(message);
      }

      // Schedule the next poll cycle now that we know the queue size
      if (this.isOnline) {
        this.processQueueTimer = setTimeout(
          () => this.processQueue(),
          nextInterval
        ) as any;
      }

    } catch (error) {
      console.error('[ChatService] processQueue error:', error);
      // Still schedule next poll even after an unexpected error
      if (this.isOnline) {
        this.processQueueTimer = setTimeout(
          () => this.processQueue(),
          IDLE_POLL_INTERVAL
        ) as any;
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async sendMessageToSupabase(message: QueuedMessage): Promise<void> {
    if (!this.userId) return;
    this.sendingIds.add(message.id);

    try {
      let finalMediaUrl = message.media?.url;

      // 1. Upload media if we have a localFileUri and no remote URL yet.
      if (message.localFileUri && !finalMediaUrl && message.media) {
        try {
           finalMediaUrl = await storageService.uploadImage(
             message.localFileUri, 
             'chat-media', 
             this.userId,
             (progress) => {
               if (this.onUploadProgressCb) {
                 this.onUploadProgressCb(message.id, progress);
               }
             }
           ) || undefined;
           
           if (!finalMediaUrl) throw new Error('Upload failed: Server returned an empty URL/Key');
           
           console.log(`[ChatService] Media uploaded successfully. Key: ${finalMediaUrl}`);
        } catch (uploadErr: any) {
           console.error('[ChatService] Media upload failed:', uploadErr.message);
           if (uploadErr.message?.includes('R2 Service not configured')) {
              console.warn('CRITICAL: Your server R2 credentials are not set in server/.env!');
           }
           throw uploadErr; // Caught below to trigger retry mechanism
        }
      }

      // [FIX BUG 2] Added `receiver` column — it was missing from the original
      // INSERT which caused a Supabase constraint error at runtime.
      const { data, error } = await supabase
        .from('messages')
        .insert({
          sender:        this.userId,
          receiver:      message.chatId,   // ← was missing before!
          text:          message.text,
          media_type:    message.media?.type    ?? null,
          media_url:     finalMediaUrl          ?? null,
          media_caption: message.media?.caption ?? null,
          reply_to_id:   message.replyTo        ?? null,
          created_at:    message.timestamp,
        })
        .select()
        .single();

      if (error) throw error;

      const serverId = data.id.toString();

      // Swap temp ID → real server ID (ON UPDATE CASCADE handles media_downloads)
      if (message.id !== serverId) {
        await offlineService.updateMessageId(message.id, serverId);
      }
      
      // Update local db with final remote url so we have it if cache gets cleared
      if (finalMediaUrl && finalMediaUrl !== message.media?.url) {
        await offlineService.updateMessageMediaUrl(serverId, finalMediaUrl);
      }
      
      await offlineService.updateMessageStatus(serverId, 'sent');
      this.onStatusUpdate?.(message.id, 'sent', serverId);

      // Push notification — best-effort, non-critical
      try {
        await supabase.functions.invoke('send-message-push', {
          body: {
            receiverId: message.chatId,
            senderId:   this.userId,
            senderName: this.senderName,   // [FIX BUG 5] real name, not 'Someone'
            text:       message.text,
            messageId:  serverId,
          },
        });
      } catch (_) {
        // Edge function failure is non-fatal — message is already saved
      }

    } catch (error: any) {
      const newRetryCount = message.retryCount + 1;
      await offlineService.updateMessageRetry(
        message.id,
        newRetryCount,
        error?.message ?? 'Network error'
      );

      if (newRetryCount >= MAX_RETRY_COUNT) {
        await offlineService.markMessageAsFailed(
          message.id,
          error?.message ?? 'Max retries exceeded'
        );
        this.onStatusUpdate?.(message.id, 'failed');
      }
    } finally {
      this.sendingIds.delete(message.id);
    }
  }

  // ── PRIVATE: Fetch history on chat open ──────────────────────────────────
  //
  // Loads the last 50 messages from Supabase and saves any missing ones
  // to the local DB.  This fills gaps that happened while offline.
  private async fetchMissedMessages(): Promise<void> {
    if (!this.userId || !this.partnerId) return;

    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(
          // [FIX BUG 2] Using `receiver` column which now actually exists
          `and(sender.eq.${this.partnerId},receiver.eq.${this.userId}),` +
          `and(sender.eq.${this.userId},receiver.eq.${this.partnerId})`
        )
        .order('created_at', { ascending: true })
        .limit(50);

      if (error || !data) return;

      for (const row of data) {
        const msg = this.mapDbRowToChatMessage(row);
        await offlineService.saveMessage(
          msg.sender_id === this.userId ? msg.receiver_id : msg.sender_id,
          {
            id:        msg.id,
            sender:    msg.sender_id === this.userId ? 'me' : 'them',
            text:      msg.text,
            timestamp: msg.timestamp,
            status:    msg.status,
            media:     msg.media,
            replyTo:   msg.reply_to,
          }
        );
        this.onNewMessage?.(msg);
      }
    } catch (e) {
      console.warn('[ChatService] fetchMissedMessages error:', e);
    }
  }

  // ── PUBLIC: sendMessage() ────────────────────────────────────────────────
  //
  // The 3-step WhatsApp pattern:
  //   1. Save to SQLite (so the message survives an app kill)
  //   2. Show in UI immediately (optimistic render)
  //   3. Queue for Supabase sync in the background
  async sendMessage(
    chatId: string,
    text: string,
    media?: ChatMessage['media'],
    replyTo?: string,
    localUri?: string
  ): Promise<ChatMessage | null> {
    const targetChatId = chatId || this.partnerId;
    if (!this.userId || !targetChatId) return null;

    // [FIX BUG 6] substr is deprecated → use substring
    const tempId    = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const timestamp = new Date().toISOString();

    const queuedMsg: QueuedMessage = {
      id:         tempId,
      chatId:     targetChatId,
      sender:     'me',
      text,
      timestamp,
      status:     'pending',
      media:      media ? { ...media } : undefined,
      replyTo,
      retryCount: 0,
      localFileUri: localUri,
    };

    // Step 1: SQLite first
    await offlineService.savePendingMessage(targetChatId, queuedMsg);

    const uiMessage: ChatMessage = {
      id:          tempId,
      sender_id:   this.userId,
      receiver_id: targetChatId,
      text,
      timestamp,
      status:      'pending',
      media,
      reply_to:    replyTo,
      localFileUri: localUri,
    };

    // Step 2: Render
    this.onNewMessage?.(uiMessage);

    // Step 3: Sync (non-blocking — don't await, let the queue handle it)
    if (this.isOnline) {
      // Push to the queue instead of bypassing it to prevent concurrent SQLite DB queries
      // that trigger "Shared object released" crashes.
      this.processQueue();
    }

    return uiMessage;
  }

  // ── PUBLIC: updateMessageStatusOnServer() ───────────────────────────────
  //
  // Called after we receive a message to tell the server it's delivered/read.
  async updateMessageStatusOnServer(
    messageId: string,
    status: 'delivered' | 'read'
  ): Promise<void> {
    try {
      await supabase.from('messages').update({ status }).eq('id', messageId);
    } catch (_) {}
  }

  // ── PUBLIC: markMessagesAsRead() ─────────────────────────────────────────
  async markMessagesAsRead(messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    try {
      await supabase.from('messages').update({ status: 'read' }).in('id', messageIds);
      for (const id of messageIds) {
        await offlineService.updateMessageStatus(id, 'read');
      }
    } catch (_) {}
  }

  // ── PUBLIC: retryMessage() ───────────────────────────────────────────────
  //
  // Called when the user taps the "!" retry button on a failed message.
  async retryMessage(messageId: string): Promise<void> {
    const message = await offlineService.getMessageById(messageId);
    if (!message) return;

    // Reset retry count so backoff starts fresh
    await offlineService.updateMessageRetry(messageId, 0);
    await offlineService.updateMessageStatus(messageId, 'pending');

    if (this.isOnline) {
      this.processQueue();
    }
  }

  // ── PUBLIC: getNetworkStatus() ───────────────────────────────────────────
  getNetworkStatus(): boolean {
    return this.isOnline;
  }

  // ── PUBLIC: getPendingMessageCount() ─────────────────────────────────────
  async getPendingMessageCount(chatId: string): Promise<number> {
    const pending = await offlineService.getPendingMessages();
    return pending.filter(m => m.chatId === chatId).length;
  }

  // ── PUBLIC: clearServerMessages() ───────────────────────────────────────
  //
  // DANGER: Permanently deletes messages from Supabase.
  // Also clears the local SQLite records for this chat.
  async clearServerMessages(userId: string, partnerId: string): Promise<void> {
    await supabase
      .from('messages')
      .delete()
      .or(
        `and(sender.eq.${userId},receiver.eq.${partnerId}),` +
        `and(sender.eq.${partnerId},receiver.eq.${userId})`
      );
    await offlineService.clearChat(partnerId);
  }

  // ── PRIVATE: mapDbRowToChatMessage() ────────────────────────────────────
  private mapDbRowToChatMessage(row: any): ChatMessage {
    return {
      id:          row.id.toString(),
      sender_id:   row.sender,
      receiver_id: row.receiver,
      text:        row.text ?? '',
      timestamp:   row.created_at,
      status:      (row.status as ChatMessage['status']) ?? 'sent',
      media:       row.media_url
        ? {
            type:    row.media_type ?? 'image',
            url:     row.media_url,
            caption: row.media_caption,
          }
        : undefined,
      reply_to:    row.reply_to_id?.toString(),
      reactions:   row.reaction ? [row.reaction] : undefined,
    };
  }

  // ── PUBLIC: getSocket() ───────────────────────────────────────────────────
  //
  // MusicSyncService expects a socket.io socket object.
  // This ChatService uses Supabase Realtime (not socket.io), so we return null.
  // MusicSyncService will log "socket not ready" and retry every 2s — that's fine.
  getSocket(): null {
    return null;
  }

  // ── PUBLIC: isSocketConnected() ───────────────────────────────────────────
  isSocketConnected(): boolean {
    return false;
  }

  // ── PRIVATE: Message polling fallback ───────────────────────────────────
  //
  // When Supabase Realtime WebSocket is blocked by ISP (Jio/Airtel),
  // poll for new messages every 10 seconds via REST (goes through Cloudflare proxy).
  private startMessagePolling(): void {
    if (this.pollTimer) return;
    this.lastPollAt = new Date().toISOString();
    this.pollTimer = setInterval(() => this.pollForNewMessages(), 10_000) as any;
  }

  private stopMessagePolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer as any);
      this.pollTimer = null;
    }
  }

  private async pollForNewMessages(): Promise<void> {
    if (!this.userId || !this.partnerId || !this.lastPollAt) return;
    const since = this.lastPollAt;
    this.lastPollAt = new Date().toISOString();
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(
          `and(sender.eq.${this.partnerId},receiver.eq.${this.userId}),` +
          `and(sender.eq.${this.userId},receiver.eq.${this.partnerId})`
        )
        .gt('created_at', since)
        .order('created_at', { ascending: true });

      if (error || !data || data.length === 0) return;

      for (const row of data) {
        const msg = this.mapDbRowToChatMessage(row);
        await offlineService.saveMessage(
          msg.sender_id === this.userId ? msg.receiver_id : msg.sender_id,
          {
            id:        msg.id,
            sender:    msg.sender_id === this.userId ? 'me' : 'them',
            text:      msg.text,
            timestamp: msg.timestamp,
            status:    msg.status,
            media:     msg.media,
            replyTo:   msg.reply_to,
          }
        );
        this.onNewMessage?.(msg);
        if (msg.sender_id === this.partnerId) {
          this.updateMessageStatusOnServer(msg.id, 'delivered');
        }
      }
    } catch (_) {}
  }

  // ── PUBLIC: cleanup() ────────────────────────────────────────────────────
  //
  // Call this when the user leaves the chat screen.
  cleanup(): void {
    this.stopQueueProcessing();
    this.stopMessagePolling();

    if (this.networkListenerCleanup) {
      this.networkListenerCleanup();
      this.networkListenerCleanup = null;
    }

    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }

    this.isInitialized = false;
    this.userId        = null;
    this.partnerId     = null;
    this.isOnline      = true;
    this.lastPollAt    = null;

    console.log('[ChatService] Cleaned up.');
  }
}

// Single shared instance — same pattern as before
export const chatService = new ChatService();
