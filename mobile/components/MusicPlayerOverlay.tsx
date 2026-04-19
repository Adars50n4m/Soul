import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, Modal,
    ScrollView, ActivityIndicator, TextInput,
    Dimensions, PanResponder, KeyboardAvoidingView, Platform, Keyboard
} from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withSequence,
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
import { GlassView } from './ui/GlassView';
import { MaterialIcons } from '@expo/vector-icons';
import { getSaavnApiUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { Song } from '../types';
import { lyricsService, LyricLine } from '../services/LyricsService';

const { width, height } = Dimensions.get('window');

interface MusicPlayerOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    contactName?: string;
}

const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
};

// Animated play button with spring press feedback
const PlayButton = ({ isPlaying, onPress, accentColor }: { isPlaying: boolean; onPress: () => void; accentColor: string }) => {
    const scale = useSharedValue(1);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
    }));

    const handlePressIn = () => {
        scale.value = withSpring(0.88, { damping: 15, stiffness: 300 });
    };

    const handlePressOut = () => {
        scale.value = withSpring(1, { damping: 12, stiffness: 200 });
    };

    return (
        <Pressable
            onPress={onPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            hitSlop={25}
        >
            <Animated.View style={[styles.playButton, animatedStyle]}>
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={44} color="#000" />
            </Animated.View>
        </Pressable>
    );
};

