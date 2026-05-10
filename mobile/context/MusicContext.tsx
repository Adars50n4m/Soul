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
const HEARTBEAT_SUPPRESS_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 1500;

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
    const activeTrackIndexRef = useRef(0);
    const ignoreNextTrackChangeBroadcastRef = useRef(false);
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
                setMusicState(prev => ({ ...prev, currentSong: activeSong }));
            }
        } catch (error) {
            console.warn('[MusicContext] Failed to refresh native queue snapshot:', error);
        }
    }, [isPlayerReady]);

    const broadcastPlaybackState = useCallback(async (
        action: PlaybackAction,
        overrides: Partial<{ currentSong: Song | null; isPlaying: boolean; positionMs: number; scheduledStartTime: number | undefined }> = {}
    ) => {
        const currentSong = overrides.currentSong ?? musicStateRef.current.currentSong;
        if (!currentSong) return;

        const positionMs = overrides.positionMs ?? (
            TrackPlayer
                ? await TrackPlayer.getPosition().then((pos: number) => pos * 1000).catch(() => 0)
                : 0
        );

        musicSyncService.broadcastUpdate({
            currentSong,
            isPlaying: overrides.isPlaying ?? musicStateRef.current.isPlaying,
            position: positionMs,
            scheduledStartTime: overrides.scheduledStartTime,
            action,
        });
    }, []);

    // Internal seek function that doesn't broadcast (used for sync)
    const internalSeek = useCallback(async (seconds: number, shouldPlay = true) => {
        if (!isPlayerReady || !TrackPlayer) return;
        try {
            console.log(`[MusicSync] 🎯 Internal Seek to: ${seconds.toFixed(2)}s (shouldPlay: ${shouldPlay})`);
            await TrackPlayer.seekTo(seconds);
            
            // Wait for a small buffer window if needed
            if (shouldPlay) {
                // Short timeout to let native buffer stabilize
                setTimeout(async () => {
                    const state = await TrackPlayer.getState();
                    if (state !== (TrackPlayerEvents.State?.Playing || 'playing')) {
                        await TrackPlayer.play();
                    }
                }, 150);
            }
        } catch (e) {
            console.warn('[MusicContext] Internal seek failed:', e);
        }
    }, [isPlayerReady]);

    const seekTo = useCallback(async (position: number) => {
        if (!isPlayerReady || !TrackPlayer) return;
        
        try {
            const seconds = position / 1000;
            console.log(`[MusicContext] ⏩ User Seeking to: ${seconds}s`);
            
            setIsSeeking(true);
            markLocalInteraction();
            
            await TrackPlayer.seekTo(seconds);
            
            // Manual user seek SHOULD broadcast
            const isSynced = musicSyncService?.isClockSynced();
            await broadcastPlaybackState('seek', {
                positionMs: position,
                scheduledStartTime: isSynced ? Date.now() + 100 : undefined,
            });

            // Unlock UI after a delay
            setTimeout(() => setIsSeeking(false), 800);
        } catch (error) {
            console.error('[MusicContext] Seek Error:', error);
            setIsSeeking(false);
        }
    }, [broadcastPlaybackState, isPlayerReady, markLocalInteraction]);
    const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);
    const [musicSyncScope, setMusicSyncScope] = useState<MusicSyncScope>({ type: 'none' });
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
    const isPlaying = playbackState?.state === (TrackPlayerEvents.State?.Playing || 'playing');

    useEffect(() => {
        setMusicState(prev => ({ ...prev, isPlaying }));
    }, [isPlaying]);

    const suspendGroupRoomPlayback = useCallback(async () => {
        if (!TrackPlayer) return;
        if (musicSyncService.getCurrentScope().type !== 'group') return;

        try {
            await TrackPlayer.pause();
        } catch (e) {
            console.warn('[MusicContext] suspendGroupRoomPlayback pause failed:', e);
        }

        setMusicState(prev => ({ ...prev, isPlaying: false }));
    }, []);

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
                        waitForBuffer: true,
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
                    // Aggressive buffering for instant seeking
                    minBuffer: 10, // 10s min buffer
                    maxBuffer: 30, // 30s max buffer
                    playBuffer: 0.5, // 0.5s buffer to start playing (FAST!)
                    backBuffer: 15, // 15s back buffer
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
                    progressUpdateEventInterval: 0.25,
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
            setMusicState(prev => ({
                ...prev,
                currentSong: nextSong,
            }));

            if (isProcessingRemoteUpdate.current) return;

            if (ignoreNextTrackChangeBroadcastRef.current) {
                ignoreNextTrackChangeBroadcastRef.current = false;
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
        // Always perform the local action FIRST and verify the engine
        // actually transitioned before telling the partner. The previous
        // pattern (broadcast immediately, then call play() without await)
        // could lie to the partner if buffering failed: they'd see "you
        // resumed" while your device was silent. Now the broadcast is
        // gated on the engine confirming the transition.
        const isPlayingState = (s: any) =>
            s === (TrackPlayerEvents.State?.Playing || 'playing') ||
            s === (TrackPlayerEvents.State?.Buffering || 'buffering');

        if (event.type === TrackPlayerEvents.Event.RemotePlay) {
            try {
                userIntentRef.current = { state: 'playing', at: Date.now() };
                markLocalInteraction();
                await TrackPlayer.play();
                const state = await TrackPlayer.getState();
                if (isPlayingState(state)) {
                    await broadcastPlaybackState('play', {
                        isPlaying: true,
                    });
                } else {
                    console.warn('[MusicContext] RemotePlay did not transition to Playing — skipping broadcast. State:', state);
                }
            } catch (e) {
                console.warn('[MusicContext] RemotePlay failed:', e);
            }
        } else if (event.type === TrackPlayerEvents.Event.RemotePause) {
            try {
                userIntentRef.current = { state: 'paused', at: Date.now() };
                markLocalInteraction();
                await TrackPlayer.pause();
                const state = await TrackPlayer.getState();
                if (!isPlayingState(state)) {
                    await broadcastPlaybackState('pause', {
                        isPlaying: false,
                    });
                } else {
                    console.warn('[MusicContext] RemotePause did not transition to Paused — skipping broadcast. State:', state);
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
        AsyncStorage.getItem(`ss_favorites_${currentUser.id}`).then(favs => {
            if (favs) setMusicState(prev => ({ ...prev, favorites: JSON.parse(favs) }));
        });
        musicSyncService.initialize(currentUser.id, async (remoteState, eventType) => {
            if (isProcessingRemoteUpdate.current) return;
            
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
                        console.log('[MusicSync] 🆕 New song detected — syncing to:', cleanRemoteSong.name);
                        await TrackPlayer.reset();
                        await TrackPlayer.add(songToTrack(cleanRemoteSong));
                        await refreshQueueFromPlayer(cleanRemoteSong);
                        
                        await internalSeek(targetPosSeconds, remoteState.isPlaying);
                        
                        setMusicState(prev => ({
                            ...prev,
                            currentSong: cleanRemoteSong,
                            isPlaying: remoteState.isPlaying,
                        }));
                    } else {
                        // 2. Same song — sync play/pause and position drift
                        if (isSeekLocked) {
                            console.log('[MusicSync] 🛡️ Ignoring remote update due to active interaction lock');
                        } else {
                            const currentLocalPos = await TrackPlayer.getPosition();
                            const posDifference = Math.abs(currentLocalPos - targetPosSeconds);
                            const action = remoteState.action || 'heartbeat';

                            // Explicit seek actions should apply nearly immediately;
                            // passive heartbeats can tolerate a slightly looser drift budget.
                            const isInitialStart = currentLocalPos < 5;
                            const threshold =
                                action === 'seek'
                                    ? 0.15
                                    : action === 'heartbeat'
                                        ? 0.9
                                        : (isInitialStart ? 0.35 : 0.45);

                            if (action === 'seek' || posDifference > threshold) {
                                console.log(`[MusicSync] ⏳ Compensating for ${posDifference.toFixed(2)}s drift (threshold: ${threshold}s)`);
                                await internalSeek(targetPosSeconds, remoteState.isPlaying);
                            }

                            // Play/Pause Sync
                            const playerState = await TrackPlayer.getState();
                            const isActuallyPlaying = playerState === (TrackPlayerEvents.State?.Playing || 'playing') ||
                                                     playerState === (TrackPlayerEvents.State?.Buffering || 'buffering');

                            // Sticky-pause guard: if the user explicitly
                            // paused recently (within 30s), partner's
                            // heartbeats and stale state should NOT flip
                            // us back to play. Pause syncs from partner
                            // are still respected (no harm in a redundant
                            // pause). This is what lets a user hold pause
                            // even when partner is still listening.
                            const userPausedRecently =
                                userIntentRef.current.state === 'paused' &&
                                (Date.now() - userIntentRef.current.at) < 30_000;

                            if (remoteState.isPlaying && !isActuallyPlaying) {
                                if (userPausedRecently) {
                                    console.log('[MusicSync] 🛑 User paused recently — ignoring remote play');
                                } else {
                                    console.log('[MusicSync] ▶️ Partner is playing — resuming locally');
                                    await TrackPlayer.play();
                                }
                            } else if (!remoteState.isPlaying && isActuallyPlaying) {
                                console.log('[MusicSync] ⏸️ Partner paused — pausing locally');
                                await TrackPlayer.pause();
                            }
                        }
                        
                        if (!isSeekingRef.current) {
                            const now = Date.now();
                            if (now - lastSeekTimeRef.current > 2000) {
                                setMusicState(prev => ({ ...prev, isPlaying: remoteState.isPlaying }));
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
    }, [broadcastPlaybackState, currentUser, isPlayerReady, internalSeek, refreshQueueFromPlayer, setPlaybackOwnerChatId]);

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
        // Throttled error logging: tick runs every 250ms; without
        // throttling, a transient TrackPlayer error would spam console
        // hundreds of times per minute. Log at most once per 5s so real
        // errors are visible during diagnosis without drowning the console.
        let lastErrLog = 0;
        const tick = setInterval(async () => {
            try {
                const posSec = await TrackPlayer.getPosition();
                const idx = lyricsService.getCurrentLineIndex(lyrics, posSec);
                setCurrentLyricIndex(prev => (prev === idx ? prev : idx));
            } catch (e) {
                const now = Date.now();
                if (now - lastErrLog > 5000) {
                    console.warn('[MusicContext] Lyrics tick failed:', e);
                    lastErrLog = now;
                }
            }
        }, 250);
        return () => clearInterval(tick);
    }, [musicState.isPlaying, lyrics]);

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

            ignoreNextTrackChangeBroadcastRef.current = true;
            await TrackPlayer.reset();
            
            // Re-apply options just before play to wake up iOS media center
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
            await TrackPlayer.add(playlist.map(songToTrack));
            activeTrackIndexRef.current = 0;
            setQueue(upcomingQueue);
            
            if (broadcast) {
                // Explicit user-initiated playback — clears any sticky
                // pause intent so partner-sync resumes normally.
                userIntentRef.current = { state: 'playing', at: Date.now() };
                markLocalInteraction();

                // Await play() and confirm the engine transitioned before
                // telling the partner. Without the await, if the URL was
                // expired/404 or the codec failed, partner would receive
                // currentSong + isPlaying:true and try to sync to a song
                // we never actually started. Tight bound on the "playing"
                // claim eliminates that ghost-broadcast class of bugs.
                try {
                    await TrackPlayer.play();
                } catch (playErr) {
                    console.error('[MusicContext] playSong: TrackPlayer.play() failed:', playErr);
                    Alert.alert(
                        'Playback Error',
                        'Could not start this track. Please try another song.'
                    );
                    return;
                }

                const isSynced = musicSyncService?.isClockSynced();
                const scheduledTime = Date.now() + 100;

                await broadcastPlaybackState('track-change', {
                    currentSong: cleanSong,
                    isPlaying: true,
                    positionMs: 0,
                    scheduledStartTime: isSynced ? scheduledTime : undefined,
                });
            } else {
                await TrackPlayer.play();
            }
            setMusicState(prev => ({ ...prev, currentSong: cleanSong, isPlaying: true }));
            setTimeout(() => {
                ignoreNextTrackChangeBroadcastRef.current = false;
            }, 1000);
        } catch (error) {
            ignoreNextTrackChangeBroadcastRef.current = false;
            console.error('[MusicContext] playSong error:', error);
        }
    }, [broadcastPlaybackState, isPlayerReady, markLocalInteraction]);

    const togglePlayMusic = useCallback(async () => {
        if (!TrackPlayer) {
            console.warn('[MusicContext] togglePlayMusic: TrackPlayer module is missing');
            return;
        }
        if (!isPlayerReady) {
            console.warn('[MusicContext] togglePlayMusic: Player is not ready yet');
            // Try to set it to ready if we have the module
            setIsPlayerReady(true);
        }

        const state = await TrackPlayer.getState();
        const isPlayingState = (s: any) => 
            s === (TrackPlayerEvents.State?.Playing || 'playing') || 
            s === (TrackPlayerEvents.State?.Buffering || 'buffering');
            
        const wasPlaying = isPlayingState(state);

        if (wasPlaying) {
            try {
                // Mark user intent as paused BEFORE the pause call so that
                // any heartbeat or remote update arriving in the window
                // between pause() and broadcast can't flip us back to play.
                userIntentRef.current = { state: 'paused', at: Date.now() };
                markLocalInteraction();
                await TrackPlayer.pause();
                await broadcastPlaybackState('pause', {
                    isPlaying: false,
                });
                setMusicState(prev => ({ ...prev, isPlaying: false }));
            } catch (e) {
                console.warn('[MusicContext] togglePlayMusic pause failed:', e);
            }
        } else {
            // Await play and verify the engine actually transitioned before
            // broadcasting. The previous code broadcast { isPlaying: true }
            // optimistically and then fired play() without awaiting — if
            // buffering or codec failed, partner saw us as playing while
            // our device was silent. Now we tell the partner only after we
            // know we're actually playing.
            try {
                // Set intent BEFORE play so a partner heartbeat racing in
                // can't be misclassified. Cleared paused-intent here so
                // the remote handler stops blocking play sync.
                userIntentRef.current = { state: 'playing', at: Date.now() };
                markLocalInteraction();
                if (!musicStateRef.current.currentSong && queueRef.current.length > 0) {
                    await playSong(queueRef.current[0], true);
                    return;
                }
                if (!musicStateRef.current.currentSong) {
                    console.warn('[MusicContext] togglePlayMusic: no active track to resume');
                    return;
                }
                await TrackPlayer.play();
                const state = await TrackPlayer.getState();
                const isActuallyPlaying = isPlayingState(state);
                if (!isActuallyPlaying) {
                    console.warn('[MusicContext] togglePlayMusic: play() did not transition to Playing. State:', state);
                    return;
                }
                const isSynced = musicSyncService?.isClockSynced();
                const scheduledTime = Date.now() + 100;
                await broadcastPlaybackState('play', {
                    isPlaying: true,
                    scheduledStartTime: isSynced ? scheduledTime : undefined,
                });
                setMusicState(prev => ({ ...prev, isPlaying: true }));
            } catch (e) {
                console.error('[MusicContext] togglePlayMusic play failed:', e);
            }
        }
    }, [broadcastPlaybackState, isPlayerReady, markLocalInteraction, playSong]);

    const toggleFavoriteSong = useCallback(async (song: Song) => {
        setMusicState(prev => {
            const isFav = prev.favorites.some(s => s.id === song.id);
            const nextFavs = isFav ? prev.favorites.filter(s => s.id !== song.id) : [...prev.favorites, song];
            if (currentUser) AsyncStorage.setItem(`ss_favorites_${currentUser.id}`, JSON.stringify(nextFavs));
            return { ...prev, favorites: nextFavs };
        });
    }, [currentUser]);


    const getPlaybackPosition = useCallback(async () => {
        if (!isPlayerReady || !TrackPlayer) return 0;
        const pos = await TrackPlayer.getPosition();
        return pos * 1000;
    }, [isPlayerReady]);

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
        await TrackPlayer.skip(targetIndex);
        activeTrackIndexRef.current = targetIndex;
    }, [isPlayerReady, markLocalInteraction, playSong, repeatMode, shuffle]);

    const playPrevious = useCallback(async () => {
        if (!TrackPlayer || !isPlayerReady) return;

        const currentPosition = await TrackPlayer.getPosition().catch(() => 0);
        if (currentPosition > 3) {
            await seekTo(0);
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
            await seekTo(0);
            return;
        }

        markLocalInteraction();
        await TrackPlayer.skip(targetIndex);
        activeTrackIndexRef.current = targetIndex;
    }, [isPlayerReady, markLocalInteraction, repeatMode, seekTo]);

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
                setSleepTimerMinutes(null);
            }, minutes * 60 * 1000);
        }
    }, []);

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
                setMusicState(prev => ({ ...prev, isPlaying: false }));
            }
        });
        return () => sub?.remove?.();
    }, [repeatMode, musicState.currentSong]);

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
    };
    return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
};

export const useMusic = () => {
    const context = useContext(MusicContext);
    if (context === undefined) throw new Error('useMusic must be used within a MusicProvider');
    return context;
};
