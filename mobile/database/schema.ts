/**
 * SQLite Schema — WhatsApp-style Offline-First Architecture
 *
 * Every operation writes to SQLite FIRST, syncs to server second.
 * UI always reads from local storage.
 */

const SCHEMA_VERSION = 4;

export const MIGRATE_DB = async (db: any) => {
  // ── WAL mode: 2-3x faster reads, concurrent read/write ──────────
  try {
    await db.execAsync('PRAGMA journal_mode = WAL;');
  } catch (e) {
    console.warn('[SQLite] Failed to set WAL mode:', e);
  }

  // ── Migration: drop old-schema messages table (had conversation_id instead of chat_id) ──
  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(messages);`);
    const colNames = (cols as any[]).map((c: any) => c.name);
    if (colNames.length > 0 && !colNames.includes('chat_id')) {
      console.log('[SQLite] Old messages schema detected (missing chat_id) — recreating table...');
      await db.execAsync('DROP TABLE IF EXISTS messages;');
      await db.execAsync('DROP INDEX IF EXISTS idx_messages_chat_id;');
      await db.execAsync('DROP INDEX IF EXISTS idx_messages_status;');
    }
  } catch (e) {
    console.warn('[SQLite] Schema check failed, will try CREATE anyway:', e);
  }

  const queries = [
    // ── contacts ─────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      bio TEXT,
      status TEXT DEFAULT 'offline',
      last_synced_at TEXT
    );`,

    // ── messages (matches LocalDBService column names) ───────────────
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT,
      media_type TEXT,
      media_url TEXT,
      media_caption TEXT,
      reply_to_id TEXT,
      timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      is_unsent INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      last_retry_at TEXT,
      error_message TEXT,
      local_file_uri TEXT,
      media_status TEXT DEFAULT 'not_downloaded',
      thumbnail_uri TEXT,
      file_size INTEGER,
      mime_type TEXT,
      reaction TEXT
    );`,

    // ── statuses ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS statuses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      r2_key TEXT,
      local_path TEXT,
      type TEXT DEFAULT 'image',
      text_content TEXT,
      background_color TEXT,
      viewers TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      is_mine INTEGER DEFAULT 0,
      is_seen INTEGER DEFAULT 0
    );`,

    // ── media_downloads ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS media_downloads (
      message_id TEXT PRIMARY KEY,
      remote_url TEXT NOT NULL,
      local_uri TEXT NOT NULL,
      file_size INTEGER,
      downloaded_at TEXT NOT NULL
    );`,

    // ── pending_sync ─────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS pending_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retry_count INTEGER DEFAULT 0
    );`,

    // ── Indexes ─────────────────────────────────────────────────────
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, timestamp DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);`,
    `CREATE INDEX IF NOT EXISTS idx_statuses_expires ON statuses(expires_at);`,
    `CREATE INDEX IF NOT EXISTS idx_sync_action ON pending_sync(action);`,
  ];

  try {
    for (const query of queries) {
      try {
        await db.execAsync(query);
      } catch (e) {
        console.warn('[SQLite] Query failed:', query, e);
      }
    }

    // Migration: add columns that may be missing on older installations
    const alterQueries = [
      `ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0;`,
      `ALTER TABLE messages ADD COLUMN last_retry_at TEXT;`,
      `ALTER TABLE messages ADD COLUMN error_message TEXT;`,
      `ALTER TABLE messages ADD COLUMN local_file_uri TEXT;`,
      `ALTER TABLE messages ADD COLUMN media_status TEXT DEFAULT 'not_downloaded';`,
      `ALTER TABLE messages ADD COLUMN thumbnail_uri TEXT;`,
      `ALTER TABLE messages ADD COLUMN file_size INTEGER;`,
      `ALTER TABLE messages ADD COLUMN mime_type TEXT;`,
      `ALTER TABLE messages ADD COLUMN reaction TEXT;`,
      `ALTER TABLE statuses ADD COLUMN is_seen INTEGER DEFAULT 0;`,
    ];

    for (const alterQuery of alterQueries) {
      try {
        await db.execAsync(alterQuery);
      } catch (e) {
        // Column already exists — expected, ignore
      }
    }

    console.log(`[SQLite] Database schema v${SCHEMA_VERSION} initialized — WAL mode enabled.`);
  } catch (error) {
    console.error('[SQLite] Migration failed:', error);
    throw error;
  }
};
