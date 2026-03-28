import * as SQLite from 'expo-sqlite';

const DB_TARGET_VERSION = 1;

async function getCurrentVersion(db: SQLite.SQLiteDatabase): Promise<number> {
    try {
        await db.execAsync(`
            CREATE TABLE IF NOT EXISTS db_version (
                version INTEGER NOT NULL DEFAULT 0
            );
        `);
        const row = await db.getFirstAsync<{ version: number }>(`SELECT version FROM db_version LIMIT 1;`);
        if (!row) {
            await db.runAsync(`INSERT INTO db_version (version) VALUES (0);`);
            return 0;
        }
        return row.version;
    } catch (e) {
        return 0;
    }
}

async function setVersion(db: SQLite.SQLiteDatabase, version: number): Promise<void> {
    await db.runAsync(`UPDATE db_version SET version = ?;`, [version]);
}

async function migration_v1(db: SQLite.SQLiteDatabase): Promise<void> {
    await db.execAsync(`
        CREATE TABLE IF NOT EXISTS call_logs (
            id           TEXT PRIMARY KEY NOT NULL,
            contact_id   TEXT NOT NULL,
            contact_name TEXT,
            avatar       TEXT,
            time         TEXT NOT NULL,
            type         TEXT NOT NULL, -- incoming/outgoing
            status       TEXT NOT NULL, -- completed/missed/rejected/busy
            duration     INTEGER,       -- duration in seconds
            call_type    TEXT NOT NULL, -- audio/video
            created_at   TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_call_logs_time ON call_logs(time DESC);
        CREATE INDEX IF NOT EXISTS idx_call_logs_contact ON call_logs(contact_id);
    `);
}

export const MIGRATE_CALLS_DB = async (db: SQLite.SQLiteDatabase): Promise<void> => {
    let currentVersion = await getCurrentVersion(db);
    
    while (currentVersion < DB_TARGET_VERSION) {
        const nextVersion = currentVersion + 1;
        try {
            if (nextVersion === 1) await migration_v1(db);
            await setVersion(db, nextVersion);
            currentVersion = nextVersion;
        } catch (e) {
            console.error(`[CallsSchema] Migration to v${nextVersion} failed:`, e);
            throw e;
        }
    }
};
