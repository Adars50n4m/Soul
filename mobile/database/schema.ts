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
const DB_TARGET_VERSION = 27;

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
    // FIX #16: Added delivered_at, read_at for message acknowledgment system
    `CREATE TABLE IF NOT EXISTS messages (
      id             TEXT    PRIMARY KEY NOT NULL,
      chat_id        TEXT    NOT NULL,
      sender         TEXT    NOT NULL,
      receiver       TEXT    NOT NULL,
      text           TEXT,
      media_type     TEXT,
      media_url      TEXT,
      media_caption  TEXT,
      media_thumbnail TEXT,
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
      mime_type      TEXT,
      delivered_at   TEXT,
      read_at        TEXT,
      idempotency_key TEXT,
      media_duration INTEGER
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
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
          console.warn(`[SQLite] Migration helper WARN for "${sql}":`, msg);
      }
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
    try { await db.execAsync(sql); } catch (e: any) { 
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v3:`, msg);
        }
    }
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
// MIGRATION v4 — Add is_unsent and retry_count to old tables
//
// These columns existed in migration_v1 for NEW installs, but users who
// upgraded from very old builds might be missing them, leading to crashes.
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v4(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (_) { /* already exists */ }
  };
  await safeAlter(`ALTER TABLE messages ADD COLUMN is_unsent INTEGER DEFAULT 0;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN last_retry_at TEXT;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN error_message TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v5 — Add missing `about` column to `contacts` table
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v5(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (_) { /* already exists */ }
  };
  await safeAlter(`ALTER TABLE contacts ADD COLUMN about TEXT DEFAULT '';`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v6 — Add `last_seen` column to `contacts` table
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v6(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v6:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE contacts ADD COLUMN last_seen TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v7 — Add `media_thumbnail` column to `messages` table
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v7(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v7:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE messages ADD COLUMN media_thumbnail TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v8 — Add `delivered_at`, `read_at`, `idempotency_key` columns
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v8(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v8:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE messages ADD COLUMN delivered_at TEXT;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN read_at TEXT;`);
  await safeAlter(`ALTER TABLE messages ADD COLUMN idempotency_key TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v9 — Add local chat mirror + pending sync operations
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v9(db: any): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS chats (
      id                   TEXT PRIMARY KEY NOT NULL,
      last_message_preview TEXT,
      last_message_at      TEXT,
      unread_count         INTEGER DEFAULT 0,
      updated_at           TEXT DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS pending_sync_ops (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      op_type     TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      retry_count INTEGER DEFAULT 0
    );`,
    `CREATE INDEX IF NOT EXISTS idx_chats_updated_at
       ON chats(updated_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_pending_sync_ops_entity
       ON pending_sync_ops(entity_type, entity_id);`,
    `CREATE INDEX IF NOT EXISTS idx_pending_sync_ops_created_at
       ON pending_sync_ops(created_at);`,
  ];

  for (const sql of statements) {
    await db.execAsync(sql);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v10 — Add avatar_type and teddy_variant to contacts
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v10(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v10:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE contacts ADD COLUMN avatar_type TEXT DEFAULT 'default';`);
  await safeAlter(`ALTER TABLE contacts ADD COLUMN teddy_variant TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v11 — Add connection tables
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v11(db: any): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS connection_requests (
      id TEXT PRIMARY KEY NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY NOT NULL,
      user_1_id TEXT NOT NULL,
      user_2_id TEXT NOT NULL,
      is_favorite INTEGER DEFAULT 0,
      custom_name TEXT,
      mute_notifications INTEGER DEFAULT 0,
      connected_at TEXT DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_conn_req_receiver ON connection_requests(receiver_id);`,
    `CREATE INDEX IF NOT EXISTS idx_connections_users ON connections(user_1_id, user_2_id);`
  ];
  for (const sql of statements) {
    await db.execAsync(sql);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v12 — Add avatar_cache table
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v12(db: any): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS avatar_cache (
      user_id      TEXT PRIMARY KEY NOT NULL,
      remote_url   TEXT NOT NULL,
      local_uri    TEXT NOT NULL,
      cached_at    TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v13 — Add is_archived column to contacts table
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v13(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v13:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE contacts ADD COLUMN is_archived INTEGER DEFAULT 0;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v14 — Add `media_duration` column to `messages` table
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v14(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v14:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE messages ADD COLUMN media_duration INTEGER;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v15 — Add `updated_at` to `contacts` table for validation
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v15(db: any): Promise<void> {
  const safeAlter = async (sql: string) => {
    try { await db.execAsync(sql); } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Migration helper WARN v15:`, msg);
        }
    }
  };
  await safeAlter(`ALTER TABLE contacts ADD COLUMN updated_at TEXT;`);
  await safeAlter(`ALTER TABLE contacts ADD COLUMN note TEXT;`);
  await safeAlter(`ALTER TABLE contacts ADD COLUMN note_timestamp TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v16 — Schema Self-Healing & Repair
// Move the previously high-cost "run on every boot" repair logic here.
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v16(db: any): Promise<void> {
    const repairSteps = [
        // Ensure chats table and columns exist
        `CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY NOT NULL,
          last_message_preview TEXT,
          last_message_at TEXT,
          unread_count INTEGER DEFAULT 0,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );`,
        `ALTER TABLE chats ADD COLUMN last_message_preview TEXT;`,
        `ALTER TABLE chats ADD COLUMN last_message_at TEXT;`,
        `ALTER TABLE chats ADD COLUMN unread_count INTEGER DEFAULT 0;`,
        `ALTER TABLE chats ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP;`,
        
        // Ensure messages columns exist
        `ALTER TABLE messages ADD COLUMN last_retry_at TEXT;`,
        `ALTER TABLE messages ADD COLUMN error_message TEXT;`,
        `ALTER TABLE messages ADD COLUMN reaction TEXT;`,
        `ALTER TABLE messages ADD COLUMN media_thumbnail TEXT;`,
        `ALTER TABLE messages ADD COLUMN delivered_at TEXT;`,
        `ALTER TABLE messages ADD COLUMN read_at TEXT;`,
        `ALTER TABLE messages ADD COLUMN idempotency_key TEXT;`,
        `ALTER TABLE messages ADD COLUMN media_duration INTEGER;`,
        
        // Ensure contacts columns exist
        `ALTER TABLE contacts ADD COLUMN about TEXT DEFAULT '';`,
        `ALTER TABLE contacts ADD COLUMN last_seen TEXT;`,
        `ALTER TABLE contacts ADD COLUMN is_archived INTEGER DEFAULT 0;`,
        `ALTER TABLE contacts ADD COLUMN updated_at TEXT;`,
        `ALTER TABLE contacts ADD COLUMN note TEXT;`,
        `ALTER TABLE contacts ADD COLUMN note_timestamp TEXT;`,
        
        // Ensure sync queue exists
        `CREATE TABLE IF NOT EXISTS pending_sync_ops (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id   TEXT NOT NULL,
          op_type     TEXT NOT NULL,
          payload     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0
        );`,
        // Ensure contacts columns exist
        `ALTER TABLE contacts ADD COLUMN avatar_type TEXT DEFAULT 'default';`,
        `ALTER TABLE contacts ADD COLUMN teddy_variant TEXT;`,
        
        // Ensure connection tables exist
        `CREATE TABLE IF NOT EXISTS connection_requests (
          id TEXT PRIMARY KEY NOT NULL,
          sender_id TEXT NOT NULL,
          receiver_id TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          message TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          responded_at TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY NOT NULL,
          user_1_id TEXT NOT NULL,
          user_2_id TEXT NOT NULL,
          is_favorite INTEGER DEFAULT 0,
          custom_name TEXT,
          mute_notifications INTEGER DEFAULT 0,
          connected_at TEXT DEFAULT CURRENT_TIMESTAMP
        );`,
        // Ensure avatar_cache table exists
        `CREATE TABLE IF NOT EXISTS avatar_cache (
          user_id      TEXT PRIMARY KEY NOT NULL,
          remote_url   TEXT NOT NULL,
          local_uri    TEXT NOT NULL,
          cached_at    TEXT DEFAULT CURRENT_TIMESTAMP
        );`
    ];
  
    for (const sql of repairSteps) {
        try {
            await db.execAsync(sql);
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration v16 repair check warning for "${sql}":`, msg);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v17 — Add country and country_code to users and contacts
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v17(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v17:`, msg);
            }
        }
    };
    await safeAlter(`ALTER TABLE users ADD COLUMN country TEXT;`);
    await safeAlter(`ALTER TABLE users ADD COLUMN country_code TEXT;`);
    await safeAlter(`ALTER TABLE contacts ADD COLUMN country TEXT;`);
    await safeAlter(`ALTER TABLE contacts ADD COLUMN country_code TEXT;`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v18 — Add status caching, uploads, and user metadata
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v18(db: any): Promise<void> {
    const statements = [
        // Table: cached_statuses (server statuses mirror with local file support)
        `CREATE TABLE IF NOT EXISTS cached_statuses (
          id                TEXT PRIMARY KEY NOT NULL,
          user_id           TEXT NOT NULL,
          media_local_path  TEXT,
          media_type        TEXT CHECK(media_type IN ('image', 'video')),
          caption           TEXT,
          duration          INTEGER DEFAULT 5,
          expires_at        INTEGER NOT NULL, -- unix timestamp
          is_viewed         INTEGER DEFAULT 0,
          is_mine           INTEGER DEFAULT 0,
          created_at        INTEGER NOT NULL,
          cached_at         INTEGER DEFAULT (strftime('%s', 'now'))
        );`,

        // Table: pending_uploads (queue for statuses created while offline)
        `CREATE TABLE IF NOT EXISTS pending_uploads (
          id             TEXT PRIMARY KEY NOT NULL, -- local UUID
          local_uri      TEXT NOT NULL,
          media_type     TEXT NOT NULL,
          media_key      TEXT,
          caption        TEXT,
          created_at     INTEGER NOT NULL,
          retry_count    INTEGER DEFAULT 0,
          upload_status  TEXT DEFAULT 'pending' -- pending | uploading | failed
        );`,

        // Table: cached_users (metadata for status feed display)
        `CREATE TABLE IF NOT EXISTS cached_users (
          id             TEXT PRIMARY KEY NOT NULL,
          username       TEXT,
          display_name   TEXT,
          avatar_url     TEXT,
          soul_note      TEXT,
          soul_note_at   INTEGER
        );`,

        `CREATE INDEX IF NOT EXISTS idx_cached_statuses_user ON cached_statuses(user_id);`,
        `CREATE INDEX IF NOT EXISTS idx_cached_statuses_expires ON cached_statuses(expires_at);`
    ];

    for (const sql of statements) {
        await db.execAsync(sql);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v19 — Add offline avatar caching to contacts
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v19(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v19:`, msg);
            }
        }
    };
    
    // Track local file system path for user's profile picture
    await safeAlter(`ALTER TABLE contacts ADD COLUMN local_avatar_uri TEXT;`);
    
    // Store the server's updated_at timestamp to detect when a new DP needs downloading
    await safeAlter(`ALTER TABLE contacts ADD COLUMN avatar_updated_at TEXT;`);
    
    console.log('[SQLite] Migration v19: Added local_avatar_uri and avatar_updated_at to contacts');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v20 — Add offline avatar support to status user cache
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v20 — Add offline avatar support to status user cache
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v20(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v20:`, msg);
            }
        }
    };
    
    await safeAlter(`ALTER TABLE cached_users ADD COLUMN local_avatar_uri TEXT;`);
    console.log('[SQLite] Migration v20: Added local_avatar_uri to cached_users');
}

// ─────────────────────────────────────────────────────────────────────────────
async function migration_v21(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v21:`, msg);
            }
        }
    };
    
    await safeAlter(`ALTER TABLE pending_uploads ADD COLUMN local_uri TEXT;`);
    await safeAlter(`ALTER TABLE pending_uploads ADD COLUMN media_key TEXT;`);
    
    console.log('[SQLite] Migration v21: Added missing columns to pending_uploads');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v22 — Robust Schema Fix (Ensure all columns exist)
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v22(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v22:`, msg);
            }
        }
    };
    
    // 1. Recreate the pending_uploads table from scratch to guarantee schema.
    await db.execAsync(`DROP TABLE IF EXISTS pending_uploads;`);
    await db.execAsync(`
        CREATE TABLE pending_uploads (
          id             TEXT PRIMARY KEY NOT NULL,
          local_uri      TEXT NOT NULL,
          media_type     TEXT NOT NULL,
          media_key      TEXT,
          caption        TEXT,
          created_at     INTEGER NOT NULL,
          retry_count    INTEGER DEFAULT 0,
          upload_status  TEXT DEFAULT 'pending'
        );
    `);
    
    // 2. Ensure other tables are robustly patched
    await safeAlter(`ALTER TABLE contacts ADD COLUMN local_avatar_uri TEXT;`);
    await safeAlter(`ALTER TABLE contacts ADD COLUMN avatar_updated_at TEXT;`);
    await safeAlter(`ALTER TABLE cached_users ADD COLUMN local_avatar_uri TEXT;`);
    
    console.log('[SQLite] Migration v22: Robust schema repair complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v23 — Add media_type to pending_uploads if missing
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v23(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v23:`, msg);
            }
        }
    };
    
    await safeAlter(`ALTER TABLE pending_uploads ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';`);
    
    console.log('[SQLite] Migration v23: Added media_type to pending_uploads');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v24 — Add mediaUrl to cached_statuses
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v24(db: any): Promise<void> {
    const safeAlter = async (sql: string) => {
        try { await db.execAsync(sql); } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
                console.warn(`[SQLite] Migration helper WARN v24:`, msg);
            }
        }
    };
    
    await safeAlter(`ALTER TABLE cached_statuses ADD COLUMN mediaUrl TEXT;`);
    
    console.log('[SQLite] Migration v24: Added mediaUrl to cached_statuses');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v25 — Canonicalize cached_statuses user column (userId -> user_id)
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v25(db: any): Promise<void> {
    const existingTable = await db.getFirstAsync(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cached_statuses' LIMIT 1;"
    ) as any;

    // Fresh installs should still end with the canonical table shape.
    if (!existingTable) {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS cached_statuses (
          id                TEXT PRIMARY KEY NOT NULL,
          user_id           TEXT NOT NULL,
          media_local_path  TEXT,
          media_key         TEXT,
          media_type        TEXT CHECK(media_type IN ('image', 'video')),
          caption           TEXT,
          duration          INTEGER DEFAULT 5,
          expires_at        INTEGER NOT NULL,
          is_viewed         INTEGER DEFAULT 0,
          is_mine           INTEGER DEFAULT 0,
          created_at        INTEGER NOT NULL,
          cached_at         INTEGER DEFAULT (strftime('%s', 'now')),
          mediaUrl          TEXT
        );
      `);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_cached_statuses_user ON cached_statuses(user_id);`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_cached_statuses_expires ON cached_statuses(expires_at);`);
      console.log('[SQLite] Migration v25: Created canonical cached_statuses table');
      return;
    }

    const columns = await db.getAllAsync('PRAGMA table_info(cached_statuses);') as any[];
    const columnNames = new Set((columns || []).map((c: any) => String(c.name)));

    const hasSnakeUserId = columnNames.has('user_id');
    const hasCamelUserId = columnNames.has('userId');

    // Already canonical and no legacy conflicting column: keep data as-is.
    if (hasSnakeUserId && !hasCamelUserId) {
      console.log('[SQLite] Migration v25: cached_statuses already canonical');
      return;
    }

    const pickExpr = (candidates: string[], fallback: string): string => {
      for (const candidate of candidates) {
        if (columnNames.has(candidate)) {
          return `"${candidate}"`;
        }
      }
      return fallback;
    };

    const userIdExpr = hasSnakeUserId && hasCamelUserId
      ? `COALESCE("user_id", "userId")`
      : hasSnakeUserId
        ? `"user_id"`
        : hasCamelUserId
          ? `"userId"`
          : `NULL`;

    const mediaLocalExpr = pickExpr(['media_local_path', 'mediaLocalPath'], 'NULL');
    const mediaKeyExpr = pickExpr(['media_key', 'mediaKey'], 'NULL');
    const mediaTypeExpr = pickExpr(['media_type', 'mediaType'], "'image'");
    const captionExpr = pickExpr(['caption'], 'NULL');
    const durationExpr = pickExpr(['duration'], '5');
    const expiresAtExpr = pickExpr(
      ['expires_at', 'expiresAt'],
      "CAST((strftime('%s','now') + 86400) * 1000 AS INTEGER)"
    );
    const isViewedExpr = pickExpr(['is_viewed', 'isViewed'], '0');
    const isMineExpr = pickExpr(['is_mine', 'isMine'], '0');
    const createdAtExpr = pickExpr(['created_at', 'createdAt'], "CAST(strftime('%s','now') * 1000 AS INTEGER)");
    const cachedAtExpr = pickExpr(['cached_at', 'cachedAt'], "strftime('%s','now')");
    const mediaUrlExpr = pickExpr(['mediaUrl', 'media_url'], 'NULL');

    await db.execAsync('BEGIN IMMEDIATE TRANSACTION;');
    try {
      await db.execAsync('ALTER TABLE cached_statuses RENAME TO cached_statuses_legacy_v25;');

      await db.execAsync(`
        CREATE TABLE cached_statuses (
          id                TEXT PRIMARY KEY NOT NULL,
          user_id           TEXT NOT NULL,
          media_local_path  TEXT,
          media_key         TEXT,
          media_type        TEXT CHECK(media_type IN ('image', 'video')),
          caption           TEXT,
          duration          INTEGER DEFAULT 5,
          expires_at        INTEGER NOT NULL,
          is_viewed         INTEGER DEFAULT 0,
          is_mine           INTEGER DEFAULT 0,
          created_at        INTEGER NOT NULL,
          cached_at         INTEGER DEFAULT (strftime('%s', 'now')),
          mediaUrl          TEXT
        );
      `);

      await db.execAsync(`
        INSERT OR REPLACE INTO cached_statuses (
          id, user_id, media_local_path, media_key, media_type, caption,
          duration, expires_at, is_viewed, is_mine, created_at, cached_at, mediaUrl
        )
        SELECT
          "id",
          ${userIdExpr},
          ${mediaLocalExpr},
          ${mediaKeyExpr},
          ${mediaTypeExpr},
          ${captionExpr},
          ${durationExpr},
          ${expiresAtExpr},
          ${isViewedExpr},
          ${isMineExpr},
          ${createdAtExpr},
          ${cachedAtExpr},
          ${mediaUrlExpr}
        FROM cached_statuses_legacy_v25
        WHERE ${userIdExpr} IS NOT NULL AND TRIM(${userIdExpr}) != '';
      `);

      await db.execAsync('DROP TABLE cached_statuses_legacy_v25;');
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_cached_statuses_user ON cached_statuses(user_id);`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_cached_statuses_expires ON cached_statuses(expires_at);`);
      await db.execAsync('COMMIT;');

      console.log('[SQLite] Migration v25: Rebuilt cached_statuses with canonical user_id');
    } catch (e) {
      await db.execAsync('ROLLBACK;');
      throw e;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION v26 — Deep Audit & Force-Add media_key column
// Ensures consistency across cached_statuses and pending_uploads
// ─────────────────────────────────────────────────────────────────────────────
async function migration_v26(db: any): Promise<void> {
    const safeAlter = async (table: string, column: string, type: string, defVal?: string) => {
        try {
            await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} ${defVal ? 'DEFAULT ' + defVal : ''};`);
            console.log(`[SQLite] Migration v26: Added ${column} to ${table}`);
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (msg.includes('duplicate column name') || msg.includes('already exists')) {
                // Table already has the column, which is what we want.
                return;
            }
            console.warn(`[SQLite] Migration v26 helper WARN for ${table}.${column}:`, msg);
        }
    };

    // 1. Audit cached_statuses
    await safeAlter('cached_statuses', 'media_key', 'TEXT');
    
    // 2. Audit pending_uploads
    await safeAlter('pending_uploads', 'media_key', 'TEXT');

    console.log('[SQLite] Migration v26: Schema audit & repair complete');
}


