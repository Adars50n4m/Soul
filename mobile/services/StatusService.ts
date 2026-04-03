import { supabase } from '../config/supabase';
import { 
    CachedStatus, 
    PendingUpload, 
    CachedUser, 
    UserStatusGroup 
} from '../types';
import { storageService } from './StorageService';
import * as FileSystem from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from './LocalDBService';

class StatusService {
  private async getDb() {
    return await getDb();
  }

  async getPendingUploads(): Promise<PendingUpload[]> {
    const db = await this.getDb();
    const rows = await db.getAllAsync<any>(
      'SELECT id, local_uri as localUri, media_type as mediaType, caption, created_at as createdAt, upload_status as uploadStatus, retry_count as retryCount, media_key as mediaKey FROM pending_uploads ORDER BY created_at ASC'
    );
    return rows as PendingUpload[];
  }

  public async resolveStatusActor(): Promise<{ id: string; hasSession: boolean; isBypass: boolean } | null> {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (!userError && userData.user?.id) {
      return { id: userData.user.id, hasSession: true, isBypass: false };
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (!sessionError && sessionData.session?.user?.id) {
      return { id: sessionData.session.user.id, hasSession: true, isBypass: false };
    }

    const cachedUserId = await AsyncStorage.getItem('ss_current_user');
    if (cachedUserId) {
      const isBypass = cachedUserId.startsWith('f00f00f0-0000-0000-0000');
      if (isBypass) {
        console.log(`[StatusService] Using recognized Developer Bypass user: ${cachedUserId}`);
      } else {
        console.warn(`[StatusService] Using cached user ID without active Supabase session: ${cachedUserId}`);
      }
      return { id: cachedUserId, hasSession: false, isBypass };
    }

    return null;
  }

  private getStatusDuration(mediaType: 'image' | 'video'): number {
    return mediaType === 'video' ? 15 : 5;
  }

  private getDirectMediaUrl(mediaKey?: string | null, mediaUrl?: string | null): string | null {
    if (typeof mediaUrl === 'string' && mediaUrl.startsWith('http')) return mediaUrl;
    if (typeof mediaKey === 'string' && mediaKey.startsWith('http')) return mediaKey;
    return null;
  }

  private async queuePendingUpload(
    db: SQLite.SQLiteDatabase,
    userId: string,
    localUri: string,
    mediaType: 'image' | 'video',
    caption?: string
  ): Promise<void> {
    if (!userId || !userId.trim()) {
      throw new Error('Status upload requires a valid user ID');
    }

    const now = Date.now();
    const pendingId = `pending-${now}`;
    const expiresAt = now + 24 * 60 * 60 * 1000;

    await db.runAsync(
      'INSERT OR REPLACE INTO pending_uploads (id, local_uri, media_type, media_key, caption, created_at, upload_status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [pendingId, localUri, mediaType, localUri, caption || null, now, 'pending', 0]
    );

    await db.runAsync(
      'INSERT OR REPLACE INTO cached_statuses (id, user_id, media_local_path, media_key, media_type, caption, duration, expires_at, is_viewed, is_mine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [pendingId, userId, localUri, localUri, mediaType, caption || null, this.getStatusDuration(mediaType), expiresAt, 1, 1, now]
    );
  }


  // ─── UPLOAD ───────────────────────────────

  async uploadStory(localUri: string, mediaType: 'image' | 'video', caption?: string): Promise<void> {
    const db = await this.getDb();
    const actor = await this.resolveStatusActor();
    if (!actor?.id) {
      throw new Error('No logged-in or cached user found');
    }
    const userId = actor.id;

    console.log(`[StatusService] Queuing story for background upload: ${localUri}`);
    await this.queuePendingUpload(db, userId, localUri, mediaType, caption);
  }

  async processPendingUploads(onProgress?: (id: string, progress: number) => void): Promise<void> {
    const db = await this.getDb();
    const isOnline = !!(await NetInfo.fetch()).isConnected;
    if (!isOnline) return;

    const actor = await this.resolveStatusActor();
    if (!actor?.id) {
      console.warn('[StatusSync] No session or cached user during background refresh');
      return;
    }
    const userId = actor.id;

    const pending = await db.getAllAsync<any>(
      "SELECT id, local_uri as localUri, media_type as mediaType, media_key as mediaKey FROM pending_uploads WHERE upload_status != 'uploading' ORDER BY created_at ASC"
    );

    for (const item of pending || []) {
      try {
        console.log(`[StatusSync] Processing ${item.id} (mediaKey: ${item.mediaKey})`);
        await db.runAsync('UPDATE pending_uploads SET upload_status = ? WHERE id = ?', ['uploading', item.id]);
        
        // 1. Check if we already have a valid R2 key from a previous successful upload attempt
        let mediaKey = item.mediaKey;
        const isAlreadyUploaded = mediaKey && !mediaKey.startsWith('file://') && !mediaKey.startsWith('content://');

        if (!isAlreadyUploaded) {
          console.log(`[StatusSync] Uploading media for ${item.id}`);
          mediaKey = await storageService.uploadStatusMedia(item.localUri, userId, item.mediaType, (p) => {
            if (onProgress) onProgress(item.id, p);
          });
          
          if (!mediaKey) throw new Error('R2 upload failed during sync');

          // Save the successfully uploaded key immediately in case Supabase fails next
          await db.runAsync('UPDATE pending_uploads SET media_key = ? WHERE id = ?', [mediaKey, item.id]);
        } else {
          console.log(`[StatusSync] Media already uploaded for ${item.id}, skipping to Supabase insert`);
          if (onProgress) onProgress(item.id, 100);
        }

        // 2. Insert into Supabase
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const duration = this.getStatusDuration(item.mediaType);

        if (!actor.hasSession && !actor.isBypass) {
          console.warn(`[StatusSync] Skipping Supabase insert for ${item.id} - No valid session or bypass authorization`);
          throw new Error('No authentication context available');
        }

        console.log(`[StatusSync] Attempting Supabase insert for ${item.id} (Session: ${actor.hasSession}, Bypass: ${actor.isBypass})`);
        const { data, error } = await supabase
          .from('statuses')
          .insert({
            user_id: userId,
            media_key: mediaKey,
            media_type: item.mediaType,
            caption: item.caption || null,
            expires_at: expiresAt,
            duration
          })
          .select('id, user_id, media_key, media_type, caption, duration, expires_at, created_at')
          .single();

        if (error) {
          throw error;
        }

        const statusId = String(data.id);
        console.log(`[StatusSync] Success for ${item.id}, new Supabase ID: ${statusId}`);
        await db.runAsync('DELETE FROM pending_uploads WHERE id = ?', [item.id]);
        await db.runAsync('DELETE FROM cached_statuses WHERE id = ?', [item.id]); 
        
        await db.runAsync(
          'INSERT OR REPLACE INTO cached_statuses (id, user_id, media_local_path, media_key, media_type, caption, duration, expires_at, is_viewed, is_mine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            statusId,
            userId,
            item.localUri,
            data.media_key || mediaKey,
            item.mediaType,
            item.caption || null,
            typeof data.duration === 'number' ? data.duration : duration,
            Date.parse(expiresAt),
            1,
            1,
            data.created_at ? Date.parse(data.created_at) : Date.now(),
          ]
        );
      } catch (e: any) {
        console.warn(`[StatusSync] Retry failed for ${item.id}:`, e.message || e);
        await db.runAsync(
          'UPDATE pending_uploads SET upload_status = ?, retry_count = retry_count + 1 WHERE id = ?', 
          ['failed', item.id]
        );
      }
    }
  }

