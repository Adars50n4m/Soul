import React, { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
import {
    View, Text, Image, TextInput, Pressable, StyleSheet, StatusBar,
    FlatList, useWindowDimensions, ActivityIndicator, ImageBackground,
    KeyboardAvoidingView, Platform, Keyboard, ScrollView
} from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import GlassView from '../components/ui/GlassView';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withTiming,
    FadeInDown, 
    runOnJS,
    interpolate,
    Extrapolation
} from 'react-native-reanimated';
import { useApp } from '../context/AppContext';
import { getSaavnApiUrl } from '../config/api';
import { lyricsService, LyricLine } from '../services/LyricsService';



// Constants
const MAGENTA = '#ff0080';
const BG_DARK = '#050505';

// Song Interface
interface Song {
    id: string;
    name: string;
    artist: string;
    image: string;
    url: string;
    duration?: number;
}

// Memoized Song Item for performance
const SongItem = memo(({
    item,
    isCurrent,
    isFavorite,
    onPress,
    onLongPress,
    magentaColor
}: {
    item: Song;
    isCurrent: boolean;
    isFavorite: boolean;
    onPress: (song: Song) => void;
    onLongPress?: (song: Song) => void;
    magentaColor: string;
}) => {
    return (
        <Pressable
            onPress={() => onPress(item)}
            onLongPress={() => onLongPress?.(item)}
            delayLongPress={400}
            style={[styles.songItem, isCurrent && styles.songItemActive]}
        >
            {!!item.image ? (
                <Image source={{ uri: item.image }} style={styles.songThumb} />
            ) : (
                <View style={[styles.songThumb, { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }]}>
                    <MaterialIcons name="music-note" size={20} color="rgba(255,255,255,0.2)" />
                </View>
            )}
            <View style={styles.songInfo}>
                <Text style={styles.songName} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.songArtistName} numberOfLines={1}>{item.artist}</Text>
            </View>
            <View style={styles.songAction}>
                <MaterialIcons 
                    name="favorite" 
                    size={18} 
                    color={isFavorite ? magentaColor : 'rgba(255,255,255,0.1)'} 
                />
            </View>
        </Pressable>
    );
});

