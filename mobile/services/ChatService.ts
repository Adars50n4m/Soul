import { supabase } from '../config/supabase';
import { SUPABASE_ENDPOINT, SERVER_URL } from '../config/api';
import { storageService } from './StorageService';
import { offlineService, type QueuedMessage, type MessageStatus } from './LocalDBService';
import { AppState, AppStateStatus } from 'react-native';
import { io, Socket } from 'socket.io-client';

export interface ChatMessage {
    id: string;
    sender_id: string;
    receiver_id: string;
    text: string;
    timestamp: string;
    status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
    media?: {
        type: 'image' | 'video' | 'audio' | 'file' | 'status_reply';
        url: string;
        name?: string;
        caption?: string;
    };
    reply_to?: string;
    reactions?: string[];
}

type MessageCallback = (message: ChatMessage) => void;
type StatusCallback = (messageId: string, status: ChatMessage['status'], newId?: string) => void;
type StatusUpdateCallback = (status: any) => void;
type StatusViewUpdateCallback = (statusId: string, viewerId: string) => void;
type NetworkStatusCallback = (isOnline: boolean) => void;

// Configuration for retry logic
const MAX_RETRY_COUNT = 5;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000; // 1 minute
const PROCESSING_INTERVAL_MS = 2000; // Check queue every 2 seconds

class ChatService {
    private socket: Socket | null = null;
    private userId: string | null = null;
    private partnerId: string | null = null;
    private onNewMessage: MessageCallback | null = null;
    private onStatusUpdate: StatusCallback | null = null;
    private onNewStatus: StatusUpdateCallback | null = null;
    private onStatusViewUpdate: StatusViewUpdateCallback | null = null;
    private onNetworkStatusChange: NetworkStatusCallback | null = null;
    private isInitialized: boolean = false;
    
    // Queue management
    private isProcessingQueue: boolean = false;
    private processQueueTimer: any = null;
    private retryTimers: Map<string, any> = new Map();
    private sendingIds: Set<string> = new Set();
    
    // Network status
    private isOnline: boolean = true;
    private networkListenerCleanup: (() => void) | null = null;

    /**
     * Initialize the chat service for a specific user pair
     */
    async initialize(
        userId: string,
        partnerId: string,
        onMessage: MessageCallback,
        onStatus: StatusCallback,
        onNewStatus?: StatusUpdateCallback,
        onStatusViewUpdate?: StatusViewUpdateCallback,
        onNetworkStatus?: NetworkStatusCallback
    ): Promise<void> {
        if (this.isInitialized && this.userId === userId && this.partnerId === partnerId) {
            return;
        }

        this.userId = userId;
        this.partnerId = partnerId;
        this.onNewMessage = onMessage;
        this.onStatusUpdate = onStatus;
        this.onNewStatus = onNewStatus ?? null;
        this.onStatusViewUpdate = onStatusViewUpdate ?? null;
        this.onNetworkStatusChange = onNetworkStatus ?? null;

        // Setup network listener
        this.setupNetworkListener();

        // Fetch missed messages from Supabase Ephemeral Table
        await this.fetchMissedMessages();

        // Connect to Node.js Socket.IO server
        if (!this.socket) {
            this.socket = io(SERVER_URL);

            this.socket.on('connect', () => {
                this.isInitialized = true;
                this.updateNetworkStatus(true);
                console.log('[ChatService] Connected to Socket.IO Server');
                
                // Identify the user to receive targeted messages
                this.socket?.emit('register', userId);
                this.startQueueProcessing();
            });

            this.socket.on('disconnect', () => {
                console.warn('[ChatService] Socket disconnected');
                this.updateNetworkStatus(false);
                this.stopQueueProcessing();
            });

            this.socket.on('message:receive', (msg: any) => {
                if (msg.receiver_id === this.userId && msg.sender_id === this.partnerId) {
                    console.log('[ChatService] Received new message for current chat:', msg);
                    this.onNewMessage?.(msg as ChatMessage);
                    
                    // Mark as delivered
                    this.socket?.emit('message:status', {
                        senderId: msg.sender_id,
                        messageId: msg.id,
                        status: 'delivered'
                    });
                    
                    this.updateMessageStatus(msg.id, 'delivered');
                }
            });

            this.socket.on('message:status_update', (data: any) => {
                // data = { senderId, messageId, status }
                if (data.senderId === this.userId) {
                    this.onStatusUpdate?.(data.messageId, data.status);
                    offlineService.updateMessageStatus(data.messageId, data.status);
                }
            });

            this.socket.on('status:new', (statusData: any) => {
                console.log('[ChatService] Received new status via socket:', statusData);
                this.onNewStatus?.(statusData);
            });

            this.socket.on('status:view_update', (data: { statusId: string, viewerId: string }) => {
                console.log('[ChatService] Received status view update:', data);
                this.onStatusViewUpdate?.(data.statusId, data.viewerId);
            });

            this.socket.on('user:online', (data: any) => {
                if (data.userId === this.partnerId) {
                    this.onNetworkStatusChange?.(data.isOnline);
                }
            });
        } else {
            // If reusing existing socket, just register again just in case
            this.socket.emit('register', userId);
            this.socket.emit('user:online', { userId, isOnline: true });
        }
    }