  // ─── FEED ─────────────────────────────────

  async getStatusFeed(): Promise<UserStatusGroup[]> {
    const db = await this.getDb();
    const actor = await this.resolveStatusActor();
    if (!actor?.id) return [];
    const currentUserId = actor.id;

    const isOnline = !!(await NetInfo.fetch()).isConnected;
    const now = Date.now();

    // 1. Initial fetch from local DB
    const getLocalGroups = async (): Promise<UserStatusGroup[]> => {
      // Robust column check: if migration v26 just ran, we are safe.
      const cachedUsers = await db.getAllAsync<CachedUser>('SELECT * FROM cached_users');
      
      // FIX: Use media_key in local query
      const cachedStatuses = await db.getAllAsync<any>(
         'SELECT id, user_id as userId, media_local_path as mediaLocalPath, media_key as mediaKey, media_type as mediaType, caption, duration, expires_at as expiresAt, is_viewed as isViewed, is_mine as isMine, created_at as createdAt FROM cached_statuses WHERE expires_at > ? ORDER BY created_at ASC',
         [now]
      );

      const groupsMap: Map<string, UserStatusGroup> = new Map();
      for (const status of cachedStatuses || []) {
        if (!groupsMap.has(status.userId)) {
          const user = cachedUsers?.find(u => u.id === status.userId) || { id: status.userId };
          groupsMap.set(status.userId, {
            user,
            statuses: [],
            hasUnviewed: false,
            isMine: status.userId === currentUserId
          });
        }
        const group = groupsMap.get(status.userId)!;
        group.statuses.push(status);
        if (!status.isViewed) group.hasUnviewed = true;
      }

      return Array.from(groupsMap.values()).sort((a, b) => {
        if (a.isMine) return -1;
        if (b.isMine) return 1;
        if (a.hasUnviewed && !b.hasUnviewed) return -1;
        if (!a.hasUnviewed && b.hasUnviewed) return 1;
        return 0;
      });
    };

    // Return local data immediately to be "Offline-First"
    let groups = await getLocalGroups();

    // 2. Background Sync (Unblocked)
    if (isOnline) {
      // NOTE: We don't await the entire sync process here to keep the return fast
      // But we will kick it off. In a more advanced implementation, the UI would
      // listen for DB changes.
      this.syncStatusFeedFromSupabase(currentUserId).catch(e => {
        console.warn('[StatusService] Async feed sync failed:', e);
      });
    }

    return groups;
  }

