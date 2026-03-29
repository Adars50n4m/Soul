import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
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
     * Resolves a potentially complex URI (like ph:// on iOS) to a local file path.
     */
    async resolveUri(uri: string): Promise<string> {
        if (Platform.OS === 'ios' && uri.startsWith('ph://')) {
            try {
                const assetId = uri.substring(5).split('/')[0];
                const info = await MediaLibrary.getAssetInfoAsync(assetId);
                if (info && (info.localUri || info.uri)) {
                    return info.localUri || info.uri || uri;
                }
            } catch (e) {
                console.warn('[StorageService] Failed to resolve ph:// URI:', e);
            }
        }
        return uri;
    },

    /**
     * Detects MIME type from URI/Filename
     */
    getMimeType(uri: string): string {
        const ext = uri.split('.').pop()?.toLowerCase() || '';
        const map: Record<string, string> = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'webp': 'image/webp',
            'gif': 'image/gif',
            'mp4': 'video/mp4',
            'mov': 'video/quicktime',
            'm4v': 'video/mp4',
            'm4a': 'audio/x-m4a',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav',
            'aac': 'audio/aac',
            'caf': 'audio/x-caf'
        };
        return map[ext] || 'application/octet-stream';
    },

    /**
     * Upload media (image or video) to storage via Server Presigned URLs
     */
    async uploadImage(uri: string, bucket: string, folder: string = '', onProgress?: (progress: number) => void): Promise<string | null> {
        console.log(`[StorageService] Starting upload for: ${uri}`);
        try {
            // 0. Resolve URI and Detect Content Type
            const localUri = await this.resolveUri(uri);
            const contentType = this.getMimeType(localUri);
            const ext = localUri.split('.').pop()?.toLowerCase() || 'jpg';
            const fileName = `${folder ? folder + '-' : ''}${Date.now()}.${ext}`;

            console.log(`[StorageService] Prepared: ${fileName} (${contentType})`);

            // 1. Get Presigned PUT URL from Node Server (with short timeout)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for presign

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
                    return await r2StorageService.uploadImage(localUri, bucket, folder);
                } catch (fallbackErr: any) {
                    console.error('[StorageService] Fallback also failed:', fallbackErr.message);
                    throw new Error(error || 'Failed to get presigned URL from server');
                }
            }
            
            const { presignedUrl, key } = data;

            // 2. Perform the binary upload to R2 via presigned URL
            const uploadTask = FileSystem.createUploadTask(
                presignedUrl,
                localUri,
                {
                    httpMethod: 'PUT',
                    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                    headers: { 'Content-Type': contentType }
                },
                (progress) => {
                    if (onProgress && progress.totalBytesExpectedToSend > 0) {
                        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
                    } else if (onProgress && progress.totalBytesSent > 0) {
                        onProgress(0.01);
                    }
                }
            );

            const result = await uploadTask.uploadAsync();

            if (result && (result.status === 200 || result.status === 201 || result.status === 204)) {
                console.log(`[StorageService] Upload success: ${key}`);
                return key;
            } else {
                throw new Error(`Upload failed with status ${result?.status || 'unknown'}`);
            }
        } catch (e: any) {
            console.warn(`[StorageService] Upload catch error:`, e.message);
            // Emergency fallback for network errors or timeouts
            if (e.name === 'AbortError' || e.message.includes('fetch') || e.message.includes('Network')) {
               try {
                 return await r2StorageService.uploadImage(uri, bucket, folder);
               } catch (finalErr) {
                 console.error('[StorageService] Emergency fallback failed:', finalErr);
               }
            }
            throw e; 
        }
    },

    /**
     * Get local playable/viewable URL for an R2 key (with organized caching)
     */
    async getMediaUrl(r2Key: string, messageId?: string, mediaType?: string): Promise<string | null> {
        if (!r2Key) return null;
        
        if (r2Key.startsWith('file://') || r2Key.startsWith('data:')) {
            return r2Key;
        }

        try {
            if (messageId) {
                const cachedPath = await offlineService.getMediaDownload(messageId);
                if (cachedPath) {
                    const info = await FileSystem.getInfoAsync(cachedPath);
                    if (info.exists) return cachedPath;
                }
            }

            const ext = r2Key.split('.').pop()?.split('?')[0] || 'jpg';
            const inferredType = mediaType || soulFolderService.inferMediaType(ext);
            
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
                if (R2_PUBLIC_BASE) {
                    downloadUrl = `${R2_PUBLIC_BASE}/${r2Key}`;
                } else {
                    return r2Key.startsWith('http') ? r2Key : null;
                }
            }

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