    /**
     * Setup network status listener
     */
    private async setupNetworkListener(): Promise<void> {
        // Initial check
        await this.checkConnectivity();

        // Listen for app state changes (foregrounding usually triggers network reconnections)
        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'active') {
                console.log('[ChatService] App foregrounded, checking connectivity...');
                this.checkConnectivity();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        // Fallback: Periodically check connectivity if needed
        const intervalId = setInterval(() => {
            this.checkConnectivity();
        }, 30000); // Every 30 seconds

        this.networkListenerCleanup = () => {
            subscription.remove();
            clearInterval(intervalId);
        };
    }

    /**
     * Check actual connectivity by pinging Supabase
     */
    private async checkConnectivity(): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

            await fetch(SUPABASE_ENDPOINT, { 
                method: 'GET', // GET is sometimes better for some proxies
                signal: controller.signal,
                mode: 'no-cors'
            });
            
            clearTimeout(timeoutId);
            this.updateNetworkStatus(true);
            this.startQueueProcessing();
            return true;
        } catch (error) {
            console.log('[ChatService] Connectivity check:', error);
            
            // Stay optimistic on timeout (AbortError) - it might just be slow/throttled
            if (error instanceof Error && error.name === 'AbortError') {
                this.updateNetworkStatus(true);
                return true;
            }

            this.updateNetworkStatus(false);
            this.stopQueueProcessing();
            return false;
        }
    }

    /**
     * Update internal network status and notify listeners
     */
    private updateNetworkStatus(online: boolean): void {
        const wasOnline = this.isOnline;
        this.isOnline = online;
        
        if (wasOnline !== online && this.onNetworkStatusChange) {
            this.onNetworkStatusChange(online);
        }
    }

    /**
     * Start processing the message queue
     */
    private startQueueProcessing(): void {
        if (this.isProcessingQueue || !this.isOnline) {
            return;
        }

        this.isProcessingQueue = true;
        console.log('[ChatService] Starting queue processing');
        
        // Process immediately
        this.processQueue();
        
        // Then set up periodic processing
        this.processQueueTimer = setInterval(() => {
            this.processQueue();
        }, PROCESSING_INTERVAL_MS);
    }

    /**
     * Stop processing the message queue
     */
    private stopQueueProcessing(): void {
        if (this.processQueueTimer) {
            clearInterval(this.processQueueTimer);
            this.processQueueTimer = null;
        }
        this.isProcessingQueue = false;
        
        // Clear all retry timers
        this.retryTimers.forEach((timer) => clearTimeout(timer));
        this.retryTimers.clear();
    }

    /**
     * Process pending messages in the queue
     */
    private async processQueue(): Promise<void> {
        if (!this.isOnline || this.isProcessingQueue === false) {
            return;
        }

        try {
            const pendingMessages = await offlineService.getPendingMessages();
            
            if (pendingMessages.length === 0) {
                return;
            }

            console.log(`[ChatService] Processing ${pendingMessages.length} pending message(s)`);

            for (const message of pendingMessages) {
                // Skip if already being retried or currently sending
                if (this.retryTimers.has(message.id) || this.sendingIds.has(message.id)) {
                    continue;
                }

                // Check if max retries exceeded
                if (message.retryCount >= MAX_RETRY_COUNT) {
                    console.warn(`[ChatService] Message ${message.id} exceeded max retries, marking as failed`);
                    await offlineService.markMessageAsFailed(
                        message.id,
                        `Failed after ${MAX_RETRY_COUNT} retry attempts`
                    );
                    continue;
                }

                // Attempt to send
                await this.sendQueuedMessageToServer(message);
            }
        } catch (error) {
            console.error('[ChatService] Error processing queue:', error);
        }
    }

    /**
     * Send a queued message via Socket.IO Server
     */
    private async sendQueuedMessageToServer(message: QueuedMessage): Promise<void> {
        if (!this.userId || !this.socket?.connected) return;
        if (this.sendingIds.has(message.id)) return;

        this.sendingIds.add(message.id);
        try {
            console.log(`[ChatService] Sending queued message ${message.id} to Server`);

            // 1. If message has media, upload to R2 first
            let uploadedMedia = message.media;
            if (message.media && message.media.url.startsWith('file://')) {
                const r2Key = await storageService.uploadImage(message.media.url, 'chat-media');
                if (!r2Key) throw new Error('Failed to upload media to R2');

                uploadedMedia = { ...message.media, url: r2Key };
            }

            const payload = {
                recipientId: message.chatId,
                message: {
                    id: message.id,
                    sender_id: this.userId,
                    receiver_id: message.chatId,
                    text: message.text,
                    timestamp: message.timestamp,
                    status: 'sent',
                    media: uploadedMedia,
                    reply_to: message.replyTo
                }
            };

            // 2. Emit via socket and wait for ack
            const response = await new Promise((resolve) => {
                this.socket?.emit('message:send', payload, (ack: any) => {
                    resolve(ack);
                });
                
                // timeout fallback
                setTimeout(() => resolve({ success: false, error: 'Ack timeout' }), 10000);
            }) as any;

            if (!response.success) {
                throw new Error(response.error || 'Server failed to acknowledge message');
            }

            console.log(`[ChatService] Message ${message.id} successfully synced to Server.`);
            
            // Success - update local status
            await offlineService.updateMessageStatus(message.id, 'sent');
            
            // Notify UI about the status change
            if (message.sender === 'me') {
                this.onStatusUpdate?.(message.id, 'sent');
            }

            // Clear any retry timer for this message
            if (this.retryTimers.has(message.id)) {
                clearTimeout(this.retryTimers.get(message.id)!);
                this.retryTimers.delete(message.id);
            }

        } catch (error: any) {
            console.warn(`[ChatService] Failed to send message ${message.id}:`, error);
            
            // Increment retry count
            const newRetryCount = message.retryCount + 1;
            await offlineService.updateMessageRetry(
                message.id,
                newRetryCount,
                error?.message || 'Network error'
            );

            if (newRetryCount < MAX_RETRY_COUNT) {
                // Schedule retry with exponential backoff
                const delay = Math.min(
                    INITIAL_RETRY_DELAY_MS * Math.pow(2, newRetryCount),
                    MAX_RETRY_DELAY_MS
                );
                
                console.log(`[ChatService] Scheduling retry for message ${message.id} in ${delay}ms`);
                
                const timer = setTimeout(() => {
                    this.retryTimers.delete(message.id);
                    this.processQueue();
                }, delay);
                
                this.retryTimers.set(message.id, timer);
            } else {
                // Max retries exceeded
                await offlineService.markMessageAsFailed(
                    message.id,
                    error?.message || 'Failed after maximum retries'
                );
                console.warn(`[ChatService] Message ${message.id} marked as failed after max retries`);
            }
        } finally {
            this.sendingIds.delete(message.id);
        }
    }

    /**
     * Fetch unread/missed messages from DB and deliver them to the UI
     */
    private async fetchMissedMessages() {
        if (!this.userId || !this.partnerId) return;

        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender.eq.${this.partnerId},receiver.eq.${this.userId}),and(sender.eq.${this.userId},receiver.eq.${this.partnerId})`)
            .order('created_at', { ascending: true })
            .limit(50);

        if (error) {
            console.warn('[ChatService] Error fetching missed messages:', error);
            return;
        }

        if (data && data.length > 0) {
            console.log(`[ChatService] Delivering ${data.length} missed message(s) to UI`);
            for (const row of data) {
                const msg = this.mapDbMessageToChatMessage(row);
                this.onNewMessage?.(msg);
            }
        }
    }

    /**
     * Send a message - Optimistic UI first, then sync to Supabase
     */
    async sendMessage(
        text: string,
        media?: ChatMessage['media'],
        replyTo?: string
    ): Promise<ChatMessage | null> {
        if (!this.userId || !this.partnerId) return null;

        const messageId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        const timestamp = new Date().toISOString();

        // Create optimistic message object
        const optimisticMessage: QueuedMessage = {
            id: messageId,
            chatId: this.partnerId,
            sender: 'me',
            text,
            timestamp,
            status: 'pending',
            media: media ? {
                type: media.type,
                url: media.url,
                name: media.name,
                caption: media.caption
            } : undefined,
            replyTo,
            retryCount: 0
        };

        // Step 1: Save to local DB with 'pending' status (Optimistic UI)
        await offlineService.savePendingMessage(this.partnerId, optimisticMessage);

        // Step 2: Notify UI immediately (message will appear with clock icon)
        const uiMessage: ChatMessage = {
            id: messageId,
            sender_id: this.userId,
            receiver_id: this.partnerId,
            text,
            timestamp,
            status: 'pending',
            media,
            reply_to: replyTo
        };
        
        this.onNewMessage?.(uiMessage);

        // Step 3: If online and socket connected, attempt to sync immediately
        if (this.isOnline && this.socket?.connected) {
            await this.sendQueuedMessageToServer(optimisticMessage);
        } else {
            console.log('[ChatService] Offline - message queued for later sync');
        }

        return uiMessage;
    }

    /**
     * Update message status (delivered/read) on server
     */
    async updateMessageStatus(messageId: string, status: 'delivered' | 'read'): Promise<void> {
        try {
            if (this.socket?.connected && this.partnerId) {
                this.socket.emit('message:status', {
                    senderId: this.partnerId,
                    messageId,
                    status
                });
            } else {
                // Fallback to supabase direct update if socket isn't ready
                await supabase
                    .from('messages')
                    .update({ status })
                    .eq('id', messageId);
            }
        } catch (e) {
            console.warn('Failed to update message status:', e);
        }
    }

    /**
     * Batch mark messages as read — called when user views the chat screen
     */
    async markMessagesAsRead(messageIds: string[]): Promise<void> {
        if (!messageIds.length) return;
        try {
            await supabase
                .from('messages')
                .update({ status: 'read' })
                .in('id', messageIds);
        } catch (e) {
            console.warn('Failed to batch mark messages as read:', e);
        }
    }

    /**
     * Retry a specific failed/pending message
     */
    async retryMessage(messageId: string): Promise<void> {
        const message = await offlineService.getMessageById(messageId);
        
        if (!message) {
            console.warn(`[ChatService] Message ${messageId} not found for retry`);
            return;
        }

        // Reset retry count for manual retry
        await offlineService.updateMessageRetry(messageId, 0);
        
        // Clear any existing retry timer
        if (this.retryTimers.has(messageId)) {
            clearTimeout(this.retryTimers.get(messageId)!);
            this.retryTimers.delete(messageId);
        }

        // If online and connected, send immediately
        if (this.isOnline && this.socket?.connected) {
            await this.sendQueuedMessageToServer(message);
        } else {
            console.log('[ChatService] Cannot retry - offline, message will be sent when online');
        }
    }

    /**
     * Get current network status
     */
    getNetworkStatus(): boolean {
        return this.isOnline;
    }

    /**
     * Get pending message count for a chat
     */
    async getPendingMessageCount(chatId: string): Promise<number> {
        const pendingMessages = await offlineService.getPendingMessages();
        return pendingMessages.filter(m => m.chatId === chatId).length;
    }

    /**
     * Map DB row to ChatMessage interface
     */
    private mapDbMessageToChatMessage(dbRow: any): ChatMessage {
        return {
            id: dbRow.id.toString(),
            sender_id: dbRow.sender,
            receiver_id: dbRow.receiver,
            text: dbRow.text,
            timestamp: dbRow.created_at,
            status: (dbRow.status as ChatMessage['status']) || 'sent',
            media: dbRow.media_url ? {
                type: dbRow.media_type || 'image',
                url: dbRow.media_url,
                caption: dbRow.media_caption
            } : undefined,
            reply_to: dbRow.reply_to_id?.toString(),
            reactions: dbRow.reaction ? [dbRow.reaction] : undefined
        };
    }

    /**
     * Clear all messages between users on the server
     */
    async clearServerMessages(userId: string, partnerId: string): Promise<void> {
        try {
            const { error } = await supabase
                .from('messages')
                .delete()
                .or(`and(sender.eq.${userId},receiver.eq.${partnerId}),and(sender.eq.${partnerId},receiver.eq.${userId})`);

            if (error) {
                console.warn('[ChatService] Error clearing server messages:', error);
                throw error;
            }
            console.log(`[ChatService] Successfully cleared messages between ${userId} and ${partnerId}`);
        } catch (e) {
            console.error('[ChatService] Exception in clearServerMessages:', e);
            throw e;
        }
    }

    /**
     * Cleanup
     */
    cleanup(): void {
        // Stop queue processing
        this.stopQueueProcessing();
        
        // Cleanup network listener
        if (this.networkListenerCleanup) {
            this.networkListenerCleanup();
            this.networkListenerCleanup = null;
        }

        // Cleanup socket connection
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        
        this.isInitialized = false;
        this.userId = null;
        this.partnerId = null;
        this.isOnline = true;
    }
}

export const chatService = new ChatService();
