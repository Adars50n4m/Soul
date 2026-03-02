/**
 * Cloudflare R2 Storage Configuration (FREE TIER)
 *
 * Configure these values based on your FREE Cloudflare Worker deployment
 */

export const R2_CONFIG = {
  // Cloudflare Worker URL (FREE workers.dev subdomain)
  // Get this after running: npm run deploy
  WORKER_URL: process.env.EXPO_PUBLIC_R2_WORKER_URL || 'https://soulsync-upload-worker.YOUR-SUBDOMAIN.workers.dev',

  // R2 public domain (FREE r2.dev subdomain)
  // Get this from: R2 Dashboard → soulsync-media → Settings → Public Access
  PUBLIC_URL: process.env.EXPO_PUBLIC_R2_PUBLIC_URL || 'https://pub-XXXXXXXXXXXX.r2.dev',

  // Feature flag: Use R2 for uploads to bypass ISP blocks on Supabase Storage
  USE_R2: false,

  // Upload timeout in milliseconds
  UPLOAD_TIMEOUT: 30000,

  // Retry configuration
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
};

/**
 * FREE TIER Setup Instructions:
 *
 * 1. Deploy Worker (FREE): cd cloudflare-worker && npm run deploy
 * 2. Get Worker URL: https://soulsync-upload-worker.YOUR-SUBDOMAIN.workers.dev
 * 3. Enable R2 public access in dashboard to get r2.dev URL
 * 4. Create .env file:
 *
 * EXPO_PUBLIC_R2_WORKER_URL=https://soulsync-upload-worker.YOUR-SUBDOMAIN.workers.dev
 * EXPO_PUBLIC_R2_PUBLIC_URL=https://pub-XXXXXXXXXXXX.r2.dev
 * EXPO_PUBLIC_USE_R2=false
 *
 * 5. Start with USE_R2=false, test, then enable!
 *
 * FREE TIER LIMITS:
 * - R2: 10GB storage, 1M writes/month, 10M reads/month (FREE!)
 * - Workers: 100k requests/day (FREE!)
 * - Good for up to 1,000 active users!
 */