// Animated icon button (shuffle, prev, next, lyrics)
const IconButton = ({ name, size, color, onPress }: { name: any; size: number; color: string; onPress: () => void }) => {
    const scale = useSharedValue(1);
    const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

    return (
        <Pressable
            onPress={onPress}
            onPressIn={() => { scale.value = withSpring(0.8, { damping: 15, stiffness: 400 }); }}
            onPressOut={() => { scale.value = withSpring(1, { damping: 10, stiffness: 200 }); }}
            hitSlop={20}
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
                            <Text
                                key={idx}
                                style={[
                                    styles.lyricLine,
                                    idx === currentLyricIndex && styles.lyricLineActive
                                ]}
                            >
                                {line.text}
                            </Text>
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
    contactName
}) => {
    const { musicState, playSong, togglePlayMusic, toggleFavoriteSong, getPlaybackPosition, seekTo, activeTheme,
        repeatMode, toggleRepeat, shuffle, toggleShuffle, queue, addToQueue, removeFromQueue, clearQueue, playNext, playPrevious } = useApp() as any;
    const themeAccent = activeTheme?.primary || '#fff';
    const [searchResults, setSearchResults] = useState<Song[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [activeTab, setActiveTab] = useState<'music' | 'favorites' | 'queue'>('music');

    // Lyrics State
    const [lyrics, setLyrics] = useState<LyricLine[]>([]);
    const [lyricsLoading, setLyricsLoading] = useState(false);
    const [showLyrics, setShowLyrics] = useState(false);
    const [currentLyricIndex, setCurrentLyricIndex] = useState(0);
    const lyricsScrollRef = useRef<ScrollView>(null);

    // Playback State
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isSeeking, setIsSeeking] = useState(false);
    const [seekPosition, setSeekPosition] = useState(0);

    // ─── Reanimated Shared Values ────────────────────────────────────────────
    const slideY = useSharedValue(height);          // Sheet slide in/out
    const scrollY = useSharedValue(0);              // Scroll position for PIP transition
    const backdropOpacity = useSharedValue(0);      // Backdrop fade
    const expandedBaseHeight = useSharedValue(395); // Dynamic height to prevent lyrics overlap
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const scrollViewRef = useRef<any>(null);

    // ─── Sheet open/close animation ─────────────────────────────────────────
    useEffect(() => {
        if (isOpen) {
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

            if (searchResults.length === 0) fetchSongs();
        } else {
            slideY.value = withSpring(height, {
                damping: 28,
                stiffness: 280,
                mass: 0.8,
            });
            backdropOpacity.value = withTiming(0, { duration: 220 });
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
    const headerOverlayStyle = useAnimatedStyle(() => {
        // Collapse from current dynamic base height to just the unified mini bar (86)
        const h = interpolate(scrollY.value, [0, 200], [expandedBaseHeight.value, 86], Extrapolation.CLAMP);
        const bg = interpolate(scrollY.value, [0, 150], [0, 0.98], Extrapolation.CLAMP);
        return {
            height: h,
            backgroundColor: `rgba(10,10,10,${bg})`,
        };
    });

    const fullPlayerStyle = useAnimatedStyle(() => {
        const opacity = interpolate(scrollY.value, [0, 80], [1, 0], Extrapolation.CLAMP);
        const scale = interpolate(scrollY.value, [0, 200], [1, 0.45], Extrapolation.CLAMP);
        return { opacity, transform: [{ scale }] };
    });

    const miniPlayerStyle = useAnimatedStyle(() => {
        const opacity = interpolate(scrollY.value, [100, 160], [0, 1], Extrapolation.CLAMP);
        return { opacity };
    });

    // Drag handle fades OUT as mini player fades IN — they merge into one bar
    const dragHandleOpacity = useAnimatedStyle(() => {
        const opacity = interpolate(scrollY.value, [60, 130], [1, 0], Extrapolation.CLAMP);
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

    // ─── Playback polling ────────────────────────────────────────────────────
    useEffect(() => {
        let interval: any;
        if (musicState.isPlaying && !isSeeking) {
            interval = setInterval(async () => {
                const pos = await getPlaybackPosition();
                const posSeconds = pos / 1000;
                setPosition(posSeconds);

                if (lyrics.length > 0) {
                    const idx = lyricsService.getCurrentLineIndex(lyrics, posSeconds);
                    if (idx !== currentLyricIndex) setCurrentLyricIndex(idx);
                }
            }, 200);
        }
        return () => clearInterval(interval);
    }, [musicState.isPlaying, isSeeking, lyrics, currentLyricIndex]);

    // ─── Lyrics loader ───────────────────────────────────────────────────────
    useEffect(() => {
        const song = musicState.currentSong;
        if (song) {
            setLyricsLoading(true);
            setLyrics([]);
            setShowLyrics(false);
            setCurrentLyricIndex(0);
            lyricsService.getLyrics(song.name, song.artist, Number(song.duration))
                .then(result => { if (result) setLyrics(result.lines); })
                .catch(e => console.warn('[MusicPlayerOverlay] Lyrics error:', e))
                .finally(() => setLyricsLoading(false));
        } else {
            setLyrics([]);
        }
    }, [musicState.currentSong?.id]);

    // ─── Animate header height when lyrics toggle ────────────────────────────
    useEffect(() => {
        if (showLyrics) {
            expandedBaseHeight.value = withSpring(520, { damping: 25, stiffness: 120 });
        } else {
            expandedBaseHeight.value = withSpring(395, { damping: 25, stiffness: 120 });
        }
    }, [showLyrics]);

    useEffect(() => {
        if (showLyrics && lyrics.length > 0 && currentLyricIndex >= 0) {
            lyricsScrollRef.current?.scrollTo({
                y: Math.max(0, currentLyricIndex * 22 - 40),
                animated: true
            });
        }
    }, [currentLyricIndex, showLyrics]);

    useEffect(() => {
        if (musicState.currentSong?.duration) {
            setDuration(Number(musicState.currentSong.duration));
        } else {
            setDuration(240);
        }
    }, [musicState.currentSong]);

    // ─── Song fetch ──────────────────────────────────────────────────────────
    const fetchSongs = async (query = 'Top Hits') => {
        setIsLoading(true);
        try {
            const apiUrl = getSaavnApiUrl();
            const cleanBaseUrl = apiUrl.replace(/\/$/, '');
            const baseApiUrl = cleanBaseUrl.endsWith('/api') ? cleanBaseUrl : `${cleanBaseUrl}/api`;
            const response = await fetch(`${baseApiUrl}/search/songs?query=${encodeURIComponent(query)}&limit=50`);
            const data = await response.json() as any;
            if (data?.success && data?.data?.results) {
                const songs = data.data.results.map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    artist: s.artists?.primary?.map((a: any) => a.name).join(', ') || s.primaryArtists || 'Unknown',
                    image: s.image?.[s.image.length - 1]?.url || s.image?.[1]?.url || '',
                    url: s.downloadUrl?.[s.downloadUrl.length - 1]?.url || '',
                    duration: s.duration || 0,
                })).filter((s: Song) => s.url);
                setSearchResults(songs);
            }
        } catch (error) {
            console.log('Failed to fetch songs:', error);
        }
        setIsLoading(false);
    };

    const handleSearch = () => {
        if (searchQuery.trim()) fetchSongs(searchQuery);
    };

    const isFavorite = (song: Song) => musicState.favorites.some((s: any) => s.id === song.id);

    // ─── Seek via PanResponder ───────────────────────────────────────────────
    const [progressBarLayout, setProgressBarLayout] = useState({ width: 0, x: 0 });
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (evt) => {
                setIsSeeking(true);
                const touchX = evt.nativeEvent.locationX;
                const percent = Math.max(0, Math.min(1, touchX / (progressBarLayout.width || width - 48)));
                setSeekPosition(percent * duration);
            },
            onPanResponderMove: (evt) => {
                const touchX = evt.nativeEvent.locationX;
                const percent = Math.max(0, Math.min(1, touchX / (progressBarLayout.width || width - 48)));
                setSeekPosition(percent * duration);
            },
            onPanResponderRelease: (evt) => {
                const touchX = evt.nativeEvent.locationX;
                const percent = Math.max(0, Math.min(1, touchX / (progressBarLayout.width || width - 48)));
                const finalSeekTime = percent * duration;
                seekTo(finalSeekTime * 1000);
                setPosition(finalSeekTime);
                setIsSeeking(false);
            },
        })
    ).current;

    const currentDisplayPosition = isSeeking ? seekPosition : position;
    const progressPercent = duration > 0 ? Math.min((currentDisplayPosition / duration) * 100, 100) : 0;

    if (!isOpen) return null;

    return (
        <Modal
            transparent
            visible={isOpen}
            animationType="none"
            onRequestClose={onClose}
            statusBarTranslucent={true}
        >
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
                                        <ActivityIndicator color={themeAccent} style={{ marginTop: 20 }} />
                                    ) : (
                                        (activeTab === 'queue' ? queue : searchResults).map((song: Song) => (
                                            <SongCard
                                                key={song.id}
                                                song={song}
                                                isActive={musicState.currentSong?.id === song.id}
                                                isFav={isFavorite(song)}
                                                inQueue={queue.some((s: any) => s.id === song.id)}
                                                themeAccent={themeAccent}
                                                onPlay={() => playSong(song)}
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
                                <Animated.View style={[styles.fullPlayerContent, fullPlayerStyle]}>
                                    <ArtworkView
                                        uri={musicState.currentSong?.image}
                                        showLyrics={showLyrics}
                                        lyrics={lyrics}
                                        currentLyricIndex={currentLyricIndex}
                                        lyricsScrollRef={lyricsScrollRef}
                                        themeAccent={themeAccent}
                                        isPlaying={musicState.isPlaying}
                                    />

                                    <View style={styles.trackInfo}>
                                        <Text style={styles.trackTitle} numberOfLines={1}>
                                            {musicState.currentSong?.name || 'Select a Song'}
                                        </Text>
                                        <Text style={[styles.trackArtist, { color: themeAccent }]} numberOfLines={1}>
                                            {musicState.currentSong?.artist || 'Soul Music'}
                                        </Text>
                                    </View>

                                    {/* Progress Bar */}
                                    <View style={styles.progressBarContainer}>
                                        <View
                                            style={styles.progressBarTouchArea}
                                            {...panResponder.panHandlers}
                                            onLayout={(e) => setProgressBarLayout({
                                                width: e.nativeEvent.layout.width,
                                                x: e.nativeEvent.layout.x
                                            })}
                                        >
                                            <View style={styles.progressBar}>
                                                <View style={[styles.progressFill, { width: `${progressPercent}%`, backgroundColor: themeAccent }]} />
                                            </View>
                                        </View>
                                        <View style={styles.timeLabels}>
                                            <Text style={styles.timeText}>{formatTime(currentDisplayPosition)}</Text>
                                            <Text style={styles.timeText}>{formatTime(Math.max(currentDisplayPosition, duration))}</Text>
                                        </View>
                                    </View>

                                    {/* Controls */}
                                    <View style={styles.playerBottomContainer}>
                                        <View style={styles.controlsRow}>
                                            <IconButton name="shuffle" size={24} color={shuffle ? themeAccent : 'rgba(255,255,255,0.4)'} onPress={toggleShuffle} />
                                            <IconButton name="skip-previous" size={36} color="rgba(255,255,255,0.7)" onPress={playPrevious} />
                                            <PlayButton isPlaying={musicState.isPlaying} onPress={togglePlayMusic} accentColor={themeAccent} />
                                            <IconButton name="skip-next" size={36} color="rgba(255,255,255,0.7)" onPress={playNext} />
                                            <IconButton name="lyrics" size={24} color={showLyrics ? themeAccent : 'rgba(255,255,255,0.4)'} onPress={() => setShowLyrics(!showLyrics)} />
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
                                        </View>
                                        <Pressable onPress={togglePlayMusic} style={styles.miniPlayBtn} hitSlop={15}>
                                            <MaterialIcons
                                                name={musicState.isPlaying ? 'pause-circle' : 'play-circle'}
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
        paddingTop: 50,   // Compensates for headerOverlay now starting at top:0
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
    miniPlayBtn: {
        padding: 4,
    },
    artworkWrapper: {
        width: 200,
        height: 200,
        marginBottom: 20,
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
        height: 280,
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
        marginBottom: 16,
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
        marginBottom: 24,
        justifyContent: 'center',
    },
    progressBarTouchArea: {
        height: 20,
        justifyContent: 'center',
    },
    progressBar: {
        height: 6,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 3,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: 3,
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
