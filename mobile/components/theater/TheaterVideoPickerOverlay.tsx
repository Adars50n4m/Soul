import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    ActivityIndicator,
    Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import GlassView from '../ui/GlassView';
import {
    youtubeService,
    YouTubeSnippet,
    YOUTUBE_CATEGORY_PILLS,
    YouTubeCategoryPill,
} from '../../services/YouTubeService';
import { useApp } from '../../context/AppContext';

const SEARCH_DEBOUNCE_MS = 350;

const formatViews = (n?: number): string => {
    if (!n || n <= 0) return '';
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
};

const formatDuration = (sec?: number): string | null => {
    if (!sec || sec <= 0) return null;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
};

interface TheaterVideoPickerOverlayProps {
    accent: string;
    /** Already-playing videoId so we can mark it as the "Now playing" tile. */
    currentVideoId?: string;
    onPick: (video: YouTubeSnippet) => void;
    onClose: () => void;
    bottomInset: number;
}

const TheaterVideoPickerOverlay: React.FC<TheaterVideoPickerOverlayProps> = ({
    accent,
    currentVideoId,
    onPick,
    onClose,
    bottomInset,
}) => {
    const { activeTheme } = useApp() as any;
    const themeAccent = activeTheme?.primary || accent;
    const [query, setQuery] = useState('');
    const [activePill, setActivePill] = useState<YouTubeCategoryPill>(YOUTUBE_CATEGORY_PILLS[0]);
    const [items, setItems] = useState<YouTubeSnippet[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestSeqRef = useRef(0);

    const fetchForState = useCallback(async (q: string, pill: YouTubeCategoryPill) => {
        const seq = ++requestSeqRef.current;
        setLoading(true);
        setError(null);
        try {
            let result: { items: YouTubeSnippet[] };
            if (q.trim().length > 0) {
                result = await youtubeService.search(q.trim(), { maxResults: 24 });
            } else if (pill.searchKeyword) {
                result = await youtubeService.search(pill.searchKeyword, { maxResults: 24 });
            } else {
                result = await youtubeService.getTrending({
                    categoryId: pill.categoryId,
                    maxResults: 24,
                });
            }
            if (seq !== requestSeqRef.current) return;
            setItems(result.items);
        } catch (err: any) {
            if (seq !== requestSeqRef.current) return;
            console.warn('[TheaterVideoPicker] fetch failed:', err);
            setError(err?.message || 'Failed to load videos');
            setItems([]);
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!youtubeService.isConfigured()) {
            setError('YouTube API key missing.');
            return;
        }
        if (query.trim().length === 0) {
            void fetchForState('', activePill);
        }
    }, [activePill, fetchForState, query]);

    useEffect(() => {
        if (query.trim().length === 0) return;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            void fetchForState(query, activePill);
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [query, activePill, fetchForState]);

    const renderTile = useCallback(({ item }: { item: YouTubeSnippet }) => {
        const dur = formatDuration(item.durationSec);
        const views = formatViews(item.viewCount);
        const isNowPlaying = !!currentVideoId && item.videoId === currentVideoId;
        return (
            <Pressable
                style={[styles.tile, isNowPlaying && { opacity: 0.55 }]}
                onPress={() => {
                    if (isNowPlaying) return;
                    onPick(item);
                }}
                disabled={isNowPlaying}
            >
                <View style={styles.thumbWrap}>
                    {item.thumbnail ? (
                        <Image
                            source={{ uri: item.thumbnail }}
                            style={StyleSheet.absoluteFill}
                            contentFit="cover"
                            transition={120}
                            cachePolicy="memory-disk"
                        />
                    ) : (
                        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.06)' }]} />
                    )}
                    <LinearGradient
                        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.65)']}
                        locations={[0.5, 1]}
                        style={StyleSheet.absoluteFill}
                        pointerEvents="none"
                    />
                    {dur ? (
                        <View style={styles.durationChip}>
                            <Text style={styles.durationText}>{dur}</Text>
                        </View>
                    ) : null}
                    {isNowPlaying ? (
                        <View style={[styles.nowPlayingChip, { backgroundColor: themeAccent }]}>
                            <MaterialIcons name="play-arrow" size={11} color="#fff" />
                            <Text style={styles.nowPlayingText}>Now playing</Text>
                        </View>
                    ) : (
                        <View style={[styles.theaterBadge, { backgroundColor: themeAccent }]} pointerEvents="none">
                            <MaterialIcons name="movie" size={11} color="#fff" />
                        </View>
                    )}
                </View>
                <Text style={styles.tileTitle} numberOfLines={2}>{item.title}</Text>
                <View style={styles.metaRow}>
                    <Text style={styles.metaChannel} numberOfLines={1}>{item.channelTitle}</Text>
                    {views ? <Text style={styles.metaDot}> · </Text> : null}
                    {views ? <Text style={styles.metaViews}>{views}</Text> : null}
                </View>
            </Pressable>
        );
    }, [currentVideoId, onPick, themeAccent]);

    const pills = useMemo(() => YOUTUBE_CATEGORY_PILLS, []);
    const activePillLabel = query.trim().length === 0 ? activePill.label : '';

    return (
        <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(160)}
            style={StyleSheet.absoluteFill}
        >
            <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={onClose} />
            <Animated.View
                entering={SlideInDown.duration(240)}
                exiting={SlideOutDown.duration(200)}
                style={[styles.sheet, { paddingBottom: bottomInset + 6 }]}
            >
                <GlassView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />

                <View style={styles.handleRow}>
                    <View style={styles.handle} />
                    <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
                        <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.78)" />
                    </Pressable>
                </View>
                <Text style={styles.heading}>Change video</Text>
                <Text style={styles.subheading}>Both viewers will switch immediately.</Text>

                <View style={[styles.searchRow, Platform.OS === 'android' && { paddingVertical: 4 }]}>
                    <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                    <MaterialIcons name="search" size={18} color="rgba(255,255,255,0.55)" style={{ marginLeft: 4 }} />
                    <TextInput
                        style={styles.searchInput}
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search YouTube"
                        placeholderTextColor="rgba(255,255,255,0.4)"
                        autoCorrect={false}
                        returnKeyType="search"
                        underlineColorAndroid="transparent"
                    />
                    {query.length > 0 ? (
                        <Pressable onPress={() => setQuery('')} hitSlop={8} style={{ marginRight: 4 }}>
                            <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.55)" />
                        </Pressable>
                    ) : null}
                </View>

                <View style={styles.pillsRow}>
                    <FlashList
                        data={pills}
                        horizontal
                        keyExtractor={(p) => p.label}
                        showsHorizontalScrollIndicator={false}
                        estimatedItemSize={92}
                        extraData={{ activePillLabel, themeAccent }}
                        contentContainerStyle={{ paddingHorizontal: 12 }}
                        renderItem={({ item }) => {
                            const active = item.label === activePillLabel;
                            return (
                                <Pressable
                                    onPress={() => {
                                        setActivePill(item);
                                        setQuery('');
                                    }}
                                    style={[
                                        styles.pill,
                                        active && { backgroundColor: themeAccent, borderColor: themeAccent },
                                    ]}
                                >
                                    <Text style={[styles.pillText, active && { color: '#fff', fontWeight: '700' }]}>
                                        {item.label}
                                    </Text>
                                </Pressable>
                            );
                        }}
                    />
                </View>

                {error ? (
                    <View style={styles.errorBox}>
                        <View style={styles.errorRow}>
                            <MaterialIcons name="error-outline" size={20} color="rgba(255,255,255,0.8)" />
                            <Text style={styles.errorText}>{error}</Text>
                        </View>
                        <Pressable
                            style={[styles.retryBtn, { backgroundColor: themeAccent }]}
                            onPress={() => {
                                setError(null);
                                void fetchForState(query, activePill);
                            }}
                        >
                            <MaterialIcons name="refresh" size={14} color="#fff" />
                            <Text style={styles.retryBtnText}>Retry</Text>
                        </Pressable>
                    </View>
                ) : null}

                {loading && items.length === 0 ? (
                    <View style={styles.loadingWrap}>
                        <ActivityIndicator color={themeAccent} />
                    </View>
                ) : (
                    <FlashList
                        data={items}
                        keyExtractor={(it) => it.videoId}
                        numColumns={2}
                        estimatedItemSize={210}
                        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24 }}
                        renderItem={renderTile}
                        ListEmptyComponent={
                            !loading && !error ? (
                                <View style={styles.emptyWrap}>
                                    <MaterialIcons name="search-off" size={28} color="rgba(255,255,255,0.4)" />
                                    <Text style={styles.emptyText}>No results</Text>
                                </View>
                            ) : null
                        }
                    />
                )}
            </Animated.View>
        </Animated.View>
    );
};

