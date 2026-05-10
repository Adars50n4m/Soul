import React, { useRef, useCallback, useMemo, useEffect } from 'react';
import { View, Text, Pressable, Alert, Image as RNImage, Linking } from 'react-native';
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import { Image } from 'expo-image';
import { getInfoAsync } from 'expo-file-system';
import LottieView from 'lottie-react-native';
import GlassView from '../ui/GlassView';
import { MaterialIcons } from '@expo/vector-icons';
import { hapticService } from '../../services/HapticService';
import * as Haptics from 'expo-haptics';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withSpring, 
    withTiming,
    withSequence,
    withRepeat,
    interpolateColor,
    runOnJS 
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useApp } from '../../context/AppContext';
import { Message } from '../../types';
import { ChatStyles } from './ChatStyles';
import { getMessageMediaItems } from '../../utils/chatUtils';
import VoiceNotePlayer from './VoiceNotePlayer';
import TheaterSessionCard from './TheaterSessionCard';
import { SpoilerView } from 'react-native-spoiler-view';
import { R2_CONFIG } from '../../config/r2';

const R2_PUBLIC_BASE = R2_CONFIG.PUBLIC_URL && !R2_CONFIG.PUBLIC_URL.includes('XXXXXXXXXXXX')
    ? R2_CONFIG.PUBLIC_URL.replace(/\/$/, '')
    : null;

/** Convert hex color to rgba */
const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
};

/** Resolve a media URL — if it's an R2 key (not a full URL), prepend R2 public base */
const resolveMediaUrl = (url?: string): string | undefined => {
    if (!url) return undefined;
    if (url.startsWith('http') || url.startsWith('file:') || url.startsWith('data:')) return url;
    if (R2_PUBLIC_BASE) return `${R2_PUBLIC_BASE}/${url}`;
    return undefined;
};

interface MessageBubbleProps {
    msg: Message;
    contactName: string;
    onLongPress?: (id: string, layout: any) => void;
    onReply?: (m: Message) => void;
    isSelected?: boolean;
    onReaction?: (emoji: string) => void;
    quotedMessage?: Message | null;
    onDoubleTap?: (id: string, mediaIndex?: number) => void;
    remoteLikePulse?: { messageId: string; mediaIndex: number; nonce: number } | null;
    onMediaTap?: (data: any) => void;
    isClone?: boolean;
    selectionMode?: boolean;
    isChecked?: boolean;
    onSelectToggle?: (id: string) => void;
    initialAspectRatio?: number | null;
    isHighlighted?: boolean;
    onQuotePress?: (msgId: string) => void;
    uploadProgress?: number;
    onMediaDownload?: (msgId: string, url: string, index: number, manual?: boolean) => void;
    onRetry?: (msgId: string) => void;
    isHidden?: boolean;
    isAdmin?: boolean;
    senderRole?: string;
    onTheaterEnd?: (msgId: string, theaterData: any) => void;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

/** Circular upload progress indicator with stop button */
const UploadProgressRing = ({ progress, size = 52 }: { progress: number; size?: number }) => {
    const stroke = 3;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference * (1 - progress);

    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
                <SvgCircle
                    cx={size / 2} cy={size / 2} r={radius}
                    stroke="rgba(255,255,255,0.2)" strokeWidth={stroke} fill="none"
                />
                <SvgCircle
                    cx={size / 2} cy={size / 2} r={radius}
                    stroke="#fff" strokeWidth={stroke} fill="none"
                    strokeDasharray={`${circumference}`}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                />
            </Svg>
            <MaterialIcons name="close" size={size * 0.38} color="#fff" />
        </View>
    );
};

const LinkedText = ({ text, style }: { text: string; style: any }) => {
    const parts = text.split(URL_REGEX);
    if (parts.length === 1) return <Text style={style}>{text}</Text>;

    return (
        <Text style={style}>
            {parts.map((part, i) =>
                URL_REGEX.test(part) ? (
                    <Text
                        key={i}
                        style={{ textDecorationLine: 'underline', color: '#60a5fa' }}
                        onPress={() => Linking.openURL(part).catch(() => {})}
                    >
                        {part}
                    </Text>
                ) : (
                    <Text key={i}>{part}</Text>
                )
            )}
        </Text>
    );
};

const formatTime = (ts: string) => {
    if (!ts) return '';
    if (ts.includes('AM') || ts.includes('PM') || ts.includes(':')) {
        if (!ts.includes('T')) return ts; 
    }
    try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return ts;
    }
};

