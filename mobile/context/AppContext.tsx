import * as React from 'react';
// Force re-bundle: 2026-04-03T16:00:00Z (DB Migration v27)
import { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth, AuthProvider, PrivacySettings, PrivacyValue, DEFAULT_PRIVACY } from './AuthContext';
import { useChat, ChatProvider } from './ChatContext';
import { TheaterProvider } from './TheaterContext';
import { useCall, CallProvider } from './CallContext';
import { useMusic, MusicProvider, RepeatMode, MusicInvite } from './MusicContext';
import { useStatus, StatusProvider } from './StatusContext';
import { UserStatusGroup, CachedStatus, PendingUpload } from '../types';

// We'll define basic types here if they aren't easily importable, 
// but try to keep it lean.
export type ThemeName = 'midnight' | 'ocean' | 'forest' | 'sunset' | 'lavender' | 'crimson' | 'cyberpunk';

const THEME_MAP = {
    midnight: { primary: '#BC002A', accent: '#FF6A88', background: '#000', surface: '#12101A' },
    ocean: { primary: '#0EA5E9', accent: '#67E8F9', background: '#03131D', surface: '#0A2230' },
    forest: { primary: '#22C55E', accent: '#86EFAC', background: '#04120A', surface: '#102216' },
    sunset: { primary: '#F97316', accent: '#FDBA74', background: '#160904', surface: '#2A140C' },
    lavender: { primary: '#A855F7', accent: '#E9D5FF', background: '#100517', surface: '#1D0F29' },
    crimson: { primary: '#DC2626', accent: '#FCA5A5', background: '#140607', surface: '#2A1114' },
    cyberpunk: { primary: '#FACC15', accent: '#67E8F9', background: '#08080A', surface: '#18181B' },
} satisfies Record<ThemeName, { primary: string; accent: string; background: string; surface: string }>;

export const THEMES = THEME_MAP;

export const USERS: Record<string, { id: string }> = {};

interface AppContextType {
    // Auth
    currentUser: any;
    isLoggedIn: boolean;
    isReady: boolean;
    login: any;
    setSession: any;
    logout: () => Promise<void>;
    updateProfile: any;
    changeUsername: any;

    // Chat
    contacts: any[];
    messages: any;
    sendChatMessage: any;
    updateMessage: any;
    addReaction: any;
    deleteMessage: (chatId: string, messageId: string, isAdmin?: boolean, deleteForMeOnly?: boolean) => Promise<void>;
    toggleHeart: any;
    sendMediaLikePulse: any;
    remoteLikePulse: { messageId: string; mediaIndex: number; nonce: number } | null;
    clearChatMessages: any;
    sendTyping: any;
    initializeChatSession: any;
    cleanupChatSession: any;
    onlineUsers: string[];
    typingUsers: string[];
    uploadProgressTracker: Record<string, number>;
    otherUser: any | null;
    fetchOtherUserProfile: any;
    archiveContact: (partnerId: string, archive?: boolean) => Promise<void>;
    unfriendContact: (partnerId: string) => Promise<void>;
    
    // Status
    statuses: UserStatusGroup[];
    myStatuses: CachedStatus[];
    pendingStatusUploads: PendingUpload[];
    statusUploadProgress: Record<string, number>;
    isStatusSyncing: boolean;
    addStatus: (localUri: string, mediaType: 'image' | 'video', caption?: string) => Promise<void>;
    deleteStatus: (id: string, mediaKey: string) => Promise<void>;
    addStatusView: (statusId: string, viewerId: string) => Promise<void>;
    updateSoulNote: (text: string) => Promise<void>;
    refreshStatuses: () => Promise<void>;
    retryPendingStatusUploads: () => Promise<void>;

    // Call
    activeCall: any;
    calls: any[];
    startCall: any;
    acceptCall: () => Promise<void>;
    endCall: any;
    toggleMinimizeCall: (val: boolean) => void;
    toggleMute: () => void;
    toggleVideo: () => void;
    deleteCall: (id: string) => Promise<void>;
    clearCalls: () => Promise<void>;
    startGroupCall: (groupId: string, participantIds: string[], type: 'audio' | 'video') => Promise<void>;

    // Core Settings
    theme: ThemeName;
    activeTheme: { primary: string; accent: string; background: string; surface: string };
    setTheme: (theme: ThemeName) => void;
    connectivity: {
        isDeviceOnline: boolean;
        isServerReachable: boolean;
        isRealtimeConnected: boolean;
    };
    
    // Privacy
    privacySettings: PrivacySettings;
    updatePrivacy: (updates: Partial<PrivacySettings>) => Promise<void>;

