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
      `INSERT OR REPLACE INTO messages (id, chat_id, sender, text, media_type, media_url, media_caption, reply_to_id, timestamp, status, is_unsent, local_file_uri, media_status, thumbnail_uri, file_size, mime_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
        msg.mimeType ?? null
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
      `INSERT OR REPLACE INTO messages (id, chat_id, sender, text, media_type, media_url, media_caption, reply_to_id, timestamp, status, is_unsent, retry_count, last_retry_at, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?);`,
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
        msg.errorMessage ?? null
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
      replyTo: row.reply_to_id
    }));
  },

  /**
   * Get all pending messages across all chats for queue processing
   */
  async getPendingMessages(): Promise<QueuedMessage[]> {
    const db = await getDB();
    if (!db) return [];
    const rows = await db.getAllAsync(
      `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC;`
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
      errorMessage: row.error_message
    };
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
      mimeType: row.mime_type
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
  // ── UPLOAD QUEUE (media upload queue for offline) ───────────
  // ============================================================

  /**
   * Add a media file to the upload queue
   */
  async addToUploadQueue(item: {
    id: string;
    messageId: string;
    localPath: string;
    remotePath?: string;
  }): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO upload_queue
       (id, message_id, local_path, remote_path, status, retry_count, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?);`,
      [item.id, item.messageId, item.localPath, item.remotePath ?? null, Date.now()]
    );
  },

  /**
   * Get all pending uploads
   */
  async getPendingUploads(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(
      `SELECT * FROM upload_queue WHERE status = 'pending' OR status = 'failed' ORDER BY created_at ASC;`
    );
  },

  /**
   * Update upload status
   */
  async markUploadStatus(id: string, status: 'pending' | 'uploading' | 'done' | 'failed'): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE upload_queue SET status = ?, last_tried_at = ? WHERE id = ?;`,
      [status, Date.now(), id]
    );
  },

  /**
   * Increment retry count for a failed upload
   */
  async incrementUploadRetry(id: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE upload_queue SET retry_count = retry_count + 1, last_tried_at = ? WHERE id = ?;`,
      [Date.now(), id]
    );
  },

  /**
   * Remove completed uploads from queue
   */
  async cleanUploadQueue(): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(`DELETE FROM upload_queue WHERE status = 'done';`);
  },

  // ============================================================
  // ── MY STATUSES ─────────────────────────────────────────────
  // ============================================================

  /**
   * Save a status I posted
   */
  async saveMyStatus(status: {
    id: string;
    type: 'image' | 'video';
    mediaLocalPath: string;
    mediaRemoteUrl?: string;
    thumbnailPath?: string;
    caption?: string;
  }): Promise<void> {
    const db = await getDB();
    if (!db) return;
    const now = Date.now();
    const expiresAt = now + 86400000; // 24 hours
    await db.runAsync(
      `INSERT OR REPLACE INTO my_statuses
       (id, type, media_local_path, media_remote_url, thumbnail_path, caption, synced, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?);`,
      [
        status.id, status.type, status.mediaLocalPath,
        status.mediaRemoteUrl ?? null, status.thumbnailPath ?? null,
        status.caption ?? null, now, expiresAt,
      ]
    );
  },

  /**
   * Get all my non-expired statuses
   */
  async getMyStatuses(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(
      `SELECT * FROM my_statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [Date.now()]
    );
  },

  /**
   * Mark a status as synced to server
   */
  async markMyStatusSynced(statusId: string, remoteUrl: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE my_statuses SET synced = 1, media_remote_url = ? WHERE id = ?;`,
      [remoteUrl, statusId]
    );
  },

  // ============================================================
  // ── RECEIVED STATUSES ───────────────────────────────────────
  // ============================================================

  /**
   * Save a status received from a contact
   */
  async saveReceivedStatus(status: {
    id: string;
    userId: string;
    userName?: string;
    userAvatarPath?: string;
    type: 'image' | 'video';
    mediaLocalPath?: string;
    mediaRemoteUrl: string;
    thumbnailPath?: string;
    caption?: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `INSERT OR REPLACE INTO received_statuses
       (id, user_id, user_name, user_avatar_path, type, media_local_path,
        media_remote_url, thumbnail_path, caption, media_download_status,
        synced, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?);`,
      [
        status.id, status.userId, status.userName ?? null,
        status.userAvatarPath ?? null, status.type,
        status.mediaLocalPath ?? null, status.mediaRemoteUrl,
        status.thumbnailPath ?? null, status.caption ?? null,
        status.createdAt, status.expiresAt,
      ]
    );
  },

  /**
   * Get all non-expired received statuses grouped by user
   */
  async getReceivedStatuses(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(
      `SELECT * FROM received_statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [Date.now()]
    );
  },

  /**
   * Mark a received status as viewed
   */
  async markStatusViewed(statusId: string): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.runAsync(
      `UPDATE received_statuses SET is_viewed = 1, viewed_at = ? WHERE id = ?;`,
      [Date.now(), statusId]
    );
  },

  // ============================================================
  // ── TEXT STATUSES ───────────────────────────────────────────
  // ============================================================

  /**
   * Save a text status (mine or received)
   */
  async saveTextStatus(status: {
    id: string;
    userId: string;
    userName?: string;
    userAvatarPath?: string;
    textContent: string;
    bgType?: 'solid' | 'gradient';
    bgColor?: string;
    bgGradient?: string[];
    textColor?: string;
    fontSize?: number;
    fontStyle?: string;
    textAlign?: string;
    isMine: boolean;
  }): Promise<void> {
    const db = await getDB();
    if (!db) return;
    const now = Date.now();
    const expiresAt = now + 86400000; // 24 hours
    await db.runAsync(
      `INSERT OR REPLACE INTO text_statuses
       (id, user_id, user_name, user_avatar_path, text_content, bg_type, bg_color,
        bg_gradient, text_color, font_size, font_style, text_align,
        is_mine, synced, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?);`,
      [
        status.id, status.userId, status.userName ?? null,
        status.userAvatarPath ?? null, status.textContent,
        status.bgType ?? 'solid', status.bgColor ?? '#2D6A4F',
        status.bgGradient ? JSON.stringify(status.bgGradient) : null,
        status.textColor ?? '#FFFFFF', status.fontSize ?? 24,
        status.fontStyle ?? 'normal', status.textAlign ?? 'center',
        status.isMine ? 1 : 0, now, expiresAt,
      ]
    );
  },

  /**
   * Get all non-expired text statuses
   */
  async getTextStatuses(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    return await db.getAllAsync(
      `SELECT * FROM text_statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [Date.now()]
    );
  },

  // ============================================================
  // ── COMBINED STATUS FEED ────────────────────────────────────
  // ============================================================

  /**
   * Get all statuses (text + media) merged and grouped by user
   */
  async getAllStatuses(): Promise<any[]> {
    const db = await getDB();
    if (!db) return [];
    const now = Date.now();

    const textStatuses = await db.getAllAsync(
      `SELECT *, 'text' as status_type FROM text_statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [now]
    );
    const myStatuses = await db.getAllAsync(
      `SELECT *, 'media' as status_type, 1 as is_mine FROM my_statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [now]
    );
    const receivedStatuses = await db.getAllAsync(
      `SELECT *, 'media' as status_type, 0 as is_mine FROM received_statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [now]
    );

    return [...textStatuses, ...myStatuses, ...receivedStatuses];
  },

  // ============================================================
  // ── CLEANUP ─────────────────────────────────────────────────
  // ============================================================

  /**
   * Remove all expired statuses (24hr TTL)
   */
  async cleanupExpiredStatuses(): Promise<{ deleted: number }> {
    const db = await getDB();
    if (!db) return { deleted: 0 };
    const now = Date.now();

    // Get expired media paths for file cleanup
    const expiredMedia = await db.getAllAsync(
      `SELECT media_local_path, thumbnail_path FROM my_statuses WHERE expires_at < ?
       UNION ALL
       SELECT media_local_path, thumbnail_path FROM received_statuses WHERE expires_at < ?;`,
      [now, now]
    );

    // Delete from all status tables
    await db.runAsync(`DELETE FROM my_statuses WHERE expires_at < ?;`, [now]);
    await db.runAsync(`DELETE FROM received_statuses WHERE expires_at < ?;`, [now]);
    await db.runAsync(`DELETE FROM text_statuses WHERE expires_at < ?;`, [now]);

    return { deleted: expiredMedia.length };
  },
};
