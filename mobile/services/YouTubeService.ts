import { Platform } from 'react-native';
import { YOUTUBE_API_KEY, SERVER_URL, IS_DEV } from '../config/env';

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * On Android dev builds the emulator clock is often out of sync, which breaks
 * SSL certificate validation for googleapis.com. Route YouTube API calls
 * through the local dev server (plain HTTP → host does the HTTPS call with
 * correct time). On iOS and production, go direct.
 */
const useProxy = IS_DEV && Platform.OS === 'android' && !!SERVER_URL;

const buildYtUrl = (path: 'videos' | 'search', params: URLSearchParams): string => {
    if (useProxy) {
        params.set('path', path);
        return `${SERVER_URL}/api/youtube/proxy?${params.toString()}`;
    }
    return `${YT_BASE}/${path}?${params.toString()}`;
};

export interface YouTubeSnippet {
    videoId: string;
    title: string;
    description?: string;
    channelTitle: string;
    publishedAt: string;
    thumbnail: string;
    durationSec?: number;
    viewCount?: number;
}

interface SearchOptions {
    maxResults?: number;
    pageToken?: string;
    /** Filter by upload date — equivalent to YouTube's `videoDuration` param. */
    videoDuration?: 'any' | 'short' | 'medium' | 'long';
}

interface SearchResult {
    items: YouTubeSnippet[];
    nextPageToken?: string;
}

/**
 * Parse an ISO 8601 duration like "PT4M13S" into seconds.
 * YouTube returns durations in this format from videos.list contentDetails.
 */
const parseISO8601Duration = (iso?: string): number | undefined => {
    if (!iso || typeof iso !== 'string') return undefined;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return undefined;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    return h * 3600 + min * 60 + s;
};

const pickThumbnail = (thumbnails: any): string => {
    if (!thumbnails) return '';
    return (
        thumbnails.maxres?.url ||
        thumbnails.standard?.url ||
        thumbnails.high?.url ||
        thumbnails.medium?.url ||
        thumbnails.default?.url ||
        ''
    );
};

const ensureKey = (): string => {
    if (!YOUTUBE_API_KEY) {
        throw new Error('YouTube API key missing — set EXPO_PUBLIC_YOUTUBE_API_KEY in .env');
    }
    return YOUTUBE_API_KEY;
};

const YT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Fetch with hard timeout and a friendlier error than "Network request
 * failed". Without this, the picker hangs forever on the spinner whenever
 * the device can't reach googleapis.com — which is a common state on Android
 * emulators where the AVD's NAT to external HTTPS is flaky.
 */
const fetchWithTimeout = async (url: string, label: string): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), YT_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'Accept': 'application/json',
                'User-Agent': Platform.OS === 'android' ? 'Soul-Android' : 'Soul-iOS',
            },
        });
        return resp;
    } catch (err: any) {
        const isTimeout = err?.name === 'AbortError' || err?.message?.includes('timed out');
        const isNetworkError = typeof err?.message === 'string' && 
            (err.message.includes('Network request failed') || err.message.includes('Failed to fetch'));

        if (isTimeout) {
            throw new Error(`${label} timed out (25s) — check device internet or emulator clock sync (googleapis.com).`);
        }
        if (isNetworkError) {
            // On Android, "Network request failed" is often an SSL error due to bad system time.
            const extra = Platform.OS === 'android' ? ' Check device date/time & DNS.' : '';
            throw new Error(`${label} failed: device can't reach googleapis.com.${extra}`);
        }
        console.warn(`[YouTube] ${label} unexpected error:`, err);
        throw err;
    } finally {
        clearTimeout(timer);
    }
};

interface VideoDetails {
    durationSec?: number;
    viewCount?: number;
    embeddable?: boolean;
}

/**
 * Hydrate a list of video ids with duration + viewCount + embeddable from the
 * videos endpoint. search.list does not return contentDetails or status; we
 * batch a second call. The embeddable flag is critical — major label channels
 * (Saregama, T-Series, etc.) disable iframe embedding, which would otherwise
 * leave the user stuck on a "Watch on YouTube" overlay inside our player.
 */
const fetchVideoDetails = async (ids: string[]): Promise<Map<string, VideoDetails>> => {
    const key = ensureKey();
    const out = new Map<string, VideoDetails>();
    if (ids.length === 0) return out;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

    await Promise.all(chunks.map(async (chunk) => {
        const detailParams = new URLSearchParams({
            part: 'contentDetails,statistics,status',
            id: chunk.join(','),
            key,
        });
        const url = buildYtUrl('videos', detailParams);
        const resp = await fetchWithTimeout(url, 'YouTube videos.list');
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.warn('[YouTube] videos.list failed:', resp.status, body.slice(0, 200));
            return;
        }
        const data: any = await resp.json();
        for (const item of data.items || []) {
            out.set(item.id, {
                durationSec: parseISO8601Duration(item.contentDetails?.duration),
                viewCount: item.statistics?.viewCount ? Number(item.statistics.viewCount) : undefined,
                embeddable: item.status?.embeddable !== false,
            });
        }
    }));

    return out;
};

