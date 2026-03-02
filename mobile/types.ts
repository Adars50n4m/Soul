
export type MediaStatus = 'not_downloaded' | 'downloading' | 'downloaded' | 'download_failed';

export interface Message {
    id: string;
    sender: 'me' | 'them';
    text: string;
    timestamp: string;
    status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
    reactions?: string[];
    replyTo?: string;
    media?: {
        type: 'image' | 'video' | 'audio' | 'file' | 'status_reply';
        url: string;
        name?: string;
        caption?: string;
    };
    // Offline media support
    localFileUri?: string;
    mediaStatus?: MediaStatus;
    thumbnailUri?: string;
    fileSize?: number;
    mimeType?: string;
}

export interface Story {
  id: string;
  url: string;
  type: 'image' | 'video' | 'text';
  timestamp: string;
  seen: boolean;
  duration?: number;
  caption?: string;
  backgroundColor?: string;
  userId?: string;
  likes?: string[];
  views?: string[];
  music?: {
    name: string;
    artist: string;
    image: string;
  };
}

export interface Contact {
    id: string;
    name: string;
    avatar: string;
    status: 'online' | 'offline' | 'away' | 'busy';
    lastSeen?: string;
    about?: string;
    lastMessage?: string;
    unreadCount?: number;
    stories?: Story[];
    birthdate?: string;
    note?: string; // New field for SoulSync Notes (status bubble)
    noteTimestamp?: string; // ISO date string
}

export interface StatusUpdate {
    id: string;
    userId: string; // 'me' for own status, or contact id
    mediaUrl: string;
    mediaType: 'image' | 'video';
    caption?: string;
    timestamp: string;
    expiresAt: string; // ISO date string, 24h from creation
    views: string[]; // Array of user IDs who viewed
    likes: string[]; // Array of user IDs who liked
    music?: {
      name: string;
      artist: string;
      image: string;
    };
    // Legacy fields for backwards compatibility
    contactName?: string;
    avatar?: string;
    time?: string;
    previewImage?: string;
}

export interface CallLog {
    id: string;
    contactId: string;
    contactName: string;
    avatar: string;
    time: string;
    previewImage?: string;
    type: 'incoming' | 'outgoing'; // type can just be direction now
    status: 'completed' | 'missed' | 'rejected' | 'busy';
    duration?: number; // in seconds
    callType: 'audio' | 'video';
}

export interface ActiveCall {
    callId?: string;
    contactId: string;
    type: 'audio' | 'video';
    isMinimized: boolean;
    startTime?: number;
    isMuted: boolean;
    isVideoOff?: boolean;
    isSpeaker?: boolean;
    isIncoming: boolean;
    isAccepted: boolean;
    isRinging?: boolean;
    callerName?: string;
    callerAvatar?: string;
    roomId?: string; // Added for debugging and signaling
}

export interface Song {
    id: string;
    name: string;
    artist: string;
    image: string;
    url: string;
    duration?: number;
}

export interface MusicState {
    currentSong: Song | null;
    isPlaying: boolean;
    favorites: Song[];
}
