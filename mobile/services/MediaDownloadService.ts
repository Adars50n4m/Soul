/**
 * MediaDownloadService - WhatsApp-style offline media handling
 * 
 * Handles downloading media files from Cloudflare R2 to local device storage
 * using expo-file-system for offline viewing.
 */

import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { offlineService } from './LocalDBService';
import { MediaStatus } from '../types';
import { soulFolderService } from './SoulFolderService';
import { proxySupabaseUrl } from '../config/api';

// OLD flat cache — kept for backward compatibility during migration
const LEGACY_MEDIA_DIR = `${FileSystem.documentDirectory}media_cache`;

// NEW: Use SoulFolderService for organized paths

export interface DownloadProgress {
  messageId: string;
  progress: number; // 0-100
  bytesWritten: number;
  totalBytes: number;
}

export interface DownloadResult {
  success: boolean;
  localUri?: string;
  error?: string;
  fileSize?: number;
  messageId?: string;
}

/**
 * Ensure media directory exists — now uses Soul folder structure
 */
async function ensureMediaDir(mediaType?: string, isSent?: boolean): Promise<string> {
  // Initialize Soul folder structure (idempotent)
  await soulFolderService.init();
  
  // If we have type info, return the specific organized folder
  if (mediaType) {
    const type = mediaType as 'image' | 'video' | 'audio' | 'document' | 'voice_note';
    return soulFolderService.getMediaPath(type, isSent ?? false);
  }
  
  // Fallback: legacy flat cache for unknown types
  const dirInfo = await FileSystem.getInfoAsync(LEGACY_MEDIA_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(LEGACY_MEDIA_DIR, { intermediates: true });
  }
  return LEGACY_MEDIA_DIR;
}

/**
 * Generate a unique local filename for a media file
 */
