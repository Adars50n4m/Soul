import { supabase } from '../config/supabase';
import {
    CachedStatus,
    PendingUpload,
    CachedUser,
    UserStatusGroup
} from '../types';
import { storageService } from './StorageService';
import { soulFolderService } from './SoulFolderService';
import { 
    documentDirectory, 
    getInfoAsync, 
    makeDirectoryAsync, 
    deleteAsync, 
    readDirectoryAsync, 
    copyAsync, 
    cacheDirectory, 
    downloadAsync 
} from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import * as ImageManipulator from 'expo-image-manipulator';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from './LocalDBService';

class StatusService {
  private normalizeStatusUriCandidate(value?: string | null): string {
    if (!value) return '';
    return storageService.normalizePseudoLocalUri(value);
  }

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
      return { id: cachedUserId, hasSession: false, isBypass };
    }

    return null;
  }

  private getStatusDuration(mediaType: 'image' | 'video'): number {
    return mediaType === 'video' ? 15 : 5;
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

  // Copy an upload's source file into Documents/status-media/ so that
  // media_local_path keeps pointing at something readable after iOS cleans
  // up its tmp/cache directories (which is where ImagePicker hands us URIs).
  // On any failure, falls back to the original URI — getMediaSource will
  // then transparently fall through to the R2 signed URL.
  private async persistStatusMediaLocally(sourceUri: string, statusId: string): Promise<string> {
    try {
      if (!sourceUri || !sourceUri.startsWith('file://')) return sourceUri;
      const info = await getInfoAsync(sourceUri);
      if (!info.exists) return sourceUri;
      const dir = `${documentDirectory}status-media/`;
      const dirInfo = await getInfoAsync(dir);
      if (!dirInfo.exists) {
        await makeDirectoryAsync(dir, { intermediates: true });
      }
      const ext = (sourceUri.split('.').pop() || 'bin').toLowerCase();
      const target = `${dir}${statusId}.${ext}`;
      const existing = await getInfoAsync(target);
      if (existing.exists) await deleteAsync(target, { idempotent: true }).catch(() => {});
      await copyAsync({ from: sourceUri, to: target });
      return target;
    } catch (e) {
      console.warn('[StatusService] persistStatusMediaLocally failed:', e);
      return sourceUri;
    }
  }

  async uploadStory(localUri: string, mediaType: 'image' | 'video', caption?: string): Promise<void> {
    const db = await this.getDb();
    const actor = await this.resolveStatusActor();
    if (!actor?.id) throw new Error('No logged-in or cached user found');
    await this.queuePendingUpload(db, actor.id, localUri, mediaType, caption);
  }

  async processPendingUploads(onProgress?: (id: string, progress: number) => void): Promise<void> {
    const db = await this.getDb();
    const isOnline = !!(await NetInfo.fetch()).isConnected;
    if (!isOnline) return;

    const actor = await this.resolveStatusActor();
    if (!actor?.id) return;
    const userId = actor.id;

    const pending = await db.getAllAsync<any>(
      "SELECT id, local_uri as localUri, media_type as mediaType, media_key as mediaKey, retry_count as retryCount FROM pending_uploads WHERE upload_status != 'permanently_failed' ORDER BY created_at ASC"
    );

    for (const item of pending || []) {
      if ((item.retryCount || 0) >= 5) {
        await db.runAsync('DELETE FROM pending_uploads WHERE id = ?', [item.id]);
        continue;
      }
      try {
        await db.runAsync('UPDATE pending_uploads SET upload_status = ? WHERE id = ?', ['uploading', item.id]);
        let mediaKey = item.mediaKey;
        const isAlreadyUploaded = mediaKey && !mediaKey.startsWith('file://') && !mediaKey.startsWith('content://');

        if (!isAlreadyUploaded) {
          // Belt-and-braces HEIC handling: the picker now transcodes HEIC →
          // JPEG up front, but a previously-queued HEIC pending upload could
          // still be sitting here from before the fix landed. Detect by
          // extension and convert in place so it stops perma-failing against
          // the R2 worker's allow-list (jpg/png/webp/mp4/mov).
          let uploadUri = item.localUri;
          const ext = (uploadUri.split('.').pop() || '').toLowerCase();
          if (item.mediaType === 'image' && (ext === 'heic' || ext === 'heif')) {
            try {
              const converted = await ImageManipulator.manipulateAsync(uploadUri, [], {
                format: ImageManipulator.SaveFormat.JPEG,
                compress: 0.92,
              });
              uploadUri = converted.uri;
              await db.runAsync('UPDATE pending_uploads SET local_uri = ? WHERE id = ?', [uploadUri, item.id]);
            } catch (convErr) {
              console.warn('[StatusService] HEIC → JPEG conversion failed for queued upload:', convErr);
            }
          }

          mediaKey = await storageService.uploadStatusMedia(uploadUri, userId, item.mediaType, (p) => {
            if (onProgress) onProgress(item.id, p);
          });
          if (!mediaKey) throw new Error('R2 upload failed during sync');
          await db.runAsync('UPDATE pending_uploads SET media_key = ? WHERE id = ?', [mediaKey, item.id]);
        }
        
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase.from('statuses').insert({
          user_id: userId, media_key: mediaKey, media_type: item.mediaType,
          caption: item.caption || null, expires_at: expiresAt,
          duration: this.getStatusDuration(item.mediaType)
        }).select().single();

        if (error) throw error;

        const statusId = String(data.id);
        await db.runAsync('DELETE FROM pending_uploads WHERE id = ?', [item.id]);
        await db.runAsync('DELETE FROM cached_statuses WHERE id = ?', [item.id]);

        // Copy the picker's ephemeral file into Documents/ so it survives iOS
        // tmp/cache cleanup. Without this, media_local_path points at a path
        // that gets purged across app sessions/rebuilds, and every subsequent
        // view of "your own" status falls through to an R2 signed-URL fetch.
        const persistedLocalPath = await this.persistStatusMediaLocally(
          item.localUri,
          statusId
        );

        await db.runAsync(
          'INSERT OR REPLACE INTO cached_statuses (id, user_id, media_local_path, media_key, media_type, caption, duration, expires_at, is_viewed, is_mine, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [statusId, userId, persistedLocalPath, data.media_key || mediaKey, item.mediaType, item.caption || null, data.duration, Date.parse(expiresAt), 1, 1, Date.parse(data.created_at)]
        );
      } catch (e: any) {
        await db.runAsync('UPDATE pending_uploads SET upload_status = ?, retry_count = retry_count + 1 WHERE id = ?', ['failed', item.id]);
      }
    }
  }

  /**
   * @param options.syncFirst Default true. When true, pulls fresh server state
   * into local cache BEFORE reading — used by feed refreshes so a friend's
   * just-posted status is visible. Pass false from screens that only need an
   * instant local-cache snapshot (e.g. the status viewer right after a tap,
   * which would otherwise show a black flash while waiting on the network).
   */
  async getStatusFeed(options: { syncFirst?: boolean } = {}): Promise<UserStatusGroup[]> {
    const { syncFirst = true } = options;
    const db = await this.getDb();
    const actor = await this.resolveStatusActor();
    if (!actor?.id) return [];

    // Pull fresh server state into the local cache BEFORE reading. The old
    // fire-and-forget pattern returned a stale snapshot whenever a realtime
    // INSERT triggered a refresh — the friend's new row hadn't landed in
    // SQLite yet, so the UI rendered the pre-insert feed and never re-read.
    // If offline, the swallow falls back to whatever the cache already has.
    if (syncFirst) {
      await this.syncStatusFeedFromSupabase(actor.id).catch(() => {});
    }

    const now = Date.now();
    let cachedUsers: CachedUser[] = [];
    try {
      cachedUsers = await db.getAllAsync<CachedUser>('SELECT id, username, display_name as displayName, avatar_url as avatarUrl, avatar_type as avatarType, teddy_variant as teddyVariant, local_avatar_uri as localAvatarUri, soul_note as soulNote, soul_note_at as soulNoteAt FROM cached_users');
    } catch (e: any) {
      // Fallback for migration race condition: if avatar_type doesn't exist yet, query without it
      if (e?.message?.includes('no such column') || e?.message?.includes('avatar_type')) {
        console.warn('[StatusService] Database columns missing (migration pending?), using fallback query.');
        const fallbackRows = await db.getAllAsync<any>('SELECT id, username, display_name as displayName, avatar_url as avatarUrl, local_avatar_uri as localAvatarUri, soul_note as soulNote, soul_note_at as soulNoteAt FROM cached_users');
        cachedUsers = fallbackRows.map(r => ({
          ...r,
          avatarType: 'default' as const,
          teddyVariant: undefined
        }));
      } else {
        throw e; // Re-throw other errors
      }
    }
    const cachedStatuses = await db.getAllAsync<any>('SELECT id, user_id as userId, media_local_path as mediaLocalPath, media_key as mediaKey, media_type as mediaType, caption, duration, expires_at as expiresAt, is_viewed as isViewed, is_mine as isMine, created_at as createdAt FROM cached_statuses WHERE expires_at > ? ORDER BY created_at ASC', [now]);

    const groupsMap: Map<string, UserStatusGroup> = new Map();
    for (const status of cachedStatuses || []) {
      if (!groupsMap.has(status.userId)) {
        const user = cachedUsers?.find(u => u.id === status.userId) || { id: status.userId };
        groupsMap.set(status.userId, { user, statuses: [], hasUnviewed: false, isMine: status.userId === actor.id });
      }
      const group = groupsMap.get(status.userId)!;
      group.statuses.push(status);
      if (!status.isViewed) group.hasUnviewed = true;
    }

    const result = Array.from(groupsMap.values()).sort((a, b) => {
      if (a.isMine) return -1; if (b.isMine) return 1;
      if (a.hasUnviewed && !b.hasUnviewed) return -1;
      if (!a.hasUnviewed && b.hasUnviewed) return 1;
      return 0;
    });
    console.log('[StatusService] getStatusFeed result:', {
      groupCount: result.length,
      groups: result.map(g => ({
        userId: g.user.id,
        displayName: (g.user as any).displayName || (g.user as any).username,
        statusCount: g.statuses.length,
        isMine: g.isMine,
      })),
    });
    return result;
  }

  private async syncStatusFeedFromSupabase(currentUserId: string): Promise<void> {
    const db = await this.getDb();
    try {
      const { data: serverStatuses, error } = await supabase.from('statuses').select('*').gt('expires_at', new Date().toISOString());
      if (error) {
        console.warn('[StatusService] supabase statuses query error:', error);
        throw error;
      }
      const userIds = Array.from(new Set((serverStatuses || []).map(s => s.user_id).filter(Boolean)));
      console.log('[StatusService] syncStatusFeedFromSupabase →', {
        currentUserId,
        rowCount: serverStatuses?.length || 0,
        userIds,
      });
      if (userIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('*').in('id', userIds);
        if (profiles) {
          for (const profile of profiles) {
            const contact = await db.getFirstAsync<any>('SELECT local_avatar_uri FROM contacts WHERE id = ?', [profile.id]);
            await db.runAsync(
              'INSERT OR REPLACE INTO cached_users (id, username, display_name, avatar_url, avatar_type, teddy_variant, local_avatar_uri, soul_note, soul_note_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [profile.id, profile.username, profile.display_name, profile.avatar_url, profile.avatar_type || 'default', profile.teddy_variant, contact?.local_avatar_uri, profile.soul_note, profile.soul_note_at ? Date.parse(profile.soul_note_at) : null]
            );
          }
        }
      }
      for (const s of serverStatuses || []) {
        const existing = await db.getFirstAsync<any>('SELECT is_viewed as isViewed, media_local_path as mediaLocalPath, media_key as mediaKey, duration FROM cached_statuses WHERE id = ?', [String(s.id)]);
        await db.runAsync('INSERT OR REPLACE INTO cached_statuses (id, user_id, media_type, media_key, caption, duration, expires_at, is_viewed, is_mine, created_at, media_local_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [String(s.id), s.user_id, s.media_type, s.media_key || existing?.mediaKey, s.caption, s.duration || existing?.duration || this.getStatusDuration(s.media_type), Date.parse(s.expires_at), existing?.isViewed || 0, s.user_id === currentUserId ? 1 : 0, Date.parse(s.created_at), existing?.mediaLocalPath || null]);
      }
    } catch (err) {
      console.warn('[StatusService] syncStatusFeedFromSupabase failed:', err);
    }
  }

  async onStatusViewed(statusId: string, userId: string): Promise<void> {
    const db = await this.getDb();
    await db.runAsync('UPDATE cached_statuses SET is_viewed = 1 WHERE id = ?', [statusId]);
    if (!statusId.startsWith('pending-')) {
      try {
        await supabase.from('status_views').insert({ status_id: statusId, viewer_id: userId });
      } catch (err) {
        console.warn('[Status] Failed to log status view:', err);
      }
    }
    const status = await db.getFirstAsync<any>('SELECT media_type as mediaType, media_local_path as mediaLocalPath, media_key as mediaKey FROM cached_statuses WHERE id = ?', [statusId]);
    if (status && !status.mediaLocalPath && !statusId.startsWith('pending-')) {
      let mediaKey = status.mediaKey;
      if (!mediaKey) {
        const { data } = await supabase.from('statuses').select('media_key').eq('id', statusId).single();
        mediaKey = data?.media_key;
        if (mediaKey) await db.runAsync('UPDATE cached_statuses SET media_key = ? WHERE id = ?', [mediaKey, statusId]);
      }
      if (mediaKey) {
        const signedUrl = await storageService.getSignedUrl(mediaKey);
        if (signedUrl) {
          const localPath = await storageService.downloadToDevice(signedUrl, statusId, status.mediaType);
          if (localPath) await db.runAsync('UPDATE cached_statuses SET media_local_path = ? WHERE id = ?', [localPath, statusId]);
        }
      }
    }
  }

  async prefetchNextStatuses(currentUserId: string, feedGroups: UserStatusGroup[]): Promise<void> {
    let count = 0;
    for (const group of feedGroups) {
      if (group.isMine) continue;
      for (const status of group.statuses) {
        if (!status.isViewed && !status.mediaLocalPath) {
          this.downloadStatusToCache(status.id);
          if (++count >= 3) return;
        }
      }
    }
  }

  private async downloadStatusToCache(statusId: string): Promise<void> {
    const db = await this.getDb();
    const status = await db.getFirstAsync<any>('SELECT media_key as mediaKey, media_type as mediaType FROM cached_statuses WHERE id = ?', [statusId]);
    if (!status?.mediaKey) return;
    try {
      const signedUrl = await storageService.getSignedUrl(status.mediaKey);
      if (signedUrl) {
        const localPath = await storageService.downloadToDevice(signedUrl, statusId, status.mediaType);
        if (localPath) await db.runAsync('UPDATE cached_statuses SET media_local_path = ? WHERE id = ?', [localPath, statusId]);
      }
    } catch (_) {}
  }

  async getMediaSource(statusId: string, mediaKey?: string): Promise<{uri: string, isLocal: boolean} | null> {
    const db = await getDb();
    const status = await db.getFirstAsync<any>('SELECT media_local_path as mediaLocalPath, media_key as mediaKey FROM cached_statuses WHERE id = ?', [statusId]);
    const localPath = this.normalizeStatusUriCandidate(status?.mediaLocalPath);
    if (localPath) {
      if (localPath.startsWith('ph://')) {
        const resolved = await storageService.resolveUri(localPath).catch(() => localPath);
        if (resolved?.startsWith('file://') || resolved?.startsWith('content://') || resolved?.startsWith('ph://')) {
          return { uri: resolved, isLocal: true };
        }
      }
      if (localPath.startsWith('content://')) return { uri: localPath, isLocal: true };
      if (localPath.startsWith('file://')) {
        const info = await getInfoAsync(localPath);
        if (info.exists) return { uri: localPath, isLocal: true };
      }
    }
    const key = this.normalizeStatusUriCandidate(mediaKey || status?.mediaKey);
    if (!key) return null;
    if (key.startsWith('http')) return { uri: key, isLocal: false };
    if (key.startsWith('file://') || key.startsWith('content://')) return { uri: key, isLocal: true };
    if (key.startsWith('ph://')) {
      const resolved = await storageService.resolveUri(key).catch(() => key);
      if (resolved?.startsWith('file://') || resolved?.startsWith('content://') || resolved?.startsWith('ph://')) {
        return { uri: resolved, isLocal: true };
      }
      return null;
    }
    const signedUrl = await storageService.getSignedUrl(key);
    return signedUrl ? { uri: signedUrl, isLocal: false } : null;
  }

  async getMyStatuses(): Promise<CachedStatus[]> {
    const db = await this.getDb();
    return db.getAllAsync<any>('SELECT id, user_id as userId, media_local_path as mediaLocalPath, media_key as mediaKey, media_type as mediaType, caption, duration, expires_at as expiresAt, is_viewed as isViewed, is_mine as isMine, created_at as createdAt FROM cached_statuses WHERE is_mine = 1 AND expires_at > ? ORDER BY created_at ASC', [Date.now()]);
  }

  async getMyStatusViewers(statusId: string): Promise<any[]> {
    const { data } = await supabase.from('status_views').select('*, profiles:viewer_id(*)').eq('status_id', statusId);
    return data || [];
  }

  async deleteMyStatus(statusId: string, mediaKey: string): Promise<void> {
    const db = await this.getDb();
    const status = await db.getFirstAsync<any>('SELECT media_local_path as mediaLocalPath, media_key as mediaKey FROM cached_statuses WHERE id = ?', [statusId]);
    if (!statusId.startsWith('pending-')) {
      await supabase.from('statuses').delete().eq('id', statusId);
    }
    const key = mediaKey || status?.mediaKey;
    if (key) await storageService.deleteMedia(key).catch(() => {});
    if (status?.mediaLocalPath) {
      const localPath = await storageService.resolveUri(status.mediaLocalPath).catch(() => status.mediaLocalPath);
      if (localPath?.startsWith('file://') || localPath?.startsWith('content://')) {
        await deleteAsync(localPath, { idempotent: true }).catch(() => {});
      }
    }
    await db.runAsync('DELETE FROM pending_uploads WHERE id = ?', [statusId]);
    await db.runAsync('DELETE FROM cached_statuses WHERE id = ?', [statusId]);
  }

  async updateMyStatusCaption(statusId: string, caption: string): Promise<void> {
    const db = await this.getDb();
    const val = caption.trim() || null;
    if (!statusId.startsWith('pending-')) {
      const { error } = await supabase.from('statuses').update({ caption: val }).eq('id', statusId);
      if (error) throw error;
    }
    await db.runAsync('UPDATE cached_statuses SET caption = ? WHERE id = ?', [val, statusId]);
    await db.runAsync('UPDATE pending_uploads SET caption = ? WHERE id = ?', [val, statusId]);
  }

  async updateSoulNote(text: string): Promise<void> {
    const actor = await this.resolveStatusActor();
    if (!actor?.id) return;
    const { error } = await supabase.from('profiles').update({ soul_note: text, soul_note_at: new Date().toISOString() }).eq('id', actor.id);
    if (error) throw error;
    const db = await this.getDb();
    await db.runAsync('UPDATE cached_users SET soul_note = ?, soul_note_at = ? WHERE id = ?', [text, Date.now(), actor.id]);
  }

  async getSoulNote(userId: string): Promise<string | null> {
    const db = await this.getDb();
    const user = await db.getFirstAsync<any>('SELECT soul_note as soulNote, soul_note_at as soulNoteAt FROM cached_users WHERE id = ?', [userId]);
    if (!user || !user.soulNoteAt || (Date.now() - user.soulNoteAt > 24 * 60 * 60 * 1000)) return null;
    return user.soulNote;
  }

  async cleanupExpiredLocal(): Promise<void> {
    const db = await this.getDb();
    const expired = await db.getAllAsync<any>('SELECT id, media_local_path as mediaLocalPath FROM cached_statuses WHERE expires_at < ?', [Date.now()]);
    for (const s of expired || []) {
      if (s.mediaLocalPath) await deleteAsync(s.mediaLocalPath, { idempotent: true }).catch(() => {});
      await db.runAsync('DELETE FROM cached_statuses WHERE id = ?', [s.id]);
    }
  }

  async syncAllStatusMedia(currentUserId: string, groups: UserStatusGroup[]): Promise<void> {
    console.log('[StatusService] Starting background media sync for feed...');
    for (const group of groups) {
      if (group.isMine) continue;
      for (const status of group.statuses) {
        if (!status.mediaLocalPath) {
          // We don't await here to allow background parallel downloads
          this.downloadStatusToCache(status.id).catch(() => {});
        }
      }
    }
  }

  async likeStatus(statusId: string): Promise<boolean> {
    const actor = await this.resolveStatusActor();
    if (!actor?.id) return false;
    
    try {
      const { error } = await supabase.from('status_likes').insert({
        status_id: statusId,
        user_id: actor.id
      });
      if (error) {
        // Handle unique constraint violation (already liked)
        if (error.code === '23505') return true;
        throw error;
      }
      return true;
    } catch (err) {
      console.warn('[Status] Failed to like status:', err);
      return false;
    }
  }

  async unlikeStatus(statusId: string): Promise<boolean> {
    const actor = await this.resolveStatusActor();
    if (!actor?.id) return false;

    try {
      const { error } = await supabase.from('status_likes').delete().match({
        status_id: statusId,
        user_id: actor.id
      });
      if (error) throw error;
      return true;
    } catch (err) {
      console.warn('[Status] Failed to unlike status:', err);
      return false;
    }
  }

  async getStatusLikesCount(statusId: string): Promise<number> {
    try {
      const { count, error } = await supabase.from('status_likes').select('*', { count: 'exact', head: true }).eq('status_id', statusId);
      if (error) throw error;
      return count || 0;
    } catch (err) {
      console.warn('[Status] Failed to get likes count:', err);
      return 0;
    }
  }
}

export const statusService = new StatusService();
