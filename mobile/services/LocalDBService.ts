// mobile/services/LocalDBService.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL DATABASE SERVICE  (Single Source of Truth)
// ─────────────────────────────────────────────────────────────────────────────

import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { MIGRATE_DB } from '../database/schema';
import { dbManager } from '../database/DatabaseManager';

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

export interface PendingSyncOperation {
  id: number;
  entityType: string;
  entityId: string;
  opType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retryCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'soul_messages.db';
const OLD_DB_NAME = 'soulsync.db';

async function ensureDatabaseMigration(): Promise<void> {
  try {
    const dbDir = `${FileSystem.documentDirectory}SQLite/`;
    const oldPath = `${dbDir}${OLD_DB_NAME}`;
    const newPath = `${dbDir}${DB_NAME}`;

    const oldInfo = await FileSystem.getInfoAsync(oldPath);
    const newInfo = await FileSystem.getInfoAsync(newPath);

    if (oldInfo.exists && !newInfo.exists) {
      console.log(`[SQLite] Migrating ${OLD_DB_NAME} -> ${DB_NAME}`);
      await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });
      await FileSystem.moveAsync({ from: oldPath, to: newPath });
      console.log('[SQLite] Database migration successful');
    }
  } catch (error) {
    console.warn('[SQLite] Database migration check failed:', error);
  }
}

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  await ensureDatabaseMigration();

  return dbManager.getDatabase({
    name: DB_NAME,
    migrations: MIGRATE_DB,
    onOpen: async (db) => {
      // Removed integrity check: too slow for startup (watchdog violation)
      // await checkDatabaseIntegrity(db);
      // FIX #19: Setup periodic WAL checkpoint to prevent data loss on crash
      setupWalCheckpoint(db);
    }
  });
}



// FIX #19: Periodic WAL checkpoint to prevent data loss on crash
let checkpointInterval: NodeJS.Timeout | null = null;

function setupWalCheckpoint(db: SQLite.SQLiteDatabase): void {
  // Run checkpoint every 30 seconds to consolidate WAL data
  if (checkpointInterval) {
    clearInterval(checkpointInterval);
  }

  checkpointInterval = setInterval(async () => {
    try {
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
      console.log('[SQLite] WAL checkpoint completed');
    } catch (error) {
      console.warn('[SQLite] WAL checkpoint failed:', error);
    }
  }, 30000);
}

