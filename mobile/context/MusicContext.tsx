import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { NativeModules, Platform, AppState, Alert } from 'react-native';
// We import types only to avoid side-effects if the native module is missing
import type { Song, MusicState } from '../types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { musicSyncService, type MusicSyncScope, type PlaybackAction } from '../services/MusicSyncService';
import { lyricsService, type LyricLine } from '../services/LyricsService';
import { onReconnect } from '../services/NetworkMonitor';
import { supabase } from '../config/supabase';
import { useAuth } from './AuthContext';
import { normalizeId } from '../utils/idNormalization';

// Safe require for TrackPlayer to prevent crash if native module is missing
let TrackPlayer: any = null;
let TrackPlayerEvents: any = {
    Capability: {
        Play: 0,
        Pause: 1,
        Stop: 2,
        SkipToNext: 3,
        SkipToPrevious: 4,
        SeekTo: 5,
    },
    Event: {
        RemotePlay: 'remote-play',
        RemotePause: 'remote-pause',
        RemoteStop: 'remote-stop',
        RemoteNext: 'remote-next',
        RemotePrevious: 'remote-previous',
        PlaybackError: 'playback-error',
        PlaybackQueueEnded: 'playback-queue-ended',
        PlaybackActiveTrackChanged: 'playback-active-track-changed',
    },
    State: {
        None: 'none',
        Ready: 'ready',
        Playing: 'playing',
        Paused: 'paused',
        Stopped: 'stopped',
        Buffering: 'buffering',
        Loading: 'loading',
    },
    AppKilledPlaybackBehavior: {
        StopPlaybackAndRemoveNotification: 'stop-playback-and-remove-notification',
    }
};
let TrackPlayerHooks: any = {
    usePlaybackState: () => ({ state: 'none' }),
    useTrackPlayerEvents: () => {},
};

try {
    // Only attempt to load if the native module exists
    const hasNativeModule = !!(NativeModules.TrackPlayerModule || NativeModules.RNTrackPlayer);
    console.log('[MusicContext] Native TrackPlayer detected:', hasNativeModule);
    
    if (hasNativeModule || Platform.OS === 'web') {
        TrackPlayer = require('react-native-track-player').default;
        const TP = require('react-native-track-player');
        // Override with actual constants if available
        TrackPlayerEvents = {
            Capability: TP.Capability || TrackPlayerEvents.Capability,
            Event: TP.Event || TrackPlayerEvents.Event,
            State: TP.State || TrackPlayerEvents.State,
            AppKilledPlaybackBehavior: TP.AppKilledPlaybackBehavior || TrackPlayerEvents.AppKilledPlaybackBehavior,
        };
        TrackPlayerHooks = {
            usePlaybackState: TP.usePlaybackState,
            useTrackPlayerEvents: TP.useTrackPlayerEvents,
        };
        console.log('[MusicContext] TrackPlayer library loaded successfully');
    } else {
        console.warn('[MusicContext] TrackPlayer native module NOT found. Rebuild with npx expo run:ios is required.');
    }
} catch (e) {
    console.warn('[MusicContext] TrackPlayer load error:', e);
}

const decodeHTMLEntities = (text: string): string => {
    if (!text) return '';
    return text
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
        .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
};

const REMOTE_SEEK_LOCK_MS = 3000;
const HEARTBEAT_SUPPRESS_MS = 2000;
// 3 s between heartbeats. 1.5 s was too aggressive on Android: every cycle
// fired 3-4 async TrackPlayer calls (getState/getPosition/seekTo/play) which
// blocked the audio thread and made buttons feel unresponsive. 3 s still keeps
// partners within ~3 s of each other which is imperceptible for casual listening.
const HEARTBEAT_INTERVAL_MS = 3000;

const getPlaybackStateValue = (state: any) =>
    state && typeof state === 'object' && 'state' in state ? state.state : state;

const isTrackPlayerActiveState = (state: any) => {
    const value = getPlaybackStateValue(state);
    return value === (TrackPlayerEvents.State?.Playing || 'playing') ||
        value === (TrackPlayerEvents.State?.Buffering || 'buffering') ||
        value === (TrackPlayerEvents.State?.Loading || 'loading');
};

const songToTrack = (song: Song) => ({
    id: song.id,
    url: song.url,
    title: decodeHTMLEntities(song.name),
    artist: decodeHTMLEntities(song.artist),
    artwork: song.image,
    duration: song.duration ? Number(song.duration) : undefined,
});

const trackToSong = (track: any): Song | null => {
    if (!track?.id || !track?.url) return null;
    return {
        id: String(track.id),
        name: decodeHTMLEntities(track.title || track.name || 'Unknown Title'),
        artist: decodeHTMLEntities(track.artist || 'Unknown Artist'),
        image: track.artwork || track.image || '',
        url: track.url,
        duration: track.duration ? Number(track.duration) : undefined,
    };
};

export type RepeatMode = 'off' | 'all' | 'one';

export interface MusicInvite {
    song: Song;
    senderId: string;
}

interface MusicContextType {
    musicState: MusicState;
    playSong: (song: Song, broadcast?: boolean) => Promise<void>;
    togglePlayMusic: () => Promise<void>;
    toggleFavoriteSong: (song: Song) => Promise<void>;
    seekTo: (position: number) => Promise<void>;
    getPlaybackPosition: () => Promise<number>;
    // New features
    repeatMode: RepeatMode;
    toggleRepeat: () => void;
    shuffle: boolean;
    toggleShuffle: () => void;
    queue: Song[];
    addToQueue: (song: Song) => void;
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
    musicSyncScope: MusicSyncScope;
    setIsSeeking: (seeking: boolean) => void;
    isSeeking: boolean;
    // Which chat "owns" the currently playing track. Lets each chat screen
    // decide whether to show the music UI in its header — only one chat at a
    // time can be the owner because the device only plays one track.
    playbackOwnerChatId: string | null;
    setPlaybackOwnerChatId: (chatId: string | null) => void;
    // Music invite — partner started playing and is inviting us to listen together.
    pendingMusicInvite: MusicInvite | null;
    acceptMusicInvite: () => Promise<void>;
    declineMusicInvite: () => void;
    // Lyrics — fetched once per song, current line tracked while playing.
    // Lifted to context so the chat-header karaoke view can subscribe even when
    // the player overlay is closed.
    lyrics: LyricLine[];
    lyricsLoading: boolean;
    currentLyricIndex: number;
    showLyrics: boolean;
    setShowLyrics: (v: boolean) => void;
}

export const MusicContext = createContext<MusicContextType | undefined>(undefined);

