import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SOUL_BASE = `${FileSystem.documentDirectory}Soul/`;

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

// Complete folder structure
const FOLDERS = {
  // Databases
  databases:       `${SOUL_BASE}Databases/`,

  // Media — Received (root of each type folder)
  images:          `${SOUL_BASE}Media/Soul Images/`,
  videos:          `${SOUL_BASE}Media/Soul Videos/`,
  audio:           `${SOUL_BASE}Media/Soul Audio/`,
  documents:       `${SOUL_BASE}Media/Soul Documents/`,
  voiceNotes:      `${SOUL_BASE}Media/Soul Voice Notes/`,

  // Media — Sent (Sent/ subfolder inside each type)
  imagesSent:      `${SOUL_BASE}Media/Soul Images/Sent/`,
  videosSent:      `${SOUL_BASE}Media/Soul Videos/Sent/`,
  audioSent:       `${SOUL_BASE}Media/Soul Audio/Sent/`,
  documentsSent:   `${SOUL_BASE}Media/Soul Documents/Sent/`,
  voiceNotesSent:  `${SOUL_BASE}Media/Soul Voice Notes/Sent/`,

  // Other media
  profilePhotos:   `${SOUL_BASE}Media/Soul Profile Photos/`,
  stickers:        `${SOUL_BASE}Media/Soul Stickers/`,
  statuses:        `${SOUL_BASE}Media/.Statuses/`,

  // Backups
  backups:         `${SOUL_BASE}Backups/`,
} as const;

