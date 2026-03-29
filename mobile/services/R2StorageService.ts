/**
 * R2 Storage Service
 * Handles file uploads to Cloudflare R2 via Worker proxy
 */

import * as FileSystem from 'expo-file-system';
import { R2_CONFIG } from '../config/r2';
import { supabase } from '../config/supabase';

interface UploadResponse {
  success: boolean;
  publicUrl?: string;
  filename?: string;
  key?: string;
  size: number;
  contentType: string;
}

class R2StorageService {
  /**
   * Upload an image/video to R2 storage
   * @param uri Local file URI (file:// or content://)
   * @param bucket Bucket name ('avatars' or 'status-media')
   * @param folder Optional folder path (defaults to user ID)
   * @returns Public URL or null on failure
   */
  async uploadImage(
    uri: string,
    bucket: string,
    folder: string = '',
    onProgress?: (progress: number) => void
  ): Promise<string | null> {
    let retries = 0;

    while (retries < R2_CONFIG.MAX_RETRIES) {
      try {
        // 1. Get authentication token
        const token = await this.getAuthToken();
        if (!token) throw new Error('Auth token missing');

        // 2. Detect content type & Filename
        const contentType = this.getContentType(uri);
        const fileName = uri.split('/').pop() || `status-${Date.now()}`;

        // 3. Upload to Worker using direct Binary PUT.
        const uploadPath = this.getUploadPath(bucket);
        const uploadUrl = `${R2_CONFIG.WORKER_URL}${uploadPath}`;

        console.log(`[R2Direct] Uploading via PUT to ${uploadUrl} (${contentType})`);

        const uploadTask = FileSystem.createUploadTask(
          uploadUrl,
          this.normalizeFileUri(uri),
          {
            httpMethod: 'PUT',
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
            mimeType: contentType,
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': contentType,
              'x-filename': fileName,
              'x-folder': folder || '',
            },
          },
          (p) => {
            if (onProgress && p.totalBytesExpectedToSend > 0) {
              const progress = Math.round((p.totalBytesSent / p.totalBytesExpectedToSend) * 100);
              onProgress(progress);
            }
          }
        );

        // 4. Implement 60s timeout
        const UPLOAD_TIMEOUT = 60000;
        const uploadPromise = uploadTask.uploadAsync();
        const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Upload timed out after 60s')), UPLOAD_TIMEOUT)
        );

        const result = await Promise.race([uploadPromise, timeoutPromise]) as FileSystem.FileSystemUploadResult;

        if (result && result.status >= 200 && result.status < 300) {
          try {
            const data: UploadResponse = JSON.parse(result.body);
            const normalizedKey = data.key
              ? data.key
              : data.filename
                ? (data.filename.startsWith(`${bucket}/`) ? data.filename : `${bucket}/${data.filename}`)
                : null;

            if (data.success && normalizedKey) {
              console.log(`[R2Direct] ✅ Success: ${normalizedKey}`);
              return normalizedKey;
            }

            if (data.success && data.publicUrl) {
              console.log(`[R2Direct] ✅ Success via public URL: ${data.publicUrl}`);
              return data.publicUrl;
            }

            if (!data.success) {
              console.error('[R2Direct] ❌ Worker returned success=false:', data);
            } else {
              console.error('[R2Direct] ❌ Worker response missing key/publicUrl:', data);
            }
          } catch {
            console.error('[R2Direct] ❌ Failed to parse worker response:', result.body);
          }
        }
        
        console.error(`[R2Direct] ❌ Worker error: status=${result?.status}, body=${result?.body}`);
        throw new Error(`Worker returned ${result?.status}: ${result?.body}`);
      } catch (error: any) {
        retries++;
        console.warn(`[R2Direct] Attempt ${retries} failed:`, error.message);
        if (retries >= R2_CONFIG.MAX_RETRIES) return null;
        await this.delay(R2_CONFIG.RETRY_DELAY * retries);
      }
    }

    return null;
  }

  /**
   * Get Supabase authentication token
   */
  private async getAuthToken(): Promise<string | null> {
    try {
      const { data, error } = await supabase.auth.getSession();

      if (error || !data.session) {
        return null;
      }

      return data.session.access_token;
    } catch (error) {
      console.warn('Error getting auth token:', error);
      return null;
    }
  }

  /**
   * Get content type from file URI
   */
  private getContentType(uri: string): string {
    const ext = this.getExtension(uri);
    const types: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'webp': 'image/webp',
      'gif': 'image/gif',
      'mp4': 'video/mp4',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska',
      'm4a': 'audio/x-m4a',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'aac': 'audio/aac',
      'caf': 'audio/x-caf',
    };
    return types[ext] || 'application/octet-stream';
  }

  private getUploadPath(bucket: string): string {
    if (bucket === 'avatars') return '/upload/avatar';
    if (bucket === 'status-media') return '/upload/status';
    if (bucket === 'chat-media') return '/upload/chat';
    return `/upload/${bucket}`;
  }

  /**
   * Get file extension from URI
   */
  private getExtension(uri: string): string {
    return uri.split('.').pop()?.toLowerCase() || '';
  }

  private normalizeFileUri(uri: string): string {
    if (uri.startsWith('file://') || uri.startsWith('content://')) {
      return uri;
    }
    return `file://${uri}`;
  }

  /**
   * Delay helper for retries
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if R2 is available (health check)
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${R2_CONFIG.WORKER_URL}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch (error) {
      console.warn('R2 health check failed:', error);
      return false;
    }
  }
}

export const r2StorageService = new R2StorageService();
