import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';

export type SyncMessageStatus = 'pending' | 'sent' | 'delivered' | 'read';
export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export interface LocalMessageRecord {
  id: string;
  chatId: string;
  senderId: string;
  receiverId: string;
  text: string;
  status: SyncMessageStatus;
  createdAt: string;
  updatedAt: string;
  remoteId?: string | null;
  mediaType?: MediaKind | null;
  mediaLocalUri?: string | null;
  mediaRemoteUrl?: string | null;
  mediaMimeType?: string | null;
  mediaSize?: number | null;
  syncError?: string | null;
}

export interface NewLocalMessageInput {
  id: string;
  chatId: string;
  senderId: string;
  receiverId: string;
  text?: string;
  status?: SyncMessageStatus;
  createdAt?: string;
  remoteId?: string | null;
  mediaType?: MediaKind | null;
  mediaLocalUri?: string | null;
  mediaRemoteUrl?: string | null;
  mediaMimeType?: string | null;
  mediaSize?: number | null;
  syncError?: string | null;
}

export interface MediaCacheRecord {
  id: string;
  messageId: string;
  mediaType: MediaKind;
  localUri: string;
  remoteUrl?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  createdAt: string;
  lastAccessedAt: string;
}

const DB_NAME = 'soulsync_local.db';
const MEDIA_CACHE_DIR = `${FileSystem.documentDirectory}soulsync-media/`;

class LocalDBService {
  private database: SQLite.SQLiteDatabase | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    this.database = await SQLite.openDatabaseAsync(DB_NAME);
    await this.ensureMediaDirectory();
    await this.database.execAsync(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY NOT NULL,
        peer_id TEXT NOT NULL,
        peer_name TEXT,
        peer_avatar TEXT,
        last_message_text TEXT,
        last_message_at TEXT,
        unread_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        text TEXT DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivered', 'read')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        remote_id TEXT,
        media_type TEXT,
        media_local_uri TEXT,
        media_remote_url TEXT,
        media_mime_type TEXT,
        media_size INTEGER,
        sync_error TEXT,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS media_cache (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        local_uri TEXT NOT NULL,
        remote_url TEXT,
        mime_type TEXT,
        file_size INTEGER,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_messages_remote_id ON messages(remote_id);
      CREATE INDEX IF NOT EXISTS idx_media_cache_message_id ON media_cache(message_id);
      CREATE INDEX IF NOT EXISTS idx_media_cache_remote_url ON media_cache(remote_url);
    `);

    this.initialized = true;
  }

  private get db(): SQLite.SQLiteDatabase {
    if (!this.database) {
      throw new Error('LocalDBService not initialized. Call init() first.');
    }
    return this.database;
  }

  private async ensureMediaDirectory(): Promise<void> {
    const info = await FileSystem.getInfoAsync(MEDIA_CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIR, { intermediates: true });
    }
  }

  async upsertChat(input: {
    id: string;
    peerId: string;
    peerName?: string;
    peerAvatar?: string;
    lastMessageText?: string;
    lastMessageAt?: string;
  }): Promise<void> {
    await this.init();
    const now = new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO chats (
        id, peer_id, peer_name, peer_avatar, last_message_text, last_message_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        peer_id = excluded.peer_id,
        peer_name = excluded.peer_name,
        peer_avatar = excluded.peer_avatar,
        last_message_text = COALESCE(excluded.last_message_text, chats.last_message_text),
        last_message_at = COALESCE(excluded.last_message_at, chats.last_message_at),
        updated_at = excluded.updated_at;`,
      [
        input.id,
        input.peerId,
        input.peerName ?? null,
        input.peerAvatar ?? null,
        input.lastMessageText ?? null,
        input.lastMessageAt ?? null,
        now,
      ]
    );
  }

