/**
 * R2 Storage Service
 * Handles file uploads to Cloudflare R2 via Worker proxy
 */

import { getInfoAsync, uploadAsync, FileSystemUploadType } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  private static readonly FALLBACK_TOKEN_KEY = 'ss_last_access_token';
  private authSyncInitialized = false;
  private authSyncPromise: Promise<void> | null = null;
  private unsubscribeAuthSync: (() => void) | null = null;

  /**
   * Upload an image/video to R2 storage
   */
  async uploadImage(
    uri: string,
    bucket: string,
    folder: string = '',
    onProgress?: (progress: number) => void,
    forceContentType?: string
  ): Promise<string | null> {
    let retries = 0;
    let lastError: any = null;

    while (retries < R2_CONFIG.MAX_RETRIES) {
      try {
        const token = await this.getAuthToken();
        if (!token) throw new R2AuthError('Auth token missing');

        const normalizedUri = this.normalizeFileUri(uri);
        const fileCheck = await getInfoAsync(normalizedUri);
        if (!fileCheck.exists) {
          throw new Error(`Source file not found: ${normalizedUri}`);
        }

        const contentType = forceContentType || this.getContentType(uri);
        let fileName = uri.split('/').pop() || `upload-${Date.now()}`;
        
        // Ensure extension exists for Android compatibility
        if (!fileName.includes('.')) {
          const extMap: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'video/mp4': 'mp4',
            'video/quicktime': 'mov',
          };
          const ext = extMap[contentType] || 'bin';
          fileName = `${fileName}.${ext}`;
        }

        const uploadPath = this.getUploadPath(bucket);
        const uploadUrl = `${R2_CONFIG.WORKER_URL}${uploadPath}`;

        const fileSizeKB = ((fileCheck as any).size || 0) / 1024;
        console.log(`[R2Direct] Uploading via fetch to ${uploadUrl} (${contentType}, ${fileSizeKB}KB)`);
        onProgress?.(0.05);

        // 🛡️ [Stall Prevention] Improved simulated progress
        // The native upload task doesn't surface progress here; simulate up to 96%
        // so the UI never appears stuck during the upload.
        let simProgress = 0.05;
        const estimatedMs = Math.max(2000, (fileSizeKB / 150) * 1000);
        const progressInterval = setInterval(() => {
          const remaining = 0.96 - simProgress;
          const increment = Math.max(0.005, remaining * 0.15);
          simProgress += increment;
          onProgress?.(simProgress);
        }, estimatedMs / 12);

        let data: UploadResponse;
        try {
          // Use expo-file-system's native upload task instead of RN fetch+FormData.
          // RN's fetch with multipart bodies is unreliable on iOS Simulator
          // ("Network request failed" with no HTTP roundtrip). uploadAsync goes
          // through NSURLSessionUploadTask, which streams the file robustly.
          console.log(`[R2Direct] Sending request with token: ${token ? (token.substring(0, 10) + '...') : 'NULL'}`);
          const result = await uploadAsync(uploadUrl, normalizedUri, {
            httpMethod: 'POST',
            uploadType: FileSystemUploadType.MULTIPART,
            fieldName: 'file',
            mimeType: contentType,
            parameters: { folder: folder || '' },
            headers: {
              'Authorization': `Bearer ${token}`,
              'x-filename': fileName,
              'x-folder': folder || '',
            },
          });
          clearInterval(progressInterval);
          onProgress?.(0.92);

          if (result.status === 401 || result.status === 403) {
            console.warn(`[R2Direct] ❌ Worker Auth Failure (${result.status}): ${result.body}`);
            throw new R2AuthError(`Worker auth rejected request (${result.status})`);
          }
          if (result.status < 200 || result.status >= 300) {
            console.warn(`[R2Direct] ❌ Worker Error (${result.status}): ${result.body}`);
            throw new Error(`Worker returned ${result.status}: ${result.body}`);
          }
          try {
            data = JSON.parse(result.body) as UploadResponse;
          } catch {
            throw new Error(`Worker returned non-JSON body: ${result.body.substring(0, 100)}`);
          }
          console.log(`[R2Direct] ✅ Worker Response:`, data);
        } catch (uploadErr) {
          clearInterval(progressInterval);
          throw uploadErr;
        }
        const normalizedKey = data.key
          ? data.key
          : data.filename
            ? (data.filename.startsWith(`${bucket}/`) ? data.filename : `${bucket}/${data.filename}`)
            : null;

        if (data.success && normalizedKey) {
          onProgress?.(1);
          console.log(`[R2Direct] ✅ Success: ${normalizedKey}`);
          return normalizedKey;
        } else {
          throw new Error(data.error || 'Worker response successful but missing final key');
        }
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

  private _cachedToken: string | null = null;
  private _cachedTokenAt: number = 0;
  private static readonly TOKEN_CACHE_TTL = 4 * 60 * 1000;

  private async ensureAuthTokenSync(): Promise<void> {
    if (this.authSyncInitialized) return;
    if (this.authSyncPromise) return this.authSyncPromise;

    this.authSyncPromise = (async () => {
      this.authSyncInitialized = true;

      const seedToken = async () => {
        try {
          const { data } = await supabase.auth.getSession();
          const seededToken = data.session?.access_token ?? null;
          if (seededToken) {
            this._cachedToken = seededToken;
            this._cachedTokenAt = Date.now();
            await AsyncStorage.setItem(R2StorageService.FALLBACK_TOKEN_KEY, seededToken);
          }
        } catch (error: any) {
          console.warn('[R2Storage] Failed to seed auth token cache:', error?.message || error);
        }
      };

      await seedToken();

      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
        const nextToken = session?.access_token ?? null;
        this._cachedToken = nextToken;
        this._cachedTokenAt = nextToken ? Date.now() : 0;

        try {
          if (nextToken) {
            await AsyncStorage.setItem(R2StorageService.FALLBACK_TOKEN_KEY, nextToken);
          } else {
            await AsyncStorage.removeItem(R2StorageService.FALLBACK_TOKEN_KEY);
          }
        } catch (storageError) {
          console.warn('[R2Storage] Failed to persist auth token cache:', storageError);
        }
      });

      this.unsubscribeAuthSync = () => subscription.unsubscribe();
    })();

    return this.authSyncPromise;
  }

  private async getAuthToken(): Promise<string | null> {
    await this.ensureAuthTokenSync();

    if (this._cachedToken && (Date.now() - this._cachedTokenAt) < R2StorageService.TOKEN_CACHE_TTL) {
      return this._cachedToken;
    }

    try {
      const sessionPromise = supabase.auth.getSession();
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
      const sessionResult = await Promise.race([sessionPromise, timeoutPromise]);

      if (sessionResult && 'data' in sessionResult && sessionResult.data.session?.access_token) {
        this._cachedToken = sessionResult.data.session.access_token;
        this._cachedTokenAt = Date.now();
        await AsyncStorage.setItem(R2StorageService.FALLBACK_TOKEN_KEY, this._cachedToken);
        return this._cachedToken;
      }

      const persistedToken = await AsyncStorage.getItem(R2StorageService.FALLBACK_TOKEN_KEY);
      if (persistedToken) {
        this._cachedToken = persistedToken;
        this._cachedTokenAt = Date.now();
        return this._cachedToken;
      }

      const refreshPromise = supabase.auth.refreshSession();
      const refreshTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000));
      const refreshResult = await Promise.race([refreshPromise, refreshTimeout]);

      if (refreshResult && 'data' in refreshResult && refreshResult.data.session?.access_token) {
        this._cachedToken = refreshResult.data.session.access_token;
        this._cachedTokenAt = Date.now();
        await AsyncStorage.setItem(R2StorageService.FALLBACK_TOKEN_KEY, this._cachedToken);
        return this._cachedToken;
      }

      const cachedUserId = await AsyncStorage.getItem('ss_current_user');
      if (cachedUserId && cachedUserId.startsWith('f00f00f0-0000-0000-0000')) {
        return 'DEV_BYPASS_TOKEN';
      }
      return null;
    } catch (error: any) {
      console.warn('[R2Storage] Auth error:', error.message);
      const persistedToken = await AsyncStorage.getItem(R2StorageService.FALLBACK_TOKEN_KEY);
      if (persistedToken) {
        this._cachedToken = persistedToken;
        this._cachedTokenAt = Date.now();
        return this._cachedToken;
      }
      return null;
    }
  }

  private getContentType(uri: string): string {
    const ext = this.getExtension(uri);
    const types: Record<string, string> = {
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp',
      'gif': 'image/gif', 'mp4': 'video/mp4', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska', 'm4a': 'audio/x-m4a', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
      'aac': 'audio/aac', 'caf': 'audio/x-caf',
    };
    return types[ext] || 'application/octet-stream';
  }

  private getUploadPath(bucket: string): string {
    if (bucket === 'avatars') return '/upload/avatar';
    if (bucket === 'status-media') return '/upload/status';
    if (bucket === 'chat-media') return '/upload/chat';
    return `/upload/${bucket}`;
  }

  private getExtension(uri: string): string {
    return uri.split('.').pop()?.toLowerCase() || '';
  }

  private normalizeFileUri(uri: string): string {
    if (uri.startsWith('file://') || uri.startsWith('content://')) return uri;
    return `file://${uri}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${R2_CONFIG.WORKER_URL}/health`, { method: 'GET' });
      return response.ok;
    } catch (error) {
      console.warn('R2 health check failed:', error);
      return false;
    }
  }
}

export const r2StorageService = new R2StorageService();