export const youtubeService = {
    isConfigured(): boolean {
        return !!YOUTUBE_API_KEY;
    },

    async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
        const key = ensureKey();
        const params = new URLSearchParams({
            part: 'snippet',
            q: query,
            type: 'video',
            // Ask YouTube to drop videos whose uploaders disabled iframe
            // embedding — major label music channels block it and the iframe
            // would render a "Watch on YouTube" stub instead of playing.
            videoEmbeddable: 'true',
            videoSyndicated: 'true',
            // Pull a few extras so we can still fill the grid after we drop
            // any stragglers that slipped past the embeddable filter.
            maxResults: String(Math.min(50, (options.maxResults ?? 20) + 8)),
            key,
        });
        if (options.pageToken) params.set('pageToken', options.pageToken);
        if (options.videoDuration && options.videoDuration !== 'any') {
            params.set('videoDuration', options.videoDuration);
        }

        const url = buildYtUrl('search', params);
        const resp = await fetchWithTimeout(url, 'YouTube search');
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`YouTube search failed (${resp.status}): ${body.slice(0, 200)}`);
        }
        const data: any = await resp.json();

        const ids: string[] = [];
        const allItems: YouTubeSnippet[] = (data.items || [])
            .filter((it: any) => it?.id?.videoId)
            .map((it: any) => {
                ids.push(it.id.videoId);
                return {
                    videoId: it.id.videoId,
                    title: it.snippet?.title || '',
                    description: it.snippet?.description || '',
                    channelTitle: it.snippet?.channelTitle || '',
                    publishedAt: it.snippet?.publishedAt || '',
                    thumbnail: pickThumbnail(it.snippet?.thumbnails),
                };
            });

        let items = allItems;
        try {
            const details = await fetchVideoDetails(ids);
            // Belt-and-suspenders: drop anything that videos.list confirms is
            // not embeddable, even if search told us otherwise.
            items = allItems.filter((item) => details.get(item.videoId)?.embeddable !== false);
            for (const item of items) {
                const d = details.get(item.videoId);
                if (d) {
                    item.durationSec = d.durationSec;
                    item.viewCount = d.viewCount;
                }
            }
        } catch (err) {
            console.warn('[YouTube] details hydrate failed (non-fatal):', err);
        }

        if (options.maxResults && items.length > options.maxResults) {
            items = items.slice(0, options.maxResults);
        }

        return {
            items,
            nextPageToken: data.nextPageToken,
        };
    },

    async getTrending(options: { regionCode?: string; categoryId?: string; maxResults?: number; pageToken?: string } = {}): Promise<SearchResult> {
        const key = ensureKey();
        // Over-fetch a bit so we still have plenty of results after dropping
        // any non-embeddable videos (e.g. Saregama / T-Series uploads).
        const desired = options.maxResults ?? 20;
        const params = new URLSearchParams({
            part: 'snippet,contentDetails,statistics,status',
            chart: 'mostPopular',
            regionCode: options.regionCode || 'IN',
            maxResults: String(Math.min(50, desired + 10)),
            key,
        });
        if (options.categoryId) params.set('videoCategoryId', options.categoryId);
        if (options.pageToken) params.set('pageToken', options.pageToken);

        const url = buildYtUrl('videos', params);
        const resp = await fetchWithTimeout(url, 'YouTube trending');
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(`YouTube trending failed (${resp.status}): ${body.slice(0, 200)}`);
        }
        const data: any = await resp.json();

        const items: YouTubeSnippet[] = (data.items || [])
            .filter((it: any) => it?.status?.embeddable !== false)
            .map((it: any) => ({
                videoId: it.id,
                title: it.snippet?.title || '',
                description: it.snippet?.description || '',
                channelTitle: it.snippet?.channelTitle || '',
                publishedAt: it.snippet?.publishedAt || '',
                thumbnail: pickThumbnail(it.snippet?.thumbnails),
                durationSec: parseISO8601Duration(it.contentDetails?.duration),
                viewCount: it.statistics?.viewCount ? Number(it.statistics.viewCount) : undefined,
            }))
            .slice(0, desired);

        return {
            items,
            nextPageToken: data.nextPageToken,
        };
    },

    /**
     * Convenience helper for hard-coded thumbnails when we have a videoId
     * and don't want to round-trip the API just for the image.
     */
    thumbnailUrl(videoId: string, quality: 'default' | 'medium' | 'high' | 'standard' | 'maxresdefault' = 'high'): string {
        return `https://i.ytimg.com/vi/${videoId}/${quality === 'high' ? 'hqdefault' : quality === 'medium' ? 'mqdefault' : quality === 'maxresdefault' ? 'maxresdefault' : 'default'}.jpg`;
    },
};

export type YouTubeCategoryPill = {
    label: string;
    /** YouTube `videoCategoryId` for trending fetch, or null if it's a search keyword instead. */
    categoryId?: string;
    /** Search keyword fallback (for things YouTube doesn't expose as a category id). */
    searchKeyword?: string;
};

export const YOUTUBE_CATEGORY_PILLS: YouTubeCategoryPill[] = [
    { label: 'Trending' },
    { label: 'Movies', searchKeyword: 'movie trailer' },
    { label: 'Music', categoryId: '10' },
    { label: 'Comedy', categoryId: '23' },
    { label: 'Gaming', categoryId: '20' },
    { label: 'Sports', categoryId: '17' },
    { label: 'Adventure', searchKeyword: 'adventure short film' },
    { label: 'Anime', searchKeyword: 'anime opening' },
];
