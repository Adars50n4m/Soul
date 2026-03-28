import * as FileSystem from 'expo-file-system';
import { SERVER_URL, safeFetchJson } from '../config/api';
import { R2_CONFIG } from '../config/r2';
import { r2StorageService } from './R2StorageService';
import { offlineService } from './LocalDBService';
import { mediaDownloadService } from './MediaDownloadService';
import { soulFolderService } from './SoulFolderService';

// Public R2 URL for direct access when server is unavailable
const R2_PUBLIC_BASE = R2_CONFIG.PUBLIC_URL && !R2_CONFIG.PUBLIC_URL.includes('XXXXXXXXXXXX')
    ? R2_CONFIG.PUBLIC_URL.replace(/\/$/, '')
    : null;

export const storageService = {
    /**
     * Upload media (image or video) to storage via Server Presigned URLs
     */
    async uploadImage(uri: string, bucket: string, folder: string = '', onProgress?: (progress: number) => void): Promise<string | null> {
        console.log(`[StorageService] Starting upload for: ${uri}`);
        try {
            const ext = uri.split('.').pop()?.toLowerCase() || 'jpg';
            const fileName = `${folder ? folder + '-' : ''}${Date.now()}.${ext}`;

            // Determine content type
            let contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
                contentType = `video/${ext === 'mov' ? 'quicktime' : ext}`;
            } else if (['m4a', 'mp3', 'wav', 'aac', 'caf', 'opus'].includes(ext)) {
                // Precision: iOS uses audio/x-m4a or audio/x-caf usually
                if (ext === 'm4a') contentType = 'audio/x-m4a';
                else if (ext === 'caf') contentType = 'audio/x-caf';
                else if (ext === 'mp3') contentType = 'audio/mpeg';
                else contentType = `audio/${ext}`;
            }

            console.log(`[StorageService] Determined contentType: ${contentType}, fileName: ${fileName}`);

            // 1. Get Presigned PUT URL from Node Server (with short timeout)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout for presign

            const { success, data, error } = await safeFetchJson<{ presignedUrl: string, key: string }>(
                `${SERVER_URL}/api/media/presign-upload`, 
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName, contentType }),
                    signal: controller.signal
                }
            ).finally(() => clearTimeout(timeoutId));
            
            if (!success || !data) {
                console.warn(`[StorageService] Presign failed (${error}). Falling back to Direct R2.`);
                // Fallback to direct R2 worker if server fails
                try {
                    return await r2StorageService.uploadImage(uri, bucket, folder);
                } catch (fallbackErr: any) {
                    console.error('[StorageService] Fallback also failed:', fallbackErr.message);
                    throw new Error(error || 'Failed to get presigned URL from server');
                }
            }
            
            const { presignedUrl, key } = data;

            // Resolve ph:// URIs
            if (uri.startsWith('ph://')) {
                try {
                    const assetId = uri.substring(5).split('/')[0];
                    const MediaLibrary = require('expo-media-library');
                    const info = await MediaLibrary.getAssetInfoAsync(assetId);
                    if (info && (info.localUri || info.uri)) {
                        uri = info.localUri || info.uri;
                    }
                } catch (err) {
                    console.warn(`[StorageService] Failed to resolve ph:// URI:`, err);
                }
            }

            // Verify file exists
            const fileInfo = await FileSystem.getInfoAsync(uri);
            if (!fileInfo.exists) {
                // Try file:// prefix
                if (!uri.startsWith('file://')) {
                    const fixedUri = 'file://' + uri;
                    const secondCheck = await FileSystem.getInfoAsync(fixedUri);
                    if (secondCheck.exists) uri = fixedUri;
                    else throw new Error('File not found: ' + uri);
                } else {
                    throw new Error('File not found: ' + uri);
                }
            }

            // 2. Upload to R2
            const uploadTask = FileSystem.createUploadTask(
                presignedUrl,
                uri,
                {
                    httpMethod: 'PUT',
                    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                    headers: { 'Content-Type': contentType }
                },
                (progress) => {
                    if (onProgress) {
                        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
                    }
                }
            );

            const uploadRes = await uploadTask.uploadAsync();

            if (uploadRes?.status !== 200 && uploadRes?.status !== 201 && uploadRes?.status !== 204) {
                 throw new Error(`R2 Upload failed: ${uploadRes?.status}`);
            }

            console.log(`[StorageService] Upload successful: ${key}`);
            return key; 
        } catch (e: any) {
            console.warn(`[StorageService] Upload error:`, e.message);
            // Emergency fallback
            if (bucket === 'chat-media' || bucket === 'status-media' || bucket === 'avatars') {
                return await r2StorageService.uploadImage(uri, bucket, folder);
            }
            throw e; 
        }
    },

    /**
     * Get local playable/viewable URL for an R2 key (with WhatsApp-style organized caching)
     */
    async getMediaUrl(r2Key: string, messageId?: string, mediaType?: string): Promise<string | null> {
        if (!r2Key) return null;
        
        // Return as-is if it's already a local file
        if (r2Key.startsWith('file://') || r2Key.startsWith('data:')) {
            return r2Key;
        }

        try {
            // 1. Check local SQLite cache first (if we have a messageId)
            if (messageId) {
                const cachedPath = await offlineService.getMediaDownload(messageId);
                if (cachedPath) {
                    const info = await FileSystem.getInfoAsync(cachedPath);
                    if (info.exists) return cachedPath;
                }
            }

            // 2. Fallback: Search in the new organized Soul folders
            // This handles cases where we have the file but lost the DB record
            const ext = r2Key.split('.').pop()?.split('?')[0] || 'jpg';
            const inferredType = mediaType || soulFolderService.inferMediaType(ext);
            
            // Note: We don't know the exact filename because SoulFolderService 
            // uses dynamic counters, but we can check if the file exists anyway
            // if we really need to. For now, we proceed to download if DB hit failed.

            // 3. Fetch Presigned Download URL from Server
            const { success, data } = await safeFetchJson<{ presignedUrl: string }>(
                `${SERVER_URL}/api/media/presign-download`, 
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: r2Key })
                }
            );

            let downloadUrl = data?.presignedUrl;

            if (!success || !downloadUrl) {
                // Fallback: public R2 URL
                if (R2_PUBLIC_BASE) {
                    downloadUrl = `${R2_PUBLIC_BASE}/${r2Key}`;
                } else {
                    return r2Key.startsWith('http') ? r2Key : null;
                }
            }

            // 4. Download organizesly if we have a messageId
            if (messageId) {
                const result = await mediaDownloadService.downloadMedia(
                    messageId, 
                    downloadUrl, 
                    undefined, 
                    inferredType
                );
                if (result.success && result.localUri) {
                    return result.localUri;
                }
            }

            // 5. If no messageId, do a temporary non-tracked download (fallback)
            const tempPath = `${FileSystem.cacheDirectory}preview_${Date.now()}.${ext}`;
            const downloadRes = await FileSystem.downloadAsync(downloadUrl, tempPath);
            return downloadRes.uri;

        } catch (error) {
            console.warn(`[StorageService] Resolver failure for ${r2Key}:`, error);
            if (R2_PUBLIC_BASE) return `${R2_PUBLIC_BASE}/${r2Key}`;
            return r2Key.startsWith('http') ? r2Key : null;
        }
    },

    /**
     * For sent media: save it to the organized "Sent/" folder
     */
    async saveSentMedia(messageId: string, localUri: string, mediaType: string): Promise<string | null> {
        try {
            const result = await mediaDownloadService.saveLocalMediaFromUri(messageId, localUri, mediaType);
            if (result.success && result.localUri) {
                // Update DB so we don't try to download what we just sent
                await offlineService.updateMessageLocalUri(messageId, result.localUri, result.fileSize || 0);
                return result.localUri;
            }
            return null;
        } catch (e) {
            console.warn('[StorageService] Failed to save sent media:', e);
            return null;
        }
    }
};
