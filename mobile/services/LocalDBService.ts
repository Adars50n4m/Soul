// mobile/services/LocalDBService.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DATABASE SERVICE  (Single Source of Truth)
// ─────────────────────────────────────────────────────────────────────────────

import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { 
  documentDirectory, 
  getInfoAsync, 
  makeDirectoryAsync, 
  moveAsync 
} from 'expo-file-system';
import { proxySupabaseUrl } from '../config/api';
import { MIGRATE_DB } from '../database/schema';
import { dbManager } from '../database/DatabaseManager';
import { mergeGroupedMediaThumbnail } from '../utils/chatUtils';

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
    thumbnail?: string;
    duration?: number;
  };
  replyTo?: string;
  senderName?: string;
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
  senderName?: string;
  localFileUri?: string;
  groupId?: string;
}

export interface LocalGroup {
  id: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LocalGroupMember {
  id: string;
  groupId: string;
  userId: string;
  role: string;
  joinedAt?: string;
}

export interface PendingSyncOperation {
  id: number;
  entityType: string;
  entityId: string;
  opType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
}

const MEDIA_GROUP_MARKER = '__MEDIA_GROUP_V1__:';

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'soul_messages.db';
const LEGACY_DB_NAME = 'soulsync_messages.db';
const SOUL_V1_DB_NAME = 'soul.db'; // Transient name from recent rename
const SOULSYNC_V1_DB_NAME = 'soulsync.db'; // Original legacy name

async function ensureDatabaseMigration(): Promise<void> {
  try {
    const dbDir = `${documentDirectory}SQLite/`;
    const newPath = `${dbDir}${DB_NAME}`;

    // Priority 1: Check for soulsync_messages.db (Old system, same schema structure)
    const legacyPath = `${dbDir}${LEGACY_DB_NAME}`;
    const legacyInfo = await getInfoAsync(legacyPath);
    if (legacyInfo.exists) {
      console.log(`[SQLite] Migrating ${LEGACY_DB_NAME} -> ${DB_NAME}`);
      await moveAsync({ from: legacyPath, to: newPath });
      return;
    }

    // Priority 2: Check for soul.db (If it exists but soul_messages.db doesn't)
    const soulV1Path = `${dbDir}${SOUL_V1_DB_NAME}`;
    const soulV1Info = await getInfoAsync(soulV1Path);
    if (soulV1Info.exists) {
        console.log(`[SQLite] Migrating ${SOUL_V1_DB_NAME} -> ${DB_NAME}`);
        await moveAsync({ from: soulV1Path, to: newPath });
        return;
    }

    // Priority 3: Check for soulsync.db
    const soulsyncPath = `${dbDir}${SOULSYNC_V1_DB_NAME}`;
    const soulsyncInfo = await getInfoAsync(soulsyncPath);
    if (soulsyncInfo.exists) {
        console.log(`[SQLite] Migrating ${SOULSYNC_V1_DB_NAME} -> ${DB_NAME}`);
        await moveAsync({ from: soulsyncPath, to: newPath });
        return;
    }
  } catch (error) {
    console.warn('[SQLite] Database migration check failed:', error);
  }
}

let _dbInstance: SQLite.SQLiteDatabase | null = null;
let _dbInitPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let _isInitializing = false;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_dbInstance) return _dbInstance;
  if (_dbInitPromise) return _dbInitPromise;

  _dbInitPromise = (async () => {
    if (_isInitializing) return _dbInitPromise!; // Should not happen with current logic but safe
    _isInitializing = true;
    try {
      await ensureDatabaseMigration();
      const db = await dbManager.getDatabase({
        name: DB_NAME,
        migrations: async (dbInstance) => {
            await MIGRATE_DB(dbInstance);
        },
        onOpen: async (db) => {
          // Delay setup of WAL checkpoint slightly to allow other boot tasks to finish
          setTimeout(() => setupWalCheckpoint(db), 5000);
        }
      });
      _dbInstance = db;
      console.log('[SQLite] LocalDBService: database ready');
      return db;
    } finally {
      _isInitializing = false;
    }
  })();

  return _dbInitPromise;
}

// Exported for other services (StatusService, etc.)
export { getDb };

// FIX #19: Periodic WAL checkpoint to prevent data loss on crash
let checkpointInterval: NodeJS.Timeout | null = null;

