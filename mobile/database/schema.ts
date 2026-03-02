/**
 * SQLite Schema — WhatsApp-style Offline-First Architecture
 *
 * Every operation writes to SQLite FIRST, syncs to server second.
 * UI always reads from local storage.
 *
 * Tables: users, contacts, chats, messages, upload_queue, sync_queue,
 *         media_downloads, my_statuses, received_statuses, text_statuses
 */

const SCHEMA_VERSION = 2;

export const MIGRATE_DB = async (db: any) => {
  // ── WAL mode: 2-3x faster reads, concurrent read/write ──────────
  try {
    await db.execAsync('PRAGMA journal_mode = WAL;');
  } catch (e) {
    console.warn('[SQLite] Failed to set WAL mode:', e);
  }

  const queries = [
    // ── Table 1: users ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      bio TEXT,
      last_synced_at TEXT
    );`,

    // ── Table 2: contacts ───────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      bio TEXT,
      status TEXT DEFAULT 'offline',
      last_message TEXT,
      unread_count INTEGER DEFAULT 0,
      last_synced_at TEXT
    );`,

    // ── Table 3: chats ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS chats (
      id                TEXT PRIMARY KEY,
      name              TEXT,
      type              TEXT DEFAULT 'direct',
      last_message      TEXT,
      last_message_time INTEGER,
      last_message_type TEXT,
      unread_count      INTEGER DEFAULT 0,
      avatar_local_path TEXT,
      avatar_remote_url TEXT,
      synced            INTEGER DEFAULT 0,
      updated_at        INTEGER
    );`,

    // ── Table 4: messages ───────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS messages (
      id                    TEXT PRIMARY KEY NOT NULL,
      chat_id               TEXT NOT NULL,
      sender                TEXT NOT NULL,
      text                  TEXT,
      type                  TEXT DEFAULT 'text',
      media_type            TEXT,
      media_url             TEXT,
      media_caption         TEXT,
      reply_to_id           TEXT,
      timestamp             TEXT NOT NULL,
      status                TEXT DEFAULT 'sending',
      is_unsent             INTEGER DEFAULT 0,
      retry_count           INTEGER DEFAULT 0,
      last_retry_at         TEXT,
      error_message         TEXT,
      created_at            TEXT DEFAULT CURRENT_TIMESTAMP,
      -- Offline media support
      media_local_path      TEXT,
      media_remote_url      TEXT,
      media_thumbnail_path  TEXT,
      media_size            INTEGER,
      media_duration        INTEGER,
      media_mime_type       TEXT,
      media_download_status TEXT DEFAULT 'none',
      local_file_uri        TEXT,
      media_status          TEXT DEFAULT 'not_downloaded',
      thumbnail_uri         TEXT,
      file_size             INTEGER,
      mime_type             TEXT,
      synced                INTEGER DEFAULT 0,
      reaction              TEXT,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );`,

    // ── Table 5: upload_queue ───────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS upload_queue (
      id            TEXT PRIMARY KEY,
      message_id    TEXT NOT NULL,
      local_path    TEXT NOT NULL,
      remote_path   TEXT,
      status        TEXT DEFAULT 'pending',
      retry_count   INTEGER DEFAULT 0,
      max_retries   INTEGER DEFAULT 3,
      created_at    INTEGER NOT NULL,
      last_tried_at INTEGER
    );`,

    // ── Table 6: sync_queue (generic actions) ───────────────────────
    `CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      retry_count INTEGER DEFAULT 0
    );`,

    // ── Table 7: media_downloads ────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS media_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      remote_url TEXT NOT NULL,
      local_uri TEXT NOT NULL,
      file_size INTEGER,
      downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );`,

    // ── Table 8: my_statuses ────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS my_statuses (
      id                  TEXT PRIMARY KEY,
      type                TEXT DEFAULT 'image',
      media_local_path    TEXT,
      media_remote_url    TEXT,
      thumbnail_path      TEXT,
      caption             TEXT,
      view_count          INTEGER DEFAULT 0,
      synced              INTEGER DEFAULT 0,
      created_at          INTEGER NOT NULL,
      expires_at          INTEGER NOT NULL
    );`,

    // ── Table 9: received_statuses ──────────────────────────────────
    `CREATE TABLE IF NOT EXISTS received_statuses (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      user_name           TEXT,
      user_avatar_path    TEXT,
      type                TEXT DEFAULT 'image',
      media_local_path    TEXT,
      media_remote_url    TEXT,
      thumbnail_path      TEXT,
      caption             TEXT,
      is_viewed           INTEGER DEFAULT 0,
      viewed_at           INTEGER,
      media_download_status TEXT DEFAULT 'pending',
      synced              INTEGER DEFAULT 0,
      created_at          INTEGER NOT NULL,
      expires_at          INTEGER NOT NULL
    );`,

    // ── Table 10: text_statuses ─────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS text_statuses (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      user_name       TEXT,
      user_avatar_path TEXT,
      text_content    TEXT NOT NULL,
      bg_type         TEXT DEFAULT 'solid',
      bg_color        TEXT DEFAULT '#2D6A4F',
      bg_gradient     TEXT,
      text_color      TEXT DEFAULT '#FFFFFF',
      font_size       INTEGER DEFAULT 24,
      font_style      TEXT DEFAULT 'normal',
      text_align      TEXT DEFAULT 'center',
      is_viewed       INTEGER DEFAULT 0,
      viewed_at       INTEGER,
      view_count      INTEGER DEFAULT 0,
      is_mine         INTEGER DEFAULT 0,
      synced          INTEGER DEFAULT 0,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL
    );`,

    // ── Indexes ─────────────────────────────────────────────────────
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_messages_media_status ON messages(media_status);`,
    `CREATE INDEX IF NOT EXISTS idx_messages_synced ON messages(synced);`,
    `CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON sync_queue(created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_upload_queue_status ON upload_queue(status);`,
    `CREATE INDEX IF NOT EXISTS idx_my_statuses_expires ON my_statuses(expires_at);`,
    `CREATE INDEX IF NOT EXISTS idx_received_statuses_user ON received_statuses(user_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_text_status_user ON text_statuses(user_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);`,
  ];

  // Columns to add to existing messages table (safe migration for existing installs)
  const alterQueries = [
    'ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0;',
    'ALTER TABLE messages ADD COLUMN last_retry_at TEXT;',
    'ALTER TABLE messages ADD COLUMN error_message TEXT;',
    'ALTER TABLE messages ADD COLUMN local_file_uri TEXT;',
    "ALTER TABLE messages ADD COLUMN media_status TEXT DEFAULT 'not_downloaded';",
    'ALTER TABLE messages ADD COLUMN thumbnail_uri TEXT;',
    'ALTER TABLE messages ADD COLUMN file_size INTEGER;',
    'ALTER TABLE messages ADD COLUMN mime_type TEXT;',
    'ALTER TABLE messages ADD COLUMN media_local_path TEXT;',
    'ALTER TABLE messages ADD COLUMN media_remote_url TEXT;',
    'ALTER TABLE messages ADD COLUMN media_thumbnail_path TEXT;',
    'ALTER TABLE messages ADD COLUMN media_size INTEGER;',
    'ALTER TABLE messages ADD COLUMN media_duration INTEGER;',
    'ALTER TABLE messages ADD COLUMN media_mime_type TEXT;',
    "ALTER TABLE messages ADD COLUMN media_download_status TEXT DEFAULT 'none';",
    'ALTER TABLE messages ADD COLUMN synced INTEGER DEFAULT 0;',
    "ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text';",
    'ALTER TABLE messages ADD COLUMN reaction TEXT;',
  ];

  try {
    for (const query of queries) {
      try {
        await db.execAsync(query);
      } catch (e) {
        // Ignore errors from CREATE TABLE IF NOT EXISTS
      }
    }

    // Safe column additions (will fail silently if they already exist)
    for (const alterQuery of alterQueries) {
      try {
        await db.execAsync(alterQuery);
      } catch (e) {
        // Column already exists, ignore
      }
    }

    console.log(`[SQLite] Database schema v${SCHEMA_VERSION} initialized — ${queries.length} tables, WAL mode enabled.`);
  } catch (error) {
    console.error('[SQLite] Migration failed:', error);
    throw error;
  }
};