function rowToQueuedMessage(row: any): QueuedMessage {
  let media: QueuedMessage['media'] | undefined;
  if (row.media_url != null || row.media_type || row.local_file_uri) {
    media = {
      type: row.media_type ?? 'image',
      url: row.media_url ?? '',
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
    retryCount: row.retry_count ?? 0,
    lastRetryAt: row.last_retry_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    localFileUri: row.local_file_uri ?? undefined,
  };
}

class OfflineService {
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
    const db = await getDb();
    const receiver = msg.sender === 'me' ? chatId : 'me';
    
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO messages
           (id, chat_id, sender, receiver, text,
            media_type, media_url, media_caption, media_thumbnail,
            reply_to_id, timestamp, status, local_file_uri, is_unsent, media_duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           media_url = COALESCE(excluded.media_url, messages.media_url),
           media_thumbnail = COALESCE(excluded.media_thumbnail, messages.media_thumbnail),
           local_file_uri = COALESCE(messages.local_file_uri, excluded.local_file_uri);`,
        [msg.id, chatId, msg.sender, receiver, msg.text ?? '', msg.media?.type ?? null, msg.media?.url ?? null, msg.media?.caption ?? null, msg.media?.thumbnail ?? null, msg.replyTo ?? null, msg.timestamp, msg.status ?? 'delivered', msg.localFileUri ?? null, msg.media?.duration ?? null]
      );

      const preview = msg.text?.trim() || (msg.media ? 'Media' : '');
      await this.upsertChatSummary(chatId, preview, msg.timestamp, msg.sender === 'them' ? 1 : 0);
    });
  }

  async savePendingMessage(chatId: string, msg: QueuedMessage): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO messages
           (id, chat_id, sender, receiver, text,
            media_type, media_url, media_caption, media_thumbnail,
            reply_to_id, timestamp, status, retry_count, local_file_uri, is_unsent, media_duration)
         VALUES (?, ?, 'me', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET 
           status = 'pending', 
           is_unsent = 1,
           media_url = COALESCE(excluded.media_url, messages.media_url),
           media_thumbnail = COALESCE(excluded.media_thumbnail, messages.media_thumbnail),
           local_file_uri = COALESCE(messages.local_file_uri, excluded.local_file_uri);`,
        [msg.id, chatId, chatId, msg.text ?? '', msg.media?.type ?? null, msg.media?.url ?? null, msg.media?.caption ?? null, msg.media?.thumbnail ?? null, msg.replyTo ?? null, msg.timestamp, msg.localFileUri ?? null, msg.media?.duration ?? null]
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
    const rows = await db.getAllAsync(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT ?;`, [chatId, limit]);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getPendingMessages(): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM messages WHERE status = 'pending' OR status = 'failed' ORDER BY timestamp ASC;`);
    return (rows as any[]).map(rowToQueuedMessage);
  }

  async getMessageById(messageId: string): Promise<QueuedMessage | null> {
    const db = await getDb();
    const row = await db.getFirstAsync(`SELECT * FROM messages WHERE id = ? LIMIT 1;`, [messageId]);
    return row ? rowToQueuedMessage(row) : null;
  }

  async getAllMessages(): Promise<QueuedMessage[]> {
    const db = await getDb();
    const rows = await db.getAllAsync(`SELECT * FROM messages ORDER BY timestamp ASC;`);
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

  async updateMessageLocalUri(messageId: string, uri: string, fileSize?: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET local_file_uri = ?, file_size = ?, media_status = 'downloaded' WHERE id = ?;`, [uri, fileSize ?? null, messageId]);
  }

  async updateMediaStatus(messageId: string, status: 'not_downloaded' | 'downloading' | 'downloaded' | 'failed'): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE messages SET media_status = ? WHERE id = ?;`, [status, messageId]);
  }

  async updateMessageId(oldId: string, newId: string): Promise<void> {
    const db = await getDb();
    if (oldId === newId) return;

    await db.withTransactionAsync(async () => {
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
        noteTimestamp: r.note_timestamp ?? undefined
    }));
  }

  async saveContact(contact: any): Promise<void> {
    const db = await getDb();
    
    // SAFEGUARD: Never save the current user to the contacts table!
    // We try to get the current user ID from AsyncStorage to be sure.
    try {
      const cachedUserId = await require('@react-native-async-storage/async-storage').default.getItem('ss_current_user');
      const myId = cachedUserId;
      if (myId) {
        const { LEGACY_TO_UUID } = require('../config/supabase');
        const cid = LEGACY_TO_UUID[contact.id] || contact.id;
        const mid = LEGACY_TO_UUID[myId] || myId;
        if (cid === mid) {
          console.log('[SQLite] Blocking self-contact save for:', contact.id);
          return;
        }
      }
    } catch (e) {
      console.warn('[SQLite] saveContact self-filter check failed (ignoring):', e);
    }

    await db.runAsync(
        `INSERT OR REPLACE INTO contacts 
            (id, name, avatar, avatar_type, teddy_variant, status, last_message, unread_count, about, last_seen, last_synced_at, updated_at, note, note_timestamp) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`, 
        [
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
            contact.noteTimestamp ?? null
        ]
    );
  }

  async setContactArchived(userId: string, archived: boolean): Promise<void> {
    const db = await getDb();
    await db.runAsync('UPDATE contacts SET is_archived = ? WHERE id = ?;', [archived ? 1 : 0, userId]);
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
    await db.withTransactionAsync(async () => {
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
    const db = await getDb();
    await db.execAsync('BEGIN TRANSACTION;');
    try {
      await db.runAsync(`DELETE FROM messages WHERE chat_id = ?;`, [partnerId]);
      await db.runAsync(`UPDATE contacts SET last_message = '', unread_count = 0, is_archived = 0 WHERE id = ?;`, [partnerId]);
      await db.runAsync(`DELETE FROM chats WHERE id = ?;`, [partnerId]);
      await db.execAsync('COMMIT;');
    } catch (e) {
      await db.execAsync('ROLLBACK;');
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
    
    await db.execAsync('BEGIN TRANSACTION;');
    try {
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
          'UPDATE statuses SET user_id = ? WHERE user_id = ?',
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
      await db.execAsync('COMMIT;');
      console.log('[SQLite] Migration completed successfully');
    } catch (e) {
      await db.execAsync('ROLLBACK;');
      console.error('[SQLite] Migration failed:', e);
      throw e;
    }
  }

  /**
   * Clears all user-specific data from the local database.
   * Used during logout to prevent data pollution between different accounts.
   */
  async clearDatabase(): Promise<void> {
    const db = await getDb();
    console.log('[SQLite] Clearing user database...');
    await db.execAsync('BEGIN TRANSACTION;');
    try {
      await db.runAsync('DELETE FROM messages;');
      await db.runAsync('DELETE FROM contacts;');
      await db.runAsync('DELETE FROM chats;');
      await db.runAsync('DELETE FROM statuses;');
      await db.runAsync('DELETE FROM pending_sync_ops;');
      await db.runAsync('DELETE FROM media_downloads;');
      await db.execAsync('COMMIT;');
      console.log('[SQLite] Database cleared successfully.');
    } catch (e) {
      await db.execAsync('ROLLBACK;');
      console.error('[SQLite] Failed to clear database:', e);
      throw e;
    }
  }
}

export const offlineService = new OfflineService();
