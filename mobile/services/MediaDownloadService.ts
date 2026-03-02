/**
 * MediaDownloadService - WhatsApp-style offline media handling
 * 
 * Handles downloading media files from Cloudflare R2 to local device storage
 * using expo-file-system for offline viewing.
 */

import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { offlineService, MediaStatus } from './LocalDBService';

// Use documentDirectory from the legacy module
const MEDIA_DIR = `${FileSystem.documentDirectory}media_cache`;

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
}

/**
 * Ensure media cache directory exists
 */
async function ensureMediaDir(): Promise<string> {
  const dirInfo = await FileSystem.getInfoAsync(MEDIA_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
  }
  return MEDIA_DIR;
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
  return `${MEDIA_DIR}/${filename}`;
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
 */
export async function downloadMedia(
  messageId: string,
  remoteUrl: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<DownloadResult> {
  try {
    // Ensure media directory exists
    await ensureMediaDir();
    
    // Generate local filename
    const filename = await generateLocalFilename(messageId, remoteUrl);
    const localUri = `${MEDIA_DIR}/${filename}`;
    
    // Check if already downloaded
    if (await localFileExists(localUri)) {
      console.log('[MediaDownload] File already exists:', localUri);
      return { success: true, localUri };
    }
    
    // Update status to downloading
    await offlineService.updateMediaStatus(messageId, 'downloading');
    
    // Download the file
    console.log('[MediaDownload] Starting download:', remoteUrl);
    
    const downloadResult = await FileSystem.downloadAsync(
      remoteUrl,
      localUri,
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
    await offlineService.updateLocalFileUri(messageId, downloadResult.uri, fileSize);
    
    console.log('[MediaDownload] Download complete:', downloadResult.uri, 'Size:', fileSize);
    
    return {
      success: true,
      localUri: downloadResult.uri,
      fileSize
    };
  } catch (error) {
    console.error('[MediaDownload] Download failed:', error);
    
    // Update status to failed
    await offlineService.updateMediaStatus(messageId, 'download_failed');
    
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
  // In production, you might use a custom native module or XMLHttpRequest for progress
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
 * Copies the file to our media cache directory
 */
export async function saveLocalMediaFromUri(
  messageId: string,
  sourceUri: string
): Promise<DownloadResult> {
  try {
    await ensureMediaDir();
    
    const filename = await generateLocalFilename(messageId, sourceUri);
    const destUri = `${MEDIA_DIR}/${filename}`;
    
    // Copy file to media cache
    await FileSystem.copyAsync({
      from: sourceUri,
      to: destUri
    });
    
    // Get file size
    const fileInfo = await FileSystem.getInfoAsync(destUri) as FileSystem.FileInfo;
    const fileSize = fileInfo.exists ? fileInfo.size : 0;
    
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
 * Clear all cached media files
 */
export async function clearMediaCache(): Promise<{ deletedCount: number; freedBytes: number }> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(MEDIA_DIR);
    if (!dirInfo.exists) {
      return { deletedCount: 0, freedBytes: 0 };
    }
    
    const files = await FileSystem.readDirectoryAsync(MEDIA_DIR);
    let totalSize = 0;
    
    for (const file of files) {
      const fileUri = `${MEDIA_DIR}/${file}`;
      const info = await FileSystem.getInfoAsync(fileUri) as FileSystem.FileInfo;
      if (info.exists && info.size) {
        totalSize += info.size;
      }
    }
    
    await FileSystem.deleteAsync(MEDIA_DIR, { idempotent: true });
    
    console.log(`[MediaDownload] Cleared ${files.length} files, freed ${totalSize} bytes`);
    
    return {
      deletedCount: files.length,
      freedBytes: totalSize
    };
  } catch (error) {
    console.error('[MediaDownload] Clear cache failed:', error);
    return { deletedCount: 0, freedBytes: 0 };
  }
}

/**
 * Get storage usage for media cache
 */
export async function getMediaCacheSize(): Promise<{ fileCount: number; totalBytes: number }> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(MEDIA_DIR);
    if (!dirInfo.exists) {
      return { fileCount: 0, totalBytes: 0 };
    }
    
    const files = await FileSystem.readDirectoryAsync(MEDIA_DIR);
    let totalSize = 0;
    
    for (const file of files) {
      const fileUri = `${MEDIA_DIR}/${file}`;
      const info = await FileSystem.getInfoAsync(fileUri) as FileSystem.FileInfo;
      if (info.exists && info.size) {
        totalSize += info.size;
      }
    }
    
    return {
      fileCount: files.length,
      totalBytes: totalSize
    };
  } catch (error) {
    console.error('[MediaDownload] Get cache size failed:', error);
    return { fileCount: 0, totalBytes: 0 };
  }
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