    // Security
    isLocked: boolean;
    unlockApp: () => void;
    biometricEnabled: boolean;
    setBiometricEnabled: (val: boolean) => void;
    pinEnabled: boolean;
    setPinEnabled: (val: boolean) => void;
    pin: string | null;
    setPin: (pin: string | null) => void;
    refreshLocalCache: (force?: boolean) => Promise<void>;
    offlineService: any;

    // Music
    musicState: any;
    playSong: (song: any, broadcast?: boolean) => Promise<void>;
    togglePlayMusic: () => Promise<void>;
    toggleFavoriteSong: (song: any) => Promise<void>;
    seekTo: (position: number) => Promise<void>;
    getPlaybackPosition: () => Promise<number>;
    repeatMode: RepeatMode;
    toggleRepeat: () => void;
    shuffle: boolean;
    toggleShuffle: () => void;
    queue: any[];
    addToQueue: (song: any) => void;
    removeFromQueue: (songId: string) => void;
    clearQueue: () => void;
    playNext: () => Promise<void>;
    playPrevious: () => Promise<void>;
    sleepTimerMinutes: number | null;
    setSleepTimer: (minutes: number | null) => void;
    setMusicPartner: (partnerId: string) => void;
    joinGroupMusicRoom: (groupId: string) => void;
    leaveGroupMusicRoom: (groupId?: string) => Promise<void>;
    requestMusicSync: () => void;
    musicSyncScope: any;
    setIsSeeking: (seeking: boolean) => void;
    isSeeking: boolean;
    playbackOwnerChatId: string | null;
    setPlaybackOwnerChatId: (chatId: string | null) => void;
    lyrics: any[];
    lyricsLoading: boolean;
    currentLyricIndex: number;
    showLyrics: boolean;
    setShowLyrics: (v: boolean) => void;
    pendingMusicInvite: MusicInvite | null;
    acceptMusicInvite: () => Promise<void>;
    declineMusicInvite: () => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

const AppProviderInternal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const auth = useAuth();
    const chat = useChat();
    const call = useCall();
    const music = useMusic();
    const status = useStatus();

    const [theme, setThemeState] = useState<ThemeName>('midnight');
    const [connectivity, setConnectivity] = useState({
        isDeviceOnline: true,
        isServerReachable: true,
        isRealtimeConnected: true
    });
    const [isLocked, setIsLocked] = useState(false);
    const [biometricEnabled, setBiometricEnabledState] = useState(false);
    const [pinEnabled, setPinEnabledState] = useState(false);
    const [pin, setPinState] = useState<string | null>(null);
    const [privacySettings, setPrivacySettings] = useState<PrivacySettings>(DEFAULT_PRIVACY);

    // Load security & privacy settings on mount
    useEffect(() => {
        Promise.all([
            AsyncStorage.getItem('ss_biometric_enabled'),
            AsyncStorage.getItem('ss_pin_enabled'),
            AsyncStorage.getItem('ss_pin'),
            AsyncStorage.getItem('ss_privacy_settings'),
        ]).then(([bio, pinEn, pinVal, privacyVal]) => {
            if (bio === 'true') setBiometricEnabledState(true);
            if (pinEn === 'true') setPinEnabledState(true);
            if (pinVal) setPinState(pinVal);
            if (privacyVal) {
                try {
                    setPrivacySettings(JSON.parse(privacyVal));
                } catch (e) {
                    console.warn('[AppContext] Failed to parse privacy settings:', e);
                }
            }
            // Lock app on startup if any security is enabled
            if (bio === 'true' || pinEn === 'true') setIsLocked(true);
        });
    }, []);

    const updatePrivacy = useCallback(async (updates: Partial<PrivacySettings>) => {
        setPrivacySettings(prev => {
            const next = { ...prev, ...updates };
            AsyncStorage.setItem('ss_privacy_settings', JSON.stringify(next));
            return next;
        });
    }, []);

    const setBiometricEnabled = useCallback((val: boolean) => {
        setBiometricEnabledState(val);
        AsyncStorage.setItem('ss_biometric_enabled', String(val));
    }, []);

    const setPinEnabled = useCallback((val: boolean) => {
        setPinEnabledState(val);
        AsyncStorage.setItem('ss_pin_enabled', String(val));
    }, []);

    const setPin = useCallback((newPin: string | null) => {
        setPinState(newPin);
        if (newPin) {
            AsyncStorage.setItem('ss_pin', newPin);
        } else {
            AsyncStorage.removeItem('ss_pin');
        }
    }, []);

    // Signal-style: lock app when going to background
    const appStateRef = useRef(AppState.currentState);
    useEffect(() => {
        const sub = AppState.addEventListener('change', (nextState) => {
            if (appStateRef.current === 'active' && nextState.match(/inactive|background/)) {
                // Going to background — lock if security is enabled
                if (biometricEnabled || pinEnabled) {
                    setIsLocked(true);
                }
            }
            appStateRef.current = nextState;
        });
        return () => sub.remove();
    }, [biometricEnabled, pinEnabled]);

