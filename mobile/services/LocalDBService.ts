// mobile/services/LocalDBService.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DATABASE SERVICE  (Single Source of Truth)
// ─────────────────────────────────────────────────────────────────────────────

import * as SQLite from 'expo-sqlite';
import { MIGRATE_DB } from '../database/schema';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type MessageStatus =
  | 'pending'    // Saved locally, not yet sent to server
  | 'sent'       // Server accepted it
  | 'delivered'  // Receiver's device received it
  | 'read'       // Receiver opened it
  | 'failed';    // Gave up after MAX_RETRY_COUNT attempts

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
  localFileUri?: string;
}

export interface LocalMessage {
  id: string;
  sender: 'me' | 'them';
  text: string;
  timestamp: string;
  status?: string;
  media?: QueuedMessage['media'];
  replyTo?: string;
  localFileUri?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

let _db: SQLite.SQLiteDatabase | null = null;
let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    try {
      console.log('[SQLite] Opening database...');
      const db = await SQLite.openDatabaseAsync('soulsync.db');

      await db.execAsync('PRAGMA journal_mode = WAL;');
      await db.execAsync('PRAGMA foreign_keys = ON;');

      await MIGRATE_DB(db);

      // Idempotent table creation
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS messages (
          id            TEXT PRIMARY KEY NOT NULL,
          chat_id       TEXT NOT NULL,
          sender        TEXT NOT NULL,
          receiver      TEXT NOT NULL,
          text          TEXT,
          media_type    TEXT,
          media_url     TEXT,
          media_caption TEXT,
          media_name    TEXT,
          reply_to_id   TEXT,
          timestamp     TEXT NOT NULL,
          status        TEXT DEFAULT 'pending',
          retry_count   INTEGER DEFAULT 0,
          local_file_uri TEXT,
          is_unsent     INTEGER DEFAULT 0,
          reaction      TEXT
        );
        CREATE TABLE IF NOT EXISTS contacts (
          id            TEXT PRIMARY KEY NOT NULL,
          name          TEXT NOT NULL,
          avatar        TEXT,
          bio           TEXT,
          status        TEXT DEFAULT 'offline',
          last_message  TEXT,
          unread_count  INTEGER DEFAULT 0,
          about         TEXT,
          last_seen     TEXT,
          last_synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS statuses (
          id            TEXT PRIMARY KEY NOT NULL,
          user_id       TEXT NOT NULL,
          type          TEXT NOT NULL,
          r2_key        TEXT,
          local_path    TEXT,
          text_content  TEXT,
          created_at    INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL,
          is_mine       INTEGER DEFAULT 0,
          is_seen       INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS app_sync_queue (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          action        TEXT NOT NULL,
          payload       TEXT NOT NULL,
          created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
          retry_count   INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS media_downloads (
          message_id    TEXT PRIMARY KEY NOT NULL,
          remote_url    TEXT NOT NULL,
          local_uri     TEXT NOT NULL,
          file_size     INTEGER,
          downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(message_id) REFERENCES messages(id) ON UPDATE CASCADE ON DELETE CASCADE
        );
      `);

      _db = db;
      return db;
    } catch (error) {
      console.error('[SQLite] Initialization error:', error);
      _dbPromise = null;
      throw error;
    }
  })();

  return _dbPromise;
}

function rowToQueuedMessage(row: any): QueuedMessage {
  let media: QueuedMessage['media'] | undefined;
  if (row.media_url != null || row.media_type || row.local_file_uri) {
    media = {
      type: row.media_type ?? 'image',
      url: row.media_url ?? '',
      name: row.media_name ?? undefined,
      caption: row.media_caption ?? undefined,
    };
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    sender: row.sender === 'me' ? 'me' : 'them',
    text: row.text ?? '',
    timestamp: row.timestamp,
    status: (row.status as MessageStatus) ?? 'pending',
    media,
    replyTo: row.reply_to_id ?? undefined,
    retryCount: row.retry_count ?? 0,
    lastRetryAt: row.last_retry_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    localFileUri: row.local_file_uri ?? undefined,
  };
}

class OfflineService {
  async saveMessage(chatId: string, msg: LocalMessage): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO messages
         (id, chat_id, sender, receiver, text,
          media_type, media_url, media_caption,
          reply_to_id, timestamp, status, local_file_uri, is_unsent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         media_url = COALESCE(excluded.media_url, messages.media_url),
         local_file_uri = COALESCE(messages.local_file_uri, excluded.local_file_uri);`,
      [msg.id, chatId, msg.sender, msg.sender === 'me' ? chatId : 'me', msg.text ?? '', msg.media?.type ?? null, msg.media?.url ?? null, msg.media?.caption ?? null, msg.replyTo ?? null, msg.timestamp, msg.status ?? 'delivered', msg.localFileUri ?? null]
    );
  }

  async savePendingMessage(chatId: string, msg: QueuedMessage): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO messages
         (id, chat_id, sender, receiver, text,
          media_type, media_url, media_caption,
          reply_to_id, timestamp, status, retry_count, local_file_uri, is_unsent)
       VALUES (?, ?, 'me', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 1)
       ON CONFLICT(id) DO UPDATE SET status = 'pending', is_unsent = 1;`,
      [msg.id, chatId, chatId, msg.text ?? '', msg.media?.type ?? null, msg.media?.url ?? null, msg.media?.caption ?? null, msg.replyTo ?? null, msg.timestamp, msg.localFileUri ?? null]
    );
  }

  async getMessages(chatId: string, limit = 100): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT ?;`, [chatId, limit]);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getPendingMessages(): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM messages WHERE status = 'pending' ORDER BY timestamp ASC;`);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getMessageById(messageId: string): Promise<QueuedMessage | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT * FROM messages WHERE id = ? LIMIT 1;`, [messageId]);
    return row ? rowToQueuedMessage(row) : null;
  }

  async updateMessageStatus(messageId: string, status: MessageStatus): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET status = ? WHERE id = ?;`, [status, messageId]);
  }

  async updateMessageMediaUrl(messageId: string, url: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET media_url = ? WHERE id = ?;`, [url, messageId]);
  }

  async updateMessageLocalUri(messageId: string, uri: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET local_file_uri = ? WHERE id = ?;`, [uri, messageId]);
  }

  async updateMessageId(oldId: string, newId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET id = ? WHERE id = ?;`, [newId, oldId]);
  }

  async updateMessageRetry(messageId: string, retryCount: number, errorMessage?: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET retry_count = ?, last_retry_at = ?, error_message = ? WHERE id = ?;`, [retryCount, new Date().toISOString(), errorMessage ?? null, messageId]);
  }

  async markMessageAsFailed(messageId: string, reason: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET status = 'failed', error_message = ? WHERE id = ?;`, [reason, messageId]);
  }

  async markMessageAsUnsent(messageId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET is_unsent = 1 WHERE id = ?;`, [messageId]);
  }

  async getUnreadCount(chatId: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ? AND sender = 'them' AND status != 'read' AND is_unsent = 0;`, [chatId]) as any;
    return row?.cnt ?? 0;
  }

  async markChatAsRead(chatId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET status = 'read' WHERE chat_id = ? AND sender = 'them' AND status != 'read';`, [chatId]);
  }

  async updateMessageReaction(messageId: string, emoji: string | null): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET reaction = ? WHERE id = ?;`, [emoji ?? null, messageId]);
  }

  async getContacts(): Promise<any[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM contacts ORDER BY name ASC;`);
    return (rows as any[]).map(r => ({ id: r.id, name: r.name, avatar: r.avatar ?? '', status: r.status ?? 'offline', lastMessage: r.last_message ?? '', unreadCount: r.unread_count ?? 0, about: r.about ?? r.bio ?? '', lastSeen: r.last_seen ?? undefined }));
  }

  async saveContact(contact: any): Promise<void> {
    const db = await getDb();
    await db.runAsync(`INSERT OR REPLACE INTO contacts (id, name, avatar, status, last_message, unread_count, about, last_seen, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`, [contact.id, contact.name, contact.avatar ?? null, contact.status ?? 'offline', contact.lastMessage ?? null, contact.unreadCount ?? 0, contact.about ?? null, contact.lastSeen ?? null, new Date().toISOString()]);
  }

  async getStatuses(): Promise<any[]> {
    const db = await getDb();
    return await db.getAllAsync(`SELECT * FROM statuses WHERE expires_at > ? ORDER BY created_at DESC;`, [Date.now()]);
  }

  async saveStatus(status: any): Promise<void> {
    const db = await getDb();
    await db.runAsync(`INSERT OR REPLACE INTO statuses (id, user_id, type, r2_key, local_path, text_content, created_at, expires_at, is_mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`, [status.id, status.userId, status.type, status.r2Key ?? null, status.localPath ?? null, status.textContent ?? null, status.createdAt, status.expiresAt, status.isMine ? 1 : 0]);
  }

  async deleteStatus(statusId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM statuses WHERE id = ?;`, [statusId]);
  }

  async markStatusAsSeen(statusId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE statuses SET is_seen = 1 WHERE id = ?;`, [statusId]);
  }

  async getPendingSyncActions(): Promise<any[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM app_sync_queue ORDER BY created_at ASC;`);
    return (rows as any[]).map(r => ({ id: r.id, action: r.action, payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(), retry_count: r.retry_count ?? 0 }));
  }

  async removeSyncAction(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM app_sync_queue WHERE id = ?;`, [id]);
  }

  async incrementSyncRetry(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE app_sync_queue SET retry_count = retry_count + 1 WHERE id = ?;`, [id]);
  }

  async saveMediaDownload(messageId: string, remoteUrl: string, localUri: string, fileSize?: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(`INSERT OR REPLACE INTO media_downloads (message_id, remote_url, local_uri, file_size) VALUES (?, ?, ?, ?);`, [messageId, remoteUrl, localUri, fileSize ?? null]);
    await db.runAsync(`UPDATE messages SET local_file_uri = ? WHERE id = ?;`, [localUri, messageId]);
  }

  async getMediaDownload(messageId: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT local_uri FROM media_downloads WHERE message_id = ? LIMIT 1;`, [messageId]) as any;
    return row?.local_uri ?? null;
  }

  async clearChat(partnerId: string): Promise<void> {
    const db = await getDb();
    await db.execAsync('BEGIN TRANSACTION;');
    try {
      await db.runAsync(`DELETE FROM messages WHERE chat_id = ?;`, [partnerId]);
      await db.runAsync(`UPDATE contacts SET last_message = '', unread_count = 0 WHERE id = ?;`, [partnerId]);
      await db.execAsync('COMMIT;');
    } catch (e) {
      await db.execAsync('ROLLBACK;');
      throw e;
    }
  }
}

export const offlineService = new OfflineService();
