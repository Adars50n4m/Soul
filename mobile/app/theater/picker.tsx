import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    ActivityIndicator,
    Alert,
    Platform,
    ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    FadeIn,
    FadeOut,
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withSpring,
    interpolateColor,
    Easing,
} from 'react-native-reanimated';
import * as Crypto from 'expo-crypto';
import GlassView from '../../components/ui/GlassView';
import { useApp } from '../../context/AppContext';
import {
    youtubeService,
    YouTubeSnippet,
    YOUTUBE_CATEGORY_PILLS,
    YouTubeCategoryPill,
} from '../../services/YouTubeService';
import { encodeTheaterMetaIntoCaption } from '../../utils/theaterMetaCodec';
import type { Message } from '../../types';

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

const SEARCH_DEBOUNCE_MS = 350;

const PILL_INACTIVE_BG = 'rgba(255,255,255,0.06)';
const PILL_INACTIVE_BORDER = 'rgba(255,255,255,0.12)';
const PILL_INACTIVE_TEXT = 'rgba(255,255,255,0.78)';
const PILL_SLIDER_SPRING = { damping: 22, stiffness: 280, mass: 0.6 } as const;

type PillItemProps = {
    label: string;
    active: boolean;
    onPress: () => void;
    onLayout: (e: { nativeEvent: { layout: { x: number; width: number } } }) => void;
};

const PillItem: React.FC<PillItemProps> = React.memo(({ label, active, onPress, onLayout }) => {
    const progress = useSharedValue(active ? 1 : 0);

    useEffect(() => {
        progress.value = withTiming(active ? 1 : 0, {
            duration: 240,
            easing: Easing.bezier(0.2, 0.8, 0.2, 1),
        });
    }, [active, progress]);

    const animatedBox = useAnimatedStyle(() => ({
        backgroundColor: interpolateColor(
            progress.value,
            [0, 1],
            [PILL_INACTIVE_BG, 'rgba(0,0,0,0)'],
        ),
        borderColor: interpolateColor(
            progress.value,
            [0, 1],
            [PILL_INACTIVE_BORDER, 'rgba(0,0,0,0)'],
        ),
    }));

    const animatedText = useAnimatedStyle(() => ({
        color: interpolateColor(
            progress.value,
            [0, 1],
            [PILL_INACTIVE_TEXT, '#ffffff'],
        ),
    }));

    return (
        <Animated.View style={[styles.pill, animatedBox]} onLayout={onLayout}>
            <Pressable onPress={onPress} style={styles.pillPressable}>
                <Animated.Text style={[styles.pillText, animatedText]}>
                    {label}
                </Animated.Text>
            </Pressable>
        </Animated.View>
    );
});
PillItem.displayName = 'PillItem';

