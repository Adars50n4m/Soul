import * as FileSystem from 'expo-file-system';
import { SERVER_URL, proxySupabaseUrl, serverFetch } from '../config/api';
// Temporarily keeping supabase instance around as a fallback if needed
import { supabase } from '../config/supabase';
import { offlineService } from './LocalDBService';

export const storageService = {
    /**
     * Upload media (image or video) to storage via Server Presigned URLs
     */
    async uploadImage(uri: string, bucket: string, folder: string = '', onProgress?: (progress: number) => void): Promise<string | null> {
        console.log('📤 Uploading media via Server Presigned URL');
        let uploadTask: FileSystem.UploadTask | null = null;
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

            // 1. Get Presigned PUT URL from Node Server
            const res = await serverFetch(`${SERVER_URL}/api/media/presign-upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName, contentType })
            });

            if (!res.ok) {
                 throw new Error('Failed to get presigned URL from server');
            }

            const jsonRes = await res.json() as { presignedUrl: string, key: string };
            const { presignedUrl, key } = jsonRes;

            // 2. Upload file directly to R2 using FileSystem
            const fileInfo = await FileSystem.getInfoAsync(uri);
            if (!fileInfo.exists) throw new Error('File does not exist locally');

            uploadTask = FileSystem.createUploadTask(
                presignedUrl,
                uri,
                {
                    httpMethod: 'PUT',
                    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                    headers: {
                        'Content-Type': contentType,
                    }
                },
                (data) => {
                    const progress = data.totalBytesSent / data.totalBytesExpectedToSend;
                    if (onProgress) onProgress(progress);
                }
            );

            const uploadRes = await uploadTask.uploadAsync();

            if (uploadRes?.status !== 200) {
                 throw new Error(`R2 Upload failed: ${uploadRes?.status}`);
            }

            // For now return the key, the app can generate download URLs later via the server
            // or store it locally
            return key; 
        } catch (e: any) {
            console.warn('Upload failed:', e.message);
            
            // Fallback to Base64 Data URI if offline or server is down
            try {
               const ext = uri.split('.').pop()?.toLowerCase() || 'jpg';
               let contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
               const base64Fallback = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
               return `data:${contentType};base64,${base64Fallback}`;
            } catch (fallbackError) {
               throw e; 
            }
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
            const res = await serverFetch(`${SERVER_URL}/api/media/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys })
            });

            if (res.ok) {
                console.log(`✅ Successfully queued deletion of ${keys.length} files`);
            } else {
                console.warn('Failed to delete media via server');
            }
        } catch (e) {
            console.warn('Deletion API call failed:', e);
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

        try {
            // 1. Check local SQLite cache
            const cachedPath = await offlineService.getCachedMedia(r2Key);
            if (cachedPath) {
                const info = await FileSystem.getInfoAsync(cachedPath);
                if (info.exists) {
                    return cachedPath;
                }
            }

            // 2. Fetch Presigned Download URL from Server
            const res = await serverFetch(`${SERVER_URL}/api/media/presign-download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: r2Key })
            });

            if (!res.ok) {
                // If the key is already a full URL (e.g. from Supabase legacy), just return it
                if (r2Key.startsWith('http')) return r2Key;
                throw new Error('Failed to get download presigned URL');
            }

            const { presignedUrl } = await res.json();
            if (!presignedUrl) return r2Key.startsWith('http') ? r2Key : null;

            // 3. Download the file locally
            const ext = r2Key.split('.').pop() || 'tmp';
            // Sanitize filename from key
            const safeName = r2Key.replace(/[^a-zA-Z0-9.-]/g, '_');
            const localUri = `${FileSystem.documentDirectory}cached_media_${Date.now()}_${safeName}`;

            const downloadRes = await FileSystem.downloadAsync(presignedUrl, localUri);
            
            if (downloadRes.status !== 200) {
                throw new Error(`Download failed with status: ${downloadRes.status}`);
            }

            // 4. Save to Cache tracking
            await offlineService.saveCachedMedia(r2Key, localUri, undefined, downloadRes.headers['Content-Length'] ? parseInt(downloadRes.headers['Content-Length']) : undefined);

            return localUri;
        } catch (error) {
            console.warn(`[StorageService] Failed to fetch/cache media for ${r2Key}:`, error);
            // Fallback: if it was a URL, return it so the UI can try streaming it directly
            return r2Key.startsWith('http') ? r2Key : null;
        }
    }
};
