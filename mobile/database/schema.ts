// mobile/database/schema.ts
// ─────────────────────────────────────────────────────────────────────────────
// VERSIONED MIGRATION SYSTEM
//
// HOW IT WORKS:
//   - We keep a `db_version` table that stores one row: the current schema version.
//   - Every time we add a column, change a constraint, or add a table, we bump
//     DB_TARGET_VERSION by 1 and add a new migration block inside runMigrations().
//   - On first install:  runs ALL migrations from v0 → latest.
//   - On update:         only runs the NEW migrations the user hasn't seen yet.
//   - On fresh launch:   reads version, sees it matches target, does nothing.
//
// WHY NOT DROP & RECREATE?
//   - Dropping tables deletes user data permanently.
//   - The old comment said "Drops and recreates" but the code never did — it was
//     a lie that would confuse any future developer.
//   - This versioned approach is what WhatsApp, Telegram, etc. actually use.
// ─────────────────────────────────────────────────────────────────────────────

// ⬆️  Bump this number every time you change the schema.
const DB_TARGET_VERSION = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helper — read the stored schema version (returns 0 if brand-new install)
// ─────────────────────────────────────────────────────────────────────────────
async function getCurrentVersion(db: any): Promise<number> {
  try {
    // Create the version-tracker table if it has never existed
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS db_version (
        version INTEGER NOT NULL DEFAULT 0
      );
    `);

    const row = await db.getFirstAsync(`SELECT version FROM db_version LIMIT 1;`);
    if (!row) {
      // First install — insert the starting row
      await db.runAsync(`INSERT INTO db_version (version) VALUES (0);`);
      return 0;
    }
    return (row as any).version as number;
  } catch (e) {
    console.error('[SQLite] Could not read db_version:', e);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — save the new version after a migration succeeds
// ─────────────────────────────────────────────────────────────────────────────
async function setVersion(db: any, version: number): Promise<void> {
  await db.runAsync(`UPDATE db_version SET version = ?;`, [version]);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v1 — Initial schema (all base tables)
//
// FIX vs old code:
//   - Added `receiver TEXT NOT NULL` column to `messages` so ChatService can
//     query "messages sent to me" without a schema mismatch crash.
//   - Kept ON UPDATE CASCADE on media_downloads (was already correct).
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v1(db: any): Promise<void> {
  const statements = [
    // ── users ──────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY NOT NULL,
      name           TEXT NOT NULL,
      avatar         TEXT,
      bio            TEXT,
      last_synced_at TEXT
    );`,

    // ── contacts ───────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS contacts (
      id             TEXT PRIMARY KEY NOT NULL,
      name           TEXT NOT NULL,
      avatar         TEXT,
      bio            TEXT,
      status         TEXT    DEFAULT 'offline',
      last_message   TEXT,
      unread_count   INTEGER DEFAULT 0,
      last_synced_at TEXT
    );`,

    // ── messages ───────────────────────────────────────────────────────────
    // NOTE: Both `sender` AND `receiver` columns exist so ChatService queries
    //       like  .or(`sender.eq.X,receiver.eq.Y`)  work without crashing.
    `CREATE TABLE IF NOT EXISTS messages (
      id             TEXT    PRIMARY KEY NOT NULL,
      chat_id        TEXT    NOT NULL,
      sender         TEXT    NOT NULL,
      receiver       TEXT    NOT NULL,
      text           TEXT,
      media_type     TEXT,
      media_url      TEXT,
      media_caption  TEXT,
      reply_to_id    TEXT,
      timestamp      TEXT    NOT NULL,
      status         TEXT    DEFAULT 'pending',
      is_unsent      INTEGER DEFAULT 0,
      retry_count    INTEGER DEFAULT 0,
      last_retry_at  TEXT,
      error_message  TEXT,
      created_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
      local_file_uri TEXT,
      media_status   TEXT    DEFAULT 'not_downloaded',
      thumbnail_uri  TEXT,
      file_size      INTEGER,
      mime_type      TEXT
    );`,

    // ── sync_queue ─────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS sync_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      retry_count INTEGER DEFAULT 0
    );`,

    // ── media_downloads ────────────────────────────────────────────────────
    // ON UPDATE CASCADE: when an offline message gets its real server ID,
    // this row's message_id updates automatically — no broken links.
    `CREATE TABLE IF NOT EXISTS media_downloads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL UNIQUE,
      remote_url    TEXT NOT NULL,
      local_uri     TEXT NOT NULL,
      file_size     INTEGER,
      downloaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
    );`,

    // ── indexes ────────────────────────────────────────────────────────────
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_id
       ON messages(chat_id);`,

    `CREATE INDEX IF NOT EXISTS idx_messages_status
       ON messages(status);`,

    // Composite index: speeds up "pending messages for this chat" query
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_status
       ON messages(chat_id, status);`,

    `CREATE INDEX IF NOT EXISTS idx_messages_media_status
       ON messages(media_status);`,

    `CREATE INDEX IF NOT EXISTS idx_sync_queue_created
       ON sync_queue(created_at);`,
  ];

  for (const sql of statements) {
    await db.execAsync(sql);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v2 — Add `receiver` column to existing installations
//
// Users who already had v1 installed won't have `receiver` in their messages
// table because the old schema didn't have it. This migration adds it safely.
//
// HOW TO ADD FUTURE MIGRATIONS:
//   1. Create  async function migration_v3(db) { ... }
//   2. Bump DB_TARGET_VERSION to 3
//   3. Add a case 3 block below in runMigrations()
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v2(db: any): Promise<void> {
  // ALTER TABLE silently fails if the column already exists — that is fine.
  const safeAlter = async (sql: string) => {
    try {
      await db.execAsync(sql);
    } catch (_) {
      // Column already exists on fresh installs — ignore.
    }
  };

  await safeAlter(
    `ALTER TABLE messages ADD COLUMN receiver TEXT NOT NULL DEFAULT '';`
  );

  // Back-fill: for old rows, set receiver = chat_id
  // (chat_id was the partner's userId in the old design)
  await db.execAsync(
    `UPDATE messages SET receiver = chat_id WHERE receiver = '';`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v3 — Add missing columns to messages table
//
// Existing installs had a messages table created by older code that lacked
// the columns defined in migration_v1's CREATE TABLE.  We add them here
// with ALTER TABLE ... which is always safe (fails silently if already present).
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v3(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (_) { /* column already exists */ }
  };

  // Columns added in the new schema that old installations never had
  await safeAlter(`ALTER TABLE messages ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN local_file_uri TEXT;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN media_status TEXT DEFAULT 'not_downloaded';`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN thumbnail_uri TEXT;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN file_size INTEGER;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN mime_type TEXT;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN reaction TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — call this once in your app's DB initialisation
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATE_DB = async (db: any): Promise<void> => {
  let currentVersion = await getCurrentVersion(db);
  console.log(
    `[SQLite] DB version: ${currentVersion}, target: ${DB_TARGET_VERSION}`
  );

  if (currentVersion >= DB_TARGET_VERSION) {
    console.log('[SQLite] Schema is up to date. Nothing to do.');
    return;
  }

  // Run only the migrations that haven't been applied yet
  while (currentVersion < DB_TARGET_VERSION) {
    const nextVersion = currentVersion + 1;
    console.log(`[SQLite] Running migration v${nextVersion}...`);

    try {
      switch (nextVersion) {
        case 1:
          await migration_v1(db);
          break;
        case 2:
          await migration_v2(db);
          break;
        case 3:
          await migration_v3(db);
          break;
        // ── Add future cases here ──────────────────────────────────────────
        // case 3:
        //   await migration_v3(db);
        //   break;
        default:
          throw new Error(`[SQLite] No migration defined for v${nextVersion}`);
      }

      // Only bump the stored version after a successful migration
      await setVersion(db, nextVersion);
      currentVersion = nextVersion;
      console.log(`[SQLite] Migration v${nextVersion} complete.`);
    } catch (error) {
      console.error(`[SQLite] Migration v${nextVersion} FAILED:`, error);
      // Stop here — do NOT mark this version as applied.
      // The app will retry the same migration on next launch.
      throw error;
    }
  }

  console.log('[SQLite] All migrations complete. App is ready.');
};
