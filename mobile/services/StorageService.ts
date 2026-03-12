import * as FileSystem from 'expo-file-system';
import { SERVER_URL, proxySupabaseUrl, safeFetchJson } from '../config/api';
import { R2_CONFIG } from '../config/r2';
import { r2StorageService } from './R2StorageService';
// Temporarily keeping supabase instance around as a fallback if needed
import { supabase } from '../config/supabase';
import { offlineService } from './LocalDBService';

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
            } else if (['m4a', 'mp3', 'wav', 'aac', 'caf'].includes(ext)) {
                contentType = `audio/${ext === 'm4a' ? 'x-m4a' : ext}`;
            }

            console.log(`[StorageService] Determined contentType: ${contentType}, fileName: ${fileName}`);

            // 1. Get Presigned PUT URL from Node Server
            console.log(`[StorageService] Fetching presigned upload URL from: ${SERVER_URL}/api/media/presign-upload`);
            const { success, data, error } = await safeFetchJson<{ presignedUrl: string, key: string }>(
                `${SERVER_URL}/api/media/presign-upload`, 
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName, contentType })
                }
            );
            
            if (!success || !data) {
                console.warn('[StorageService] Presign upload failed:', error);
                if (bucket === 'chat-media' || bucket === 'status-media' || bucket === 'avatars') {
                    console.log('[StorageService] Falling back to direct R2 worker upload');
                    const workerUrl = await r2StorageService.uploadImage(uri, bucket, folder);
                    if (workerUrl) {
                        return workerUrl;
                    }
                }
                throw new Error(error || 'Failed to get presigned URL from server');
            }
            
            const { presignedUrl, key } = data;
            console.log(`[StorageService] Got presigned upload URL for key: ${key}`);

            // Intercept ph:// URIs and resolve to local file:// using MediaLibrary
            if (uri.startsWith('ph://')) {
                try {
                    console.log(`[StorageService] Intercepted ph:// URI: ${uri}`);
                    const assetId = uri.substring(5).split('/')[0];
                    const MediaLibrary = require('expo-media-library');
                    const info = await MediaLibrary.getAssetInfoAsync(assetId);
                    if (info && (info.localUri || info.uri)) {
                        uri = info.localUri || info.uri;
                        console.log(`[StorageService] Resolved ph:// to: ${uri}`);
                    }
                } catch (err) {
                    console.warn(`[StorageService] Failed to resolve ph:// URI:`, err);
                }
            }

            // 2. Upload file directly to R2 using FileSystem
            let fileInfo = await FileSystem.getInfoAsync(uri);
            if (!fileInfo.exists) {
                console.log(`[StorageService] File not found at ${uri}, attempting file:// prefix check`);
                if (!uri.startsWith('file://') && !uri.startsWith('content://')) {
                    const fixedUri = 'file://' + uri;
                    const secondCheck = await FileSystem.getInfoAsync(fixedUri);
                    if (secondCheck.exists) {
                        uri = fixedUri;
                        fileInfo = secondCheck; // Use the verified info
                        console.log(`[StorageService] Found file with prefix: ${uri}`);
                    } else {
                        throw new Error('File does not exist locally: ' + uri);
                    }
                } else {
                    throw new Error('File does not exist locally: ' + uri);
                }
            }

            // Ensure we have a size for the log
            const fileSize = (fileInfo as any).size || 'unknown';
            console.log(`[StorageService] Starting upload via createUploadTask to R2. Size: ${fileSize}`);
            
            const uploadTask = FileSystem.createUploadTask(
                presignedUrl,
                uri,
                {
                    httpMethod: 'PUT',
                    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                    headers: {
                        'Content-Type': contentType,
                    }
                },
                (progress) => {
                    if (onProgress) {
                        const fraction = progress.totalBytesSent / progress.totalBytesExpectedToSend;
                        onProgress(fraction);
                    }
                }
            );

            const uploadRes = await uploadTask.uploadAsync();

            console.log(`[StorageService] uploadAsync finished with status: ${uploadRes?.status}`);

            if (uploadRes?.status !== 200 && uploadRes?.status !== 201 && uploadRes?.status !== 204) {
                 console.warn(`[StorageService] R2 Upload failed with body: ${uploadRes?.body}`);
                 throw new Error(`R2 Upload failed: ${uploadRes?.status} - ${uploadRes?.body}`);
            }

            console.log(`[StorageService] Upload successful! Returning key: ${key}`);
            return key; 
        } catch (e: any) {
            console.warn(`[StorageService] uploadImage CRITICAL error:`, e.message);
            if (bucket === 'chat-media' || bucket === 'status-media' || bucket === 'avatars') {
                try {
                    console.log('[StorageService] Retrying via direct R2 worker fallback');
                    const workerUrl = await r2StorageService.uploadImage(uri, bucket, folder);
                    if (workerUrl) {
                        return workerUrl;
                    }
                } catch (workerError: any) {
                    console.warn('[StorageService] Direct R2 worker upload also failed:', workerError?.message);
                }
            }
            throw e; 
        }
    },

    /**
     * Delete multiple files from storage via Server
     */
    async deleteMedia(urls: string[], bucket: string): Promise<void> {
        if (!urls || urls.length === 0) return;

        console.log(`🗑️ Deleting ${urls.length} media keys via server`);
        
        // This takes the 'keys' and tells the Node server to remove them
        const keys = urls.map(url => url.split('/').pop()).filter((key): key is string => !!key);
        
        if (keys.length === 0) return;

        try {
            const { success, error } = await safeFetchJson<any>(
                `${SERVER_URL}/api/media/delete`, 
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys })
                }
            );

            if (success) {
                console.log(`✅ Successfully queued deletion of ${keys.length} files`);
            } else {
                console.warn('[Storage] Failed to delete media via server:', error);
            }
        } catch (e) {
            console.warn('[Storage] Deletion API call failed:', e);
        }
    },

    /**
     * Get local playable/viewable URL for an R2 key (with offline caching)
     */
    async getMediaUrl(r2Key: string): Promise<string | null> {
        if (!r2Key) return null;
        
        // Return as-is if it's already a local file or data URI
        if (r2Key.startsWith('file://') || r2Key.startsWith('data:')) {
            return r2Key;
        }

        console.log(`[StorageService] Resolving media for key: ${r2Key}`);

        try {
            // 1. Check local SQLite cache
            const cachedPath = await offlineService.getMediaDownload(r2Key);
            if (cachedPath) {
                const info = await FileSystem.getInfoAsync(cachedPath);
                if (info.exists) {
                    console.log(`[StorageService] Cache hit: ${cachedPath}`);
                    return cachedPath;
                }
                console.log(`[StorageService] Cache record found but file missing: ${cachedPath}`);
            }

            // 2. Fetch Presigned Download URL from Server
            console.log(`[StorageService] Fetching presigned URL from: ${SERVER_URL}/api/media/presign-download`);
            const { success, data, error } = await safeFetchJson<{ presignedUrl: string }>(
                `${SERVER_URL}/api/media/presign-download`, 
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: r2Key })
                }
            );

            if (!success || !data?.presignedUrl) {
                console.warn('[StorageService] Presign download failed:', error);
                // Fallback: use public R2 URL directly (no server needed)
                if (R2_PUBLIC_BASE) {
                    const publicUrl = `${R2_PUBLIC_BASE}/${r2Key}`;
                    console.log('[StorageService] Falling back to public R2 URL:', publicUrl);
                    return publicUrl;
                }
                const fallback = r2Key.startsWith('http') ? r2Key : null;
                console.log(`[StorageService] No R2_PUBLIC_BASE. Final fallback: ${fallback}`);
                return fallback;
            }

            const { presignedUrl } = data;
            console.log(`[StorageService] Got presigned URL (truncated): ${presignedUrl.substring(0, 50)}...`);

            // 3. Download the file locally
            const ext = r2Key.split('.').pop() || 'tmp';
            // Sanitize filename from key
            const safeName = r2Key.replace(/[^a-zA-Z0-9.-]/g, '_');
            const localUri = `${FileSystem.documentDirectory}cached_media_${Date.now()}_${safeName}`;

            console.log(`[StorageService] Downloading to: ${localUri}`);
            const downloadRes = await FileSystem.downloadAsync(presignedUrl, localUri);
            
            if (downloadRes.status !== 200) {
                throw new Error(`Download failed with status: ${downloadRes.status}`);
            }

            console.log(`[StorageService] Download complete. Size: ${downloadRes.headers['Content-Length'] || 'unknown'}`);

            // 4. Save to Cache tracking
            await offlineService.saveMediaDownload(r2Key, presignedUrl, localUri, downloadRes.headers['Content-Length'] ? parseInt(downloadRes.headers['Content-Length']) : undefined);

            return localUri;
        } catch (error) {
            console.warn(`[StorageService] Critical failure for ${r2Key}:`, error);
            // Fallback: use public R2 URL so images still load even when server is down
            if (R2_PUBLIC_BASE) {
                const publicUrl = `${R2_PUBLIC_BASE}/${r2Key}`;
                console.log('[StorageService] Emergency fallback to public R2 URL:', publicUrl);
                return publicUrl;
            }
            return r2Key.startsWith('http') ? r2Key : null;
        }
    }
};
