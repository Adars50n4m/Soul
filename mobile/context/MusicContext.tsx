import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { NativeModules, Platform, AppState, Alert } from 'react-native';
// We import types only to avoid side-effects if the native module is missing
import type { Song, MusicState } from '../types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { musicSyncService } from '../services/MusicSyncService';
import { useAuth } from './AuthContext';

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
    setSleepTimer: (minutes: number | null) => void;
    setMusicPartner: (partnerId: string) => void;
    requestMusicSync: () => void;
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
    const [clockOffset, setClockOffset] = useState(0);
    const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
    const [shuffle, setShuffle] = useState(false);
    const [queue, setQueue] = useState<Song[]>([]);
    const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);
    const sleepTimerRef = useRef<NodeJS.Timeout | null>(null);
    const queueIndexRef = useRef(-1);
    
    // Safely use hooks
    const playbackState = TrackPlayerHooks.usePlaybackState();
    const isPlaying = playbackState?.state === (TrackPlayerEvents.State?.Playing || 'playing');

    useEffect(() => {
        setMusicState(prev => ({ ...prev, isPlaying }));
    }, [isPlaying]);

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
    ], async (event: any) => {
        if (!TrackPlayer) return;
        
        if (event.type === TrackPlayerEvents.Event.PlaybackError) {
            console.error('[MusicContext] ❌ Native Playback Error:', event.message || event.code || event);
            Alert.alert(
                'Playback Error',
                'Could not load this track. Please check your internet connection or try another song.'
            );
            return;
        }

        console.log('[MusicContext] Remote event received:', event.type);
        if (event.type === TrackPlayerEvents.Event.RemotePlay) {
            TrackPlayer.play();
            musicSyncService.broadcastUpdate({ isPlaying: true });
        } else if (event.type === TrackPlayerEvents.Event.RemotePause) {
            TrackPlayer.pause();
            musicSyncService.broadcastUpdate({ isPlaying: false });
        } else if (event.type === TrackPlayerEvents.Event.RemoteNext) {
            playNext();
        } else if (event.type === TrackPlayerEvents.Event.RemotePrevious) {
            playPrevious();
        }
    });

    useEffect(() => {
        if (!currentUser) return;
        AsyncStorage.getItem(`ss_favorites_${currentUser.id}`).then(favs => {
            if (favs) setMusicState(prev => ({ ...prev, favorites: JSON.parse(favs) }));
        });
        musicSyncService.initialize(currentUser.id, async (remoteState, eventType) => {
            // Handle Clock Sync (Ping/Pong)
            if (eventType === 'ping') {
                musicSyncService.sendPong(remoteState.updatedAt);
                return;
            }
            if (eventType === 'pong') {
                const now = Date.now();
                const rtt = now - remoteState.position; // remoteState.position stores our original ping time
                const remoteClockAtTarget = remoteState.updatedAt + (rtt / 2);
                const newOffset = remoteClockAtTarget - now;
                
                // Use a moving average for more stable offset (70% new, 30% old)
                setClockOffset(prev => (prev === 0 ? newOffset : (prev * 0.3 + newOffset * 0.7)));
                console.log(`[MusicSync] ⏱️ Clock sync: offset=${newOffset.toFixed(0)}ms, rtt=${rtt.toFixed(0)}ms`);
                return;
            }

            console.log(`[MusicSync] (${eventType}) Received remote update:`, remoteState.isPlaying, remoteState.currentSong?.name);
            
            // Handle Sync Request: If partner asked for our state, send it immediately
            if (eventType === 'sync_request') {
                const currentPos = await TrackPlayer.getPosition();
                musicSyncService.broadcastUpdate({
                    currentSong: musicStateRef.current.currentSong,
                    isPlaying: musicStateRef.current.isPlaying,
                    position: currentPos * 1000,
                });
                return;
            }

            if (!TrackPlayer || !isPlayerReady) return;

            try {
                // Determine target position with high-precision latency compensation (drift + clock sync)
                const now = Date.now();
                // (now + clockOffset) is our estimate of the PARTNER'S local time right now
                const drift = (now + clockOffset) - remoteState.updatedAt;
                const targetPosSeconds = (remoteState.position + drift) / 1000;

                // 1. If partner started playing a new song
                if (remoteState.currentSong && remoteState.currentSong.url) {
                    const currentSong = musicStateRef.current?.currentSong;
                    if (!currentSong || currentSong.id !== remoteState.currentSong.id) {
                        console.log('[MusicSync] Different song detected — syncing to:', remoteState.currentSong.name);
                        await TrackPlayer.reset();
                        await TrackPlayer.add({
                            id: remoteState.currentSong.id,
                            url: remoteState.currentSong.url,
                            title: remoteState.currentSong.name,
                            artist: remoteState.currentSong.artist,
                            artwork: remoteState.currentSong.image,
                            duration: remoteState.currentSong.duration ? Number(remoteState.currentSong.duration) / 1000 : undefined,
                        });
                        
                        await TrackPlayer.seekTo(targetPosSeconds);
                        
                        if (remoteState.isPlaying) {
                            if (remoteState.scheduledStartTime) {
                                const delay = (remoteState.scheduledStartTime - clockOffset) - Date.now();
                                if (delay > 0) {
                                    console.log(`[MusicSync] ⏱️ Scheduled start in ${delay}ms`);
                                    setTimeout(() => TrackPlayer.play(), delay);
                                } else {
                                    await TrackPlayer.play();
                                }
                            } else {
                                await TrackPlayer.play();
                            }
                        }

                        setMusicState(prev => ({
                            ...prev,
                            currentSong: remoteState.currentSong,
                            isPlaying: remoteState.isPlaying,
                        }));
                    } else {
                        // 2. Same song — sync play/pause and position drift
                        const currentLocalPos = await TrackPlayer.getPosition();
                        const posDifference = Math.abs(currentLocalPos - targetPosSeconds);

                        // Only snap if we are drifting by more than 0.8 seconds (Tighter threshold for near-zero lag)
                        if (posDifference > 0.8) {
                            console.log(`[MusicSync] ⏳ Compensating for ${posDifference.toFixed(2)}s drift`);
                            await TrackPlayer.seekTo(targetPosSeconds);
                        }

                        if (remoteState.isPlaying) {
                            if (remoteState.scheduledStartTime) {
                                const delay = (remoteState.scheduledStartTime - clockOffset) - Date.now();
                                if (delay > 0) {
                                    console.log(`[MusicSync] ⏱️ Scheduled resume in ${delay}ms`);
                                    setTimeout(() => TrackPlayer.play(), delay);
                                } else {
                                    await TrackPlayer.play();
                                }
                            } else {
                                await TrackPlayer.play();
                            }
                        } else {
                            await TrackPlayer.pause();
                        }
                        setMusicState(prev => ({ ...prev, isPlaying: remoteState.isPlaying }));
                    }
                } else if (!remoteState.isPlaying && !remoteState.currentSong) {
                    // Partner stopped playback
                    await TrackPlayer.pause();
                    setMusicState(prev => ({ ...prev, isPlaying: false }));
                }
            } catch (e) {
                console.warn('[MusicSync] Failed to apply remote state:', e);
            }
        });

        // When app comes to foreground, reset retry cap so MusicSync can reconnect
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                musicSyncService.retryNow();
            }
        });

        return () => {
            sub.remove();
            musicSyncService.cleanup();
        };
    }, [currentUser, isPlayerReady]);

    // ── Heartbeat Loop: Ensures real-time alignment during playback ─────────
    useEffect(() => {
        if (!musicState.isPlaying || !musicState.currentSong || !TrackPlayer) return;

        const heartbeat = setInterval(async () => {
            try {
                // Only heartbeat if we have an active channel to broadcast on
                if (musicSyncService.getConnectionStatus() === 'connected') {
                    const pos = await TrackPlayer.getPosition();
                    musicSyncService.broadcastUpdate({
                        currentSong: musicStateRef.current.currentSong,
                        isPlaying: true,
                        position: pos * 1000,
                    });
                }
            } catch (e) {
                console.warn('[MusicContext] Heartbeat failed:', e);
            }
        }, 3000); // 3s heartbeat

        return () => clearInterval(heartbeat);
    }, [musicState.isPlaying, !!musicState.currentSong]);

    // ── Clock Sync Effect: Regularly calibrate clocks when a partner is present ──
    useEffect(() => {
        if (!musicSyncService.partnerId || !currentUser) return;

        // Perform initial sync pings
        const syncInterval = setInterval(() => {
            if (musicSyncService.getConnectionStatus() === 'connected') {
                musicSyncService.sendPing();
            }
        }, 15000); // Re-calibrate every 15s

        // Trigger immediate ping
        setTimeout(() => musicSyncService.sendPing(), 1000);

        return () => clearInterval(syncInterval);
    }, [musicSyncService.partnerId, !!currentUser]);

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

            await TrackPlayer.add({
                id: song.id,
                url: song.url,
                title: song.name,
                artist: song.artist,
                artwork: song.image,
                duration: song.duration ? Number(song.duration) / 1000 : undefined,
            });
            
            if (broadcast) {
                const scheduledTime = Date.now() + 500;
                musicSyncService.broadcastUpdate({ 
                    currentSong: song, 
                    isPlaying: true, 
                    position: 0,
                    scheduledStartTime: scheduledTime
                });
                console.log(`[MusicContext] ⏱️ Local scheduled start in 500ms`);
                setTimeout(() => TrackPlayer.play(), 500);
            } else {
                await TrackPlayer.play();
            }
            setMusicState(prev => ({ ...prev, currentSong: song, isPlaying: true }));
        } catch (error) {
            console.error('[MusicContext] playSong error:', error);
        }
    }, [isPlayerReady]);

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
            await TrackPlayer.pause();
            musicSyncService.broadcastUpdate({
                currentSong: musicStateRef.current.currentSong,
                isPlaying: false,
                position: (await TrackPlayer.getPosition()) * 1000,
            });
        } else {
            const scheduledTime = Date.now() + 500;
            const pos = await TrackPlayer.getPosition();
            musicSyncService.broadcastUpdate({
                currentSong: musicStateRef.current.currentSong,
                isPlaying: true,
                position: pos * 1000,
                scheduledStartTime: scheduledTime
            });
            console.log(`[MusicContext] ⏱️ Local scheduled resume in 500ms`);
            setTimeout(() => TrackPlayer.play(), 500);
        }
        // We rely on the usePlaybackState hook for actual state, but set UI state here for responsiveness
        setMusicState(prev => ({ ...prev, isPlaying: !wasPlaying }));
    }, [isPlayerReady]);

    const toggleFavoriteSong = useCallback(async (song: Song) => {
        setMusicState(prev => {
            const isFav = prev.favorites.some(s => s.id === song.id);
            const nextFavs = isFav ? prev.favorites.filter(s => s.id !== song.id) : [...prev.favorites, song];
            if (currentUser) AsyncStorage.setItem(`ss_favorites_${currentUser.id}`, JSON.stringify(nextFavs));
            return { ...prev, favorites: nextFavs };
        });
    }, [currentUser]);

    const seekTo = useCallback(async (position: number) => {
        if (!isPlayerReady || !TrackPlayer) return;
        await TrackPlayer.seekTo(position / 1000);
        musicSyncService.broadcastUpdate({
            currentSong: musicStateRef.current.currentSong,
            isPlaying: musicStateRef.current.isPlaying,
            position,
        });
    }, [isPlayerReady]);

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
        setQueue(prev => prev.some(s => s.id === song.id) ? prev : [...prev, song]);
    }, []);

    const removeFromQueue = useCallback((songId: string) => {
        setQueue(prev => prev.filter(s => s.id !== songId));
    }, []);

    const clearQueue = useCallback(() => {
        setQueue([]);
        queueIndexRef.current = -1;
    }, []);

    const playNext = useCallback(async () => {
        if (queue.length === 0) return;
        let nextIndex: number;
        if (shuffle) {
            nextIndex = Math.floor(Math.random() * queue.length);
        } else {
            nextIndex = queueIndexRef.current + 1;
            if (nextIndex >= queue.length) {
                if (repeatMode === 'all') nextIndex = 0;
                else return; // End of queue
            }
        }
        queueIndexRef.current = nextIndex;
        await playSong(queue[nextIndex]);
    }, [queue, shuffle, repeatMode, playSong]);

    const playPrevious = useCallback(async () => {
        if (queue.length === 0) return;
        let prevIndex = queueIndexRef.current - 1;
        if (prevIndex < 0) {
            if (repeatMode === 'all') prevIndex = queue.length - 1;
            else prevIndex = 0;
        }
        queueIndexRef.current = prevIndex;
        await playSong(queue[prevIndex]);
    }, [queue, repeatMode, playSong]);

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
        const sub = TrackPlayer.addEventListener?.('playback-queue-ended', async () => {
            if (repeatMode === 'one' && musicState.currentSong) {
                await TrackPlayer.seekTo(0);
                await TrackPlayer.play();
            } else if (queue.length > 0) {
                await playNext();
            }
        });
        return () => sub?.remove?.();
    }, [repeatMode, musicState.currentSong, queue, playNext]);

    const setMusicPartner = useCallback((partnerId: string) => {
        musicSyncService.setPartner(partnerId);
    }, []);

    const requestMusicSync = useCallback(() => {
        musicSyncService.requestSync();
    }, []);

    const value = {
        musicState, playSong, togglePlayMusic, toggleFavoriteSong, seekTo, getPlaybackPosition,
        repeatMode, toggleRepeat, shuffle, toggleShuffle,
        queue, addToQueue, removeFromQueue, clearQueue, playNext, playPrevious,
        sleepTimerMinutes, setSleepTimer, setMusicPartner, requestMusicSync,
    };
    return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
};

export const useMusic = () => {
    const context = useContext(MusicContext);
    if (context === undefined) throw new Error('useMusic must be used within a MusicProvider');
    return context;
};
