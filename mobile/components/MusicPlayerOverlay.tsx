import React, { useState, useEffect, useRef } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, Modal,
    Animated, ScrollView, ActivityIndicator, TextInput,
    useWindowDimensions, PanResponder, KeyboardAvoidingView, Platform, Keyboard
} from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { getSaavnApiUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { Song } from '../types';


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

export const MusicPlayerOverlay: React.FC<MusicPlayerOverlayProps> = ({
    isOpen,
    onClose,
    contactName
}) => {
    const { width, height } = useWindowDimensions();
    const { musicState, playSong, togglePlayMusic, toggleFavoriteSong, getPlaybackPosition, seekTo } = useApp();
    const [searchResults, setSearchResults] = useState<Song[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [activeTab, setActiveTab] = useState<'music' | 'favorites'>('music');

    // Playback State
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isSeeking, setIsSeeking] = useState(false);
    const [seekPosition, setSeekPosition] = useState(0);

    // Animations
    const slideAnim = useRef(new Animated.Value(height)).current;

    // Keyboard State
    const [keyboardVisible, setKeyboardVisible] = useState(false);

    useEffect(() => {
        const showSubscription = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
        const hideSubscription = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, []);

    useEffect(() => {
        if (isOpen) {
            Animated.spring(slideAnim, {
                toValue: 0,
                damping: 20,
                stiffness: 90,
                mass: 1,
                useNativeDriver: true,
            }).start();
            if (searchResults.length === 0) fetchSongs();
        } else {
            Animated.timing(slideAnim, {
                toValue: height,
                duration: 300,
                useNativeDriver: true,
            }).start();
        }
    }, [isOpen]);

    // Polling for Playback Position
    useEffect(() => {
        let interval: any;
        if (musicState.isPlaying && !isSeeking) {
            interval = setInterval(async () => {
                const pos = await getPlaybackPosition();
                setPosition(pos / 1000); // Convert ms to s
            }, 1000); // Update every second
        }
        return () => clearInterval(interval);
    }, [musicState.isPlaying, isSeeking]);

    // Establish Duration
    useEffect(() => {
        if (musicState.currentSong?.duration) {
            setDuration(Number(musicState.currentSong.duration));
        } else {
            // Fallback or attempt to get duration from other source if needed
            setDuration(240); // Default 4 mins if unknown
        }
    }, [musicState.currentSong]);


    const fetchSongs = async (query = 'Top Hits') => {
        setIsLoading(true);
        try {
            const apiUrl = getSaavnApiUrl();
            // Increased limit to 50 for "unlimited" feel
            const response = await fetch(`${apiUrl}/api/search/songs?query=${encodeURIComponent(query)}&limit=50`);
            const data = await response.json();

            if (data?.success && data?.data?.results) {
                const songs = data.data.results.map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    artist: s.artists?.primary?.map((a: any) => a.name).join(', ') || s.primaryArtists || 'Unknown',
                    image: s.image?.[s.image.length - 1]?.url || s.image?.[1]?.url || '',
                    url: s.downloadUrl?.[s.downloadUrl.length - 1]?.url || '',
                    duration: s.duration || 0 // Ensure duration is captured
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

    const isFavorite = (song: Song) => musicState.favorites.some(s => s.id === song.id);
    const displaySongs = activeTab === 'favorites' ? musicState.favorites : searchResults;

    // PanResponder for Seeking
    const progressBarWidth = width - 48; // paddingHorizontal 24 * 2
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (evt) => {
                setIsSeeking(true);
                const locationX = evt.nativeEvent.locationX;
                const percent = Math.max(0, Math.min(1, locationX / progressBarWidth));
                setSeekPosition(percent * duration);
            },
            onPanResponderMove: (evt, gestureState) => {
                const locationX = evt.nativeEvent.locationX;
                const percent = Math.max(0, Math.min(1, locationX / progressBarWidth));
                setSeekPosition(percent * duration);
            },
            onPanResponderRelease: (evt, gestureState) => {
                const locationX = evt.nativeEvent.locationX;
                const percent = Math.max(0, Math.min(1, locationX / progressBarWidth));
                const finalSeekTime = percent * duration;
                seekTo(finalSeekTime * 1000); // Convert s to ms
                setPosition(finalSeekTime);
                setIsSeeking(false);
            },
        })
    ).current;

    const currentDisplayPosition = isSeeking ? seekPosition : position;
    const progressPercent = duration > 0 ? (currentDisplayPosition / duration) * 100 : 0;

    const backdropOpacity = slideAnim.interpolate({
        inputRange: [0, height * 0.5, height],
        outputRange: [1, 0.5, 0],
        extrapolate: 'clamp'
    });


    return (
        <Modal transparent visible={!!isOpen} animationType="none" onRequestClose={onClose}>
            {/* Backdrop with Dynamic Transparency */}
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropOpacity }]}>
                {Platform.OS === 'ios' && (
                    <BlurView 
                        intensity={25} 
                        tint="dark" 
                        style={StyleSheet.absoluteFill}
                    />
                )}
                <Pressable 
                    style={[
                        styles.backdrop, 
                        Platform.OS === 'android' && { backgroundColor: 'rgba(0,0,0,0.4)' }
                    ]} 
                    onPress={onClose} 
                />
            </Animated.View>

            {/* Overlay Panel (82% Height) */}
            <Animated.View style={[
                styles.overlay,
                { transform: [{ translateY: slideAnim }] },
                keyboardVisible && { height: '100%', top: 100 } // Push to top when keyboard is open
            ]}>
                <BlurView 
                    intensity={Platform.OS === 'android' ? 95 : 90} 
                    tint="dark" 
                    style={styles.glassContainer} 
                    experimentalBlurMethod="dimezisBlurView"
                >
                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        style={{ flex: 1 }}
                        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
                    >

                        {/* Drag Handle */}
                        <View style={styles.dragHandleContainer}>
                            <View style={styles.dragHandle} />
                        </View>

                        <View style={styles.contentContainer}>
                            {/* Now Playing Section - Large Artwork */}
                            {!keyboardVisible && (
                                <View style={styles.nowPlayingSection}>
                                    <View style={styles.artworkWrapper}>
                                        <Image
                                            source={{ uri: musicState.currentSong?.image || 'https://via.placeholder.com/300' }}
                                            style={styles.artwork}
                                        />
                                        <View style={styles.artworkOverlay} />
                                        <View style={styles.equalizerBadge}>
                                            <MaterialIcons name="graphic-eq" size={16} color="#fff" />
                                        </View>
                                    </View>

                                    <View style={styles.trackInfo}>
                                        <Text style={styles.trackTitle} numberOfLines={1}>
                                            {musicState.currentSong?.name || 'Select a Song'}
                                        </Text>
                                        <Text style={styles.trackArtist} numberOfLines={1}>
                                            {musicState.currentSong?.artist || 'SoulSync Music'}
                                        </Text>
                                    </View>

                                    {/* Interactive Gradient Progress Bar */}
                                    <View style={styles.progressBarContainer}>
                                        <View
                                            style={styles.progressBarTouchArea}
                                            {...panResponder.panHandlers}
                                        >
                                            <View style={styles.progressBar}>
                                                <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
                                            </View>
                                        </View>
                                        <View style={styles.timeLabels}>
                                            <Text style={styles.timeText}>{formatTime(currentDisplayPosition)}</Text>
                                            <Text style={styles.timeText}>{formatTime(Math.max(currentDisplayPosition, duration))}</Text>
                                        </View>
                                    </View>

                                    {/* Controls */}
                                    <View style={styles.controlsRow}>
                                        <Pressable>
                                            <MaterialIcons name="skip-previous" size={36} color="rgba(255,255,255,0.4)" />
                                        </Pressable>
                                        <Pressable style={styles.playButton} onPress={togglePlayMusic}>
                                            <MaterialIcons
                                                name={musicState.isPlaying ? "pause" : "play-arrow"}
                                                size={44}
                                                color="#000"
                                            />
                                        </Pressable>
                                        <Pressable>
                                            <MaterialIcons name="skip-next" size={36} color="rgba(255,255,255,0.4)" />
                                        </Pressable>
                                    </View>
                                </View>
                            )}

                            {/* Search Bar - Always Visible */}
                            <View style={[styles.searchContainer, keyboardVisible && { marginTop: 40 }]}>
                                <BlurView 
                                    intensity={Platform.OS === 'android' ? 60 : 30} 
                                    tint="light" 
                                    style={styles.searchInputWrapper} 
                                    experimentalBlurMethod="dimezisBlurView"
                                >
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
                                </BlurView>
                            </View>

                            {/* Song List */}
                            <View style={styles.listContainer}>
                                <View style={styles.listHeader}>
                                    <Text style={styles.listTitle}>{activeTab === 'favorites' ? 'FAVORITES' : 'ALL MUSIC'}</Text>
                                    <MaterialIcons name="filter-list" size={18} color="rgba(255,255,255,0.2)" />
                                </View>

                                <ScrollView
                                    showsVerticalScrollIndicator={false}
                                    contentContainerStyle={styles.scrollContent}
                                    keyboardShouldPersistTaps="handled"
                                >
                                    {isLoading ? (
                                        <ActivityIndicator color="#f43f5e" style={{ marginTop: 20 }} />
                                    ) : (
                                        displaySongs.map((song) => (
                                            <Pressable
                                                key={song.id}
                                                style={styles.songCard}
                                                onPress={() => playSong(song)}
                                            >
                                                <Image source={{ uri: song.image }} style={styles.songThumb} />
                                                <View style={styles.songDetails}>
                                                    <Text style={styles.songName} numberOfLines={1}>{song.name}</Text>
                                                    <Text style={styles.songArtist} numberOfLines={1}>{song.artist}</Text>
                                                </View>
                                                <Pressable onPress={() => toggleFavoriteSong(song)}>
                                                    <MaterialIcons
                                                        name={isFavorite(song) ? "favorite" : "favorite-border"}
                                                        size={18}
                                                        color={isFavorite(song) ? "#f43f5e" : "rgba(255,255,255,0.1)"}
                                                    />
                                                </Pressable>
                                            </Pressable>
                                        ))
                                    )}
                                    <View style={{ height: keyboardVisible ? 250 : 100 }} />
                                </ScrollView>
                            </View>

                            {/* Floating Tab Bar - Hide when typing */}
                            {!keyboardVisible && (
                                <View style={styles.floatingTabsContainer}>
                                    <View style={styles.floatingTabsWrapper}>
                                        <BlurView 
                                            intensity={Platform.OS === 'android' ? 80 : 40} 
                                            tint="dark" 
                                            style={StyleSheet.absoluteFill} 
                                            experimentalBlurMethod="dimezisBlurView" 
                                        />
                                        <View style={styles.floatingTabsOverlay} />
                                        <View style={styles.floatingTabsInner}>
                                            <Pressable
                                                style={[styles.tabItem, activeTab === 'favorites' && styles.tabItemActive]}
                                                onPress={() => setActiveTab('favorites')}
                                            >
                                                <MaterialIcons name="favorite" size={18} color={activeTab === 'favorites' ? "#f43f5e" : "rgba(255,255,255,0.4)"} />
                                                <Text style={[styles.tabText, activeTab === 'favorites' && styles.tabTextActive]}>Favorites</Text>
                                            </Pressable>
                                            <Pressable
                                                style={[styles.tabItem, activeTab === 'music' && styles.tabItemActive]}
                                                onPress={() => setActiveTab('music')}
                                            >
                                                <MaterialIcons name="library-music" size={18} color={activeTab === 'music' ? "#f43f5e" : "rgba(255,255,255,0.4)"} />
                                                <Text style={[styles.tabText, activeTab === 'music' && styles.tabTextActive]}>Music</Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                </View>
                            )}

                        </View>
                    </KeyboardAvoidingView>
                </BlurView>
            </Animated.View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    overlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '85%', // Slightly taller to account for safe areas
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
        // Both platforms: dark frosted glass backing
        backgroundColor: Platform.OS === 'android' ? 'rgba(12, 12, 14, 0.75)' : 'rgba(15, 15, 15, 0.92)',
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
        alignItems: 'center',
    },
    // Now Playing
    nowPlayingSection: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 24,
        marginBottom: 24,
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
    },
    artwork: {
        width: '100%',
        height: '100%',
        borderRadius: 24,
    },
    artworkOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(244, 63, 94, 0.2)', // Pink overlay
        borderRadius: 24,
    },
    equalizerBadge: {
        position: 'absolute',
        bottom: -10,
        right: -10,
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: '#f43f5e',
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
        color: '#f43f5e',
        fontSize: 13,
        fontWeight: '600',
    },
    progressBarContainer: {
        width: '100%',
        marginBottom: 24,
        justifyContent: 'center',
    },
    progressBarTouchArea: {
        height: 20, // Taller touch area
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
        backgroundColor: '#f43f5e',
        borderRadius: 3,
        shadowColor: '#f43f5e',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 8,
    },
    timeLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: -4, // Adjust for touch area padding
    },
    timeText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 10,
        fontWeight: '500',
    },
    controlsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 40,
        marginBottom: 10,
    },
    playButton: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: '#fff',
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: 'rgba(255,255,255,0.2)',
        shadowRadius: 20,
        shadowOpacity: 0.5,
    },

    // Search
    searchContainer: {
        width: '100%',
        paddingHorizontal: 24,
        marginBottom: 24,
    },
    searchInputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: Platform.OS === 'android' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.1)',
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

    // List
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
        paddingBottom: 100,
    },
    songCard: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
        marginBottom: 10,
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.04)',
        // Shadow for hover/active effect simulation
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
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

    // Tabs
    floatingTabsContainer: {
        position: 'absolute',
        bottom: 30,
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    floatingTabsWrapper: {
        width: '85%',
        borderRadius: 50,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: Platform.OS === 'android' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.08)',
        backgroundColor: Platform.OS === 'android' ? 'rgba(22, 22, 26, 0.5)' : 'transparent',
    },
    floatingTabsOverlay: {
        ...StyleSheet.absoluteFillObject,
        // iOS: tint over real blur; Android: handled by wrapper backgroundColor
        backgroundColor: Platform.OS === 'android' ? 'transparent' : 'rgba(20, 20, 20, 0.6)',
    },
    floatingTabsInner: {
        flexDirection: 'row',
        padding: 5,
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
    tabItemActive: {
        backgroundColor: 'rgba(244, 63, 94, 0.15)',
        borderWidth: 1,
        borderColor: 'rgba(244, 63, 94, 0.4)',
    },
    tabText: {
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 1,
        color: 'rgba(255,255,255,0.4)',
    },
    tabTextActive: {
        color: '#f43f5e',
    },
});

export default MusicPlayerOverlay;
