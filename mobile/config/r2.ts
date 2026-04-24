import * as Env from './env';

export const R2_CONFIG = {
  // Cloudflare Worker URL
  WORKER_URL: Env.R2_WORKER_URL,

  // R2 public domain
  PUBLIC_URL: Env.R2_PUBLIC_URL,

  // Feature flag
  USE_R2: Env.USE_R2,

  // Upload timeout in milliseconds (10 min for large media)
  UPLOAD_TIMEOUT: 600000,

  // Retry configuration
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
};

/**
 * FREE TIER Setup Instructions:
 *
 * 1. Deploy Worker (FREE): cd cloudflare-worker && npm run deploy
 * 2. Get Worker URL: https://soul-upload-worker.YOUR-SUBDOMAIN.workers.dev
 * 3. Enable R2 public access in dashboard to get r2.dev URL
 * 4. Create .env file:
 *
 * EXPO_PUBLIC_R2_WORKER_URL=https://soul-upload-worker.YOUR-SUBDOMAIN.workers.dev
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