export default TheaterVideoPickerOverlay;

const styles = StyleSheet.create({
    backdrop: {
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '85%',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,15,18,0.6)',
    },
    handleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 6,
        paddingHorizontal: 14,
    },
    handle: {
        width: 44,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.25)',
    },
    closeBtn: {
        position: 'absolute',
        right: 14,
        top: 0,
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    heading: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '700',
        textAlign: 'center',
        marginTop: 12,
        letterSpacing: 0.1,
    },
    subheading: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 11.5,
        textAlign: 'center',
        marginTop: 3,
        fontWeight: '500',
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    searchInput: {
        flex: 1,
        color: '#fff',
        fontSize: 14,
        fontWeight: '500',
        padding: 0,
    },
    pillsRow: {
        height: 44,
        marginTop: 12,
    },
    pill: {
        height: 32,
        paddingHorizontal: 14,
        borderRadius: 16,
        marginRight: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
    },
    pillText: {
        color: 'rgba(255,255,255,0.78)',
        fontSize: 13,
        fontWeight: '600',
        letterSpacing: 0.1,
    },
    tile: {
        flex: 1,
        margin: 6,
        borderRadius: 14,
    },
    thumbWrap: {
        aspectRatio: 16 / 10,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.04)',
        position: 'relative',
    },
    durationChip: {
        position: 'absolute',
        right: 6,
        bottom: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: 'rgba(0,0,0,0.7)',
    },
    durationText: {
        color: '#fff',
        fontSize: 10.5,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
    theaterBadge: {
        position: 'absolute',
        left: 6,
        top: 6,
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    nowPlayingChip: {
        position: 'absolute',
        left: 6,
        top: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 9,
    },
    nowPlayingText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 0.4,
    },
    tileTitle: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
        marginTop: 8,
        letterSpacing: 0.1,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 3,
    },
    metaChannel: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 11,
        fontWeight: '500',
        flexShrink: 1,
    },
    metaDot: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 11,
    },
    metaViews: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 11,
        fontWeight: '500',
    },
    loadingWrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyWrap: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 60,
        gap: 8,
    },
    emptyText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 13,
        fontWeight: '500',
    },
    errorBox: {
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: 'rgba(255,80,80,0.12)',
        borderWidth: 1,
        borderColor: 'rgba(255,80,80,0.32)',
        gap: 8,
    },
    errorRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    errorText: {
        color: 'rgba(255,255,255,0.9)',
        fontSize: 12.5,
        fontWeight: '600',
        flex: 1,
    },
    retryBtn: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 12,
    },
    retryBtnText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
});
