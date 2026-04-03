import * as React from 'react';
// Force re-bundle: 2026-04-03T16:00:00Z (DB Migration v27)
import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth, AuthProvider } from './AuthContext';
import { useChat, ChatProvider } from './ChatContext';
import { useCall, CallProvider } from './CallContext';
import { useMusic, MusicProvider } from './MusicContext';
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
    deleteMessage: any;
    toggleHeart: any;
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

    // Music
    musicState: any;
    playSong: any;
    togglePlayMusic: any;
    toggleFavoriteSong: (song: any) => Promise<void>;
    seekTo: (position: number) => Promise<void>;
    getPlaybackPosition: () => Promise<number>;

    // Core Settings
    theme: ThemeName;
    activeTheme: { primary: string; accent: string; background: string; surface: string };
    setTheme: (theme: ThemeName) => void;
    connectivity: {
        isDeviceOnline: boolean;
        isServerReachable: boolean;
        isRealtimeConnected: boolean;
    };
    
    // Security
    isLocked: boolean;
    unlockApp: () => void;
    refreshLocalCache: () => Promise<void>;
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

        // Music
        musicState: music.musicState,
        playSong: music.playSong,
        togglePlayMusic: music.togglePlayMusic,
        toggleFavoriteSong: music.toggleFavoriteSong,
        seekTo: music.seekTo,
        getPlaybackPosition: music.getPlaybackPosition,

        // Settings
        theme,
        activeTheme: THEME_MAP[theme],
        setTheme,
        connectivity,
        isLocked,
        unlockApp: () => setIsLocked(false),
        refreshLocalCache: chat.refreshLocalCache
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
                            <AppProviderInternal>
                                {children}
                            </AppProviderInternal>
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
            musicState: { isPlaying: false },
            theme: 'midnight',
            activeTheme: THEME_MAP['midnight'],
            setTheme: () => {},
            connectivity: { isDeviceOnline: true, isServerReachable: true, isRealtimeConnected: true },
            isLocked: false,
            unlockApp: () => {},
            refreshLocalCache: async () => {},
            // Default no-ops for functions
            sendChatMessage: async () => {},
            updateMessage: async () => {},
            addReaction: async () => {},
            deleteMessage: async () => {},
            toggleHeart: async () => {},
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
        } as any;
    }
    
    return context;
};

export const useApp = useAppContext;
