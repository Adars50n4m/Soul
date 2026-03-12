/**
 * R2 Storage Service
 * Handles file uploads to Cloudflare R2 via Worker proxy
 */

import * as FileSystem from 'expo-file-system';
import { R2_CONFIG } from '../config/r2';
import { supabase } from '../config/supabase';

interface UploadResponse {
  success: boolean;
  publicUrl: string;
  filename: string;
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
    folder: string = ''
  ): Promise<string | null> {
    let retries = 0;

    while (retries < R2_CONFIG.MAX_RETRIES) {
      try {
        return await this.attemptUpload(uri, bucket, folder);
      } catch (error) {
        retries++;
        console.warn(`Upload attempt ${retries} failed:`, error);

        if (retries >= R2_CONFIG.MAX_RETRIES) {
          console.warn('Max retries reached for direct R2 worker upload');
          return null;
        }

        // Wait before retrying
        await this.delay(R2_CONFIG.RETRY_DELAY * retries);
      }
    }

    return null;
  }

  /**
   * Attempt to upload file to R2
   */
  private async attemptUpload(
    uri: string,
    bucket: string,
    folder: string
  ): Promise<string> {
    // 1. Get authentication token
    const token = await this.getAuthToken(folder);
    if (!token) {
      throw new Error('Failed to get authentication token');
    }

    // 2. Detect content type
    const contentType = this.getContentType(uri);

    // 3. Create form data
    const formData = new FormData();
    const fileUri = this.normalizeFileUri(uri);
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) {
      throw new Error(`Local file not found: ${fileUri}`);
    }

    formData.append('file', {
      uri: fileUri,
      name: this.getFilename(fileUri),
      type: contentType,
    } as any);
    formData.append('folder', folder);

    // 5. Upload to Worker
    const uploadPath = this.getUploadPath(bucket);
    const uploadResponse = await fetch(
      `${R2_CONFIG.WORKER_URL}${uploadPath}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      }
    );

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json().catch(() => ({}));
      throw new Error(
        errorData.error || `Upload failed with status ${uploadResponse.status}`
      );
    }

    const data: UploadResponse = await uploadResponse.json();

    if (!data.success || !data.publicUrl) {
      throw new Error('Invalid response from upload server');
    }

    console.log(`✅ Upload successful: ${data.filename} (${data.size} bytes)`);
    return data.publicUrl;
  }

  /**
   * Get Supabase authentication token
   */
  private async getAuthToken(folder?: string): Promise<string | null> {
    try {
      const { data, error } = await supabase.auth.getSession();

      if (error || !data.session) {
        if (folder) {
          console.warn('No active session, using dev-user token fallback');
          return `dev-user:${folder}`;
        }
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

  /**
   * Get filename from URI
   */
  private getFilename(uri: string): string {
    const parts = uri.split('/');
    return parts[parts.length - 1] || 'upload';
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
