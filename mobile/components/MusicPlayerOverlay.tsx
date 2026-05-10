import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, Modal,
    ScrollView, TextInput,
    Dimensions, KeyboardAvoidingView, Platform, Keyboard,
    NativeModules,
} from 'react-native';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import { SoulLoader } from './ui/SoulLoader';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withSequence,
    cancelAnimation,
    interpolate,
    Extrapolation,
    useAnimatedScrollHandler,
    runOnJS,
    FadeIn,
    FadeOut,
    SlideInDown,
    SlideOutDown,
    Easing,
} from 'react-native-reanimated';

// Safe-require useProgress from TrackPlayer. Gives us native-event-driven position
// updates instead of a JS setInterval, freeing the JS thread for touch events.
let useTrackProgress: (interval?: number) => { position: number; buffered: number; duration: number } =
    (_interval?: number) => ({ position: 0, buffered: 0, duration: 0 });
try {
    const hasNative = !!(NativeModules.TrackPlayerModule || NativeModules.RNTrackPlayer);
    if (hasNative) {
        const TP = require('react-native-track-player');
        if (TP.useProgress) useTrackProgress = TP.useProgress;
    }
} catch (_) {}
import { GlassView } from './ui/GlassView';
import { MaterialIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSaavnApiBaseUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { Song } from '../types';
import type { LyricLine } from '../services/LyricsService';

// Cache key for the default music list. The upstream Saavn API
// (saavn.sumit.co) is Cloudflare-fronted and rate-limits aggressively
// (HTTP 429 / Error 1027). Caching the last-good result means a thrott-
// led user still sees something instead of a blank "ALL MUSIC" section.
const SONGS_CACHE_KEY = 'music-overlay-default-songs-v1';
const SONGS_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

const { width, height } = Dimensions.get('window');

interface MusicPlayerOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    contactName?: string;
    // ID of the chat that owns this player instance. Set on the music context
    // whenever a song is played so other chats don't show this chat's song.
    chatId?: string;
}

const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
};

const isAndroid = Platform.OS === 'android';

// Fast timing (not spring) gives crisp Spotify-like press feedback.
// NOT memo'd — memo + GHPressable has known Android gesture-drop issues when
// the onPress prop reference changes every render.
const PlayButton = ({ isPlaying, onPress, accentColor }: { isPlaying: boolean; onPress: () => void; accentColor: string }) => {
    const scale = useSharedValue(1);
    const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
    const lastPressAt = useRef(0);

    const handlePress = () => {
        const now = Date.now();
        if (now - lastPressAt.current < 300) return;
        lastPressAt.current = now;
        scale.value = withSequence(
            withTiming(0.88, { duration: 60 }),
            withTiming(1, { duration: 100 }),
        );
        onPress();
    };

    return (
        <Pressable
            onPress={handlePress}
            android_disableSound
            hitSlop={{ top: 0, bottom: 25, left: 25, right: 25 }}
        >
            <Animated.View style={[styles.playButton, animatedStyle]}>
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={44} color="#000" />
            </Animated.View>
        </Pressable>
    );
};

const IconButton = ({ name, size, color, onPress }: { name: any; size: number; color: string; onPress: () => void }) => {
    const scale = useSharedValue(1);
    const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
    const lastPressAt = useRef(0);

    const handlePress = () => {
        const now = Date.now();
        if (now - lastPressAt.current < 300) return;
        lastPressAt.current = now;
        scale.value = withSequence(
            withTiming(0.78, { duration: 60 }),
            withTiming(1, { duration: 100 }),
        );
        onPress();
    };

    return (
        <Pressable
            onPress={handlePress}
            android_disableSound
            hitSlop={{ top: 4, bottom: 20, left: 20, right: 20 }}
        >
            <Animated.View style={animStyle}>
                <MaterialIcons name={name} size={size} color={color} />
            </Animated.View>
        </Pressable>
    );
};

