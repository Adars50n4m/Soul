/**
 * MediaManager — WhatsApp-style local media file system
 *
 * All media files are stored in the app's document directory.
 * Files are organized by type and never deleted automatically.
 *
 * Folder Structure:
 * {documentDirectory}/SoulSync/
 * ├── media/
 * │   ├── images/       ← .jpg, .png, .webp
 * │   ├── videos/       ← .mp4, .mov
 * │   ├── audio/        ← .m4a, .mp3, .ogg
 * │   └── files/        ← .pdf, .doc, etc.
 * ├── thumbnails/       ← video thumbnails
 * ├── status/
 * │   ├── my/           ← your own posted statuses
 * │   └── received/     ← others' statuses
 * └── temp/             ← staging area before upload
 *
 * Naming: {type}_{messageId}_{timestamp}.{ext}
 */

import * as FileSystem from 'expo-file-system';

const BASE_DIR = FileSystem.documentDirectory + 'SoulSync/';

const DIRS = {
  images: `${BASE_DIR}media/images/`,
  videos: `${BASE_DIR}media/videos/`,
  audio: `${BASE_DIR}media/audio/`,
  files: `${BASE_DIR}media/files/`,
  thumbnails: `${BASE_DIR}thumbnails/`,
  statusMy: `${BASE_DIR}status/my/`,
  statusReceived: `${BASE_DIR}status/received/`,
  temp: `${BASE_DIR}temp/`,
};

type MediaType = 'image' | 'video' | 'audio' | 'file' | 'status';

/**
 * Ensure all directories exist (called once on app start)
 */
export const ensureDirectories = async (): Promise<void> => {
  for (const dir of Object.values(DIRS)) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  }
  console.log('[MediaManager] Directory structure initialized.');
};

/**
 * Get the target directory for a media type
 */
const getDirForType = (type: MediaType, subType?: 'my' | 'received'): string => {
  switch (type) {
    case 'image': return DIRS.images;
    case 'video': return DIRS.videos;
    case 'audio': return DIRS.audio;
    case 'file': return DIRS.files;
    case 'status':
      return subType === 'received' ? DIRS.statusReceived : DIRS.statusMy;
    default: return DIRS.files;
  }
};

/**
 * Get the file extension from a URI
 */
const getExtension = (uri: string): string => {
  const parts = uri.split('.');
  const ext = parts[parts.length - 1]?.split('?')[0]?.toLowerCase();
  return ext || 'bin';
};

/**
 * Generate a filename: {type}_{messageId}_{timestamp}.{ext}
 */
const generateFilename = (type: string, messageId: string, ext: string): string => {
  const prefix = type === 'image' ? 'img' : type === 'video' ? 'vid' : type === 'audio' ? 'aud' : 'file';
  return `${prefix}_${messageId}_${Date.now()}.${ext}`;
};

/**
 * Save a file to local storage (copy from source URI)
 */
export const saveMediaLocally = async (
  uri: string,
  type: MediaType,
  messageId: string,
  subType?: 'my' | 'received'
): Promise<string> => {
  await ensureDirectories();
  const ext = getExtension(uri);
  const filename = generateFilename(type, messageId, ext);
  const destDir = getDirForType(type, subType);
  const destPath = destDir + filename;

  await FileSystem.copyAsync({ from: uri, to: destPath });
  console.log(`[MediaManager] Saved: ${filename}`);
  return destPath;
};

/**
 * Download remote media to local storage
 */
export const downloadMedia = async (
  url: string,
  type: MediaType,
  messageId: string,
  subType?: 'my' | 'received'
): Promise<string> => {
  await ensureDirectories();
  const ext = getExtension(url);
  const filename = generateFilename(type, messageId, ext);
  const destDir = getDirForType(type, subType);
  const destPath = destDir + filename;

  const result = await FileSystem.downloadAsync(url, destPath);
  console.log(`[MediaManager] Downloaded: ${filename}`);
  return result.uri;
};

/**
 * Save to temp directory (staging before upload)
 */
export const saveToTemp = async (uri: string, messageId: string): Promise<string> => {
  await ensureDirectories();
  const ext = getExtension(uri);
  const destPath = `${DIRS.temp}temp_${messageId}_${Date.now()}.${ext}`;
  await FileSystem.copyAsync({ from: uri, to: destPath });
  return destPath;
};

/**
 * Check if a file exists locally
 */
export const fileExists = async (path: string): Promise<boolean> => {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists;
  } catch {
    return false;
  }
};

/**
 * Delete a local file
 */
export const deleteLocalFile = async (path: string): Promise<void> => {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      await FileSystem.deleteAsync(path, { idempotent: true });
    }
  } catch (e) {
    console.warn('[MediaManager] Failed to delete:', path, e);
  }
};

/**
 * Clean the temp directory (call after successful uploads)
 */
export const cleanTemp = async (): Promise<void> => {
  try {
    const info = await FileSystem.getInfoAsync(DIRS.temp);
    if (info.exists) {
      await FileSystem.deleteAsync(DIRS.temp, { idempotent: true });
      await FileSystem.makeDirectoryAsync(DIRS.temp, { intermediates: true });
    }
  } catch (e) {
    console.warn('[MediaManager] Failed to clean temp:', e);
  }
};

/**
 * Get total storage used by SoulSync media
 */
export const getStorageUsage = async (): Promise<{
  totalBytes: number;
  breakdown: Record<string, number>;
}> => {
  const breakdown: Record<string, number> = {};
  let totalBytes = 0;

  for (const [key, dir] of Object.entries(DIRS)) {
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (info.exists) {
        const files = await FileSystem.readDirectoryAsync(dir);
        let dirSize = 0;
        for (const file of files) {
          const fileInfo = await FileSystem.getInfoAsync(dir + file);
          if (fileInfo.exists && fileInfo.size) {
            dirSize += fileInfo.size;
          }
        }
        breakdown[key] = dirSize;
        totalBytes += dirSize;
      }
    } catch (e) {
      breakdown[key] = 0;
    }
  }

  return { totalBytes, breakdown };
};

/**
 * Format bytes to human-readable string
 */
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export const mediaManager = {
  ensureDirectories,
  saveMediaLocally,
  downloadMedia,
  saveToTemp,
  fileExists,
  deleteLocalFile,
  cleanTemp,
  getStorageUsage,
  formatBytes,
  BASE_DIR,
  DIRS,
};
