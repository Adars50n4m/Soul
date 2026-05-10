/**
 * SoulSync Upload Worker
 * Handles media uploads (avatars, status images/videos) to Cloudflare R2
 */

export interface Env {
  R2_BUCKET: R2Bucket;
  // Legacy HS256 secret. Optional once the project moves to asymmetric keys,
  // but kept for backward compatibility with old-style tokens.
  SUPABASE_JWT_SECRET: string;
  // Required for modern Supabase projects (publishable key sb_publishable_*),
  // which sign session tokens with RS256/ES256. Used to fetch JWKS at
  // `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
  SUPABASE_URL: string;
  R2_PUBLIC_DOMAIN: string;
  MAX_FILE_SIZE_MB: string;
  MAX_AVATAR_SIZE_MB: string;
}

// CORS headers for mobile app
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Upload endpoints
    if (url.pathname === '/upload/avatar') {
      return handleUpload(request, env, 'avatars');
    }

    if (url.pathname === '/upload/status') {
      return handleUpload(request, env, 'status-media');
    }

    if (url.pathname === '/upload/chat') {
      return handleUpload(request, env, 'chat-media');
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

/**
 * Handle file upload to R2
 */
async function handleUpload(request: Request, env: Env, bucket: string): Promise<Response> {
  try {
    // 1. Verify authentication
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Unauthorized: Missing or invalid token' }, 401);
    }

    const token = authHeader.substring(7);

    // Allow dev bypass tokens for development/testing
    let userId: string | null = null;
    if (token === 'DEV_BYPASS_TOKEN') {
      userId = 'dev-user';
    } else {
      userId = await verifyJWT(token, env);
    }

    if (!userId) {
      return jsonResponse({ error: 'Unauthorized: Invalid token' }, 401);
    }

    // 2. Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as unknown as File;
    const folder = (formData.get('folder') as string) || userId;

    if (!file) {
      return jsonResponse({ error: 'No file provided' }, 400);
    }

    // 3. Validate file
    const maxSizeMB = bucket === 'avatars'
      ? parseInt(env.MAX_AVATAR_SIZE_MB || '5')
      : parseInt(env.MAX_FILE_SIZE_MB || '50');

    const maxSizeBytes = maxSizeMB * 1024 * 1024;

    if (file.size > maxSizeBytes) {
      return jsonResponse({
        error: `File too large. Max size: ${maxSizeMB}MB`
      }, 400);
    }

    const contentType = file.type || detectContentType(file.name);
    if (!isValidContentType(contentType, bucket)) {
      return jsonResponse({
        error: 'Invalid file type. Allowed: images (jpg, png, webp) and videos (mp4, mov)'
      }, 400);
    }

    // 4. Generate unique filename
    const timestamp = Date.now();
    const extension = getExtension(file.name) || getExtensionFromMime(contentType);
    const filename = `${folder}/${timestamp}.${extension}`;
    const key = `${bucket}/${filename}`;

    // 5. Upload to R2
    await env.R2_BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: contentType,
      },
      customMetadata: {
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        originalName: file.name,
      },
    });

    // 6. Generate public URL
    const publicUrl = `${env.R2_PUBLIC_DOMAIN}/${key}`;

    console.log(`Upload successful: ${key} (${file.size} bytes) by user ${userId}`);

    return jsonResponse({
      success: true,
      publicUrl,
      filename,
      size: file.size,
      contentType,
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    return jsonResponse({
      error: 'Upload failed',
      details: error.message
    }, 500);
  }
}

/**
 * Verify a Supabase JWT and return its `sub` (user id), or null if invalid.
 *
 * Supports HS256 (legacy projects) plus RS256 / ES256 used by modern
 * projects with publishable keys. Asymmetric algs are verified against the
 * project's JWKS endpoint; HS256 falls back to SUPABASE_JWT_SECRET.
 */
let jwksCache: { keys: any[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 5 * 60 * 1000;

async function fetchJWKS(supabaseUrl: string): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { keys?: any[] };
  jwksCache = { keys: json.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function b64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(b64 + padding), (c) => c.charCodeAt(0));
}

async function verifyJWT(token: string, env: Env): Promise<string | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    if (payload.exp && payload.exp < Date.now() / 1000) {
      console.warn('Token expired');
      return null;
    }

    const userId: string | undefined = payload.sub || payload.user_id;
    if (!userId) return null;

    const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = b64urlDecode(signatureB64);
    const alg: string = header.alg;

    if (alg === 'HS256') {
      if (!env.SUPABASE_JWT_SECRET) {
        console.error('HS256 token but SUPABASE_JWT_SECRET is not set');
        return null;
      }
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      const ok = await crypto.subtle.verify('HMAC', cryptoKey, signature, dataToVerify);
      if (!ok) {
        console.error('HS256 signature invalid - check SUPABASE_JWT_SECRET');
        return null;
      }
      return userId;
    }

    if (alg === 'RS256' || alg === 'ES256') {
      if (!env.SUPABASE_URL) {
        console.error(`${alg} token received but SUPABASE_URL is not set; cannot fetch JWKS`);
        return null;
      }
      const keys = await fetchJWKS(env.SUPABASE_URL);
      const jwk =
        keys.find((k) => k.kid === header.kid) ||
        keys.find((k) => k.alg === alg);
      if (!jwk) {
        console.error(`No JWKS key matched kid=${header.kid} alg=${alg}`);
        return null;
      }
      const importParams: any =
        alg === 'RS256'
          ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
          : { name: 'ECDSA', namedCurve: 'P-256' };
      const verifyParams: any =
        alg === 'RS256'
          ? { name: 'RSASSA-PKCS1-v1_5' }
          : { name: 'ECDSA', hash: 'SHA-256' };
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        importParams,
        false,
        ['verify'],
      );
      const ok = await crypto.subtle.verify(verifyParams, cryptoKey, signature, dataToVerify);
      if (!ok) {
        console.error(`${alg} signature invalid for kid=${header.kid}`);
        return null;
      }
      return userId;
    }

    console.error(`Unsupported JWT alg: ${alg}`);
    return null;
  } catch (error) {
    console.error('JWT verification error:', error);
    return null;
  }
}

/**
 * Detect content type from filename
 */
function detectContentType(filename: string): string {
  const ext = getExtension(filename);
  const mimeTypes: Record<string, string> = {
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
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Validate content type for bucket
 */
function isValidContentType(contentType: string, bucket: string): boolean {
  const validTypes: Record<string, string[]> = {
    'avatars': ['image/jpeg', 'image/png', 'image/webp'],
    'status-media': [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'
    ],
    'chat-media': [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
      'audio/x-m4a', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-caf'
    ],
  };

  const allowed = validTypes[bucket] || [];
  return allowed.some(type => contentType.startsWith(type));
}

/**
 * Get file extension from filename
 */
function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

/**
 * Get extension from MIME type
 */
function getExtensionFromMime(mime: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'audio/x-m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/aac': 'aac',
    'audio/x-caf': 'caf',
  };
  return extensions[mime] || 'bin';
}

/**
 * Helper to return JSON response with CORS
 */
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