// Animated artwork that smoothly changes when song changes
const ArtworkView = ({
    uri,
    showLyrics,
    lyrics,
    currentLyricIndex,
    lyricsScrollRef,
    themeAccent,
    isPlaying,
    onLyricPress,
}: any) => {
    const opacity = useSharedValue(1);
    const prevUri = useRef(uri);

    useEffect(() => {
        if (uri !== prevUri.current) {
            // Fade out → swap image → fade in
            opacity.value = withSequence(
                withTiming(0, { duration: 180, easing: Easing.out(Easing.ease) }),
                withTiming(1, { duration: 300, easing: Easing.in(Easing.ease) })
            );
            prevUri.current = uri;
        }
    }, [uri]);

    const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

    return (
        <Animated.View style={[styles.artworkWrapper, animStyle, showLyrics && styles.lyricsActiveWrapper]}>
            {showLyrics && lyrics.length > 0 ? (
                <View style={styles.lyricsWideContainer}>
                    <ScrollView
                        ref={lyricsScrollRef}
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={{ paddingVertical: 20 }}
                    >
                        {lyrics.map((line: LyricLine, idx: number) => (
                            <Pressable
                                key={idx}
                                onPress={() => onLyricPress?.(line)}
                                hitSlop={6}
                            >
                                <Text
                                    style={[
                                        styles.lyricLine,
                                        idx === currentLyricIndex && styles.lyricLineActive
                                    ]}
                                >
                                    {line.text}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            ) : (
                <>
                    <Image source={{ uri: uri || 'https://via.placeholder.com/300' }} style={styles.artwork} />
                    <View style={[styles.artworkOverlay, { backgroundColor: themeAccent + '33' }]} />
                    {isPlaying && (
                        <Animated.View
                            entering={FadeIn.duration(250)}
                            exiting={FadeOut.duration(200)}
                            style={[styles.equalizerBadge, { backgroundColor: themeAccent }]}
                        >
                            <MaterialIcons name="graphic-eq" size={16} color="#fff" />
                        </Animated.View>
                    )}
                </>
            )}
        </Animated.View>
    );
};

export const MusicPlayerOverlay: React.FC<MusicPlayerOverlayProps> = ({
    isOpen,
    onClose,
    contactName,
    chatId,
}) => {
    const { musicState, playSong, togglePlayMusic, toggleFavoriteSong, getPlaybackPosition, seekTo, activeTheme, musicSyncScope,
        repeatMode, toggleRepeat, shuffle, toggleShuffle, queue, addToQueue, removeFromQueue, clearQueue, playNext, playPrevious, isSeeking, setIsSeeking,
        setPlaybackOwnerChatId,
        lyrics, currentLyricIndex, showLyrics, setShowLyrics } = useApp() as any;

    // Wrap playSong so this chat is recorded as the playback owner. Other chats
    // hide their music UI when their id doesn't match.
    const playSongInThisChat = useCallback((song: Song) => {
        if (chatId) setPlaybackOwnerChatId(chatId);
        return playSong(song);
    }, [chatId, playSong, setPlaybackOwnerChatId]);
    const themeAccent = activeTheme?.primary || '#fff';
    const [searchResults, setSearchResults] = useState<Song[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [fetchError, setFetchError] = useState<'rate-limited' | 'network' | 'empty' | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [activeTab, setActiveTab] = useState<'music' | 'favorites' | 'queue'>('music');
    const displayedSongs = activeTab === 'favorites'
        ? musicState.favorites
        : activeTab === 'queue'
            ? queue
            : searchResults;

    // Local mirror of context showLyrics — updates immediately on tap without
    // waiting for the MusicContext → AppContext → component re-render chain.
    const [localShowLyrics, setLocalShowLyrics] = useState(showLyrics);
    useEffect(() => { setLocalShowLyrics(showLyrics); }, [showLyrics]);

    const lyricsScrollRef = useRef<ScrollView>(null);

    // Native-event-driven position (no JS setInterval). Fires every 1000ms via
    // TrackPlayer's internal progress tracking — JS thread is free between events.
    const trackProgress = useTrackProgress(1000);

    // displayIsPlaying flips instantly on tap (local state, no context round-trip).
    // isPlayingRef prevents stale-closure issues in the press handler.
    // The useEffect always re-syncs to ground truth so if a toggle fails on Android
    // (e.g. TrackPlayer busy) we snap back to the real state within one event cycle.
    const isPlayingRef = useRef(musicState.isPlaying);
    const [displayIsPlaying, setDisplayIsPlaying] = useState(musicState.isPlaying);
    useEffect(() => {
        isPlayingRef.current = musicState.isPlaying;
        setDisplayIsPlaying(musicState.isPlaying);
    }, [musicState.isPlaying]);

    const handleInstantTogglePlay = useCallback(() => {
        const next = !isPlayingRef.current;
        isPlayingRef.current = next;
        setDisplayIsPlaying(next);
        togglePlayMusic();
    }, [togglePlayMusic]);
    const miniPlayPressHandledRef = useRef(false);
    const handleMiniPlayPressIn = useCallback(() => {
        if (!isAndroid) return;
        miniPlayPressHandledRef.current = true;
        handleInstantTogglePlay();
    }, [handleInstantTogglePlay]);
    const handleMiniPlayPress = useCallback(() => {
        if (isAndroid && miniPlayPressHandledRef.current) {
            miniPlayPressHandledRef.current = false;
            return;
        }
        handleInstantTogglePlay();
    }, [handleInstantTogglePlay]);

    // Playback State
    const [duration, setDuration] = useState(0);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const scrubThumbScale = useSharedValue(1);
    const animatedScrubThumbStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scrubThumbScale.value }],
    }));
    const [seekPosition, setSeekPosition] = useState(0);

    // ─── Reanimated Shared Values ────────────────────────────────────────────
    const slideY = useSharedValue(height);          // Sheet slide in/out
    const scrollY = useSharedValue(0);              // Scroll position for PIP transition
    const backdropOpacity = useSharedValue(0);      // Backdrop fade
    const expandedBaseHeight = useSharedValue(395); // Dynamic height to prevent lyrics overlap

    // Expand the header when lyrics are active. Lyrics artworkWrapper is 270px tall
    // vs artwork's 200px — the 70px overflow pushes controls into the search bar.
    useEffect(() => {
        expandedBaseHeight.value = withSpring(localShowLyrics ? 465 : 395, {
            damping: 28,
            stiffness: 180,
        });
    }, [localShowLyrics]);

    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const scrollViewRef = useRef<any>(null);

    // Keep the modal mounted through the slide-out so the closing animation
    // can actually play. Without this, `isOpen=false` would return null on the
    // next render and tear the component down before the spring runs.
    const [shouldRender, setShouldRender] = useState(isOpen);

    // ─── Sheet open/close animation ─────────────────────────────────────────
    useEffect(() => {
        if (isOpen) {
            setShouldRender(true);
            // Reset scroll to top
            scrollY.value = 0;
            setTimeout(() => scrollViewRef.current?.scrollTo({ y: 0, animated: false }), 50);

            // Slide up with spring
            slideY.value = withSpring(0, {
                damping: 26,
                stiffness: 200,
                mass: 1,
                overshootClamping: false,
            });
            backdropOpacity.value = withTiming(1, { duration: 250 });

            if (searchResults.length === 0) {
                // Hydrate from cache immediately so the list isn't blank while
                // the network request is in flight (or while CF is rate-limited).
                loadCachedSongs().then((cached) => {
                    if (cached && cached.length > 0 && searchResults.length === 0) {
                        setSearchResults(cached);
                    }
                });
                fetchSongs();
            }
        } else {
            backdropOpacity.value = withTiming(0, { duration: 220 });
            slideY.value = withSpring(height, {
                damping: 28,
                stiffness: 280,
                mass: 0.8,
                overshootClamping: true,
            }, (finished) => {
                if (finished) {
                    runOnJS(setShouldRender)(false);
                }
            });
        }
    }, [isOpen]);

    // ─── Keyboard listeners ─────────────────────────────────────────────────
    useEffect(() => {
        const show = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
            () => setKeyboardVisible(true)
        );
        const hide = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
            () => setKeyboardVisible(false)
        );
        return () => { show.remove(); hide.remove(); };
    }, []);

    // ─── Scroll handler (Reanimated) ────────────────────────────────────────
    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollY.value = event.contentOffset.y;
        },
    });

    // ─── PIP interpolations (all on UI thread) ───────────────────────────────
    // The header collapses from `expandedBaseHeight` down to the 86px mini bar.
    // The collapse must finish at exactly `expandedBaseHeight - 86` of scroll —
    // any other range leaves a gap (or overlap) between the mini bar and the
    // search input below the spacer. See spacerStyle: spacer is fixed at
    // `expandedBaseHeight`, so when scrollY = base - 86, search is visible at
    // exactly 86px from top, which is also where the collapsed header ends.
    const headerOverlayStyle = useAnimatedStyle(() => {
        'worklet';
        const collapseEnd = Math.max(40, expandedBaseHeight.value - 86);
        const h = interpolate(scrollY.value, [0, collapseEnd], [expandedBaseHeight.value, 86], Extrapolation.CLAMP);
        const bg = interpolate(scrollY.value, [0, collapseEnd * 0.75], [0, 0.98], Extrapolation.CLAMP);
        return {
            height: h,
            backgroundColor: `rgba(10,10,10,${bg})`,
        };
    });

    const fullPlayerStyle = useAnimatedStyle(() => {
        'worklet';
        const collapseEnd = Math.max(40, expandedBaseHeight.value - 86);
        const opacity = interpolate(scrollY.value, [0, collapseEnd * 0.4], [1, 0], Extrapolation.CLAMP);
        const scale = interpolate(scrollY.value, [0, collapseEnd], [1, 0.45], Extrapolation.CLAMP);
        return { opacity, transform: [{ scale }] };
    });

    const miniPlayerStyle = useAnimatedStyle(() => {
        'worklet';
        const collapseEnd = Math.max(40, expandedBaseHeight.value - 86);
        const opacity = interpolate(scrollY.value, [collapseEnd * 0.5, collapseEnd * 0.8], [0, 1], Extrapolation.CLAMP);
        return { opacity };
    });

    // Drag handle fades OUT as mini player fades IN — they merge into one bar
    const dragHandleOpacity = useAnimatedStyle(() => {
        'worklet';
        const collapseEnd = Math.max(40, expandedBaseHeight.value - 86);
        const opacity = interpolate(scrollY.value, [collapseEnd * 0.3, collapseEnd * 0.65], [1, 0], Extrapolation.CLAMP);
        return { opacity };
    });

    // ─── Sheet + backdrop animated styles ────────────────────────────────────
    const sheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: slideY.value }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: backdropOpacity.value,
    }));

    const spacerStyle = useAnimatedStyle(() => ({
        height: expandedBaseHeight.value,
    }));

    // Position for time labels + display. Sourced from useTrackProgress when the native
    // hook delivers real values; falls back to a 1s timer via getPlaybackPosition so
    // the time counter always increments even if useProgress isn't available on this build.
    const [position, setPosition] = useState(0);

    useEffect(() => {
        if (trackProgress.position > 0) {
            setPosition(trackProgress.position);
        }
    }, [trackProgress.position]);

    // Fallback 1s timer — only active when useTrackProgress returns zeros (not available).
    useEffect(() => {
        if (!musicState.isPlaying || isSeeking || isScrubbing) return;
        if (trackProgress.position > 0 || trackProgress.duration > 0) return; // native hook active
        const timer = setInterval(async () => {
            const pos = await getPlaybackPosition();
            setPosition(pos / 1000);
        }, 1000);
        return () => clearInterval(timer);
    }, [musicState.isPlaying, isSeeking, isScrubbing, trackProgress.position, trackProgress.duration]);

    // ─── Lyrics scroll — track current line ─────────────────────────────────
    const lastScrolledLyricRef = useRef(-1);
    useEffect(() => {
        if (localShowLyrics && lyrics.length > 0 && currentLyricIndex >= 0 &&
            currentLyricIndex !== lastScrolledLyricRef.current) {
            lastScrolledLyricRef.current = currentLyricIndex;
            // animated:false — was true. With currentLyricIndex updating every
            // 250 ms, animated:true spawned a new scroll animation on every tick,
            // competing with touch events and causing severe Android jank.
            lyricsScrollRef.current?.scrollTo({
                y: Math.max(0, currentLyricIndex * 22 - 40),
                animated: false,
            });
        }
    }, [currentLyricIndex, localShowLyrics]);

    useEffect(() => {
        if (musicState.currentSong?.duration) {
            setDuration(Number(musicState.currentSong.duration));
        } else {
            setDuration(240);
        }
    }, [musicState.currentSong]);

    // No syncPosition needed — useTrackProgress already reflects current state.

    // ─── Song fetch ──────────────────────────────────────────────────────────
    const loadCachedSongs = async (): Promise<Song[] | null> => {
        try {
            const raw = await AsyncStorage.getItem(SONGS_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed?.songs || !Array.isArray(parsed.songs)) return null;
            if (Date.now() - (parsed.timestamp || 0) > SONGS_CACHE_TTL_MS) return null;
            return parsed.songs as Song[];
        } catch {
            return null;
        }
    };

    const fetchSongs = async (query = 'Hindi Trending Top 20', isDefault = true) => {
        setIsLoading(true);
        setFetchError(null);
        try {
            const baseApiUrl = getSaavnApiBaseUrl();
            if (!baseApiUrl) {
                console.warn('[MusicPlayerOverlay] No Saavn API URL configured.');
                setFetchError('network');
                setSearchResults([]);
                return;
            }
            const url = `${baseApiUrl}/search/songs?query=${encodeURIComponent(query)}&limit=50`;
            // Explicit headers — saavn.sumit is Cloudflare-fronted; default RN
            // User-Agent sometimes gets a challenge page. Even with these, CF
            // rate limits with 429 (Error 1027) when the host is hot, which
            // we handle explicitly below.
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': `Soul/1.0 (${Platform.OS})`,
                },
            });
            const text = await response.text();

            // Cloudflare 429 — fall back to cached songs so the list isn't blank.
            if (response.status === 429) {
                console.warn('[MusicPlayerOverlay] Saavn rate-limited (429).');
                const cached = isDefault ? await loadCachedSongs() : null;
                if (cached && cached.length > 0) {
                    console.log(`[MusicPlayerOverlay] Using ${cached.length} cached songs.`);
                    setSearchResults(cached);
                    setFetchError(null);
                } else {
                    setSearchResults([]);
                    setFetchError('rate-limited');
                }
                return;
            }

            if (!response.ok) {
                console.warn(`[MusicPlayerOverlay] HTTP ${response.status} from Saavn:`, text.slice(0, 200));
                const cached = isDefault ? await loadCachedSongs() : null;
                if (cached && cached.length > 0) {
                    setSearchResults(cached);
                } else {
                    setSearchResults([]);
                    setFetchError('network');
                }
                return;
            }

            let data: any;
            try {
                data = JSON.parse(text);
            } catch {
                console.warn('[MusicPlayerOverlay] Non-JSON response (likely CF challenge):', text.slice(0, 200));
                const cached = isDefault ? await loadCachedSongs() : null;
                if (cached && cached.length > 0) {
                    setSearchResults(cached);
                } else {
                    setSearchResults([]);
                    setFetchError('rate-limited');
                }
                return;
            }

            if (data?.success && data?.data?.results) {
                const songs = data.data.results.map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    artist: s.artists?.primary?.map((a: any) => a.name).join(', ') || s.primaryArtists || 'Unknown',
                    image: s.image?.[s.image.length - 1]?.url || s.image?.[1]?.url || '',
                    url: s.downloadUrl?.[s.downloadUrl.length - 1]?.url || '',
                    duration: s.duration || 0,
                })).filter((s: Song) => s.url);
                console.log(`[MusicPlayerOverlay] Loaded ${songs.length} songs for "${query}"`);
                setSearchResults(songs);
                if (isDefault && songs.length > 0) {
                    AsyncStorage.setItem(SONGS_CACHE_KEY, JSON.stringify({
                        songs,
                        timestamp: Date.now(),
                    })).catch((e) => console.warn('[MusicPlayerOverlay] Cache write failed:', e));
                }
            } else {
                console.warn('[MusicPlayerOverlay] API returned no results. Shape:',
                    JSON.stringify({ success: data?.success, hasData: !!data?.data, hasResults: !!data?.data?.results }));
                setSearchResults([]);
                setFetchError('empty');
            }
        } catch (error) {
            console.warn('[MusicPlayerOverlay] Failed to fetch songs:', error);
            const cached = isDefault ? await loadCachedSongs() : null;
            if (cached && cached.length > 0) {
                setSearchResults(cached);
            } else {
                setSearchResults([]);
                setFetchError('network');
            }
        } finally {
            setIsLoading(false);
        }
    };

    const handleSearch = () => {
        if (searchQuery.trim()) fetchSongs(searchQuery, false);
    };

    const isFavorite = (song: Song) => musicState.favorites.some((s: any) => s.id === song.id);
    const progressBarRef = useRef<View>(null);

    const progressBarWidthShared = useSharedValue(width - 48);
    const seekSettleTimer = useRef<any>(null);

    // UI-thread-driven progress (0..1). Gesture scrubs set it directly.
    // During playback we launch a continuous withTiming to end-of-track so the
    // bar moves at 60fps (Spotify-style) instead of jumping every 1s.
    const scrubPercent = useSharedValue(0);
    const isScrubbingShared = useSharedValue(false);

    useEffect(() => {
        if (isScrubbing || duration <= 0) return;
        // Use `position` state (reliable, from either useTrackProgress or fallback timer).
        const pos = position;
        const pct = Math.min(pos / duration, 1);
        cancelAnimation(scrubPercent);
        scrubPercent.value = pct;
        if (displayIsPlaying && pos < duration) {
            // Animate the bar continuously to end-of-track on the UI thread (60fps, zero JS load).
            scrubPercent.value = withTiming(1, {
                duration: (duration - pos) * 1000,
                easing: Easing.linear,
            });
        }
    }, [position, displayIsPlaying, isScrubbing, duration]);

    const commitSeek = useCallback(async (targetSec: number) => {
        setSeekPosition(targetSec);
        // Cancel smooth animation and pin to seek target immediately.
        cancelAnimation(scrubPercent);
        scrubPercent.value = duration > 0 ? Math.min(targetSec / duration, 1) : 0;

        if (seekSettleTimer.current) clearTimeout(seekSettleTimer.current);

        // Fire and forget seek to avoid blocking UI thread
        seekTo(targetSec * 1000).catch(e => console.warn('[MusicPlayerOverlay] seek failed:', e));

        // native player takes some time to report the new position. 
        // 800ms is safer for jittery networks/older devices.
        seekSettleTimer.current = setTimeout(() => {
            setIsScrubbing(false);
            setIsSeeking(false);
            seekSettleTimer.current = null;
        }, 800);
    }, [seekTo, setIsSeeking, duration]);

    const beginScrub = useCallback(() => {
        if (seekSettleTimer.current) {
            clearTimeout(seekSettleTimer.current);
            seekSettleTimer.current = null;
        }
        setIsScrubbing(true);
        setIsSeeking(true);
    }, [setIsSeeking]);

    const updateScrubPosition = useCallback((targetSec: number) => {
        setSeekPosition(targetSec);
    }, []);

    useEffect(() => () => {
        if (seekSettleTimer.current) clearTimeout(seekSettleTimer.current);
    }, []);

    // Pan handles drag-to-scrub. Pan with minDistance(0) doesn't reliably fire
    // onEnd for a pure tap, so we compose with Tap which always commits on lift.
    const panGesture = Gesture.Pan()
        .minDistance(0)
        .onBegin((e) => {
            'worklet';
            isScrubbingShared.value = true;
            const w = progressBarWidthShared.value || 1;
            const percent = Math.max(0, Math.min(1, e.x / w));
            scrubPercent.value = percent;
            scrubThumbScale.value = withTiming(1.4, { duration: 80 });
            runOnJS(beginScrub)();
            runOnJS(updateScrubPosition)(percent * duration);
        })
        .onUpdate((e) => {
            'worklet';
            const w = progressBarWidthShared.value || 1;
            const percent = Math.max(0, Math.min(1, e.x / w));
            scrubPercent.value = percent;
            runOnJS(updateScrubPosition)(percent * duration);
        })
        .onEnd((e) => {
            'worklet';
            const w = progressBarWidthShared.value || 1;
            const percent = Math.max(0, Math.min(1, e.x / w));
            scrubPercent.value = percent;
            scrubThumbScale.value = withTiming(1, { duration: 120 });
            isScrubbingShared.value = false;
            runOnJS(commitSeek)(percent * duration);
        })
        .onFinalize(() => {
            'worklet';
            scrubThumbScale.value = withTiming(1, { duration: 120 });
            isScrubbingShared.value = false;
        });

    const tapGesture = Gesture.Tap()
        .maxDuration(400)
        .onEnd((e, success) => {
            'worklet';
            if (!success) return;
            const w = progressBarWidthShared.value || 1;
            const percent = Math.max(0, Math.min(1, e.x / w));
            scrubPercent.value = percent;
            runOnJS(commitSeek)(percent * duration);
        });

    const seekGesture = Gesture.Exclusive(panGesture, tapGesture);

    const animatedProgressFillStyle = useAnimatedStyle(() => ({
        width: `${scrubPercent.value * 100}%`,
    }));

    const animatedThumbPositionStyle = useAnimatedStyle(() => ({
        left: `${scrubPercent.value * 100}%`,
    }));

    const currentDisplayPosition = isScrubbing ? seekPosition : position;

    if (!shouldRender) return null;

    return (
        <Modal
            transparent
            visible={shouldRender}
            animationType="none"
            onRequestClose={onClose}
            statusBarTranslucent={true}
        >
            {/* Modals mount in a separate native view tree on iOS — gestures inside
                require their own GestureHandlerRootView, the outer one in _layout
                doesn't reach in here. */}
            <GestureHandlerRootView style={{ flex: 1 }}>
            {/* Backdrop */}
            <Animated.View style={[StyleSheet.absoluteFill, styles.backdropBase, backdropStyle]}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
            </Animated.View>

            {/* Sheet Panel */}
            <Animated.View style={[
                styles.overlay,
                sheetStyle,
                keyboardVisible && { height: '100%', top: 100 }
            ]}>
                <GlassView intensity={80} tint="dark" style={styles.glassContainer}>
                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        style={{ flex: 1 }}
                    >
                        <Animated.View style={[styles.dragHandleContainer, dragHandleOpacity]}>
                            <View style={styles.dragHandle} />
                        </Animated.View>

                        <View style={styles.contentContainer}>
                            <Animated.ScrollView
                                ref={scrollViewRef}
                                showsVerticalScrollIndicator={false}
                                onScroll={scrollHandler}
                                scrollEventThrottle={16}
                                style={{ width: '100%' }}
                                contentContainerStyle={[styles.scrollContent, { alignItems: 'stretch' }]}
                                keyboardShouldPersistTaps="handled"
                            >
                                {/* Spacer below player header — now dynamic to prevent overlap */}
                                <Animated.View style={spacerStyle} />

                                {/* Search */}
                                <View style={[styles.searchContainer, keyboardVisible && { marginTop: 40 }]}>
                                    <GlassView intensity={30} tint="light" style={styles.searchInputWrapper}>
                                        <MaterialIcons name="search" size={20} color="rgba(255,255,255,0.5)" style={{ marginRight: 10 }} />
                                        <TextInput
                                            style={styles.searchInput}
                                            placeholder="Search songs, artists..."
                                            placeholderTextColor="rgba(255,255,255,0.3)"
                                            value={searchQuery}
                                            onChangeText={setSearchQuery}
                                            onSubmitEditing={handleSearch}
                                            returnKeyType="search"
                                        />
                                    </GlassView>
                                </View>

                                {/* Song List / Queue */}
                                <View style={styles.listContainer}>
                                    <View style={styles.listHeader}>
                                        <Text style={styles.listTitle}>
                                            {activeTab === 'favorites' ? 'FAVORITES' : activeTab === 'queue' ? 'UP NEXT' : 'ALL MUSIC'}
                                        </Text>
                                        {activeTab === 'queue' && queue.length > 0 && (
                                            <Pressable onPress={clearQueue} hitSlop={10}>
                                                <Text style={{ color: themeAccent, fontSize: 10, fontWeight: '700' }}>CLEAR</Text>
                                            </Pressable>
                                        )}
                                    </View>

                                    {isLoading ? (
                                        <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                                            <SoulLoader size={80} />
                                        </View>
                                    ) : displayedSongs.length === 0 ? (
                                        <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 }}>
                                            <MaterialIcons
                                                name={activeTab === 'favorites' ? 'favorite-border' : activeTab === 'queue' ? 'queue-music' : fetchError === 'rate-limited' ? 'cloud-off' : 'music-off'}
                                                size={36}
                                                color="rgba(255,255,255,0.18)"
                                            />
                                            <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, marginTop: 12, fontWeight: '600', textAlign: 'center' }}>
                                                {activeTab === 'favorites'
                                                    ? 'No favorites yet'
                                                    : activeTab === 'queue'
                                                        ? 'Queue is empty'
                                                        : searchQuery
                                                            ? `No results for "${searchQuery}"`
                                                            : fetchError === 'rate-limited'
                                                                ? 'Music service is busy'
                                                                : fetchError === 'network'
                                                                    ? 'Network error'
                                                                    : 'No songs available'}
                                            </Text>
                                            {activeTab === 'music' && !searchQuery && fetchError === 'rate-limited' && (
                                                <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 6, textAlign: 'center', lineHeight: 16 }}>
                                                    The Saavn API is temporarily rate-limited. Try again in a minute.
                                                </Text>
                                            )}
                                            {activeTab === 'music' && !searchQuery && (
                                                <Pressable
                                                    onPress={() => fetchSongs()}
                                                    style={{ marginTop: 16, paddingVertical: 9, paddingHorizontal: 20, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' }}
                                                >
                                                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.5 }}>RETRY</Text>
                                                </Pressable>
                                            )}
                                        </View>
                                    ) : (
                                        displayedSongs.map((song: Song) => (
                                            <SongCard
                                                key={song.id}
                                                song={song}
                                                isActive={musicState.currentSong?.id === song.id}
                                                isFav={isFavorite(song)}
                                                inQueue={queue.some((s: any) => s.id === song.id)}
                                                themeAccent={themeAccent}
                                                onPlay={() => playSongInThisChat(song)}
                                                onFav={() => toggleFavoriteSong(song)}
                                                onQueue={() => addToQueue(song)}
                                            />
                                        ))
                                    )}
                                    <View style={{ height: keyboardVisible ? 250 : 120 }} />
                                </View>
                            </Animated.ScrollView>

                            {/* Floating Tab Bar */}
                            {!keyboardVisible && (
                                <TabBar
                                    activeTab={activeTab}
                                    setActiveTab={setActiveTab}
                                    themeAccent={themeAccent}
                                />
                            )}
                        </View>

                        {/* TRANSFORMED HEADER LAYER */}
                        {!keyboardVisible && (
                            <Animated.View style={[styles.headerOverlay, headerOverlayStyle]} pointerEvents="box-none">

                                {/* Full Player */}
                                <Animated.View style={[styles.fullPlayerContent, fullPlayerStyle]} pointerEvents="auto">
                                    <ArtworkView
                                        uri={musicState.currentSong?.image}
                                        showLyrics={localShowLyrics}
                                        lyrics={lyrics}
                                        currentLyricIndex={currentLyricIndex}
                                        lyricsScrollRef={lyricsScrollRef}
                                        themeAccent={themeAccent}
                                        isPlaying={displayIsPlaying}
                                        onLyricPress={(line: LyricLine) => {
                                            setSeekPosition(line.time);
                                            commitSeek(line.time);
                                        }}
                                    />

                                    <View style={styles.trackInfo}>
                                        <Text style={styles.trackTitle} numberOfLines={1}>
                                            {musicState.currentSong?.name || 'Select a Song'}
                                        </Text>
                                        <Text style={[styles.trackArtist, { color: themeAccent }]} numberOfLines={1}>
                                            {musicState.currentSong?.artist || 'Soul Music'}
                                        </Text>
                                        {musicSyncScope?.type === 'group' && (
                                            <Text style={[styles.roomSyncLabel, { color: themeAccent }]}>
                                                LIVE IN ROOM
                                            </Text>
                                        )}
                                    </View>

                                    <View style={styles.progressBarContainer}>
                                        <GestureDetector gesture={seekGesture}>
                                            <View
                                                ref={progressBarRef}
                                                onLayout={(e) => {
                                                    progressBarWidthShared.value = e.nativeEvent.layout.width;
                                                }}
                                                style={styles.progressBarTouchArea}
                                                collapsable={false}
                                            >
                                                <View style={styles.progressBar} pointerEvents="none">
                                                    <Animated.View style={[styles.progressFill, { backgroundColor: themeAccent }, animatedProgressFillStyle]} />
                                                    <Animated.View
                                                        style={[
                                                            styles.progressThumb,
                                                            { backgroundColor: themeAccent },
                                                            animatedThumbPositionStyle,
                                                            animatedScrubThumbStyle,
                                                        ]}
                                                    />
                                                </View>
                                            </View>
                                        </GestureDetector>
                                        <View style={styles.timeLabels}>
                                            <Text style={styles.timeText}>{formatTime(currentDisplayPosition)}</Text>
                                            <Text style={styles.timeText}>{formatTime(duration)}</Text>
                                        </View>
                                    </View>

                                    {/* Controls */}
                                    <View style={styles.playerBottomContainer}>
                                        <View style={styles.controlsRow}>
                                            <IconButton name="shuffle" size={24} color={shuffle ? themeAccent : 'rgba(255,255,255,0.4)'} onPress={toggleShuffle} />
                                            <IconButton name="skip-previous" size={36} color="rgba(255,255,255,0.7)" onPress={playPrevious} />
                                            <PlayButton isPlaying={displayIsPlaying} onPress={handleInstantTogglePlay} accentColor={themeAccent} />
                                            <IconButton name="skip-next" size={36} color="rgba(255,255,255,0.7)" onPress={playNext} />
                                            <IconButton name="lyrics" size={24} color={localShowLyrics ? themeAccent : 'rgba(255,255,255,0.4)'} onPress={() => {
                                                const next = !localShowLyrics;
                                                setLocalShowLyrics(next);
                                                setShowLyrics(next);
                                            }} />
                                        </View>
                                    </View>
                                </Animated.View>

                                {/* Mini Player — includes drag pill to merge with handle */}
                                <Animated.View style={[styles.miniPlayerContent, miniPlayerStyle]}>
                                    {/* Embedded drag pill at top center */}
                                    <View style={styles.miniDragPill} pointerEvents="none">
                                        <View style={styles.miniDragHandle} />
                                    </View>
                                    {/* Row content */}
                                    <View style={styles.miniRow}>
                                        <Image
                                            source={{ uri: musicState.currentSong?.image || 'https://via.placeholder.com/100' }}
                                            style={styles.miniArtwork}
                                        />
                                        <View style={styles.miniDetails}>
                                            <Text style={styles.miniTitle} numberOfLines={1}>
                                                {musicState.currentSong?.name || 'Select a Song'}
                                            </Text>
                                            <Text style={[styles.miniArtist, { color: themeAccent }]} numberOfLines={1}>
                                                {musicState.currentSong?.artist || 'Soul Music'}
                                            </Text>
                                            {musicSyncScope?.type === 'group' && (
                                                <Text style={[styles.roomSyncLabelMini, { color: themeAccent }]}>
                                                    ROOM LIVE
                                                </Text>
                                            )}
                                        </View>
                                        <Pressable
                                            onPress={handleMiniPlayPress}
                                            onPressIn={handleMiniPlayPressIn}
                                            unstable_pressDelay={0}
                                            android_disableSound
                                            style={styles.miniPlayBtn}
                                            hitSlop={15}
                                        >
                                            <MaterialIcons
                                                name={displayIsPlaying ? 'pause-circle' : 'play-circle'}
                                                size={32}
                                                color="#fff"
                                            />
                                        </Pressable>
                                    </View>
                                </Animated.View>
                            </Animated.View>
                        )}
                    </KeyboardAvoidingView>
                </GlassView>
            </Animated.View>
            </GestureHandlerRootView>
        </Modal>
    );
};