const areNumberArraysEqual = (a: number[], b: number[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

const isSameRatio = (current: number | null, next: number) => {
    if (current == null) return false;
    return Math.abs(current - next) < 0.02;
};

const mediaAspectRatioCache = new Map<string, number>();
const DEFAULT_MEDIA_RATIO = 0.78;
const MEDIA_DOUBLE_TAP_DELAY_MS = 260;
const MEDIA_LIKE_ANIMATION_HIDE_MS = 920;
const MEDIA_LIKE_ANIMATION_SOURCE = {
    uri: 'https://lottie.host/a1007fcc-beef-400c-ae66-36168992c97a/GaYBDY5AIT.lottie',
};

const isLikeableMediaType = (type?: string) => type === 'image' || type === 'status_reply';
const VIDEO_URL_REGEX = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i;

/** WhatsApp-style colors for different group members */
const SENDER_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', 
    '#F06292', '#AED581', '#FFD54F', '#4DB6AC', '#7986CB',
    '#9575CD', '#FF8A65', '#4FC3F7', '#81C784', '#DCE775'
];

const getSenderColor = (senderId: string) => {
    if (!senderId) return SENDER_COLORS[0];
    let hash = 0;
    for (let i = 0; i < senderId.length; i++) {
        hash = senderId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
};

const MessageBubble = React.memo(({ 
  msg, 
  contactName, 
  onLongPress, 
  onReply, 
  isSelected, 
  onReaction,
  quotedMessage,
  onDoubleTap,
  remoteLikePulse,
  onMediaTap,
  isClone,
  selectionMode,
  isChecked,
  onSelectToggle,
  initialAspectRatio,
  isHighlighted = false,
  onQuotePress,
  uploadProgress,
    onMediaDownload,
    onRetry,
    isHidden,
    isAdmin = false,
    senderRole,
    onTheaterEnd,
}: MessageBubbleProps) => {
    // Fade-in when transitioning from hidden → visible (flying bubble handoff)
    const revealOpacity = useSharedValue(isHidden ? 0 : 1);
    const wasHidden = useRef(isHidden);
    useEffect(() => {
        if (wasHidden.current && !isHidden) {
            revealOpacity.value = 0;
            revealOpacity.value = withTiming(1, { duration: 250 });
        }
        wasHidden.current = isHidden;
    }, [isHidden, revealOpacity]);

    const revealStyle = useAnimatedStyle(() => ({
        opacity: revealOpacity.value,
    }));

    const initialMediaItems = getMessageMediaItems(msg);
    const initialMediaSource =
        initialMediaItems[0]?.localFileUri ||
        (initialMediaItems[0]?.url && (
            initialMediaItems[0].url.startsWith('http') ||
            initialMediaItems[0].url.startsWith('file:') ||
            initialMediaItems[0].url.startsWith('data:')
        ) ? initialMediaItems[0].url : undefined) ||
        initialMediaItems[0]?.thumbnail ||
        null;
    const cachedAspectRatio = initialMediaSource ? mediaAspectRatioCache.get(`${msg.id}:${initialMediaSource}`) ?? null : null;
    const { activeTheme } = useApp();
    const [aspectRatio, setAspectRatio] = React.useState<number | null>(initialAspectRatio || cachedAspectRatio || null);
    const [downloadingIndices, setDownloadingIndices] = React.useState<number[]>([]);
    const [invalidLocalIndices, setInvalidLocalIndices] = React.useState<number[]>([]);
    const [likeAnimation, setLikeAnimation] = React.useState<{ index: number; nonce: number } | null>(null);
    const translateX = useSharedValue(0);
    const likeAnimationOpacity = useSharedValue(0);
    const likeAnimationScale = useSharedValue(0.72);
    const isMe = msg.sender === 'me';
    const bubbleRef = useRef<View>(null);
    const likeHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastLongPressAtRef = useRef(0);
    const pendingMediaTapRef = useRef<{
        index: number;
        at: number;
        timeout: ReturnType<typeof setTimeout> | null;
    }>({
        index: -1,
        at: 0,
        timeout: null,
    });

    const mediaItems = useMemo(() => getMessageMediaItems(msg), [msg]);
    const enableMessageLevelDoubleTap = useMemo(
        () => !mediaItems.some((media) => isLikeableMediaType(media.type)),
        [mediaItems]
    );
    const mediaValidationKey = useMemo(
        () => mediaItems.map((media, index) => `${index}:${media.localFileUri || ''}:${media.url || ''}:${media.thumbnail || ''}`).join('|'),
        [mediaItems]
    );
    const invalidLocalIndexSet = useMemo(() => new Set(invalidLocalIndices), [invalidLocalIndices]);
    const primaryMediaPreviewSource = useMemo(() => {
        const media = mediaItems[0];
        if (!media || media.type === 'audio') return null;
        const usableLocalUri = invalidLocalIndexSet.has(0) ? undefined : media.localFileUri;
        const fallbackRemoteUri = resolveMediaUrl(media.url);
        return usableLocalUri || fallbackRemoteUri || media.thumbnail || null;
    }, [mediaItems, invalidLocalIndexSet]);
    const primaryMediaAspectCacheKey = primaryMediaPreviewSource ? `${msg.id}:${primaryMediaPreviewSource}` : null;
    const isValidatingRef = useRef(false);
    React.useEffect(() => {
        let cancelled = false;

        const validateLocalMedia = async () => {
            if (isValidatingRef.current) return;
            isValidatingRef.current = true;
            
            const results = await Promise.all(mediaItems.map(async (media, index) => {
                if (!media.localFileUri) return null;
                try {
                    const info = await getInfoAsync(media.localFileUri);
                    return info.exists ? null : index;
                } catch {
                    return index;
                }
            }));

            if (!cancelled) {
                const nextInvalidIndices = results.filter((value): value is number => value !== null);
                setInvalidLocalIndices((prev) => (
                    areNumberArraysEqual(prev, nextInvalidIndices) ? prev : nextInvalidIndices
                ));
            }
            isValidatingRef.current = false;
        };

        validateLocalMedia();
        return () => { cancelled = true; };
    }, [mediaItems, mediaValidationKey]);

    React.useEffect(() => {
        if (!primaryMediaPreviewSource || aspectRatio != null) return;

        let cancelled = false;

        RNImage.getSize(
            primaryMediaPreviewSource,
            (width, height) => {
                if (cancelled || !width || !height) return;
                const ratio = Math.max(0.6, Math.min(width / height, 1.8));
                if (primaryMediaAspectCacheKey) {
                    mediaAspectRatioCache.set(primaryMediaAspectCacheKey, ratio);
                }
                setAspectRatio(prev => (isSameRatio(prev, ratio) ? prev : ratio));
            },
            () => {
                if (!cancelled) {
                    // Fallback to square aspect ratio on measurement failure
                    setAspectRatio(prev => prev ?? 1);
                }
            }
        );

        return () => {
            cancelled = true;
        };
    }, [aspectRatio, primaryMediaAspectCacheKey, primaryMediaPreviewSource]);

    React.useEffect(() => () => {
        if (pendingMediaTapRef.current.timeout) {
            clearTimeout(pendingMediaTapRef.current.timeout);
        }
        if (likeHideTimeoutRef.current) {
            clearTimeout(likeHideTimeoutRef.current);
        }
    }, []);
    
    // Clear downloading state if download failed
    React.useEffect(() => {
        if ((msg as any).downloadFailed && downloadingIndices.length > 0) {
            setDownloadingIndices([]);
        }
    }, [(msg as any).downloadFailed]);

    const downloadTriggeredRef = useRef<{ [key: string]: boolean }>({});

    React.useEffect(() => {
        if (!isMe && onMediaDownload) {
            mediaItems.forEach((media, index) => {
                if (media.type === 'status_reply' || media.type === 'theater_session') {
                    return;
                }
                const usableLocalUri = invalidLocalIndexSet.has(index) ? undefined : media.localFileUri;

                // Stop loop: If we are currently validating files, wait.
                if (isValidatingRef.current) return;

                const runKey = `${msg.id}:${index}`;

                // If we JUST got the localFileUri, remove it from downloadingIndices
                if (usableLocalUri && downloadingIndices.includes(index)) {
                    console.log(`[MessageBubble] Media downloaded: clearing index ${index}`);
                    setDownloadingIndices(prev => prev.filter(i => i !== index));
                    
                    // CRITICAL: We do NOT delete the trigger ref here if we want to prevent re-downloads
                    // during state-sync races. Keeping it true for the component lifetime.
                    downloadTriggeredRef.current[runKey] = true;
                    return;
                }

                // Auto-download any media we don't have locally (keys or remote URLs)
                if (media.url && !usableLocalUri && !downloadingIndices.includes(index)) {
                    const isLocalPath = media.url.startsWith('file:') || media.url.startsWith('data:');
                    if (!isLocalPath) {
                        if (downloadTriggeredRef.current[runKey]) return; // Stop the loop!

                        console.log(`[MessageBubble] Auto-downloading media: ${media.url.substring(0, 60)}...`);
                        downloadTriggeredRef.current[runKey] = true;
                        setDownloadingIndices(prev => [...prev, index]);
                        onMediaDownload(msg.id, media.url, index, false);
                    }
                }
            });
        }
    }, [isMe, msg.id, mediaItems, onMediaDownload, downloadingIndices, invalidLocalIndexSet]);

    const hasText = !!msg.text;
    const hasCaption = !!msg.media?.caption;
    // theater_session smuggles meta through media.caption, so hasCaption is
    // misleadingly true for fresh sends — treat it like a media-only bubble
    // so the red sender background doesn't leak around the card.
    const isTheaterCardMessage = mediaItems[0]?.type === 'theater_session';
    const isMediaOnly = mediaItems.length > 0 && !hasText && (isTheaterCardMessage || !hasCaption) && mediaItems[0].type !== 'audio';
    // theater_session reuses media.caption to smuggle structured meta through
    // the flat-column DB schema. The codec strips it on DB-read, but a freshly
    // sent local copy goes straight from picker → state → bubble without that
    // hop, so the raw `__THEATER_META_V1__:{…}` blob would otherwise leak as a
    // visible caption underneath the theater card. Always suppress here.
    const showStandaloneCaption = !!msg.media?.caption
        && msg.media?.type !== 'status_reply'
        && msg.media?.type !== 'theater_session';

    const doubleTapGesture = Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(250)
        .onEnd(() => {
            if (enableMessageLevelDoubleTap && onDoubleTap) runOnJS(onDoubleTap)(msg.id);
        });

    const measureAndShowMenu = useCallback((id: string) => {
        bubbleRef.current?.measure((x, y, width, height, pageX, pageY) => {
            if (onLongPress) {
                onLongPress(id, { x: pageX, y: pageY, width, height, aspectRatio });
            }
        });
    }, [onLongPress, aspectRatio]);

    const measureAndShowMedia = useCallback((index: number, openGallery: boolean) => {
        bubbleRef.current?.measure((x, y, width, height, pageX, pageY) => {
            if (onMediaTap) {
                onMediaTap({
                    messageId: msg.id,
                    mediaItems,
                    index,
                    openGallery,
                    layout: { x: pageX, y: pageY, width, height }
                });
            }
        });
    }, [onMediaTap, msg.id, mediaItems]);

    const longPressGesture = Gesture.LongPress()
        .minDuration(400)
        .runOnJS(true)
        .onStart(() => {
            if (!selectionMode && !isClone) {
                lastLongPressAtRef.current = Date.now();
                hapticService.impact(Haptics.ImpactFeedbackStyle.Medium);
                measureAndShowMenu(msg.id);
            }
        });

    const panGesture = Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onUpdate((e) => {
            if (!selectionMode && !isClone) {
                if (isMe) {
                    // Sent message (right side): swipe LEFT toward the chat
                    // body to reply — matches WhatsApp/iMessage convention
                    // where the gesture direction points away from the
                    // bubble's edge of the screen.
                    translateX.value = Math.min(0, Math.max(e.translationX, -80));
                } else {
                    // Received message (left side): swipe RIGHT toward the
                    // chat body to reply.
                    translateX.value = Math.max(0, Math.min(e.translationX, 80));
                }
            }
        })
        .onEnd(() => {
            const threshold = 60;
            const isTriggered = isMe ? translateX.value < -threshold : translateX.value > threshold;

            if (isTriggered && onReply && !isClone) {
                runOnJS(hapticService.notification)(Haptics.NotificationFeedbackType.Success);
                runOnJS(onReply)(msg);
            }
            translateX.value = withSpring(0);
        });

    const singleTapGesture = Gesture.Tap()
        .onEnd(() => {
            if (selectionMode && onSelectToggle && !isClone) {
                runOnJS(onSelectToggle)(msg.id);
            }
        });

    const composedGestures = selectionMode
        ? singleTapGesture
        : enableMessageLevelDoubleTap
            ? Gesture.Simultaneous(panGesture, Gesture.Exclusive(doubleTapGesture, longPressGesture))
            : Gesture.Simultaneous(panGesture, longPressGesture);

    const highlightProgress = useSharedValue(0);

    React.useEffect(() => {
        if (isHighlighted) {
            highlightProgress.value = withSequence(
                withTiming(1, { duration: 200 }),
                withRepeat(withTiming(0, { duration: 400 }), 3, true),
                withTiming(0, { duration: 200 })
            );
        }
    }, [isHighlighted, highlightProgress]);

    const bubbleStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: translateX.value }],
        backgroundColor: interpolateColor(
            highlightProgress.value,
            [0, 1],
            ['transparent', 'rgba(255, 255, 255, 0.3)']
        )
    }));

    const likeAnimationStyle = useAnimatedStyle(() => ({
        opacity: likeAnimationOpacity.value,
        transform: [{ scale: likeAnimationScale.value }],
    }));

    const iconStyle = useAnimatedStyle(() => {
        const absX = Math.abs(translateX.value);
        const opacity = absX / 60;
        const scale = Math.min(opacity, 1);

        // Slide the icon in from the side opposite to the swipe direction:
        //  - isMe (right bubble) swipes LEFT, so the icon is anchored to the
        //    bubble's right edge and slides inward (rightward → leftward) as
        //    the swipe progresses. Starts offscreen-right (iconX=+60), settles
        //    at iconX=0 once threshold is reached.
        //  - !isMe (left bubble) swipes RIGHT — icon anchored on the left edge,
        //    slides inward from the left (iconX=-60 → 0).
        const iconX = isMe ? (60 - absX) : (absX - 60);

        return {
            opacity,
            transform: [
                { translateX: iconX },
                { scale: scale }
            ] as any,
        };
    });

    const clearPendingMediaTap = useCallback(() => {
        if (pendingMediaTapRef.current.timeout) {
            clearTimeout(pendingMediaTapRef.current.timeout);
        }
        pendingMediaTapRef.current = {
            index: -1,
            at: 0,
            timeout: null,
        };
    }, []);

    const handleMediaPress = useCallback((index: number, openGallery = false) => {
        if (!isClone) {
            const media = mediaItems[index];
            const usableLocalUri = invalidLocalIndexSet.has(index) ? undefined : media.localFileUri;
            if (!isMe && media.type !== 'status_reply' && !usableLocalUri && onMediaDownload) {
                if (!media.url) {
                    Alert.alert('Media Unavailable', 'This media hasn\'t been uploaded yet. Ask the sender to resend it.');
                    return;
                }
                
                // MANUAL BYPASS: Allow manual triggers to ignore the downloadTriggeredRef lock.
                // This serves as a fail-safe if the auto-download or state sync misses a beat.
                if (downloadingIndices.includes(index)) {
                    console.log(`[MessageBubble] Manual download suppressed: index ${index} already in progress`);
                    return;
                }

                console.log(`[MessageBubble] Downloading media for ${msg.id}: ${media.url.substring(0, 60)}`);
                const runKey = `${msg.id}:${index}`;
                downloadTriggeredRef.current[runKey] = true;
                setDownloadingIndices(prev => [...prev, index]);
                onMediaDownload(msg.id, media.url, index, true);
                return;
            }
            measureAndShowMedia(index, openGallery);
        }
    }, [downloadingIndices, invalidLocalIndexSet, isClone, isMe, mediaItems, measureAndShowMedia, msg.id, onMediaDownload]);

    const triggerLikeAnimation = useCallback((index: number) => {
        if (likeHideTimeoutRef.current) {
            clearTimeout(likeHideTimeoutRef.current);
        }

        clearPendingMediaTap();
        setLikeAnimation((prev) => ({
            index,
            nonce: (prev?.nonce ?? 0) + 1,
        }));

        hapticService.impact(Haptics.ImpactFeedbackStyle.Light);

        likeAnimationOpacity.value = 0;
        likeAnimationScale.value = 0.72;
        likeAnimationOpacity.value = withSequence(
            withTiming(1, { duration: 90 }),
            withTiming(1, { duration: 560 }),
            withTiming(0, { duration: 220 })
        );
        likeAnimationScale.value = withSequence(
            withSpring(1.08, { damping: 13, stiffness: 220 }),
            withTiming(0.96, { duration: 170 }),
            withTiming(1, { duration: 110 })
        );

        likeHideTimeoutRef.current = setTimeout(() => {
            setLikeAnimation(null);
        }, MEDIA_LIKE_ANIMATION_HIDE_MS);
    }, [clearPendingMediaTap, likeAnimationOpacity, likeAnimationScale]);

    const lastRemotePulseNonceRef = useRef<number | null>(null);
    React.useEffect(() => {
        if (!remoteLikePulse) return;
        if (remoteLikePulse.messageId !== msg.id) return;
        if (remoteLikePulse.nonce === lastRemotePulseNonceRef.current) return;
        lastRemotePulseNonceRef.current = remoteLikePulse.nonce;
        const idx = Number.isFinite(remoteLikePulse.mediaIndex) ? remoteLikePulse.mediaIndex : 0;
        triggerLikeAnimation(idx);
    }, [remoteLikePulse, msg.id, triggerLikeAnimation]);

    const handleMediaTapIntent = useCallback((index: number, openGallery = false) => {
        const media = mediaItems[index];
        if (!media) return;

        if (Date.now() - lastLongPressAtRef.current < 450) {
            return;
        }

        if (!isLikeableMediaType(media.type) || selectionMode || isClone) {
            handleMediaPress(index, openGallery);
            return;
        }

        const now = Date.now();
        const pending = pendingMediaTapRef.current;
        const isDoubleTap =
            pending.timeout &&
            pending.index === index &&
            now - pending.at <= MEDIA_DOUBLE_TAP_DELAY_MS;

        if (isDoubleTap) {
            clearPendingMediaTap();
            triggerLikeAnimation(index);
            onDoubleTap?.(msg.id, index);
            return;
        }

        clearPendingMediaTap();
        pendingMediaTapRef.current = {
            index,
            at: now,
            timeout: setTimeout(() => {
                clearPendingMediaTap();
                handleMediaPress(index, openGallery);
            }, MEDIA_DOUBLE_TAP_DELAY_MS),
        };
    }, [clearPendingMediaTap, handleMediaPress, isClone, mediaItems, msg.id, onDoubleTap, selectionMode, triggerLikeAnimation]);

    const renderLikeOverlay = (index: number, size: number, borderRadius = 12) => {
        if (likeAnimation?.index !== index) return null;

        return (
            <Animated.View
                pointerEvents="none"
                style={[
                    ChatStyles.mediaLikeOverlay,
                    { borderRadius },
                    likeAnimationStyle,
                ]}
            >
                <LottieView
                    key={`media-like-${msg.id}-${likeAnimation.nonce}`}
                    source={MEDIA_LIKE_ANIMATION_SOURCE}
                    autoPlay
                    loop={false}
                    style={{ width: size, height: size }}
                />
            </Animated.View>
        );
    };

    const STATUS_EXPIRATION_MS = 24 * 60 * 60 * 1000;

    const isStatusExpired = (timestamp: string): boolean => {
        if (!timestamp) return false;
        try {
            const msgTime = new Date(timestamp).getTime();
            const now = Date.now();
            return (now - msgTime) > STATUS_EXPIRATION_MS;
        } catch {
            return false;
        }
    };

    const renderStatusReplyCard = (media: typeof mediaItems[number], index: number) => {
        const expired = isStatusExpired(msg.timestamp);
        const usableLocalUri = invalidLocalIndexSet.has(index) ? undefined : media.localFileUri;
        const fallbackRemoteUri = resolveMediaUrl(media.url);
        const previewSource = usableLocalUri || media.thumbnail || fallbackRemoteUri;
        const canRenderPreview = !!previewSource && !VIDEO_URL_REGEX.test(previewSource);
        
        // 🛡️ Logic: If expired, show "Status expired" regardless of original caption
        const statusSnippet = expired 
            ? 'Status expired' 
            : (media.caption?.trim() || 'Tap to view status');

        const handlePress = () => {
            if (expired) {
                hapticService.notification(Haptics.NotificationFeedbackType.Warning);
                Alert.alert(
                    'Status Expired',
                    'This status was posted more than 24 hours ago and is no longer available.',
                    [{ text: 'OK' }]
                );
                return;
            }
            handleMediaTapIntent(index);
        };

        return (
            <Pressable
                onPress={handlePress}
                style={[
                    ChatStyles.statusReplyCard,
                    isMe ? ChatStyles.statusReplyCardMe : ChatStyles.statusReplyCardThem,
                ]}
            >
                <View style={[ChatStyles.statusReplyAccent, { backgroundColor: expired ? 'rgba(255,255,255,0.2)' : activeTheme.primary }]} />
                <View style={ChatStyles.statusReplyCopy}>
                    <Text style={[ChatStyles.statusReplyLabel, isMe && ChatStyles.statusReplyLabelMe, expired && { color: 'rgba(255,255,255,0.4)' }]}>
                        Status
                    </Text>
                    <Text
                        numberOfLines={2}
                        style={[
                            ChatStyles.statusReplySnippet,
                            isMe ? ChatStyles.statusReplySnippetMe : ChatStyles.statusReplySnippetThem,
                            expired && { fontStyle: 'italic', color: 'rgba(255,255,255,0.4)' }
                        ]}
                    >
                        {statusSnippet}
                    </Text>
                </View>
                <View style={ChatStyles.statusReplyPreviewFrame}>
                    {canRenderPreview ? (
                        <Image
                            source={{ uri: previewSource }}
                            style={ChatStyles.statusReplyPreview}
                            contentFit="cover"
                            transition={120}
                            cachePolicy="memory-disk"
                            onError={() => {
                                if (usableLocalUri && !invalidLocalIndexSet.has(index)) {
                                    setInvalidLocalIndices(prev => (prev.includes(index) ? prev : [...prev, index]));
                                }
                            }}
                        />
                    ) : (
                        <View style={ChatStyles.statusReplyPreviewFallback}>
                            <MaterialIcons name="auto-stories" size={20} color="rgba(255,255,255,0.9)" />
                        </View>
                    )}
                </View>
                {renderLikeOverlay(index, 92, 16)}
            </Pressable>
        );
    };

    const renderMediaContent = () => {
        if (!mediaItems.length) return null;

        if (mediaItems.length === 1) {
            const media = mediaItems[0];
            if (media.type === 'status_reply') {
                return renderStatusReplyCard(media, 0);
            }
            if (media.type === 'theater_session') {
                const theaterMeta: any = (media as any).theater || {};
                // A stale message could have media.url corrupted into an HTTPS
                // URL (R2 public base prefixed onto the videoId by an old build
                // of proxySupabaseUrl). Reject any URL-shaped fallback — both
                // sessionId and videoId are short alphanumeric tokens, never
                // hostnames. If nothing usable is left we leave the field
                // undefined and TheaterSessionCard renders the orphan/Ended UI
                // instead of routing the user to a broken player.
                const looksLikeUrl = (s: any) =>
                    typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://') || s.includes('/'));
                const safeUrlFallback = looksLikeUrl(media.url) ? '' : (media.url || '');
                const sessionId: string = theaterMeta.sessionId || safeUrlFallback;
                const effectiveVideoId: string = theaterMeta.youtubeVideoId || safeUrlFallback;
                const enhancedTheater = effectiveVideoId
                    ? { ...theaterMeta, youtubeVideoId: effectiveVideoId }
                    : theaterMeta;
                const remoteVideoUrl = resolveMediaUrl(media.url);
                return (
                    <TheaterSessionCard
                        sessionId={sessionId}
                        title={media.name}
                        thumbnail={media.thumbnail}
                        duration={media.duration}
                        theater={enhancedTheater}
                        isMe={isMe}
                        accent={activeTheme.primary}
                        onJoin={() => onMediaTap?.({
                            theaterSession: true,
                            sessionId,
                            messageId: msg.id,
                            theater: enhancedTheater,
                            youtubeVideoId: effectiveVideoId,
                            title: media.name,
                            thumbnail: media.thumbnail,
                            remoteUrl: remoteVideoUrl,
                        })}
                        onEnd={() => {
                            if (onTheaterEnd) {
                                onTheaterEnd(msg.id, enhancedTheater);
                            }
                        }}
                    />
                );
            }
            const usableLocalUri = invalidLocalIndexSet.has(0) ? undefined : media.localFileUri;
            const fallbackRemoteUri = resolveMediaUrl(media.url);
            const previewSource = usableLocalUri || fallbackRemoteUri || media.thumbnail;
            const showDownloadOverlay = !isMe && !usableLocalUri;
            const shouldMeasureImage = !showDownloadOverlay || aspectRatio == null;
            if (media.type === 'audio') {
                return (
                    <VoiceNotePlayer 
                        uri={usableLocalUri || media.url} 
                        isMe={isMe} 
                        theme={activeTheme} 
                        initialDuration={media.duration} 
                    />
                );
            }

            const currentAspectRatio = aspectRatio || DEFAULT_MEDIA_RATIO;
            const mediaWidth = 260;
            const mediaHeight = mediaWidth / currentAspectRatio;
            const shouldHideInitialFlash = showDownloadOverlay && aspectRatio == null;
            
            // FLICKER FIX: Disable transition if we already have a preview source but are switching to local
            const hasRemoteSource = !!fallbackRemoteUri || !!media.thumbnail;
            const isSwitchingToLocal = hasRemoteSource && !!usableLocalUri;
            const transitionDuration = isSwitchingToLocal ? 0 : (showDownloadOverlay ? 0 : 120);

            return (
                <Pressable
                    onPress={() => handleMediaTapIntent(0)}
                    style={[
                        ChatStyles.mediaSurface,
                        isMe ? [ChatStyles.mediaSurfaceMe, { borderColor: hexToRgba(activeTheme.primary, 0.58) }] : ChatStyles.mediaSurfaceThem,
                        !hasText && !hasCaption && ChatStyles.mediaSingleNoGap,
                        { 
                            width: mediaWidth,
                            height: mediaHeight,
                            backgroundColor: shouldHideInitialFlash ? 'transparent' : 'rgba(255,255,255,0.05)',
                        }
                    ]}
                >
                    {!shouldHideInitialFlash && (
                        <>
                            <Image
                                source={previewSource ? { uri: previewSource } : undefined}
                                placeholder={media.thumbnail && !media.thumbnail.startsWith('http') && !media.thumbnail.startsWith('file:')
                                    ? { blurhash: media.thumbnail }
                                    : undefined
                                }
                                style={{
                                    width: mediaWidth,
                                    height: mediaHeight,
                                }}
                                contentFit="cover"
                                transition={transitionDuration}
                                cachePolicy="memory-disk"
                                blurRadius={showDownloadOverlay ? 20 : 0}
                                onLoad={(e) => {
                                    if (!shouldMeasureImage) return;
                                    const { width, height } = e.source;
                                    if (width && height) {
                                        const ratio = Math.max(0.6, Math.min(width / height, 1.8));
                                        if (primaryMediaAspectCacheKey) {
                                            mediaAspectRatioCache.set(primaryMediaAspectCacheKey, ratio);
                                        }
                                        setAspectRatio(prev => (isSameRatio(prev, ratio) ? prev : ratio));
                                    }
                                }}
                                onError={() => {
                                    if (usableLocalUri && !invalidLocalIndexSet.has(0)) {
                                        setInvalidLocalIndices(prev => (prev.includes(0) ? prev : [...prev, 0]));
                                    }
                                }}
                            />
                            {showDownloadOverlay && (
                                <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: mediaWidth, height: mediaHeight }}>
                                    <SpoilerView
                                        revealed={false}
                                        enabled={false}
                                        config={{
                                            particleColor: 'rgba(255, 255, 255, 0.55)',
                                            overlayColor: 'transparent',
                                            particleDensity: 0.04,
                                            particleSizeRange: [0.4, 1.2],
                                            revealDuration: 400,
                                            burstSpeed: 200,
                                        }}
                                        style={{ width: mediaWidth, height: mediaHeight }}
                                    >
                                        <View style={{ width: mediaWidth, height: mediaHeight }} />
                                    </SpoilerView>
                                </View>
                            )}
                        </>
                    )}
                    {media.type === 'video' && uploadProgress === undefined && !showDownloadOverlay && (
                        <View style={ChatStyles.mediaTilePlayOverlay}>
                            <MaterialIcons name="play-circle-filled" size={46} color="rgba(255,255,255,0.92)" />
                        </View>
                    )}
                    {uploadProgress !== undefined && uploadProgress < 1 && msg.status === 'pending' && (
                        <View style={[ChatStyles.mediaTilePlayOverlay, { backgroundColor: 'rgba(0,0,0,0.35)' }]}>
                            <UploadProgressRing progress={uploadProgress} size={52} />
                        </View>
                    )}
                    {showDownloadOverlay && !shouldHideInitialFlash && (
                        <View style={[ChatStyles.mediaTilePlayOverlay, { backgroundColor: 'transparent' }]}>
                            <View style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 24, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
                                <MaterialIcons
                                    name={downloadingIndices.includes(0) ? 'downloading' : (media.url ? 'file-download' : 'cloud-off')}
                                    size={26}
                                    color="#fff"
                                />
                            </View>
                        </View>
                    )}
                    {isLikeableMediaType(media.type) && renderLikeOverlay(0, Math.min(mediaWidth * 0.58, 164), 14)}
                </Pressable>
            );
        }

        const visibleItems = mediaItems.slice(0, 4);
        const extraCount = mediaItems.length - 4;

        // Split items into rows of 2 (WhatsApp-style grid)
        const rows: typeof visibleItems[] = [];
        for (let i = 0; i < visibleItems.length; i += 2) {
            rows.push(visibleItems.slice(i, i + 2));
        }

        const renderTile = (media: typeof visibleItems[0], index: number) => {
            const usableLocalUri = invalidLocalIndexSet.has(index) ? undefined : media.localFileUri;
            const fallbackRemoteUri = resolveMediaUrl(media.url);
            const previewSource = usableLocalUri || fallbackRemoteUri || media.thumbnail;
            const showDownloadOverlay = !isMe && !usableLocalUri;
            const showMore = index === 3 && extraCount > 0;
                    const hasRemoteSource = !!fallbackRemoteUri || !!media.thumbnail;
                    const isSwitchingToLocal = hasRemoteSource && !!usableLocalUri;
                    const transitionDuration = isSwitchingToLocal ? 0 : (showDownloadOverlay ? 0 : 120);

                    return (
                        <Pressable
                            key={`grid-${index}`}
                            style={ChatStyles.mediaGridTile}
                            onPress={() => handleMediaTapIntent(index, showMore)}
                        >
                            <Image
                                source={previewSource ? { uri: previewSource } : undefined}
                                placeholder={media.thumbnail
                                    ? (media.thumbnail.startsWith('data:') ? { uri: media.thumbnail } : (!media.thumbnail.startsWith('http') && !media.thumbnail.startsWith('file:') ? { blurhash: media.thumbnail } : undefined))
                                    : undefined
                                }
                                style={ChatStyles.mediaGridImage}
                                contentFit="cover"
                                transition={transitionDuration}
                                cachePolicy="memory-disk"
                                blurRadius={showDownloadOverlay ? 20 : 0}
                        onError={() => {
                            if (usableLocalUri && !invalidLocalIndexSet.has(index)) {
                                setInvalidLocalIndices(prev => (prev.includes(index) ? prev : [...prev, index]));
                            }
                        }}
                    />
                    {showDownloadOverlay && (
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                            <SpoilerView
                                revealed={false}
                                enabled={false}
                                config={{
                                    particleColor: 'rgba(255, 255, 255, 0.55)',
                                    overlayColor: 'transparent',
                                    particleDensity: 0.04,
                                    particleSizeRange: [0.4, 1.2],
                                    revealDuration: 400,
                                    burstSpeed: 200,
                                }}
                                style={{ flex: 1 }}
                            >
                                <View style={{ flex: 1 }} />
                            </SpoilerView>
                        </View>
                    )}
                    {media.type === 'video' && !showMore && uploadProgress === undefined && !showDownloadOverlay && (
                        <View style={ChatStyles.mediaTilePlayOverlay}>
                            <MaterialIcons name="play-circle-filled" size={34} color="rgba(255,255,255,0.92)" />
                        </View>
                    )}
                    {uploadProgress !== undefined && uploadProgress < 1 && msg.status === 'pending' && (
                        <View style={[ChatStyles.mediaTilePlayOverlay, { backgroundColor: 'rgba(0,0,0,0.35)' }]}>
                            <UploadProgressRing progress={uploadProgress} size={40} />
                        </View>
                    )}
                    {showDownloadOverlay && (
                        <View style={[ChatStyles.mediaTilePlayOverlay, { backgroundColor: 'transparent' }]}>
                            <View style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 20, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                                <MaterialIcons
                                    name={downloadingIndices.includes(index) ? 'downloading' : 'file-download'}
                                    size={22}
                                    color="#fff"
                                />
                            </View>
                        </View>
                    )}
                    {showMore && (
                        <View style={ChatStyles.mediaMoreOverlay}>
                            <Text style={ChatStyles.mediaMoreText}>{`+${extraCount}`}</Text>
                        </View>
                    )}
                    {isLikeableMediaType(media.type) && renderLikeOverlay(index, 88, 10)}
                </Pressable>
            );
        };

        return (
            <View style={[
                ChatStyles.mediaSurface,
                ChatStyles.mediaGridSurface,
                isMe ? [ChatStyles.mediaSurfaceMe, { borderColor: hexToRgba(activeTheme.primary, 0.58) }] : ChatStyles.mediaSurfaceThem,
                !hasText && !hasCaption && ChatStyles.mediaGridNoGap
            ]}>
                {rows.map((row, rowIndex) => (
                    <View
                        key={`row-${rowIndex}`}
                        style={[
                            ChatStyles.mediaGridRow,
                            rowIndex === rows.length - 1 && ChatStyles.mediaGridRowLast
                        ]}
                    >
                        {row.map((media, colIndex) => renderTile(media, rowIndex * 2 + colIndex))}
                    </View>
                ))}
            </View>
        );
    };

    if (isClone) {
        return (
            <Animated.View style={[bubbleStyle, { alignItems: isMe ? 'flex-end' : 'flex-start' }]}>
                <View style={[
                    ChatStyles.bubbleContainer,
                    isMe ? [ChatStyles.bubbleContainerMe, { backgroundColor: hexToRgba(activeTheme.primary, 0.75) }] : ChatStyles.bubbleContainerThem,
                    quotedMessage && ChatStyles.bubbleContainerWithQuote,
                    isMediaOnly && ChatStyles.bubbleContainerMediaOnly,
                    { width: '100%', height: '100%', maxWidth: '100%' }
                ]}>
                    <View style={[ChatStyles.messageContent, isMediaOnly && ChatStyles.messageContentMediaOnly]}>
                        {quotedMessage && (
                            <View style={[ChatStyles.quotedContainer, isMe ? ChatStyles.quotedMe : ChatStyles.quotedThem]}>
                                <View style={ChatStyles.quoteContent}>
                                    <Text numberOfLines={1} style={[ChatStyles.quoteSender, { color: isMe ? '#fff' : activeTheme.primary }]}>
                                        {quotedMessage.sender === 'me' ? 'You' : contactName}
                                    </Text>
                                    <Text numberOfLines={1} style={[ChatStyles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                        {quotedMessage.text}
                                    </Text>
                                </View>
                            </View>
                        )}
                        {renderMediaContent()}
                        {showStandaloneCaption && (
                            <Text style={[ChatStyles.captionText, isMe ? { color: 'rgba(255,255,255,0.8)' } : { color: 'rgba(255,255,255,0.6)' }]}>
                                {msg.media.caption}
                            </Text>
                        )}
                        {hasText && (
                            <LinkedText text={msg.text} style={[ChatStyles.messageText, isMe && ChatStyles.messageTextMe]} />
                        )}
                    </View>
                </View>
                {msg.reactions && msg.reactions.length > 0 && (
                    <View style={[ChatStyles.reactionsRow, isMe ? ChatStyles.reactionsRight : ChatStyles.reactionsLeft]}>
                        {msg.reactions.map((r, idx) => (
                            <GlassView key={idx} intensity={40} tint="dark" style={ChatStyles.reactionPill} >
                                <Text style={ChatStyles.reactionEmoji}>{r}</Text>
                            </GlassView>
                        ))}
                    </View>
                )}
            </Animated.View>
        );
    }

    return (
        <View style={[
            ChatStyles.messageWrapper,
            isMe && ChatStyles.messageWrapperMe,
            msg.reactions && msg.reactions.length > 0 && ChatStyles.messageWrapperWithReactions
        ]}>
            {selectionMode && !isClone && (
                <View style={ChatStyles.selectionCheckboxContainer}>
                    <View style={[ChatStyles.selectionCheckbox, isChecked && { backgroundColor: activeTheme.primary, borderColor: activeTheme.primary }]}>
                        {isChecked && <MaterialIcons name="check" size={14} color="#fff" />}
                    </View>
                </View>
            )}

            <View style={[
                ChatStyles.replyIconContainer,
                isMe ? ChatStyles.replyIconContainerMe : ChatStyles.replyIconContainerThem
            ]}>
                <Animated.View style={[ChatStyles.replyIcon, iconStyle]}>
                    <MaterialIcons 
                        name="reply" 
                        size={24} 
                        color={activeTheme.primary} 
                        style={!isMe ? { transform: [{ scaleX: -1 }] } : {}} 
                    />
                </Animated.View>
            </View>

            <GestureDetector gesture={composedGestures}>
                <Animated.View style={[
                    bubbleStyle,
                    { alignItems: isMe ? 'flex-end' : 'flex-start' },
                    selectionMode && !isClone && !isMe && { paddingLeft: 34 },
                    revealStyle,
                ]}>
                    {msg.senderName && !isMe && !isClone && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            <Text style={[ChatStyles.senderName, { color: getSenderColor(msg.senderId || '') }]}>
                                {msg.senderName}
                            </Text>
                            {senderRole === 'admin' && (
                                <View style={{ backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                                    <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 }}>ADMIN</Text>
                                </View>
                            )}
                        </View>
                    )}
                    <View style={ChatStyles.bubbleReactionAnchor}>
                        <View ref={bubbleRef} style={[
                            ChatStyles.bubbleContainer,
                            isMe ? [ChatStyles.bubbleContainerMe, { backgroundColor: hexToRgba(activeTheme.primary, 0.75) }] : ChatStyles.bubbleContainerThem,
                            quotedMessage && ChatStyles.bubbleContainerWithQuote,
                            isMediaOnly && ChatStyles.bubbleContainerMediaOnly,
                        ]}>
                            <View style={[ChatStyles.messageContent, isMediaOnly && ChatStyles.messageContentMediaOnly]}>
                                {quotedMessage && (
                                    <Pressable
                                        style={[ChatStyles.quotedContainer, isMe ? ChatStyles.quotedMe : ChatStyles.quotedThem]}
                                        onPress={() => {
                                            if (onQuotePress && quotedMessage) {
                                                onQuotePress(quotedMessage.id);
                                            }
                                        }}
                                        onLongPress={() => {
                                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                            Alert.alert(
                                                quotedMessage.sender === 'me' ? 'You' : contactName,
                                                quotedMessage.text || '📎 Media',
                                            );
                                        }}
                                    >
                                        <View style={ChatStyles.quoteContent}>
                                            <Text numberOfLines={1} style={[ChatStyles.quoteSender, { color: isMe ? '#fff' : activeTheme.primary }]}>
                                                {quotedMessage.sender === 'me' ? 'You' : contactName}
                                            </Text>
                                            <Text numberOfLines={1} style={[ChatStyles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                                {(() => {
                                                    const quoteMedia = getMessageMediaItems(quotedMessage);
                                                    const hasQuoteMedia = quoteMedia.length > 0;
                                                    const firstQuoteMedia = hasQuoteMedia ? quoteMedia[0] : null;
                                                    if (quotedMessage.text) return quotedMessage.text;
                                                    if (firstQuoteMedia?.type === 'video') return '🎥 Video';
                                                    if (firstQuoteMedia?.type === 'audio') return '🎵 Audio Voice Note';
                                                    if (firstQuoteMedia?.type === 'image') return '📷 Photo';
                                                    return '📎 Media';
                                                })()}
                                            </Text>
                                        </View>
                                        {(() => {
                                            const quoteMedia = getMessageMediaItems(quotedMessage);
                                            const hasQuoteMedia = quoteMedia.length > 0;
                                            const firstQuoteMedia = hasQuoteMedia ? quoteMedia[0] : null;
                                            if (hasQuoteMedia && firstQuoteMedia?.type !== 'audio' && firstQuoteMedia?.url) {
                                                const resolvedUrl = resolveMediaUrl(firstQuoteMedia.url);
                                                return <Image source={(firstQuoteMedia.localFileUri || resolvedUrl) ? { uri: firstQuoteMedia.localFileUri || resolvedUrl } : undefined} style={ChatStyles.quoteThumbnail} contentFit="cover" />;
                                            }
                                            return null;
                                        })()}
                                    </Pressable>
                                )}

                                {renderMediaContent()}
                                {showStandaloneCaption && (
                                    <Text style={[ChatStyles.captionText, isMe ? { color: 'rgba(255,255,255,0.8)' } : { color: 'rgba(255,255,255,0.6)' }]}>
                                        {msg.media.caption}
                                    </Text>
                                )}
                                {hasText && (
                                    <LinkedText text={msg.text} style={[ChatStyles.messageText, isMe && ChatStyles.messageTextMe]} />
                                )}
                            </View>
                        </View>
                        {msg.reactions && msg.reactions.length > 0 && (
                            <View style={[ChatStyles.reactionsRow, isMe ? ChatStyles.reactionsRight : ChatStyles.reactionsLeft]}>
                                {msg.reactions.map((r, idx) => (
                                    <GlassView key={idx} intensity={40} tint="dark" style={ChatStyles.reactionPill} >
                                        <Text style={ChatStyles.reactionEmoji}>{r}</Text>
                                    </GlassView>
                                ))}
                            </View>
                        )}
                    </View>

                    <View style={[
                        ChatStyles.messageFooter,
                        isMe ? ChatStyles.messageFooterMe : ChatStyles.messageFooterThem,
                        msg.reactions && msg.reactions.length > 0 && ChatStyles.messageFooterWithReaction
                    ]}>
                        {!!msg.isStarred && (
                            <MaterialIcons name="star" size={10} color="#facc15" style={{ marginRight: 4 }} />
                        )}
                        {!!msg.editedAt && (
                            <Text style={[ChatStyles.timestamp, { marginRight: 4, fontSize: 10 }]}>edited</Text>
                        )}
                        <Text style={ChatStyles.timestamp}>{formatTime(msg.timestamp)}</Text>
                        {isMe && msg.status !== 'failed' && (
                            <MaterialIcons
                                name={
                                    msg.status === 'pending' ? 'schedule' :
                                    msg.status === 'delivered' || msg.status === 'read' ? 'done-all' :
                                    'done'
                                }
                                size={10}
                                color={msg.status === 'read' ? '#34B7F1' : 'rgba(255,255,255,0.3)'}
                            />
                        )}
                    </View>
                </Animated.View>
            </GestureDetector>

            {/* WhatsApp-style retry banner for failed messages */}
            {isMe && msg.status === 'failed' && (
                <Pressable
                    onPress={() => onRetry?.(msg.id)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        alignSelf: 'flex-end',
                        marginTop: 2,
                        paddingVertical: 4,
                        paddingHorizontal: 8,
                    }}
                    hitSlop={8}
                >
                    <MaterialIcons name="error-outline" size={13} color="#ef4444" style={{ marginRight: 4 }} />
                    <Text style={{ color: '#ef4444', fontSize: 11, fontWeight: '500' }}>
                        Not sent. Tap to retry
                    </Text>
                </Pressable>
            )}
        </View>
    );
}, (prevProps, nextProps) => {
  if (prevProps.msg?.id !== nextProps.msg?.id) return false;
  if (prevProps.msg?.text !== nextProps.msg?.text) return false;
  if (prevProps.msg?.status !== nextProps.msg?.status) return false;
  
  // CRITICAL: Ensure re-render when media is downloaded or resolved
  if (prevProps.msg?.localFileUri !== nextProps.msg?.localFileUri) return false;
  if (prevProps.msg?.media?.url !== nextProps.msg?.media?.url) return false;
  if (prevProps.msg?.media?.thumbnail !== nextProps.msg?.media?.thumbnail) return false;

  const prevReactions = (prevProps.msg?.reactions || []).join('|');
  const nextReactions = (nextProps.msg?.reactions || []).join('|');
  if (prevReactions !== nextReactions) return false;
  if (prevProps.isSelected !== nextProps.isSelected) return false;
  if (prevProps.isClone !== nextProps.isClone) return false;
  if (prevProps.quotedMessage?.id !== nextProps.quotedMessage?.id) return false;
  if (prevProps.selectionMode !== nextProps.selectionMode) return false;
  if (prevProps.isChecked !== nextProps.isChecked) return false;
  if (prevProps.isHidden !== nextProps.isHidden) return false;
  return true;
});

export default MessageBubble;
MessageBubble.displayName = 'MessageBubble';
