import { 
  documentDirectory, 
  getInfoAsync, 
  makeDirectoryAsync, 
  deleteAsync, 
  readDirectoryAsync, 
  moveAsync
} from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SOUL_BASE = (documentDirectory || '') + 'Soul/';

const FOLDERS: Record<string, string> = {
  databases: `${SOUL_BASE}Databases/`,
  images:    `${SOUL_BASE}Media/Soul Images/`,
  videos:    `${SOUL_BASE}Media/Soul Videos/`,
  audio:     `${SOUL_BASE}Media/Soul Audio/`,
  documents: `${SOUL_BASE}Media/Soul Documents/`,
  voiceNotes: `${SOUL_BASE}Media/Soul Voice Notes/`,
  imagesSent: `${SOUL_BASE}Media/Soul Images/Sent/`,
  videosSent: `${SOUL_BASE}Media/Soul Videos/Sent/`,
  audioSent:  `${SOUL_BASE}Media/Soul Audio/Sent/`,
  documentsSent: `${SOUL_BASE}Media/Soul Documents/Sent/`,
  voiceNotesSent: `${SOUL_BASE}Media/Soul Voice Notes/Sent/`,
  profilePhotos: `${SOUL_BASE}Media/Soul Profile Photos/`,
  stickers:      `${SOUL_BASE}Media/Soul Stickers/`,
  statuses:      `${SOUL_BASE}Media/.Statuses/`,
  backups:       `${SOUL_BASE}Backups/`,
  cache:         `${documentDirectory}media_cache/`,
};

// Media type prefixes for WhatsApp-style filenames
const FILE_PREFIX: Record<string, string> = {
  image:      'IMG',
  video:      'VID',
  audio:      'AUD',
  document:   'DOC',
  voice_note: 'PTT',
  file:       'DOC',
  status:     'STT',
};

// Map media type + direction to folder
const MEDIA_FOLDER_MAP: Record<string, string> = {
  'image_received': 'images',
  'image_sent': 'imagesSent',
  'video_received': 'videos',
  'video_sent': 'videosSent',
  'audio_received': 'audio',
  'audio_sent': 'audioSent',
  'document_received': 'documents',
  'document_sent': 'documentsSent',
  'file_received': 'documents',
  'file_sent': 'documentsSent',
  'voice_note_received': 'voiceNotes',
  'voice_note_sent': 'voiceNotesSent',
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let _initialized = false;
let _initPromise: Promise<void> | null = null;
let _mediaLibraryGranted = false;
const _albumCache: Record<string, MediaLibrary.Album> = {};

// Per-type daily counter for filenames
let _counterDate = '';
const _counters: Record<string, number> = {};

function getDailyCounter(mediaType: string): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (_counterDate !== today) {
    _counterDate = today;
    Object.keys(_counters).forEach(k => delete _counters[k]);
  }
  _counters[mediaType] = (_counters[mediaType] || 0) + 1;
  return String(_counters[mediaType]).padStart(4, '0');
}