// Map media type + direction to folder
const MEDIA_FOLDER_MAP: Record<string, { received: string; sent: string }> = {
  image:      { received: FOLDERS.images,     sent: FOLDERS.imagesSent     },
  video:      { received: FOLDERS.videos,     sent: FOLDERS.videosSent     },
  audio:      { received: FOLDERS.audio,      sent: FOLDERS.audioSent      },
  document:   { received: FOLDERS.documents,  sent: FOLDERS.documentsSent  },
  file:       { received: FOLDERS.documents,  sent: FOLDERS.documentsSent  },
  voice_note: { received: FOLDERS.voiceNotes, sent: FOLDERS.voiceNotesSent },
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let _initialized = false;
let _initPromise: Promise<void> | null = null;

// Per-type daily counter for filenames (resets when date changes)
let _counterDate = '';
const _counters: Record<string, number> = {};

function getDailyCounter(mediaType: string): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (_counterDate !== today) {
    _counterDate = today;
    Object.keys(_counters).forEach(k => delete _counters[k]);
  }
  const key = mediaType;
  _counters[key] = (_counters[key] || 0) + 1;
  return String(_counters[key]).padStart(4, '0');
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

  // ── Initialize ────────────────────────────────────────────────────────────
  // Call once at app startup (idempotent — safe to call multiple times)
  async init(): Promise<void> {
    if (_initialized) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      console.log('[SoulFolder] Initializing folder structure...');

      // Create all folders
      for (const [name, path] of Object.entries(FOLDERS)) {
        try {
          const info = await FileSystem.getInfoAsync(path);
          if (!info.exists) {
            await FileSystem.makeDirectoryAsync(path, { intermediates: true });
            console.log(`[SoulFolder] Created: ${name}`);
          }
        } catch (e: any) {
          console.warn(`[SoulFolder] Failed to create ${name}:`, e.message);
        }
      }

      // Android: create .nomedia to prevent gallery from indexing Soul media
      if (Platform.OS === 'android') {
        const nomediaPath = `${SOUL_BASE}.nomedia`;
        try {
          const info = await FileSystem.getInfoAsync(nomediaPath);
          if (!info.exists) {
            await FileSystem.writeAsStringAsync(nomediaPath, '');
            console.log('[SoulFolder] Created .nomedia');
          }
        } catch (_) {}
      }

      _initialized = true;
      console.log('[SoulFolder] Folder structure ready.');
    })();

    return _initPromise;
  },

  // ── Get media folder path ─────────────────────────────────────────────────
  // Returns the correct subfolder for a given media type and direction.
  //
  // Usage:
  //   soulFolderService.getMediaPath('image', false)  → Soul Images/     (received)
  //   soulFolderService.getMediaPath('image', true)   → Soul Images/Sent/ (sent)
  //   soulFolderService.getMediaPath('video', false)  → Soul Videos/
  //   soulFolderService.getMediaPath('audio', true)   → Soul Audio/Sent/
  //
  getMediaPath(
    mediaType: 'image' | 'video' | 'audio' | 'document' | 'file' | 'voice_note' | 'status' | 'profile_photo',
    isSent: boolean
  ): string {
    if (mediaType === 'status') return FOLDERS.statuses;
    if (mediaType === 'profile_photo') return FOLDERS.profilePhotos;

    const mapping = MEDIA_FOLDER_MAP[mediaType];
    if (!mapping) {
      console.warn(`[SoulFolder] Unknown media type: ${mediaType}, defaulting to documents`);
      return isSent ? FOLDERS.documentsSent : FOLDERS.documents;
    }
    return isSent ? mapping.sent : mapping.received;
  },

  // ── Generate WhatsApp-style filename ──────────────────────────────────────
  // Format: IMG-20250115-SOUL0001.jpg
  //
  // Usage:
  //   soulFolderService.generateFilename('image', 'photo.jpg')
  //     → "IMG-20250328-SOUL0001.jpg"
  //
  generateFilename(
    mediaType: 'image' | 'video' | 'audio' | 'document' | 'file' | 'voice_note' | 'status' | 'profile_photo',
    originalUri: string,
    id?: string
  ): string {
    const prefix = FILE_PREFIX[mediaType] || 'DOC';
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counter = id ? id.slice(-4).toUpperCase() : getDailyCounter(mediaType);
    const ext = getExtension(originalUri);
    return `${prefix}-${date}-SOUL${counter}.${ext}`;
  },

  // ── Get full destination path for a media file ────────────────────────────
  // Combines getMediaPath + generateFilename into a single call.
  //
  // Usage:
  //   const destPath = soulFolderService.getDestinationPath('image', false, 'photo.jpg');
  //   // → ".../Soul/Media/Soul Images/IMG-20250328-SOUL0001.jpg"
  //
  getDestinationPath(
    mediaType: 'image' | 'video' | 'audio' | 'document' | 'file' | 'voice_note' | 'status' | 'profile_photo',
    isSent: boolean,
    originalUri: string,
    id?: string
  ): string {
    const folder = this.getMediaPath(mediaType, isSent);
    const filename = this.generateFilename(mediaType, originalUri, id);
    return `${folder}${filename}`;
  },

  // ── Other paths ───────────────────────────────────────────────────────────

  getBasePath(): string {
    return SOUL_BASE;
  },

  getDatabasePath(): string {
    return FOLDERS.databases;
  },

  getStatusPath(): string {
    return FOLDERS.statuses;
  },

  getBackupPath(): string {
    return FOLDERS.backups;
  },

  getProfilePhotoPath(): string {
    return FOLDERS.profilePhotos;
  },

  getStickerPath(): string {
    return FOLDERS.stickers;
  },

  // ── Migrate old media_cache files to organized structure ──────────────────
  // Moves files from the old flat media_cache/ folder to the new Soul/ structure.
  // Run this once after enabling the new folder system. Non-destructive — if a
  // file already exists at the destination, it skips it.
  //
  async migrateFromOldCache(): Promise<{ migrated: number; skipped: number; errors: number }> {
    const oldCacheDir = `${FileSystem.documentDirectory}media_cache`;
    const stats = { migrated: 0, skipped: 0, errors: 0 };

    try {
      const info = await FileSystem.getInfoAsync(oldCacheDir);
      if (!info.exists) {
        console.log('[SoulFolder] No old media_cache to migrate.');
        return stats;
      }

      const files = await FileSystem.readDirectoryAsync(oldCacheDir);
      console.log(`[SoulFolder] Migrating ${files.length} files from media_cache...`);

      for (const file of files) {
        try {
          const ext = getExtension(file);
          const mediaType = this.inferMediaType(ext);
          // Old cache has no sent/received info — default to received
          const destPath = this.getDestinationPath(mediaType, false, file);

          const destInfo = await FileSystem.getInfoAsync(destPath);
          if (destInfo.exists) {
            stats.skipped++;
            continue;
          }

          await FileSystem.moveAsync({
            from: `${oldCacheDir}/${file}`,
            to: destPath,
          });
          stats.migrated++;
        } catch (e) {
          stats.errors++;
          console.warn(`[SoulFolder] Failed to migrate ${file}:`, e);
        }
      }

      // Try to remove old cache dir if empty
      try {
        const remaining = await FileSystem.readDirectoryAsync(oldCacheDir);
        if (remaining.length === 0) {
          await FileSystem.deleteAsync(oldCacheDir, { idempotent: true });
          console.log('[SoulFolder] Removed empty media_cache/');
        }
      } catch (_) {}

      console.log(`[SoulFolder] Migration complete: ${stats.migrated} migrated, ${stats.skipped} skipped, ${stats.errors} errors`);
      return stats;
    } catch (e) {
      console.error('[SoulFolder] Migration failed:', e);
      return stats;
    }
  },

  // Also handle old documentDirectory/cached_media_* files from StorageService
  async migrateOldStorageServiceFiles(): Promise<number> {
    let migrated = 0;
    try {
      const docDir = FileSystem.documentDirectory;
      if (!docDir) return 0;

      const files = await FileSystem.readDirectoryAsync(docDir);
      const oldFiles = files.filter(f => f.startsWith('cached_media_'));

      for (const file of oldFiles) {
        try {
          const ext = getExtension(file);
          const mediaType = this.inferMediaType(ext);
          const destPath = this.getDestinationPath(mediaType, false, file);

          await FileSystem.moveAsync({
            from: `${docDir}${file}`,
            to: destPath,
          });
          migrated++;
        } catch (_) {}
      }

      if (migrated > 0) {
        console.log(`[SoulFolder] Migrated ${migrated} old StorageService cached files`);
      }
    } catch (_) {}
    return migrated;
  },

  // ── Infer media type from file extension ──────────────────────────────────
  inferMediaType(ext: string): 'image' | 'video' | 'audio' | 'document' {
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'];
    const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp'];
    const audioExts = ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'opus', 'caf', 'flac'];

    if (imageExts.includes(ext)) return 'image';
    if (videoExts.includes(ext)) return 'video';
    if (audioExts.includes(ext)) return 'audio';
    return 'document';
  },

  // ── Storage stats per folder ──────────────────────────────────────────────
  async getFolderSize(folderPath: string): Promise<{ fileCount: number; totalBytes: number }> {
    try {
      const info = await FileSystem.getInfoAsync(folderPath);
      if (!info.exists) return { fileCount: 0, totalBytes: 0 };

      const files = await FileSystem.readDirectoryAsync(folderPath);
      let totalBytes = 0;
      let fileCount = 0;

      for (const file of files) {
        // Skip subdirectories (like Sent/)
        const filePath = `${folderPath}${file}`;
        const fileInfo = await FileSystem.getInfoAsync(filePath);
        if (fileInfo.exists && !(fileInfo as any).isDirectory) {
          totalBytes += (fileInfo as any).size || 0;
          fileCount++;
        }
      }

      return { fileCount, totalBytes };
    } catch (_) {
      return { fileCount: 0, totalBytes: 0 };
    }
  },

  // Get complete storage breakdown like WhatsApp's storage management screen
  async getStorageBreakdown(): Promise<Record<string, { received: { fileCount: number; totalBytes: number }; sent: { fileCount: number; totalBytes: number } }>> {
    const types = ['images', 'videos', 'audio', 'documents', 'voiceNotes'] as const;
    const sentKeys = ['imagesSent', 'videosSent', 'audioSent', 'documentsSent', 'voiceNotesSent'] as const;

    const result: Record<string, any> = {};

    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        const sentKey = sentKeys[i];
        result[type] = {
            received: await this.getFolderSize(FOLDERS[type]),
            sent: await this.getFolderSize(FOLDERS[sentKey]),
        };
    }

    return result;
  },

  // ── Clear media by type ───────────────────────────────────────────────────
  async clearMediaByType(
    mediaType: 'images' | 'videos' | 'audio' | 'documents' | 'voiceNotes',
    direction: 'sent' | 'received' | 'both'
  ): Promise<number> {
    let deleted = 0;

    const clearFolder = async (folderPath: string) => {
      try {
        const files = await FileSystem.readDirectoryAsync(folderPath);
        for (const file of files) {
          const filePath = `${folderPath}${file}`;
          const info = await FileSystem.getInfoAsync(filePath);
          if (info.exists && !(info as any).isDirectory) {
            await FileSystem.deleteAsync(filePath, { idempotent: true });
            deleted++;
          }
        }
      } catch (_) {}
    };

    if (direction === 'received' || direction === 'both') {
      await clearFolder(FOLDERS[mediaType]);
    }
    if (direction === 'sent' || direction === 'both') {
      const sentKey = `${mediaType}Sent` as keyof typeof FOLDERS;
      if (FOLDERS[sentKey]) {
        await clearFolder(FOLDERS[sentKey]);
      }
    }

    console.log(`[SoulFolder] Cleared ${deleted} ${mediaType} files (${direction})`);
    return deleted;
  },
};