export default function TheaterPickerScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{ chatId?: string; contactName?: string }>();
    const { activeTheme, currentUser, sendChatMessage } = useApp() as any;
    const accent = activeTheme?.primary || '#ff0080';

    const chatId = params.chatId ? String(params.chatId) : '';
    const contactName = params.contactName ? String(params.contactName) : '';

    const [query, setQuery] = useState('');
    const [activePill, setActivePill] = useState<YouTubeCategoryPill>(YOUTUBE_CATEGORY_PILLS[0]);
    const [items, setItems] = useState<YouTubeSnippet[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestSeqRef = useRef(0);
    const pillsScrollRef = useRef<ScrollView>(null);
    const pillLayoutsRef = useRef<Record<string, { x: number; width: number }>>({});
    const pillsContainerWidthRef = useRef(0);
    const sliderX = useSharedValue(0);
    const sliderWidth = useSharedValue(0);
    const sliderInitialized = useRef(false);

    useEffect(() => {
        const layout = pillLayoutsRef.current[activePill.label];
        if (!layout) return;
        if (!sliderInitialized.current) {
            sliderX.value = layout.x;
            sliderWidth.value = layout.width;
            sliderInitialized.current = true;
        } else {
            sliderX.value = withSpring(layout.x, PILL_SLIDER_SPRING);
            sliderWidth.value = withSpring(layout.width, PILL_SLIDER_SPRING);
        }
    }, [activePill.label, sliderX, sliderWidth]);

    const sliderStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: sliderX.value }],
        width: sliderWidth.value,
    }));

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
            if (seq !== requestSeqRef.current) return; // stale
            setItems(result.items);
        } catch (err: any) {
            if (seq !== requestSeqRef.current) return;
            console.warn('[Picker] fetch failed:', err);
            setError(err?.message || 'Failed to load videos');
            setItems([]);
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, []);

    // Initial load + reload on pill change.
    useEffect(() => {
        if (!youtubeService.isConfigured()) {
            setError('YouTube API key missing. Set EXPO_PUBLIC_YOUTUBE_API_KEY in .env and restart.');
            return;
        }
        if (query.trim().length === 0) {
            void fetchForState('', activePill);
        }
    }, [activePill, fetchForState, query]);

    // Debounced search.
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

    const handleClose = useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/' as any);
    }, [router]);

    const handlePickVideo = useCallback(async (video: YouTubeSnippet) => {
        if (!chatId) {
            Alert.alert('Theater', 'Missing chat context. Open from a chat.');
            return;
        }
        if (submitting) return;
        setSubmitting(true);

        const sessionId = Crypto.randomUUID();
        const messageId = Crypto.randomUUID();
        const hostId = currentUser?.id || 'me';
        const sessionTitle = contactName ? `${contactName} • Theater` : 'Theater Night';

        const theaterMeta = {
            sessionId,
            youtubeVideoId: video.videoId,
            mediaTitle: video.title,
            channelTitle: video.channelTitle,
            status: 'live' as const,
            participants: [hostId],
            hostId,
            isLocked: false,
            viewerCount: 1,
        };

        const media: Message['media'] = {
            type: 'theater_session',
            url: video.videoId, // Stored as the videoId; play via youtubeVideoId. R2 upload is not triggered for YouTube sources because there's no localFileUri.
            name: sessionTitle,
            thumbnail: video.thumbnail,
            duration: video.durationSec,
            // The DB only persists flat media columns, so we encode theater
            // meta into `caption` with a marker. Receivers decode it back into
            // `media.theater` at the persistRemoteMessageRow boundary so all
            // downstream code (card, player, sync) keeps working with the
            // structured object.
            caption: encodeTheaterMetaIntoCaption(theaterMeta),
            theater: theaterMeta,
        };

        try {
            await sendChatMessage(chatId, '', media, undefined, undefined, messageId);
            handleClose();
        } catch (err: any) {
            console.error('[Picker] sendChatMessage failed:', err);
            Alert.alert('Theater', err?.message || 'Failed to start session.');
            setSubmitting(false);
        }
    }, [chatId, contactName, currentUser?.id, sendChatMessage, submitting, handleClose]);

    const renderTile = useCallback(({ item }: { item: YouTubeSnippet }) => {
        const dur = formatDuration(item.durationSec);
        const views = formatViews(item.viewCount);
        return (
            <Pressable
                style={styles.tile}
                onPress={() => handlePickVideo(item)}
                disabled={submitting}
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
                    <View style={[styles.theaterBadge, { backgroundColor: accent }]} pointerEvents="none">
                        <MaterialIcons name="movie" size={11} color="#fff" />
                    </View>
                </View>
                <Text style={styles.tileTitle} numberOfLines={2}>{item.title}</Text>
                <View style={styles.metaRow}>
                    <Text style={styles.metaChannel} numberOfLines={1}>{item.channelTitle}</Text>
                    {views ? <Text style={styles.metaDot}> · </Text> : null}
                    {views ? <Text style={styles.metaViews}>{views}</Text> : null}
                </View>
            </Pressable>
        );
    }, [accent, submitting, handlePickVideo]);

    const pills = useMemo(() => YOUTUBE_CATEGORY_PILLS, []);

    return (
        <View style={styles.root}>
            <Pressable style={StyleSheet.absoluteFill} onPress={handleClose}>
                <View style={[StyleSheet.absoluteFill, styles.backdrop]} />
            </Pressable>

            <Animated.View
                entering={FadeIn.duration(220)}
                exiting={FadeOut.duration(180)}
                style={[
                    styles.sheet,
                    { paddingTop: 8, paddingBottom: insets.bottom + 6 },
                ]}
            >
                <GlassView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />

                <View style={styles.handle} />
                <Text style={styles.heading}>Choose media</Text>

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

                <View
                    style={styles.pillsRow}
                    onLayout={(e) => {
                        pillsContainerWidthRef.current = e.nativeEvent.layout.width;
                    }}
                >
                    <ScrollView
                        ref={pillsScrollRef}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ paddingHorizontal: 12, alignItems: 'center' }}
                        keyboardShouldPersistTaps="handled"
                    >
                        <Animated.View
                            pointerEvents="none"
                            style={[
                                styles.pillSlider,
                                { backgroundColor: accent, borderColor: accent },
                                sliderStyle,
                            ]}
                        />
                        {pills.map((item) => {
                            const active = item.label === activePill.label && query.trim().length === 0;
                            const handlePress = () => {
                                setActivePill(item);
                                setQuery('');
                                const layout = pillLayoutsRef.current[item.label];
                                const containerWidth = pillsContainerWidthRef.current;
                                if (layout && containerWidth > 0) {
                                    const targetX = Math.max(
                                        0,
                                        layout.x - (containerWidth - layout.width) / 2,
                                    );
                                    pillsScrollRef.current?.scrollTo({
                                        x: targetX,
                                        y: 0,
                                        animated: true,
                                    });
                                }
                            };
                            return (
                                <PillItem
                                    key={item.label}
                                    label={item.label}
                                    active={active}
                                    onPress={handlePress}
                                    onLayout={(e) => {
                                        const { x, width } = e.nativeEvent.layout;
                                        pillLayoutsRef.current[item.label] = { x, width };
                                        if (
                                            item.label === activePill.label &&
                                            !sliderInitialized.current &&
                                            width > 0
                                        ) {
                                            sliderX.value = x;
                                            sliderWidth.value = width;
                                            sliderInitialized.current = true;
                                        }
                                    }}
                                />
                            );
                        })}
                    </ScrollView>
                </View>

                {error ? (
                    <View style={styles.errorBox}>
                        <View style={styles.errorRow}>
                            <MaterialIcons name="error-outline" size={20} color="rgba(255,255,255,0.8)" />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.errorText}>{error}</Text>
                                {error.includes('googleapis.com') && Platform.OS === 'android' && (
                                    <Text style={styles.errorHint}>
                                        Tip: Emulator clocks can go out of sync. Restarting the emulator often fixes this.
                                    </Text>
                                )}
                            </View>
                        </View>
                        <Pressable
                            style={[styles.retryBtn, { backgroundColor: accent }]}
                            onPress={() => {
                                setError(null);
                                void fetchForState(query, activePill);
                            }}
                        >
                            <MaterialIcons name="refresh" size={14} color="#fff" />
                            <Text style={styles.retryBtnText}>Retry Now</Text>
                        </Pressable>
                    </View>
                ) : null}

                {loading && items.length === 0 ? (
                    <View style={styles.loadingWrap}>
                        <ActivityIndicator color={accent} />
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

            {submitting ? (
                <Animated.View
                    entering={FadeIn.duration(160)}
                    style={styles.submittingOverlay}
                    pointerEvents="auto"
                >
                    <ActivityIndicator color={accent} size="large" />
                    <Text style={styles.submittingText}>Starting theater…</Text>
                </Animated.View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    backdrop: {
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sheet: {
        height: '88%',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,15,18,0.6)',
    },
    handle: {
        alignSelf: 'center',
        width: 44,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.25)',
        marginTop: 4,
    },
    heading: {
        color: '#fff',
        fontSize: 17,
        fontWeight: '700',
        textAlign: 'center',
        marginTop: 14,
        letterSpacing: 0.1,
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
        marginRight: 8,
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    pillPressable: {
        flex: 1,
        paddingHorizontal: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pillSlider: {
        position: 'absolute',
        left: 0,
        top: 6,
        height: 32,
        borderRadius: 16,
        borderWidth: 1,
    },
    pillText: {
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.1,
        lineHeight: 16,
        includeFontPadding: false,
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
        lineHeight: 18,
    },
    errorHint: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 11,
        marginTop: 4,
        lineHeight: 15,
        fontWeight: '500',
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
    submittingOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.55)',
        gap: 12,
    },
    submittingText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
});