// ─── SongCard with press animation ───────────────────────────────────────────
const SongCard = React.memo(({ song, isActive, isFav, inQueue, themeAccent, onPlay, onFav, onQueue }: any) => {
    const scale = useSharedValue(1);
    const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

    return (
        <Pressable
            onPress={onPlay}
            onPressIn={() => { scale.value = withSpring(0.97, { damping: 20, stiffness: 300 }); }}
            onPressOut={() => { scale.value = withSpring(1, { damping: 15, stiffness: 200 }); }}
        >
            <Animated.View style={[styles.songCard, animStyle, isActive && { borderColor: themeAccent + '44', backgroundColor: themeAccent + '11' }]}>
                <Image source={{ uri: song.image }} style={styles.songThumb} />
                <View style={styles.songDetails}>
                    <Text style={[styles.songName, isActive && { color: themeAccent }]} numberOfLines={1}>{song.name}</Text>
                    <Text style={styles.songArtist} numberOfLines={1}>{song.artist}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <Pressable onPress={onQueue} hitSlop={8}>
                        <MaterialIcons name="playlist-add" size={20} color={inQueue ? themeAccent : 'rgba(255,255,255,0.3)'} />
                    </Pressable>
                    <Pressable onPress={onFav}>
                        <MaterialIcons
                            name={isFav ? 'favorite' : 'favorite-border'}
                            size={18}
                            color={isFav ? themeAccent : 'rgba(255,255,255,0.1)'}
                        />
                    </Pressable>
                </View>
            </Animated.View>
        </Pressable>
    );
});