async function generateLocalFilename(messageId: string, originalUrl: string): Promise<string> {
  const extension = originalUrl.split('.').pop()?.split('?')[0] || 'bin';
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${messageId}-${Date.now()}`
  );
  return `${hash.substring(0, 16)}.${extension}`;
}

/**
 * Get the local URI for a message's media file
 */
export function getLocalMediaUri(messageId: string, filename: string): string {
  // Note: This is a legacy method, we should prefer soulFolderService.getDestinationPath
  return `${LEGACY_MEDIA_DIR}/${filename}`;
}

/**
 * Check if a local file exists
 */
export async function localFileExists(localUri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(localUri);
    return info.exists;
  } catch {
    return false;
  }
}

/**
 * Delete a local media file
 */
export async function deleteLocalFile(localUri: string): Promise<boolean> {
  try {
    const exists = await localFileExists(localUri);
    if (exists) {
      await FileSystem.deleteAsync(localUri, { idempotent: true });
    }
    return true;
  } catch (error) {
    console.error('[MediaDownload] Error deleting file:', error);
    return false;
  }
}

/**
 * Download a media file from remote URL to local storage
 * Updates the message's media status during download
 * 
 * Now saves to organized Soul/ folder structure:
 *   Received images → Soul/Media/Soul Images/IMG-20250328-SOUL0001.jpg
 *   Received videos → Soul/Media/Soul Videos/VID-20250328-SOUL0001.mp4
 */
export async function downloadMedia(
  messageId: string,
  remoteUrl: string,
  onProgress?: (progress: DownloadProgress) => void,
  mediaType?: string,
  isSent: boolean = false
): Promise<DownloadResult> {
  try {
    // Determine the media type from URL if not provided
    const ext = remoteUrl.split('.').pop()?.split('?')[0] || 'bin';
    const inferredType = mediaType || soulFolderService.inferMediaType(ext);
    
    // Get organized destination path
    const destPath = soulFolderService.getDestinationPath(
      inferredType as any,
      isSent,
      remoteUrl
    );
    
    // Check if we already have this file downloaded
    const existingUri = await offlineService.getMediaDownload(messageId);
    if (existingUri) {
      const exists = await localFileExists(existingUri);
      if (exists) {
        return { success: true, localUri: existingUri, messageId };
      }
    }
    
    // Update status to downloading
    await offlineService.updateMediaStatus(messageId, 'downloading');
    
    // Download the file to organized path
    console.log(`[MediaDownload] Starting download for msg ${messageId}:`, remoteUrl);
    
    const downloadResult = await FileSystem.downloadAsync(
      remoteUrl,
      destPath,
      {
        headers: {
          'Accept': '*/*',
        },
      }
    );
    
    // Get file info for size
    const fileInfo = await FileSystem.getInfoAsync(downloadResult.uri) as FileSystem.FileInfo;
    const fileSize = fileInfo.exists ? fileInfo.size : 0;
    
    // Update local URI in database
    await offlineService.updateMessageLocalUri(messageId, downloadResult.uri, fileSize);
    
    console.log('[MediaDownload] Download complete:', downloadResult.uri, 'Size:', fileSize);
    
    return {
      success: true,
      localUri: downloadResult.uri,
      fileSize
    };
  } catch (error) {
    console.error('[MediaDownload] Download failed:', error);
    
    // Update status to failed
    await offlineService.updateMediaStatus(messageId, 'download_failed' as any);
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Download failed'
    };
  }
}

/**
 * Download with progress callback (using custom implementation)
 * Note: expo-file-system doesn't support progress natively, so we simulate it
 */
export async function downloadMediaWithProgress(
  messageId: string,
  remoteUrl: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
  // For now, use the simple download
  const result = await downloadMedia(messageId, remoteUrl);
  
  if (onProgress && result.success) {
    onProgress({
      messageId,
      progress: 100,
      bytesWritten: result.fileSize || 0,
      totalBytes: result.fileSize || 0
    });
  }
  
  return result;
}

/**
 * Save a local file from a local source (for sending media)
 * Copies the file to our organized Soul/Media/.../Sent/ folder
 */
export async function saveLocalMediaFromUri(
  messageId: string,
  sourceUri: string,
  mediaType?: string
): Promise<DownloadResult> {
  try {
    // Determine media type
    const ext = sourceUri.split('.').pop()?.split('?')[0] || 'bin';
    const inferredType = mediaType || soulFolderService.inferMediaType(ext);
    
    // Get organized destination path — sent = true
    const destUri = soulFolderService.getDestinationPath(
      inferredType as any,
      true, // isSent = true
      sourceUri
    );
    
    // Ensure the Sent/ folder exists
    await ensureMediaDir(inferredType, true);
    
    // Copy file to organized Sent/ folder
    await FileSystem.copyAsync({
      from: sourceUri,
      to: destUri
    });
    
    // Get file size
    const fileInfo = await FileSystem.getInfoAsync(destUri) as FileSystem.FileInfo;
    const fileSize = fileInfo.exists ? fileInfo.size : 0;
    
    console.log('[MediaDownload] Saved sent media:', destUri, 'Size:', fileSize);
    
    return {
      success: true,
      localUri: destUri,
      fileSize
    };
  } catch (error) {
    console.error('[MediaDownload] Save local media failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Save failed'
    };
  }
}

/**
 * Clear all cached media files (both old flat cache and new organized structure)
 */
export async function clearMediaCache(): Promise<{ deletedCount: number; freedBytes: number }> {
  let totalDeleted = 0;
  let totalFreed = 0;

  // Clear old flat media_cache/
  try {
    const dirInfo = await FileSystem.getInfoAsync(LEGACY_MEDIA_DIR);
    if (dirInfo.exists) {
      const files = await FileSystem.readDirectoryAsync(LEGACY_MEDIA_DIR);
      for (const file of files) {
        const fileUri = `${LEGACY_MEDIA_DIR}/${file}`;
        const info = await FileSystem.getInfoAsync(fileUri) as FileSystem.FileInfo;
        if (info.exists && info.size) {
          totalFreed += info.size;
          totalDeleted++;
        }
      }
      await FileSystem.deleteAsync(LEGACY_MEDIA_DIR, { idempotent: true });
    }
  } catch (_) {}

  // Clear new organized Soul/ media (received only — keep sent by default)
  try {
    const breakdown = await soulFolderService.getStorageBreakdown();
    for (const type of Object.keys(breakdown)) {
      const receivedStats = breakdown[type].received;
      totalDeleted += receivedStats.fileCount;
      totalFreed += receivedStats.totalBytes;
    }
    // Clear received files for all types
    for (const type of ['images', 'videos', 'audio', 'documents', 'voiceNotes'] as const) {
      await soulFolderService.clearMediaByType(type, 'received');
    }
  } catch (_) {}

  // Clear old StorageService cached_media_* files
  try {
    const docDir = FileSystem.documentDirectory;
    if (docDir) {
      const files = await FileSystem.readDirectoryAsync(docDir);
      for (const file of files.filter(f => f.startsWith('cached_media_'))) {
        const filePath = `${docDir}${file}`;
        const info = await FileSystem.getInfoAsync(filePath) as FileSystem.FileInfo;
        if (info.exists && info.size) {
          totalFreed += info.size;
          totalDeleted++;
        }
        await FileSystem.deleteAsync(filePath, { idempotent: true });
      }
    }
  } catch (_) {}

  console.log(`[MediaDownload] Cleared ${totalDeleted} files, freed ${totalFreed} bytes`);
  return { deletedCount: totalDeleted, freedBytes: totalFreed };
}

/**
 * Get storage usage for all media (old cache + new organized Soul/ folders)
 */
export async function getMediaCacheSize(): Promise<{ fileCount: number; totalBytes: number }> {
  let totalFiles = 0;
  let totalBytes = 0;

  // Old flat cache
  try {
    const dirInfo = await FileSystem.getInfoAsync(LEGACY_MEDIA_DIR);
    if (dirInfo.exists) {
      const files = await FileSystem.readDirectoryAsync(LEGACY_MEDIA_DIR);
      for (const file of files) {
        const fileUri = `${LEGACY_MEDIA_DIR}/${file}`;
        const info = await FileSystem.getInfoAsync(fileUri) as FileSystem.FileInfo;
        if (info.exists && info.size) {
          totalBytes += info.size;
          totalFiles++;
        }
      }
    }
  } catch (_) {}

  // New organized structure
  try {
    const breakdown = await soulFolderService.getStorageBreakdown();
    for (const type of Object.keys(breakdown)) {
      totalFiles += breakdown[type].received.fileCount + breakdown[type].sent.fileCount;
      totalBytes += breakdown[type].received.totalBytes + breakdown[type].sent.totalBytes;
    }
  } catch (_) {}

  return { fileCount: totalFiles, totalBytes };
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export const mediaDownloadService = {
  downloadMedia,
  downloadMediaWithProgress,
  saveLocalMediaFromUri,
  deleteLocalFile,
  localFileExists,
  clearMediaCache,
  getMediaCacheSize,
  formatBytes,
  getLocalMediaUri
};
/**
 * Syncs a contact's avatar to local storage if it's new or updated.
 */
export async function syncAvatar(
  contactId: string,
  remoteUrl: string | null,
  serverUpdatedAt?: string
): Promise<string | null> {
  if (!remoteUrl || (remoteUrl.startsWith('file://'))) return null;
  const resolvedRemoteUrl = proxySupabaseUrl(remoteUrl);

  try {
    const contact = await offlineService.getContact(contactId);
    const localUri = contact?.localAvatarUri;
    const lastUpdatedAt = contact?.avatarUpdatedAt;

    // 1. If we have it locally and the timestamp matches, we're done.
    if (localUri && lastUpdatedAt === serverUpdatedAt) {
      const exists = await localFileExists(localUri);
      if (exists) return localUri;
    }

    // 2. Download to Soul/Media/Soul Profile Photos/
    const destination = soulFolderService.getDestinationPath('profile_photo', false, resolvedRemoteUrl, contactId);

    // Guard: Ensure resolvedRemoteUrl is a valid URL and not an empty string
    if (!resolvedRemoteUrl || typeof resolvedRemoteUrl !== 'string' || !resolvedRemoteUrl.trim().startsWith('http')) {
      console.warn(`[MediaDownload] Skipping avatar sync for ${contactId}: invalid URL "${resolvedRemoteUrl}"`);
      return null;
    }

    // Ensure directory exists
    await soulFolderService.init();

    console.log(`[MediaDownload] Syncing Avatar for ${contactId}. Destination: ${destination}`);
    const result = await FileSystem.downloadAsync(resolvedRemoteUrl, destination);

    if (result.status === 200) {
      // Update local database with the new path and timestamp
      await offlineService.updateContactAvatar(contactId, result.uri, serverUpdatedAt || new Date().toISOString());
      console.log(`[MediaDownload] DP synced: ${result.uri}`);
      return result.uri;
    }

    return localUri || null;
  } catch (error) {
    console.error(`[MediaDownload] syncAvatar failed for ${contactId}:`, error);
    return null;
  }
}

/**
 * Downloads a status media file to organized storage.
 */
export async function downloadStatusMedia(status: {
  id: string;
  userId: string;
  mediaKey?: string;
  mediaType: string;
  mediaLocalPath?: string;
  mediaUrl?: string; // Signed URL
}): Promise<string | null> {
  if (status.mediaLocalPath) {
    const exists = await localFileExists(status.mediaLocalPath);
    if (exists) return status.mediaLocalPath;
  }

  const url = status.mediaUrl;
  if (!url) return null;

  try {
    await soulFolderService.init();
    
    // Path: Soul/Media/.Statuses/STT-YYYYMMDD-ID.ext
    const destPath = soulFolderService.getDestinationPath('status' as any, false, url, status.id);

    console.log(`[MediaDownload] Downloading Status ${status.id} from ${url}`);
    const result = await FileSystem.downloadAsync(url, destPath);

    if (result.status === 200) {
      // Update DB
      const db = await getDb();
      await db.runAsync(
        'UPDATE cached_statuses SET media_local_path = ? WHERE id = ?',
        [result.uri, status.id]
      );
      console.log(`[MediaDownload] Status ${status.id} saved to ${result.uri}`);
      return result.uri;
    }
  } catch (err) {
    console.error(`[MediaDownload] downloadStatusMedia failed for ${status.id}:`, err);
  }
  return null;
}

import { getDb } from './LocalDBService';
