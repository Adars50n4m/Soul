import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import { setTheaterMorphOrigin } from '../../utils/theaterMorphOrigins';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withSequence,
    withTiming,
    Easing,
} from 'react-native-reanimated';
import GlassView from '../ui/GlassView';
import type { TheaterSessionMeta } from '../../types';
import { SUPPORT_SHARED_TRANSITIONS, SOUL_LIQUID_TRANSITION } from '../../constants/sharedTransitions';

const AnimatedImage = Animated.createAnimatedComponent(Image);

const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
};

const formatDuration = (seconds?: number): string | null => {
    if (!seconds || seconds <= 0) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
};

interface TheaterSessionCardProps {
    sessionId: string;
    title?: string;
    thumbnail?: string;
    duration?: number;
    theater?: TheaterSessionMeta;
    isMe: boolean;
    accent: string;
    onJoin: () => void;
    onEnd?: () => void;
}

const CARD_WIDTH = 260;
const CARD_HEIGHT = 168;

const TheaterSessionCard: React.FC<TheaterSessionCardProps> = ({
    sessionId,
    title,
    thumbnail,
    duration,
    theater,
    isMe,
    accent,
    onJoin,
    onEnd,
}) => {
    const status = theater?.status || 'live';
    // A theater_session message that lost its YouTube videoId across the DB
    // round-trip is functionally dead — no playback is possible. Treat it the
    // same as an explicit `ended` so the bubble grays out and Join is gone
    // instead of routing the user into an error alert.
    const isOrphan = !theater?.youtubeVideoId;
    const isEnded = status === 'ended' || isOrphan;
    const isLive = status === 'live' && !isOrphan;
    const isLocked = !!theater?.isLocked;
    const viewerCount = theater?.viewerCount ?? theater?.participants?.length ?? 1;
    const mediaTitle = theater?.mediaTitle;
    const durationLabel = formatDuration(duration);

    const livePulse = useSharedValue(1);
    useEffect(() => {
        if (!isLive) return;
        livePulse.value = withRepeat(
            withSequence(
                withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.quad) }),
                withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
            ),
            -1,
            false,
        );
    }, [isLive, livePulse]);

    const livePulseStyle = useAnimatedStyle(() => ({ opacity: livePulse.value }));

    const useSharedTransition = SUPPORT_SHARED_TRANSITIONS && Platform.OS === 'ios';
    const sharedTag = `theater-poster-${sessionId}`;
    const sharedCardTag = `theater-card-${sessionId}`;

    // Refs and handlers that capture the card's screen-space rect at the
    // moment the user taps Join, so the theater screen can animate UP from
    // that exact origin into a full-screen video area.
    const cardRef = useRef<View>(null);
    const captureOriginAndJoin = useCallback(() => {
        const node = cardRef.current as any;
        if (node && typeof node.measureInWindow === 'function') {
            try {
                node.measureInWindow((x: number, y: number, width: number, height: number) => {
                    if (typeof x === 'number' && typeof y === 'number' && width > 0 && height > 0) {
                        setTheaterMorphOrigin(sessionId, { x, y, width, height });
                    }
                    onJoin();
                });
                return;
            } catch {}
        }
        onJoin();
    }, [sessionId, onJoin]);

    return (
        <Animated.View
            ref={cardRef}
            {...(useSharedTransition ? {
                sharedTransitionTag: sharedCardTag,
                sharedTransitionStyle: SOUL_LIQUID_TRANSITION,
            } : {})}
            collapsable={false}
            style={[
                styles.card,
                {
                    borderColor: isMe ? hexToRgba(accent, 0.35) : 'rgba(255,255,255,0.12)',
                    opacity: isEnded ? 0.7 : 1,
                },
            ]}
        >
            <Pressable
                onPress={isEnded ? undefined : captureOriginAndJoin}
                disabled={isEnded}
                style={StyleSheet.absoluteFill}
            >
            {thumbnail ? (
                useSharedTransition ? (
                    <AnimatedImage
                        sharedTransitionTag={sharedTag}
                        sharedTransitionStyle={SOUL_LIQUID_TRANSITION}
                        source={{ uri: thumbnail }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={120}
                        cachePolicy="memory-disk"
                    />
                ) : (
                    <Image
                        source={{ uri: thumbnail }}
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                        transition={120}
                        cachePolicy="memory-disk"
                    />
                )
            ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: hexToRgba(accent, 0.22) }]}>
                    <View style={styles.posterPlaceholder}>
                        <MaterialIcons name="movie" size={42} color="rgba(255,255,255,0.55)" />
                    </View>
                </View>
            )}

            <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.05)', 'rgba(0,0,0,0.78)']}
                locations={[0, 0.45, 1]}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
            />

            <View style={styles.topRow} pointerEvents="none">
                {isLive && (
                    <View style={[styles.livePill, { backgroundColor: hexToRgba(accent, 0.95) }]}>
                        <Animated.View style={[styles.liveDot, livePulseStyle]} />
                        <Text style={styles.liveText}>LIVE</Text>
                    </View>
                )}
                {status === 'scheduled' && (
                    <View style={styles.scheduledPill}>
                        <MaterialIcons name="schedule" size={11} color="#fff" />
                        <Text style={styles.scheduledText}>SCHEDULED</Text>
                    </View>
                )}
                {isEnded && (
                    <View style={styles.endedPill}>
                        <MaterialIcons name="stop-circle" size={11} color="rgba(255,255,255,0.85)" />
                        <Text style={styles.endedText}>ENDED</Text>
                    </View>
                )}
                <View style={{ flex: 1 }} />
                {isLocked && (
                    <View style={styles.lockChip}>
                        <MaterialIcons name="lock" size={13} color="rgba(255,255,255,0.92)" />
                    </View>
                )}
            </View>

            {durationLabel && (
                <View style={styles.durationChip} pointerEvents="none">
                    <MaterialIcons name="play-arrow" size={12} color="rgba(255,255,255,0.92)" />
                    <Text style={styles.durationText}>{durationLabel}</Text>
                </View>
            )}

            <View style={styles.footer}>
                <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                <View style={styles.footerInner}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text numberOfLines={1} style={styles.title}>
                            {title || 'Theater Night'}
                        </Text>
                        {mediaTitle ? (
                            <Text numberOfLines={1} style={styles.subtitle}>
                                {mediaTitle}
                            </Text>
                        ) : (
                            <View style={styles.viewerRow}>
                                <MaterialIcons name="visibility" size={11} color="rgba(255,255,255,0.6)" />
                                <Text style={styles.viewerText}>
                                    {viewerCount} watching
                                </Text>
                            </View>
                        )}
                    </View>
                    {isEnded ? (
                        <View style={styles.endedPillFooter}>
                            <Text style={styles.endedFooterText}>Ended</Text>
                        </View>
                    ) : (
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            {isMe && onEnd && (
                                <Pressable
                                    onPress={(e) => {
                                        e.stopPropagation();
                                        onEnd();
                                    }}
                                    style={styles.endActionPill}
                                >
                                    <Text style={styles.endActionText}>End</Text>
                                </Pressable>
                            )}
                            <View style={[styles.joinPill, { backgroundColor: accent }]}>
                                <Text style={styles.joinText}>Join</Text>
                                <MaterialIcons name="arrow-forward" size={14} color="#fff" />
                            </View>
                        </View>
                    )}
                </View>
            </View>
            </Pressable>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    card: {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    posterPlaceholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    topRow: {
        position: 'absolute',
        top: 10,
        left: 10,
        right: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    livePill: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 10,
        gap: 5,
    },
    liveDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#fff',
    },
    liveText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 0.8,
    },
    scheduledPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 10,
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
    },
    scheduledText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.6,
    },
    endedPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 10,
        backgroundColor: 'rgba(255,255,255,0.12)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
    },
    endedText: {
        color: 'rgba(255,255,255,0.85)',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.6,
    },
    endedPillFooter: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
    },
    endedFooterText: {
        color: 'rgba(255,255,255,0.75)',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    lockChip: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
    },
    durationChip: {
        position: 'absolute',
        top: 10,
        right: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 9,
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    durationText: {
        color: 'rgba(255,255,255,0.92)',
        fontSize: 10.5,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
    footer: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 56,
        overflow: 'hidden',
    },
    footerInner: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
    },
    title: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
        letterSpacing: 0.1,
    },
    subtitle: {
        color: 'rgba(255,255,255,0.72)',
        fontSize: 11.5,
        fontWeight: '500',
        marginTop: 2,
    },
    viewerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 3,
    },
    viewerText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 11,
        fontWeight: '500',
    },
    joinPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 14,
    },
    joinText: {
        color: '#fff',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    endActionPill: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(255,59,48,0.3)',
    },
    endActionText: {
        color: '#ff3b30',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
});

export default TheaterSessionCard;