    useEffect(() => {
        AsyncStorage.getItem('ss_theme').then(t => {
            if (t) setThemeState(t as ThemeName);
        });
    }, []);

    const setTheme = useCallback((t: ThemeName) => {
        setThemeState(t);
        AsyncStorage.setItem('ss_theme', t);
    }, []);

    useEffect(() => {
        setConnectivity(chat.connectivity);
    }, [chat.connectivity]);

    const value: AppContextType = {
        // Auth
        currentUser: auth.currentUser,
        isLoggedIn: auth.isLoggedIn,
        isReady: auth.isReady,
        login: auth.login,
        setSession: auth.setSession,
        logout: auth.logout,
        updateProfile: auth.updateProfile,
        changeUsername: auth.changeUsername,

        // Chat
        contacts: chat.contacts,
        messages: chat.messages,
        sendChatMessage: chat.sendChatMessage,
        updateMessage: chat.updateMessage,
        addReaction: chat.addReaction,
        deleteMessage: chat.deleteMessage,
        toggleHeart: chat.toggleHeart,
        sendMediaLikePulse: chat.sendMediaLikePulse,
        remoteLikePulse: chat.remoteLikePulse,
        clearChatMessages: chat.clearChatMessages,
        sendTyping: chat.sendTyping,
        initializeChatSession: chat.initializeChatSession,
        cleanupChatSession: chat.cleanupChatSession,
        onlineUsers: chat.onlineUsers,
        typingUsers: chat.typingUsers,
        uploadProgressTracker: chat.uploadProgressTracker,
        otherUser: chat.otherUser,
        fetchOtherUserProfile: chat.fetchOtherUserProfile,
        archiveContact: chat.archiveContact,
        unfriendContact: chat.unfriendContact,

        // Status
        statuses: status.statusGroups,
        myStatuses: status.myStatuses,
        pendingStatusUploads: status.pendingUploads,
        statusUploadProgress: status.statusUploadProgress,
        isStatusSyncing: status.isStatusSyncing,
        addStatus: status.addStatus,
        deleteStatus: status.deleteStatus,
        addStatusView: status.viewStatus,
        updateSoulNote: status.updateSoulNote,
        refreshStatuses: status.refreshStatuses,
        retryPendingStatusUploads: status.retryPendingUploads,

        // Call
        activeCall: call.activeCall,
        calls: call.calls,
        startCall: call.startCall,
        acceptCall: call.acceptCall,
        endCall: call.endCall,
        toggleMinimizeCall: call.toggleMinimizeCall,
        toggleMute: call.toggleMute,
        toggleVideo: call.toggleVideo,
        deleteCall: call.deleteCall,
        clearCalls: call.clearCalls,
        startGroupCall: call.startGroupCall,

        // Music
        musicState: music.musicState,
        playSong: music.playSong,
        togglePlayMusic: music.togglePlayMusic,
        toggleFavoriteSong: music.toggleFavoriteSong,
        seekTo: music.seekTo,
        getPlaybackPosition: music.getPlaybackPosition,
        repeatMode: music.repeatMode,
        toggleRepeat: music.toggleRepeat,
        shuffle: music.shuffle,
        toggleShuffle: music.toggleShuffle,
        queue: music.queue,
        addToQueue: music.addToQueue,
        removeFromQueue: music.removeFromQueue,
        clearQueue: music.clearQueue,
        playNext: music.playNext,
        playPrevious: music.playPrevious,
        sleepTimerMinutes: music.sleepTimerMinutes,
        setSleepTimer: music.setSleepTimer,
        setMusicPartner: music.setMusicPartner,
        joinGroupMusicRoom: music.joinGroupMusicRoom,
        leaveGroupMusicRoom: music.leaveGroupMusicRoom,
        requestMusicSync: music.requestMusicSync,
        musicSyncScope: music.musicSyncScope,
        setIsSeeking: music.setIsSeeking,
        isSeeking: music.isSeeking,
        playbackOwnerChatId: music.playbackOwnerChatId,
        setPlaybackOwnerChatId: music.setPlaybackOwnerChatId,
        lyrics: music.lyrics,
        lyricsLoading: music.lyricsLoading,
        currentLyricIndex: music.currentLyricIndex,
        showLyrics: music.showLyrics,
        setShowLyrics: music.setShowLyrics,
        pendingMusicInvite: music.pendingMusicInvite,
        acceptMusicInvite: music.acceptMusicInvite,
        declineMusicInvite: music.declineMusicInvite,

        // Settings
        theme,
        activeTheme: THEME_MAP[theme],
        setTheme,
        connectivity,
        isLocked,
        unlockApp: () => setIsLocked(false),
        biometricEnabled,
        setBiometricEnabled,
        pinEnabled,
        setPinEnabled,
        pin,
        setPin,
        privacySettings,
        updatePrivacy,
        refreshLocalCache: chat.refreshLocalCache,
        offlineService: chat.offlineService
    };

    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <AuthProvider>
            <ChatProvider>
                <CallProvider>
                    <MusicProvider>
                        <StatusProvider>
                            <TheaterProvider>
                                <AppProviderInternal>
                                    {children}
                                </AppProviderInternal>
                            </TheaterProvider>
                        </StatusProvider>
                    </MusicProvider>
                </CallProvider>
            </ChatProvider>
        </AuthProvider>
    );
};