// ─── Tab Bar with animated indicator ─────────────────────────────────────────
const TABS = [
    { key: 'favorites', label: 'Favorites', icon: 'favorite' },
    { key: 'queue',     label: 'Queue',     icon: 'queue-music' },
    { key: 'music',     label: 'Music',     icon: 'library-music' },
] as const;

const TabBar = ({ activeTab, setActiveTab, themeAccent }: any) => {
    const indicatorX = useSharedValue(0);
    const tabWidth = ((Dimensions.get('window').width * 0.85) - 10) / 3;

    const indicatorStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: indicatorX.value }],
    }));

    const handleTabPress = (key: string, index: number) => {
        indicatorX.value = withSpring(index * tabWidth, { damping: 20, stiffness: 200 });
        setActiveTab(key);
    };

    // Sync indicator to initial active tab
    useEffect(() => {
        const idx = TABS.findIndex(t => t.key === activeTab);
        indicatorX.value = idx * tabWidth;
    }, []);

    return (
        <View style={styles.floatingTabsContainer}>
            <GlassView intensity={40} tint="dark" style={styles.floatingTabs}>
                {/* Animated indicator */}
                <Animated.View
                    style={[
                        {
                            position: 'absolute',
                            left: 5,
                            top: 5,
                            width: tabWidth - 4,
                            bottom: 5,
                            borderRadius: 40,
                            backgroundColor: themeAccent + '26',
                            borderWidth: 1,
                            borderColor: themeAccent + '66',
                        },
                        indicatorStyle,
                    ]}
                    pointerEvents="none"
                />
                {TABS.map((tab, index) => {
                    const isActive = activeTab === tab.key;
                    return (
                        <Pressable
                            key={tab.key}
                            style={styles.tabItem}
                            onPress={() => handleTabPress(tab.key, index)}
                        >
                            <MaterialIcons
                                name={tab.icon as any}
                                size={18}
                                color={isActive ? themeAccent : 'rgba(255,255,255,0.4)'}
                            />
                            <Text style={[styles.tabText, isActive && { color: themeAccent }]}>
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </GlassView>
        </View>
    );
};

const styles = StyleSheet.create({
    backdropBase: {
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    overlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '85%',
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -10 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
        elevation: 20,
    },
    glassContainer: {
        flex: 1,
        backgroundColor: 'rgba(15, 15, 15, 0.65)',
    },
    dragHandleContainer: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    dragHandle: {
        width: 48,
        height: 5,
        borderRadius: 3,
        backgroundColor: 'rgba(255,255,255,0.2)',
    },
    contentContainer: {
        flex: 1,
        alignItems: 'stretch',
    },
    headerOverlay: {
        position: 'absolute',
        top: 0,        // Start at very top — mini player covers drag handle area
        left: 0,
        right: 0,
        zIndex: 100,
        paddingTop: 0,
    },
    fullPlayerContent: {
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingTop: 35,   // Shift everything up (was 50)
    },
    miniPlayerContent: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 86,           // drag pill (18px) + content row (56px) + padding
        flexDirection: 'column',
        backgroundColor: 'transparent',
        paddingTop: 4,
    },
    miniDragPill: {
        alignItems: 'center',
        paddingBottom: 6,
        paddingTop: 2,
    },
    miniDragHandle: {
        width: 48,
        height: 5,
        borderRadius: 3,
        backgroundColor: 'rgba(255,255,255,0.22)',
    },
    miniRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    miniArtwork: {
        width: 48,
        height: 48,
        borderRadius: 8,
        marginRight: 16,
    },
    miniDetails: {
        flex: 1,
        justifyContent: 'center',
    },
    miniTitle: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
        marginBottom: 2,
    },
    miniArtist: {
        fontSize: 11,
        fontWeight: '600',
    },
    roomSyncLabelMini: {
        fontSize: 9,
        fontWeight: '800',
        letterSpacing: 0.8,
        marginTop: 2,
    },
    miniPlayBtn: {
        padding: 4,
    },
    artworkWrapper: {
        width: 200,
        height: 200,
        marginBottom: 12,  // Tighter vertical flow (was 20)
        borderRadius: 24,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
        position: 'relative',
        backgroundColor: 'transparent',
    },
    lyricsActiveWrapper: {
        width: '100%',
        height: 270,       // Slightly shorter to keep layout compact
        shadowOpacity: 0,
        borderRadius: 0,
    },
    lyricsWideContainer: {
        ...StyleSheet.absoluteFillObject,
        paddingHorizontal: 10,
    },
    artwork: {
        width: '100%',
        height: '100%',
        borderRadius: 24,
    },
    artworkOverlay: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 24,
    },
    equalizerBadge: {
        position: 'absolute',
        bottom: -10,
        right: -10,
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: '#0f0f0f',
    },
    trackInfo: {
        alignItems: 'center',
        marginBottom: 12, // Tighter (was 16)
        width: '100%',
    },
    trackTitle: {
        color: '#fff',
        fontSize: 20,
        fontWeight: '700',
        marginBottom: 4,
    },
    trackArtist: {
        fontSize: 13,
        fontWeight: '600',
    },
    roomSyncLabel: {
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 1,
        marginTop: 6,
    },
    playerBottomContainer: {
        width: '100%',
        height: 110,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: -35,
    },
    lyricLine: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 18,
        fontWeight: '600',
        textAlign: 'center',
        marginVertical: 8,
        paddingHorizontal: 20,
    },
    lyricLineActive: {
        color: '#fff',
        fontSize: 24,
        fontWeight: '800',
    },
    progressBarContainer: {
        width: '100%',
        marginBottom: 18, // Tighter (was 24)
        justifyContent: 'center',
    },
    progressBarTouchArea: {
        height: 20, // Tighter touch target (was 36) to prevent stealing button taps
        marginVertical: 0,
        justifyContent: 'center',
        zIndex: 50,
    },
    progressBar: {
        height: 4,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 2,
        justifyContent: 'center',
    },
    progressFill: {
        height: '100%',
        borderRadius: 2,
    },
    progressThumb: {
        position: 'absolute',
        width: 12,
        height: 12,
        borderRadius: 6,
        marginLeft: -6,
    },
    timeLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: -4,
    },
    timeText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 10,
        fontWeight: '500',
    },
    controlsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 20,
        marginBottom: 10,
        zIndex: 20,
    },
    playButton: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: '#fff',
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: 'rgba(255,255,255,0.3)',
        shadowRadius: 20,
        shadowOpacity: 0.6,
        elevation: 5,
    },
    searchContainer: {
        width: '100%',
        paddingHorizontal: 24,
        marginBottom: 24,
    },
    searchInputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        overflow: 'hidden',
    },
    searchInput: {
        flex: 1,
        color: '#fff',
        fontSize: 14,
    },
    listContainer: {
        flex: 1,
        width: '100%',
        paddingHorizontal: 24,
    },
    listHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
        paddingHorizontal: 8,
    },
    listTitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 2,
        textTransform: 'uppercase',
    },
    scrollContent: {
        paddingBottom: 200,
    },
    songCard: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
        marginBottom: 10,
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.04)',
    },
    songThumb: {
        width: 44,
        height: 44,
        borderRadius: 8,
        marginRight: 14,
        backgroundColor: '#222',
    },
    songDetails: {
        flex: 1,
    },
    songName: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
        marginBottom: 2,
    },
    songArtist: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 10,
    },
    floatingTabsContainer: {
        position: 'absolute',
        bottom: 42,
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    floatingTabs: {
        flexDirection: 'row',
        borderRadius: 50,
        padding: 5,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        backgroundColor: 'rgba(20,20,20,0.6)',
        width: '85%',
    },
    tabItem: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 10,
        gap: 6,
        borderRadius: 40,
    },
    tabText: {
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 1,
        color: 'rgba(255,255,255,0.4)',
    },
});

export default MusicPlayerOverlay;
