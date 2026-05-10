
export type MediaStatus = 'not_downloaded' | 'downloading' | 'downloaded' | 'download_failed';

export type TheaterStatus = 'live' | 'scheduled' | 'ended';

export interface TheaterSessionMeta {
    /** Stable per-session identifier used to scope the Realtime channel. */
    sessionId?: string;
    /** YouTube video id for cataloged playback (Theater Mode default source). */
    youtubeVideoId?: string;
    /** Channel/uploader name shown in the bubble + player header. */
    channelTitle?: string;
    mediaTitle?: string;
    status?: TheaterStatus;
    participants?: string[];
    hostId?: string;
    isLocked?: boolean;
    scheduledAt?: string;
    /** @deprecated user-uploaded path — Phase 1 prototype only. */
    videoUrl?: string;
    /** @deprecated host-side local file path — Phase 1 prototype only. */
    videoLocalUri?: string;
    viewerCount?: number;
}

export interface Message {
    id: string;
    sender: 'me' | 'them';
    senderId?: string;
    senderName?: string;
    text: string;
    timestamp: string;
    status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
    reactions?: string[];
    replyTo?: string;
    media?: {
        type: 'image' | 'video' | 'audio' | 'file' | 'status_reply' | 'theater_session';
        url: string;
        name?: string;
        caption?: string;
        thumbnail?: string;
        duration?: number;
        theater?: TheaterSessionMeta;
    };
    // Offline media support
    localFileUri?: string;
    mediaStatus?: MediaStatus;
    thumbnailUri?: string;
    fileSize?: number;
    mimeType?: string;
    editedAt?: string;
    isStarred?: boolean;
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
    avatarType?: 'default' | 'teddy' | 'custom';
    teddyVariant?: 'boy' | 'girl';
    status: 'online' | 'offline' | 'away' | 'busy';
    lastSeen?: string;
    about?: string;
    lastMessage?: string;
    unreadCount?: number;
    stories?: Story[];
    birthdate?: string;
    note?: string; // New field for Soul Notes (status bubble)
    noteTimestamp?: string; // ISO date string
    isArchived?: boolean;
    isGroup?: boolean; // Indicates if this contact is actually a chat_group
    last_updated_at?: string; // Server timestamp for profile validation
    localAvatarUri?: string; // Local file path for offline DP
    avatarUpdatedAt?: string; // Timestamp of the last successful DP download
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

// ─── NEW STATUS SYSTEM TYPES ───

export interface CachedStatus {
    id: string;
    userId: string;
    mediaLocalPath?: string;
    mediaUrl?: string;
    mediaKey?: string;
    mediaType: 'image' | 'video';
    caption?: string;
    duration: number;
    expiresAt: number; // unix timestamp
    isViewed: boolean;
    isMine: boolean;
    createdAt: number; // unix timestamp
    cachedAt: number; // unix timestamp
}

export interface PendingUpload {
    id: string;
    localUri: string;
    mediaType: 'image' | 'video';
    mediaKey?: string;
    caption?: string;
    createdAt: number;
    retryCount: number;
    uploadStatus: 'pending' | 'uploading' | 'failed';
}

export interface CachedUser {
    id: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string;
    avatarType?: 'default' | 'teddy' | 'custom';
    teddyVariant?: 'boy' | 'girl';
    localAvatarUri?: string; // Local cached avatar file
    soulNote?: string;
    soulNoteAt?: number;
}

export interface UserStatusGroup {
    user: CachedUser;
    statuses: CachedStatus[];
    hasUnviewed: boolean;
    isMine: boolean;
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
    contactName?: string;
    contactAvatar?: string;
    avatar?: string; // Alias for flexibility
    roomId?: string; // Added for debugging and signaling
    groupId?: string; // Room is actually a group
    participantIds?: string[]; // All users in the group call
    remoteMuted?: boolean;
    remoteVideoOff?: boolean;
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