export const useAppContext = (): AppContextType => {
    const context = useContext(AppContext);
    
    if (context === undefined) {
        // SAFE FALLBACK: Return a dummy object to prevent crashes on Android during route transitions
        console.warn('[AppContext] useApp() called outside of AppProvider. This usually happens during rapid navigation or deep links. Providing safe fallback.');
        
        return {
            currentUser: null,
            isLoggedIn: false,
            isReady: false,
            login: () => Promise.resolve(false),
            setSession: () => Promise.resolve(),
            logout: () => Promise.resolve(),
            updateProfile: () => Promise.resolve(),
            changeUsername: () => Promise.resolve({ success: false }),
            contacts: [],
            messages: {},
            onlineUsers: [],
            typingUsers: [],
            uploadProgressTracker: {},
            otherUser: null,
            statuses: [],
            myStatuses: [],
            pendingStatusUploads: [],
            statusUploadProgress: {},
            isStatusSyncing: false,
            calls: [],
            activeCall: null,
            startGroupCall: async () => {},
            musicState: { isPlaying: false },
            theme: 'midnight',
            activeTheme: THEME_MAP['midnight'],
            setTheme: () => {},
            connectivity: { isDeviceOnline: true, isServerReachable: true, isRealtimeConnected: true },
            isLocked: false,
            unlockApp: () => {},
            biometricEnabled: false,
            setBiometricEnabled: () => {},
            pinEnabled: false,
            setPinEnabled: () => {},
            pin: null,
            setPin: () => {},
            privacySettings: DEFAULT_PRIVACY,
            updatePrivacy: async () => {},
            refreshLocalCache: async () => {},
            // Default no-ops for functions
            sendChatMessage: async () => {},
            updateMessage: async () => {},
            addReaction: async () => {},
            deleteMessage: async () => {},
            toggleHeart: async () => {},
            sendMediaLikePulse: () => {},
            remoteLikePulse: null,
            clearChatMessages: async () => {},
            sendTyping: () => {},
            initializeChatSession: () => {},
            cleanupChatSession: () => {},
            fetchOtherUserProfile: async () => {},
            archiveContact: async () => {},
            unfriendContact: async () => {},
            addStatus: async () => {},
            deleteStatus: async () => {},
            addStatusView: async () => {},
            updateSoulNote: async () => {},
            refreshStatuses: async () => {},
            retryPendingStatusUploads: async () => {},
            startCall: async () => {},
            acceptCall: async () => {},
            endCall: async () => {},
            toggleMinimizeCall: () => {},
            toggleMute: () => {},
            toggleVideo: () => {},
            deleteCall: async () => {},
            clearCalls: async () => {},
            playSong: async () => {},
            togglePlayMusic: async () => {},
            toggleFavoriteSong: async () => {},
            seekTo: async () => {},
            getPlaybackPosition: async () => 0,
            repeatMode: 'off',
            toggleRepeat: () => {},
            shuffle: false,
            toggleShuffle: () => {},
            queue: [],
            addToQueue: () => {},
            removeFromQueue: () => {},
            clearQueue: () => {},
            playNext: async () => {},
            playPrevious: async () => {},
            sleepTimerMinutes: null,
            setSleepTimer: () => {},
            setMusicPartner: () => {},
            joinGroupMusicRoom: () => {},
            leaveGroupMusicRoom: async () => {},
            requestMusicSync: () => {},
            musicSyncScope: { type: 'none' },
            playbackOwnerChatId: null,
            setPlaybackOwnerChatId: () => {},
            lyrics: [],
            lyricsLoading: false,
            currentLyricIndex: 0,
            showLyrics: false,
            setShowLyrics: () => {},
            pendingMusicInvite: null,
            acceptMusicInvite: async () => {},
            declineMusicInvite: () => {},
            offlineService: null,
        } as any;
    }
    
    return context;
};

export const useApp = useAppContext;