function setupWalCheckpoint(db: SQLite.SQLiteDatabase): void {
  // Consolidate WAL data to prevent the file from growing indefinitely
  if (checkpointInterval) {
    clearInterval(checkpointInterval);
  }

  checkpointInterval = setInterval(async () => {
    try {
      // 🛡️ Use execAsync to run the pragma without blocking long-running queries
      await db.execAsync('PRAGMA wal_checkpoint(PASSIVE);'); 
      // console.log('[SQLite] WAL checkpoint (passive)');
    } catch (error) {
      // Periodic failures are expected if DB is very busy, just log it.
      // console.debug('[SQLite] WAL checkpoint deferred');
    }
  }, 60000); // Reduce frequency to once per minute to lower lock contention
}

function rowToQueuedMessage(row: any): QueuedMessage {
  let media: QueuedMessage['media'] | undefined;
  if (row.media_url != null || row.media_type || row.local_file_uri) {
    media = {
      type: row.media_type ?? 'image',
      url: proxySupabaseUrl(row.media_url ?? ''),
      name: row.media_name ?? undefined,
      caption: row.media_caption ?? undefined,
      thumbnail: row.media_thumbnail ?? undefined,
      duration: row.media_duration ?? undefined,
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
    senderName: row.sender_name ?? undefined,
    retryCount: row.retry_count ?? 0,
    lastRetryAt: row.last_retry_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    localFileUri: row.local_file_uri ?? undefined,
  };
}

class OfflineService {
  private transactionQueue: Promise<unknown> = Promise.resolve();

  private async runSerializedTransaction<T>(
    operation: (db: SQLite.SQLiteDatabase) => Promise<T>
  ): Promise<T> {
    const db = await getDb();

    let releaseQueue!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    const previous = this.transactionQueue;
    this.transactionQueue = previous.then(() => gate, () => gate);

    await previous;

    try {
      let result!: T;
      await db.withTransactionAsync(async () => {
        result = await operation(db);
      });
      return result;
    } finally {
      releaseQueue();
    }
  }

  async initialize(): Promise<void> {
    await getDb();
  }

  private async upsertChatSummary(
    chatId: string,
    messagePreview: string,
    timestamp: string,
    unreadIncrement = 0
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO chats (id, last_message_preview, last_message_at, unread_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_message_preview = excluded.last_message_preview,
         last_message_at = excluded.last_message_at,
         unread_count = MAX(0, COALESCE(chats.unread_count, 0) + ?),
         updated_at = excluded.updated_at;`,
      [chatId, messagePreview, timestamp, Math.max(0, unreadIncrement), timestamp, unreadIncrement]
    );
  }

  // ─── GROUP METHODS ───────────────────────────────────────────────────────

  async saveGroup(group: LocalGroup): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO groups (id, name, description, avatar_url, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at;`,
      [group.id, group.name, group.description ?? null, group.avatarUrl ?? null, group.createdBy ?? null, group.createdAt ?? null, group.updatedAt ?? null]
    );

    // Also ensure a contact entry exists for this group so it shows in chat list
    await this.saveContact({
        id: group.id,
        name: group.name,
        avatar: group.avatarUrl,
        about: group.description,
        isGroup: true
    });
  }

  async getGroup(id: string): Promise<LocalGroup | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT * FROM groups WHERE id = ? LIMIT 1;`, [id]) as any;
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        avatarUrl: row.avatar_url ?? undefined,
        createdBy: row.created_by ?? undefined,
        createdAt: row.created_at ?? undefined,
        updatedAt: row.updated_at ?? undefined
    };
  }

  async saveGroupMembers(groupId: string, members: LocalGroupMember[]): Promise<void> {
    await this.runSerializedTransaction(async (db) => {
        // WhatsApp style: usually we refresh the whole list for a group
        // If we want to be surgical, we could just upsert
        for (const member of members) {
            await db.runAsync(
                `INSERT INTO group_members (id, group_id, user_id, role, joined_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(group_id, user_id) DO UPDATE SET
                   role = excluded.role;`,
                [member.id, groupId, member.userId, member.role, member.joinedAt ?? null]
            );
        }
    });
  }

  async getGroupMembers(groupId: string): Promise<LocalGroupMember[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM group_members WHERE group_id = ?;`, [groupId]);
    return (rows as any[]).map(r => ({
        id: r.id,
        groupId: r.group_id,
        userId: r.user_id,
        role: r.role,
        joinedAt: r.joined_at ?? undefined
    }));
  }

  private async enqueuePendingSyncOp(
    entityType: string,
    entityId: string,
    opType: string,
    payload: Record<string, unknown>,
    createdAt: string
  ): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO pending_sync_ops (entity_type, entity_id, op_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [entityType, entityId, opType, JSON.stringify(payload), createdAt]
    );
  }

  async saveMessage(chatId: string, msg: LocalMessage): Promise<void> {
    const receiver = msg.sender === 'me' ? chatId : 'me';
    
    await this.runSerializedTransaction(async (db) => {
      const existing = await db.getFirstAsync<{ id: string; media_thumbnail?: string | null }>(
        `SELECT id, media_thumbnail FROM messages WHERE id = ? LIMIT 1;`,
        [msg.id]
      );
      const mergedThumbnail = mergeGroupedMediaThumbnail(existing?.media_thumbnail ?? undefined, msg.media?.thumbnail);

      await db.runAsync(
        `INSERT INTO messages
           (id, chat_id, sender, receiver, text,
            media_type, media_url, media_caption, media_thumbnail,
            reply_to_id, timestamp, status, local_file_uri, is_unsent, media_duration, group_id, sender_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
           text = COALESCE(NULLIF(excluded.text, ''), messages.text),
           status = CASE
             WHEN messages.status = 'read' OR excluded.status = 'read' THEN 'read'
             WHEN messages.status = 'delivered' OR excluded.status = 'delivered' THEN 'delivered'
             WHEN messages.status = 'sent' OR excluded.status = 'sent' THEN 'sent'
             WHEN messages.status = 'pending' OR excluded.status = 'pending' THEN 'pending'
             ELSE COALESCE(excluded.status, messages.status)
           END,
           media_type = COALESCE(excluded.media_type, messages.media_type),
           media_url = COALESCE(NULLIF(excluded.media_url, ''), messages.media_url),
           media_caption = COALESCE(NULLIF(excluded.media_caption, ''), messages.media_caption),
           media_thumbnail = COALESCE(NULLIF(excluded.media_thumbnail, ''), messages.media_thumbnail),
           reply_to_id = COALESCE(NULLIF(excluded.reply_to_id, ''), messages.reply_to_id),
           media_duration = COALESCE(excluded.media_duration, messages.media_duration),
           group_id = COALESCE(excluded.group_id, messages.group_id),
           sender_name = COALESCE(excluded.sender_name, messages.sender_name),
           local_file_uri = COALESCE(messages.local_file_uri, excluded.local_file_uri);`,
        [msg.id, chatId, msg.sender, receiver, msg.text ?? '', msg.media?.type ?? null, msg.media?.url ?? null, msg.media?.caption ?? null, mergedThumbnail ?? null, msg.replyTo ?? null, msg.timestamp, msg.status ?? 'delivered', msg.localFileUri ?? null, msg.media?.duration ?? null, msg.groupId ?? null, msg.senderName ?? null]
      );

      if (!existing) {
        const preview = msg.text?.trim() || (msg.media ? 'Media' : '');
        await this.upsertChatSummary(chatId, preview, msg.timestamp, msg.sender === 'them' ? 1 : 0);
      }
    });
  }

  async savePendingMessage(chatId: string, msg: QueuedMessage): Promise<void> {
    await this.runSerializedTransaction(async (db) => {
      await db.runAsync(
        `INSERT INTO messages
           (id, chat_id, sender, receiver, text,
            media_type, media_url, media_caption, media_thumbnail,
            reply_to_id, timestamp, status, retry_count, local_file_uri, is_unsent, media_duration, sender_name)
         VALUES (?, ?, 'me', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
           status = 'pending', 
           is_unsent = 1,
           media_url = COALESCE(excluded.media_url, messages.media_url),
           media_thumbnail = COALESCE(excluded.media_thumbnail, messages.media_thumbnail),
           local_file_uri = COALESCE(messages.local_file_uri, excluded.local_file_uri),
           sender_name = COALESCE(excluded.sender_name, messages.sender_name);`,
        [msg.id, chatId, chatId, msg.text ?? '', msg.media?.type ?? null, msg.media?.url ?? null, msg.media?.caption ?? null, msg.media?.thumbnail ?? null, msg.replyTo ?? null, msg.timestamp, msg.localFileUri ?? null, msg.media?.duration ?? null, msg.senderName ?? null]
      );

      await this.enqueuePendingSyncOp('message', msg.id, 'insert', {
        chatId,
        sender: msg.sender,
        text: msg.text,
        timestamp: msg.timestamp,
        media: msg.media ?? null,
        replyTo: msg.replyTo ?? null,
        localFileUri: msg.localFileUri ?? null,
      }, msg.timestamp);

      const preview = msg.text?.trim() || (msg.media ? 'Media' : '');
      await this.upsertChatSummary(chatId, preview, msg.timestamp, 0);
    });
  }

  async getMessages(chatId: string, limit = 100): Promise<QueuedMessage[]> {
    const db = await getDb();
    // Get the most recent messages, then return in ASC order for display
    const rows = await db.getAllAsync(
      `SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?) sub ORDER BY timestamp ASC;`,
      [chatId, limit]
    );
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getLatestMessageTimestamp(chatId: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ timestamp: string }>(
      `SELECT timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 1;`,
      [chatId]
    );
    return row?.timestamp ?? null;
  }

  async getPendingMessages(): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM messages WHERE status = 'pending' ORDER BY timestamp ASC;`);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getIncompleteIncomingMediaMessageIds(chatId: string, limit = 25): Promise<string[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id
         FROM messages
        WHERE chat_id = ?
          AND sender = 'them'
          AND media_type IS NOT NULL
          AND (media_url IS NULL OR TRIM(media_url) = '')
        ORDER BY timestamp DESC
        LIMIT ?;`,
      [chatId, limit]
    );
    return (rows as { id: string }[]).map((row) => row.id).filter(Boolean);
  }

  async getMessageById(messageId: string): Promise<QueuedMessage | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT * FROM messages WHERE id = ? LIMIT 1;`, [messageId]);
    return row ? rowToQueuedMessage(row) : null;
  }

  async searchMessages(chatId: string, query: string, limit = 50): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM messages WHERE chat_id = ? AND text LIKE ? ORDER BY timestamp DESC LIMIT ?;`,
      [chatId, `%${query}%`, limit]
    );
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getAllMessages(): Promise<QueuedMessage[]> {
    console.warn('[LocalDBService] Using getAllMessages (DANGER: potentially slow)');
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM messages ORDER BY timestamp ASC;`);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  /**
   * Fetches the latest N messages from every chat to populate the preview list
   * without loading 50,000 messages.
   */
  async getLatestMessagesSummary(limitPerChat = 1): Promise<QueuedMessage[]> {
    const db = await getDb();
    // Complex SQL to get N latest per chat
    const rows = await db.getAllAsync(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp DESC) as rn
        FROM messages
      ) WHERE rn <= ?;
    `, [limitPerChat]);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async updateMessageStatus(messageId: string, status: MessageStatus): Promise<void> {
    const db = await getDb();
    // FIX #16: Update delivered_at/read_at timestamps for acknowledgment tracking
    let sql = `UPDATE messages SET status = ? WHERE id = ?;`;
    const params: any[] = [status, messageId];

    if (status === 'delivered') {
      sql = `UPDATE messages SET status = ?, delivered_at = ? WHERE id = ?;`;
      params[0] = status;
      params[1] = new Date().toISOString();
      params[2] = messageId;
    } else if (status === 'read') {
      sql = `UPDATE messages SET status = ?, read_at = ? WHERE id = ?;`;
      params[0] = status;
      params[1] = new Date().toISOString();
      params[2] = messageId;
    }

    await db.runAsync(sql, params);
  }

  // FIX #16: Get message acknowledgment timestamps
  async getMessageAcknowledgments(messageId: string): Promise<{ deliveredAt?: string; readAt?: string } | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ delivered_at: string; read_at: string }>(
      `SELECT delivered_at, read_at FROM messages WHERE id = ? LIMIT 1;`,
      [messageId]
    );
    if (!row) return null;
    return {
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
    };
  }

  // FIX #17: Check for duplicate message using idempotency key
  async findMessageByIdempotencyKey(key: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM messages WHERE idempotency_key = ? LIMIT 1;`,
      [key]
    );
    return row?.id ?? null;
  }

  // FIX #17: Update message with idempotency key
  async updateMessageIdempotencyKey(messageId: string, key: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET idempotency_key = ? WHERE id = ?;`, [key, messageId]);
  }

  async updateMessageMediaUrl(messageId: string, url: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET media_url = ? WHERE id = ?;`, [url, messageId]);
  }

  async updateMessageMediaThumbnail(messageId: string, thumbnail: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET media_thumbnail = ? WHERE id = ?;`, [thumbnail, messageId]);
  }

  async updateMessageLocalUri(messageId: string, uri: string, fileSize?: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET local_file_uri = ?, file_size = ?, media_status = 'downloaded' WHERE id = ?;`, [uri, fileSize ?? null, messageId]);
  }

  async updateMediaStatus(messageId: string, status: 'not_downloaded' | 'downloading' | 'downloaded' | 'failed'): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET media_status = ? WHERE id = ?;`, [status, messageId]);
  }

  async updateMessageId(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;

    await this.runSerializedTransaction(async (db) => {
      // Check if newId already exists (race condition with Realtime broadcast)
      const existing = await db.getFirstAsync(`SELECT id, local_file_uri FROM messages WHERE id = ? LIMIT 1;`, [newId]) as any;
      
      if (existing) {
          console.log(`[LocalDBService] 🔄 Race: serverId ${newId} already exists. Merging metadata...`);
          // Realtime won the race. We need to merge our local metadata (local_file_uri) into the newId row.
          const oldRow = await db.getFirstAsync(`SELECT local_file_uri FROM messages WHERE id = ? LIMIT 1;`, [oldId]) as any;
          if (oldRow?.local_file_uri) {
              await db.runAsync(`UPDATE messages SET local_file_uri = ? WHERE id = ?;`, [oldRow.local_file_uri, newId]);
          }
          // Delete the temp entry since the real one exists
          await db.runAsync(`DELETE FROM messages WHERE id = ?;`, [oldId]);
          console.log(`[LocalDBService] ✅ Merge complete for ${newId}`);
      } else {
          // Normal case: swap the ID
          await db.runAsync(`UPDATE messages SET id = ? WHERE id = ?;`, [newId, oldId]);
          console.log(`[LocalDBService] ✅ Swapped temp ID ${oldId} for server ID ${newId}`);
      }
    });
  }

  async updateMessageRetry(messageId: string, retryCount: number, errorMessage?: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET retry_count = ?, last_retry_at = ?, error_message = ? WHERE id = ?;`, [retryCount, new Date().toISOString(), errorMessage ?? null, messageId]);
  }

  async markMessageAsFailed(messageId: string, reason: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET status = 'failed', error_message = ? WHERE id = ?;`, [reason, messageId]);
  }

  async resetFailedMediaMessages(): Promise<number> {
    const db = await getDb();
    const result = await db.runAsync(
      `UPDATE messages SET status = 'pending', retry_count = 0, error_message = NULL
       WHERE status = 'failed' AND sender = 'me' AND (media_type IS NOT NULL OR local_file_uri IS NOT NULL)
       AND (error_message IS NULL OR error_message NOT LIKE '%Source file deleted%');`
    );
    return result.changes;
  }

  async resetIncompleteOutgoingMediaMessages(): Promise<number> {
    const db = await getDb();
    const result = await db.runAsync(
      `UPDATE messages
       SET status = 'pending',
           is_unsent = 1,
           retry_count = 0,
           error_message = NULL
       WHERE sender = 'me'
         AND media_type IS NOT NULL
         AND (
           local_file_uri IS NOT NULL
           OR (media_thumbnail IS NOT NULL AND media_thumbnail LIKE ?)
         )
         AND (media_url IS NULL OR TRIM(media_url) = '')
         AND status IN ('sent', 'delivered', 'read', 'failed');`
      ,
      [`${MEDIA_GROUP_MARKER}%`]
    );
    return result.changes;
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
    await db.runAsync('UPDATE messages SET reaction = ? WHERE id = ?', [emoji, messageId]);
  }

  async deleteMessage(messageId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM messages WHERE id = ?', [messageId]);
  }

  async deleteChat(chatId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM messages WHERE chat_id = ?;`, [chatId]);
  }

  async deleteContact(contactId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM contacts WHERE id = ?;`, [contactId]);
  }

  async getContacts(): Promise<any[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM contacts ORDER BY name ASC;`);
    return (rows as any[]).map(r => ({ 
        id: r.id, 
        name: r.name, 
        avatar: r.avatar ?? '', 
        avatarType: r.avatar_type ?? 'default',
        teddyVariant: r.teddy_variant ?? undefined,
        status: r.status ?? 'offline', 
        lastMessage: r.last_message ?? '', 
        unreadCount: r.unread_count ?? 0, 
        about: r.about ?? r.bio ?? '', 
        lastSeen: r.last_seen ?? undefined,
        updatedAt: r.updated_at ?? undefined,
        note: r.note ?? undefined,
        noteTimestamp: r.note_timestamp ?? undefined,
        localAvatarUri: r.local_avatar_uri ?? undefined,
        avatarUpdatedAt: r.avatar_updated_at ?? undefined,
        isArchived: r.is_archived === 1,
        isGroup: r.is_group === 1
    }));
  }

  async getContact(id: string): Promise<any | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT * FROM contacts WHERE id = ? LIMIT 1;`, [id]) as any;
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        avatar: row.avatar ?? '',
        avatarType: row.avatar_type ?? 'default',
        teddyVariant: row.teddy_variant ?? undefined,
        localAvatarUri: row.local_avatar_uri ?? undefined,
        avatarUpdatedAt: row.avatar_updated_at ?? undefined,
        updatedAt: row.updated_at ?? undefined,
        isArchived: row.is_archived === 1,
        isGroup: row.is_group === 1
    };
  }

  async updateContactAvatar(id: string, localUri: string, updatedAt: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE contacts SET local_avatar_uri = ?, avatar_updated_at = ? WHERE id = ?;`,
      [localUri, updatedAt, id]
    );
  }

  async saveContact(contact: any): Promise<void> {
    await this.saveContactsBatch([contact]);
  }

  async saveContactsBatch(contacts: any[]): Promise<void> {
    if (!contacts.length) return;

    let myUuid: string | null = null;
    try {
      const cachedId = await require('@react-native-async-storage/async-storage').default.getItem('ss_current_user');
      myUuid = cachedId;
    } catch (e) {}

    const { LEGACY_TO_UUID: MAPPING } = require('../config/supabase');

    await this.runSerializedTransaction(async (db) => {
      const statement = await db.prepareAsync(
        `INSERT INTO contacts 
            (id, name, avatar, avatar_type, teddy_variant, status, last_message, unread_count, about, last_seen, last_synced_at, updated_at, note, note_timestamp, local_avatar_uri, avatar_updated_at, is_group) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            avatar = COALESCE(excluded.avatar, contacts.avatar),
            avatar_type = COALESCE(excluded.avatar_type, contacts.avatar_type),
            teddy_variant = COALESCE(excluded.teddy_variant, contacts.teddy_variant),
            status = excluded.status,
            last_message = excluded.last_message,
            unread_count = excluded.unread_count,
            about = excluded.about,
            last_seen = excluded.last_seen,
            last_synced_at = excluded.last_synced_at,
            updated_at = excluded.updated_at,
            note = excluded.note,
            note_timestamp = excluded.note_timestamp,
            local_avatar_uri = COALESCE(excluded.local_avatar_uri, contacts.local_avatar_uri),
            avatar_updated_at = COALESCE(excluded.avatar_updated_at, contacts.avatar_updated_at),
            is_group = excluded.is_group;`
      );

      try {
        for (const contact of contacts) {
          const cid = MAPPING[contact.id] || contact.id;
          const mid = myUuid ? (MAPPING[myUuid] || myUuid) : null;
          
          if (cid === mid) continue;

          await statement.executeAsync([
            contact.id,
            contact.name,
            contact.avatar ?? null,
            contact.avatarType ?? 'default',
            contact.teddyVariant ?? null,
            contact.status ?? 'offline',
            contact.lastMessage ?? null,
            contact.unreadCount ?? 0,
            contact.about ?? null,
            contact.lastSeen ?? null,
            new Date().toISOString(),
            contact.updatedAt ?? null,
            contact.note ?? null,
            contact.noteTimestamp ?? null,
            contact.localAvatarUri ?? null,
            contact.avatarUpdatedAt ?? null,
            contact.isGroup ? 1 : 0
          ]);
        }
      } finally {
        await statement.finalizeAsync();
      }
    });
  }

  async setContactArchived(userId: string, archived: boolean): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE contacts SET is_archived = ? WHERE id = ?;', [archived ? 1 : 0, userId]);
  }

  async getStatuses(): Promise<any[]> {
    const db = await getDb();
    return await db.getAllAsync(`SELECT * FROM cached_statuses WHERE expires_at > ? ORDER BY created_at DESC;`, [Date.now()]);
  }

  async saveStatus(status: any): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO cached_statuses (id, user_id, media_type, media_key, media_local_path, caption, created_at, expires_at, is_mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`, 
      [status.id, status.userId, status.mediaType, status.mediaKey ?? null, status.mediaLocalPath ?? null, status.caption ?? null, status.createdAt, status.expiresAt, status.isMine ? 1 : 0]
    );
  }

  async deleteStatus(statusId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`DELETE FROM cached_statuses WHERE id = ?;`, [statusId]);
  }

  async markStatusAsSeen(statusId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE cached_statuses SET is_seen = 1 WHERE id = ?;`, [statusId]);
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
    await this.runSerializedTransaction(async (db) => {
      await db.runAsync(`INSERT OR REPLACE INTO media_downloads (message_id, remote_url, local_uri, file_size) VALUES (?, ?, ?, ?);`, [messageId, remoteUrl, localUri, fileSize ?? null]);
      await db.runAsync(`UPDATE messages SET local_file_uri = ? WHERE id = ?;`, [localUri, messageId]);
    });
  }

  async getMediaDownload(messageId: string): Promise<string | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT local_uri FROM media_downloads WHERE message_id = ? LIMIT 1;`, [messageId]) as any;
    return row?.local_uri ?? null;
  }

  async clearChat(partnerId: string): Promise<void> {
    console.log(`[LocalDBService] clearChat for partnerId: ${partnerId}`);
    try {
      await this.runSerializedTransaction(async (db) => {
        console.log(`[LocalDBService] clearChat: deleting messages...`);
        await db.runAsync(`DELETE FROM messages WHERE chat_id = ?;`, [partnerId]);
        console.log(`[LocalDBService] clearChat: updating contacts...`);
        await db.runAsync(`UPDATE contacts SET last_message = '', unread_count = 0, is_archived = 0 WHERE id = ?;`, [partnerId]);
        console.log(`[LocalDBService] clearChat: deleting chat...`);
        await db.runAsync(`DELETE FROM chats WHERE id = ?;`, [partnerId]);
      });
      console.log(`[LocalDBService] clearChat: transaction committed.`);
    } catch (e) {
      console.error(`[LocalDBService] clearChat transaction failed:`, e);
      throw e;
    }
  }

  async removePendingSyncOpsForEntity(entityType: string, entityId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `DELETE FROM pending_sync_ops WHERE entity_type = ? AND entity_id = ?;`,
      [entityType, entityId]
    );
  }

  async getPendingSyncOps(entityType?: string): Promise<PendingSyncOperation[]> {
    const db = await getDb();
    const rows = entityType
      ? await db.getAllAsync(
          `SELECT * FROM pending_sync_ops WHERE entity_type = ? ORDER BY created_at ASC;`,
          [entityType]
        )
      : await db.getAllAsync(`SELECT * FROM pending_sync_ops ORDER BY created_at ASC;`);

    return (rows as any[]).map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      opType: row.op_type,
      payload: (() => {
        try {
          return JSON.parse(row.payload ?? '{}');
        } catch {
          return {};
        }
      })(),
      createdAt: row.created_at,
      retryCount: row.retry_count ?? 0,
    }));
  }

  /**
   * Migrate legacy usernames to UUIDs in the local database.
   * This handles the "disappearing history" issue when transitioning to Supabase UUIDs.
   */
  async migrateLegacyIds(mapping: Record<string, string>): Promise<void> {
    const db = await getDb();
    const legacyIds = Object.keys(mapping);
    if (legacyIds.length === 0) return;

    // Check if any legacy IDs actually exist in the DB before locking everything
    try {
      const placeholders = legacyIds.map(() => '?').join(',');
      const countResult = await db.getFirstAsync(
        `SELECT COUNT(*) as cnt FROM messages WHERE chat_id IN (${placeholders}) OR receiver IN (${placeholders})`,
        [...legacyIds, ...legacyIds]
      );
      
      const contactCountResult = await db.getFirstAsync(
        `SELECT COUNT(*) as cnt FROM contacts WHERE id IN (${placeholders})`,
        legacyIds
      );

      const totalPending = ((countResult as any)?.cnt || 0) + ((contactCountResult as any)?.cnt || 0);
      if (totalPending === 0) {
        console.log('[SQLite] No legacy IDs found to migrate.');
        return;
      }
      
      console.log(`[SQLite] Found ${totalPending} legacy records. Starting migration...`);
    } catch (checkErr) {
      console.warn('[SQLite] Preliminary migration check failed (table might not exist yet):', checkErr);
      // Fail open and allow the transaction to try/fail normally
    }
    
    await this.runSerializedTransaction(async (db) => {
      for (const [legacyId, uuid] of Object.entries(mapping)) {
        // 1. Update messages table (no unique constraint on chat_id/receiver)
        await db.runAsync(
          'UPDATE messages SET chat_id = ? WHERE chat_id = ?',
          [uuid, legacyId]
        );
        await db.runAsync(
          'UPDATE messages SET receiver = ? WHERE receiver = ?',
          [uuid, legacyId]
        );

        // 2. Update statuses table
        await db.runAsync(
          'UPDATE cached_statuses SET user_id = ? WHERE user_id = ?',
          [uuid, legacyId]
        );

        // 3. Handle contacts table (Primary Key conflict potential)
        const existingUuid = await db.getFirstAsync('SELECT id FROM contacts WHERE id = ?', [uuid]);
        if (existingUuid) {
          console.log(`[SQLite] UUID ${uuid} already exists in contacts. Deleting legacy ${legacyId}.`);
          await db.runAsync('DELETE FROM contacts WHERE id = ?', [legacyId]);
        } else {
          await db.runAsync(
            'UPDATE contacts SET id = ? WHERE id = ?',
            [uuid, legacyId]
          );
        }

        console.log(`[SQLite] Migrated ${legacyId} -> ${uuid}`);
      }
      console.log('[SQLite] Migration completed successfully');
    });
  }

  /**
   * Clears all user-specific data from the local database.
   * Used during logout to prevent data pollution between different accounts.
   */
  async clearDatabase(): Promise<void> {
    console.log('[SQLite] Clearing user database...');
    await this.runSerializedTransaction(async (db) => {
      await db.runAsync('DELETE FROM messages;');
      await db.runAsync('DELETE FROM contacts;');
      await db.runAsync('DELETE FROM chats;');
      await db.runAsync('DELETE FROM cached_statuses;');
      await db.runAsync('DELETE FROM pending_sync_ops;');
      await db.runAsync('DELETE FROM media_downloads;');
      await db.runAsync('DELETE FROM users;');
      await db.runAsync('DELETE FROM connection_requests;');
      await db.runAsync('DELETE FROM connections;');
      await db.runAsync('DELETE FROM avatar_cache;');
      await db.runAsync('DELETE FROM pending_uploads;');
      await db.runAsync('DELETE FROM cached_users;');
      await db.runAsync('DELETE FROM groups;');
      await db.runAsync('DELETE FROM group_members;');
      await db.runAsync('DELETE FROM sync_queue;');
    });
    console.log('[SQLite] Database cleared successfully.');
  }

  // ── Disappearing Messages ──────────────────────────────────────────────────

  async getDisappearingTimer(chatId: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ disappearing_timer: number }>(
      `SELECT disappearing_timer FROM chat_settings WHERE chat_id = ? LIMIT 1;`,
      [chatId]
    );
    return row?.disappearing_timer ?? 0;
  }

  async setDisappearingTimer(chatId: string, timerSeconds: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO chat_settings (chat_id, disappearing_timer, updated_at) VALUES (?, ?, ?);`,
      [chatId, timerSeconds, new Date().toISOString()]
    );
  }

  async startMessageExpiry(messageId: string, timerSeconds: number): Promise<void> {
    const db = await getDb();
    const now = Date.now();
    const expiresAt = now + timerSeconds * 1000;
    await db.runAsync(
      `UPDATE messages SET expire_started_at = ?, expires_at = ?, expire_timer = ? WHERE id = ?;`,
      [now, expiresAt, timerSeconds, messageId]
    );
  }

  async deleteExpiredMessages(): Promise<number> {
    const db = await getDb();
    const now = Date.now();
    const expired = await db.getAllAsync(
      `SELECT id, local_file_uri FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?;`,
      [now]
    ) as any[];

    if (expired.length === 0) return 0;

    const ids = expired.map((m: any) => m.id);
    // Delete in batches of 50
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const placeholders = batch.map(() => '?').join(',');
      await db.runAsync(`DELETE FROM messages WHERE id IN (${placeholders});`, batch);
    }

    console.log(`[SQLite] Deleted ${expired.length} expired messages`);
    return expired.length;
  }

  // ── Persistent Job Queue ───────────────────────────────────────────────────

  async enqueueJob(id: string, type: string, payload: any, priority = 0, maxRetries = 5): Promise<void> {
    const db = await getDb();
    const now = Date.now();
    await db.runAsync(
      `INSERT OR IGNORE INTO job_queue (id, type, payload, priority, max_retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [id, type, JSON.stringify(payload), priority, maxRetries, now, now]
    );
  }

  async getPendingJobs(limit = 20): Promise<any[]> {
    const db = await getDb();
    const now = Date.now();
    return await db.getAllAsync(
      `SELECT * FROM job_queue WHERE state = 'pending' AND next_run_at <= ? ORDER BY priority DESC, created_at ASC LIMIT ?;`,
      [now, limit]
    ) as any[];
  }

  async updateJobState(id: string, state: 'pending' | 'processing' | 'completed' | 'failed', error?: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE job_queue SET state = ?, error = ?, updated_at = ? WHERE id = ?;`,
      [state, error ?? null, Date.now(), id]
    );
  }

  async rescheduleJob(id: string, retryCount: number, delayMs: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE job_queue SET state = 'pending', retry_count = ?, next_run_at = ?, updated_at = ? WHERE id = ?;`,
      [retryCount, Date.now() + delayMs, Date.now(), id]
    );
  }

  async cleanCompletedJobs(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `DELETE FROM job_queue WHERE state = 'completed' AND updated_at < ?;`,
      [Date.now() - olderThanMs]
    );
  }
}

export const offlineService = new OfflineService();
