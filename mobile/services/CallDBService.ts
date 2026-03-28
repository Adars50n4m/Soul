import { dbManager } from '../database/DatabaseManager';
import { MIGRATE_CALLS_DB } from '../database/calls_schema';
import { CallLog } from '../types';

class CallDBService {
  private async getDb() {
    return await dbManager.getDatabase({
      name: 'soul_calls.db',
      migrations: MIGRATE_CALLS_DB
    });
  }

  async saveCallLog(log: CallLog): Promise<void> {
    const db = await this.getDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO call_logs 
        (id, contact_id, contact_name, avatar, time, type, status, duration, call_type) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        log.id,
        log.contactId,
        log.contactName || 'Unknown',
        log.avatar || '',
        log.time,
        log.type,
        log.status,
        log.duration || 0,
        log.callType
      ]
    );
  }

  async getCallLogs(limit = 100): Promise<CallLog[]> {
    const db = await this.getDb();
    const rows = await db.getAllAsync(
      `SELECT * FROM call_logs ORDER BY time DESC LIMIT ?;`,
      [limit]
    );
    
    return (rows as any[]).map(row => ({
      id: row.id,
      contactId: row.contact_id,
      contactName: row.contact_name,
      avatar: row.avatar,
      time: row.time,
      type: row.type as 'incoming' | 'outgoing',
      status: row.status as any,
      duration: row.duration,
      callType: row.call_type as 'audio' | 'video'
    }));
  }

  async deleteCallLog(id: string): Promise<void> {
    const db = await this.getDb();
    await db.runAsync(`DELETE FROM call_logs WHERE id = ?;`, [id]);
  }

  async clearCallLogs(): Promise<void> {
    const db = await this.getDb();
    await db.runAsync(`DELETE FROM call_logs;`);
  }

  async getCallLogById(id: string): Promise<CallLog | null> {
    const db = await this.getDb();
    const row = await db.getFirstAsync(
        `SELECT * FROM call_logs WHERE id = ? LIMIT 1;`,
        [id]
    ) as any;
    if (!row) return null;
    return {
        id: row.id,
        contactId: row.contact_id,
        contactName: row.contact_name,
        avatar: row.avatar,
        time: row.time,
        type: row.type,
        status: row.status,
        duration: row.duration,
        callType: row.call_type
    };
  }
}

export const callDbService = new CallDBService();
