import { getDB } from '../database';
import { Message, Contact } from '../types';

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type MediaStatus = 'not_downloaded' | 'downloading' | 'downloaded' | 'download_failed';

export interface QueuedMessage {
  id: string;
  chatId: string;
  sender: 'me' | 'them';
  text: string;
  timestamp: string;
  status: MessageStatus;
  media?: {
    type: 'image' | 'video' | 'audio' | 'file' | 'status_reply';
    url: string;
    name?: string;
    caption?: string;
  };
  replyTo?: string;
  retryCount: number;
  lastRetryAt?: string;
  errorMessage?: string;
  // Offline media support
  localFileUri?: string;
  mediaStatus?: MediaStatus;
  thumbnailUri?: string;
  fileSize?: number;
  mimeType?: string;
  reactions?: string[];
}

export interface MediaDownloadRecord {
  messageId: string;
  remoteUrl: string;
  localUri: string;
  fileSize?: number;
  downloadedAt: string;
}

export const offlineService = {
  // --- Messages ---
  async saveMessage(chatId: string, msg: Message, isUnsent: boolean = false) {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, chat_id, sender, text, media_type, media_url, media_caption, reply_to_id, timestamp, status, is_unsent, local_file_uri, media_status, thumbnail_uri, file_size, mime_type, reaction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        msg.id,
        chatId,
        msg.sender,
        msg.text,
        msg.media?.type ?? null,
        msg.media?.url ?? null,
        msg.media?.caption ?? null,
        msg.replyTo ?? null,
        msg.timestamp,
        msg.status ?? 'sent',
        isUnsent ? 1 : 0,
        msg.localFileUri ?? null,
        msg.mediaStatus ?? 'not_downloaded',
        msg.thumbnailUri ?? null,
        msg.fileSize ?? null,
        msg.mimeType ?? null,
        msg.reactions?.[0] ?? null
      ]
    );
  },

  /**
   * Save a message with pending status for offline-first queue
   */
  async savePendingMessage(chatId: string, msg: QueuedMessage): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, chat_id, sender, text, media_type, media_url, media_caption, reply_to_id, timestamp, status, is_unsent, retry_count, last_retry_at, error_message, reaction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?);`,
      [
        msg.id,
        chatId,
        msg.sender,
        msg.text,
        msg.media?.type ?? null,
        msg.media?.url ?? null,
        msg.media?.caption ?? null,
        msg.replyTo ?? null,
        msg.timestamp,
        'pending',
        msg.retryCount ?? 0,
        msg.lastRetryAt ?? null,
        msg.errorMessage ?? null,
        null // Queued messages usually don't originate with a reaction initially, but we supply null to match columns
      ]
    );
  },

  /**
   * Get all messages including pending ones
   */
  async getMessages(chatId: string): Promise<Message[]> {
    const db = await getDB();
    if (!db) return [];
    const rows = await db.getAllAsync(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC;`,
      [chatId]
    );

    return rows.map((row: any) => ({
      id: row.id,
      sender: row.sender as 'me' | 'them',
      text: row.text,
      timestamp: row.timestamp,
      status: row.status as MessageStatus,
      media: row.media_url ? {
        type: row.media_type as any,
        url: row.media_url,
        caption: row.media_caption
      } : undefined,
      replyTo: row.reply_to_id,
      reactions: row.reaction ? [row.reaction] : undefined
    }));
  },

  /**
   * Get all pending messages across all chats for queue processing
   */
  async getPendingMessages(): Promise<QueuedMessage[]> {
    const db = await getDB();
    if (!db) return [];
    try {
      const rows = await db.getAllAsync(
        `SELECT * FROM messages WHERE status = 'pending' ORDER BY timestamp ASC;`
      );

      return rows.map((row: any) => ({
        id: row.id,
        chatId: row.chat_id,
        sender: row.sender as 'me' | 'them',
        text: row.text,
        timestamp: row.timestamp,
        status: 'pending' as MessageStatus,
        media: row.media_url ? {
          type: row.media_type,
          url: row.media_url,
          caption: row.media_caption
        } : undefined,
        replyTo: row.reply_to_id,
        retryCount: row.retry_count ?? 0,
        lastRetryAt: row.last_retry_at,
        errorMessage: row.error_message
      }));
    } catch (e) {
      console.warn('[LocalDB] getPendingMessages failed (schema mismatch?):', e);
      return [];
    }
  },

  /**
   * Update message status after successful sync
   */
  async updateMessageStatus(messageId: string, status: MessageStatus): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET status = ?, is_unsent = 0 WHERE id = ?;`,
      [status, messageId]
    );
  },

  /**
   * Reconcile local optimistic ID with server-generated ID
   */
  async updateMessageId(oldId: string, newId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET id = ? WHERE id = ?;`,
      [newId, oldId]
    );
  },

  /**
   * Update retry count and last retry timestamp for a message
   */
  async updateMessageRetry(
    messageId: string,
    retryCount: number,
    errorMessage?: string
  ): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET retry_count = ?, last_retry_at = ?, error_message = ? WHERE id = ?;`,
      [retryCount, new Date().toISOString(), errorMessage ?? null, messageId]
    );
  },

  /**
   * Mark a message as failed after max retries
   */
  async markMessageAsFailed(messageId: string, errorMessage: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET status = 'failed', error_message = ?, is_unsent = 0 WHERE id = ?;`,
      [errorMessage, messageId]
    );
  },

  /**
   * Get a specific message by ID
   */
  async getMessageById(messageId: string): Promise<QueuedMessage | null> {
    const db = await getDB();
    if (!db) return null;
    const row = await db.getFirstAsync(
      `SELECT * FROM messages WHERE id = ?;`,
      [messageId]
    );

    if (!row) return null;

    return {
      id: row.id,
      chatId: row.chat_id,
      sender: row.sender as 'me' | 'them',
      text: row.text,
      timestamp: row.timestamp,
      status: row.status as MessageStatus,
      media: row.media_url ? {
        type: row.media_type,
        url: row.media_url,
        caption: row.media_caption
      } : undefined,
      replyTo: row.reply_to_id,
      retryCount: row.retry_count ?? 0,
      lastRetryAt: row.last_retry_at,
      errorMessage: row.error_message,
      reactions: row.reaction ? [row.reaction] : undefined
    };
  },

  /**
   * Update message reaction
   */
  async updateReaction(messageId: string, reaction: string | null): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET reaction = ? WHERE id = ?;`,
      [reaction, messageId]
    );
  },

  // --- Contacts ---
  async saveContact(contact: Contact) {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO contacts (id, name, avatar, bio, status, last_message, unread_count)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        contact.id, 
        contact.name, 
        contact.avatar, 
        contact.about ?? '', 
        contact.status ?? 'offline', 
        contact.lastMessage ?? '', 
        contact.unreadCount ?? 0
      ]
    );
  },

  async getContacts(): Promise<Contact[]> {
    const db = await getDB();
    if (!db) return [];
    const rows = await db.getAllAsync(`SELECT * FROM contacts;`);
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      about: row.bio,
      status: row.status as 'online' | 'offline',
      lastMessage: row.last_message,
      unreadCount: row.unread_count
    }));
  },

  // --- Sync Queue ---
  async addToSyncQueue(actionType: string, payload: any) {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT INTO sync_queue (action_type, payload) VALUES (?, ?);`,
      [actionType, JSON.stringify(payload)]
    );
  },

  async getSyncQueue() {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(`SELECT * FROM sync_queue ORDER BY created_at ASC;`);
  },

  async removeFromSyncQueue(id: number) {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(`DELETE FROM sync_queue WHERE id = ?;`, [id]);
  },

  // --- Offline Media Support ---
  
  /**
   * Update media status for a message (not_downloaded, downloading, downloaded, download_failed)
   */
  async updateMediaStatus(messageId: string, mediaStatus: MediaStatus): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET media_status = ? WHERE id = ?;`,
      [mediaStatus, messageId]
    );
  },

  /**
   * Update local file URI after successful download
   */
  async updateLocalFileUri(messageId: string, localFileUri: string, fileSize?: number): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET local_file_uri = ?, media_status = 'downloaded', file_size = ? WHERE id = ?;`,
      [localFileUri, fileSize ?? null, messageId]
    );
    
    // Also record in media_downloads table for tracking
    const msg = await this.getMessageById(messageId);
    if (msg?.media?.url) {
      await db.runAsync(
        `INSERT OR REPLACE INTO media_downloads (message_id, remote_url, local_uri, file_size)
         VALUES (?, ?, ?, ?);`,
        [messageId, msg.media.url, localFileUri, fileSize ?? null]
      );
    }
  },

  /**
   * Save thumbnail URI for a message (for preview before download)
   */
  async updateThumbnailUri(messageId: string, thumbnailUri: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE messages SET thumbnail_uri = ? WHERE id = ?;`,
      [thumbnailUri, messageId]
    );
  },

  /**
   * Get all messages with media that need to be downloaded
   */
  async getPendingMediaMessages(): Promise<QueuedMessage[]> {
    const db = await getDB();
    if (!db) return [];
    const rows = await db.getAllAsync(
      `SELECT * FROM messages WHERE media_url IS NOT NULL AND media_status = 'not_downloaded';`
    );
    return rows.map((row: any) => ({
      id: row.id,
      chatId: row.chat_id,
      sender: row.sender as 'me' | 'them',
      text: row.text,
      timestamp: row.timestamp,
      status: row.status as MessageStatus,
      media: row.media_url ? {
        type: row.media_type,
        url: row.media_url,
        caption: row.media_caption
      } : undefined,
      replyTo: row.reply_to_id,
      retryCount: row.retry_count ?? 0,
      lastRetryAt: row.last_retry_at,
      errorMessage: row.error_message,
      localFileUri: row.local_file_uri,
      mediaStatus: row.media_status as MediaStatus,
      thumbnailUri: row.thumbnail_uri,
      fileSize: row.file_size,
      mimeType: row.mime_type,
      reactions: row.reaction ? [row.reaction] : undefined
    }));
  },

  /**
   * Get all downloaded media records
   */
  async getDownloadedMedia(): Promise<MediaDownloadRecord[]> {
    const db = await getDB();
    if (!db) return [];
    const rows = await db.getAllAsync(`SELECT * FROM media_downloads;`);
    return rows.map((row: any) => ({
      messageId: row.message_id,
      remoteUrl: row.remote_url,
      localUri: row.local_uri,
      fileSize: row.file_size,
      downloadedAt: row.downloaded_at
    }));
  },

  /**
   * Delete local media file and update status
   */
  async deleteLocalMedia(messageId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    
    // Get the local URI first
    const row = await db.getFirstAsync(
      `SELECT local_file_uri FROM messages WHERE id = ?;`,
      [messageId]
    );
    
    if (row?.local_file_uri) {
      // Delete from media_downloads table
      await db.runAsync(`DELETE FROM media_downloads WHERE message_id = ?;`, [messageId]);
      // Update message status
      await db.runAsync(
        `UPDATE messages SET local_file_uri = NULL, media_status = 'not_downloaded' WHERE id = ?;`,
        [messageId]
      );
    }
  },

  /**
   * Delete a message entirely from local storage
   */
  async deleteMessage(messageId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    
    await db.runAsync(`DELETE FROM media_downloads WHERE message_id = ?;`, [messageId]);
    await db.runAsync(`DELETE FROM messages WHERE id = ?;`, [messageId]);
  },

  /**
   * Get storage stats for media management
   */
  async getMediaStorageStats(): Promise<{ totalFiles: number; totalSize: number }> {
    const db = await getDB();
    if (!db) return { totalFiles: 0, totalSize: 0 };
    
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size 
       FROM messages WHERE local_file_uri IS NOT NULL;`
    );
    
    return {
      totalFiles: row?.count ?? 0,
      totalSize: row?.total_size ?? 0
    };
  },

  /**
   * Save message with optimistic local URI (for sender)
   */
  async saveMessageWithLocalUri(chatId: string, msg: Message, localFileUri: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, chat_id, sender, text, media_type, media_url, media_caption, reply_to_id, timestamp, status, is_unsent, local_file_uri, media_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'downloaded');`,
      [
        msg.id,
        chatId,
        msg.sender,
        msg.text,
        msg.media?.type ?? null,
        msg.media?.url ?? null,
        msg.media?.caption ?? null,
        msg.replyTo ?? null,
        msg.timestamp,
        'pending',
        localFileUri
      ]
    );
  },

  /**
   * Clear all messages and media records for a chat
   */
  async clearChat(chatId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    
    // Delete all messages for this chat
    await db.runAsync(`DELETE FROM messages WHERE chat_id = ?;`, [chatId]);
    
    // Delete associated media records (if any records remain that aren't linked)
    // Actually, media_downloads are usually linked by message_id. 
    // We can't easily delete by chatId there without joining, so we'll just delete all
    // Or we can be precise if we wanted, but deleting messages is the priority.
    // Based on schema, media_downloads has message_id.
    await db.runAsync(`DELETE FROM media_downloads WHERE message_id NOT IN (SELECT id FROM messages);`);
  },

  // ============================================================
  // ── CHATS (local chat list) ─────────────────────────────────
  // ============================================================

  /**
   * Upsert a chat entry (create or update last message info)
   */
  async upsertChat(chat: {
    id: string;
    name?: string;
    type?: 'direct' | 'group';
    lastMessage?: string;
    lastMessageTime?: number;
    lastMessageType?: string;
    unreadCount?: number;
    avatarLocalPath?: string;
    avatarRemoteUrl?: string;
  }): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO chats
       (id, name, type, last_message, last_message_time, last_message_type, unread_count, avatar_local_path, avatar_remote_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        chat.id,
        chat.name ?? null,
        chat.type ?? 'direct',
        chat.lastMessage ?? null,
        chat.lastMessageTime ?? Date.now(),
        chat.lastMessageType ?? 'text',
        chat.unreadCount ?? 0,
        chat.avatarLocalPath ?? null,
        chat.avatarRemoteUrl ?? null,
        Date.now(),
      ]
    );
  },

  /**
   * Get all chats ordered by most recent
   */
  async getChats(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(
      `SELECT * FROM chats ORDER BY last_message_time DESC;`
    );
  },

  /**
   * Update unread count for a chat
   */
  async updateUnreadCount(chatId: string, count: number): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE chats SET unread_count = ? WHERE id = ?;`,
      [count, chatId]
    );
  },

  // ============================================================
  // ── BACKGROUND SYNC QUEUE (Offline Support) ─────────────────
  // ============================================================

  /**
   * Add a generic background sync action (e.g. 'UPLOAD_STATUS_MEDIA', 'SEND_MESSAGE')
   */
  async addSyncAction(action: 'UPLOAD_STATUS_MEDIA' | 'SEND_MESSAGE' | 'UPDATE_PROFILE', payload: any): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT INTO pending_sync (action, payload, created_at, retry_count) VALUES (?, ?, ?, 0);`,
      [action, JSON.stringify(payload), Date.now()]
    );
  },

  /**
   * Get all pending sync actions ordered by oldest first
   */
  async getPendingSyncActions(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    try {
      const rows = await db.getAllAsync(`SELECT * FROM pending_sync ORDER BY created_at ASC;`);
      return rows.map((r: any) => ({
        ...r,
        payload: JSON.parse(r.payload)
      }));
    } catch {
      return [];
    }
  },

  /**
   * Remove a completed sync action from the queue
   */
  async removeSyncAction(id: number): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(`DELETE FROM pending_sync WHERE id = ?;`, [id]);
  },

  /**
   * Increment retry count for a failed sync action
   */
  async incrementSyncRetry(id: number): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(`UPDATE pending_sync SET retry_count = retry_count + 1 WHERE id = ?;`, [id]);
  },

  // ============================================================
  // ── UNIFIED STATUSES (Task 1) ───────────────────────────────
  // ============================================================

  /**
   * Save a status (mine or received)
   */
  async saveStatus(status: {
    id: string;
    userId: string;
    type: 'image' | 'video' | 'text';
    r2Key?: string;
    localPath?: string;
    textContent?: string;
    backgroundColor?: string;
    viewers?: string[];
    createdAt: number;
    expiresAt: number;
    isMine: boolean;
  }): Promise<void> {
    const db = await getDB();
    if (!db) return;
    
    await db.runAsync(
      `INSERT OR REPLACE INTO statuses
       (id, user_id, r2_key, local_path, type, text_content, background_color, viewers, created_at, expires_at, is_mine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        status.id, 
        status.userId, 
        status.r2Key ?? null, 
        status.localPath ?? null, 
        status.type,
        status.textContent ?? null, 
        status.backgroundColor ?? null, 
        status.viewers ? JSON.stringify(status.viewers) : '[]',
        status.createdAt, 
        status.expiresAt,
        status.isMine ? 1 : 0
      ]
    );
  },

  /**
   * Mark a status as seen locally
   */
  async markStatusAsSeen(statusId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    
    // Check if current user is already in viewers
    // Simplified for local: we just want to know it's seen
    await db.runAsync(
      `UPDATE statuses SET is_seen = 1 WHERE id = ?;`,
      [statusId]
    );
  },

  /**
   * Get all active statuses
   */
  async getStatuses(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(
      `SELECT * FROM statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [Date.now()]
    );
  },

  /**
   * Delete a status manually
   */
  async deleteStatus(statusId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(`DELETE FROM statuses WHERE id = ?;`, [statusId]);
  },

  /**
   * Cleanup expired statuses (24hr TTL)
   */
  async cleanupExpiredStatuses(): Promise<{ deleted: number }> {
    const db = await getDB();
    if (!db) return { deleted: 0 };
    const now = Date.now();

    // Get expired media paths for file cleanup if needed
    const expiredMedia = await db.getAllAsync(
      `SELECT local_path FROM statuses WHERE expires_at < ? AND local_path IS NOT NULL;`,
      [now]
    );

    // Delete from table
    await db.runAsync(`DELETE FROM statuses WHERE expires_at < ?;`, [now]);

    return { deleted: expiredMedia.length };
  },

  // ============================================================
  // ── CACHED MEDIA ────────────────────────────────────────────
  // ============================================================

  /**
   * Get cached media by its R2 key (remote URL)
   */
  async getCachedMedia(r2Key: string): Promise<string | null> {
    const db = await getDB();
    if (!db) return null;
    const result = await db.getFirstAsync(
      `SELECT local_path FROM cached_media WHERE r2_key = ?;`,
      [r2Key]
    ) as { local_path: string } | null;
    if (result) {
      await db.runAsync(
        `UPDATE cached_media SET last_accessed = ? WHERE r2_key = ?;`,
        [Date.now(), r2Key]
      );
      return result.local_path;
    }
    return null;
  },

  /**
   * Save a newly downloaded remote media file to the cache tracking table
   */
  async saveCachedMedia(r2Key: string, localPath: string, messageId?: string, sizeBytes?: number): Promise<void> {
    const db = await getDB();
    if (!db) return;
    const now = Date.now();
    await db.runAsync(
      `INSERT OR REPLACE INTO cached_media (r2_key, local_path, message_id, size_bytes, cached_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [r2Key, localPath, messageId || null, sizeBytes || null, now, now]
    );
  }
};