  // New helper to handle the actual server sync logic without blocking the initial feed return
  private async syncStatusFeedFromSupabase(currentUserId: string): Promise<void> {
      const db = await this.getDb();
      try {
        const { data: serverStatuses, error } = await supabase
          .from('statuses')
          .select('id, user_id, media_key, media_type, caption, duration, expires_at, created_at')
          .gt('expires_at', new Date().toISOString());

        if (error) throw error;

        const userIds = Array.from(new Set((serverStatuses || []).map((status) => status.user_id).filter(Boolean)));

        if (userIds.length > 0) {
          const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url, soul_note, soul_note_at')
            .in('id', userIds);

          if (!profilesError && profiles) {
            for (const profile of profiles) {
              const contact = await db.getFirstAsync<any>(
                'SELECT local_avatar_uri FROM contacts WHERE id = ?',
                [profile.id]
              );
              await db.runAsync(
                'INSERT OR REPLACE INTO cached_users (id, username, display_name, avatar_url, local_avatar_uri, soul_note, soul_note_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                  profile.id,
                  profile.username || null,
                  profile.display_name || null,
                  profile.avatar_url || null,
                  contact?.local_avatar_uri || null,
                  profile.soul_note || null,
                  profile.soul_note_at ? Date.parse(profile.soul_note_at) : null,
                ]
              );
            }
          }
        }

        for (const s of serverStatuses || []) {
          const statusId = String(s.id);
          // Check if we already have local metadata for this status (e.g. downloaded path)
          const existing = await db.getFirstAsync<any>(
            'SELECT is_viewed as isViewed, media_local_path as mediaLocalPath, media_key as mediaKey, duration FROM cached_statuses WHERE id = ?',
            [statusId]
          );

          await db.runAsync(
            'INSERT OR REPLACE INTO cached_statuses (id, user_id, media_type, media_key, caption, duration, expires_at, is_viewed, is_mine, created_at, media_local_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              statusId,
              s.user_id,
              s.media_type,
              s.media_key || existing?.mediaKey || null,
              s.caption || null,
              typeof s.duration === 'number' ? s.duration : (existing?.duration || this.getStatusDuration(s.media_type)),
              Date.parse(s.expires_at),
              existing?.isViewed || 0,
              s.user_id === currentUserId ? 1 : 0,
              Date.parse(s.created_at),
              existing?.mediaLocalPath || null,
            ]
          );
        }
      } catch (e) {
        throw e;
      }
  }

  // ─── VIEWING ──────────────────────────────

  async onStatusViewed(statusId: string, userId: string): Promise<void> {
    const db = await this.getDb();
    
    await db.runAsync('UPDATE cached_statuses SET is_viewed = 1 WHERE id = ?', [statusId]);

    const isOnline = !!(await NetInfo.fetch()).isConnected;
    if (isOnline && !statusId.startsWith('pending-')) {
      const { error } = await supabase.from('status_views').insert({ status_id: statusId, viewer_id: userId });
      if (error && !String(error.message).toLowerCase().includes('duplicate')) {
        console.warn('[StatusService] Failed to sync status view:', error);
      }
    }

    const status = await db.getFirstAsync<any>(
      'SELECT id, media_type as mediaType, media_local_path as mediaLocalPath, media_key as mediaKey FROM cached_statuses WHERE id = ?',
      [statusId]
    );

    if (status && !status.mediaLocalPath && !statusId.startsWith('pending-')) {
      let mediaKey = status.mediaKey || null;

      if (!mediaKey) {
        const { data, error } = await supabase.from('statuses').select('media_key').eq('id', statusId).single();
        if (error) {
          console.warn(`[StatusService] Failed to fetch media_key for ${statusId}:`, error);
        }
        mediaKey = data?.media_key || null;
        if (mediaKey) {
          await db.runAsync('UPDATE cached_statuses SET media_key = ? WHERE id = ?', [mediaKey, statusId]);
        }
      }

      if (mediaKey) {
        const signedUrl = await storageService.getSignedUrl(mediaKey);
        if (!signedUrl) {
          return;
        }

        const localPath = await storageService.downloadToDevice(signedUrl, statusId, status.mediaType);
        if (localPath) {
          await db.runAsync('UPDATE cached_statuses SET media_local_path = ? WHERE id = ?', [localPath, statusId]);
        }
      }
    }
  }

  async prefetchNextStatuses(currentUserId: string, feedGroups: UserStatusGroup[]): Promise<void> {
    // Logic: Download next 3 unviewed statuses silently in background
    let count = 0;
    for (const group of feedGroups) {
      if (group.isMine) continue;
      for (const status of group.statuses) {
        if (!status.isViewed && !status.mediaLocalPath) {
          // Trigger download without marking as viewed
          this.downloadStatusToCache(status.id).catch(() => {}); 
          count++;
          if (count >= 3) break;
        }
      }
      if (count >= 3) break;
    }
  }

  async syncAllStatusMedia(currentUserId: string, feedGroups: UserStatusGroup[]): Promise<void> {
    // For a truly offline experience like WhatsApp, we try to download all current statuses
    for (const group of feedGroups) {
      for (const status of group.statuses) {
        if (!status.mediaLocalPath) {
          this.downloadStatusToCache(status.id).catch(() => {});
        }
      }
    }
  }

  private async downloadStatusToCache(statusId: string): Promise<void> {
    const db = await this.getDb();
    const status = await db.getFirstAsync<any>(
      'SELECT media_key as mediaKey, media_type as mediaType FROM cached_statuses WHERE id = ?',
      [statusId]
    );

    if (!status?.mediaKey) return;

    try {
      const signedUrl = await storageService.getSignedUrl(status.mediaKey);
      if (signedUrl) {
        const localPath = await storageService.downloadToDevice(signedUrl, statusId, status.mediaType);
        if (localPath) {
          await db.runAsync('UPDATE cached_statuses SET media_local_path = ? WHERE id = ?', [localPath, statusId]);
        }
      }
    } catch (e) {
      console.warn(`[StatusService] Failed to cache status ${statusId}:`, e);
    }
  }

  async getMediaSource(statusId: string, mediaKey?: string): Promise<{uri: string, isLocal: boolean} | null> {
    const db = await getDb();
    
    const status = await db.getFirstAsync<any>(
      'SELECT media_local_path as mediaLocalPath, media_key as mediaKey, mediaUrl FROM cached_statuses WHERE id = ?',
      [statusId]
    );

    if (status?.mediaLocalPath) {
      if (status.mediaLocalPath.startsWith('content://')) {
        return { uri: status.mediaLocalPath, isLocal: true };
      }
      const info = await FileSystem.getInfoAsync(status.mediaLocalPath);
      if (info.exists) return { uri: status.mediaLocalPath, isLocal: true };
    }

    if (status?.mediaUrl && status.mediaUrl.startsWith('http')) {
      return { uri: status.mediaUrl, isLocal: false };
    }

    const keyToUse = mediaKey || status?.mediaKey || status?.mediaUrl || status?.mediaLocalPath;
    if (!keyToUse) return null;

    if (keyToUse.startsWith('http')) return { uri: keyToUse, isLocal: false };
    if (keyToUse.startsWith('file://') || keyToUse.startsWith('content://')) {
      return { uri: keyToUse, isLocal: true };
    }

    const signedUrl = await storageService.getSignedUrl(keyToUse);
    if (signedUrl) {
      console.log(`[StatusService] Successfully generated signed URL for ${statusId}`);
      // Update cache with signed URL for faster subsequent loads
      await db.runAsync('UPDATE cached_statuses SET mediaUrl = ? WHERE id = ?', [signedUrl, statusId]);
      return { uri: signedUrl, isLocal: false };
    }

    console.error(`[StatusService] Failed to get signed URL for ${statusId} using key ${keyToUse}`);
    return null;
  }

  // ─── MY STATUS ────────────────────────────

  async getMyStatuses(): Promise<CachedStatus[]> {
    const db = await this.getDb();
    return db.getAllAsync<any>(
      'SELECT id, user_id as userId, media_local_path as mediaLocalPath, media_key as mediaKey, media_type as mediaType, caption, duration, expires_at as expiresAt, is_viewed as isViewed, is_mine as isMine, created_at as createdAt FROM cached_statuses WHERE is_mine = 1 AND expires_at > ? ORDER BY created_at ASC',
      [Date.now()]
    );
  }

  async getMyStatusViewers(statusId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('status_views')
      .select('*, profiles:viewer_id(id, username, display_name, avatar_url)')
      .eq('status_id', statusId);
    
    if (error) return [];
    return data || [];
  }

  async deleteMyStatus(statusId: string, mediaKey: string): Promise<void> {
    const db = await this.getDb();
    const status = await db.getFirstAsync<any>(
      'SELECT media_local_path as mediaLocalPath, media_key as mediaKey FROM cached_statuses WHERE id = ?',
      [statusId]
    );

    let keyToDelete = mediaKey || status?.mediaKey || '';
    if (!keyToDelete && !statusId.startsWith('pending-')) {
      const { data } = await supabase.from('statuses').select('media_key').eq('id', statusId).single();
      keyToDelete = data?.media_key || '';
    }

    if (keyToDelete) {
      await storageService.deleteMedia(keyToDelete);
    }

    if (!statusId.startsWith('pending-')) {
      await supabase.from('statuses').delete().eq('id', statusId);
    }

    if (status?.mediaLocalPath) {
      await FileSystem.deleteAsync(status.mediaLocalPath, { idempotent: true });
    }

    await db.runAsync('DELETE FROM pending_uploads WHERE id = ?', [statusId]);
    await db.runAsync('DELETE FROM cached_statuses WHERE id = ?', [statusId]);
  }

  async updateMyStatusCaption(statusId: string, caption: string): Promise<void> {
    const db = await this.getDb();
    const normalizedCaption = caption.trim();
    const captionValue = normalizedCaption.length > 0 ? normalizedCaption : null;

    if (!statusId.startsWith('pending-')) {
      const { error } = await supabase
        .from('statuses')
        .update({ caption: captionValue })
        .eq('id', statusId);

      if (error) {
        throw error;
      }
    }

    await db.runAsync('UPDATE cached_statuses SET caption = ? WHERE id = ?', [captionValue, statusId]);
    await db.runAsync('UPDATE pending_uploads SET caption = ? WHERE id = ?', [captionValue, statusId]);
  }

  // ─── SOUL NOTE ────────────────────────────

  async updateSoulNote(text: string): Promise<void> {
    const actor = await this.resolveStatusActor();
    if (!actor?.id) return;

    const { error } = await supabase
      .from('profiles')
      .update({
        soul_note: text,
        soul_note_at: new Date().toISOString()
      })
      .eq('id', actor.id);
    
    if (error) throw error;

    const db = await this.getDb();
    await db.runAsync(
      'UPDATE cached_users SET soul_note = ?, soul_note_at = ? WHERE id = ?',
      [text, Date.now(), actor.id]
    );
  }

  async getSoulNote(userId: string): Promise<string | null> {
    const db = await this.getDb();
    const user = await db.getFirstAsync<any>(
      'SELECT soul_note as soulNote, soul_note_at as soulNoteAt FROM cached_users WHERE id = ?',
      [userId]
    );

    if (!user || !user.soulNoteAt) return null;
    
    // 24 hour expiry
    const isExpired = Date.now() - user.soulNoteAt > 24 * 60 * 60 * 1000;
    return isExpired ? null : user.soulNote || null;
  }

  // ─── CLEANUP ──────────────────────────────

  async cleanupExpiredLocal(): Promise<void> {
    const db = await this.getDb();
    const expired = await db.getAllAsync<any>(
      'SELECT id, media_local_path as mediaLocalPath FROM cached_statuses WHERE expires_at < ?',
      [Date.now()]
    );

    for (const s of expired || []) {
      if (s.mediaLocalPath) {
        try {
          await FileSystem.deleteAsync(s.mediaLocalPath, { idempotent: true });
        } catch {}
      }
      await db.runAsync('DELETE FROM cached_statuses WHERE id = ?', [s.id]);
    }
  }
}

export const statusService = new StatusService();
