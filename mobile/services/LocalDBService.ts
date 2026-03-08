// mobile/services/LocalDBService.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DATABASE SERVICE  (Single Source of Truth)
//
// This is the ONLY file that should talk directly to SQLite.
// ChatService, hooks, and screens talk to THIS service — never to the DB directly.
//
// WHY THIS FILE MATTERS:
//   The old codebase had two copies of this file:
//     - src/services/LocalDBService.ts   ← DELETE THIS
//     - services/LocalDBService.ts       ← THIS IS THE REAL ONE
//   Having two copies caused "split-brain" bugs where one screen would read
//   stale data because it was pointing at the wrong copy.
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
  lastRetryAt?: string;   // ISO string — used for exponential backoff calculation
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
  // 1. If we already have an initialized DB, return it instantly.
  if (_db) return _db;

  // 2. If an initialization is already in progress, wait for it.
  if (_dbPromise) return _dbPromise;

  // 3. Otherwise, start the initialization.
  _dbPromise = (async () => {
    try {
      console.log('[SQLite] Opening database...');
      // openDatabaseAsync is the modern non-deprecated API
      const db = await SQLite.openDatabaseAsync('soulsync.db');

      console.log('[SQLite] Database opened. Configuring PRAGMAs...');
      // Enable WAL mode: much faster writes, safe concurrent reads
      await db.execAsync('PRAGMA journal_mode = WAL;');
      // Enforce foreign key constraints (SQLite disables them by default!)
      await db.execAsync('PRAGMA foreign_keys = ON;');

      console.log('[SQLite] Running migrations...');
      await MIGRATE_DB(db);

      // Ensure extra tables exist (idempotent — safe to run every time)
      await db.execAsync(`
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
      `);

      console.log('[SQLite] Database initialization complete.');
      _db = db;
      return db;
    } catch (error) {
      console.error('[SQLite] Initialization error:', error);
      _dbPromise = null; // Allow retry on next call
      throw error;
    }
  })();

  return _dbPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — convert a raw SQLite row into a typed QueuedMessage
