import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

export type MigrationFunction = (db: SQLite.SQLiteDatabase) => Promise<void>;

interface DatabaseConfig {
  name: string;
  migrations: MigrationFunction;
  onOpen?: (db: SQLite.SQLiteDatabase) => Promise<void>;
}

class DatabaseManager {
  private static instance: DatabaseManager;
  private databases: Map<string, SQLite.SQLiteDatabase> = new Map();
  private openPromises: Map<string, Promise<SQLite.SQLiteDatabase>> = new Map();

  private constructor() {}

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * Opens a database with standard SoulSync configuration (WAL, Foreign Keys)
   * and runs migrations.
   */
  public async getDatabase(config: DatabaseConfig): Promise<SQLite.SQLiteDatabase> {
    const { name, migrations, onOpen } = config;

    // Return cached instance if available
    if (this.databases.has(name)) {
      return this.databases.get(name)!;
    }

    // Return existing open promise if one is in flight (prevents race conditions)
    if (this.openPromises.has(name)) {
      return this.openPromises.get(name)!;
    }

    const openPromise = (async () => {
      try {
        console.log(`[DatabaseManager] Opening database: ${name}`);
        const db = await SQLite.openDatabaseAsync(name);

        // Standard configuration
        await db.execAsync('PRAGMA journal_mode = WAL;');
        await db.execAsync('PRAGMA foreign_keys = ON;');

        // Run migrations
        if (migrations) {
          await migrations(db);
        }

        // Custom post-open logic
        if (onOpen) {
          await onOpen(db);
        }

        this.databases.set(name, db);
        return db;
      } catch (error) {
        console.error(`[DatabaseManager] Failed to open database ${name}:`, error);
        this.openPromises.delete(name);
        throw error;
      } finally {
        this.openPromises.delete(name);
      }
    })();

    this.openPromises.set(name, openPromise);
    return openPromise;
  }

  /**
   * Closes all open databases.
   */
  public async closeAll(): Promise<void> {
    for (const [name, db] of this.databases.entries()) {
      try {
        // Expo-sqlite doesn't have a direct close, but we can clear our references
        this.databases.delete(name);
      } catch (e) {
        console.error(`[DatabaseManager] Error closing ${name}:`, e);
      }
    }
  }
}

export const dbManager = DatabaseManager.getInstance();
