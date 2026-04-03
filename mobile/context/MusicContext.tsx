import * as React from 'react';
import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { NativeModules, Platform, AppState } from 'react-native';
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
    const hasNativeModule = !!NativeModules.TrackPlayerModule;
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

interface MusicContextType {
    musicState: MusicState;
    playSong: (song: Song, broadcast?: boolean) => Promise<void>;
    togglePlayMusic: () => Promise<void>;
    toggleFavoriteSong: (song: Song) => Promise<void>;
    seekTo: (position: number) => Promise<void>;
    getPlaybackPosition: () => Promise<number>;
}

export const MusicContext = createContext<MusicContextType | undefined>(undefined);

export const MusicProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { currentUser } = useAuth();
    const [musicState, setMusicState] = useState<MusicState>({
        currentSong: null,
        isPlaying: false,
        favorites: []
    });
    const [isPlayerReady, setIsPlayerReady] = useState(false);
    
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
    ], async (event: any) => {
        if (!TrackPlayer) return;
        console.log('[MusicContext] Remote event received:', event.type);
        if (event.type === TrackPlayerEvents.Event.RemotePlay) {
            TrackPlayer.play();
        } else if (event.type === TrackPlayerEvents.Event.RemotePause) {
            TrackPlayer.pause();
        } else if (event.type === TrackPlayerEvents.Event.RemoteNext) {
            TrackPlayer.skipToNext();
        } else if (event.type === TrackPlayerEvents.Event.RemotePrevious) {
            TrackPlayer.skipToPrevious();
        }
    });

    useEffect(() => {
        if (!currentUser) return;
        AsyncStorage.getItem(`ss_favorites_${currentUser.id}`).then(favs => {
            if (favs) setMusicState(prev => ({ ...prev, favorites: JSON.parse(favs) }));
        });
        musicSyncService.initialize(currentUser.id, (remoteState) => {
            // Sync logic...
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
    }, [currentUser]);

    const playSong = useCallback(async (song: Song, broadcast = true) => {
        if (!isPlayerReady || !TrackPlayer) return;
        try {
            console.log('[MusicContext] Playing song:', song.name);
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
            
            await TrackPlayer.play();
            setMusicState(prev => ({ ...prev, currentSong: song, isPlaying: true }));
            
            if (broadcast) {
                musicSyncService.broadcastUpdate({ 
                    currentSong: song, 
                    isPlaying: true, 
                    position: 0 
                });
            }
        } catch (error) {
            console.error('[MusicContext] playSong error:', error);
        }
    }, [isPlayerReady]);

    const togglePlayMusic = useCallback(async () => {
        if (!isPlayerReady || !TrackPlayer) return;
        const state = await TrackPlayer.getState();
        if (state === (TrackPlayerEvents.State?.Playing || 'playing')) {
            await TrackPlayer.pause();
        } else {
            await TrackPlayer.play();
        }
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
    }, [isPlayerReady]);

    const getPlaybackPosition = useCallback(async () => {
        if (!isPlayerReady || !TrackPlayer) return 0;
        const pos = await TrackPlayer.getPosition();
        return pos * 1000;
    }, [isPlayerReady]);

    const value = { musicState, playSong, togglePlayMusic, toggleFavoriteSong, seekTo, getPlaybackPosition };
    return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
};

export const useMusic = () => {
    const context = useContext(MusicContext);
    if (context === undefined) throw new Error('useMusic must be used within a MusicProvider');
    return context;
};