export const MusicProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser } = useAuth();
    const [musicState, setMusicState] = useState<MusicState>({
        currentSong: null,
        isPlaying: false,
        favorites: []
    });
    const musicStateRef = useRef(musicState);
    musicStateRef.current = musicState;
    const commitMusicState = useCallback((updater: (prev: MusicState) => MusicState) => {
        const nextState = updater(musicStateRef.current);
        musicStateRef.current = nextState;
        setMusicState(nextState);
        return nextState;
    }, []);
    const [isPlayerReady, setIsPlayerReady] = useState(false);
    const [isSeeking, setIsSeeking] = useState(false);
    const isSeekingRef = useRef(false);
    isSeekingRef.current = isSeeking;
    const lastSeekTimeRef = useRef<number>(0);
    const clockOffsetRef = useRef(0);
    const clockSyncRTTThreshold = 500; // Ignore pings with RTT > 500ms for calibration
    const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
    const [shuffle, setShuffle] = useState(false);
    const isProcessingRemoteUpdate = useRef(false);
    const seekLockRef = useRef<number>(0); // Timestamp until which remote noise is ignored
    const heartbeatSuppressUntilRef = useRef<number>(0);
    const lastSyncResponseRef = useRef<number>(0); // Cooldown: don't respond to sync_requests too often
    const activeTrackIndexRef = useRef(0);
    const ignoreNextTrackChangeBroadcastRef = useRef(false);
    const playSessionIdRef = useRef(0);
    const isPlaySongInProgressRef = useRef(false);
    // Refs for callbacks that the TrackPlayer remote-event listener
    // dispatches to. The listener is registered once via useTrackPlayerEvents
    // and its handler closes over its initial render. Without these refs,
    // pressing Next/Previous on bluetooth/lock-screen would always invoke
    // the queue-state-and-shuffle from first render, advancing to the
    // wrong song or no-op'ing after the queue was modified. Refs are
    // updated in a useEffect below so the handler always reads current.
    const playNextRef = useRef<() => Promise<void>>(async () => {});
    const playPreviousRef = useRef<() => Promise<void>>(async () => {});
    // Tracks the last song ID we attempted to recover so a single failure
    // gets exactly one silent retry (URL re-resolution / fresh buffer)
    // before we surface an error to the user. Without this, expired
    // signed URLs would just fail silently or spam-alert the user.
    const playbackRecoveryRef = useRef<{ songId: string; attemptedAt: number } | null>(null);
    // Last *explicit* user action ('playing' | 'paused') with timestamp.
    // The remote-update handler and the playback-error recovery both
    // consult this so that a partner's heartbeat or a transient native
    // error never silently undoes the user's local pause. Without this,
    // pressing pause on one device would resume playback within ~6s
    // because the partner's per-3s heartbeat broadcasts isPlaying:true
    // and after the seekLockRef window expires the local listener flips
    // back to play. Refreshed only on explicit toggle/playSong calls,
    // never by remote sync — so the "user pressed pause" signal stays
    // sticky until the user unpauses themselves.
    const userIntentRef = useRef<{ state: 'playing' | 'paused' | 'idle'; at: number }>({ state: 'idle', at: 0 });
    const [queue, setQueue] = useState<Song[]>([]);
    const queueRef = useRef<Song[]>(queue);
    queueRef.current = queue;
    const playbackAnchorRef = useRef<{
        songId: string | null;
        positionMs: number;
        updatedAt: number;
        isPlaying: boolean;
    }>({
        songId: null,
        positionMs: 0,
        updatedAt: Date.now(),
        isPlaying: false,
    });

    const getEstimatedPlaybackPosition = useCallback((song: Song | null = musicStateRef.current.currentSong) => {
        const anchor = playbackAnchorRef.current;
        const now = Date.now();
        const sameSong = !!song && anchor.songId === song.id;
        let positionMs = sameSong ? anchor.positionMs : 0;

        if (sameSong && anchor.isPlaying) {
            positionMs += now - anchor.updatedAt;
        }

        const durationMs = song?.duration ? Number(song.duration) * 1000 : 0;
        if (durationMs > 0) {
            positionMs = Math.min(positionMs, Math.max(0, durationMs - 250));
        }

        return Math.max(0, Math.round(positionMs));
    }, []);

    const setPlaybackAnchor = useCallback((
        positionMs: number,
        isPlayingValue: boolean,
        song: Song | null = musicStateRef.current.currentSong
    ) => {
        playbackAnchorRef.current = {
            songId: song?.id ?? null,
            positionMs: Math.max(0, Math.round(positionMs || 0)),
            updatedAt: Date.now(),
            isPlaying: isPlayingValue,
        };
    }, []);

    const markLocalInteraction = useCallback((remoteLockMs = REMOTE_SEEK_LOCK_MS, heartbeatMs = HEARTBEAT_SUPPRESS_MS) => {
        const now = Date.now();
        seekLockRef.current = now + remoteLockMs;
        heartbeatSuppressUntilRef.current = now + heartbeatMs;
        lastSeekTimeRef.current = now;
    }, []);

    const refreshQueueFromPlayer = useCallback(async (fallbackSong?: Song | null) => {
        if (!TrackPlayer || !isPlayerReady) return;

        try {
            const nativeQueue = await TrackPlayer.getQueue();
            const activeIndex = await TrackPlayer.getActiveTrackIndex();
            const resolvedIndex = typeof activeIndex === 'number' ? activeIndex : 0;
            const songs = nativeQueue
                .map(trackToSong)
                .filter((song): song is Song => !!song);

            activeTrackIndexRef.current = resolvedIndex;
            setQueue(songs.slice(resolvedIndex + 1));

            const activeSong = songs[resolvedIndex] || fallbackSong || null;
            if (activeSong && musicStateRef.current.currentSong?.id !== activeSong.id) {
                commitMusicState(prev => ({ ...prev, currentSong: activeSong }));
            }
        } catch (error) {
            console.warn('[MusicContext] Failed to refresh native queue snapshot:', error);
        }
    }, [commitMusicState, isPlayerReady]);

    const broadcastPlaybackState = useCallback(async (
        action: PlaybackAction,
        overrides: Partial<{ currentSong: Song | null; isPlaying: boolean; positionMs: number; scheduledStartTime: number | undefined }> = {}
    ) => {
        const currentSong = overrides.currentSong ?? musicStateRef.current.currentSong;
        if (!currentSong) return;

        const positionMs = overrides.positionMs ?? getEstimatedPlaybackPosition(currentSong);

        musicSyncService.broadcastUpdate({
            currentSong,
            isPlaying: overrides.isPlaying ?? musicStateRef.current.isPlaying,
            position: positionMs,
            scheduledStartTime: overrides.scheduledStartTime,
            action,
        });
    }, [getEstimatedPlaybackPosition]);

    // Internal seek function that doesn't broadcast (used for sync)
    const internalSeek = useCallback(async (seconds: number, shouldPlay = true) => {
        if (!isPlayerReady || !TrackPlayer) return;
        try {
            console.log(`[MusicSync] 🎯 Internal Seek to: ${seconds.toFixed(2)}s (shouldPlay: ${shouldPlay})`);
            await TrackPlayer.seekTo(seconds);

            // Suppress outgoing heartbeat for a full cycle after a remote-driven seek
            // so we don't immediately echo our newly-synced position back, which was
            // creating a ping-pong loop that made lyric lines repeat continuously.
            heartbeatSuppressUntilRef.current = Date.now() + HEARTBEAT_INTERVAL_MS;

            // Update lastSeekTimeRef so the state-update debounce (isPlaying sync)
            // doesn't immediately overwrite our local pause state with remote's.
            lastSeekTimeRef.current = Date.now();

            if (shouldPlay) {
                // Guard: if the user explicitly paused recently, do NOT force-play
                // after seeking. Without this, a partner heartbeat (isPlaying:true)
                // would call internalSeek with shouldPlay=true and override the pause
                // — this was the main reason "pause doesn't stick" on Android.
                const userPausedRecently =
                    userIntentRef.current.state === 'paused' &&
                    (Date.now() - userIntentRef.current.at) < 30_000;
                if (userPausedRecently) {
                    setPlaybackAnchor(seconds * 1000, false, musicStateRef.current.currentSong);
                    return;
                }

                setPlaybackAnchor(seconds * 1000, true, musicStateRef.current.currentSong);

                // Short timeout to let native buffer stabilize before verifying state
                setTimeout(async () => {
                    // Re-check user intent inside the timeout — the user may have
                    // paused between the seek and this callback firing (150 ms gap).
                    const intentNow =
                        userIntentRef.current.state === 'paused' &&
                        (Date.now() - userIntentRef.current.at) < 30_000;
                    if (intentNow) return;

                    const state = await TrackPlayer.getState();
                    if (state !== (TrackPlayerEvents.State?.Playing || 'playing')) {
                        await TrackPlayer.play();
                    }
                }, 150);
            } else {
                setPlaybackAnchor(seconds * 1000, false, musicStateRef.current.currentSong);
            }
        } catch (e) {
            console.warn('[MusicContext] Internal seek failed:', e);
        }
    }, [isPlayerReady, setPlaybackAnchor]);

    const seekTo = useCallback(async (position: number) => {
        if (!isPlayerReady || !TrackPlayer) return;
        
        try {
            const seconds = position / 1000;
            console.log(`[MusicContext] ⏩ User Seeking to: ${seconds}s`);
            
            setIsSeeking(true);
            markLocalInteraction();
            
            await TrackPlayer.seekTo(seconds);
            setPlaybackAnchor(position, musicStateRef.current.isPlaying, musicStateRef.current.currentSong);
            
            // Manual user seek SHOULD broadcast
            const isSynced = musicSyncService?.isClockSynced();
            void broadcastPlaybackState('seek', {
                positionMs: position,
                scheduledStartTime: isSynced ? Date.now() + 100 : undefined,
            }).catch(e => console.warn('[MusicContext] seek broadcast failed:', e));

            // Unlock UI after a delay
            setTimeout(() => setIsSeeking(false), 800);
        } catch (error) {
            console.error('[MusicContext] Seek Error:', error);
            setIsSeeking(false);
        }
    }, [broadcastPlaybackState, isPlayerReady, markLocalInteraction, setPlaybackAnchor]);
    const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);
    const [musicSyncScope, setMusicSyncScope] = useState<MusicSyncScope>({ type: 'none' });
    const [pendingMusicInvite, setPendingMusicInvite] = useState<MusicInvite | null>(null);
    const pendingMusicInviteRef = useRef<MusicInvite | null>(null);
    pendingMusicInviteRef.current = pendingMusicInvite;

    const [playbackOwnerChatId, _setPlaybackOwnerChatId] = useState<string | null>(null);
    const setPlaybackOwnerChatId = useCallback((chatId: string | null) => {
        const normalized = chatId ? normalizeId(chatId) : null;
        console.log('[MusicContext] 👑 Setting playback owner:', normalized, '(from:', chatId, ')');
        _setPlaybackOwnerChatId(normalized);
    }, []);
    const [lyrics, setLyrics] = useState<LyricLine[]>([]);
    const [lyricsLoading, setLyricsLoading] = useState(false);
    const [currentLyricIndex, setCurrentLyricIndex] = useState(0);
    const [showLyrics, setShowLyrics] = useState(false);
    const sleepTimerRef = useRef<NodeJS.Timeout | null>(null);
    
    // Safely use hooks
    const playbackState = TrackPlayerHooks.usePlaybackState();
    const isPlaying = isTrackPlayerActiveState(playbackState);

    useEffect(() => {
        const intent = userIntentRef.current;
        const intentAge = Date.now() - intent.at;

        if (intent.state === 'playing' && intentAge < 1200 && !isPlaying) return;
        if (intent.state === 'paused' && intentAge < 30_000 && isPlaying) return;

        setPlaybackAnchor(getEstimatedPlaybackPosition(), isPlaying, musicStateRef.current.currentSong);
        commitMusicState(prev => (prev.isPlaying === isPlaying ? prev : { ...prev, isPlaying }));
    }, [commitMusicState, getEstimatedPlaybackPosition, isPlaying, setPlaybackAnchor]);

    const suspendGroupRoomPlayback = useCallback(async () => {
        if (!TrackPlayer) return;
        if (musicSyncService.getCurrentScope().type !== 'group') return;

        try {
            await TrackPlayer.pause();
        } catch (e) {
            console.warn('[MusicContext] suspendGroupRoomPlayback pause failed:', e);
        }

        commitMusicState(prev => ({ ...prev, isPlaying: false }));
    }, [commitMusicState]);

    // Initialize TrackPlayer
    useEffect(() => {
        let isMounted = true;

        async function setup() {
            if (!TrackPlayer) {
                console.warn('[MusicContext] TrackPlayer module missing, skipping setup');
                return;
            }
            try {
                try {
                    await TrackPlayer.getCurrentTrack();
                    console.log('[MusicContext] TrackPlayer already initialized');
                } catch {
                    console.log('[MusicContext] Initializing TrackPlayer...');
                    await TrackPlayer.setupPlayer({
                        waitForBuffer: Platform.OS !== 'android',
                        minBuffer: Platform.OS === 'android' ? 3 : 10,
                        maxBuffer: Platform.OS === 'android' ? 15 : 30,
                        playBuffer: Platform.OS === 'android' ? 0.25 : 0.5,
                        backBuffer: Platform.OS === 'android' ? 5 : 15,
                        maxCacheSize: 1024 * 100, // 100MB cache
                        iosCategory: 'playback', // Explicitly set for background play
                        iosCategoryMode: 'default',
                        iosCategoryOptions: ['allowBluetooth', 'allowBluetoothA2DP', 'allowAirPlay'],
                    });
                }

                if (!isMounted) return;

                // Initial options setup
                await TrackPlayer.updateOptions({
                    android: {
                        appKilledPlaybackBehavior: TrackPlayerEvents.AppKilledPlaybackBehavior?.StopPlaybackAndRemoveNotification,
                    },
                    minBuffer: Platform.OS === 'android' ? 3 : 10,
                    maxBuffer: Platform.OS === 'android' ? 15 : 30,
                    playBuffer: Platform.OS === 'android' ? 0.25 : 0.5,
                    backBuffer: Platform.OS === 'android' ? 5 : 15,
                    capabilities: [
                        TrackPlayerEvents.Capability.Play,
                        TrackPlayerEvents.Capability.Pause,
                        TrackPlayerEvents.Capability.SkipToNext,
                        TrackPlayerEvents.Capability.SkipToPrevious,
                        TrackPlayerEvents.Capability.Stop,
                        TrackPlayerEvents.Capability.SeekTo,
                    ],
                    compactCapabilities: [
                        TrackPlayerEvents.Capability.Play,
                        TrackPlayerEvents.Capability.Pause,
                        TrackPlayerEvents.Capability.SkipToNext,
                    ],
                    notificationCapabilities: [
                        TrackPlayerEvents.Capability.Play,
                        TrackPlayerEvents.Capability.Pause,
                        TrackPlayerEvents.Capability.SkipToNext,
                        TrackPlayerEvents.Capability.SkipToPrevious,
                        TrackPlayerEvents.Capability.Stop,
                    ],
                    progressUpdateEventInterval: Platform.OS === 'android' ? 1 : 0.5,
                });

                setIsPlayerReady(true);
                console.log('[MusicContext] TrackPlayer is ready');
            } catch (error) {
                console.error('[MusicContext] TrackPlayer setup error:', error);
            }
        }

        setup();
        return () => { isMounted = false; };
    }, []);

    // Safely listen for remote events
    TrackPlayerHooks.useTrackPlayerEvents([
        TrackPlayerEvents.Event.RemotePlay, 
        TrackPlayerEvents.Event.RemotePause,
        TrackPlayerEvents.Event.RemoteNext,
        TrackPlayerEvents.Event.RemotePrevious,
        TrackPlayerEvents.Event.PlaybackError,
        TrackPlayerEvents.Event.PlaybackActiveTrackChanged,
    ], async (event: any) => {
        if (!TrackPlayer) return;
        
        if (event.type === TrackPlayerEvents.Event.PlaybackError) {
            const errMsg = event.message || event.code || 'unknown';
            console.error('[MusicContext] ❌ Native Playback Error:', errMsg, event);

            // One-shot recovery: most playback errors on Soul come from
            // expired Supabase signed URLs or transient network blips. Try
            // a single fresh re-add of the same song before surfacing an
            // error to the user. The recovery ref ensures we never loop
            // (one attempt per song) and don't spam alerts.
            const currentSong = musicStateRef.current?.currentSong;
            const previousAttempt = playbackRecoveryRef.current;
            const shouldRetry = !!currentSong
                && (!previousAttempt
                    || previousAttempt.songId !== currentSong.id
                    || (Date.now() - previousAttempt.attemptedAt) > 30_000);

            if (shouldRetry) {
                playbackRecoveryRef.current = { songId: currentSong!.id, attemptedAt: Date.now() };
                // Respect user intent: if they paused recently, recovery
                // should rebuild the queue but NOT auto-resume. Without
                // this guard, a transient native error during a paused
                // state would silently restart playback against the
                // user's wish (the bug they reported as "song bar-bar
                // play ho rha hai pause krne par bhi").
                const userPausedRecently =
                    userIntentRef.current.state === 'paused' &&
                    (Date.now() - userIntentRef.current.at) < 30_000;
                console.log(`[MusicContext] 🔁 Attempting one-shot playback recovery for "${currentSong!.name}"${userPausedRecently ? ' (paused — will not auto-resume)' : ''}`);
                try {
                    const lastPos = await TrackPlayer.getPosition().catch(() => 0);
                    await TrackPlayer.reset();
                    await TrackPlayer.add({
                        id: currentSong!.id,
                        url: currentSong!.url,
                        title: currentSong!.name,
                        artist: currentSong!.artist,
                        artwork: currentSong!.image,
                        duration: currentSong!.duration ? Number(currentSong!.duration) : undefined,
                    });
                    if (lastPos > 1) {
                        await TrackPlayer.seekTo(lastPos);
                    }
                    if (!userPausedRecently) {
                        await TrackPlayer.play();
                    }
                    console.log('[MusicContext] ✅ Recovery succeeded');
                    return;
                } catch (recoveryErr) {
                    console.warn('[MusicContext] Recovery failed, falling through to user alert:', recoveryErr);
                }
            }

            Alert.alert(
                'Playback Error',
                `Could not load this track (${errMsg}). Please check your internet connection or try another song.`
            );
            return;
        }

        if (event.type === TrackPlayerEvents.Event.PlaybackActiveTrackChanged) {
            const nextSong = trackToSong(event.track);
            await refreshQueueFromPlayer(nextSong);

            if (!nextSong) return;
            const previousSongId = musicStateRef.current.currentSong?.id;
            commitMusicState(prev => ({
                ...prev,
                currentSong: nextSong,
            }));

            if (isProcessingRemoteUpdate.current) return;

            if (ignoreNextTrackChangeBroadcastRef.current) {
                ignoreNextTrackChangeBroadcastRef.current = false;
                // Native player is now active on this track — safe to seek.
                // On Android, seekTo(0) before play() is often a no-op because
                // ExoPlayer hasn't loaded the track yet. Seeking here (after
                // PlaybackActiveTrackChanged) guarantees position 0 regardless
                // of any cached offset the native player restored.
                await TrackPlayer.seekTo(0).catch(() => {});
                setPlaybackAnchor(0, true, nextSong);
                return;
            }

            if (previousSongId !== nextSong.id) {
                await broadcastPlaybackState('track-change', {
                    currentSong: nextSong,
                    positionMs: 0,
                });
            }
            return;
        }

        console.log('[MusicContext] Remote event received:', event.type);

        if (event.type === TrackPlayerEvents.Event.RemotePlay) {
            try {
                const currentSong = musicStateRef.current.currentSong;
                const positionMs = getEstimatedPlaybackPosition(currentSong);
                userIntentRef.current = { state: 'playing', at: Date.now() };
                markLocalInteraction();
                setPlaybackAnchor(positionMs, true, currentSong);
                commitMusicState(prev => ({ ...prev, isPlaying: true }));
                void Promise.resolve(TrackPlayer.play())
                    .catch(e => console.warn('[MusicContext] RemotePlay failed:', e));
                if (currentSong) {
                    void broadcastPlaybackState('play', {
                        currentSong,
                        isPlaying: true,
                        positionMs,
                    }).catch(e => console.warn('[MusicContext] RemotePlay broadcast failed:', e));
                }
            } catch (e) {
                console.warn('[MusicContext] RemotePlay failed:', e);
            }
        } else if (event.type === TrackPlayerEvents.Event.RemotePause) {
            try {
                const currentSong = musicStateRef.current.currentSong;
                const positionMs = getEstimatedPlaybackPosition(currentSong);
                userIntentRef.current = { state: 'paused', at: Date.now() };
                markLocalInteraction();
                setPlaybackAnchor(positionMs, false, currentSong);
                commitMusicState(prev => ({ ...prev, isPlaying: false }));
                void Promise.resolve(TrackPlayer.pause())
                    .catch(e => console.warn('[MusicContext] RemotePause failed:', e));
                if (currentSong) {
                    void broadcastPlaybackState('pause', {
                        currentSong,
                        isPlaying: false,
                        positionMs,
                    }).catch(e => console.warn('[MusicContext] RemotePause broadcast failed:', e));
                }
            } catch (e) {
                console.warn('[MusicContext] RemotePause failed:', e);
            }
        } else if (event.type === TrackPlayerEvents.Event.RemoteNext) {
            const nativeQueue = await TrackPlayer.getQueue().catch(() => []);
            const activeIndex = await TrackPlayer.getActiveTrackIndex().catch(() => 0);
            const canNativeSkip = nativeQueue.length > 1 && typeof activeIndex === 'number' && activeIndex < nativeQueue.length - 1;
            if (!canNativeSkip) {
                playNextRef.current();
            }
        } else if (event.type === TrackPlayerEvents.Event.RemotePrevious) {
            const activeIndex = await TrackPlayer.getActiveTrackIndex().catch(() => 0);
            if (typeof activeIndex === 'number' && activeIndex <= 0) {
                playPreviousRef.current();
            }
        }
    });

    useEffect(() => {
        if (!currentUser) return;
        const normalizedCurrentUserId = normalizeId(currentUser.id);
        AsyncStorage.getItem(`ss_favorites_${currentUser.id}`).then(favs => {
            if (favs) setMusicState(prev => ({ ...prev, favorites: JSON.parse(favs) }));
        });
        musicSyncService.setInviteCallback((song, senderId) => {
            setPendingMusicInvite({ song, senderId });
        });

        musicSyncService.initialize(normalizedCurrentUserId, async (remoteState, eventType) => {
            const remoteAction = remoteState.action;
            const isTransportAction =
                remoteAction === 'play' ||
                remoteAction === 'pause' ||
                remoteAction === 'seek' ||
                remoteAction === 'track-change';
            if (isProcessingRemoteUpdate.current && !isTransportAction) return;
            
            // Handle Clock Sync (Ping/Pong)
            if (eventType === 'ping') {
                musicSyncService.sendPong(remoteState.updatedAt);
                return;
            }
            if (eventType === 'pong') {
                const now = Date.now();
                const rtt = now - remoteState.position; // remoteState.position stores our original ping time

                if (rtt > clockSyncRTTThreshold) {
                    console.log(`[MusicSync] ⚠️ Skipping clock sync, RTT too high: ${rtt.toFixed(0)}ms`);
                    return;
                }

                const remoteClockAtTarget = remoteState.updatedAt + (rtt / 2);
                const newOffset = remoteClockAtTarget - now;

                // Use a moving average for more stable offset (10% new, 90% old)
                clockOffsetRef.current = clockOffsetRef.current === 0
                    ? newOffset
                    : (clockOffsetRef.current * 0.9 + newOffset * 0.1);
                // Tell the service we now have a usable clock estimate so
                // playSong/togglePlayMusic can populate scheduledStartTime
                // from now on. Without this, the synced-start feature was
                // always disabled (isClockSynced was undefined).
                musicSyncService.markClockSynced();
                console.log(`[MusicSync] ⏱️ Clock sync: offset=${newOffset.toFixed(0)}ms, rtt=${rtt.toFixed(0)}ms`);
                return;
            }

            // Seek Protection: If we manually seeked recently, ignore remote position updates for a few seconds
            // to allow our own seek to propagate and the partner to sync to US.
            const isSeekLocked = Date.now() < seekLockRef.current;

            console.log(`[MusicSync] (${eventType}) Received remote update: isPlaying=${remoteState.isPlaying}, song=${remoteState.currentSong?.name}${isSeekLocked ? ' (SEEK LOCKED)' : ''}`);
            
            // Handle Sync Request: If partner asked for our state, send it immediately.
            // If we have nothing loaded, stay silent — broadcasting an empty
            // {currentSong: null, isPlaying: false} payload was being parsed by
            // the partner as "Partner stopped playback" and pausing their local
            // player. Silence is the correct answer for "I have no state to share".
            if (eventType === 'sync_request') {
                const mySong = musicStateRef.current.currentSong;
                if (!mySong) return;
                // Cooldown: if we responded to a sync_request recently, skip.
                // When both users open the chat simultaneously both fire
                // requestMusicSync(), each responds to the other's request, and
                // the cross-synced positions race and fight — creating a seek
                // storm that oscillates the lyric index and makes lines repeat.
                const now = Date.now();
                if (now - lastSyncResponseRef.current < 3000) return;
                lastSyncResponseRef.current = now;
                await broadcastPlaybackState('sync', {
                    currentSong: mySong,
                    isPlaying: musicStateRef.current.isPlaying,
                });
                return;
            }

            if (!TrackPlayer || !isPlayerReady) return;

            try {
                isProcessingRemoteUpdate.current = true;
                // Determine target position with high-precision latency compensation (drift + clock sync)
                const now = Date.now();
                // (now + clockOffsetRef.current) is our estimate of the PARTNER'S local time right now
                let drift = (now + clockOffsetRef.current) - remoteState.updatedAt;
                // If drift is wildly off (>60s) the clock estimate is bad —
                // probably a stale clockOffset, app resume after suspend, or
                // a long-delayed broadcast. Trust the raw remote position
                // instead of "compensating" by 30s into negative-or-past-end
                // territory which makes seekTo hang or jump to song end.
                const MAX_REASONABLE_DRIFT_MS = 60_000;
                if (Math.abs(drift) > MAX_REASONABLE_DRIFT_MS) {
                    console.warn(`[MusicSync] ⚠️ Drift ${(drift / 1000).toFixed(1)}s exceeds ${MAX_REASONABLE_DRIFT_MS / 1000}s — using raw remote position without compensation`);
                    drift = 0;
                }
                const rawTargetPosSeconds = (remoteState.position + drift) / 1000;
                // Clamp to song bounds so we never seek to negative or past
                // the end. Without this, large drifts produce out-of-range
                // seeks that TrackPlayer either ignores silently or treats
                // as "seek to end" → playback freezes / jumps to next track.
                const songDuration = remoteState.currentSong?.duration
                    ? Number(remoteState.currentSong.duration)
                    : null;
                const upperBound = songDuration && songDuration > 0
                    ? Math.max(0, songDuration - 0.5) // leave 0.5s headroom from end
                    : Number.POSITIVE_INFINITY;
                const targetPosSeconds = Math.max(0, Math.min(rawTargetPosSeconds, upperBound));
                if (targetPosSeconds !== rawTargetPosSeconds) {
                    console.warn(`[MusicSync] 🔒 Target position ${rawTargetPosSeconds.toFixed(2)}s clamped to ${targetPosSeconds.toFixed(2)}s (duration: ${songDuration ?? 'unknown'}s)`);
                }

                // 1. If partner started playing a new song
                if (remoteState.currentSong && remoteState.currentSong.url) {
                    const cleanRemoteSong = {
                        ...remoteState.currentSong,
                        name: decodeHTMLEntities(remoteState.currentSong.name),
                        artist: decodeHTMLEntities(remoteState.currentSong.artist)
                    };

                    const currentSong = musicStateRef.current?.currentSong;
                    if (!currentSong || currentSong.id !== cleanRemoteSong.id) {
                        // Don't auto-play a new song from a remote update — the
                        // invite banner (set by the music_invite broadcast) is the
                        // gating mechanism. If the banner hasn't been shown yet for
                        // this song (e.g. invite broadcast was missed), create it now.
                        // Either way, return and wait for the user to tap Accept.
                        if (pendingMusicInviteRef.current?.song.id !== cleanRemoteSong.id) {
                            console.log('[MusicSync] 🆕 New song from partner — showing invite banner:', cleanRemoteSong.name);
                            setPendingMusicInvite({ song: cleanRemoteSong, senderId: remoteState.updatedBy });
                        }
                        return;
                    } else {
                        // 2. Same song — sync play/pause and position drift
                        const action = remoteState.action || 'heartbeat';
                        const currentLocalPos = getEstimatedPlaybackPosition(cleanRemoteSong) / 1000;
                        const posDifference = Math.abs(currentLocalPos - targetPosSeconds);
                        const remotePositionMs = targetPosSeconds * 1000;

                        if (action === 'pause') {
                            userIntentRef.current = { state: 'paused', at: Date.now() };
                            setPlaybackAnchor(remotePositionMs, false, cleanRemoteSong);
                            commitMusicState(prev => ({ ...prev, isPlaying: false }));
                            void Promise.resolve(TrackPlayer.pause())
                                .catch(e => console.warn('[MusicSync] Remote pause failed:', e));
                            if (posDifference > 1.25) {
                                void Promise.resolve(TrackPlayer.seekTo(targetPosSeconds))
                                    .catch(e => console.warn('[MusicSync] Remote pause position sync failed:', e));
                            }
                        } else if (action === 'play') {
                            userIntentRef.current = { state: 'playing', at: Date.now() };
                            setPlaybackAnchor(remotePositionMs, true, cleanRemoteSong);
                            commitMusicState(prev => ({ ...prev, isPlaying: true }));
                            const playAfterOptionalSeek = posDifference > 0.75
                                ? Promise.resolve(TrackPlayer.seekTo(targetPosSeconds)).then(() => TrackPlayer.play())
                                : Promise.resolve(TrackPlayer.play());
                            void playAfterOptionalSeek.catch(e => console.warn('[MusicSync] Remote play failed:', e));
                        } else if (action === 'seek') {
                            userIntentRef.current = { state: remoteState.isPlaying ? 'playing' : 'paused', at: Date.now() };
                            setPlaybackAnchor(remotePositionMs, remoteState.isPlaying, cleanRemoteSong);
                            commitMusicState(prev => ({ ...prev, isPlaying: remoteState.isPlaying }));
                            const seekThenTransport = Promise.resolve(TrackPlayer.seekTo(targetPosSeconds))
                                .then(() => remoteState.isPlaying ? TrackPlayer.play() : TrackPlayer.pause());
                            void seekThenTransport.catch(e => console.warn('[MusicSync] Remote seek failed:', e));
                        } else if (isSeekLocked) {
                            console.log('[MusicSync] 🛡️ Ignoring passive remote update due to active interaction lock');
                        } else if (remoteState.isPlaying && musicStateRef.current.isPlaying && posDifference > 2.0) {
                            console.log(`[MusicSync] ⏳ Passive drift correction ${posDifference.toFixed(2)}s`);
                            await internalSeek(targetPosSeconds, true);
                        } else if (action === 'sync' && remoteState.isPlaying && !musicStateRef.current.isPlaying) {
                            const userPausedRecently =
                                userIntentRef.current.state === 'paused' &&
                                (Date.now() - userIntentRef.current.at) < 30_000;
                            if (!userPausedRecently) {
                                userIntentRef.current = { state: 'playing', at: Date.now() };
                                setPlaybackAnchor(remotePositionMs, true, cleanRemoteSong);
                                commitMusicState(prev => ({ ...prev, isPlaying: true }));
                                const playAfterOptionalSeek = posDifference > 0.75
                                    ? Promise.resolve(TrackPlayer.seekTo(targetPosSeconds)).then(() => TrackPlayer.play())
                                    : Promise.resolve(TrackPlayer.play());
                                void playAfterOptionalSeek.catch(e => console.warn('[MusicSync] Remote sync play failed:', e));
                            }
                        } else if (action === 'sync' && !remoteState.isPlaying && musicStateRef.current.isPlaying) {
                            userIntentRef.current = { state: 'paused', at: Date.now() };
                            setPlaybackAnchor(remotePositionMs, false, cleanRemoteSong);
                            commitMusicState(prev => ({ ...prev, isPlaying: false }));
                            void Promise.resolve(TrackPlayer.pause())
                                .catch(e => console.warn('[MusicSync] Remote sync pause failed:', e));
                        }
                        
                        if (!isSeekingRef.current) {
                            const now = Date.now();
                            if (now - lastSeekTimeRef.current > 2000 && action !== 'heartbeat') {
                                // Never let a remote heartbeat flip our local isPlaying:true
                                // while the user has intentionally paused. Without this guard:
                                // user pauses → partner heartbeat sets isPlaying=true in context
                                // → button shows PAUSE → user taps PAUSE → getState()=Paused
                                // → togglePlay tries to PLAY → infinite play/pause loop.
                                const intentPaused =
                                    userIntentRef.current.state === 'paused' &&
                                    (Date.now() - userIntentRef.current.at) < 30_000;
                                if (!intentPaused || !remoteState.isPlaying) {
                                    commitMusicState(prev => ({ ...prev, isPlaying: remoteState.isPlaying }));
                                }
                            }
                        }
                    }
                } else if (!remoteState.isPlaying && !remoteState.currentSong) {
                    // Partner has no song to share — this happens during transient
                    // states (sync_request response before partner picked a song,
                    // RemotePlay/RemotePause that omit currentSong, etc.). Treating
                    // it as "stop" was wrong: the local user might be the one
                    // playing, and we'd pause their music for no reason. Just
                    // ignore — a real stop comes via an explicit isPlaying:false
                    // with the same currentSong, handled in the branch above.
                    console.log('[MusicSync] ℹ️ Partner has no song state — ignoring (was: forced pause, removed)');
                }

                // Ownership sync
                const scope = musicSyncService.getCurrentScope();
                if (scope.type !== 'none' && scope.targetId) {
                    setPlaybackOwnerChatId(scope.targetId);
                }
            } catch (e) {
                console.warn('[MusicSync] Failed to apply remote state:', e);
            } finally {
                isProcessingRemoteUpdate.current = false;
            }
        });

        // When app comes to foreground, reset retry cap so MusicSync can reconnect
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                musicSyncService.retryNow();
            }
        });

        // Network reconnect: previously, if the device went offline mid-
        // session and came back online while the app was still in the
        // foreground, the music channel never recovered (retry cap hit
        // during the outage, then silent forever). forceReconnect tears
        // down any zombie channel and re-subscribes so users don't have
        // to background→foreground the app to revive listening together.
        const offReconnect = onReconnect(() => {
            console.log('[MusicContext] 🌐 Network reconnected — forcing music sync reconnect');
            musicSyncService.forceReconnect();
        });

        // Token refresh: Supabase auth auto-refreshes tokens, but the
        // music Realtime channel doesn't re-authenticate on its own. After
        // ~1 hour the channel silently goes dead with the channel object
        // still present (so retryNow() would bail). forceReconnect tears
        // down and re-subscribes with the fresh JWT so long listening
        // sessions don't quietly die.
        const { data: authSub } = supabase.auth.onAuthStateChange((eventName) => {
            if (eventName === 'TOKEN_REFRESHED') {
                console.log('[MusicContext] 🔑 Auth token refreshed — re-establishing music channel');
                musicSyncService.forceReconnect();
            }
        });

        return () => {
            sub.remove();
            offReconnect();
            authSub?.subscription?.unsubscribe?.();
            musicSyncService.cleanup();
        };
    }, [broadcastPlaybackState, commitMusicState, currentUser, getEstimatedPlaybackPosition, isPlayerReady, internalSeek, refreshQueueFromPlayer, setPlaybackAnchor, setPlaybackOwnerChatId]);

    // ── Lyrics: fetch on song change ────────────────────────────────────────
    useEffect(() => {
        const song = musicState.currentSong;
        setLyrics([]);
        setLyricsLoading(false);
        setCurrentLyricIndex(0);
        if (!song) return;
        let cancelled = false;
        setLyricsLoading(true);
        lyricsService
            .getLyrics(song.name, song.artist, Number(song.duration))
            .then(result => { if (!cancelled && result) setLyrics(result.lines); })
            .catch(e => console.warn('[MusicContext] Lyrics error:', e))
            .finally(() => {
                if (!cancelled) setLyricsLoading(false);
            });
        return () => { cancelled = true; };
    }, [musicState.currentSong?.id]);

    // ── Lyrics: track current line while playing ────────────────────────────
    useEffect(() => {
        if (!musicState.isPlaying || lyrics.length === 0 || !TrackPlayer) return;
        const tick = setInterval(() => {
            const posSec = getEstimatedPlaybackPosition(musicStateRef.current.currentSong) / 1000;
            const idx = lyricsService.getCurrentLineIndex(lyrics, posSec);
            setCurrentLyricIndex(prev => (prev === idx ? prev : idx));
        }, 250);
        return () => clearInterval(tick);
    }, [getEstimatedPlaybackPosition, musicState.isPlaying, lyrics]);

    // ── Heartbeat Loop: Ensures real-time alignment during playback ─────────
    useEffect(() => {
        if (!musicState.isPlaying || !musicState.currentSong || !TrackPlayer) return;

        const heartbeat = setInterval(async () => {
            try {
                if (isSeekingRef.current || Date.now() < heartbeatSuppressUntilRef.current) {
                    console.log('[MusicContext] ❤️ Heartbeat suppressed (seeking or recently seeked)');
                    return;
                }

                // Only heartbeat if we have an active channel to broadcast on
                if (musicSyncService.getConnectionStatus() === 'connected') {
                    await broadcastPlaybackState('heartbeat', {
                        isPlaying: true,
                    });
                }
            } catch (e) {
                console.warn('[MusicContext] Heartbeat failed:', e);
            }
        }, HEARTBEAT_INTERVAL_MS);

        return () => clearInterval(heartbeat);
    }, [broadcastPlaybackState, musicState.currentSong?.id, musicState.isPlaying]);

    // ── Clock Sync Effect: Regularly calibrate clocks when a partner is present ──
    useEffect(() => {
        if (musicSyncScope.type !== 'direct' || !currentUser) return;

        // Perform initial sync pings
        const syncInterval = setInterval(() => {
            if (musicSyncService.getConnectionStatus() === 'connected') {
                musicSyncService.sendPing();
            }
        }, 15000); // Re-calibrate every 15s

        // Trigger immediate ping
        const initialPing = setTimeout(() => musicSyncService.sendPing(), 1000);

        return () => {
            clearInterval(syncInterval);
            clearTimeout(initialPing);
        };
    }, [currentUser?.id, musicSyncScope.type, musicSyncScope.type === 'direct' ? musicSyncScope.targetId : null]);

    const playSong = useCallback(async (song: Song, broadcast = true) => {
        if (!isPlayerReady || !TrackPlayer) {
            console.warn('[MusicContext] Cannot play: Player not ready or module missing');
            return;
        }
        // Idempotency key: each call gets a unique session ID. After every
        // await we check isStale() — if a newer playSong superseded us, we
        // bail out and let the new session own the player.
        const sessionId = ++playSessionIdRef.current;
        const isStale = () => playSessionIdRef.current !== sessionId;
        isPlaySongInProgressRef.current = true;
        let rollbackSong: Song | null = musicStateRef.current.currentSong;
        let rollbackIsPlaying = musicStateRef.current.isPlaying;
        try {
            console.log(`[MusicContext] 🎵 Playing song: "${song.name}"`);
            console.log(`[MusicContext] 🔗 Trace URL: ${song.url}`);
            
            // Check if URL is valid
            if (!song.url || (!song.url.startsWith('http') && !song.url.startsWith('file'))) {
                console.error('[MusicContext] ❌ Invalid song URL:', song.url);
                return;
            }

            const cleanSong = {
                ...song,
                name: decodeHTMLEntities(song.name),
                artist: decodeHTMLEntities(song.artist)
            };
            const upcomingQueue = queueRef.current.filter(queuedSong => queuedSong.id !== cleanSong.id);
            const playlist = [cleanSong, ...upcomingQueue];
            const previousSong = musicStateRef.current.currentSong;
            const previousIsPlaying = musicStateRef.current.isPlaying;
            rollbackSong = previousSong;
            rollbackIsPlaying = previousIsPlaying;

            ignoreNextTrackChangeBroadcastRef.current = true;
            userIntentRef.current = { state: 'playing', at: Date.now() };
            markLocalInteraction(6000, 4000);
            setPlaybackAnchor(0, true, cleanSong);
            setQueue(upcomingQueue);
            commitMusicState(prev => ({ ...prev, currentSong: cleanSong, isPlaying: true }));

            await TrackPlayer.reset();
            if (isStale()) return;

            // Re-apply options only on iOS where it wakes the media center.
            // On Android this extra native call sits in the song-start path.
            if (Platform.OS === 'ios') {
                await TrackPlayer.updateOptions({
                    capabilities: [
                        TrackPlayerEvents.Capability.Play,
                        TrackPlayerEvents.Capability.Pause,
                        TrackPlayerEvents.Capability.SkipToNext,
                        TrackPlayerEvents.Capability.SkipToPrevious,
                        TrackPlayerEvents.Capability.Stop,
                        TrackPlayerEvents.Capability.SeekTo,
                    ],
                    notificationCapabilities: [
                        TrackPlayerEvents.Capability.Play,
                        TrackPlayerEvents.Capability.Pause,
                        TrackPlayerEvents.Capability.SkipToNext,
                        TrackPlayerEvents.Capability.SkipToPrevious,
                        TrackPlayerEvents.Capability.Stop,
                    ],
                });
            }
            await TrackPlayer.add(playlist.map(songToTrack));
            if (isStale()) return;
            await TrackPlayer.seekTo(0);
            if (isStale()) return;
            activeTrackIndexRef.current = 0;

            if (broadcast) {
                // Send invite notification so partner sees a pill before auto-sync.
                musicSyncService.sendMusicInvite(cleanSong);

                try {
                    void Promise.resolve(TrackPlayer.play()).catch((playErr) => {
                        console.error('[MusicContext] playSong: TrackPlayer.play() failed:', playErr);
                        commitMusicState(prev => ({
                            ...prev,
                            currentSong: previousSong,
                            isPlaying: previousIsPlaying,
                        }));
                        setPlaybackAnchor(getEstimatedPlaybackPosition(previousSong), previousIsPlaying, previousSong);
                        userIntentRef.current = { state: previousIsPlaying ? 'playing' : 'paused', at: Date.now() };
                    });
                } catch (playErr) {
                    console.error('[MusicContext] playSong: TrackPlayer.play() failed:', playErr);
                    Alert.alert(
                        'Playback Error',
                        'Could not start this track. Please try another song.'
                    );
                    commitMusicState(prev => ({
                        ...prev,
                        currentSong: previousSong,
                        isPlaying: previousIsPlaying,
                    }));
                    setPlaybackAnchor(getEstimatedPlaybackPosition(previousSong), previousIsPlaying, previousSong);
                    userIntentRef.current = { state: previousIsPlaying ? 'playing' : 'paused', at: Date.now() };
                    return;
                }

                const isSynced = musicSyncService?.isClockSynced();
                const scheduledTime = Date.now() + 100;

                void broadcastPlaybackState('track-change', {
                    currentSong: cleanSong,
                    isPlaying: true,
                    positionMs: 0,
                    scheduledStartTime: isSynced ? scheduledTime : undefined,
                }).catch(e => console.warn('[MusicContext] track-change broadcast failed:', e));
            } else {
                void Promise.resolve(TrackPlayer.play())
                    .catch(e => console.warn('[MusicContext] playSong accept-invite play failed:', e));
            }
            setTimeout(() => {
                ignoreNextTrackChangeBroadcastRef.current = false;
            }, 1000);
        } catch (error) {
            ignoreNextTrackChangeBroadcastRef.current = false;
            commitMusicState(prev => ({
                ...prev,
                currentSong: rollbackSong,
                isPlaying: rollbackIsPlaying,
            }));
            setPlaybackAnchor(getEstimatedPlaybackPosition(rollbackSong), rollbackIsPlaying, rollbackSong);
            userIntentRef.current = { state: rollbackIsPlaying ? 'playing' : 'paused', at: Date.now() };
            console.error('[MusicContext] playSong error:', error);
        } finally {
            if (playSessionIdRef.current === sessionId) {
                isPlaySongInProgressRef.current = false;
            }
        }
    }, [broadcastPlaybackState, commitMusicState, getEstimatedPlaybackPosition, isPlayerReady, markLocalInteraction, setPlaybackAnchor]);

    const togglePlayMusic = useCallback(async () => {
        if (!TrackPlayer) {
            console.warn('[MusicContext] togglePlayMusic: TrackPlayer module is missing');
            return;
        }
        if (isPlaySongInProgressRef.current) {
            console.log('[MusicContext] togglePlayMusic: playSong in progress, skipping');
            return;
        }
        if (!isPlayerReady) {
            console.warn('[MusicContext] togglePlayMusic: Player is not ready yet');
            // Try to set it to ready if we have the module
            setIsPlayerReady(true);
        }

        if (!musicStateRef.current.currentSong && queueRef.current.length > 0) {
            await playSong(queueRef.current[0], true);
            return;
        }
        if (!musicStateRef.current.currentSong) {
            console.warn('[MusicContext] togglePlayMusic: no active track to resume');
            return;
        }

        const currentSong = musicStateRef.current.currentSong;
        const wasPlaying = musicStateRef.current.isPlaying;
        const shouldPlay = !wasPlaying;
        const positionMs = getEstimatedPlaybackPosition(currentSong);

        userIntentRef.current = { state: shouldPlay ? 'playing' : 'paused', at: Date.now() };
        markLocalInteraction();
        setPlaybackAnchor(positionMs, shouldPlay, currentSong);
        commitMusicState(prev => ({ ...prev, isPlaying: shouldPlay }));

        try {
            if (shouldPlay) {
                void Promise.resolve(TrackPlayer.play()).catch((e) => {
                    userIntentRef.current = { state: wasPlaying ? 'playing' : 'paused', at: Date.now() };
                    setPlaybackAnchor(positionMs, wasPlaying, currentSong);
                    commitMusicState(prev => ({ ...prev, isPlaying: wasPlaying }));
                    console.warn('[MusicContext] play command failed:', e);
                });
                const isSynced = musicSyncService?.isClockSynced();
                const scheduledTime = Date.now() + 100;
                void broadcastPlaybackState('play', {
                    currentSong,
                    isPlaying: true,
                    positionMs,
                    scheduledStartTime: isSynced ? scheduledTime : undefined,
                }).catch(e => console.warn('[MusicContext] play broadcast failed:', e));
            } else {
                void Promise.resolve(TrackPlayer.pause()).catch((e) => {
                    userIntentRef.current = { state: wasPlaying ? 'playing' : 'paused', at: Date.now() };
                    setPlaybackAnchor(positionMs, wasPlaying, currentSong);
                    commitMusicState(prev => ({ ...prev, isPlaying: wasPlaying }));
                    console.warn('[MusicContext] pause command failed:', e);
                });
                void broadcastPlaybackState('pause', {
                    currentSong,
                    isPlaying: false,
                    positionMs,
                }).catch(e => console.warn('[MusicContext] pause broadcast failed:', e));
            }
        } catch (e) {
            userIntentRef.current = { state: wasPlaying ? 'playing' : 'paused', at: Date.now() };
            setPlaybackAnchor(positionMs, wasPlaying, currentSong);
            commitMusicState(prev => ({ ...prev, isPlaying: wasPlaying }));
            console.warn('[MusicContext] togglePlayMusic failed:', e);
        }
    }, [broadcastPlaybackState, commitMusicState, getEstimatedPlaybackPosition, isPlayerReady, markLocalInteraction, playSong, setPlaybackAnchor]);

    const toggleFavoriteSong = useCallback(async (song: Song) => {
        setMusicState(prev => {
            const isFav = prev.favorites.some(s => s.id === song.id);
            const nextFavs = isFav ? prev.favorites.filter(s => s.id !== song.id) : [...prev.favorites, song];
            if (currentUser) AsyncStorage.setItem(`ss_favorites_${currentUser.id}`, JSON.stringify(nextFavs));
            return { ...prev, favorites: nextFavs };
        });
    }, [currentUser]);


    const getPlaybackPosition = useCallback(async () => {
        const estimatedPosition = getEstimatedPlaybackPosition();
        if (!isPlayerReady || !TrackPlayer) return estimatedPosition;

        void TrackPlayer.getPosition()
            .then((pos: number) => {
                setPlaybackAnchor(pos * 1000, musicStateRef.current.isPlaying, musicStateRef.current.currentSong);
            })
            .catch(() => {});

        return estimatedPosition;
    }, [getEstimatedPlaybackPosition, isPlayerReady, setPlaybackAnchor]);

    const toggleRepeat = useCallback(() => {
        setRepeatMode(prev => prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off');
    }, []);

    const toggleShuffle = useCallback(() => {
        setShuffle(prev => !prev);
    }, []);

    const addToQueue = useCallback((song: Song) => {
        const currentSong = musicStateRef.current.currentSong;
        setQueue(prev => prev.some(s => s.id === song.id) ? prev : [...prev, song]);

        if (!currentSong || !TrackPlayer || !isPlayerReady) return;

        void (async () => {
            try {
                const nativeQueue = await TrackPlayer.getQueue();
                const alreadyQueued = nativeQueue.some((track: any) => String(track.id) === song.id);
                if (!alreadyQueued) {
                    await TrackPlayer.add(songToTrack(song));
                    await refreshQueueFromPlayer();
                }
            } catch (error) {
                console.warn('[MusicContext] addToQueue native sync failed:', error);
            }
        })();
    }, [isPlayerReady, refreshQueueFromPlayer]);

    const removeFromQueue = useCallback((songId: string) => {
        setQueue(prev => prev.filter(s => s.id !== songId));

        if (!TrackPlayer || !isPlayerReady) return;

        void (async () => {
            try {
                const nativeQueue = await TrackPlayer.getQueue();
                const activeIndex = await TrackPlayer.getActiveTrackIndex();
                const queueIndex = nativeQueue.findIndex((track: any) => String(track.id) === songId);
                if (queueIndex > (typeof activeIndex === 'number' ? activeIndex : 0)) {
                    await TrackPlayer.remove(queueIndex);
                    await refreshQueueFromPlayer();
                }
            } catch (error) {
                console.warn('[MusicContext] removeFromQueue native sync failed:', error);
            }
        })();
    }, [isPlayerReady, refreshQueueFromPlayer]);

    const clearQueue = useCallback(() => {
        setQueue([]);

        if (!TrackPlayer || !isPlayerReady) return;

        void (async () => {
            try {
                const nativeQueue = await TrackPlayer.getQueue();
                const activeIndex = await TrackPlayer.getActiveTrackIndex();
                const resolvedIndex = typeof activeIndex === 'number' ? activeIndex : 0;
                const indexesToRemove = nativeQueue
                    .map((_: unknown, index: number) => index)
                    .filter(index => index > resolvedIndex);
                if (indexesToRemove.length > 0) {
                    await TrackPlayer.remove(indexesToRemove);
                }
                await refreshQueueFromPlayer();
            } catch (error) {
                console.warn('[MusicContext] clearQueue native sync failed:', error);
            }
        })();
    }, [isPlayerReady, refreshQueueFromPlayer]);

    const playNext = useCallback(async () => {
        if (!TrackPlayer || !isPlayerReady) return;

        const localQueue = queueRef.current;
        if (!shuffle && localQueue.length > 0) {
            const nextSong = localQueue[0];
            const nextQueue = localQueue.slice(1);
            const shouldKeepPlaying = musicStateRef.current.isPlaying;
            const targetIndex = activeTrackIndexRef.current + 1;

            userIntentRef.current = { state: shouldKeepPlaying ? 'playing' : 'paused', at: Date.now() };
            markLocalInteraction();
            activeTrackIndexRef.current = targetIndex;
            setQueue(nextQueue);
            setPlaybackAnchor(0, shouldKeepPlaying, nextSong);
            commitMusicState(prev => ({ ...prev, currentSong: nextSong, isPlaying: shouldKeepPlaying }));

            void Promise.resolve(TrackPlayer.skip(targetIndex))
                .catch(e => {
                    console.warn('[MusicContext] fast next failed, falling back to playSong:', e);
                    void playSong(nextSong);
                });
            void broadcastPlaybackState('track-change', {
                currentSong: nextSong,
                isPlaying: shouldKeepPlaying,
                positionMs: 0,
            }).catch(e => console.warn('[MusicContext] next broadcast failed:', e));
            return;
        }

        const nativeQueue = await TrackPlayer.getQueue();
        if (nativeQueue.length === 0) {
            if (queueRef.current.length > 0) {
                await playSong(queueRef.current[0]);
            }
            return;
        }

        const activeIndex = await TrackPlayer.getActiveTrackIndex();
        const resolvedIndex = typeof activeIndex === 'number' ? activeIndex : 0;
        let targetIndex = resolvedIndex;

        if (shuffle && nativeQueue.length > 1) {
            const candidates = nativeQueue
                .map((_: unknown, index: number) => index)
                .filter(index => index !== resolvedIndex);
            targetIndex = candidates[Math.floor(Math.random() * candidates.length)];
        } else if (resolvedIndex < nativeQueue.length - 1) {
            targetIndex = resolvedIndex + 1;
        } else if (repeatMode === 'all') {
            targetIndex = 0;
        } else {
            return;
        }

        markLocalInteraction();
        void Promise.resolve(TrackPlayer.skip(targetIndex))
            .catch(e => console.warn('[MusicContext] next skip failed:', e));
        activeTrackIndexRef.current = targetIndex;
    }, [broadcastPlaybackState, commitMusicState, isPlayerReady, markLocalInteraction, playSong, repeatMode, setPlaybackAnchor, shuffle]);

    const playPrevious = useCallback(async () => {
        if (!TrackPlayer || !isPlayerReady) return;

        const currentPosition = getEstimatedPlaybackPosition(musicStateRef.current.currentSong) / 1000;
        if (currentPosition > 3) {
            void seekTo(0);
            return;
        }

        const nativeQueue = await TrackPlayer.getQueue();
        if (nativeQueue.length === 0) return;

        const activeIndex = await TrackPlayer.getActiveTrackIndex();
        const resolvedIndex = typeof activeIndex === 'number' ? activeIndex : 0;
        let targetIndex = resolvedIndex;

        if (resolvedIndex > 0) {
            targetIndex = resolvedIndex - 1;
        } else if (repeatMode === 'all') {
            targetIndex = nativeQueue.length - 1;
        } else {
            void seekTo(0);
            return;
        }

        markLocalInteraction();
        void Promise.resolve(TrackPlayer.skip(targetIndex))
            .catch(e => console.warn('[MusicContext] previous skip failed:', e));
        activeTrackIndexRef.current = targetIndex;
    }, [getEstimatedPlaybackPosition, isPlayerReady, markLocalInteraction, repeatMode, seekTo]);

    // Keep the refs the remote-event handler reads in sync with the
    // freshly memoized playNext/playPrevious whenever queue/shuffle/
    // repeatMode/song change. Without this the bluetooth/lock-screen
    // skip buttons fire the first-render version of these callbacks.
    useEffect(() => {
        playNextRef.current = playNext;
    }, [playNext]);
    useEffect(() => {
        playPreviousRef.current = playPrevious;
    }, [playPrevious]);

    // Sleep timer
    const setSleepTimer = useCallback((minutes: number | null) => {
        if (sleepTimerRef.current) { clearTimeout(sleepTimerRef.current); sleepTimerRef.current = null; }
        setSleepTimerMinutes(minutes);
        if (minutes && minutes > 0) {
            sleepTimerRef.current = setTimeout(async () => {
                if (TrackPlayer) await TrackPlayer.pause();
                setPlaybackAnchor(getEstimatedPlaybackPosition(), false, musicStateRef.current.currentSong);
                commitMusicState(prev => ({ ...prev, isPlaying: false }));
                setSleepTimerMinutes(null);
            }, minutes * 60 * 1000);
        }
    }, [commitMusicState, getEstimatedPlaybackPosition, setPlaybackAnchor]);

    // Auto-play next when song ends (repeat one / queue next)
    useEffect(() => {
        if (!TrackPlayer) return;
        const sub = TrackPlayer.addEventListener?.(TrackPlayerEvents.Event.PlaybackQueueEnded, async () => {
            if (repeatMode === 'one' && musicState.currentSong) {
                await TrackPlayer.seekTo(0);
                await TrackPlayer.play();
            } else if (repeatMode === 'all') {
                const nativeQueue = await TrackPlayer.getQueue();
                if (nativeQueue.length > 0) {
                    await TrackPlayer.skip(0);
                    await TrackPlayer.play().catch(() => {});
                }
            } else {
                setPlaybackAnchor(getEstimatedPlaybackPosition(), false, musicStateRef.current.currentSong);
                commitMusicState(prev => ({ ...prev, isPlaying: false }));
            }
        });
        return () => sub?.remove?.();
    }, [commitMusicState, getEstimatedPlaybackPosition, repeatMode, setPlaybackAnchor, musicState.currentSong]);

    const acceptMusicInvite = useCallback(async () => {
        const invite = pendingMusicInviteRef.current;
        if (!invite) return;
        setPendingMusicInvite(null);
        await playSong(invite.song, false); // false = don't re-broadcast; sync via heartbeat
    }, [playSong]);

    const declineMusicInvite = useCallback(() => {
        setPendingMusicInvite(null);
    }, []);

    const setMusicPartner = useCallback((partnerId: string) => {
        const normalized = normalizeId(partnerId);
        musicSyncService.setPartner(normalized);
        setMusicSyncScope(musicSyncService.getCurrentScope());
    }, []);

    const joinGroupMusicRoom = useCallback((groupId: string) => {
        const normalized = normalizeId(groupId);
        musicSyncService.joinGroupRoom(normalized);
        setMusicSyncScope(musicSyncService.getCurrentScope());
    }, []);

    const leaveGroupMusicRoom = useCallback(async (groupId?: string) => {
        const scope = musicSyncService.getCurrentScope();
        if (scope.type !== 'group') return;
        if (groupId && scope.targetId !== groupId) return;

        await suspendGroupRoomPlayback();
        musicSyncService.leaveGroupRoom(groupId);
        setMusicSyncScope(musicSyncService.getCurrentScope());
    }, [suspendGroupRoomPlayback]);

    const requestMusicSync = useCallback(() => {
        musicSyncService.requestSync();
    }, []);

    const value = {
        musicState, playSong, togglePlayMusic, toggleFavoriteSong, seekTo, getPlaybackPosition,
        repeatMode, toggleRepeat, shuffle, toggleShuffle,
        queue, addToQueue, removeFromQueue, clearQueue, playNext, playPrevious,
        sleepTimerMinutes, setSleepTimer, setMusicPartner, joinGroupMusicRoom, leaveGroupMusicRoom, requestMusicSync, musicSyncScope,
        isSeeking, setIsSeeking,
        playbackOwnerChatId, setPlaybackOwnerChatId,
        lyrics, lyricsLoading, currentLyricIndex, showLyrics, setShowLyrics,
        pendingMusicInvite, acceptMusicInvite, declineMusicInvite,
    };
    return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
};

export const useMusic = () => {
    const context = useContext(MusicContext);
    if (context === undefined) throw new Error('useMusic must be used within a MusicProvider');
    return context;
};