// ─────────────────────────────────────────────────────────────────────────────
function rowToQueuedMessage(row: any): QueuedMessage {
  let media: QueuedMessage['media'] | undefined;
  // If we have an intentional media type, or a populated URL/local file, we MUST recreate the media object.
  // We use `row.media_url != null` to capture empty strings correctly.
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

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE SERVICE CLASS
// ─────────────────────────────────────────────────────────────────────────────

class OfflineService {

  // ── WRITE: Save an incoming / historical message ──────────────────────────
  //
  // Called by ChatService when:
  //   (a) A realtime INSERT arrives from Supabase for the current chat
  //   (b) fetchMissedMessages() syncs old messages on startup
  //
  // Uses INSERT OR REPLACE so duplicate calls are safe (idempotent).
  async saveMessage(chatId: string, msg: LocalMessage): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO messages
         (id, chat_id, sender, receiver, text,
          media_type, media_url, media_caption,
          reply_to_id, timestamp, status, local_file_uri, is_unsent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0);`,
      [
        msg.id,
        chatId,
        msg.sender,
        msg.sender === 'me' ? chatId : 'me',   // receiver = the other party
        msg.text ?? '',
        msg.media?.type ?? null,
        msg.media?.url ?? null,
        msg.media?.caption ?? null,
        msg.replyTo ?? null,
        msg.timestamp,
        msg.status,
        msg.localFileUri ?? null,
      ]
    );
  }

  // ── WRITE: Save an outgoing message BEFORE sending to server ─────────────
  //
  // This is the "SQLite First" step.  The message is given status='pending'.
  // ChatService calls this, then immediately renders the message in the UI,
  // then in the background tries to push it to Supabase.
  async savePendingMessage(chatId: string, msg: QueuedMessage): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO messages
         (id, chat_id, sender, receiver, text,
          media_type, media_url, media_caption,
          reply_to_id, timestamp, status, retry_count, local_file_uri, is_unsent)
       VALUES (?, ?, 'me', ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 1);`,
      [
        msg.id,
        chatId,
        chatId,   // receiver = partner
        msg.text ?? '',
        msg.media?.type ?? null,
        msg.media?.url ?? null,
        msg.media?.caption ?? null,
        msg.replyTo ?? null,
        msg.timestamp,
        msg.localFileUri ?? null,
      ]
    );
  }

  // ── READ: Load all messages for a chat (for the chat screen) ──────────────
  async getMessages(chatId: string, limit = 100): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM messages
       WHERE chat_id = ?
       ORDER BY timestamp ASC
       LIMIT ?;`,
      [chatId, limit]
    );
    return (rows as any[]).map(rowToQueuedMessage);
  }

  // ── READ: All messages still waiting to be sent ───────────────────────────
  //
  // ChatService's processQueue() calls this every PROCESSING_INTERVAL_MS.
  // Returns only messages with status='pending' that haven't permanently failed.
  async getPendingMessages(): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM messages
       WHERE status = 'pending'
       ORDER BY timestamp ASC;`
    );
    return (rows as any[]).map(rowToQueuedMessage);
  }

  // ── READ: Fetch a single message by its ID ────────────────────────────────
  //
  // Used by ChatService.retryMessage() to reload a failed message.
  async getMessageById(messageId: string): Promise<QueuedMessage | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(
      `SELECT * FROM messages WHERE id = ? LIMIT 1;`,
      [messageId]
    );
    if (!row) return null;
    return rowToQueuedMessage(row);
  }

  // ── WRITE: Update a message's status ─────────────────────────────────────
  async updateMessageStatus(messageId: string, status: MessageStatus): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages SET status = ? WHERE id = ?;`,
      [status, messageId]
    );
  }

  // ── WRITE: Update media url after background upload ──────────────────────
  async updateMessageMediaUrl(messageId: string, url: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages SET media_url = ? WHERE id = ?;`,
      [url, messageId]
    );
  }

  // ── WRITE: Update localFileUri for downloaded media ──────────────────────
  async updateMessageLocalUri(messageId: string, uri: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages SET local_file_uri = ? WHERE id = ?;`,
      [uri, messageId]
    );
  }

  // ── WRITE: Swap a temp local ID for the real server ID ───────────────────
  //
  // After Supabase inserts a message, it returns a real UUID.
  // We call this to replace our temporary Date.now() ID.
  //
  // Because media_downloads has ON UPDATE CASCADE, the media row's message_id
  // updates automatically — no manual fix needed.
  async updateMessageId(oldId: string, newId: string): Promise<void> {
    const db = await getDb();
    // A single UPDATE is atomic in SQLite. 
    // ON UPDATE CASCADE in media_downloads will automatically handle the child row seamlessly.
    // Manual BEGIN/COMMIT over a shared connection causes overlapping transaction crashes 
    // when multiple messages are sent concurrently.
    try {
      await db.runAsync(
        `UPDATE messages SET id = ? WHERE id = ?;`,
        [newId, oldId]
      );
    } catch (e) {
      console.error('[LocalDB] updateMessageId failed:', e);
      throw e;
    }
  }

  // ── WRITE: Record a failed send attempt ──────────────────────────────────
  //
  // Called by ChatService after each network error.
  // Stores retryCount and lastRetryAt so the exponential-backoff check works.
  async updateMessageRetry(
    messageId: string,
    retryCount: number,
    errorMessage?: string
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages
       SET retry_count   = ?,
           last_retry_at = ?,
           error_message = ?
       WHERE id = ?;`,
      [
        retryCount,
        new Date().toISOString(),
        errorMessage ?? null,
        messageId,
      ]
    );
  }

  // ── WRITE: Permanently mark a message as failed ───────────────────────────
  //
  // Called when retryCount >= MAX_RETRY_COUNT.
  // UI can show a red "!" icon and offer a manual retry button.
  async markMessageAsFailed(messageId: string, reason: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages
       SET status        = 'failed',
           error_message = ?
       WHERE id = ?;`,
      [reason, messageId]
    );
  }

  // ── WRITE: Soft-delete — mark a message as unsent ─────────────────────────
  //
  // We never hard-delete because it would break reply threads.
  // is_unsent = 1 hides it from getMessages() but keeps the row for FK integrity.
  async markMessageAsUnsent(messageId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages SET is_unsent = 1 WHERE id = ?;`,
      [messageId]
    );
  }

  // ── READ: Unread count for a chat (badge number) ──────────────────────────
  async getUnreadCount(chatId: string, myUserId: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) as cnt
       FROM messages
       WHERE chat_id = ?
         AND sender  = 'them'
         AND status  != 'read'
         AND is_unsent = 0;`,
      [chatId]
    ) as any;
    return row?.cnt ?? 0;
  }

  // ── WRITE: Mark all messages in a chat as read ────────────────────────────
  async markChatAsRead(chatId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE messages
       SET status = 'read'
       WHERE chat_id = ? AND sender = 'them' AND status != 'read';`,
      [chatId]
    );
  }

  // ── WRITE: Record a completed media download ──────────────────────────────
  async saveMediaDownload(
    messageId: string,
    remoteUrl: string,
    localUri: string,
    fileSize?: number
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO media_downloads
         (message_id, remote_url, local_uri, file_size)
       VALUES (?, ?, ?, ?);`,
      [messageId, remoteUrl, localUri, fileSize ?? null]
    );
    // Update the message row so UI knows media is locally available
    await db.runAsync(
      `UPDATE messages
       SET media_status   = 'downloaded',
           local_file_uri = ?
       WHERE id = ?;`,
      [localUri, messageId]
    );
  }

  // ── READ: Check if media is already downloaded ────────────────────────────
  async getMediaDownload(messageId: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(
      `SELECT local_uri FROM media_downloads WHERE message_id = ? LIMIT 1;`,
      [messageId]
    ) as any;
    return row?.local_uri ?? null;
  }

  // ── UTILITY: Wipe everything for a specific chat ──────────────────────────
  async clearChat(chatId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM messages WHERE chat_id = ?;`, [chatId]);
  }

  // ── WRITE: Hard-delete a single message ──────────────────────────────────
  async deleteMessage(messageId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM messages WHERE id = ?;`, [messageId]);
  }

  // ── WRITE: Update a message's reaction emoji ──────────────────────────────
  async updateMessageReaction(messageId: string, emoji: string | null): Promise<void> {
    const db = await getDb();
    // reaction column may not exist on older installs — add it safely
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN reaction TEXT;`);
    } catch (_) { /* already exists */ }
    await db.runAsync(
      `UPDATE messages SET reaction = ? WHERE id = ?;`,
      [emoji ?? null, messageId]
    );
  }

  // ── READ: Load all contacts ───────────────────────────────────────────────
  async getContacts(): Promise<any[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM contacts ORDER BY name ASC;`);
    return (rows as any[]).map(r => ({
      id: r.id,
      name: r.name,
      avatar: r.avatar ?? '',
      status: r.status ?? 'offline',
      lastMessage: r.last_message ?? '',
      unreadCount: r.unread_count ?? 0,
      about: r.about ?? r.bio ?? '',
      lastSeen: r.last_seen ?? undefined,
    }));
  }

  // ── WRITE: Save or update a contact ──────────────────────────────────────
  async saveContact(contact: {
    id: string; name: string; avatar?: string; status?: string;
    lastMessage?: string; unreadCount?: number; about?: string; lastSeen?: string;
  }): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO contacts
         (id, name, avatar, status, last_message, unread_count, about, last_seen, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        contact.id,
        contact.name,
        contact.avatar ?? null,
        contact.status ?? 'offline',
        contact.lastMessage ?? null,
        contact.unreadCount ?? 0,
        contact.about ?? null,
        contact.lastSeen ?? null,
        new Date().toISOString(),
      ]
    );
  }

  // ── READ: All statuses ────────────────────────────────────────────────────
  async getStatuses(): Promise<any[]> {
    const db = await getDb();
    const now = Date.now();
    const rows = await db.getAllAsync(
      `SELECT * FROM statuses WHERE expires_at > ? ORDER BY created_at DESC;`,
      [now]
    );
    return rows as any[];
  }

  // ── WRITE: Save a status ──────────────────────────────────────────────────
  async saveStatus(status: {
    id: string; userId: string; type: string;
    r2Key?: string; localPath?: string; textContent?: string;
    viewers?: string[]; createdAt: number; expiresAt: number; isMine?: boolean;
  }): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO statuses
         (id, user_id, type, r2_key, local_path, text_content, created_at, expires_at, is_mine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        status.id,
        status.userId,
        status.type,
        status.r2Key ?? null,
        status.localPath ?? null,
        status.textContent ?? null,
        status.createdAt,
        status.expiresAt,
        status.isMine ? 1 : 0,
      ]
    );
  }

  // ── WRITE: Delete a status ────────────────────────────────────────────────
  async deleteStatus(statusId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM statuses WHERE id = ?;`, [statusId]);
  }

  // ── WRITE: Mark a status as seen ─────────────────────────────────────────
  async markStatusAsSeen(statusId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE statuses SET is_seen = 1 WHERE id = ?;`, [statusId]);
  }

  // ── READ: Pending sync actions ────────────────────────────────────────────
  async getPendingSyncActions(): Promise<any[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM app_sync_queue ORDER BY created_at ASC;`
    );
    return (rows as any[]).map(r => ({
      id: r.id,
      action: r.action,
      payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })(),
      retry_count: r.retry_count ?? 0,
    }));
  }

  // ── WRITE: Remove a completed / failed sync action ────────────────────────
  async removeSyncAction(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM app_sync_queue WHERE id = ?;`, [id]);
  }

  // ── WRITE: Increment retry count on a sync action ────────────────────────
  async incrementSyncRetry(id: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE app_sync_queue SET retry_count = retry_count + 1 WHERE id = ?;`,
      [id]
    );
  }
}

// Export a single shared instance — same pattern as the old file
export const offlineService = new OfflineService();
