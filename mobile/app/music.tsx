import React, { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
import {
    View, Text, Image, TextInput, Pressable, StyleSheet, StatusBar,
    FlatList, useWindowDimensions, ActivityIndicator, ImageBackground,
    KeyboardAvoidingView, Platform, Keyboard, ScrollView
} from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import { BlurView } from 'expo-blur';
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



// Constants from Mockup
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
    magentaColor 
}: { 
    item: Song; 
    isCurrent: boolean; 
    isFavorite: boolean; 
    onPress: (song: Song) => void;
    magentaColor: string;
}) => {
    return (
        <Pressable 
            onPress={() => onPress(item)}
            style={[styles.songItem, isCurrent && styles.songItemActive]}
        >
            <Image source={{ uri: item.image }} style={styles.songThumb} />
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
    searchQuery, 
    onSearchChange, 
    activeTab,
    isKeyboardVisible,
    formatClock 
}: any) => {
    return (
        <View style={[styles.overlayHeader, isKeyboardVisible && { paddingBottom: 0 }]}>
            <View style={[styles.playerInfoRow, isKeyboardVisible && { marginBottom: 16 }]}>
                <View style={[styles.artworkWrapper, isKeyboardVisible && { width: 60, height: 60, borderRadius: 12 }]}>
                    {currentSong ? (
                        <Image source={{ uri: currentSong.image }} style={styles.artwork} />
                    ) : (
                        <View style={[styles.artwork, { backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' }]}>
                            <MaterialIcons name="music-note" size={isKeyboardVisible ? 30 : 60} color="rgba(255,255,255,0.1)" />
                        </View>
                    )}
                    <LinearGradient colors={['transparent', 'rgba(255,0,128,0.2)']} style={StyleSheet.absoluteFill} />
                    {currentSong && !isKeyboardVisible && (
                        <View style={styles.artworkBadge}>
                            <MaterialIcons name="equalizer" size={16} color="#fff" />
                        </View>
                    )}
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
                                <Text style={styles.timeText}>
                                    {currentSong ? formatClock(currentSong.duration || 0) : "No Media"}
                                </Text>
                            </View>
                        </View>
                    )}
                </View>
            </View>

            {!isKeyboardVisible && (
                <View style={styles.controlsRow}>
                    <Pressable><MaterialIcons name="skip-previous" size={36} color="rgba(255,255,255,0.4)" /></Pressable>
                    <Pressable 
                        onPress={() => currentSong ? onTogglePlay() : null} 
                        style={[styles.playButton, !currentSong && { opacity: 0.5 }]}
                    >
                        <MaterialIcons name={isPlaying ? "pause" : "play-arrow"} size={44} color="#000" />
                    </Pressable>
                    <Pressable><MaterialIcons name="skip-next" size={36} color="rgba(255,255,255,0.4)" /></Pressable>
                </View>
            )}

            <View style={[styles.searchSection, isKeyboardVisible && { marginBottom: 12 }]}>
                <BlurView intensity={20} tint="light" style={styles.searchBar}>
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
                </BlurView>
            </View>

            {!isKeyboardVisible && (
                <View style={styles.listHeader}>
                    <Text style={styles.listTitle}>
                        {activeTab === 'music' 
                            ? (searchQuery ? `RESULTS FOR "${searchQuery.toUpperCase()}"` : 'TRENDING HINDI SONGS') 
                            : 'FAVORITES'}
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
    const { musicState, currentUser, playSong, togglePlayMusic, toggleFavoriteSong, startCall, getPlaybackPosition, seekTo } = useApp();

    const [activeTab, setActiveTab] = useState<'music' | 'favorites'>('music');
    const [searchQuery, setSearchQuery] = useState('');
    const [songs, setSongs] = useState<Song[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [playbackMs, setPlaybackMs] = useState(0);
    const lastClickTime = useRef<{ [key: string]: number }>({});
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const isMountedRef = useRef(true);
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
        opacity: interpolate(slideY.value, [0, height], [1, 0]),
    }));

    const backdropBlurOpacity = useAnimatedStyle(() => ({
        opacity: interpolate(slideY.value, [0, height], [1, 0]),
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
            }, 1000);
        }
        return () => clearInterval(interval);
    }, [musicState.isPlaying, musicState.currentSong]);

    useEffect(() => {
        // Reset when switching songs
        setPlaybackMs(0);
        setProgress(0);
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
            const url = `${getSaavnApiUrl()}/search/songs?query=${encodeURIComponent(query)}&page=${currentPage}&limit=${limit}`;

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

    const displaySongs = activeTab === 'favorites' ? musicState.favorites : songs;

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

    const memoizedHeader = useMemo(() => (
        <ListHeader 
            currentSong={musicState.currentSong}
            isPlaying={musicState.isPlaying}
            progress={progress}
            playbackMs={playbackMs}
            onTogglePlay={togglePlayMusic}
            onSeek={handleSeek}
            searchQuery={searchQuery}
            onSearchChange={handleSearchInput}
            activeTab={activeTab}
            isKeyboardVisible={keyboardVisible}
            formatClock={formatClock}
        />
    ), [musicState.currentSong, musicState.isPlaying, progress, playbackMs, searchQuery, activeTab, keyboardVisible]);

    const renderSongItem = useCallback(({ item }: { item: Song }) => (
        <SongItem 
            item={item}
            isCurrent={musicState.currentSong?.id === item.id}
            isFavorite={isFavorite(item.id)}
            onPress={handleSongInteraction}
            magentaColor={MAGENTA}
        />
    ), [musicState.currentSong?.id, musicState.favorites, handleSongInteraction]);

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />
            
            <Animated.View style={[StyleSheet.absoluteFill, backgroundStyle]}>
                <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
            </Animated.View>

            <Animated.View style={[StyleSheet.absoluteFill, backdropBlurOpacity, { zIndex: 40 }]}>
                {Platform.OS === 'ios' && (
                    <BlurView 
                        intensity={25} 
                        tint="dark" 
                        style={StyleSheet.absoluteFill}
                    />
                )}
                <View 
                    style={[
                        StyleSheet.absoluteFill, 
                        Platform.OS === 'android' && { backgroundColor: 'rgba(0,0,0,0.4)' }
                    ]} 
                />
            </Animated.View>

            {/* Transparent Pressable to close the overlay with animation */}
            <Pressable style={[StyleSheet.absoluteFill, { zIndex: 41 }]} onPress={handleClose} />

            <Animated.View style={[styles.musicOverlay, overlayStyle]}>
                <BlurView 
                    intensity={Platform.OS === 'android' ? 100 : 95} 
                    tint="dark" 
                    style={styles.overlayGlass} 
                    experimentalBlurMethod="dimezisBlurView"
                >
                    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
                        <View style={styles.dragHandle} />

                        {FlashList && (
                            <FlashList
                                data={displaySongs}
                                renderItem={renderSongItem}
                                estimatedItemSize={80}
                                initialNumToRender={10}
                                keyExtractor={(item) => item.id}
                                ListHeaderComponent={memoizedHeader}
                                contentContainerStyle={styles.listContent}
                                showsVerticalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                onEndReached={loadMore}
                                onEndReachedThreshold={0.5}
                                removeClippedSubviews={Platform.OS === 'android'}
                                ListFooterComponent={
                                    <View style={{ height: 120, alignItems: 'center', paddingTop: 20 }}>
                                        {isLoading && songs.length > 0 && <ActivityIndicator color={MAGENTA} />}
                                    </View>
                                }
                                ListEmptyComponent={isLoading && songs.length === 0 ? (
                                    <ActivityIndicator color={MAGENTA} style={{ marginTop: 20 }} />
                                ) : null}
                            />
                        )}


                        {/* Liquid Tabs Navigation */}
                        {!keyboardVisible && (
                            <View style={styles.tabBarContainer}>
                                <BlurView 
                                    intensity={Platform.OS === 'android' ? 80 : 40} 
                                    tint="dark" 
                                    style={styles.tabPill} 
                                    experimentalBlurMethod="dimezisBlurView"
                                >
                                    <Pressable 
                                        onPress={() => setActiveTab('favorites')}
                                        style={[styles.tabBtn, activeTab === 'favorites' && styles.tabBtnActive]}
                                    >
                                        <MaterialIcons name="favorite" size={20} color={activeTab === 'favorites' ? MAGENTA : 'rgba(255,255,255,0.4)'} />
                                        <Text style={[styles.tabText, activeTab === 'favorites' && styles.tabTextActive]}>Favorites</Text>
                                    </Pressable>
                                    <Pressable 
                                        onPress={() => setActiveTab('music')}
                                        style={[styles.tabBtn, activeTab === 'music' && styles.tabBtnActive]}
                                    >
                                        <MaterialIcons name="library-music" size={20} color={activeTab === 'music' ? MAGENTA : 'rgba(255,255,255,0.4)'} />
                                        <Text style={[styles.tabText, activeTab === 'music' && styles.tabTextActive]}>Music</Text>
                                    </Pressable>
                                </BlurView>
                            </View>
                        )}
                    </KeyboardAvoidingView>
                </BlurView>
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },
    
    // Music Overlay
    musicOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '82%', zIndex: 60, borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden' },
    overlayGlass: { flex: 1, backgroundColor: Platform.OS === 'android' ? 'rgba(15,15,15,0.7)' : 'rgba(15,15,15,0.3)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' },
    dragHandle: { width: 48, height: 6, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 3, alignSelf: 'center', marginTop: 12, marginBottom: 24 },
    listContent: { paddingHorizontal: 24 },
    overlayHeader: { width: '100%', alignItems: 'center' },
    
    playerInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 20, width: '100%', marginBottom: 32 },
    artworkWrapper: { width: 112, height: 112, borderRadius: 20, position: 'relative', overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', shadowColor: MAGENTA, shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: { width: 0, height: 10 } },
    artwork: { width: '100%', height: '100%' },
    artworkBadge: { position: 'absolute', bottom: -5, right: -5, width: 32, height: 32, borderRadius: 16, backgroundColor: MAGENTA, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#0f0f0f' },
    playerTextContainer: { flex: 1 },
    overlayTrackTitle: { color: '#fff', fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
    overlayTrackArtist: { color: MAGENTA, fontSize: 14, fontWeight: '600', marginTop: 2 },
    
    progressBarWrapper: { width: '100%', marginTop: 16 },
    progressBarBg: { width: '100%', height: 6, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' },
    progressBarFill: { height: '100%', backgroundColor: MAGENTA, borderRadius: 3, shadowColor: MAGENTA, shadowOpacity: 0.8, shadowRadius: 10 },
    timeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    timeText: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '600' },

    controlsRow: { flexDirection: 'row', alignItems: 'center', gap: 40, marginBottom: 32 },
    playButton: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#fff', shadowOpacity: 0.2, shadowRadius: 15 },

    searchSection: { width: '100%', marginBottom: 24 },
    searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 25, paddingHorizontal: 16, height: 50, borderWidth: 1, borderColor: 'rgba(255,0,128,0.4)', shadowColor: MAGENTA, shadowOpacity: 0.1, shadowRadius: 10, overflow: 'hidden' },
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
    tabPill: { flexDirection: 'row', width: '85%', borderRadius: 40, padding: 6, backgroundColor: Platform.OS === 'android' ? 'rgba(20,20,20,0.45)' : 'rgba(20,20,20,0.6)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
    tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, gap: 8, borderRadius: 34 },
    tabBtnActive: { backgroundColor: 'rgba(255,0,128,0.2)', borderWidth: 1, borderColor: 'rgba(255,0,128,0.5)' },
    tabText: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.5 },
    tabTextActive: { color: MAGENTA },
});
