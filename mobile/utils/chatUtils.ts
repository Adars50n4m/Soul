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

    if (Array.isArray(msg.media)) {
        return msg.media.filter((m: any) => m?.url).map((m: any) => ({ ...m, localFileUri: msg.localFileUri }));
    }

    if (Array.isArray(msg.media?.items)) {
        return msg.media.items.filter((m: any) => m?.url).map((m: any) => ({ ...m, localFileUri: msg.localFileUri }));
    }

    if (msg.media?.url) {
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
