import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { supabase } from '../config/supabase';
import { R2_CONFIG } from '../config/r2';
import { r2StorageService } from './R2StorageService';

export const storageService = {
    /**
     * Upload media (image or video) to storage
     * Routes to R2 or Supabase Storage based on feature flag
     * @param uri The local file URI
     * @param bucket The storage bucket (default: 'avatars' or 'status-media')
     * @param folder The folder path (optional)
     */
    async uploadImage(uri: string, bucket: string, folder: string = ''): Promise<string | null> {
        // Feature flag: Use R2 if enabled, otherwise use Supabase Storage
        if (R2_CONFIG.USE_R2) {
            console.log('📤 Using Cloudflare R2 for upload');
            return r2StorageService.uploadImage(uri, bucket, folder);
        }

        // Original Supabase Storage implementation below
        console.log('📤 Using Supabase Storage for upload');
        try {
            const ext = uri.split('.').pop()?.toLowerCase() || 'jpg';
            const fileName = `${folder ? folder + '/' : ''}${Date.now()}.${ext}`;

            // Determine content type
            let contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
                contentType = `video/${ext === 'mov' ? 'quicktime' : ext}`;
            } else if (['m4a', 'mp3', 'wav', 'aac', 'caf'].includes(ext)) {
                contentType = `audio/${ext === 'm4a' ? 'x-m4a' : ext}`;
            }

            // Read file using expo-file-system and convert to ArrayBuffer
            const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
            const arrayBuffer = decode(base64);

            // Try uploading
            const { data, error } = await supabase.storage
                .from(bucket)
                .upload(fileName, arrayBuffer, {
                    contentType: contentType,
                    cacheControl: '3600',
                    upsert: true,
                });

            if (error) {
                // If bucket not found, fallback to Base64 Data URI
                // This ensures the app "just works" even if storage is not set up
                if (error.message.includes('Bucket not found') || (error as any).statusCode === '404') {
                    console.warn(`Bucket '${bucket}' missing. Falling back to Base64...`);
                    
                    // For videos, base64 might be too large/slow, but we keep the fallback for now
                    return `data:${contentType};base64,${base64}`;
                } else {
                    console.warn('Storage upload error:', error);
                    throw new Error(error.message);
                }
            }

            // Get public URL
            const { data: { publicUrl } } = supabase.storage
                .from(bucket)
                .getPublicUrl(fileName);

            return publicUrl;
        } catch (e: any) {
            console.warn('Upload failed:', e.message);
            throw e; // Re-throw to be handled by caller
        }
    },

    /**
     * Delete multiple files from Supabase or R2 storage
     * @param urls Array of public URLs to delete
     * @param bucket The storage bucket
     */
    async deleteMedia(urls: string[], bucket: string): Promise<void> {
        if (!urls || urls.length === 0) return;

        console.log(`🗑️ Deleting ${urls.length} files from ${bucket}`);

        // Extract filenames/paths from URLs
        const filePaths = urls.map(url => {
            // Case 1: Supabase Public URL
            // https://[id].supabase.co/storage/v1/object/public/[bucket]/folder/file.jpg
            if (url.includes('supabase.co')) {
                const parts = url.split(`/public/${bucket}/`);
                return parts.length > 1 ? parts[1] : url.split('/').pop() || '';
            }
            
            // Case 2: Base64 or unknown (skip deletion)
            if (url.startsWith('data:')) return null;

            // Fallback: Just the last part
            return url.split('/').pop() || null;
        }).filter((path): path is string => path !== null);

        if (filePaths.length === 0) return;

        try {
            const { error } = await supabase.storage
                .from(bucket)
                .remove(filePaths);

            if (error) {
                console.warn('Storage deletion error:', error.message);
            } else {
                console.log(`✅ Successfully deleted ${filePaths.length} files`);
            }
        } catch (e) {
            console.warn('Deletion failed:', e);
        }
    }
};
