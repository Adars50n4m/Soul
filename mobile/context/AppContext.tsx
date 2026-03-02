import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { Message, Contact, StatusUpdate, CallLog, ActiveCall, Song, MusicState } from '../types';
import { musicSyncService, PlaybackState } from '../services/MusicSyncService';
import { chatService, ChatMessage } from '../services/ChatService';
import { callService, CallSignal } from '../services/CallService';
import {
    notificationService,
    NOTIF_ACTION_ACCEPT_CALL,
    NOTIF_ACTION_MARK_READ,
    NOTIF_ACTION_REJECT_CALL,
    NOTIF_ACTION_REPLY_MESSAGE
} from '../services/NotificationService';
import { webRTCService } from '../services/WebRTCService';
import { nativeCallBridge } from '../services/NativeCallBridge';
import { nativeCallService } from '../services/NativeCallService';
import { webSocketErrorHandler } from '../services/WebSocketErrorHandler';
import { supabase } from '../config/supabase';
import { offlineService } from '../services/LocalDBService';
import { storageService } from '../services/StorageService';
import { backgroundSyncService } from '../services/BackgroundSyncService';
import { soundService } from '../services/SoundService';
import { proxySupabaseUrl, SERVER_URL } from '../config/api';

if (!offlineService) {
    console.warn('[AppContext] LocalDBService failed to load. Check native modules.');
}
import { AppState, AppStateStatus, Alert, Image, Platform } from 'react-native';

// Initialize WebSocket error handler early to catch reload crashes
webSocketErrorHandler;

export type ThemeName = 'midnight' | 'liquid-blue' | 'sunset' | 'emerald' | 'cyber' | 'amethyst';

interface ThemeConfig {
    primary: string;
    accent: string;
    bg: string;
}

export const THEMES: Record<ThemeName, ThemeConfig> = {
    'midnight': { primary: '#BC002A', accent: '#a855f7', bg: '#09090b' },
    'liquid-blue': { primary: '#135bec', accent: '#00f2ff', bg: '#020408' },
    'sunset': { primary: '#BC002A', accent: '#fb923c', bg: '#120202' },
    'emerald': { primary: '#10b981', accent: '#2dd4bf', bg: '#02120e' },
    'cyber': { primary: '#d4ff00', accent: '#00e5ff', bg: '#050505' },
    'amethyst': { primary: '#d946ef', accent: '#6366f1', bg: '#0a050f' },
};

// User Types
interface User {
    id: string;
    name: string;
    avatar: string;
    bio: string;
    birthdate?: string;
    note?: string; // New field for SoulSync Notes
    noteTimestamp?: string; // ISO date string
    privacy?: PrivacySettings;
}

export type PrivacyValue = 'everyone' | 'contacts' | 'nobody';

export interface PrivacySettings {
    lastSeen: PrivacyValue;
    profilePhoto: PrivacyValue;
    status: PrivacyValue;
    readReceipts: boolean;
}

const DEFAULT_PRIVACY: PrivacySettings = {
    lastSeen: 'everyone',
    profilePhoto: 'everyone',
    status: 'everyone',
    readReceipts: true,
};

// Fixed Users - Shri and Hari
const USERS: Record<string, User> = {
    'shri': {
        id: 'shri',
        name: 'SHRI',
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?q=80&w=400&h=400&fit=crop',
        bio: '笨ｨ Connected through the stars',
        birthdate: '2000-01-01',
    },
    'hari': {
        id: 'hari',
        name: 'HARI',
        avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?q=80&w=400&h=400&fit=crop',
        bio: '牒 Forever in sync',
        birthdate: '2000-01-01',
    },
};

// Credentials
const CREDENTIALS: Record<string, string> = {
    'shri': 'hari',  // Shri's password is Hari
    'hari': 'shri',  // Hari's password is Shri
};

interface AppContextType {
    // Auth
    currentUser: User | null;
    otherUser: User | null;
    isLoggedIn: boolean;
    isReady: boolean;
    isCloudConnected: boolean;
    login: (username: string, password: string) => Promise<boolean>;
    logout: () => Promise<void>;

    // Data
    contacts: Contact[];
    messages: Record<string, Message[]>;
    calls: CallLog[];
    statuses: StatusUpdate[];
    theme: ThemeName;
    activeTheme: ThemeConfig;
    activeCall: ActiveCall | null;
    musicState: MusicState;

    onlineUsers: string[];
    typingUsers: string[];

    // Actions
    addMessage: (chatId: string, text: string, sender: 'me' | 'them', media?: Message['media']) => string;
    updateMessage: (chatId: string, messageId: string, text: string) => void;
    updateMessageStatus: (chatId: string, messageId: string, status: 'sent' | 'delivered' | 'read') => void;
    deleteMessage: (chatId: string, messageId: string) => void;
    addReaction: (chatId: string, messageId: string, emoji: string) => void;
    addCall: (call: Omit<CallLog, 'id'>) => void;
    addStatus: (status: Omit<StatusUpdate, 'id' | 'likes' | 'views'> & { localUri?: string }) => void;
    deleteStatus: (id: string) => void;
    toggleStatusLike: (statusId: string) => Promise<void>;
    setTheme: (theme: ThemeName) => void;
    startCall: (contactId: string, type: 'audio' | 'video') => void;
    acceptCall: () => Promise<void>;
    endCall: () => void;
    toggleMinimizeCall: (val: boolean) => void;
    toggleMute: () => void;
    playSong: (song: Song) => void;
    togglePlayMusic: () => void;
    toggleFavoriteSong: (song: Song) => void;
    seekTo: (position: number) => void;
    getPlaybackPosition: () => Promise<number>;
    sendChatMessage: (chatId: string, text: string, media?: Message['media'], replyTo?: string) => void;
    updateProfile: (updates: { name?: string; bio?: string; avatar?: string; birthdate?: string; note?: string; noteTimestamp?: string }) => void;
    addStatusView: (statusId: string) => Promise<void>;
    sendTyping: (isTyping: boolean) => void;
    saveNote: (text: string) => Promise<void>;
    deleteNote: () => Promise<void>;
    clearChatMessages: (partnerId: string) => Promise<void>;

    // Security
    biometricEnabled: boolean;
    pinEnabled: boolean;
    pin: string | null;
    isLocked: boolean;
    setBiometricEnabled: (val: boolean) => Promise<void>;
    setPinEnabled: (val: boolean) => Promise<void>;
    setPin: (val: string | null) => Promise<void>;
    unlockApp: () => void;

    // Privacy
    privacySettings: PrivacySettings;
    updatePrivacy: (settings: Partial<PrivacySettings>) => Promise<void>;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Auth State
    const [currentUser, setCurrentUser] = useState<User | null>(null);
    const [otherUser, setOtherUser] = useState<User | null>(null);

    // App State
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [messages, setMessages] = useState<Record<string, Message[]>>({});
    const [calls, setCalls] = useState<CallLog[]>([]);
    const [statuses, setStatuses] = useState<StatusUpdate[]>([]);
    const [theme, setThemeState] = useState<ThemeName>('midnight');
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [isCloudConnected, setIsCloudConnected] = useState(true);
    const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
    const [typingUsers, setTypingUsers] = useState<string[]>([]);
    const appStateRef = useRef<AppStateStatus>(AppState.currentState as AppStateStatus);

    const [musicState, setMusicState] = useState<MusicState>({
        currentSong: null,
        isPlaying: false,
        favorites: []
    });

    // Security State
    const [biometricEnabled, setBiometricEnabledState] = useState(false);
    const [pinEnabled, setPinEnabledState] = useState(false);
    const [pin, setPinState] = useState<string | null>(null);
    const [isLocked, setIsLocked] = useState(false);

    // Privacy State
    const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(DEFAULT_PRIVACY);

    const [sound, setSound] = useState<Audio.Sound | null>(null);
    const soundRef = useRef<Audio.Sound | null>(null);
    const musicStateRef = useRef(musicState);
    const isSeekingRef = useRef(false);

    useEffect(() => { soundRef.current = sound; }, [sound]);
    useEffect(() => { musicStateRef.current = musicState; }, [musicState]);

    // Configure Audio mode for proper playback
    useEffect(() => {
        const configureAudio = async () => {
            try {
                await Audio.setAudioModeAsync({
                    allowsRecordingIOS: false,
                    playsInSilentModeIOS: true,
                    staysActiveInBackground: true,
                    shouldDuckAndroid: true,
                    playThroughEarpieceAndroid: false,
                });
            } catch (e) {
                console.error('Failed to configure audio mode:', e);
            }
        };
        configureAudio();
    }, []);

    const updatePresenceInSupabase = useCallback(async (userId: string, isOnline: boolean) => {
        try {
            await supabase
                .from('profiles')
                .update({
                    is_online: isOnline,
                    last_seen: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', userId);
        } catch (e) {
            console.warn('[AppContext] Failed to update presence in DB:', e);
        }
    }, []);

    // Ref for the Supabase presence channel (used by sendTyping and cleanup)
    const presenceChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

    // --- Real-Time Presence & Typing via Supabase Realtime ---
    useEffect(() => {
        if (!currentUser) return;

        const channel = supabase.channel('presence-global', {
            config: { presence: { key: currentUser.id } },
        });
        presenceChannelRef.current = channel;

        // Presence sync — fires whenever the presence state changes
        channel.on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState();
            const onlineIds = Object.keys(state);
            setOnlineUsers(onlineIds);
            setContacts(prev => prev.map(c => ({
                ...c,
                status: onlineIds.includes(c.id) ? 'online' : 'offline',
                // When user goes offline, stamp lastSeen with current time
                lastSeen: !onlineIds.includes(c.id) && c.status === 'online'
                    ? new Date().toISOString()
                    : c.lastSeen,
            })));
        });

        // Typing broadcast listener
        channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
            if (payload.userId !== currentUser.id) {
                setTypingUsers(prev => Array.from(new Set([...prev, payload.userId])));
            }
        });

        channel.on('broadcast', { event: 'stop-typing' }, ({ payload }) => {
            setTypingUsers(prev => prev.filter(id => id !== payload.userId));
        });

