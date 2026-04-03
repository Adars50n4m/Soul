/**
 * R2 Storage Service
 * Handles file uploads to Cloudflare R2 via Worker proxy
 */

import * as FileSystem from 'expo-file-system';
import { R2_CONFIG } from '../config/r2';
import { supabase } from '../config/supabase';

export interface UploadResponse {
  success: boolean;
  publicUrl?: string;
  filename?: string;
  key?: string;
  size: number;
  contentType: string;
  error?: string;
}

export class R2AuthError extends Error {
  constructor(message: string = 'Authentication required for R2 upload') {
    super(message);
    this.name = 'R2AuthError';
  }
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
    let lastError: any = null;

    while (retries < R2_CONFIG.MAX_RETRIES) {
      try {
        // 1. Get authentication token
        const token = await this.getAuthToken();
        if (!token) throw new R2AuthError('Auth token missing');

        // 2. Detect content type & Filename
        const contentType = this.getContentType(uri);
        const fileName = uri.split('/').pop() || `status-${Date.now()}`;

        // 3. Upload to Worker using direct Multipart.
        const uploadPath = this.getUploadPath(bucket);
        const uploadUrl = `${R2_CONFIG.WORKER_URL}${uploadPath}`;

        console.log(`[R2Direct] Uploading via POST to ${uploadUrl} (${contentType})`);

        const uploadTask = FileSystem.createUploadTask(
          uploadUrl,
          this.normalizeFileUri(uri),
          {
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            fieldName: 'file',
            mimeType: contentType,
            headers: {
              'Authorization': `Bearer ${token}`,
              'x-filename': fileName,
              'x-folder': folder || '',
            },
            parameters: {
              'folder': folder || '',
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
          const data: UploadResponse = JSON.parse(result.body);
          const normalizedKey = data.key
            ? data.key
            : data.filename
              ? (data.filename.startsWith(`${bucket}/`) ? data.filename : `${bucket}/${data.filename}`)
              : null;

          if (data.success && normalizedKey) {
            console.log(`[R2Direct] ✅ Success: ${normalizedKey}`);
            return normalizedKey;
          } else {
            console.warn(`[R2Direct] Worker success field is false or key missing:`, result.body);
            throw new Error(data.error || 'Worker response successful but missing final key');
          }
        }

        if (result?.status === 401 || result?.status === 403) {
          throw new R2AuthError(`Worker auth rejected request (${result.status})`);
        }

        console.warn(`[R2Direct] Worker error: status=${result?.status}, body=${result?.body}`);
        throw new Error(`Worker returned ${result?.status}: ${result?.body || 'Empty response'}`);
      } catch (error: any) {
        if (error instanceof R2AuthError) {
          lastError = error;
          break;
        }

        retries++;
        lastError = error;
        console.warn(`[R2Direct] Attempt ${retries} failed:`, error.message);
        if (retries >= R2_CONFIG.MAX_RETRIES) break;
        await this.delay(R2_CONFIG.RETRY_DELAY * retries);
      }
    }

    throw lastError || new Error('R2 Upload failed after multiple attempts');
  }

  /**
   * Get Supabase authentication token
   */
  private async getAuthToken(): Promise<string | null> {
    try {
      console.log('[R2Storage] Retrieving auth token...');
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) {
        console.warn('[R2Storage] getSession error:', sessionError.message);
      }

      if (sessionData.session?.access_token) {
        console.log('[R2Storage] Found session token');
        return sessionData.session.access_token;
      }

      // First fallback: force refresh persisted session (if refresh token exists)
      console.log('[R2Storage] No session found, trying refreshSession()...');
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) {
        console.warn('[R2Storage] refreshSession error:', refreshError.message);
      }

      if (refreshData.session?.access_token) {
        console.log('[R2Storage] Found token after refreshSession');
        return refreshData.session.access_token;
      }

      // Final fallback: getUser() can sometimes hydrate session in edge cases
      console.log('[R2Storage] refreshSession failed, trying getUser() fallback...');
      const { error: userError } = await supabase.auth.getUser();
      if (userError) {
        console.warn('[R2Storage] getUser fallback error:', userError.message);
      }

      // Re-check session after getUser() which might have updated it
      const { data: finalSession } = await supabase.auth.getSession();
      if (finalSession.session?.access_token) {
        console.log('[R2Storage] Found token after getUser fallback');
        return finalSession.session.access_token;
      }

      console.warn('[R2Storage] Auth failure: No valid session or token found');
      return null;
    } catch (error: any) {
      console.warn('[R2Storage] Unexpected auth error:', error.message);
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