// Helper to safely add a column if it doesn't exist
async function safeAddColumn(db: any, table: string, column: string, type: string, defVal?: string): Promise<void> {
    try {
        // We use a safe check by trying to select the column first or checking table_info
        const info = await db.getAllAsync(`PRAGMA table_info(${table});`);
        const exists = (info as any[]).some(col => col.name === column);
        if (!exists) {
            console.log(`[SQLite] Repair: Adding missing column ${column} to ${table}`);
            await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} ${defVal ? 'DEFAULT ' + defVal : ''};`);
        }
    } catch (e: any) {
        const msg = e?.message || String(e);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
            console.warn(`[SQLite] Repair helper WARN for ${table}.${column}:`, msg);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — call this once in your app's DB initialisation
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATE_DB = async (db: any): Promise<void> => {
  console.log('[!!! DATABASE !!!] MIGRATE_DB called.');
  
  // ── EMERGENCY REPAIR ────────────────────────────────────────────────────────
  // Sometimes migrations fail to detect version drift. We force check the 
  // most critical column causing the current crashes.
  try {
    console.log('[!!! DATABASE !!!] Running Emergency Repair Check...');
    await safeAddColumn(db, 'cached_statuses', 'media_key', 'TEXT');
    await safeAddColumn(db, 'pending_uploads', 'media_key', 'TEXT');
    console.log('[!!! DATABASE !!!] Emergency Repair Check Complete.');
  } catch (repairErr) {
    console.warn('[!!! DATABASE !!!] Emergency Repair failed (ignoring):', repairErr);
  }

  let currentVersion = await getCurrentVersion(db);
  console.log(
    `[!!! DATABASE !!!] DB version: ${currentVersion}, target: ${DB_TARGET_VERSION}`
  );

  if (currentVersion >= DB_TARGET_VERSION) {
    console.log('[SQLite] Schema is up to date. Nothing to do.');
    return;
  }

  // ── RUN MIGRATIONS ────────────────────────────────────────────────────────
  // We use a while loop to step through every missing version one by one.
  // This is the safest way to upgrade a database.
  while (currentVersion < DB_TARGET_VERSION) {
    const nextVersion = currentVersion + 1;
    console.log(`[SQLite] Upgrading schema: v${currentVersion} ➔ v${nextVersion}...`);

    try {
      switch (nextVersion) {
        case 1: await migration_v1(db); break;
        case 2: await migration_v2(db); break;
        case 3: await migration_v3(db); break;
        case 4: await migration_v4(db); break;
        case 5: await migration_v5(db); break;
        case 6: await migration_v6(db); break;
        case 7: await migration_v7(db); break;
        case 8: await migration_v8(db); break;
        case 9: await migration_v9(db); break;
        case 10: await migration_v10(db); break;
        case 11: await migration_v11(db); break;
        case 12: await migration_v12(db); break;
        case 13: await migration_v13(db); break;
        case 14: await migration_v14(db); break;
        case 15: await migration_v15(db); break;
        case 16: await migration_v16(db); break;
        case 17: await migration_v17(db); break;
        case 18: await migration_v18(db); break;
        case 19: await migration_v19(db); break;
        case 20: await migration_v20(db); break;
        case 21: await migration_v21(db); break;
        case 22: await migration_v22(db); break;
        case 23: await migration_v23(db); break;
        case 24: await migration_v24(db); break;
        case 25: await migration_v25(db); break;
        case 26: await migration_v26(db); break;
        case 27: /* placeholder */ break;
        default:
          console.error(`[SQLite] No migration logic for v${nextVersion}!`);
      }

      await setVersion(db, nextVersion);
      currentVersion = nextVersion;
      console.log(`[SQLite] Successfully migrated to v${currentVersion}`);
    } catch (e) {
      console.error(`[SQLite] FATAL: Migration to v${nextVersion} failed:`, e);
      throw e; // Stop app boot if migration fails
    }
  }

  console.log('[SQLite] All migrations complete. App is ready.');
};