        channel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await channel.track({ user_id: currentUser.id, online_at: new Date().toISOString() });
                console.log('[Presence] Subscribed & tracking');
            }
        });

        // App state handling — track/untrack on foreground/background
        const handleAppStateChange = async (nextAppState: AppStateStatus) => {
            if (nextAppState === 'active') {
                console.log('[Presence] App active, tracking...');
                await channel.track({ user_id: currentUser.id, online_at: new Date().toISOString() });
                updatePresenceInSupabase(currentUser.id, true);
            } else if (nextAppState === 'background') {
                console.log('[Presence] App background, untracking...');
                await channel.untrack();
                updatePresenceInSupabase(currentUser.id, false);
            }
            appStateRef.current = nextAppState;
        };

        updatePresenceInSupabase(currentUser.id, true);
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
            channel.untrack();
            supabase.removeChannel(channel);
            presenceChannelRef.current = null;
            updatePresenceInSupabase(currentUser.id, false);
        };
    }, [currentUser, updatePresenceInSupabase]);

    // Initialize Music Sync
    useEffect(() => {
        if (currentUser) {
            // Check realtime connectivity before initializing
            import('../config/supabase')
                .then(({ checkRealtimeConnectivity }) => {
                    checkRealtimeConnectivity()
                        .then((result) => {
                            if (!result.ok) {
                                console.warn('[MusicSync] Realtime unavailable, sync will not work:', result.error);
                            } else {
                                console.log('[MusicSync] Realtime connectivity confirmed');
                            }
                        })
                        .catch(err => {
                            console.error('[MusicSync] connectivity check CRASHED:', err);
                        });
                })
                .catch(err => {
                    console.error('[MusicSync] Failed to lazy load supabase config:', err);
                });
            
            musicSyncService.initialize(currentUser.id, async (remoteState) => {
                try {
                    const currentMusicState = musicStateRef.current;
                    if (remoteState.currentSong?.id !== currentMusicState.currentSong?.id) {
                        if (remoteState.currentSong) {
                            await playSong(remoteState.currentSong, false);
                        }
                    }
                    if (remoteState.isPlaying !== currentMusicState.isPlaying) {
                        if (remoteState.isPlaying) {
                            await soundRef.current?.playAsync();
                        } else {
                            await soundRef.current?.pauseAsync();
                        }
                        setMusicState(prev => ({ ...prev, isPlaying: remoteState.isPlaying }));
                    }
                    if (soundRef.current && remoteState.isPlaying) {
                        const status = await soundRef.current.getStatusAsync();
                        if (status.isLoaded) {
                            const currentPos = status.positionMillis;
                            if (Math.abs(currentPos - remoteState.position) > 2000 && !isSeekingRef.current) {
                                try {
                                    isSeekingRef.current = true;
                                    await soundRef.current.setPositionAsync(remoteState.position);
                                    isSeekingRef.current = false;
                                } catch (seekError) {
                                    isSeekingRef.current = false;
                                    // Let outer catch handle reporting if needed, or ignore seeking-interrupted
                                }
                            }
                        }
                    }
                } catch (e: any) {
                    const message = String(e?.message || e || '');
                    if (!message.toLowerCase().includes('seeking interrupted')) {
                        console.warn('[MusicSync] Remote update failed:', e);
                    }
                }
            });
        }
        return () => musicSyncService.cleanup();
    }, [currentUser]); 

    // Load session on mount
    useEffect(() => {
        const loadSession = async () => {
            try {
                const userId = await AsyncStorage.getItem('ss_current_user');
                console.log('[AppContext] Loading session for user:', userId);
                
                if (userId) {
                    const storedProfileStr = await AsyncStorage.getItem(`@profile_${userId}`);
                    let userObj = USERS[userId];
                    if (storedProfileStr) {
                        try { userObj = JSON.parse(storedProfileStr); } catch (e) {}
                    }
                    
                    const otherId = userId === 'shri' ? 'hari' : 'shri';
                    const other = USERS[otherId];
                    
                    setCurrentUser(userObj);
                    setOtherUser(other);
                    
                    // 1. Load from Local DB (Instant)
                    try {
                        const localContacts = await offlineService?.getContacts() || [];
                        if (localContacts.length > 0) {
                            console.log('[AppContext] Loaded contacts from local DB');
                            setContacts(localContacts);
                        } else {
                             // Fallback for first run
                            setContacts([{
                                id: other.id,
                                name: other.name,
                                avatar: other.avatar,
                                status: 'offline',
                                about: other.bio || '',
                                lastMessage: '',
                                unreadCount: 0,
                            }]);
                        }

                        const localMessages = await offlineService?.getMessages(other.id) || [];
                        if (localMessages.length > 0) {
                            console.log('[AppContext] Loaded messages from local DB', localMessages.length);
                            setMessages(prev => ({ ...prev, [other.id]: localMessages }));
                        }
                        
                        const localStatusRows = await offlineService?.getStatuses() || [];
                        if (localStatusRows.length > 0) {
                            console.log('[AppContext] Loaded statuses from local DB', localStatusRows.length);
                            setStatuses(localStatusRows.map(mapLocalStatusToUI));
                        }
                    } catch (e) {
                        console.error('[AppContext] Failed to load local DB:', e);
                    }

                    // 2. Fetch from Network (Sync) - non-blocking for instant startup
                    fetchProfileFromSupabase(userId);
                    fetchCallsFromSupabase(userId);
                    fetchOtherUserProfile(other.id);
                    fetchStatusesFromSupabase(userId, other.id); // Sync to LocalDB
                }

                const [storedTheme, storedFavorites, storedLastSong, storedBio, storedPinEnabled, storedPin] = await Promise.all([
                    AsyncStorage.getItem('ss_theme'),
                    AsyncStorage.getItem(userId ? `ss_favorites_${userId}` : 'ss_favorites_none'),
                    AsyncStorage.getItem(userId ? `ss_last_song_${userId}` : 'ss_last_song_none'),
                    AsyncStorage.getItem(userId ? `ss_biometric_${userId}` : 'ss_biometric_none'),
                    AsyncStorage.getItem(userId ? `ss_pin_enabled_${userId}` : 'ss_pin_enabled_none'),
                    AsyncStorage.getItem(userId ? `ss_pin_${userId}` : 'ss_pin_none'),
                ]);

                if (storedTheme) setThemeState(storedTheme as ThemeName);
                if (storedBio) setBiometricEnabledState(storedBio === 'true');
                if (storedPinEnabled) setPinEnabledState(storedPinEnabled === 'true');
                if (storedPin) setPinState(storedPin);

                if (storedFavorites) {
                    try {
                        setMusicState(prev => ({ ...prev, favorites: JSON.parse(storedFavorites) }));
                    } catch (e) {}
                }

                if (storedLastSong) {
                    try {
                        const song = JSON.parse(storedLastSong);
                        setMusicState(prev => ({ ...prev, currentSong: song }));
                        // We don't auto-play, just set as current
                    } catch (e) {}
                }

                if (userId) {
                    const storedPrivacy = await AsyncStorage.getItem(`ss_privacy_${userId}`);
                    if (storedPrivacy) {
                        try {
                            setPrivacySettings(JSON.parse(storedPrivacy));
                        } catch (e) {}
                    }
                }
                
            } catch (e) {
                console.warn('[AppContext] Failed to load session', e);
            }
            setIsReady(true);
        };
        loadSession();
    }, []);

    // Persistence is handled by LocalDBService (offlineService)
    // Removed redundant and slow AsyncStorage.setItem('ss_messages') logic

    useEffect(() => { AsyncStorage.setItem('ss_theme', theme); }, [theme]);
    useEffect(() => {
        if (currentUser) {
            AsyncStorage.setItem(`ss_favorites_${currentUser.id}`, JSON.stringify(musicState.favorites));
        }
    }, [musicState.favorites, currentUser]);

    // Security Persistence
    useEffect(() => {
        if (currentUser) {
            AsyncStorage.setItem(`ss_biometric_${currentUser.id}`, JSON.stringify(biometricEnabled));
        }
    }, [biometricEnabled, currentUser]);

    useEffect(() => {
        if (currentUser) {
            AsyncStorage.setItem(`ss_pin_enabled_${currentUser.id}`, JSON.stringify(pinEnabled));
        }
    }, [pinEnabled, currentUser]);

    useEffect(() => {
        if (currentUser) {
            if (pin) AsyncStorage.setItem(`ss_pin_${currentUser.id}`, pin);
            else AsyncStorage.removeItem(`ss_pin_${currentUser.id}`);
        }
    }, [pin, currentUser]);

    // Audio cleanup
    useEffect(() => {
        return sound ? () => { sound.unloadAsync(); } : undefined;
    }, [sound]);

    // Background Sync Runner (Process pending actions)
    useEffect(() => {
        let syncInterval: NodeJS.Timeout;

        const processSyncQueue = async () => {
             try {
                 const actions = await offlineService.getPendingSyncActions();
                 if (!actions || actions.length === 0) return;

                 for (const action of actions) {
                     // Exceeded retries (e.g. 5x) -> delete it or handle failure
                     if (action.retry_count >= 5) {
                         await offlineService.removeSyncAction(action.id);
                         continue;
                     }

                     try {
                         if (action.action === 'UPLOAD_STATUS_MEDIA') {
                             const { id, messageId, localPath } = action.payload;
                             // Proceed with upload
                             const uploadedUrl = await storageService.uploadImage(localPath, 'status-media');
                             if (uploadedUrl) {
                                 // Ideally we would trigger a Supabase metadata update here
                                 // For now, task is just to perform the R2 upload logic in background
                                 await offlineService.removeSyncAction(action.id);
                             } else {
                                 await offlineService.incrementSyncRetry(action.id);
                             }
                         } else if (action.action === 'SEND_MESSAGE') {
                             // E.g. trigger ChatService to send the queued message to the Node server
                             // await ChatService.sendQueuedMessageToServer(...)
                             await offlineService.removeSyncAction(action.id);
                         } else {
                             // Unknown action
                             await offlineService.removeSyncAction(action.id);
                         }
                     } catch (e) {
                         console.warn(`[BackgroundSync] Failed to process action ${action.id}:`, e);
                         await offlineService.incrementSyncRetry(action.id);
                     }
                 }
             } catch (error) {
                 console.warn('[BackgroundSync] Error fetching queue:', error);
             }
        };

        // Poll every 10 seconds
        syncInterval = setInterval(processSyncQueue, 10000);
        
        // Fire immediately once on load
        processSyncQueue();

        return () => clearInterval(syncInterval);
    }, []);

    // Initialize Chat Service
    useEffect(() => {
        if (currentUser && otherUser) {
            chatService.initialize(
                currentUser.id,
                otherUser.id,
                (incomingMessage: ChatMessage) => {
                    const isFromMe = incomingMessage.sender_id === currentUser.id;
                    const newMsg: Message = {
                        id: incomingMessage.id,
                        sender: isFromMe ? 'me' : 'them',
                        text: incomingMessage.text,
                        timestamp: incomingMessage.timestamp,
                        status: isFromMe ? 'sent' : 'delivered',
                        media: incomingMessage.media,
                        replyTo: incomingMessage.reply_to || undefined,
                    };
                    
                    addMessageSafely(otherUser.id, newMsg);

                    setContacts(prevContacts => prevContacts.map(c =>
                        c.id === otherUser.id ? {
                            ...c,
                            lastMessage: incomingMessage.media ? 'Attachment' : incomingMessage.text,
                            unreadCount: !isFromMe ? (c.unreadCount || 0) + 1 : c.unreadCount
                        } : c
                    ));

                    if (!isFromMe) {
                        if (AppState.currentState !== 'active' || (otherUser && otherUser.id !== incomingMessage.sender_id)) {
                             const sender = contacts.find(c => c.id === incomingMessage.sender_id);
                             notificationService.showIncomingMessage({
                                chatId: incomingMessage.sender_id,
                                senderId: incomingMessage.sender_id,
                                senderName: incomingMessage.sender_id === USERS.shri.id ? USERS.shri.name : sender?.name || 'Someone',
                                text: incomingMessage.media ? 'Attachment' : incomingMessage.text,
                                messageId: incomingMessage.id
                            });
                        }
                    }
                },
                (messageId: string, status: ChatMessage['status'], newId?: string) => {
                    if (otherUser) {
                        setMessages(prev => {
                            const chatMessages = prev[otherUser.id] || [];
                            return {
                                ...prev,
                                [otherUser.id]: chatMessages.map(msg =>
                                    msg.id === messageId ? { ...msg, status, id: newId || msg.id } : msg
                                )
                            };
                        });
                    }
                },
                (statusData: any) => {
                    console.log('[AppContext] Real-time status sync via socket:', statusData.id);
                    // 1. Save to local SQLite
                    offlineService.saveStatus({
                        id: statusData.id,
                        userId: statusData.userId || statusData.user_id,
                        type: statusData.mediaType || statusData.media_type as any,
                        r2Key: statusData.mediaUrl || statusData.media_url,
                        textContent: statusData.caption,
                        createdAt: typeof statusData.createdAt === 'string' ? new Date(statusData.createdAt).getTime() : statusData.createdAt,
                        expiresAt: typeof statusData.expiresAt === 'string' ? new Date(statusData.expiresAt).getTime() : statusData.expiresAt,
                        isMine: statusData.userId === currentUser.id || statusData.user_id === currentUser.id
                    }).catch(err => console.error('[AppContext] Save synced status error:', err));

                    // 2. Update React State
                    const incomingStatus: StatusUpdate = {
                        id: statusData.id,
                        userId: statusData.userId || statusData.user_id,
                        contactName: statusData.userName || statusData.user_name,
                        avatar: statusData.userAvatar || statusData.user_avatar,
                        mediaUrl: statusData.mediaUrl || statusData.media_url,
                        mediaType: statusData.mediaType || statusData.media_type,
                        caption: statusData.caption,
                        timestamp: typeof statusData.createdAt === 'number' ? new Date(statusData.createdAt).toISOString() : statusData.createdAt,
                        expiresAt: typeof statusData.expiresAt === 'number' ? new Date(statusData.expiresAt).toISOString() : statusData.expiresAt,
                        likes: [],
                        views: []
                    };
                    
                    setStatuses(prev => {
                        if (prev.find(s => s.id === incomingStatus.id)) return prev;
                        return [incomingStatus, ...prev];
                    });

                    // Resolve R2 key to displayable URL in background
                    if (incomingStatus.mediaUrl && !incomingStatus.mediaUrl.startsWith('file://') && !incomingStatus.mediaUrl.startsWith('data:') && !incomingStatus.mediaUrl.startsWith('http')) {
                        storageService.getMediaUrl(incomingStatus.mediaUrl).then(resolvedUrl => {
                            if (resolvedUrl) {
                                setStatuses(prev => prev.map(s => s.id === incomingStatus.id ? { ...s, mediaUrl: resolvedUrl } : s));
                            }
                        }).catch(() => {});
                    }
                },
                (statusId: string, viewerId: string) => {
                    console.log('[AppContext] Status view update received for:', statusId);
                    setStatuses(prev => prev.map(s => {
                        if (s.id === statusId && !s.views.includes(viewerId)) {
                            return { ...s, views: [...(s.views || []), viewerId] };
                        }
                        return s;
                    }));
                },
                (online: boolean) => {
                    setIsCloudConnected(online);
                }
            );
        }
        return () => chatService.cleanup();
    }, [currentUser, otherUser]);

    // --- REFINED DATA FETCHING ---

    /** Resolve R2 keys → local file URIs for all statuses (background, non-blocking) */
    const resolveStatusMediaUrls = async (statusList: StatusUpdate[]) => {
        try {
            const resolved = await Promise.all(
                statusList.map(async (s) => {
                    // Skip if already a displayable URI
                    if (!s.mediaUrl || s.mediaUrl.startsWith('file://') || s.mediaUrl.startsWith('data:') || s.mediaUrl.startsWith('http')) {
                        return s;
                    }
                    // s.mediaUrl is an R2 key — resolve to local/presigned URL
                    const localUrl = await storageService.getMediaUrl(s.mediaUrl);
                    return localUrl ? { ...s, mediaUrl: localUrl } : s;
                })
            );
            setStatuses(resolved);
        } catch (e) {
            console.warn('[AppContext] resolveStatusMediaUrls failed (non-fatal):', e);
        }
    };

    const fetchStatusesFromSupabase = async (userId: string, otherId: string) => {
        try {
            console.log("Fetching statuses from Supabase to sync...");
            const { data, error } = await supabase
                .from('statuses')
                .select('*')
                .gt('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false });

            if (data && !error) {
                // Save to local offline DB for offline support (best-effort, non-blocking)
                if (offlineService) {
                    for (const dbStatus of data) {
                        offlineService.saveStatus({
                            id: dbStatus.id.toString(),
                            userId: dbStatus.user_id,
                            type: dbStatus.media_type || 'image',
                            r2Key: dbStatus.media_url,
                            textContent: dbStatus.caption,
                            viewers: dbStatus.views || [],
                            createdAt: new Date(dbStatus.created_at).getTime(),
                            expiresAt: new Date(dbStatus.expires_at).getTime(),
                            isMine: dbStatus.user_id === userId
                        }).catch(() => {});
                    }
                }

                // Map Supabase rows directly to StatusUpdate for UI
                // (SQLite loses user_name, user_avatar, likes — so use Supabase data as source of truth)
                const mapped = data.map(mapStatusFromDB);
                setStatuses(mapped);

                // Resolve R2 keys to local/presigned URLs in background (non-blocking)
                resolveStatusMediaUrls(mapped);
            }
        } catch (e) { console.warn('Fetch statuses error (Non-fatal):', e); }
    };

    const fetchCallsFromSupabase = async (userId: string) => {
        try {
            console.log("Fetching call history for:", userId);
            // Simple OR query
            const { data, error } = await supabase
                .from('call_logs')
                .select('*')
                .or(`caller_id.eq.${userId},callee_id.eq.${userId}`)
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) {
                console.warn("Supabase Call Fetch Error:", error);
                return;
            }

            console.log("Call history fetched successfully:", data?.length, "records");

            if (data) {
                const mappedCalls: CallLog[] = data.map((log: any) => {
                    const isOutgoing = log.caller_id === userId;
                    const partnerId = isOutgoing ? log.callee_id : log.caller_id;
                    const partner = (otherUser && partnerId === otherUser.id) ? otherUser : USERS[partnerId]; 

                    return {
                        id: log.id.toString(),
                        contactId: partnerId,
                        contactName: partner?.name || 'Unknown',
                        avatar: partner?.avatar || '',
                        type: isOutgoing ? 'outgoing' : 'incoming',
                        status: log.status || 'completed',
                        duration: log.duration,
                        callType: log.call_type,
                        time: new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    };
                });
                
                setCalls(mappedCalls);
            }
        } catch (e) { console.warn('Fetch calls error:', e); }
    };

    // Helper to add messages with deduplication
    const addMessageSafely = useCallback((partnerId: string, msg: Message) => {
        setMessages(prev => {
            const current = prev[partnerId] || [];
            if (current.find(m => m.id === msg.id)) return prev;
            
            const newList = [...current, { ...msg, timestamp: msg.timestamp || new Date().toISOString() }];
            return {
                ...prev,
                [partnerId]: newList.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            };
        });

        // Ensure newly observed remote messages persist to local DB
        if (offlineService && msg.sender !== 'me') {
            offlineService.saveMessage(partnerId, msg).catch(e => console.warn('saveMessage err:', e));
        }
    }, []);

    // Real-time Subscriptions
    useEffect(() => {
        if (!currentUser) return;

        // Listen for new CALL_LOGS (Persistence)
        const callSub = supabase
            .channel('public:call_logs')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, (payload) => {
                const newLog = payload.new as any;
                if (newLog.caller_id === currentUser.id || newLog.callee_id === currentUser.id) {
                    const isOutgoing = newLog.caller_id === currentUser.id;
                    const partnerId = isOutgoing ? newLog.callee_id : newLog.caller_id;
                    const partner = (otherUser && partnerId === otherUser.id) ? otherUser : USERS[partnerId];
                    
                    const callItem: CallLog = {
                        id: newLog.id.toString(),
                        contactId: partnerId,
                        contactName: partner?.name || 'Unknown',
                        avatar: partner?.avatar || '',
                        type: isOutgoing ? 'outgoing' : 'incoming',
                        status: newLog.status || 'completed',
                        duration: newLog.duration,
                        callType: newLog.call_type,
                        time: new Date(newLog.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    };
                    setCalls(prev => [callItem, ...prev]);
                }
            })
            .subscribe();

        // Listen for new STATUSES (Sync)
        const statusSub = supabase
            .channel('public:statuses')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'statuses' }, async (payload) => {
                if (payload.eventType === 'INSERT') {
                    const newStatus = payload.new;
                    // Verify if active
                    if (new Date(newStatus.expires_at) > new Date()) {
                        // Ensure the status owner exists in the contact list so Home can render it
                        // next to "My status" immediately.
                        const statusOwnerId = newStatus.user_id as string | undefined;
                        if (statusOwnerId && currentUser?.id && statusOwnerId !== currentUser.id) {
                            setContacts(prev => {
                                if (prev.some(c => c.id === statusOwnerId)) return prev;
                                return [
                                    ...prev,
                                    {
                                        id: statusOwnerId,
                                        name: 'Unknown',
                                        avatar: '',
                                        status: 'offline',
                                        lastMessage: 'Start a conversation',
                                        unreadCount: 0,
                                    },
                                ];
                            });

                            // Backfill profile info (non-blocking).
                            try {
                                const { data } = await supabase
                                    .from('profiles')
                                    .select('*')
                                    .eq('id', statusOwnerId)
                                    .single();
                                if (data) {
                                    setContacts(prev => prev.map(c => c.id === statusOwnerId ? {
                                        ...c,
                                        name: data.name || c.name,
                                        avatar: data.avatar_url || c.avatar,
                                        about: data.bio || c.about,
                                        status: data.is_online ? 'online' : c.status,
                                        lastSeen: data.last_seen || c.lastSeen,
                                    } : c));
                                }
                            } catch (e) {
                                // Non-fatal: rail can still render with placeholder.
                            }
                        }
                        const mappedNew = mapStatusFromDB(newStatus);
                        setStatuses(prev => {
                            if (prev.find(s => s.id === mappedNew.id)) return prev;
                            return [mappedNew, ...prev];
                        });
                        // Resolve R2 key in background
                        if (mappedNew.mediaUrl && !mappedNew.mediaUrl.startsWith('file://') && !mappedNew.mediaUrl.startsWith('data:') && !mappedNew.mediaUrl.startsWith('http')) {
                            storageService.getMediaUrl(mappedNew.mediaUrl).then(url => {
                                if (url) setStatuses(prev => prev.map(s => s.id === mappedNew.id ? { ...s, mediaUrl: url } : s));
                            }).catch(() => {});
                        }
                    }
                } else if (payload.eventType === 'UPDATE') {
                    const updated = payload.new;
                    const mappedUpdated = mapStatusFromDB(updated);
                    setStatuses(prev => prev.map(s =>
                        s.id === mappedUpdated.id ? mappedUpdated : s
                    ));
                    // Resolve R2 key in background
                    if (mappedUpdated.mediaUrl && !mappedUpdated.mediaUrl.startsWith('file://') && !mappedUpdated.mediaUrl.startsWith('data:') && !mappedUpdated.mediaUrl.startsWith('http')) {
                        storageService.getMediaUrl(mappedUpdated.mediaUrl).then(url => {
                            if (url) setStatuses(prev => prev.map(s => s.id === mappedUpdated.id ? { ...s, mediaUrl: url } : s));
                        }).catch(() => {});
                    }
                } else if (payload.eventType === 'DELETE') {
                    setStatuses(prev => prev.filter(s => s.id !== payload.old.id.toString()));
                }
            })
            .subscribe();

        // Listen for new MESSAGES (Realtime & Persistence)
        const messageSub = supabase
            .channel('public:messages')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
                const newMsg = payload.new as any;
                // Skip messages sent by me — ChatService.sendMessage already handles
                // optimistic UI + ID reconciliation for outgoing messages.
                // Processing them here again would cause duplicates (different local vs server IDs).
                if (newMsg.sender === currentUser.id) return;

                if (newMsg.receiver === currentUser.id) {
                    const partnerId = newMsg.sender;
                    
                    const message: Message = {
                        id: newMsg.id.toString(),
                        sender: 'them',
                        text: newMsg.text,
                        // Keep ISO timestamp for consistent sorting/deduplication
                        timestamp: newMsg.created_at,
                        status: 'delivered',
                        media: newMsg.media_url ? { type: newMsg.media_type, url: newMsg.media_url, caption: newMsg.media_caption } : undefined,
                        replyTo: newMsg.reply_to_id
                    };

                    // Save to Local DB
                    if (offlineService) {
                        await offlineService.saveMessage(partnerId, message);
                    }

                    // Update State using helper
                    addMessageSafely(partnerId, message);

                    // Update Contact Last Message
                    setContacts(prev => prev.map(c => 
                        c.id === partnerId ? {
                            ...c,
                            lastMessage: message.media ? '📎 Attachment' : message.text,
                            unreadCount: (c.unreadCount || 0) + 1
                        } : c
                    ));
                }
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, async (payload) => {
                const updatedMsg = payload.new as any;
                if (!updatedMsg?.id || !currentUser?.id) return;

                const partnerId =
                    updatedMsg.sender === currentUser.id
                        ? updatedMsg.receiver
                        : updatedMsg.sender;
                if (!partnerId) return;

                let mergedMessage: Message | null = null;

                setMessages(prev => {
                    const chatMessages = prev[partnerId] || [];
                    const idx = chatMessages.findIndex(m => m.id === updatedMsg.id.toString());
                    if (idx < 0) return prev;

                    const existing = chatMessages[idx];
                    const updatedReaction = updatedMsg.reaction ? [updatedMsg.reaction] : [];
                    mergedMessage = {
                        ...existing,
                        text: updatedMsg.text ?? existing.text,
                        status: updatedMsg.status ?? existing.status,
                        replyTo: updatedMsg.reply_to_id?.toString() ?? existing.replyTo,
                        media: updatedMsg.media_url
                            ? {
                                type: updatedMsg.media_type || 'image',
                                url: updatedMsg.media_url,
                                caption: updatedMsg.media_caption,
                            }
                            : existing.media,
                        reactions: updatedReaction,
                    };

                    const next = [...chatMessages];
                    next[idx] = mergedMessage;
                    return { ...prev, [partnerId]: next };
                });

                if (mergedMessage && offlineService) {
                    await offlineService.saveMessage(partnerId, mergedMessage);
                }
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, async (payload) => {
                const oldMsg = payload.old as any;
                if (!oldMsg?.id) return;
                
                const msgId = oldMsg.id.toString();

                if (offlineService) {
                    await offlineService.deleteMessage(msgId);
                }

                setMessages(prev => {
                    const next = { ...prev };
                    for (const [chatId, msgs] of Object.entries(next)) {
                        const filtered = msgs.filter(m => m.id !== msgId);
                        if (filtered.length !== msgs.length) {
                            next[chatId] = filtered;
                            // Update Contact Last Message
                            const lastMsg = filtered[filtered.length - 1];
                            setContacts(prevContacts => prevContacts.map(c =>
                                c.id === chatId ? {
                                    ...c,
                                    lastMessage: lastMsg ? (lastMsg.media ? '📎 Attachment' : lastMsg.text) : ''
                                } : c
                            ));
                        }
                    }
                    return next;
                });
            })
            .subscribe();

        return () => {
            supabase.removeChannel(callSub);
            supabase.removeChannel(statusSub);
            supabase.removeChannel(messageSub);
        };
    }, [currentUser?.id, otherUser]);

    // Helpers

    /** Map a Supabase DB row (snake_case) → StatusUpdate */
    const mapStatusFromDB = (dbStatus: any): StatusUpdate => ({
        id: dbStatus.id.toString(),
        userId: dbStatus.user_id,
        contactName: dbStatus.user_name || 'Unknown',
        avatar: dbStatus.user_avatar || '',
        mediaUrl: dbStatus.media_url,
        mediaType: dbStatus.media_type,
        caption: dbStatus.caption,
        timestamp: typeof dbStatus.created_at === 'number'
            ? new Date(dbStatus.created_at).toISOString()
            : dbStatus.created_at,
        expiresAt: typeof dbStatus.expires_at === 'number'
            ? new Date(dbStatus.expires_at).toISOString()
            : dbStatus.expires_at,
        views: dbStatus.views || [],
        likes: dbStatus.likes || [],
        music: dbStatus.music || undefined
    });

    /** Map a raw SQLite row → StatusUpdate (SQLite columns differ from both Supabase and StatusUpdate) */
    const mapLocalStatusToUI = (row: any): StatusUpdate => ({
        id: row.id,
        userId: row.user_id || row.userId || '',
        mediaUrl: row.r2_key || row.local_path || row.mediaUrl || '',
        mediaType: (row.type || row.mediaType || 'image') as 'image' | 'video',
        caption: row.text_content || row.caption || '',
        timestamp: row.created_at
            ? (typeof row.created_at === 'number' ? new Date(row.created_at).toISOString() : row.created_at)
            : new Date().toISOString(),
        expiresAt: row.expires_at
            ? (typeof row.expires_at === 'number' ? new Date(row.expires_at).toISOString() : row.expires_at)
            : '',
        views: row.viewers
            ? (typeof row.viewers === 'string' ? (() => { try { return JSON.parse(row.viewers); } catch { return []; } })() : row.viewers)
            : [],
        likes: [],
        contactName: '',
        avatar: '',
    });

    const sendChatMessage = useCallback(async (chatId: string, text: string, media?: Message['media'], replyTo?: string) => {
        // ChatService.sendMessage now triggers the onNewMessage callback we set up in useEffect,
        // which handles both local state update (optimistic) and sync.
        // We just need to call it.
        await chatService.sendMessage(text, media, replyTo);
    }, []);

    const login = async (username: string, password: string): Promise<boolean> => {
        const normalizedUser = username.toLowerCase();
        const normalizedPass = password.toLowerCase();

        if (CREDENTIALS[normalizedUser] === normalizedPass) {
            const user = USERS[normalizedUser];
            const other = normalizedUser === 'shri' ? USERS['hari'] : USERS['shri'];

            setCurrentUser(user);
            setOtherUser(other);
            await AsyncStorage.setItem('ss_current_user', normalizedUser);

            setContacts([{
                id: other.id,
                name: other.name,
                avatar: other.avatar,
                status: 'offline', // Default to offline, let socket update it
                about: other.bio || '',
                lastMessage: 'Start a conversation',
                unreadCount: 0,
            }]);

            // Force fetch immediately upon login (non-blocking)
            fetchProfileFromSupabase(normalizedUser);
            fetchCallsFromSupabase(normalizedUser);
            fetchOtherUserProfile(other.id);
            fetchStatusesFromSupabase(normalizedUser, other.id);

            return true;
        }
        return false;
    };

    // ... (Keep existing profile fetchers) ...
     const fetchProfileFromSupabase = async (userId: string) => {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .single();

            if (error) {
                console.warn('[AppContext] fetchProfile error:', error);
            }

            if (data && !error) {
                setCurrentUser(prev => prev ? {
                    ...prev,
                    name: data.name || prev.name,
                    avatar: proxySupabaseUrl(data.avatar_url) || prev.avatar,
                    bio: data.bio || prev.bio,
                    note: data.note || prev.note,
                    noteTimestamp: data.note_timestamp || prev.noteTimestamp
                } : null);
            }
        } catch (e) {
            console.warn('[AppContext] fetchProfile exception:', e);
        }
    };

    const fetchOtherUserProfile = async (userId: string) => {
        try {
            const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
            if (data) {
                // Update Memory State first
                setOtherUser(prev => prev ? { ...prev, name: data.name, avatar: proxySupabaseUrl(data.avatar_url), bio: data.bio } : null);
                setContacts(prev => prev.map(c => c.id === userId ? {
                    ...c,
                    name: data.name,
                    avatar: proxySupabaseUrl(data.avatar_url),
                    about: data.bio,
                    status: data.is_online ? 'online' : 'offline',
                    lastSeen: data.last_seen || undefined,
                } : c));

                // Then Save to Local DB
                if (offlineService) {
                    const updatedContact = {
                        id: userId,
                        name: data.name,
                        avatar: proxySupabaseUrl(data.avatar_url),
                        about: data.bio,
                        status: data.is_online ? 'online' as const : 'offline' as const,
                        lastSeen: data.last_seen || undefined,
                        unreadCount: 0,
                        lastMessage: ''
                    };
                    offlineService.saveContact(updatedContact).catch(e => console.warn('[AppContext] saveContact err:', e));
                }
            }
        } catch (e) {
            console.warn('[AppContext] fetchOtherUserProfile error:', e);
        }
    };

    const logout = async () => {
        const cleanup = [];
        if (currentUser) {
            cleanup.push(updatePresenceInSupabase(currentUser.id, false));
        }
        if (presenceChannelRef.current) {
            cleanup.push(presenceChannelRef.current.untrack());
            supabase.removeChannel(presenceChannelRef.current);
            presenceChannelRef.current = null;
        }
        
        await Promise.all(cleanup);
        setCurrentUser(null);
        setOtherUser(null);
        setContacts([]);
        await AsyncStorage.removeItem('ss_current_user');
    };

    // ... (Keep Music Functions) ...
    const sendTyping = useCallback((isTyping: boolean) => {
        if (!currentUser || !otherUser) return;
        presenceChannelRef.current?.send({
            type: 'broadcast',
            event: isTyping ? 'typing' : 'stop-typing',
            payload: { userId: currentUser.id },
        });
    }, [currentUser, otherUser]);

    const playSong = async (song: Song, broadcast = true) => {
        try {
            if (!song.url || song.url.trim() === '') return;

            // Ensure audio session is in media playback mode (not call/recording mode).
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                shouldDuckAndroid: true,
                playThroughEarpieceAndroid: false,
            });

            if (soundRef.current) {
                try { await soundRef.current.unloadAsync(); } catch (e) {}
            }
            const { sound: newSound, status } = await Audio.Sound.createAsync(
                { uri: song.url },
                { shouldPlay: true, volume: 1.0, progressUpdateIntervalMillis: 500 },
                (playbackStatus) => {
                    if (!playbackStatus.isLoaded) return;

                    // Keep UI in sync with actual player state.
                    setMusicState(prev => ({ ...prev, isPlaying: playbackStatus.isPlaying }));

                    if (playbackStatus.didJustFinish) {
                        setMusicState(prev => ({ ...prev, isPlaying: false }));
                        if (broadcast) {
                            musicSyncService.broadcastUpdate({
                                currentSong: song,
                                isPlaying: false,
                                updatedBy: currentUser?.id || ''
                            });
                        }
                    }
                }
            );
            if (!status.isLoaded) return;

            // Explicit play to avoid edge cases where shouldPlay state is stale.
            await Promise.all([
                newSound.setIsMutedAsync(false),
                newSound.setVolumeAsync(1.0),
                newSound.playAsync()
            ]);

            setSound(newSound);
            setMusicState(prev => ({ ...prev, currentSong: song, isPlaying: true }));

            // Save last played song
            if (currentUser) {
                AsyncStorage.setItem(`ss_last_song_${currentUser.id}`, JSON.stringify(song));
            }

            if (broadcast) {
                musicSyncService.broadcastUpdate({
                    currentSong: song,
                    isPlaying: true,
                    position: 0,
                    updatedBy: currentUser?.id || ''
                });
            }
        } catch (e) {
            console.error('[Music] playSong failed:', e);
            setMusicState(prev => ({ ...prev, isPlaying: false }));
        }
    };

    const togglePlayMusic = async () => {
        // Recover player if state says we have a song but sound instance was lost.
        if (!soundRef.current) {
            if (musicState.currentSong) {
                await playSong(musicState.currentSong, false);
            }
            return;
        }
        // Keep output on normal media route (avoid stale call/recording route).
        await Audio.setAudioModeAsync({
            allowsRecordingIOS: false,
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            shouldDuckAndroid: true,
            playThroughEarpieceAndroid: false,
        });
        const newIsPlaying = !musicState.isPlaying;
        let currentPos = 0;
        try {
            const status = await soundRef.current.getStatusAsync();
            if (status.isLoaded) currentPos = status.positionMillis;
        } catch (e) {}

        if (newIsPlaying) {
            await Promise.all([
                soundRef.current.setIsMutedAsync(false),
                soundRef.current.setVolumeAsync(1.0),
                soundRef.current.playAsync()
            ]);
        }
        else await soundRef.current.pauseAsync();

        setMusicState(prev => ({ ...prev, isPlaying: newIsPlaying }));

        if (musicState.currentSong) {
            musicSyncService.broadcastUpdate({
                currentSong: musicState.currentSong,
                isPlaying: newIsPlaying,
                position: currentPos,
                updatedBy: currentUser?.id || ''
            });
        }
    };

    const toggleFavoriteSong = async (song: Song) => {
        if (!currentUser) return;
        setMusicState(prev => {
            const isFav = prev.favorites.some(s => s.id === song.id);
            const newFavs = isFav ? prev.favorites.filter(s => s.id !== song.id) : [...prev.favorites, song];
            const syncDb = async () => {
                try {
                    if (isFav) {
                        await supabase.from('favorites').delete().eq('user_id', currentUser.id).eq('song_id', song.id);
                    } else {
                        await supabase.from('favorites').insert({ user_id: currentUser.id, song_id: song.id, song_data: song });
                    }
                } catch (e) {}
            };
            syncDb();
            return { ...prev, favorites: newFavs };
        });
    };

    const seekTo = async (position: number) => {
        if (!soundRef.current || isSeekingRef.current) return;
        try {
            isSeekingRef.current = true;
            const status = await soundRef.current.getStatusAsync();
            if (!status.isLoaded) return;

            await soundRef.current.setPositionAsync(Math.max(0, position));

            if (musicState.currentSong) {
                musicSyncService.broadcastUpdate({
                    currentSong: musicState.currentSong,
                    isPlaying: musicState.isPlaying,
                    position: Math.max(0, position),
                    updatedBy: currentUser?.id || ''
                });
            }
        } catch (e: any) {
            const message = String(e?.message || e || '');
            if (!message.toLowerCase().includes('seeking interrupted')) {
                console.warn('[Music] seekTo failed:', e);
            }
        }
        isSeekingRef.current = false;
    };

    const getPlaybackPosition = async (): Promise<number> => {
        try {
            if (soundRef.current) {
                const status = await soundRef.current.getStatusAsync();
                if (status.isLoaded) return status.positionMillis;
            }
        } catch (e) {
            // Ignore transient player state errors during rapid song switch/seek.
        }
        return 0;
    };

    // ... (Keep existing message helpers) ...
    const addMessage = (chatId: string, text: string, sender: 'me' | 'them', media?: Message['media']) => {
        const messageId = Date.now().toString();
        const newMessage: Message = {
            id: messageId,
            sender,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            status: sender === 'me' ? 'sent' : undefined,
            media,
        };
        setMessages((prev) => {
            const newChatMessages = [...(prev[chatId] || []), newMessage];
            setContacts(prevContacts => prevContacts.map(c =>
                c.id === chatId ? {
                    ...c,
                    lastMessage: media ? (media.type === 'image' ? '胴 Photo' : `梼 ${media.name}`) : text,
                    unreadCount: sender === 'them' ? (c.unreadCount || 0) + 1 : 0
                } : c
            ));
            return { ...prev, [chatId]: newChatMessages };
        });
        return messageId;
    };

    const updateMessage = (chatId: string, messageId: string, text: string) => {
        setMessages((prev) => {
            const chatMessages = prev[chatId] || [];
            return { ...prev, [chatId]: chatMessages.map((msg) => msg.id === messageId ? { ...msg, text } : msg) };
        });
    };

    const updateMessageStatus = (chatId: string, messageId: string, status: 'sent' | 'delivered' | 'read') => {
        setMessages((prev) => {
            const chatMessages = prev[chatId] || [];
            return { ...prev, [chatId]: chatMessages.map((msg) => msg.id === messageId ? { ...msg, status } : msg) };
        });
    };

    const deleteMessage = async (chatId: string, messageId: string) => {
        setMessages((prev) => {
            const chatMessages = prev[chatId] || [];
            const filteredMessages = chatMessages.filter(m => m.id !== messageId);
            const lastMsg = filteredMessages[filteredMessages.length - 1];
            setContacts(prevContacts => prevContacts.map(c =>
                c.id === chatId ? {
                    ...c,
                    lastMessage: lastMsg ? (lastMsg.media ? '📎 Attachment' : lastMsg.text) : ''
                } : c
            ));
            return { ...prev, [chatId]: filteredMessages };
        });

        if (offlineService) {
            await offlineService.deleteMessage(messageId);
        }

        try {
            await supabase.from('messages').delete().eq('id', messageId);
        } catch (error) {
            console.error('Error deleting message from server:', error);
        }
    };

    const addReaction = (chatId: string, messageId: string, emoji: string) => {
        let nextReactionValue: string | null = null;

        setMessages((prev) => {
            const chatMessages = prev[chatId] || [];
            return {
                ...prev,
                [chatId]: chatMessages.map((msg) => {
                    if (msg.id === messageId) {
                        const reactions = msg.reactions || [];
                        const isSame = reactions.includes(emoji);
                        const newReactions = isSame ? [] : [emoji];
                        nextReactionValue = newReactions[0] ?? null;
                        return { ...msg, reactions: newReactions };
                    }
                    return msg;
                })
            };
        });

        (async () => {
            if (offlineService) {
                try {
                    await offlineService.updateReaction(messageId, nextReactionValue);
                } catch (e) {
                    console.warn('[AppContext] Local reaction persistence error:', e);
                }
            }

            try {
                const { error } = await supabase
                    .from('messages')
                    .update({ reaction: nextReactionValue })
                    .eq('id', messageId);
                if (error) {
                    console.warn('[AppContext] Failed to persist reaction:', error);
                }
            } catch (e) {
                console.warn('[AppContext] Reaction persistence error:', e);
            }
        })();
    };

    // --- CALL LOGIC ---
    const addCall = async (call: Omit<CallLog, 'id'>) => {
        if (currentUser) {
            try {
                const isOutgoing = call.type === 'outgoing';
                const callerId = isOutgoing ? currentUser.id : call.contactId;
                const calleeId = isOutgoing ? call.contactId : currentUser.id;
                
                // Add to Local state immediately for speed
                const tempId = Date.now().toString();
                const newLog: CallLog = { ...call, id: tempId };
                setCalls(prev => [newLog, ...prev]);

                const insertPayload = {
                    caller_id: callerId,
                    callee_id: calleeId,
                    call_type: call.callType,
                    status: call.status || 'completed',
                    duration: call.duration || 0,
                    created_at: new Date().toISOString()
                };
                console.log("[AppContext] Inserting call log:", insertPayload);

                const { error } = await supabase.from('call_logs').insert(insertPayload);
                
                if (error) console.warn("Supabase insert call log error:", error);
                else console.log("Call log inserted successfully");
            } catch (e) { console.warn('Failed to save call to DB (Non-fatal):', e); }
        }
    };

    const activeCallRef = useRef<ActiveCall | null>(null);
    const contactsRef = useRef<Contact[]>([]);
    const currentUserRef = useRef<User | null>(null);
    const otherUserRef = useRef<User | null>(null);

    useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);
    useEffect(() => { contactsRef.current = contacts; }, [contacts]);
    useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
    useEffect(() => { otherUserRef.current = otherUser; }, [otherUser]);

    // Outgoing Call Timeout (1 Minute) - WhatsApp style
    useEffect(() => {
        let timer: any;
        if (activeCall && !activeCall.isAccepted && !activeCall.isIncoming) {
            timer = setTimeout(() => {
                console.log('[AppContext] Call timeout reached (60s). Ending call.');
                endCall();
            }, 60000); 
        }
        return () => {
             if (timer) clearTimeout(timer);
        };
    }, [activeCall?.callId, activeCall?.isAccepted]);

    useEffect(() => {
        notificationService.initialize(async (actionIdentifier, payload, userText) => {
            const authUser = currentUserRef.current;
            if (!authUser) return;

            if (payload.type === 'message') {
                if (actionIdentifier === NOTIF_ACTION_REPLY_MESSAGE && userText?.trim()) {
                    sendChatMessage(payload.chatId, userText.trim());
                }
                if (actionIdentifier === NOTIF_ACTION_MARK_READ) {
                    setContacts(prev => prev.map(c =>
                        c.id === payload.chatId ? { ...c, unreadCount: 0 } : c
                    ));
                }
                return;
            }

            if (payload.type === 'call') {
                const caller = contactsRef.current.find(c => c.id === payload.callerId);
                const signal: CallSignal = {
                    type: 'call-request',
                    callId: payload.callId,
                    callerId: payload.callerId,
                    calleeId: authUser.id,
                    callType: payload.callType,
                    timestamp: new Date().toISOString(),
                    roomId: payload.callId
                };

                if (actionIdentifier === NOTIF_ACTION_ACCEPT_CALL) {
                    setActiveCall({
                        callId: payload.callId,
                        contactId: payload.callerId,
                        type: payload.callType,
                        isMinimized: false,
                        isMuted: false,
                        isVideoOff: false,
                        isIncoming: true,
                        isAccepted: true,
                        isRinging: false,
                        startTime: Date.now(),
                        callerName: caller?.name || payload.callerName,
                        callerAvatar: caller?.avatar
                    });
                    await callService.acceptCall(signal);
                }

                if (actionIdentifier === NOTIF_ACTION_REJECT_CALL) {
                    await callService.rejectCall(signal);
                    addCall({
                        contactId: payload.callerId,
                        contactName: caller?.name || payload.callerName,
                        avatar: caller?.avatar || '',
                        type: 'incoming',
                        status: 'rejected',
                        callType: payload.callType,
                        time: 'Just now'
                    });
                }

                await notificationService.dismissCallNotification(payload.callId);
            }
        });

        return () => {
            notificationService.cleanup();
        };
    }, [sendChatMessage, addCall]);

    useEffect(() => {
        if (currentUser) {
            callService.initialize(currentUser.id);
            backgroundSyncService.register();

            // ── Initialize Native Call Bridge (CallKit / ConnectionService) ──
            nativeCallBridge.initialize(currentUser.id, {
                onCallAnswered: (callId, payload) => {
                    console.log('[AppContext] Native call answered:', callId);
                    const caller = contactsRef.current.find((c: Contact) => c.id === payload.callerId);
                    setActiveCall({
                        callId: payload.callId,
                        contactId: payload.callerId,
                        type: payload.callType,
                        isMinimized: false,
                        isMuted: false,
                        isVideoOff: false,
                        isIncoming: true,
                        isAccepted: true,
                        isRinging: false,
                        startTime: Date.now(),
                        callerName: caller?.name || payload.callerName || 'Unknown',
                        callerAvatar: caller?.avatar,
                    });
                },
                onCallDeclined: (callId) => {
                    console.log('[AppContext] Native call declined:', callId);
                    setActiveCall(null);
                },
                onCallConnected: (callId) => {
                    console.log('[AppContext] Native call connected:', callId);
                    nativeCallService.reportCallConnected(callId);
                },
                onCallEnded: (callId) => {
                    console.log('[AppContext] Native call ended callback:', callId);
                    if (__DEV__ && Platform.OS === 'ios') {
                        console.log('[AppContext] 🛡️ Dev mode: Ignoring native "end" callback to prevent UI cutoff');
                        return;
                    }
                    setActiveCall(null);
                },
                onMuteToggled: (muted) => {
                    setActiveCall(prev => prev ? { ...prev, isMuted: muted } : null);
                },
            }).catch(err => console.warn('[AppContext] NativeCallBridge init failed (non-fatal):', err));

            const handleSignal = async (signal: CallSignal) => {
                const currentActiveCall = activeCallRef.current;
                const currentContacts = contactsRef.current;
                const currentAuthUser = currentUserRef.current;

                console.log('AppContext received signal:', signal.type);

                switch (signal.type) {
                    case 'call-request':
                        if (currentActiveCall) {
                            console.log('Busy: ignored call request');
                        } else {
                            if (signal.callerId !== currentAuthUser?.id) {
                                const caller = currentContacts.find((c: Contact) => c.id === signal.callerId);
                                setActiveCall({
                                    callId: signal.callId,
                                    contactId: signal.callerId,
                                    type: signal.callType,
                                    isMinimized: false,
                                    isMuted: false,
                                    isVideoOff: false,
                                    isIncoming: true,
                                    isAccepted: false,
                                    isRinging: false,
                                    callerName: caller?.name || "Unknown User",
                                    callerAvatar: caller?.avatar
                                });
                                // PREFETCH AVATAR FOR SMOOTH TRANSITION
                                if (caller?.avatar) {
                                    try { (Image as any).prefetch(caller.avatar); } catch (e) {}
                                }

                                // Show native CallKit/ConnectionService UI (for lock screen / killed state)
                                if (nativeCallService.isAvailable() && (Platform.OS !== 'ios' || !__DEV__)) {
                                    nativeCallService.displayIncomingCall({
                                        callId: signal.callId,
                                        callerId: signal.callerId,
                                        callerName: caller?.name || "Unknown User",
                                        callType: signal.callType,
                                        roomId: signal.roomId || signal.callId,
                                    });
                                } else if (__DEV__) {
                                    console.log('[AppContext] Simulator/Dev mode: Triggering local notification fallback');
                                    notificationService.showIncomingCall({
                                        callId: signal.callId,
                                        callerId: signal.callerId,
                                        callerName: caller?.name || "Unknown User",
                                        callType: signal.callType,
                                    });
                                }

                                // Also show the in-app notification (for foreground state)
                                notificationService.showIncomingCall({
                                    callId: signal.callId,
                                    callerId: signal.callerId,
                                    callerName: caller?.name || "Unknown User",
                                    callType: signal.callType
                                });
                                callService.notifyRinging(signal.roomId || signal.callId, signal.callerId, signal.callType);
                                // The native call UI (displayIncomingCall) will play the system ringtone.
                                // We no longer play a custom MP3 here to avoid double ringing.
                            }
                        }
                        break;
                    case 'call-ringing' as any:
                        if (currentActiveCall && !currentActiveCall.isIncoming) {
                            setActiveCall(prev => prev ? { ...prev, isRinging: true } : null);
                            // Play ringing sound when callee is ringing
                            soundService.playRinging();
                        }
                        break;
                    case 'call-accept':
                        if (currentActiveCall && !currentActiveCall.isIncoming) {
                            setActiveCall(prev => prev ? { ...prev, isAccepted: true, isRinging: false, startTime: Date.now() } : null);
                            const { webRTCService } = require('../services/WebRTCService');
                            await webRTCService.onCallAccepted();
                            // Report connected to native UI
                            nativeCallBridge.reportCallConnected(signal.callId);
                            // Stop sound when accepted
                            soundService.stopAll();
                        }
                        await notificationService.dismissCallNotification(signal.callId);
                        break;
                    case 'call-reject':
                        if (currentActiveCall) {
                            const { webRTCService } = require('../services/WebRTCService');
                            webRTCService.endCall();
                            setActiveCall(null);
                            // End native call UI
                            nativeCallBridge.reportCallEnded(signal.callId);
                        }
                        await notificationService.dismissCallNotification(signal.callId);
                        break;
                    case 'ice-candidate':
                    case 'offer':
                    case 'answer':
                        const { webRTCService } = require('../services/WebRTCService');
                        await webRTCService.handleSignal(signal);
                        break;
                    case 'call-end':
                        const { webRTCService: wrtc } = require('../services/WebRTCService');
                        wrtc.endCall();
                        setActiveCall(null);
                        // Stop any sound and play call end
                        soundService.playCallEnd();
                        // End native call UI
                        nativeCallBridge.reportCallEnded(signal.callId);
                        await notificationService.dismissCallNotification(signal.callId);
                        break;
                }
            };
            callService.addListener(handleSignal);
            return () => {
                callService.removeListener(handleSignal);
                nativeCallBridge.cleanup();
            };
        }
    }, [currentUser]);

    const startCall = async (contactId: string, type: 'audio' | 'video') => {
        const contact = contacts.find(c => c.id === contactId);
        const callId = await callService.initiateCall(contactId, type);

        setActiveCall({
            callId: callId || undefined,
            contactId,
            type,
            isMinimized: false,
            isMuted: false,
            isVideoOff: false,
            isIncoming: false,
            isAccepted: false,
            callerName: contact?.name,
            callerAvatar: contact?.avatar
        });

        if (callId) {
            // ── Push Poke to Callee ──
            nativeCallBridge.sendCallPush(
                contactId, 
                callId, 
                currentUser?.name || "Someone", 
                type
            ).catch(e => console.warn('[AppContext] startCall: Push trigger failed:', e));

            // Play dialing sound
            soundService.playDialing();

            // Report outgoing call to native system
            if (Platform.OS !== 'ios' || !__DEV__) { 
                // In iOS Simulator, CallKit can be flaky for outgoing calls
                nativeCallBridge.reportOutgoingCall(callId, contact?.name || 'Unknown', type);
            } else {
                console.log('[AppContext] Skipping native outgoing call report for Simulator/Dev mode');
            }
        }

        // PREFETCH AVATAR FOR SMOOTH TRANSITION
        if (contact?.avatar) {
            try { (Image as any).prefetch(contact.avatar); } catch (e) {}
        }

        router.push('/call');
    };

    const acceptCall = async () => {
        if (activeCall && activeCall.isIncoming && activeCall.callId) {
            setActiveCall(prev => prev ? { ...prev, isAccepted: true, isRinging: false, startTime: Date.now() } : null);
            const signal: CallSignal = {
                type: 'call-accept',
                callId: activeCall.callId || '',
                callerId: activeCall.contactId,
                calleeId: currentUser!.id,
                callType: activeCall.type,
                timestamp: new Date().toISOString(),
                roomId: activeCall.callId
            };
            await callService.acceptCall(signal);
            await notificationService.dismissCallNotification(activeCall.callId);
            // Stop sound when accepting
            soundService.stopAll();
        }
    };

    const rejectCall = async () => {
        if (activeCall && activeCall.isIncoming && activeCall.callId) {
            const signal: CallSignal = {
                type: 'call-reject',
                callId: activeCall.callId || '',
                callerId: activeCall.contactId,
                calleeId: currentUser!.id,
                callType: activeCall.type,
                timestamp: new Date().toISOString(),
                roomId: activeCall.callId
            };
            callService.rejectCall(signal).catch(console.warn);
            notificationService.dismissCallNotification(activeCall.callId).catch(console.warn);
            
            // Log rejection
            const contact = contacts.find(c => c.id === activeCall.contactId);
            addCall({
                contactId: activeCall.contactId,
                contactName: contact?.name || 'Unknown',
                avatar: contact?.avatar || '',
                type: 'incoming',
                status: 'rejected',
                callType: activeCall.type,
                time: 'Just now'
            });

            // Stop sound
            soundService.stopAll();

            try {
                const { webRTCService } = require('../services/WebRTCService');
                webRTCService.endCall();
            } catch (e) {}
            // Play call end sound
            soundService.playCallEnd();
            setActiveCall(null);
        }
    };

    const endCall = async () => {
        if (activeCall) {
            if (activeCall.isIncoming && !activeCall.isAccepted) {
                rejectCall().catch(console.warn);
                return;
            }
            if (currentUser && activeCall.contactId) {
                // Don't await network call so UI updates instantly
                callService.endCall().catch(console.warn);
            }
            
            // Log completion
            const contact = contacts.find(c => c.id === activeCall.contactId);
            addCall({
                contactId: activeCall.contactId,
                contactName: contact?.name || 'Unknown',
                avatar: contact?.avatar || '',
                type: activeCall.isIncoming ? 'incoming' : 'outgoing',
                status: 'completed',
                callType: activeCall.type,
                time: 'Just now',
            });

            const { webRTCService } = require('../services/WebRTCService');
            // Cleanup webRTC locally
            webRTCService.endCall();
            
            // Set active call to null immediately to trigger UI unmount smoothly
            setActiveCall(null);
            
            // End native call UI
            if (activeCall.callId) {
                nativeCallBridge.reportCallEnded(activeCall.callId);
                notificationService.dismissCallNotification(activeCall.callId).catch(console.warn);
            }
        }
    };

    const toggleMinimizeCall = (val: boolean) => {
        setActiveCall(prev => prev ? { ...prev, isMinimized: val } : null);
    };

    const toggleMute = () => {
        const isMuted = webRTCService.toggleMute();
        setActiveCall(prev => prev ? { ...prev, isMuted } : null);
    };

    // --- STATUS LOGIC ---
    const addStatus = async (status: Omit<StatusUpdate, 'id' | 'likes' | 'views'> & { localUri?: string }) => {
        const tempId = Date.now().toString();
        const newStatus = {
            ...status,
            id: tempId,
            // Use local file URI for immediate display on poster's device
            mediaUrl: status.localUri || status.mediaUrl,
            likes: [],
            views: []
        } as StatusUpdate;
        setStatuses((prev) => [newStatus, ...prev]);

        if (!currentUser) {
            console.error('No current user found when adding status');
            return;
        }
        
        try {
            // 1. Save immediately to Local SQLite DB
            await offlineService.saveStatus({
                id: tempId,
                userId: currentUser.id,
                type: (status.mediaType === 'video' ? 'video' : 'image') as any,
                localPath: status.localUri || status.mediaUrl,
                textContent: status.caption,
                createdAt: Date.now(),
                expiresAt: new Date(status.expiresAt).getTime(),
                isMine: true
            });

            // 2. Upload Media (Fallback until R2 Service is fully built in Task 2)
            let finalMediaUrl = status.mediaUrl;
            if (status.localUri && status.localUri.startsWith('file://')) {
                // Track in pending_sync queue
                await offlineService.addSyncAction('UPLOAD_STATUS_MEDIA', {
                    id: Date.now().toString(),
                    messageId: `status_${tempId}`,
                    localPath: status.localUri
                });
                
                const uploaded = await storageService.uploadImage(status.localUri, 'status-media', currentUser.id);
                if (uploaded) {
                    finalMediaUrl = uploaded;
                    // Update Local SQLite with remote URL
                    await offlineService.saveStatus({
                        id: tempId,
                        userId: currentUser.id,
                        type: (status.mediaType === 'video' ? 'video' : 'image') as any,
                        localPath: status.localUri,
                        r2Key: finalMediaUrl, // Treat Supabase URL as r2_key for now until migration
                        textContent: status.caption,
                        createdAt: Date.now(),
                        expiresAt: new Date(status.expiresAt).getTime(),
                        isMine: true
                    });
                }
            }

            // 3. Save metadata to ephemeral Supabase statuses table via Node Server (for real-time broadcast)
            const statusPayload = {
                id: tempId,
                userId: currentUser.id,
                userName: currentUser.name,
                userAvatar: currentUser.avatar,
                mediaUrl: finalMediaUrl,
                mediaType: status.mediaType,
                caption: status.caption,
                expiresAt: status.expiresAt,
                createdAt: new Date().toISOString(),
                likes: [],
                views: [],
                music: status.music || null
            };

            const response = await fetch(`${SERVER_URL}/api/status/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: statusPayload })
            });
            
            if (!response.ok) {
                console.warn('Node server status create failed, falling back to direct Supabase');
                // Fallback to direct Supabase if Node server is down
                const { error: fallbackError } = await supabase.from('statuses').insert({
                    id: tempId,
                    user_id: currentUser.id,
                    user_name: currentUser.name,
                    user_avatar: currentUser.avatar,
                    media_url: finalMediaUrl,
                    media_type: status.mediaType,
                    caption: status.caption,
                    likes: [],
                    views: [],
                    music: statusPayload.music,
                    created_at: statusPayload.createdAt,
                    expires_at: status.expiresAt,
                });
                
                if (fallbackError) {
                    throw new Error(`Fallback insert failed: ${fallbackError.message}`);
                }
            }
            
            // Note: error was from a removed line, so we remove the check
            
        } catch (e) { 
            console.warn('Failed to save status to DB:', e);
            Alert.alert('Offline Mode', 'Status saved locally. Will sync when online.');
        }
    };

    const deleteStatus = async (statusId: string) => {
        setStatuses((prev) => prev.filter((s) => s.id !== statusId));
        try {
            await offlineService.deleteStatus(statusId);
        } catch (e) {
            console.warn('Local status delete error:', e);
        }
        if (currentUser) {
            try {
                await supabase.from('statuses').delete().eq('id', statusId).eq('user_id', currentUser.id);
            } catch (e) { console.warn('Failed to delete status from DB (Non-fatal):', e); }
        }
    };

    const setTheme = (newTheme: ThemeName) => setThemeState(newTheme);

    const addStatusView = async (statusId: string) => {
        if (!currentUser) return;
        const status = statuses.find(s => s.id === statusId);
        if (!status || status.views?.includes(currentUser.id)) return;

        const ownerId = status.userId;
        const updatedViews = [...(status.views || []), currentUser.id];
        
        // 1. Optimistic update
        setStatuses(prev => prev.map(s =>
            s.id === statusId ? { ...s, views: updatedViews } : s
        ));

        // 2. Server broadcast
        try {
            await fetch(`${SERVER_URL}/api/status/view`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ statusId, viewerId: currentUser.id, ownerId })
            });
        } catch (e) {
            console.warn('Failed to broadcast status view:', e);
        }

        // 3. Local DB update
        try {
            await offlineService.markStatusAsSeen(statusId);
        } catch (e) { console.warn('Failed to update status views locally:', e); }

        // 4. Supabase fallback update if online
        if (isCloudConnected && supabase) {
            try {
                // Ensure we use the correct array append logic if supported or just update the whole array
                await supabase.from('statuses').update({ views: updatedViews }).eq('id', statusId);
            } catch (e) { console.warn('Failed to update Supabase status views:', e); }
        }
    };

    const toggleStatusLike = async (statusId: string) => {
        if (!currentUser) return;
        const status = statuses.find(s => s.id === statusId);
        if (!status) return;

        let updatedLikes;
        if (status.likes?.includes(currentUser.id)) {
            updatedLikes = status.likes.filter(id => id !== currentUser.id);
        } else {
            updatedLikes = [...(status.likes || []), currentUser.id];
        }

        // Optimistic update
        setStatuses(prev => prev.map(s =>
            s.id === statusId ? { ...s, likes: updatedLikes } : s
        ));

        // DB update
        try {
            await supabase.from('statuses').update({ likes: updatedLikes }).eq('id', statusId);
        } catch (e) { console.warn('Failed to toggle status like (Non-fatal):', e); }
    };

    const updateProfile = async (updates: { name?: string; bio?: string; avatar?: string; birthdate?: string; note?: string; noteTimestamp?: string }) => {
        if (!currentUser) return;
        const updatedUser = {
            ...currentUser,
            name: updates.name ?? currentUser.name,
            bio: updates.bio ?? currentUser.bio,
            avatar: updates.avatar ?? currentUser.avatar,
            birthdate: updates.birthdate ?? currentUser.birthdate,
            note: updates.note !== undefined ? updates.note : currentUser.note,
            noteTimestamp: updates.noteTimestamp !== undefined ? updates.noteTimestamp : currentUser.noteTimestamp,
        };
        setCurrentUser(updatedUser);
        const updatedAt = new Date().toISOString();
        try {
            const { error } = await supabase.from('profiles').upsert({
                id: currentUser.id,
                name: updatedUser.name,
                avatar_url: updatedUser.avatar,
                bio: updatedUser.bio,
                birthdate: updatedUser.birthdate,
                note: updatedUser.note,
                note_timestamp: updatedUser.noteTimestamp,
                updated_at: updatedAt,
            });
            if (error) {
                console.warn('Failed to sync profile (DB):', error);
            } else {
                await AsyncStorage.setItem(`@profile_${currentUser.id}`, JSON.stringify(updatedUser));
            }
        } catch (e) { console.warn('Failed to sync profile (Exception):', e); }
    };

    const saveNote = async (text: string) => {
        await updateProfile({ note: text, noteTimestamp: new Date().toISOString() });
    };

    const deleteNote = async () => {
        await updateProfile({ note: '', noteTimestamp: undefined });
    };

    useEffect(() => {
        const profileSubscription = supabase
            .channel('public:profiles')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
                const updatedProfile = payload.new;
                setContacts(prevContacts => prevContacts.map(contact => {
                    if (contact.id === updatedProfile.id) {
                        return { 
                            ...contact, 
                            name: updatedProfile.name || contact.name,                             avatar: updatedProfile.avatar_url || contact.avatar,
                             about: updatedProfile.bio || contact.about,
                             birthdate: updatedProfile.birthdate || contact.birthdate,
                             note: updatedProfile.note || '',
                             noteTimestamp: updatedProfile.note_timestamp || '',
                             status: updatedProfile.is_online ? 'online' : 'offline',
                             lastSeen: updatedProfile.last_seen || contact.lastSeen,
                          };
                    }
                    return contact;
                }));
            })
            .subscribe();
        return () => { supabase.removeChannel(profileSubscription); };
    }, []);

    const setBiometricEnabled = async (val: boolean) => {
        setBiometricEnabledState(val);
    };

    const setPinEnabled = async (val: boolean) => {
        setPinEnabledState(val);
    };

    const setPin = async (val: string | null) => {
        setPinState(val);
    };

    const unlockApp = () => {
        setIsLocked(false);
    };

    const updatePrivacy = async (updates: Partial<PrivacySettings>) => {
        if (!currentUser) return;
        
        const newSettings = { ...privacySettings, ...updates };
        setPrivacySettings(newSettings);
        
        try {
            await AsyncStorage.setItem(`ss_privacy_${currentUser.id}`, JSON.stringify(newSettings));
            
            // Sync with Supabase profiles table
            const { error } = await supabase
                .from('profiles')
                .update({ 
                    privacy_settings: newSettings,
                    updated_at: new Date().toISOString()
                })
                .eq('id', currentUser.id);
                
            if (error) throw error;
        } catch (e) {
            console.error('[AppContext] Failed to update privacy settings:', e);
        }
    };

    // Auto-lock logic
    useEffect(() => {
        const handleAppStateSecurity = (nextAppState: AppStateStatus) => {
            if (appStateRef.current === 'active' && (nextAppState === 'inactive' || nextAppState === 'background')) {
                // Use a small delay or check settings
                if (biometricEnabled || pinEnabled) {
                    setIsLocked(true);
                }
            }
            appStateRef.current = nextAppState;
        };

        const subscription = AppState.addEventListener('change', handleAppStateSecurity);
        return () => subscription.remove();
    }, [biometricEnabled, pinEnabled]);

    const clearChatMessages = async (partnerId: string) => {
        if (!currentUser) return;

        try {
            // 1. Identify media to delete
            const chatMsgs = messages[partnerId] || [];
            const mediaUrls = chatMsgs
                .filter(m => m.media?.url)
                .map(m => m.media!.url);

            // 2. Delete from Supabase Storage
            if (mediaUrls.length > 0) {
                // Delete from both likely buckets
                await Promise.all([
                    storageService.deleteMedia(mediaUrls, 'status-media'),
                    storageService.deleteMedia(mediaUrls, 'chat-media')
                ]);
            }

            // 3. Delete from Supabase Database
            await chatService.clearServerMessages(currentUser.id, partnerId);

            // 4. Delete from Local DB
            await offlineService.clearChat(partnerId);

            // 5. Update State
            setMessages(prev => {
                const newMessages = { ...prev };
                delete newMessages[partnerId];
                return newMessages;
            });

            setContacts(prev => prev.map(c => 
                c.id === partnerId ? { ...c, lastMessage: '', unreadCount: 0 } : c
            ));

            Alert.alert('Success', 'Chat history cleared successfully');
        } catch (e) {
            console.error('[AppContext] Clear chat failed:', e);
            Alert.alert('Error', 'Failed to clear chat history. Please try again.');
        }
    };

    return (
        <AppContext.Provider value={{
            currentUser, otherUser, isLoggedIn: !!currentUser, login, logout,
            contacts, messages, calls, statuses, theme, activeTheme: THEMES[theme], activeCall, musicState, isReady, isCloudConnected, onlineUsers,
            addMessage, updateMessage, updateMessageStatus, deleteMessage, addReaction, addCall, addStatus, deleteStatus, setTheme,
            startCall, acceptCall, endCall, toggleMinimizeCall, toggleMute, playSong, togglePlayMusic, toggleFavoriteSong,
            seekTo, getPlaybackPosition, sendChatMessage, updateProfile, addStatusView, toggleStatusLike,
            typingUsers, sendTyping,
            saveNote, deleteNote,
            clearChatMessages,
            biometricEnabled,
            pinEnabled,
            pin,
            isLocked,
            setBiometricEnabled,
            setPinEnabled,
            setPin,
            unlockApp,
            privacySettings,
            updatePrivacy,
        }}>
            {children}
        </AppContext.Provider >
    );
};

export const useApp = () => {
    const context = useContext(AppContext);
    if (!context) throw new Error('useApp must be used within an AppProvider');
    return context;
};