// Memoized Header to fix keyboard dismissal
const ListHeader = memo(({
    currentSong,
    isPlaying,
    progress,
    playbackMs,
    onTogglePlay,
    onSeek,
    onNext,
    onPrevious,
    repeatMode,
    onToggleRepeat,
    shuffle,
    onToggleShuffle,
    searchQuery,
    onSearchChange,
    activeTab,
    isKeyboardVisible,
    formatClock,
    showLyrics,
    onToggleLyrics,
    lyricsAvailable,
    lyricsLines,
    lyricsLoading,
    currentLyricIndex,
    onSeekLyric,
    magentaColor,
}: any) => {
    return (
        <View style={[styles.overlayHeader, isKeyboardVisible && { paddingBottom: 0 }]}>
            {/* Top area: either Artwork+Info OR Lyrics (toggled) */}
            {showLyrics && !isKeyboardVisible && currentSong ? (
                <Animated.View entering={FadeInDown.duration(300)} style={{ height: 220, marginBottom: 4, width: '100%', paddingHorizontal: 4 }}>
                    {/* Compact song name + close */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                        <View style={{ flex: 1 }}>
                            <Text style={{ color: magentaColor, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>LYRICS</Text>
                            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 1 }} numberOfLines={1}>
                                {currentSong.name} — {currentSong.artist}
                            </Text>
                        </View>
                        <Pressable onPress={onToggleLyrics} hitSlop={10} style={{ padding: 5, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 16 }}>
                            <MaterialIcons name="close" size={14} color="rgba(255,255,255,0.5)" />
                        </Pressable>
                    </View>
                    {/* Progress */}
                    <View style={[styles.progressBarWrapper, { marginBottom: 4 }]}>
                        <Pressable onPress={onSeek} hitSlop={{ top: 10, bottom: 10 }}>
                            <View style={styles.progressBarBg}>
                                <View style={[styles.progressBarFill, { width: `${progress}%` }]} />
                            </View>
                        </Pressable>
                        <View style={styles.timeLabels}>
                            <Text style={styles.timeText}>{formatClock(playbackMs / 1000)}</Text>
                            <Text style={styles.timeText}>{formatClock(currentSong.duration || 0)}</Text>
                        </View>
                    </View>
                    {/* Scrollable lyrics */}
                    {lyricsLoading ? (
                        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <ActivityIndicator color={magentaColor} size="small" />
                        </View>
                    ) : lyricsLines.length === 0 ? (
                        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                            <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 12 }}>No lyrics available</Text>
                        </View>
                    ) : (
                        <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled fadingEdgeLength={30}>
                            {lyricsLines.map((line: any, idx: number) => {
                                const isCurrent = idx === currentLyricIndex;
                                const isPast = idx < currentLyricIndex;
                                return (
                                    <Pressable key={idx} onPress={() => onSeekLyric(line.time * 1000)} style={{ paddingVertical: 3 }}>
                                        <Text style={{
                                            fontSize: isCurrent ? 18 : 13,
                                            fontWeight: isCurrent ? '800' : '400',
                                            color: isCurrent ? '#fff' : isPast ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.25)',
                                            lineHeight: isCurrent ? 24 : 18,
                                        }}>{line.text}</Text>
                                    </Pressable>
                                );
                            })}
                            <View style={{ height: 20 }} />
                        </ScrollView>
                    )}
                </Animated.View>
            ) : (
                <View style={[styles.playerInfoRow, isKeyboardVisible && { marginBottom: 16 }]}>
                    <View style={[styles.artworkWrapper, isKeyboardVisible && { width: 60, height: 60, borderRadius: 12 }]}>
                        {currentSong && currentSong.image ? (
                            <Image source={{ uri: currentSong.image }} style={styles.artwork} />
                        ) : (
                            <View style={[styles.artwork, { backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' }]}>
                                <MaterialIcons name="music-note" size={isKeyboardVisible ? 30 : 60} color="rgba(255,255,255,0.1)" />
                            </View>
                        )}
                        <LinearGradient colors={['transparent', 'rgba(255,0,128,0.2)']} style={StyleSheet.absoluteFill} />
                    </View>
                    <View style={styles.playerTextContainer}>
                        <Text style={[styles.overlayTrackTitle, isKeyboardVisible && { fontSize: 16 }]} numberOfLines={1}>
                            {currentSong?.name || "Choose a song"}
                        </Text>
                        <Text style={[styles.overlayTrackArtist, isKeyboardVisible && { fontSize: 12 }]} numberOfLines={1}>
                            {currentSong?.artist || "Search to start listening"}
                        </Text>
                        {!isKeyboardVisible && (
                            <View style={styles.progressBarWrapper}>
                                <Pressable onPress={onSeek} hitSlop={{ top: 10, bottom: 10 }}>
                                    <View style={styles.progressBarBg}>
                                        <View style={[styles.progressBarFill, { width: `${progress}%` }]} />
                                    </View>
                                </Pressable>
                                <View style={styles.timeLabels}>
                                    <Text style={styles.timeText}>{formatClock(playbackMs / 1000)}</Text>
                                    <Text style={styles.timeText}>{currentSong ? formatClock(currentSong.duration || 0) : "No Media"}</Text>
                                </View>
                            </View>
                        )}
                    </View>
                </View>
            )}

            {/* Controls Row — shuffle, prev, play, next, repeat, LYRICS icon */}
            {!isKeyboardVisible && (
                <View style={styles.controlsRow}>
                    <Pressable onPress={onToggleShuffle} hitSlop={8}>
                        <MaterialIcons name="shuffle" size={20} color={shuffle ? magentaColor : 'rgba(255,255,255,0.3)'} />
                    </Pressable>
                    <Pressable onPress={onPrevious} hitSlop={8}>
                        <MaterialIcons name="skip-previous" size={34} color="rgba(255,255,255,0.7)" />
                    </Pressable>
                    <Pressable
                        onPress={() => currentSong ? onTogglePlay() : null}
                        style={[styles.playButton, !currentSong && { opacity: 0.5 }]}
                    >
                        <MaterialIcons name={isPlaying ? "pause" : "play-arrow"} size={44} color="#000" />
                    </Pressable>
                    <Pressable onPress={onNext} hitSlop={8}>
                        <MaterialIcons name="skip-next" size={34} color="rgba(255,255,255,0.7)" />
                    </Pressable>
                    <Pressable onPress={onToggleRepeat} hitSlop={8}>
                        <MaterialIcons
                            name={repeatMode === 'one' ? 'repeat-one' : 'repeat'}
                            size={20}
                            color={repeatMode !== 'off' ? magentaColor : 'rgba(255,255,255,0.3)'}
                        />
                    </Pressable>
                    {currentSong && (
                        <Pressable onPress={onToggleLyrics} hitSlop={8}>
                            <MaterialIcons name="lyrics" size={20} color={showLyrics ? magentaColor : 'rgba(255,255,255,0.3)'} />
                        </Pressable>
                    )}
                </View>
            )}

            <View style={[
                styles.searchSection,
                isKeyboardVisible && styles.searchSectionKeyboard
            ]}>
                <GlassView intensity={35} tint="dark" style={styles.searchBar}>
                    <MaterialIcons name="search" size={20} color="rgba(255,0,128,0.8)" />
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Search songs, artists..."
                        placeholderTextColor="rgba(255,255,255,0.3)"
                        value={searchQuery}
                        onChangeText={onSearchChange}
                        returnKeyType="search"
                        autoCorrect={false}
                        autoCapitalize="none"
                    />
                </GlassView>
            </View>

            {!isKeyboardVisible && (
                <View style={styles.listHeader}>
                    <Text style={styles.listTitle}>
                        {activeTab === 'music'
                            ? (searchQuery ? `RESULTS FOR "${searchQuery.toUpperCase()}"` : 'TRENDING HINDI SONGS')
                            : activeTab === 'favorites' ? 'FAVORITES'
                            : activeTab === 'queue' ? 'UP NEXT'
                            : 'LYRICS'}
                    </Text>
                    <MaterialIcons name="filter-list" size={18} color="rgba(255,255,255,0.2)" />
                </View>
            )}
        </View>
    );
});

export default function MusicScreen() {
    const { width, height } = useWindowDimensions();
    const router = useRouter();
    const { activeTheme, musicState, currentUser, playSong, togglePlayMusic, toggleFavoriteSong, startCall, getPlaybackPosition, seekTo, repeatMode, toggleRepeat, shuffle, toggleShuffle, queue, addToQueue, playNext, playPrevious, sleepTimerMinutes, setSleepTimer } = useApp() as any;
    const themeAccent = activeTheme?.primary || MAGENTA;

    const [activeTab, setActiveTab] = useState<'music' | 'favorites' | 'lyrics' | 'queue'>('music');
    const [searchQuery, setSearchQuery] = useState('');
    const [songs, setSongs] = useState<Song[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [playbackMs, setPlaybackMs] = useState(0);
    const lastClickTime = useRef<{ [key: string]: number }>({});
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const isMountedRef = useRef(true);

    // Lyrics state
    const [lyrics, setLyrics] = useState<LyricLine[]>([]);
    const [lyricsLoading, setLyricsLoading] = useState(false);
    const [currentLyricIndex, setCurrentLyricIndex] = useState(0);
    const [showLyrics, setShowLyrics] = useState(false);
    const [recommendedSongs, setRecommendedSongs] = useState<Song[]>([]);
    const lyricsListRef = useRef<FlatList>(null);
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Animations
    const slideY = useSharedValue(height);

    const navigation = useNavigation();
    const closeScreen = () => {
        if (navigation.canGoBack()) {
            navigation.goBack();
            return;
        }
        router.back();
    };

    const handleClose = () => {
        slideY.value = withTiming(height, { duration: 220 }, (finished) => {
            if (finished) {
                runOnJS(closeScreen)();
            }
        });
    };

    useEffect(() => {
        // Open the music overlay
        slideY.value = withTiming(0, { duration: 220 });

        // Initial Load Logic:
        // Fetch Bollywood Trending but DO NOT auto-play.
        searchSongs('Hindi Trending Top 20'); 

        const showSub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
        const hideSub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
        return () => {
            isMountedRef.current = false;
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    const overlayStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: slideY.value }]
    }));

    const backgroundStyle = useAnimatedStyle(() => ({
        opacity: interpolate(slideY.value, [0, height], [1, 1], Extrapolation.CLAMP), // Keep base backdrop stable
    }));

    const backdropBlurOpacity = useAnimatedStyle(() => ({
        opacity: interpolate(slideY.value, [0, height], [1, 0], Extrapolation.CLAMP),
    }));

    // Real Progress Sync
    useEffect(() => {
        let interval: any;
        if (musicState.isPlaying) {
            interval = setInterval(async () => {
                const pos = await getPlaybackPosition();
                const duration = musicState.currentSong?.duration || 240; // Default 4 mins if unknown
                // Convert duration to ms for calculation
                const progressPercent = (pos / (duration * 1000)) * 100;
                setProgress(progressPercent);
                setPlaybackMs(pos);
                // Sync lyrics highlight
                if (lyrics.length > 0) {
                    const idx = lyricsService.getCurrentLineIndex(lyrics, pos / 1000);
                    if (idx !== currentLyricIndex) {
                        setCurrentLyricIndex(idx);
                    }
                }
            }, 1000);
        }
        return () => clearInterval(interval);
    }, [musicState.isPlaying, musicState.currentSong]);

    useEffect(() => {
        // Reset when switching songs
        setPlaybackMs(0);
        setProgress(0);
        setShowLyrics(false);

        // Fetch lyrics + recommended songs
        const song = musicState.currentSong;
        if (song) {
            setLyricsLoading(true);
            setLyrics([]);
            lyricsService.getLyrics(song.name, song.artist, song.duration)
                .then(result => { if (result) setLyrics(result.lines); })
                .finally(() => setLyricsLoading(false));

            const apiUrl = getSaavnApiUrl();
            if (apiUrl) {
                fetch(`${apiUrl}/songs/${song.id}/suggestions?limit=10`)
                    .then(r => r.ok ? r.json() : null)
                    .then((data: any) => {
                        if (data?.data) {
                            const recs = data.data.map((s: any) => transformSong(s)).filter(Boolean);
                            setRecommendedSongs(recs);
                        }
                    })

                    .catch(() => setRecommendedSongs([]));
            }
        } else {
            setLyrics([]);
            setRecommendedSongs([]);
        }
    }, [musicState.currentSong?.id]);

    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);

    const transformSong = (s: any): Song => {
        try {
            if (!s) return { id: Math.random().toString(), name: 'Unknown', artist: 'Unknown', image: '', url: '' };

            let imageUrl = 'https://images.unsplash.com/photo-1614850523296-d8c1af93d400?w=400&h=400&fit=crop';
            if (Array.isArray(s.image) && s.image.length > 0) {
                imageUrl = s.image[s.image.length - 1]?.url || s.image[0]?.url || imageUrl;
            } else if (typeof s.image === 'string' && s.image) {
                imageUrl = s.image;
            }

            let downloadUrl = '';
            if (Array.isArray(s.downloadUrl) && s.downloadUrl.length > 0) {
                downloadUrl = s.downloadUrl[s.downloadUrl.length - 1]?.url || s.downloadUrl[0]?.url || '';
            } else if (typeof s.downloadUrl === 'string') {
                downloadUrl = s.downloadUrl;
            }

            let artistName = 'Unknown Artist';
            if (s.artists?.primary && Array.isArray(s.artists.primary)) {
                artistName = s.artists.primary.map((a: any) => a.name).join(', ');
            } else if (typeof s.primaryArtists === 'string') {
                artistName = s.primaryArtists;
            } else if (s.artist) {
                artistName = s.artist;
            }

            return {
                id: s.id?.toString() || Math.random().toString(),
                name: s.name || s.title || 'Unknown Title',
                artist: artistName || 'Unknown Artist',
                image: imageUrl,
                url: downloadUrl,
                duration: typeof s.duration === 'number' ? s.duration : 0,
            };
        } catch (e) {
            console.error('[Music] Transform Error:', e);
            return { id: Math.random().toString(), name: 'Error', artist: 'Error', image: '', url: '' };
        }
    };

    const searchSongs = useCallback(async (query: string, newSearch = true) => {
        try {
            if (!query.trim()) {
                if (isMountedRef.current) setSongs([]);
                return;
            }

            // Cancel previous request if any
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            // Create new abort controller for this request
            abortControllerRef.current = new AbortController();

            if (newSearch) {
                if (isMountedRef.current) {
                    setIsLoading(true);
                    setPage(1);
                    setHasMore(true);
                }
            }

            const currentPage = newSearch ? 1 : page;
            const limit = 40;
            const apiUrl = getSaavnApiUrl();
            const cleanBaseUrl = apiUrl.replace(/\/$/, '');
            const baseApiUrl = cleanBaseUrl.endsWith('/api') ? cleanBaseUrl : `${cleanBaseUrl}/api`;
            const url = `${baseApiUrl}/search/songs?query=${encodeURIComponent(query)}&page=${currentPage}&limit=${limit}`;

            console.log(`[Music] Searching URL: ${url}`);

            const response = await fetch(url, {
                signal: abortControllerRef.current.signal
            });

            if (!isMountedRef.current) return;

            const text = await response.text();
            if (!isMountedRef.current) return;

            // console.log('[Music] Response length:', text.length);

            let data;
            try {
                data = JSON.parse(text);
            } catch (jsonError) {
                console.warn('[Music] JSON Parse Error:', jsonError);
                if (isMountedRef.current) {
                    if (newSearch) setSongs([]);
                    setIsLoading(false);
                }
                return;
            }

            if (!isMountedRef.current) return;

            if (data?.success && data?.data?.results) {
                const resultsArray = Array.isArray(data.data.results) ? data.data.results : [];

                if (resultsArray.length === 0) {
                    if (isMountedRef.current) {
                        if (newSearch) setSongs([]);
                        setHasMore(false);
                        setIsLoading(false);
                    }
                    return;
                }

                const rawResults = resultsArray
                    .map((item: any) => transformSong(item))
                    .filter((s: Song) => s.url); // Filter out songs without URL

                // Deduplicate by ID
                const uniqueResults = Array.from(new Map(rawResults.map((s: Song) => [s.id, s])).values()) as Song[];

                console.log(`[Music] Found ${uniqueResults.length} valid songs`);

                if (!isMountedRef.current) return;

                if (newSearch) {
                    setSongs(uniqueResults);
                } else {
                    setSongs(prev => {
                        const combined = [...prev, ...uniqueResults];
                         return Array.from(new Map(combined.map((s: Song) => [s.id, s])).values()) as Song[];
                    });
                }

                if (uniqueResults.length < limit) {
                    setHasMore(false);
                } else {
                    setPage(prev => prev + 1);
                }
                setIsLoading(false);
            } else {
                console.log('[Music] API returned success=false or no data');
                if (isMountedRef.current) {
                    if (newSearch) setSongs([]);
                    setHasMore(false);
                }
            }
        } catch (error: any) {
            // Don't log abort errors as they're expected when cancelling requests
            if (error?.name !== 'AbortError') {
                console.warn('[Music] Search error:', error?.message || error);
            }
            if (isMountedRef.current && newSearch && error?.name !== 'AbortError') {
                setSongs([]);
            }
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [page]);

    const loadMore = () => {
        if (activeTab !== 'music') return;
        if (!isLoading && hasMore && searchQuery.trim()) {
            searchSongs(searchQuery, false);
        }
    };

    // Debounced search as user types (like Saavn app)
    const handleSearchInput = useCallback((text: string) => {
        setSearchQuery(text);

        // Clear previous timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
            searchTimeoutRef.current = null;
        }

        // Cancel ongoing request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }

        // Debounce search - trigger after 500ms of user stopping typing
        if (text.trim().length >= 2) {
            setIsLoading(true);
            searchTimeoutRef.current = setTimeout(() => {
                if (isMountedRef.current) {
                    searchSongs(text, true);
                }
            }, 500);
        } else if (text.trim().length === 0) {
            // Clear results if search is empty
            setSongs([]);
            setIsLoading(false);
        } else {
            // Less than 2 characters
            setIsLoading(false);
        }
    }, [searchSongs]);

    const handleSongInteraction = useCallback((song: Song) => {
        const now = Date.now();
        const lastTime = lastClickTime.current[song.id] || 0;
        if (now - lastTime < 300) {
            toggleFavoriteSong(song);
        } else {
            playSong(song);
        }
        lastClickTime.current[song.id] = now;
    }, [playSong, toggleFavoriteSong]);

    const isFavorite = useCallback((songId: string) => 
        musicState.favorites.some(s => s.id === songId)
    , [musicState.favorites]);

    const displaySongs = activeTab === 'favorites' ? musicState.favorites
        : activeTab === 'queue' ? queue
        : songs;

    const handleSeek = useCallback((e: any) => {
        const { locationX } = e.nativeEvent;
        const barWidth = width - 48; // Screen width - padding (24 * 2)
        const percent = Math.max(0, Math.min(1, locationX / barWidth));
        const duration = musicState.currentSong?.duration || 240;
        const targetMs = percent * duration * 1000;
        seekTo(targetMs);
        setProgress(percent * 100);
        setPlaybackMs(targetMs);
    }, [musicState.currentSong?.duration, seekTo]);

    const formatClock = (seconds: number) => {
        const safe = Math.max(0, Math.floor(seconds));
        const mins = Math.floor(safe / 60);
        const secs = safe % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const memoizedTopPanel = useMemo(() => (
        <ListHeader
            currentSong={musicState.currentSong}
            isPlaying={musicState.isPlaying}
            progress={progress}
            playbackMs={playbackMs}
            onTogglePlay={togglePlayMusic}
            onSeek={handleSeek}
            onNext={playNext}
            onPrevious={playPrevious}
            repeatMode={repeatMode}
            onToggleRepeat={toggleRepeat}
            shuffle={shuffle}
            onToggleShuffle={toggleShuffle}
            searchQuery={searchQuery}
            onSearchChange={handleSearchInput}
            activeTab={activeTab}
            isKeyboardVisible={keyboardVisible}
            formatClock={formatClock}
            showLyrics={showLyrics}
            onToggleLyrics={() => setShowLyrics(prev => !prev)}
            lyricsAvailable={lyrics.length > 0}
            lyricsLines={lyrics}
            lyricsLoading={lyricsLoading}
            currentLyricIndex={currentLyricIndex}
            onSeekLyric={seekTo}
            magentaColor={themeAccent}
        />
    ), [musicState.currentSong, musicState.isPlaying, progress, playbackMs, searchQuery, activeTab, keyboardVisible, repeatMode, shuffle, showLyrics, lyrics, lyricsLoading, currentLyricIndex, themeAccent]);

    const handleSongLongPress = useCallback((song: Song) => {
        addToQueue(song);
    }, [addToQueue]);

    const renderSongItem = useCallback(({ item }: { item: Song }) => (
        <SongItem
            item={item}
            isCurrent={musicState.currentSong?.id === item.id}
            isFavorite={isFavorite(item.id)}
            onPress={handleSongInteraction}
            onLongPress={handleSongLongPress}
            magentaColor={themeAccent}
        />
    ), [musicState.currentSong?.id, musicState.favorites, handleSongInteraction, handleSongLongPress]);

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />
            
            {/* Combined Backdrop: Glass blur over chat screen — chat visible underneath */}
            <Animated.View style={[StyleSheet.absoluteFill, backdropBlurOpacity, { zIndex: 40 }]}>
                <GlassView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.3)' }]} />
            </Animated.View>


            {/* Transparent Pressable to close the overlay with animation */}
            <Pressable style={[StyleSheet.absoluteFill, { zIndex: 41 }]} onPress={handleClose} />

            <Animated.View style={[styles.musicOverlay, overlayStyle]}>
                <GlassView 
                    intensity={80} 
                    tint="dark" 
                    style={styles.overlayGlass} 
                >
                    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
                        <View style={styles.dragHandle} />
                        {memoizedTopPanel}

                        {FlashList ? (
                            <FlashList
                                data={displaySongs}
                                renderItem={renderSongItem}
                                // @ts-ignore - TS incorrectly complains about missing estimatedItemSize in FlashListProps
                                estimatedItemSize={80}
                                keyExtractor={(item) => item.id}
                                contentContainerStyle={styles.listContent}
                                showsVerticalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                onEndReached={loadMore}
                                onEndReachedThreshold={0.5}
                                removeClippedSubviews={Platform.OS === 'android'}
                                ListFooterComponent={
                                    <View style={{ paddingBottom: 120 }}>
                                        {isLoading && activeTab === 'music' && songs.length > 0 && (
                                            <ActivityIndicator color={themeAccent} style={{ marginVertical: 20 }} />
                                        )}
                                        {/* Recommended Songs Section */}
                                        {recommendedSongs.length > 0 && activeTab === 'music' && !searchQuery && (
                                            <View style={{ marginTop: 16, paddingHorizontal: 4 }}>
                                                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 10 }}>
                                                    RECOMMENDED FOR YOU
                                                </Text>
                                                {recommendedSongs.map(song => (
                                                    <Pressable
                                                        key={song.id}
                                                        onPress={() => playSong(song)}
                                                        onLongPress={() => { addToQueue(song); }}
                                                        style={{
                                                            flexDirection: 'row', alignItems: 'center',
                                                            paddingVertical: 8, paddingHorizontal: 4,
                                                        }}
                                                    >
                                                        <Image source={{ uri: song.image }} style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                                                        <View style={{ flex: 1, marginLeft: 12 }}>
                                                            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '500' }} numberOfLines={1}>{song.name}</Text>
                                                            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 1 }} numberOfLines={1}>{song.artist}</Text>
                                                        </View>
                                                        <Pressable onPress={() => addToQueue(song)} hitSlop={8} style={{ padding: 6 }}>
                                                            <MaterialIcons name="playlist-add" size={20} color="rgba(255,255,255,0.3)" />
                                                        </Pressable>
                                                    </Pressable>
                                                ))}
                                            </View>
                                        )}
                                    </View>
                                }
                                ListEmptyComponent={isLoading && activeTab === 'music' && songs.length === 0 ? (
                                    <ActivityIndicator color={themeAccent} style={{ marginTop: 20 }} />
                                ) : activeTab === 'queue' && queue.length === 0 ? (
                                    <View style={{ alignItems: 'center', marginTop: 40 }}>
                                        <MaterialIcons name="queue-music" size={40} color="rgba(255,255,255,0.1)" />
                                        <Text style={{ color: 'rgba(255,255,255,0.25)', fontSize: 13, marginTop: 12 }}>Queue is empty</Text>
                                        <Text style={{ color: 'rgba(255,255,255,0.12)', fontSize: 11, marginTop: 4 }}>Long press a song to add it</Text>
                                    </View>
                                ) : activeTab === 'favorites' && musicState.favorites.length === 0 ? (
                                    <View style={{ alignItems: 'center', marginTop: 40 }}>
                                        <MaterialIcons name="favorite-border" size={40} color="rgba(255,255,255,0.1)" />
                                        <Text style={{ color: 'rgba(255,255,255,0.25)', fontSize: 13, marginTop: 12 }}>No favorites yet</Text>
                                    </View>
                                ) : null}
                            />
                        ) : null}


                        {/* Liquid Tabs Navigation */}
                        {!keyboardVisible && (
                            <View style={styles.tabBarContainer}>
                                <GlassView 
                                    intensity={35} 
                                    tint="dark" 
                                    style={styles.tabPill} 
                                >
                                    <Pressable
                                        onPress={() => setActiveTab('favorites')}
                                        style={[styles.tabBtn, activeTab === 'favorites' && styles.tabBtnActive]}
                                    >
                                        <MaterialIcons name="favorite" size={18} color={activeTab === 'favorites' ? themeAccent : 'rgba(255,255,255,0.4)'} />
                                        <Text style={[styles.tabText, activeTab === 'favorites' && { color: themeAccent }]}>Favs</Text>
                                    </Pressable>
                                    <Pressable
                                        onPress={() => setActiveTab('queue')}
                                        style={[styles.tabBtn, activeTab === 'queue' && styles.tabBtnActive]}
                                    >
                                        <MaterialIcons name="queue-music" size={18} color={activeTab === 'queue' ? themeAccent : 'rgba(255,255,255,0.4)'} />
                                        <Text style={[styles.tabText, activeTab === 'queue' && { color: themeAccent }]}>Queue</Text>
                                    </Pressable>
                                    <Pressable
                                        onPress={() => setActiveTab('music')}
                                        style={[styles.tabBtn, activeTab === 'music' && styles.tabBtnActive]}
                                    >
                                        <MaterialIcons name="library-music" size={18} color={activeTab === 'music' ? themeAccent : 'rgba(255,255,255,0.4)'} />
                                        <Text style={[styles.tabText, activeTab === 'music' && { color: themeAccent }]}>Music</Text>
                                    </Pressable>
                                </GlassView>
                            </View>
                        )}
                    </KeyboardAvoidingView>
                </GlassView>
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },
    
    // Music Overlay
    musicOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '82%', zIndex: 60, borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden' },
    overlayGlass: { flex: 1, backgroundColor: 'transparent', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' },
    dragHandle: { width: 48, height: 6, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 3, alignSelf: 'center', marginTop: 12, marginBottom: 24 },
    listContent: { paddingHorizontal: 24, paddingBottom: 120 },
    overlayHeader: { width: '100%', alignItems: 'center' },
    
    playerInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 20, width: '100%', marginBottom: 16 },
    artworkWrapper: { width: 112, height: 112, borderRadius: 20, position: 'relative', overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: '#1a1a1a', shadowColor: '#fff', shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: { width: 0, height: 10 } },
    artwork: { width: '100%', height: '100%' },
    artworkBadge: { position: 'absolute', bottom: -5, right: -5, width: 32, height: 32, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#0f0f0f' },
    playerTextContainer: { flex: 1 },
    overlayTrackTitle: { color: '#fff', fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
    overlayTrackArtist: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 2 },
    
    progressBarWrapper: { width: '100%', marginTop: 16 },
    progressBarBg: { width: '100%', height: 6, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' },
    progressBarFill: { height: '100%', backgroundColor: '#fff', borderRadius: 3, shadowColor: '#fff', shadowOpacity: 0.8, shadowRadius: 10 },
    timeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    timeText: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '600' },

    controlsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 12, width: '100%', paddingHorizontal: 8 },
    playButton: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#fff', shadowOpacity: 0.2, shadowRadius: 15 },

    searchSection: { width: '100%', marginBottom: 12 },
    searchSectionKeyboard: { marginBottom: 12 },
    searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 25, paddingHorizontal: 16, height: 50, borderWidth: 1.2, borderColor: 'rgba(255,255,255,0.22)', shadowColor: '#fff', shadowOpacity: 0.1, shadowRadius: 10, overflow: 'hidden' },
    searchInput: { flex: 1, color: '#fff', marginLeft: 12, fontSize: 14, fontWeight: '500' },

    listHeader: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 16, paddingHorizontal: 8 },
    listTitle: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '800', letterSpacing: 2 },

    songItem: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 16, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' },
    songItemActive: { backgroundColor: 'rgba(255,0,128,0.1)', borderColor: 'rgba(255,0,128,0.2)' },
    songThumb: { width: 48, height: 48, borderRadius: 8 },
    songInfo: { flex: 1, marginLeft: 16 },
    songName: { color: '#fff', fontSize: 14, fontWeight: '600' },
    songArtistName: { color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 2 },
    songAction: { paddingLeft: 10 },

    tabBarContainer: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' },
    tabPill: { flexDirection: 'row', width: '85%', borderRadius: 40, padding: 6, backgroundColor: 'transparent', borderWidth: 1.2, borderColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
    tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, gap: 8, borderRadius: 34 },
    tabBtnActive: { backgroundColor: 'rgba(255,0,128,0.2)', borderWidth: 1, borderColor: 'rgba(255,0,128,0.5)' },
    tabText: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.5 },
    tabTextActive: { color: MAGENTA },
});