function getExtension(uriOrKey: string): string {
  const clean = uriOrKey.split('?')[0].split('#')[0];
  const ext = clean.split('.').pop()?.toLowerCase();
  if (!ext || ext.length > 5) return 'bin';
  return ext;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export const soulFolderService = {

  async init(): Promise<void> {
    if (_initialized) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      const start = Date.now();
      try {
        // Parallelize all folder checks/creations
        await Promise.all(
          Object.values(FOLDERS).map(async (folder) => {
            const info = await getInfoAsync(folder);
            if (!info.exists) {
              await makeDirectoryAsync(folder, { intermediates: true });
            }
          })
        );
        
        _initialized = true;
        console.log(`[SoulFolderService] Storage initialized in ${Date.now() - start}ms`);
      } catch (error) {
        console.error('[SoulFolderService] Init failed:', error);
      }
    })();

    return _initPromise;
  },

  async migrateFromOldCache(): Promise<void> {
    // Legacy migration logic simplified
    return Promise.resolve();
  },

  async migrateOldStorageServiceFiles(): Promise<void> {
    return Promise.resolve();
  },

  getMediaPath(mediaType: string, isSent: boolean): string {
    const key = `${mediaType}_${isSent ? 'sent' : 'received'}`;
    const folderKey = MEDIA_FOLDER_MAP[key] || (isSent ? 'documentsSent' : 'documents');
    return FOLDERS[folderKey] || FOLDERS.documents;
  },

  generateFilename(mediaType: string, originalUri: string, id?: string): string {
    const prefix = FILE_PREFIX[mediaType] || 'DOC';
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counter = id ? id.slice(-4).toUpperCase() : getDailyCounter(mediaType);
    const ext = getExtension(originalUri);
    return `${prefix}-${date}-SOUL${counter}.${ext}`;
  },

  getDestinationPath(mediaType: string, isSent: boolean, originalUri: string, id?: string): string {
    const folder = this.getMediaPath(mediaType, isSent);
    return `${folder}${this.generateFilename(mediaType, originalUri, id)}`;
  },

  async getFolderSize(folderPath: string): Promise<{ fileCount: number; totalBytes: number }> {
    try {
      const files = await readDirectoryAsync(folderPath);
      let totalBytes = 0;
      let fileCount = 0;
      for (const file of files) {
        const info = await getInfoAsync(`${folderPath}${file}`);
        if (info.exists && !info.isDirectory) {
          totalBytes += info.size || 0;
          fileCount++;
        }
      }
      return { fileCount, totalBytes };
    } catch (_) {
      return { fileCount: 0, totalBytes: 0 };
    }
  },

  inferMediaType(ext: string): 'image' | 'video' | 'audio' | 'document' {
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'];
    const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp'];
    const audioExts = ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'opus', 'caf', 'flac'];

    if (imageExts.includes(ext.toLowerCase())) return 'image';
    if (videoExts.includes(ext.toLowerCase())) return 'video';
    if (audioExts.includes(ext.toLowerCase())) return 'audio';
    return 'document';
  },

  async saveToDeviceGallery(localUri: string, mediaType: string, isSent: boolean = false): Promise<boolean> {
    if (mediaType !== 'image' && mediaType !== 'video') return false;
    await this.init();

    if (!_mediaLibraryGranted) {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') return false;
      _mediaLibraryGranted = true;
    }

    try {
      const albumName = `Soul ${mediaType === 'image' ? 'Images' : 'Videos'}${isSent ? ' Sent' : ''}`;
      const asset = await MediaLibrary.createAssetAsync(localUri);
      let album = _albumCache[albumName] || await MediaLibrary.getAlbumAsync(albumName);
      
      if (album) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      } else {
        album = await MediaLibrary.createAlbumAsync(albumName, asset, false);
      }
      _albumCache[albumName] = album;
      return true;
    } catch (e) {
      console.warn('[SoulFolder] Gallery export failed:', e);
      return false;
    }
  },

  async getStorageBreakdown(): Promise<Record<string, { bytes: number; count: number }>> {
    const breakdown: Record<string, { bytes: number; count: number }> = {};
    const mediaTypes = ['images', 'videos', 'audio', 'documents', 'voiceNotes', 'profilePhotos', 'stickers', 'statuses'];
    
    for (const type of mediaTypes) {
      const receivedPath = FOLDERS[type];
      const sentPath = FOLDERS[type + 'Sent'];
      
      let totalBytes = 0;
      let totalCount = 0;
      
      if (receivedPath) {
        const stats = await this.getFolderSize(receivedPath);
        totalBytes += stats.totalBytes;
        totalCount += stats.fileCount;
      }
      
      if (sentPath) {
        const stats = await this.getFolderSize(sentPath);
        totalBytes += stats.totalBytes;
        totalCount += stats.fileCount;
      }
      
      breakdown[type] = { bytes: totalBytes, count: totalCount };
    }
    
    return breakdown;
  },

  async clearMediaByType(type: string): Promise<void> {
    const receivedPath = FOLDERS[type];
    const sentPath = FOLDERS[type + 'Sent'];
    
    if (receivedPath) {
      const files = await readDirectoryAsync(receivedPath);
      for (const file of files) {
        await deleteAsync(receivedPath + file, { idempotent: true });
      }
    }
    
    if (sentPath) {
      const files = await readDirectoryAsync(sentPath);
      for (const file of files) {
        await deleteAsync(sentPath + file, { idempotent: true });
      }
    }
  },

  async clearAllMedia(): Promise<void> {
    console.log('[SoulFolderService] Purging all user media...');
    try {
      // Clear all standard media folders
      const mediaTypes = ['images', 'videos', 'audio', 'documents', 'voiceNotes', 'profilePhotos', 'stickers', 'statuses', 'cache'];
      for (const type of mediaTypes) {
        const path = FOLDERS[type];
        if (path) {
          const info = await getInfoAsync(path);
          if (info.exists) {
            const files = await readDirectoryAsync(path);
            for (const file of files) {
              await deleteAsync(path + file, { idempotent: true });
            }
            
            // Also check for 'Sent' subfolder
            const sentPath = FOLDERS[type + 'Sent'];
            if (sentPath) {
              const sentInfo = await getInfoAsync(sentPath);
              if (sentInfo.exists) {
                const sentFiles = await readDirectoryAsync(sentPath);
                for (const file of sentFiles) {
                  await deleteAsync(sentPath + file, { idempotent: true });
                }
              }
            }
          }
        }
      }
      console.log('[SoulFolderService] Media purge complete.');
    } catch (error) {
      console.error('[SoulFolderService] Failed to clear all media:', error);
    }
  }
};
