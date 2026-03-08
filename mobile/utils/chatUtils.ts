import { Message } from '../types';

export interface ChatMediaItem {
    url: string;
    type: string;
    caption?: string;
    name?: string;
    localFileUri?: string;
}

export const getMessageMediaItems = (msg: Message | any): ChatMediaItem[] => {
    if (!msg?.media) return [];

    const hasSource = (m: any) => !!(m?.url || msg.localFileUri);

    if (Array.isArray(msg.media)) {
        return msg.media.filter(hasSource).map((m: any) => ({ ...m, localFileUri: msg.localFileUri }));
    }

    if (Array.isArray(msg.media?.items)) {
        return msg.media.items.filter(hasSource).map((m: any) => ({ ...m, localFileUri: msg.localFileUri }));
    }

    if (msg.media?.url || msg.localFileUri) {
        return [{ ...msg.media, localFileUri: msg.localFileUri }];
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
