import {
  getInfoAsync,
  cacheDirectory,
  downloadAsync,
  documentDirectory,
  makeDirectoryAsync
} from 'expo-file-system';
import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import { SERVER_URL, safeFetchJson } from '../config/api';
import { R2_CONFIG } from '../config/r2';
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
        || message.includes('timeout')
        || message.includes('fetch')
        || message.includes('Network')
        || message.includes('Aborted');
};

const isMissingUploadRouteError = (error: any): boolean => {
    const message = typeof error?.message === 'string' ? error.message : '';
    return message.includes('status 404')
        || message.includes('status 405')
        || message.includes('Not found');
};

const isPayloadTooLargeError = (error: any): boolean => {
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    return message.includes('file too large')
        || message.includes('too large')
        || message.includes('payload too large')
        || message.includes('worker returned 413')
        || message.includes('status 413');
};

const inFlightUploads = new Map<string, Promise<string | null>>();

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
        
        // 2. Special handling for common Android/iOS patterns if extension is missing
        const lowerUri = uri.toLowerCase();
        if (lowerUri.includes('image') || lowerUri.includes('photo')) return 'image/jpeg';
        if (lowerUri.includes('video')) return 'video/mp4';
        if (lowerUri.includes('audio')) return 'audio/x-m4a';

        return 'application/octet-stream';
    },

    /**
     * Helper to ensure a filename has an extension based on its MIME type.
     * Critical for Android FormData uploads.
     */
    ensureExtension(fileName: string, mimeType: string): string {
        if (fileName.includes('.')) return fileName;
        
        const map: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'video/mp4': 'mp4',
            'video/quicktime': 'mov',
            'audio/x-m4a': 'm4a',
            'audio/mpeg': 'mp3',
            'audio/wav': 'wav',
        };
        
        const ext = map[mimeType] || 'bin';
        return `${fileName}.${ext}`;
    },

    async uploadViaServerProxy(
        localUri: string,
        bucket: string,
        folder: string = '',
        contentType: string,
        onProgress?: (progress: number) => void
    ): Promise<string | null> {
        console.log(`[StorageService] Uploading via server proxy to ${bucket}/${folder || ''}`);

        const fileCheck = await getInfoAsync(localUri);
        if (!fileCheck.exists) {
            throw new Error(`Source file not found: ${localUri}`);
        }

        // React Native FormData: use { uri, type, name } object instead of Blob
        let fileName = localUri.split('/').pop() || `upload-${Date.now()}`;
        fileName = this.ensureExtension(fileName, contentType);
        
        const normalizedUri = (localUri.startsWith('file://') || localUri.startsWith('content://')) 
            ? localUri 
            : `file://${localUri}`;

        const formData = new FormData();
        formData.append('file', {
            uri: normalizedUri,
            type: contentType,
            name: fileName,
        } as any);
        formData.append('bucket', bucket);
        formData.append('folder', folder || '');

        onProgress?.(0.4);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const targetUrl = `${SERVER_URL.replace(/\/$/, '')}/api/media/upload`;
        console.log(`[StorageService] Sending POST request to: ${targetUrl}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
        }).catch(err => {
            const domain = targetUrl.split('/')[2] || 'unknown';
            console.error(`[StorageService] Fetch to ${targetUrl} failed:`, err);
            throw new Error(`Conn error: ${err.message} [on ${domain}]`);
        });
        clearTimeout(timeoutId);

        onProgress?.(0.9);

        if (!response.ok) {
            const errText = await response.text().catch(() => 'No body');
            const domain = targetUrl.split('/')[2] || 'unknown';
            console.warn(`[StorageService] Upload proxy failed (${response.status}):`, errText);
            throw new Error(`Srv Error ${response.status}: ${errText.substring(0, 30)} [on ${domain}]`);
        }

        const payload: Partial<UploadResponse> = await response.json().catch(() => ({}));

        if (payload.success) {
            const key = payload.key || payload.filename;
            if (key) {
                console.log(`[StorageService] Upload confirmed with key: ${key}`);
                return key;
            }
        }

        throw new Error(payload.error || `Upload proxy failed with status ${response.status}`);
    },

    /**
     * Upload media (image or video) to storage via Server Presigned URLs
     */
    async uploadImage(uri: string, bucket: string, folder: string = '', onProgress?: (progress: number) => void): Promise<string | null> {
        console.log(`[StorageService] Starting upload for: ${uri}`);
        let localUri = uri;
        let contentType = 'application/octet-stream';
        // 1. Resolve URI to local file path
        localUri = await this.resolveUri(uri);

        // Guard: verify file exists before attempting native upload (prevents SIGABRT crash)
        const fileInfo = await getInfoAsync(localUri);
        if (!fileInfo.exists) {
            console.warn(`[StorageService] Source file does not exist: ${localUri}`);
            throw new Error('Source file not found');
        }

        contentType = this.getMimeType(localUri);
        const ext = localUri.split('.').pop()?.toLowerCase() || 'jpg';
        const fileName = `${folder ? folder + '-' : ''}${Date.now()}.${ext}`;
        const uploadKey = `${bucket}:${folder}:${localUri}:${(fileInfo as any).size || 0}`;

        console.log(`[StorageService] Prepared: ${fileName} (${contentType})`);

        const existingUpload = inFlightUploads.get(uploadKey);
        if (existingUpload) {
            console.log(`[StorageService] Reusing in-flight upload for ${uploadKey}`);
            return existingUpload;
        }

        const uploadPromise = (async () => {
            try {
                // Heuristic: If SERVER_URL is identical to the proxy worker, 
                // it's likely a misconfiguration for API uploads.
                const SERVER_IS_PROXY = SERVER_URL.includes('workers.dev');
                
                if (!R2_CONFIG.USE_R2 && !SERVER_IS_PROXY) {
                    console.log(`[StorageService] Using server proxy upload for ${bucket}/${folder}`);
                    try {
                        return await this.uploadViaServerProxy(localUri, bucket, folder, contentType, onProgress);
                    } catch (proxyError: any) {
                        if (!R2_CONFIG.WORKER_URL || !isMissingUploadRouteError(proxyError)) {
                            throw proxyError;
                        }

                        console.warn('[StorageService] Server upload route unavailable, falling back to R2 worker:', proxyError.message);
                        return await r2StorageService.uploadImage(localUri, bucket, folder, onProgress, contentType);
                    }
                }

                // If USE_R2 is true OR the server is misconfigured to point to the proxy worker,
                // we try R2 first, with a fallback to the proxy just in case.
                console.log(`[StorageService] Attempting direct R2 upload: ${bucket}/${folder}`);
                try {
                    const r2Key = await r2StorageService.uploadImage(localUri, bucket, folder, onProgress, contentType);
                    if (r2Key) {
                        console.log(`[StorageService] ✅ R2 upload success: ${r2Key}`);
                        return r2Key;
                    }
                    throw new Error('R2 upload returned no key');
                } catch (r2Error: any) {
                    if (isR2AuthFailure(r2Error)) {
                        throw new Error('Upload requires an active session. Please log in again and retry.');
                    }

                    const shouldFallbackToServer =
                        !SERVER_IS_PROXY &&
                        (isNetworkLikeError(r2Error) || isPayloadTooLargeError(r2Error));

                    if (!shouldFallbackToServer) {
                        throw r2Error;
                    }

                    console.warn('[StorageService] R2 direct upload failed, falling back to server proxy:', r2Error.message);
                    return await this.uploadViaServerProxy(localUri, bucket, folder, contentType, onProgress);
                }
            } catch (e: any) {
                console.warn(`[StorageService] Upload failed:`, e.message);
                throw e;
            }
        })();

        inFlightUploads.set(uploadKey, uploadPromise);
        try {
            return await uploadPromise;
        } finally {
            if (inFlightUploads.get(uploadKey) === uploadPromise) {
                inFlightUploads.delete(uploadKey);
            }
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
            // Check local cache first
            if (messageId) {
                const cachedPath = await offlineService.getMediaDownload(messageId);
                if (cachedPath) {
                    const info = await getInfoAsync(cachedPath);
                    if (info.exists) return cachedPath;
                }
            }

            const ext = r2Key.split('.').pop()?.split('?')[0] || 'jpg';
            const inferredType = mediaType || soulFolderService.inferMediaType(ext);

            let downloadUrl: string | undefined;

            // For direct HTTP URLs, use them directly
            if (r2Key.startsWith('http')) {
                downloadUrl = r2Key;
            } else if (R2_PUBLIC_BASE) {
                // For R2 keys, use public URL directly (no server presign needed)
                downloadUrl = `${R2_PUBLIC_BASE}/${r2Key}`;
            } else {
                console.warn(`[StorageService] No R2_PUBLIC_BASE configured for key: ${r2Key}`);
                return null;
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

            const tempPath = `${cacheDirectory}preview_${Date.now()}.${ext}`;
            const downloadRes = await downloadAsync(downloadUrl, tempPath);
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
            const directory = `${documentDirectory}soul_status/`;
            const localPath = `${directory}${statusId}.${ext}`;

            // Ensure directory exists
            const dirInfo = await getInfoAsync(directory);
            if (!dirInfo.exists) {
                await makeDirectoryAsync(directory, { intermediates: true });
            }

            // Check if already exists
            const fileInfo = await getInfoAsync(localPath);
            if (fileInfo.exists) return localPath;

            // Perform download from provided signedUrl
            const downloadRes = await downloadAsync(signedUrl, localPath);

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
