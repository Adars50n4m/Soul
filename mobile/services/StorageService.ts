import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { SERVER_URL, safeFetchJson } from '../config/api';
import { R2_CONFIG } from '../config/r2';
import { USE_R2 } from '../config/env';
import { r2StorageService, UploadResponse, R2AuthError } from './R2StorageService';
import { offlineService } from './LocalDBService';
import { mediaDownloadService } from './MediaDownloadService';
import { soulFolderService } from './SoulFolderService';

// Public R2 URL for direct access when server is unavailable
const R2_PUBLIC_BASE = R2_CONFIG.PUBLIC_URL && !R2_CONFIG.PUBLIC_URL.includes('XXXXXXXXXXXX')
    ? R2_CONFIG.PUBLIC_URL.replace(/\/$/, '')
    : null;

const isR2AuthFailure = (error: any): boolean => {
    if (!error) return false;
    if (error instanceof R2AuthError) return true;

    const message = typeof error?.message === 'string' ? error.message : '';
    return message.includes('Auth token missing')
        || message.includes('Authentication required')
        || message.includes('Worker auth rejected request')
        || message.includes('Unauthorized');
};

const isNetworkLikeError = (error: any): boolean => {
    const message = typeof error?.message === 'string' ? error.message : '';
    return error?.name === 'AbortError'
        || message.includes('fetch')
        || message.includes('Network');
};

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
        if (!uri) return 'application/octet-stream';

        // 1. Try to get extension from the end of the URI (standard file paths)
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

        if (map[ext]) return map[ext];

        // 2. Special handling for Android content:// URIs which often lack extensions
        if (uri.startsWith('content://')) {
            if (uri.includes('image')) return 'image/jpeg';
            if (uri.includes('video')) return 'video/mp4';
            if (uri.includes('audio')) return 'audio/x-m4a';
        }

        return 'application/octet-stream';
    },

    async uploadViaServerProxy(
        localUri: string,
        bucket: string,
        folder: string = '',
        contentType: string,
        onProgress?: (progress: number) => void
    ): Promise<string | null> {
        console.log(`[StorageService] Uploading via server proxy to ${bucket}/${folder || ''}`);

        const uploadTask = FileSystem.createUploadTask(
            `${SERVER_URL}/api/media/upload`,
            localUri,
            {
                httpMethod: 'POST',
                uploadType: FileSystem.FileSystemUploadType.MULTIPART,
                fieldName: 'file',
                mimeType: contentType,
                parameters: {
                    bucket,
                    folder: folder || '',
                },
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
        if (!result || result.status < 200 || result.status >= 300) {
            throw new Error(`Upload proxy failed with status ${result?.status || 'unknown'}`);
        }

        let payload: Partial<UploadResponse> = {};
        try {
            payload = result.body ? JSON.parse(result.body) : {};
        } catch {
            console.warn('[StorageService] Failed to parse proxy response body');
        }

        if (result && result.status >= 200 && result.status < 300 && payload.success) {
            const key = payload.key || payload.filename;
            if (key) return key;
        }

        throw new Error(payload.error || `Upload proxy failed with status ${result?.status || 'unknown'}`);
    },

    /**
     * Upload media (image or video) to storage via Server Presigned URLs
     */
    async uploadImage(uri: string, bucket: string, folder: string = '', onProgress?: (progress: number) => void): Promise<string | null> {
        console.log(`[StorageService] Starting upload for: ${uri}`);
        let localUri = uri;
        let r2AuthUnavailable = false;
        try {
            // 1. Resolve URI to local file path
            localUri = await this.resolveUri(uri);
            const contentType = this.getMimeType(localUri);
            const ext = localUri.split('.').pop()?.toLowerCase() || 'jpg';
            const fileName = `${folder ? folder + '-' : ''}${Date.now()}.${ext}`;

            console.log(`[StorageService] Prepared: ${fileName} (${contentType})`);

            // 1. Priority: Direct R2 Worker path if enabled
            if (USE_R2) {
                try {
                    console.log(`[StorageService] Priority: Direct R2 upload to ${bucket}/${folder}`);
                    const r2Key = await r2StorageService.uploadImage(localUri, bucket, folder, onProgress);
                    if (r2Key) {
                        console.log(`[StorageService] Direct R2 success: ${r2Key}`);
                        return r2Key;
                    }
                } catch (r2Err: any) {
                    if (isR2AuthFailure(r2Err)) {
                        r2AuthUnavailable = true;
                        console.warn('[StorageService] Direct R2 skipped: no valid auth session. Falling back to server upload paths.');
                    } else {
                        console.warn(`[StorageService] Direct R2 failed: ${r2Err.message}. Falling back to Server Presigned.`);
                    }
                }
            }

            // 2. Preferred fallback on mobile: send multipart to local Node server.
            // iOS `createUploadTask` is more reliable against our server than direct presigned PUT.
            try {
                const proxiedKey = await this.uploadViaServerProxy(localUri, bucket, folder, contentType, onProgress);
                if (proxiedKey) {
                    console.log(`[StorageService] Server proxy upload success: ${proxiedKey}`);
                    return proxiedKey;
                }
            } catch (proxyErr: any) {
                console.warn(`[StorageService] Server proxy upload failed: ${proxyErr.message}. Falling back to presigned PUT.`);
            }

            // 3. Final fallback: Get Presigned PUT URL from Node Server
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
                if (!r2AuthUnavailable) {
                    try {
                        return await r2StorageService.uploadImage(localUri, bucket, folder);
                    } catch (fallbackErr: any) {
                        console.warn('[StorageService] Fallback also failed:', fallbackErr.message);
                    }
                }
                throw new Error(error || 'Failed to get presigned URL from server');
            }
            
            const { presignedUrl, key } = data;

            // 4. Perform the binary upload to R2 via presigned URL
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
                try {
                    const proxiedKey = await this.uploadViaServerProxy(localUri, bucket, folder, contentType, onProgress);
                    if (proxiedKey) {
                        console.log(`[StorageService] Recovered via server proxy after presigned failure: ${proxiedKey}`);
                        return proxiedKey;
                    }
                } catch (proxyErr: any) {
                    console.warn(`[StorageService] Recovery via server proxy failed: ${proxyErr.message}`);
                }
                throw new Error(`Upload failed with status ${result?.status || 'unknown'}`);
            }
        } catch (e: any) {
            console.warn(`[StorageService] Upload catch error:`, e.message);
            // Emergency fallback for network errors or timeouts
            if (isNetworkLikeError(e) && !r2AuthUnavailable) {
               try {
                 console.log(`[StorageService] Emergency R2 fallback for: ${localUri}`);
                 return await r2StorageService.uploadImage(localUri, bucket, folder);
               } catch (finalErr) {
                 console.warn('[StorageService] Emergency fallback failed:', finalErr);
               }
            }

            if (isNetworkLikeError(e) && r2AuthUnavailable) {
                throw new Error('Upload requires an active session or reachable sync server. Please log in again and retry.');
            }

            throw e; 
        }
    },

    /**
     * Upload status media (image or video) specifically to the statuses/ folder
     */
    async uploadStatusMedia(uri: string, userId: string, mediaType: 'image' | 'video', onProgress?: (progress: number) => void): Promise<string | null> {
        return this.uploadImage(uri, 'status-media', `status-${userId}`, onProgress);
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
    },

    /**
     * Download media to device local storage specifically for statuses
     * Returns local file path
     */
    async downloadToDevice(signedUrl: string, statusId: string, mediaType: string): Promise<string | null> {
        try {
            const ext = mediaType === 'video' ? 'mp4' : 'jpg';
            const directory = `${FileSystem.documentDirectory}soulsync_status/`;
            const localPath = `${directory}${statusId}.${ext}`;

            // Ensure directory exists
            const dirInfo = await FileSystem.getInfoAsync(directory);
            if (!dirInfo.exists) {
                await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
            }

            // Check if already exists
            const fileInfo = await FileSystem.getInfoAsync(localPath);
            if (fileInfo.exists) return localPath;

            // Perform download from provided signedUrl
            const downloadRes = await FileSystem.downloadAsync(signedUrl, localPath);
            console.log(`[StorageService] Downloaded status ${statusId} to ${downloadRes.uri}`);
            return downloadRes.uri;
        } catch (e) {
            console.warn(`[StorageService] Failed to download status media:`, e);
            return null;
        }
    },

    /**
     * Get signed URL for an R2 key (valid for 25 hours / 90000 seconds)
     */
    async getSignedUrl(key: string): Promise<string | null> {
        try {
            if (key.startsWith('http')) {
              console.log('[StorageService] Key is already a URL, returning as is');
              return key;
            }

            const { success, data } = await safeFetchJson<{ presignedUrl: string }>(
                `${SERVER_URL}/api/media/presign-download`, 
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key, expires: 90000 })
                }
            );

            if (success && data?.presignedUrl) {
                return data.presignedUrl;
            }

            if (R2_PUBLIC_BASE) {
                return `${R2_PUBLIC_BASE}/${key}`;
            }

            return null;
        } catch (e) {
            console.error('[StorageService] getSignedUrl failed:', e);
            if (R2_PUBLIC_BASE && !key.startsWith('http')) {
                return `${R2_PUBLIC_BASE}/${key}`;
            }
            return null;
        }
    },

    /**
     * Delete file from R2
     */
    async deleteMedia(key: string): Promise<void> {
        try {
            if (!key || key.startsWith('http')) return;

            await safeFetchJson(`${SERVER_URL}/api/media/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys: [key] })
            });
        } catch (e) {
            console.error('[StorageService] deleteMedia failed:', e);
        }
    }
};
