import * as React from 'react';
import { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from 'react';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import { AppState, AppStateStatus, Alert, Image, Platform } from 'react-native';
import Constants from 'expo-constants';
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

import { supabase } from '../config/supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { offlineService } from '../services/LocalDBService';
import { storageService } from '../services/StorageService';
import { backgroundSyncService } from '../services/BackgroundSyncService';
import { soundService } from '../services/SoundService';
import { authService } from '../services/AuthService';
import { proxySupabaseUrl, SERVER_URL, serverFetch } from '../config/api';
import { sileo } from '../components/ui/Sileo';

if (!offlineService) {
    console.warn('[AppContext] LocalDBService failed to load. Check native modules.');
}

// Initialize WebSocket error handler early to catch reload crashes
// webSocketErrorHandler is initialized as a singleton when the module is imported

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
    note?: string; // New field for Soul Notes
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

// Fixed Users - Shri and Hari with actual Database UUIDs
const SHRI_ID = '4d28b137-66ff-4417-b451-b1a421e34b25';
const HARI_ID = '02e52f08-6c1e-497f-93f6-b29c275b8ca4';

export const USERS: Record<string, User> = {
    'shri': {
        id: SHRI_ID,
        name: 'SHRI',
        avatar: '',
        bio: '✨ Connected through the stars',
        birthdate: '2000-01-01',
    },
    'hari': {
        id: HARI_ID,
        name: 'HARI',
        avatar: '',
        bio: '🔗 Forever in sync',
        birthdate: '2000-01-01',
    },
    // Add UUID keys as well for fast reverse lookup
    [SHRI_ID]: {
        id: SHRI_ID,
        name: 'SHRI',
        avatar: '',
        bio: '✨ Connected through the stars',
        birthdate: '2000-01-01',
    },
    [HARI_ID]: {
        id: HARI_ID,
        name: 'HARI',
        avatar: '',
        bio: '🔗 Forever in sync',
        birthdate: '2000-01-01',
    },
};

// Credentials - Using username keys for login lookup
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
    setSession: (userId: string) => Promise<void>;
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
    addMessage: (chatId: string, text: string, media?: Message['media'], replyTo?: string) => Promise<void>;
    updateMessage: (chatId: string, messageId: string, updates: Partial<Message>) => Promise<void>;
    updateMessageStatus: (chatId: string, messageId: string, status: Message['status']) => Promise<void>;
    deleteMessage: (chatId: string, messageId: string) => Promise<void>;
    addReaction: (chatId: string, messageId: string, emoji: string) => Promise<void>;
    addCall: (call: Omit<CallLog, 'id'>) => Promise<void>;
    deleteCall: (id: string) => Promise<void>;
    clearCalls: () => Promise<void>;
    deleteStatus: (id: string) => Promise<void>;
    toggleStatusLike: (statusId: string) => Promise<void>;
    setTheme: (theme: ThemeName) => void;
    startCall: (contactId: string, type: 'audio' | 'video') => Promise<void>;
    acceptCall: () => Promise<void>;
    endCall: () => Promise<void>;
    toggleMinimizeCall: (val: boolean) => void;
    toggleMute: () => void;
    toggleVideo: () => void;
    playSong: (song: Song) => Promise<void>;
    togglePlayMusic: () => Promise<void>;
    toggleFavoriteSong: (song: Song) => Promise<void>;
    seekTo: (position: number) => Promise<void>;
    getPlaybackPosition: () => Promise<number>;
    sendChatMessage: (chatId: string, text: string, media?: Message['media'], replyTo?: string, localUri?: string) => Promise<void>;
    updateProfile: (updates: { name?: string; bio?: string; avatar?: string; birthdate?: string; note?: string; noteTimestamp?: string }) => Promise<void>;
    addStatusView: (statusId: string) => Promise<void>;
    sendTyping: (isTyping: boolean) => void;
    saveNote: (text: string) => Promise<void>;
    deleteNote: () => Promise<void>;
    toggleHeart: (chatId: string, messageId: string) => Promise<void>;
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

    // Upload Tracking
    uploadProgressTracker: Record<string, number>;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

interface AppProviderProps {
    children: React.ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
    // Auth State
    const [currentUser, setCurrentUser] = useState<User | null>(null);
    const [otherUser, setOtherUser] = useState<User | null>(null);

    // App State
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [messages, setMessages] = useState<Record<string, Message[]>>({});
    const messagesRef = useRef<Record<string, Message[]>>({});

    // Helper to keep both state and ref in sync synchronously
    const syncSetMessages = useCallback((updater: (prev: Record<string, Message[]>) => Record<string, Message[]>) => {
        setMessages(prev => {
            const next = updater(prev);
            messagesRef.current = next;
            return next;
        });
    }, []);
    const [calls, setCalls] = useState<CallLog[]>([]);
    const [statuses, setStatuses] = useState<StatusUpdate[]>([]);
    const [uploadProgressTracker, setUploadProgressTracker] = useState<Record<string, number>>({});
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
    const pendingViewUpdatesRef = useRef<Set<string>>(new Set());
    
    const statusesRef = useRef(statuses);
    const themeRef = useRef(theme);
    const biometricEnabledRef = useRef(biometricEnabled);
    const pinEnabledRef = useRef(pinEnabled);
    const pinRef = useRef(pin);
    const privacySettingsRef = useRef(privacySettings);
    const contactsRef = useRef(contacts);
    const currentUserRef = useRef<User | null>(null);
    const otherUserRef = useRef<User | null>(null);
    const activeCallRef = useRef<ActiveCall | null>(activeCall);

    useEffect(() => { soundRef.current = sound; }, [sound]);
    useEffect(() => { musicStateRef.current = musicState; }, [musicState]);
    // The main sync happens in syncSetMessages, this is a safety sync for background updates
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    useEffect(() => { statusesRef.current = statuses; }, [statuses]);
    useEffect(() => { themeRef.current = theme; }, [theme]);
    useEffect(() => { biometricEnabledRef.current = biometricEnabled; }, [biometricEnabled]);
    useEffect(() => { pinEnabledRef.current = pinEnabled; }, [pinEnabled]);
    useEffect(() => { pinRef.current = pin; }, [pin]);
    useEffect(() => { privacySettingsRef.current = privacySettings; }, [privacySettings]);
    useEffect(() => { contactsRef.current = contacts; }, [contacts]);
    useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
    useEffect(() => { otherUserRef.current = otherUser; }, [otherUser]);
    useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);

    // Configure Audio mode safely (especially for Simulators)
    const configureAudioMode = useCallback(async (enableRecording = false) => {
        try {
            const isSimulator = !Constants.isDevice;
            
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: enableRecording,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                shouldDuckAndroid: true,
                playThroughEarpieceAndroid: false,
                // On simulator, avoid VoiceProcessing (VPIO) which causes timeouts/crashes
                // react-native-webrtc usually handles this, but we assist it here
            });
            console.log(`[AppContext] Audio mode configured: recording=${enableRecording}`);
        } catch (e) {
            console.warn('[AppContext] Audio mode config failed:', e);
        }
    }, []);

    useEffect(() => {
        configureAudioMode(false);
    }, [configureAudioMode]);

    const updatePresenceInSupabase = useCallback(async (userId: string, isOnline: boolean) => {
        try {
            console.log(`[Presence] Updating status: ${userId} -> ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
            const timestamp = new Date().toISOString();
            
            // Update both profiles (UI matching) AND users (Auth system) tables
            const results = await Promise.all([
                supabase.from('profiles').update({
                    is_online: isOnline,
                    last_seen: timestamp,
                    updated_at: timestamp,
                }).eq('id', userId),
                supabase.from('users').update({
                   is_online: isOnline,
                   last_seen: timestamp,
                }).eq('id', userId)
            ]);

            const profileError = results[0].error;
            const userError = results[1].error;

            if (profileError) console.warn('[Presence] Profile update error:', profileError.message);
            if (userError) console.warn('[Presence] User table update error:', userError.message);
            
            if (!profileError && !userError) {
                console.log('[Presence] Status updated successfully in both tables');
            }
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
            
            // NOTE: We no longer force-offline users here because Supabase Realtime 
            // is often blocked by ISPs. We rely on the polling function below for 
            // the primary status, and only use this as a 'fast-path' for online status.
            if (onlineIds.length > 0) {
                setContacts(prev => prev.map(c => {
                    if (onlineIds.includes(c.id)) {
                        return { ...c, status: 'online' as const };
                    }
                    return c;
                }));
            }
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

    // Separate Reliable Polling Effect (Works even if Realtime is blocked)
    useEffect(() => {
        if (!currentUser) return;

        let isRunning = false; // guard against concurrent polls

        const pollOtherUserStatus = async () => {
            // Only poll when app is in foreground to avoid RCTNetworking crashes
            if (AppState.currentState !== 'active') return;
            if (isRunning) return;
            isRunning = true;

            const otherId = otherUserRef.current?.id;
            if (!otherId) { isRunning = false; return; }

            try {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('is_online, last_seen')
                    .eq('id', otherId)
                    .single();

                if (!error && data) {
                    setContacts(prev => prev.map(c => c.id === otherId ? {
                        ...c,
                        status: data.is_online ? 'online' : 'offline',
                        lastSeen: data.last_seen || c.lastSeen,
                    } : c));
                }
            } catch (_) {
            } finally {
                isRunning = false;
            }
        };

        // Poll immediately then every 30s (was 15s — reduced to ease RCTNetworking load)
        pollOtherUserStatus();
        const pollInterval = setInterval(pollOtherUserStatus, 30_000);

        return () => clearInterval(pollInterval);
    }, [currentUser?.id]);  // depend only on ID, not full object (avoids channel flap)

    // Initialize Music Sync (uses Socket.io via ChatService, not Supabase Realtime)
    useEffect(() => {
        if (currentUser) {
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
            }, otherUser?.id);
        }
        return () => musicSyncService.cleanup();
    }, [currentUser, otherUser]); 

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
                    
                    const otherId = userObj.id === SHRI_ID ? 'hari' : 'shri';
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
                            syncSetMessages(prev => ({ ...prev, [other.id]: localMessages }));
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

    // --- REAL-TIME CONNECTION NOTIFICATIONS ---
    useEffect(() => {
        if (currentUser?.id) {
            // ── Supabase Broadcast for User Signals (Requests, Notifications) ────────
            const channelName = `user_signals_${currentUser.id}`;
            const signalChannel = supabase.channel(channelName, {
                config: { broadcast: { self: false } },
            });

            signalChannel
                .on('broadcast', { event: 'connection_request' }, ({ payload }) => {
                    sileo.info({
                        title: 'New Connection Request',
                        description: `${payload.senderName || 'Someone'} wants to connect with you.`,
                        button: {
                            title: 'View Requests',
                            onClick: () => router.push('/requests')
                        }
                    });
                })
                .on('broadcast', { event: 'request_accepted' }, ({ payload }) => {
                    sileo.success({
                        title: 'Request Accepted!',
                        description: `You are now connected with ${payload.receiverName || 'someone'}.`,
                        button: {
                            title: 'Chat',
                            onClick: () => router.push(`/chat/${payload.receiverId}`)
                        }
                    });
                })
                .subscribe();

            return () => {
                signalChannel.unsubscribe();
            };
        }
    }, [currentUser?.id]);

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
                currentUser.name || 'Someone',
                (incomingMessage: ChatMessage) => {
                    const isFromMe = incomingMessage.sender_id === currentUser.id;
                    const partnerId = isFromMe ? incomingMessage.receiver_id : incomingMessage.sender_id;
                    const newMsg: Message = {
                        id: incomingMessage.id,
                        sender: isFromMe ? 'me' : 'them',
                        text: incomingMessage.text,
                        timestamp: incomingMessage.timestamp,
                        status: isFromMe ? 'sent' : 'delivered',
                        media: incomingMessage.media,
                        replyTo: incomingMessage.reply_to || undefined,
                        reactions: incomingMessage.reactions || [],
                        localFileUri: incomingMessage.localFileUri,
                    };
                    
                    addMessageSafely(partnerId, newMsg);

                    setContacts(prevContacts => prevContacts.map(c =>
                        c.id === partnerId ? {
                            ...c,
                            lastMessage: incomingMessage.media ? 'Attachment' : incomingMessage.text,
                            unreadCount: !isFromMe ? (c.unreadCount || 0) + 1 : c.unreadCount
                        } : c
                    ));

                    if (!isFromMe) {
                        soundService.playNotification();
                        // If we are NOT focused on this chat (partnerId here), show a notification
                        if (AppState.currentState !== 'active') {
                             const sender = contacts.find(c => c.id === incomingMessage.sender_id);
                             notificationService.showIncomingMessage({
                                chatId: incomingMessage.sender_id,
                                senderId: incomingMessage.sender_id,
                                senderName: sender?.name || (Object.values(USERS).find(u => u.id === incomingMessage.sender_id)?.name) || 'Someone',
                                text: incomingMessage.media ? 'Attachment' : incomingMessage.text,
                                messageId: incomingMessage.id
                            });
                        }
                    }
                },
                (messageId: string, status: ChatMessage['status'], newId?: string) => {
                    if (otherUser) {
                        syncSetMessages(prev => {
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
                (online: boolean) => {
                    setIsCloudConnected(online);
                },
                (messageId: string, progress: number) => {
                    // Update the localized upload progress state
                    setUploadProgressTracker?.(prev => ({
                       ...prev,
                       [messageId]: progress
                    }));
                }
            );

            // Initialize CallService with the same user
            callService.initialize(currentUser.id);
        }
        return () => {
            chatService.cleanup();
            callService.cleanup();
        };
    }, [currentUser, otherUser]);

    // --- REFINED DATA FETCHING ---

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

                // Map Supabase rows and resolve R2 keys in one pass (single setStatuses call)
                const mapped = data.map(mapStatusFromDB);
                const resolved = await Promise.all(
                    mapped.map(async (s) => {
                        // Resolve owner info if missing
                        if (s.contactName === 'Unknown' || !s.avatar) {
                            const owner = USERS[s.userId] || contactsRef.current.find(c => c.id === s.userId);
                            if (owner) {
                                s.contactName = owner.name;
                                s.avatar = owner.avatar;
                            }
                        }

                        if (!s.mediaUrl || s.mediaUrl.startsWith('file://') || s.mediaUrl.startsWith('data:') || s.mediaUrl.startsWith('http')) return s;
                        try {
                            const localUrl = await storageService.getMediaUrl(s.mediaUrl);
                            return localUrl ? { ...s, mediaUrl: localUrl } : s;
                        } catch { return s; }
                    })
                );
                setStatuses(resolved);
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
        syncSetMessages(prev => {
            const chatMessages = prev[partnerId] || [];
            if (chatMessages.some(m => m.id === msg.id)) return prev;
            
            // Ensure timestamp is set and sort the list
            const messageWithTimestamp = { ...msg, timestamp: msg.timestamp || new Date().toISOString() };
            const newList = [...chatMessages, messageWithTimestamp];
            return {
                ...prev,
                [partnerId]: newList.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            };
        });

        // Ensure newly observed remote messages persist to local DB
        if (offlineService && msg.sender !== 'me') {
            offlineService.saveMessage(partnerId, msg).catch(e => console.warn('saveMessage err:', e));
        }
    }, [syncSetMessages, offlineService]);

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

        // Listen for new STATUSES (Sync - UPDATE/DELETE only to avoid duplication with socket sync)
        const statusSub = supabase
            .channel('public:statuses')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'statuses' }, async (payload) => {
                const updated = payload.new;
                const updatedId = updated.id?.toString();

                // Skip echo from our own addStatusView / toggleStatusLike optimistic updates
                if (updatedId && pendingViewUpdatesRef.current.has(updatedId)) {
                    return;
                }

                setStatuses(prev => prev.map(s => {
                    if (s.id === updatedId) {
                        // Merge existing state with new DB fields to avoid dropping data
                        const mappedUpdated = mapStatusFromDB({
                            id: s.id,
                            user_id: s.userId,
                            user_name: s.contactName,
                            user_avatar: s.avatar,
                            media_url: s.mediaUrl, 
                            media_type: s.mediaType,
                            caption: s.caption,
                            created_at: s.timestamp,
                            expires_at: s.expiresAt,
                            views: s.views,
                            likes: s.likes,
                            music: s.music,
                            ...updated // Overwrite with Supabase Realtime payload
                        });

                        // Preserve local file:// URL if the server only has the R2 key
                        const finalMediaUrl = (s.mediaUrl?.startsWith('file://') && !mappedUpdated.mediaUrl?.startsWith('http')) 
                            ? s.mediaUrl 
                            : mappedUpdated.mediaUrl;
                            
                        const finalStatus = { ...mappedUpdated, mediaUrl: finalMediaUrl };

                        // Resolve R2 key in background ONLY if we don't already have a valid URL
                        if (finalMediaUrl && !finalMediaUrl.startsWith('file://') && !finalMediaUrl.startsWith('data:') && !finalMediaUrl.startsWith('http')) {
                            storageService.getMediaUrl(finalMediaUrl).then(url => {
                                if (url) setStatuses(curr => curr.map(currS => currS.id === finalStatus.id ? { ...currS, mediaUrl: url } : currS));
                            }).catch(() => {});
                        }

                        return finalStatus;
                    }
                    return s;
                }));
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'statuses' }, async (payload) => {
                setStatuses(prev => prev.filter(s => s.id !== payload.old.id.toString()));
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

                    // Play Notification Sound
                    soundService.playNotification();
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

                syncSetMessages(prev => {
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

                syncSetMessages(prev => {
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
    }, [currentUser?.id, otherUser, addMessageSafely, syncSetMessages, offlineService, setContacts]);

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

    const sendChatMessage = useCallback(async (chatId: string, text: string, media?: Message['media'], replyTo?: string, localUri?: string) => {
        // ChatService.sendMessage now triggers the onNewMessage callback we set up in useEffect,
        // which handles both local state update (optimistic) and sync.
        // We just need to call it with the explicit chatId.
        await chatService.sendMessage(chatId, text, media, replyTo, localUri);
    }, []);

    const login = useCallback(async (username: string, password: string): Promise<boolean> => {
        const normalizedUser = username.toLowerCase();
        const normalizedPass = password.toLowerCase();

        if (CREDENTIALS[normalizedUser] === normalizedPass) {
            await setSession(normalizedUser);
            return true;
        }
        return false;
    }, []);

    const setSession = useCallback(async (userId: string) => {
        let userObj = USERS[userId];
        if (!userObj) {
            userObj = { id: userId, name: userId, avatar: '', bio: '', birthdate: '' };
        }
        const otherId = userObj.id === SHRI_ID ? 'hari' : 'shri';
        const other = USERS[otherId];

        setCurrentUser(userObj);
        setOtherUser(other);
        await AsyncStorage.setItem('ss_current_user', userId);

        setContacts([{
            id: other.id,
            name: other.name,
            avatar: other.avatar,
            status: 'offline',
            about: other.bio || '',
            lastMessage: 'Start a conversation',
            unreadCount: 0,
        }]);

        // Sync with local DB
        if (offlineService) {
            offlineService.saveContact({
                id: other.id,
                name: other.name,
                avatar: other.avatar,
                status: 'offline',
                lastMessage: 'Start a conversation',
                unreadCount: 0,
                about: other.bio || '',
            }).catch(() => {});
        }

        fetchProfileFromSupabase(userObj.id);
        fetchCallsFromSupabase(userObj.id);
        fetchOtherUserProfile(other.id);
        fetchStatusesFromSupabase(userObj.id, other.id);
    }, []);

    const logout = useCallback(async () => {
        const authId = currentUserRef.current?.id;
        console.log('[AppContext] Logging out user:', authId);
        
        const cleanup = [];
        if (authId) {
            cleanup.push(updatePresenceInSupabase(authId, false));
        }
        if (presenceChannelRef.current) {
            cleanup.push(presenceChannelRef.current.untrack());
            supabase.removeChannel(presenceChannelRef.current);
            presenceChannelRef.current = null;
        }
        
        await Promise.all(cleanup);
        
        // --- CRITICAL: Clear ALL session-specific state ---
        setCurrentUser(null);
        setOtherUser(null);
        setContacts([]);
        setMessages({});
        messagesRef.current = {};
        setStatuses([]);
        setCalls([]);
        setMusicState({
            currentSong: null,
            isPlaying: false,
            favorites: []
        });
        
        // Reset audio for next user
        configureAudioMode(false);
        
        await authService.signOut();
        await AsyncStorage.removeItem('ss_current_user');
    }, [updatePresenceInSupabase, configureAudioMode]);

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


    // ... (Keep Music Functions) ...
    const sendTyping = useCallback((isTyping: boolean) => {
        if (!currentUser || !otherUser) return;
        presenceChannelRef.current?.send({
            type: 'broadcast',
            event: isTyping ? 'typing' : 'stop-typing',
            payload: { userId: currentUser.id },
        });
    }, [currentUser, otherUser]);

    const playSong = useCallback(async (song: Song, broadcast = true) => {
        try {
            if (!song.url || song.url.trim() === '') return;

            // ✅ INSTANTLY update currentSong so list highlight & header update immediately
            // Don't wait for audio to load — this is what the user clicked
            setMusicState(prev => ({ 
                ...prev, 
                currentSong: song, 
                isPlaying: false  // will become true once audio loads
            }));

            await configureAudioMode(false);

            if (soundRef.current) {
                try { await soundRef.current.unloadAsync(); } catch (e) {}
            }
            const { sound: newSound, status } = await Audio.Sound.createAsync(
                { uri: song.url },
                { shouldPlay: true, volume: 1.0, progressUpdateIntervalMillis: 1000 },
                (playbackStatus) => {
                    if (!playbackStatus.isLoaded) return;
                    
                    // Only update state if isPlaying actually changed to prevent high-frequency re-renders
                    setMusicState(prev => {
                        if (prev.isPlaying !== playbackStatus.isPlaying) {
                            return { ...prev, isPlaying: playbackStatus.isPlaying };
                        }
                        return prev;
                    });

                    if (playbackStatus.didJustFinish) {
                        setMusicState(prev => ({ ...prev, isPlaying: false }));
                        if (broadcast) {
                            musicSyncService.broadcastUpdate({
                                currentSong: song,
                                isPlaying: false
                            });
                        }
                    }
                }
            );
            if (!status.isLoaded) return;

            await Promise.all([
                newSound.setIsMutedAsync(false),
                newSound.setVolumeAsync(1.0),
                newSound.playAsync()
            ]);

            setSound(newSound);
            // Mark as playing now that audio is ready
            setMusicState(prev => ({ 
                ...prev, 
                currentSong: song,   // keep in sync (song might have changed during load)
                isPlaying: true 
            }));

            if (currentUserRef.current) {
                AsyncStorage.setItem(`ss_last_song_${currentUserRef.current.id}`, JSON.stringify(song));
            }

            if (broadcast) {
                musicSyncService.broadcastUpdate({
                    currentSong: song,
                    isPlaying: true,
                    position: 0,
                    updatedBy: currentUserRef.current?.id || ''
                });
            }
        } catch (e) {
            console.error('[Music] playSong failed:', e);
            setMusicState(prev => ({ ...prev, isPlaying: false }));
        }
    }, []);

    const togglePlayMusic = useCallback(async () => {
        if (!soundRef.current) {
            if (musicStateRef.current.currentSong) {
                await playSong(musicStateRef.current.currentSong, false);
            }
            return;
        }
        await configureAudioMode(false);
        const newIsPlaying = !musicStateRef.current.isPlaying;
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

        if (musicStateRef.current.currentSong) {
            musicSyncService.broadcastUpdate({
                currentSong: musicStateRef.current.currentSong,
                isPlaying: newIsPlaying,
                position: currentPos,
                updatedBy: currentUserRef.current?.id || ''
            });
        }
    }, [playSong]);

    const toggleFavoriteSong = useCallback(async (song: Song) => {
        if (!currentUserRef.current) return;
        const currentRef = currentUserRef.current;
        setMusicState(prev => {
            const isFav = prev.favorites.some(s => s.id === song.id);
            const newFavs = isFav ? prev.favorites.filter(s => s.id !== song.id) : [...prev.favorites, song];
            
            (async () => {
                try {
                    if (isFav) {
                        await supabase.from('favorites').delete().eq('user_id', currentRef.id).eq('song_id', song.id);
                    } else {
                        await supabase.from('favorites').insert({ user_id: currentRef.id, song_id: song.id, song_data: song });
                    }
                } catch (e) {}
            })();
            
            return { ...prev, favorites: newFavs };
        });
    }, []);

    const seekTo = useCallback(async (position: number) => {
        if (!soundRef.current || isSeekingRef.current) return;
        try {
            isSeekingRef.current = true;
            const status = await soundRef.current.getStatusAsync();
            if (!status.isLoaded) return;

            await soundRef.current.setPositionAsync(Math.max(0, position));

            if (musicStateRef.current.currentSong) {
                musicSyncService.broadcastUpdate({
                    currentSong: musicStateRef.current.currentSong,
                    isPlaying: musicStateRef.current.isPlaying,
                    position: Math.max(0, position),
                    updatedBy: currentUserRef.current?.id || ''
                });
            }
        } catch (e: any) {
            const message = String(e?.message || e || '');
            if (!message.toLowerCase().includes('seeking interrupted')) {
                console.warn('[Music] seekTo failed:', e);
            }
        }
        isSeekingRef.current = false;
    }, []);

    const getPlaybackPosition = useCallback(async (): Promise<number> => {
        try {
            if (soundRef.current) {
                const status = await soundRef.current.getStatusAsync();
                if (status.isLoaded) return status.positionMillis;
            }
        } catch (e) {}
        return 0;
    }, []);

    const addMessage = useCallback(async (chatId: string, text: string, media?: Message['media'], replyTo?: string) => {
        // Redundant UI updates removed — chatService.sendMessage handles optimistic 
        // insertion and persistence via its own onNewMessage callback correctly.
        await chatService.sendMessage(chatId, text, media, replyTo);
    }, [chatService]);

    const updateMessage = useCallback(async (chatId: string, messageId: string, updates: Partial<Message>) => {
        syncSetMessages(prev => {
            const chatMsgs = prev[chatId] || [];
            if (!chatMsgs.find(m => m.id === messageId)) return prev;
            return {
                ...prev,
                [chatId]: chatMsgs.map(m => m.id === messageId ? { ...m, ...updates } : m)
            };
        });

        if (offlineService) {
            const msg = messagesRef.current[chatId]?.find(m => m.id === messageId);
            if (msg) await offlineService.saveMessage(chatId, { ...msg, ...updates });
        }
    }, [syncSetMessages, offlineService]);

    const updateMessageStatus = useCallback(async (chatId: string, messageId: string, status: Message['status']) => {
        syncSetMessages(prev => {
            const chatMsgs = prev[chatId] || [];
            if (!chatMsgs.find(m => m.id === messageId)) return prev;
            return {
                ...prev,
                [chatId]: chatMsgs.map(m => m.id === messageId ? { ...m, status } : m)
            };
        });

        if (offlineService) {
            const msg = messagesRef.current[chatId]?.find(m => m.id === messageId);
            if (msg) await offlineService.saveMessage(chatId, { ...msg, status });
        }
    }, []);

    const deleteMessage = useCallback(async (chatId: string, messageId: string) => {
        setMessages(prev => {
            const next = { ...prev };
            next[chatId] = (next[chatId] || []).filter(m => m.id !== messageId);
            return next;
        });

        if (offlineService) {
            await offlineService.deleteMessage(messageId);
        }

        setContacts(prev => prev.map(c => {
            if (c.id === chatId) {
                const chatMsgs = (messagesRef.current[chatId] || []).filter(m => m.id !== messageId);
                const lastMsg = chatMsgs[chatMsgs.length - 1];
                return { ...c, lastMessage: lastMsg ? (lastMsg.media ? '📎 Attachment' : lastMsg.text) : '' };
            }
            return c;
        }));
        try {
            await supabase.from('messages').delete().eq('id', messageId);
        } catch {}
    }, []);

    // Guard: track recently changed reactions to prevent incoming socket events from overriding
    const recentLocalReactions = useRef<Map<string, number>>(new Map());

    const addReaction = useCallback(async (chatId: string, messageId: string, emoji: string | null, senderId?: string) => {
        const reactions = emoji ? [emoji] : [];
        const isMe = !senderId || senderId === currentUserRef.current?.id;
        
        console.log(`[AppContext] addReaction: [${emoji || 'REMOVE'}] msg=${messageId} chat=${chatId} isMe=${isMe} senderId=${senderId || 'none'}`);

        // If this is a REMOTE event, check if we recently modified this message locally
        if (senderId) {
            const lastLocal = recentLocalReactions.current.get(messageId);
            if (lastLocal && Date.now() - lastLocal < 3000) {
                console.log(`[AppContext] IGNORING remote reaction for ${messageId} — local change was <3s ago`);
                return;
            }
        }

        // --- CRITICAL FIX: Update REF instantly (synchronously) ---
        // This ensures the next immediate call (e.g. from a second double-tap)
        // sees the updated state even before React re-renders.
        const currentMsgs = messagesRef.current[chatId] || [];
        if (currentMsgs.some(m => m.id === messageId)) {
            messagesRef.current = {
                ...messagesRef.current,
                [chatId]: currentMsgs.map(m => m.id === messageId ? { ...m, reactions } : m)
            };
        }

        // Update React State
        syncSetMessages(prev => {
            const chatMsgs = prev[chatId] || [];
            if (!chatMsgs.some(m => m.id === messageId)) return prev;
            return {
                ...prev,
                [chatId]: chatMsgs.map(m => m.id === messageId ? { ...m, reactions } : m)
            };
        });

        // Only emit and persist if WE initiated the reaction (no senderId)
        if (!senderId) {
            recentLocalReactions.current.set(messageId, Date.now());
            
            // Reactions are synced via Supabase 'messages' table UPDATE

            try {
                await Promise.all([
                    offlineService.updateMessageReaction(messageId, emoji || null),
                    supabase.from('messages').update({ reaction: emoji || null }).eq('id', messageId)
                ]);
            } catch (e) {
                console.error('[AppContext] Failed to persist reaction:', e);
            }
        }
    }, [syncSetMessages]);

    const toggleHeart = useCallback(async (chatId: string, messageId: string): Promise<void> => {
        // Read directly from the ref (which we now keep 100% in sync)
        const chatMsgs = messagesRef.current[chatId] || [];
        const msg = chatMsgs.find(m => m.id === messageId);
        
        if (!msg) {
            console.log(`[AppContext] toggleHeart: Message ${messageId} not found in chat ${chatId}`);
            return;
        }

        const currentReactions = msg.reactions || [];
        // Support multiple variants of heart emojis and handle non-string values gracefully
        const heartVariants = ['❤️', '❤', '\u2764\uFE0F', '\u2764'];
        const hasHeart = currentReactions.some(r => 
            typeof r === 'string' && (heartVariants.includes(r) || r.includes('❤️') || r.includes('❤'))
        );

        const newEmoji = hasHeart ? null : '❤️';
        console.log(`[AppContext] toggleHeart logic: msg=${messageId} hasHeart=${hasHeart} -> newEmoji=${newEmoji || 'REMOVE'}`);
        
        await addReaction(chatId, messageId, newEmoji);
    }, [addReaction]);


    // --- CALL LOGIC ---
    const addCall = useCallback(async (call: Omit<CallLog, 'id'>) => {
        const authUser = currentUserRef.current;
        if (authUser) {
            try {
                const isOutgoing = call.type === 'outgoing';
                const callerId = isOutgoing ? authUser.id : call.contactId;
                const calleeId = isOutgoing ? call.contactId : authUser.id;
                
                const tempId = Date.now().toString();
                const newLog: CallLog = { ...call, id: tempId };
                setCalls(prev => [newLog, ...prev]);

                const { error } = await supabase.from('call_logs').insert({
                    caller_id: callerId,
                    callee_id: calleeId,
                    call_type: call.callType,
                    status: call.status || 'completed',
                    duration: call.duration || 0,
                    created_at: new Date().toISOString()
                });
                if (error) console.warn("Supabase insert call log error:", error);
            } catch (e) { console.warn('Failed to save call to DB:', e); }
        }
    }, []);

    const deleteCall = useCallback(async (callId: string) => {
        setCalls(prev => prev.filter(c => c.id !== callId));
        await supabase.from('call_logs').delete().eq('id', callId);
    }, []);

    const clearCalls = useCallback(async () => {
        const authId = currentUserRef.current?.id;
        if (!authId) return;
        setCalls([]);
        await supabase.from('call_logs').delete().or(`caller_id.eq.${authId},callee_id.eq.${authId}`);
    }, []);


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
                    soundService.stopAll(); // Instantly kill ringing sound
                    // Dismiss the duplicate local notification we sent in fallback if answering native
                    notificationService.dismissCallNotification(callId).catch(() => {});
                    
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

                    // Send accept signal back to caller so WebRTC handshake starts
                    const currentAuthUser = currentUserRef.current;
                    if (currentAuthUser) {
                        callService.acceptCall({
                            type: 'call-accept',
                            callId: payload.callId,
                            roomId: payload.roomId || payload.callId,
                            callerId: payload.callerId,
                            calleeId: currentAuthUser.id,
                            callType: payload.callType,
                            timestamp: new Date().toISOString()
                        }).catch(err => console.error('[AppContext] Failed to broadcast accept from native answer:', err));
                    }
                },
                onCallDeclined: (callId) => {
                    console.log('[AppContext] Native call declined:', callId);
                    notificationService.dismissCallNotification(callId).catch(() => {});
                    
                    const currentActive = activeCallRef.current;
                    const currentAuthUser = currentUserRef.current;
                    if (currentActive && currentAuthUser) {
                        callService.rejectCall({
                            type: 'call-reject',
                            callId: currentActive.callId,
                            roomId: currentActive.callId,
                            callerId: currentActive.contactId,
                            calleeId: currentAuthUser.id,
                            callType: currentActive.type,
                            timestamp: new Date().toISOString()
                        }).catch(e => console.error('[AppContext] Failed to broadcast reject from native decline:', e));
                    }
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
                                } else {
                                    // Fallback for Simulators or if Native Module is missing
                                    console.log('[AppContext] Simulator/Dev mode or No Native Module: Triggering local push notification');
                                    notificationService.showIncomingCall({
                                        callId: signal.callId,
                                        callerId: signal.callerId,
                                        callerName: caller?.name || "Unknown User",
                                        callType: signal.callType,
                                    });
                                }

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
                            const { webRTCService: wrtc } = require('../services/WebRTCService');
                            
                            // IDENTIFY ROLE IMMEDIATELY TO UNBLOCK SIGNALING
                            wrtc.setInitiator(true);
                            await wrtc.onCallAccepted();
                            
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
                    case 'video-toggle':
                        if (currentActiveCall && currentActiveCall.callId === signal.callId) {
                            setActiveCall(prev => prev ? { ...prev, remoteVideoOff: signal.payload?.isVideoOff } : null);
                        }
                        break;
                    case 'audio-toggle':
                        if (currentActiveCall && currentActiveCall.callId === signal.callId) {
                            setActiveCall(prev => prev ? { ...prev, remoteMuted: signal.payload?.isMuted } : null);
                        }
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

    const rejectCall = useCallback(async () => {
        const active = activeCallRef.current;
        if (active && active.isIncoming && active.callId) {
            const signal: CallSignal = {
                type: 'call-reject',
                callId: active.callId,
                callerId: active.contactId,
                calleeId: currentUserRef.current?.id || '',
                callType: active.type,
                timestamp: new Date().toISOString(),
                roomId: active.callId
            };
            callService.rejectCall(signal).catch(console.warn);
            notificationService.dismissCallNotification(active.callId).catch(console.warn);
            
            const contact = contactsRef.current.find(c => c.id === active.contactId);
            addCall({
                contactId: active.contactId,
                contactName: contact?.name || 'Unknown',
                avatar: contact?.avatar || '',
                type: 'incoming',
                status: 'rejected',
                callType: active.type,
                time: 'Just now'
            });

            soundService.stopAll();
            try {
                const { webRTCService } = require('../services/WebRTCService');
                webRTCService.endCall();
            } catch (e) {}
            soundService.playCallEnd();
            setActiveCall(null);
        }
    }, [addCall]);
    const startCall = useCallback(async (contactId: string, type: 'audio' | 'video') => {
        const contact = contactsRef.current.find(c => c.id === contactId);
        const currentUser = currentUserRef.current;
        const callId = await callService.initiateCall(contactId, type);

        console.log(`[AppContext] Starting call to ${contactId}, callId: ${callId}`);

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

        const { webRTCService: wrtc } = require('../services/WebRTCService');
        wrtc.setInitiator(true);

        if (callId) {
            nativeCallBridge.sendCallPush(
                contactId, 
                callId, 
                currentUserRef.current?.name || "Someone", 
                type
            ).catch(e => console.warn('[AppContext] startCall: Push trigger failed:', e));

            soundService.playDialing();

            if (Platform.OS !== 'ios' || !__DEV__) { 
                nativeCallBridge.reportOutgoingCall(callId, contact?.name || 'Unknown', type);
            }
        }

        if (contact?.avatar) {
            try { (Image as any).prefetch(contact.avatar); } catch (e) {}
        }
        router.push('/call');
    }, []);

    const acceptCall = useCallback(async () => {
        const active = activeCallRef.current;
        if (active && active.isIncoming && active.callId) {
            setActiveCall(prev => prev ? { ...prev, isAccepted: true, isRinging: false, startTime: Date.now() } : null);
            const signal: CallSignal = {
                type: 'call-accept',
                callId: active.callId,
                callerId: active.contactId,
                calleeId: currentUserRef.current?.id || '',
                callType: active.type,
                timestamp: new Date().toISOString(),
                roomId: active.callId
            };
            await callService.acceptCall(signal);
            await notificationService.dismissCallNotification(active.callId);
            soundService.stopAll();
        }
    }, []);

    const endCall = useCallback(async () => {
        const active = activeCallRef.current;
        if (active) {
            if (active.isIncoming && !active.isAccepted) {
                await rejectCall();
                return;
            }
            if (currentUserRef.current && active.contactId) {
                callService.endCall().catch(console.warn);
            }
            
            const contact = contactsRef.current.find(c => c.id === active.contactId);
            addCall({
                contactId: active.contactId,
                contactName: contact?.name || 'Unknown',
                avatar: contact?.avatar || '',
                type: active.isIncoming ? 'incoming' : 'outgoing',
                status: 'completed',
                callType: active.type,
                time: 'Just now',
            });

            const { webRTCService } = require('../services/WebRTCService');
            webRTCService.endCall();
            
            setActiveCall(null);
            
            if (active.callId) {
                nativeCallBridge.reportCallEnded(active.callId);
                notificationService.dismissCallNotification(active.callId).catch(console.warn);
            }
        }
    }, [addCall, rejectCall]);

    const toggleMinimizeCall = useCallback((val: boolean) => {
        setActiveCall(prev => prev ? { ...prev, isMinimized: val } : null);
    }, []);

    const toggleMute = useCallback(() => {
        const active = activeCallRef.current;
        const currentUserId = currentUserRef.current?.id;
        if (!active || !currentUserId) return;

        const { webRTCService } = require('../services/WebRTCService');
        const isMuted = webRTCService.toggleMute();
        setActiveCall(prev => prev ? { ...prev, isMuted } : null);

        // Sync with partner
        callService.sendSignal({
            type: 'audio-toggle',
            callId: active.callId!,
            callerId: currentUserId,
            calleeId: active.contactId,
            callType: active.type,
            payload: { isMuted },
            timestamp: new Date().toISOString()
        }).catch(err => console.warn('[AppContext] Failed to sync mute state:', err));
    }, []);

    const toggleVideo = useCallback(() => {
        const active = activeCallRef.current;
        const currentUserId = currentUserRef.current?.id;
        if (!active || !currentUserId || active.type !== 'video') return;

        const { webRTCService } = require('../services/WebRTCService');
        // webRTCService.toggleVideo returns true if the track was enabled (is now off)
        const isNowOff = webRTCService.toggleVideo();
        setActiveCall(prev => prev ? { ...prev, isVideoOff: isNowOff } : null);

        // Sync with partner
        callService.sendSignal({
            type: 'video-toggle',
            callId: active.callId!,
            callerId: currentUserId,
            calleeId: active.contactId,
            callType: active.type,
            payload: { isVideoOff: isNowOff },
            timestamp: new Date().toISOString()
        }).catch(err => console.warn('[AppContext] Failed to sync video state:', err));
    }, []);

    // --- STATUS LOGIC ---
    const addStatus = useCallback(async (status: Omit<StatusUpdate, 'id' | 'likes' | 'views'> & { localUri?: string }) => {
        const authId = currentUserRef.current?.id;
        const authName = currentUserRef.current?.name;
        const authAvatar = currentUserRef.current?.avatar;
        if (!authId) return;

        const tempId = Date.now().toString();
        const newStatus = { ...status, id: tempId, mediaUrl: status.localUri || status.mediaUrl, likes: [], views: [] } as StatusUpdate;
        setStatuses((prev) => [newStatus, ...prev]);

        try {
            await offlineService.saveStatus({
                id: tempId, userId: authId, type: (status.mediaType === 'video' ? 'video' : 'image') as any,
                localPath: status.localUri || status.mediaUrl, textContent: status.caption,
                createdAt: Date.now(), expiresAt: new Date(status.expiresAt).getTime(), isMine: true
            });

            let finalMediaUrl = status.mediaUrl;
            if (status.localUri?.startsWith('file://')) {
                const uploaded = await storageService.uploadImage(status.localUri, 'status-media', authId);
                if (uploaded) finalMediaUrl = uploaded;
            }

            await serverFetch(`${SERVER_URL}/api/status/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: { 
                    id: tempId, userId: authId, userName: authName, userAvatar: authAvatar,
                    mediaUrl: finalMediaUrl, mediaType: status.mediaType, caption: status.caption, 
                    expiresAt: status.expiresAt, createdAt: new Date().toISOString(), likes: [], views: [], music: status.music || null
                }})
            });
        } catch (e) {
            console.warn('Failed to save status:', e);
            Alert.alert('Offline Mode', 'Status saved locally. Will sync when online.');
        }
    }, []);

    const deleteStatus = useCallback(async (statusId: string) => {
        setStatuses((prev) => prev.filter((s) => s.id !== statusId));
        const authId = currentUserRef.current?.id;
        try {
            await offlineService.deleteStatus(statusId);
            if (authId) {
                await supabase.from('statuses').delete().eq('id', statusId).eq('user_id', authId);
            }
        } catch (e) { console.warn('Delete status error:', e); }
    }, []);

    const setTheme = useCallback((newTheme: ThemeName) => setThemeState(newTheme), []);

    const addStatusView = useCallback(async (statusId: string) => {
        const authId = currentUserRef.current?.id;
        if (!authId) return;
        const status = statusesRef.current.find(s => s.id === statusId);
        if (!status || (status.views || []).includes(authId)) return;

        const updatedViews = [...(status.views || []), authId];
        setStatuses(prev => prev.map(s => s.id === statusId ? { ...s, views: updatedViews } : s));

        pendingViewUpdatesRef.current.add(statusId);
        setTimeout(() => pendingViewUpdatesRef.current.delete(statusId), 5000);

        try {
            await serverFetch(`${SERVER_URL}/api/status/view`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ statusId, viewerId: authId, ownerId: status.userId })
            });
            await offlineService.markStatusAsSeen(statusId);
            if (isCloudConnected && supabase) {
                await supabase.from('statuses').update({ views: updatedViews }).eq('id', statusId);
            }
        } catch (e) { console.warn('Status view error:', e); }
    }, [isCloudConnected]);

    const toggleStatusLike = useCallback(async (statusId: string) => {
        const authId = currentUserRef.current?.id;
        if (!authId) return;
        const status = statusesRef.current.find(s => s.id === statusId);
        if (!status) return;

        const updatedLikes = (status.likes || []).includes(authId)
            ? status.likes!.filter(id => id !== authId)
            : [...(status.likes || []), authId];

        setStatuses(prev => prev.map(s => s.id === statusId ? { ...s, likes: updatedLikes } : s));

        try {
            await supabase.from('statuses').update({ likes: updatedLikes }).eq('id', statusId);
        } catch (e) { console.warn('Toggle status like error:', e); }
    }, []);

    const updateProfile = useCallback(async (updates: { name?: string; bio?: string; avatar?: string; birthdate?: string; note?: string; noteTimestamp?: string }) => {
        const authUser = currentUserRef.current;
        if (!authUser) return;
        const updatedUser = { ...authUser, ...updates };
        setCurrentUser(updatedUser);
        try {
            const { error } = await supabase.from('profiles').upsert({
                id: authUser.id,
                name: updatedUser.name,
                avatar_url: updatedUser.avatar,
                bio: updatedUser.bio,
                birthdate: updatedUser.birthdate,
                note: updatedUser.note,
                note_timestamp: updatedUser.noteTimestamp,
                updated_at: new Date().toISOString(),
            });
            if (!error) await AsyncStorage.setItem(`@profile_${authUser.id}`, JSON.stringify(updatedUser));
        } catch (e) { console.warn('Update profile error:', e); }
    }, []);

    const saveNote = useCallback(async (text: string) => {
        await updateProfile({ note: text, noteTimestamp: new Date().toISOString() });
    }, [updateProfile]);

    const deleteNote = useCallback(async () => {
        await updateProfile({ note: '', noteTimestamp: undefined });
    }, [updateProfile]);

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

    const setBiometricEnabled = useCallback(async (val: boolean) => setBiometricEnabledState(val), []);
    const setPinEnabled = useCallback(async (val: boolean) => setPinEnabledState(val), []);
    const setPin = useCallback(async (val: string | null) => setPinState(val), []);
    const unlockApp = useCallback(() => setIsLocked(false), []);

    const updatePrivacy = useCallback(async (updates: Partial<PrivacySettings>) => {
        const authId = currentUserRef.current?.id;
        if (!authId) return;
        const newSettings = { ...privacySettingsRef.current, ...updates };
        setPrivacySettings(newSettings);
        try {
            await AsyncStorage.setItem(`ss_privacy_${authId}`, JSON.stringify(newSettings));
            await supabase.from('profiles').update({ 
                privacy_settings: newSettings,
                updated_at: new Date().toISOString()
            }).eq('id', authId);
        } catch (e) { console.error('Update privacy error:', e); }
    }, []);

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

    const clearChatMessages = useCallback(async (partnerId: string) => {
        const authUser = currentUserRef.current;
        if (!authUser) return;

        try {
            const chatMsgs = (messagesRef.current[partnerId] || []);
            const mediaUrls = chatMsgs.filter(m => m.media?.url).map(m => m.media!.url);

            if (mediaUrls.length > 0) {
                await Promise.all([
                    storageService.deleteMedia(mediaUrls, 'status-media'),
                    storageService.deleteMedia(mediaUrls, 'chat-media')
                ]);
            }

            await chatService.clearServerMessages(authUser.id, partnerId);
            await offlineService.clearChat(partnerId);

            setMessages(prev => {
                const next = { ...prev };
                delete next[partnerId];
                return next;
            });

            setContacts(prev => prev.map(c => 
                c.id === partnerId ? { ...c, lastMessage: '', unreadCount: 0 } : c
            ));

            Alert.alert('Success', 'Chat history cleared successfully');
        } catch (e) {
            console.error('[AppContext] Clear chat failed:', e);
            Alert.alert('Error', 'Failed to clear chat history.');
        }
    }, []);

    const contextValue = useMemo(() => ({
        currentUser, otherUser, isLoggedIn: !!currentUser, login, setSession, logout,
        contacts, messages, calls, statuses, theme, activeTheme: THEMES[theme], activeCall, musicState, isReady, isCloudConnected, onlineUsers,
        addMessage, updateMessage, updateMessageStatus, deleteMessage, addReaction, addCall, deleteCall, clearCalls, addStatus, deleteStatus, setTheme,
        startCall, acceptCall, endCall, toggleMinimizeCall, toggleMute, toggleVideo, playSong, togglePlayMusic, toggleFavoriteSong,
        seekTo, getPlaybackPosition, sendChatMessage, updateProfile, addStatusView, toggleStatusLike,
        typingUsers, sendTyping, saveNote, deleteNote, toggleHeart, clearChatMessages,
        biometricEnabled, pinEnabled, pin, isLocked, setBiometricEnabled, setPinEnabled, setPin, unlockApp,
        privacySettings, updatePrivacy, uploadProgressTracker
    }), [
        currentUser, otherUser, contacts, messages, calls, statuses, theme, activeCall, musicState, isReady, isCloudConnected, onlineUsers,
        login, setSession, logout, addMessage, updateMessage, updateMessageStatus, deleteMessage, addReaction, addCall, deleteCall, clearCalls, addStatus, deleteStatus, setTheme,
        startCall, acceptCall, endCall, toggleMinimizeCall, toggleMute, toggleVideo, playSong, togglePlayMusic, toggleFavoriteSong,
        seekTo, getPlaybackPosition, sendChatMessage, updateProfile, addStatusView, toggleStatusLike,
        typingUsers, sendTyping, saveNote, deleteNote, toggleHeart, clearChatMessages,
        biometricEnabled, pinEnabled, pin, isLocked, setBiometricEnabled, setPinEnabled, setPin, unlockApp,
        privacySettings, updatePrivacy, uploadProgressTracker
    ]);

    return (
        <AppContext.Provider value={contextValue}>
            {children}
        </AppContext.Provider >
    );
};

export const useApp = () => {
    const context = useContext(AppContext);
    if (!context) throw new Error('useApp must be used within an AppProvider');
    return context;
};
