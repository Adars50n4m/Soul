import { Message } from '../types';
const MEDIA_GROUP_MARKER = '__MEDIA_GROUP_V1__:';

export interface ChatMediaItem {
    url: string;
    type: string;
    caption?: string;
    name?: string;
    localFileUri?: string;
    thumbnail?: string;
    duration?: number;
}

const decodeGroupedItems = (thumbnail?: string): ChatMediaItem[] => {
    if (!thumbnail || !thumbnail.startsWith(MEDIA_GROUP_MARKER)) return [];
    try {
        const raw = thumbnail.slice(MEDIA_GROUP_MARKER.length);
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(Boolean).map((item: any) => ({
            url: item?.url || '',
            type: item?.type || 'image',
            caption: item?.caption,
            name: item?.name,
            localFileUri: item?.localFileUri,
            thumbnail: item?.thumbnail,
            duration: item?.duration,
        }));
    } catch {
        return [];
    }
};

export const getMessageMediaItems = (msg: Message | any): ChatMediaItem[] => {
    if (!msg?.media) return [];

    const hasSource = (m: any) => !!(m?.url || m?.localFileUri || msg.localFileUri);

    if (Array.isArray(msg.media)) {
        return msg.media.filter(hasSource).map((m: any) => ({ 
            ...m, 
            localFileUri: m.localFileUri || msg.localFileUri,
            thumbnail: m.thumbnail || msg.media?.thumbnail 
        }));
    }

    if (Array.isArray(msg.media?.items)) {
        return msg.media.items.filter(hasSource).map((m: any) => ({ 
            ...m, 
            localFileUri: m.localFileUri || msg.localFileUri,
            thumbnail: m.thumbnail || msg.media?.thumbnail
        }));
    }

    const groupedFromThumbnail = decodeGroupedItems(msg.media?.thumbnail);
    if (groupedFromThumbnail.length > 0) {
        return groupedFromThumbnail.filter(hasSource).map((m: any) => ({
            ...m,
            localFileUri: m.localFileUri || msg.localFileUri,
        }));
    }

    if (msg.media?.url || msg.localFileUri) {
        return [{ 
            ...msg.media, 
            localFileUri: msg.localFileUri,
            thumbnail: msg.media.thumbnail
        }];
    }

    return [];
};

export const sanitizeSongTitle = (title: string): string => {
    if (!title) return '';
    return title
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/\s*\[[^\]]*\]/g, '')
        .trim();
};