  async insertMessage(input: NewLocalMessageInput): Promise<void> {
    await this.init();
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const status = input.status ?? 'pending';
    await this.db.runAsync(
      `INSERT OR REPLACE INTO messages (
        id, chat_id, sender_id, receiver_id, text, status, created_at, updated_at,
        remote_id, media_type, media_local_uri, media_remote_url, media_mime_type, media_size, sync_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.id,
        input.chatId,
        input.senderId,
        input.receiverId,
        input.text ?? '',
        status,
        createdAt,
        now,
        input.remoteId ?? null,
        input.mediaType ?? null,
        input.mediaLocalUri ?? null,
        input.mediaRemoteUrl ?? null,
        input.mediaMimeType ?? null,
        input.mediaSize ?? null,
        input.syncError ?? null,
      ]
    );
  }

  async getMessagesByChat(chatId: string): Promise<LocalMessageRecord[]> {
    await this.init();
    const rows = await this.db.getAllAsync<LocalMessageRecord>(
      `SELECT
        id,
        chat_id as chatId,
        sender_id as senderId,
        receiver_id as receiverId,
        text,
        status,
        created_at as createdAt,
        updated_at as updatedAt,
        remote_id as remoteId,
        media_type as mediaType,
        media_local_uri as mediaLocalUri,
        media_remote_url as mediaRemoteUrl,
        media_mime_type as mediaMimeType,
        media_size as mediaSize,
        sync_error as syncError
       FROM messages
       WHERE chat_id = ?
       ORDER BY created_at ASC;`,
      [chatId]
    );
    return rows;
  }

  async getPendingMessages(limit = 100): Promise<LocalMessageRecord[]> {
    await this.init();
    const rows = await this.db.getAllAsync<LocalMessageRecord>(
      `SELECT
        id,
        chat_id as chatId,
        sender_id as senderId,
        receiver_id as receiverId,
        text,
        status,
        created_at as createdAt,
        updated_at as updatedAt,
        remote_id as remoteId,
        media_type as mediaType,
        media_local_uri as mediaLocalUri,
        media_remote_url as mediaRemoteUrl,
        media_mime_type as mediaMimeType,
        media_size as mediaSize,
        sync_error as syncError
       FROM messages
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?;`,
      [limit]
    );
    return rows;
  }

  async updateMessageStatus(messageId: string, status: SyncMessageStatus): Promise<void> {
    await this.init();
    await this.db.runAsync(
      `UPDATE messages SET status = ?, updated_at = ? WHERE id = ?;`,
      [status, new Date().toISOString(), messageId]
    );
  }

  async markMessageSynced(localId: string, remoteId: string): Promise<void> {
    await this.init();
    await this.db.runAsync(
      `UPDATE messages
       SET remote_id = ?, status = 'sent', sync_error = NULL, updated_at = ?
       WHERE id = ?;`,
      [remoteId, new Date().toISOString(), localId]
    );
  }

  async setMessageSyncError(messageId: string, error: string): Promise<void> {
    await this.init();
    await this.db.runAsync(
      `UPDATE messages SET sync_error = ?, updated_at = ? WHERE id = ?;`,
      [error, new Date().toISOString(), messageId]
    );
  }

  async upsertRemoteMessage(input: {
    remoteId: string;
    chatId: string;
    senderId: string;
    receiverId: string;
    text?: string;
    status?: SyncMessageStatus;
    createdAt: string;
    mediaType?: MediaKind | null;
    mediaRemoteUrl?: string | null;
    mediaLocalUri?: string | null;
    mediaMimeType?: string | null;
    mediaSize?: number | null;
  }): Promise<void> {
    await this.init();
    const existing = await this.db.getFirstAsync<{ id: string }>(
      `SELECT id FROM messages WHERE remote_id = ? LIMIT 1;`,
      [input.remoteId]
    );

    const localId = existing?.id ?? `local-${input.remoteId}`;
    await this.insertMessage({
      id: localId,
      chatId: input.chatId,
      senderId: input.senderId,
      receiverId: input.receiverId,
      text: input.text ?? '',
      status: input.status ?? 'delivered',
      createdAt: input.createdAt,
      remoteId: input.remoteId,
      mediaType: input.mediaType ?? null,
      mediaRemoteUrl: input.mediaRemoteUrl ?? null,
      mediaLocalUri: input.mediaLocalUri ?? null,
      mediaMimeType: input.mediaMimeType ?? null,
      mediaSize: input.mediaSize ?? null,
    });
  }

  async saveMediaToCache(input: {
    id: string;
    messageId: string;
    mediaType: MediaKind;
    sourceUri: string;
    remoteUrl?: string | null;
    mimeType?: string | null;
  }): Promise<MediaCacheRecord> {
    await this.init();

    const fileName = `${Date.now()}-${input.id}`;
    const targetPath = `${MEDIA_CACHE_DIR}${fileName}`;
    if (input.sourceUri.startsWith('file://')) {
      await FileSystem.copyAsync({ from: input.sourceUri, to: targetPath });
    } else {
      await FileSystem.downloadAsync(input.sourceUri, targetPath);
    }

    const info = await FileSystem.getInfoAsync(targetPath);
    const now = new Date().toISOString();

    await this.db.runAsync(
      `INSERT OR REPLACE INTO media_cache (
        id, message_id, media_type, local_uri, remote_url, mime_type, file_size, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        input.id,
        input.messageId,
        input.mediaType,
        targetPath,
        input.remoteUrl ?? null,
        input.mimeType ?? null,
        info.exists && 'size' in info ? info.size ?? null : null,
        now,
        now,
      ]
    );

    await this.db.runAsync(
      `UPDATE messages
       SET media_local_uri = ?, media_remote_url = COALESCE(?, media_remote_url), media_mime_type = ?, media_size = ?, updated_at = ?
       WHERE id = ?;`,
      [
        targetPath,
        input.remoteUrl ?? null,
        input.mimeType ?? null,
        info.exists && 'size' in info ? info.size ?? null : null,
        now,
        input.messageId,
      ]
    );

    return {
      id: input.id,
      messageId: input.messageId,
      mediaType: input.mediaType,
      localUri: targetPath,
      remoteUrl: input.remoteUrl ?? null,
      mimeType: input.mimeType ?? null,
      fileSize: info.exists && 'size' in info ? info.size ?? null : null,
      createdAt: now,
      lastAccessedAt: now,
    };
  }

  async markMediaAccessed(messageId: string): Promise<void> {
    await this.init();
    await this.db.runAsync(
      `UPDATE media_cache SET last_accessed_at = ? WHERE message_id = ?;`,
      [new Date().toISOString(), messageId]
    );
  }
}

export const localDBService = new LocalDBService();
export default localDBService;
