import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import LottieView from 'lottie-react-native';
import {
    View, Text, StyleSheet, StatusBar,
    useWindowDimensions, Pressable, Alert, TextInput, Modal, ScrollView,
    BackHandler,
} from 'react-native';
// expo-image gives us a persistent on-disk cache keyed by URI, shared across
// screens. Same R2 URL fetched in my-status's StatusThumbnail is served from
// cache here without a re-download — fixes the "loads from R2 every time"
// black-flash even when the photo was already on screen seconds ago.
import { Image } from 'expo-image';
import { SoulLoader } from '../components/ui/SoulLoader';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withDelay,
    runOnJS,
    cancelAnimation,
    Easing,
    withSpring,
    interpolate,
    Extrapolation,
} from 'react-native-reanimated';
import { getStatusMorphOrigin, clearStatusMorphOrigin } from '../utils/statusMorphOrigins';
import { Video, ResizeMode } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { statusService } from '../services/StatusService';
import { storageService } from '../services/StorageService';
import { useApp } from '../context/AppContext';
import { proxySupabaseUrl } from '../config/api';
import { UserStatusGroup } from '../types';
import { supabase } from '../config/supabase';

const StatusProgressBar = ({ idx, currentIndex, progress }: any) => {
    const style = useAnimatedStyle(() => {
        'worklet';
        return {
            width: idx < currentIndex
                ? '100%'
                : idx === currentIndex
                    ? `${progress.value * 100}%`
                    : '0%'
        };
    });
    return <View style={styles.progressBar}><Animated.View style={[styles.progressFill, style]} /></View>;
};

export default function ViewStatusScreen() {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const {
        id,
        sharedTag,
        statusId: initialStatusIdParam,
        mediaKey: initialMediaKeyParam,
        uriHint: initialUriHintParam,
        mediaType: initialMediaTypeParam,
    } = useLocalSearchParams<{
        id: string;
        sharedTag?: string;
        statusId?: string;
        mediaKey?: string;
        uriHint?: string;
        mediaType?: string;
    }>();
    const router = useRouter();
    const navigation = useNavigation();
    const { currentUser, sendChatMessage, activeTheme } = useApp();
    const themeAccent = activeTheme.primary;
    const currentUserId = currentUser?.id;
    
    const [statusGroup, setStatusGroup] = useState<UserStatusGroup | null>(null);
    const [currentIndex, setCurrentIndex] = useState(0);
    const initialSharedTag = typeof sharedTag === 'string' && sharedTag.length > 0
        ? sharedTag
        : `status-hero-${id}`;
    const initialStatusId = typeof initialStatusIdParam === 'string' ? initialStatusIdParam : '';
    const initialMediaKey = typeof initialMediaKeyParam === 'string' ? initialMediaKeyParam : '';
    const initialUriHint = typeof initialUriHintParam === 'string' ? initialUriHintParam : '';
    const initialMediaType = typeof initialMediaTypeParam === 'string' ? initialMediaTypeParam : '';
    const buildImmediateMediaSource = useCallback((uriHint?: string, mediaKey?: string) => {
        const candidate = storageService.normalizePseudoLocalUri(uriHint || mediaKey || '');
        if (!candidate) return null;
        if (candidate.startsWith('file://') || candidate.startsWith('content://') || candidate.startsWith('ph://')) {
            return { uri: candidate, isLocal: true };
        }
        if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
            return { uri: candidate, isLocal: false };
        }
        return null;
    }, []);
    const initialImmediateSource = buildImmediateMediaSource(initialUriHint, initialMediaKey);
    const [mediaSource, setMediaSource] = useState<{uri: string, isLocal: boolean} | null>(initialImmediateSource);
    // Start in loading state whenever we mount with a source — even images
    // need a beat to download/decode, and showing the SoulLoader beats black.
    const [loading, setLoading] = useState(!!initialImmediateSource);
    const [isPaused, setIsPaused] = useState(false);
    const [replyText, setReplyText] = useState('');
    const [isReplyComposerActive, setIsReplyComposerActive] = useState(false);
    const [isReplyActionLoading, setIsReplyActionLoading] = useState(false);
    const [showViewers, setShowViewers] = useState(false);
    const [viewers, setViewers] = useState<any[]>([]);
    const replyInputRef = useRef<TextInput>(null);

    const progress = useSharedValue(0);
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const isLongPressing = useSharedValue(0);

    // ───── Circle → fullscreen morph (source thumbnail / pill → this screen) ─────
    // my-status / home rail measures the source rect and stashes it via
    // setStatusMorphOrigin(initialSharedTag, rect). We read it here and animate
    // a wrapping container from that rect (circle) up to fullscreen on mount,
    // then reverse on dismiss. Mirrors the theater morph pattern — required
    // because this route is presented as transparentModal w/ animation:'none',
    // so Reanimated shared-element transitions can't fire on their own.
    const circleOrigin = useMemo(
        () => getStatusMorphOrigin(initialSharedTag),
        [initialSharedTag]
    );
    const hasCircleMorph =
        !!circleOrigin
        && Number.isFinite(circleOrigin.x)
        && Number.isFinite(circleOrigin.y)
        && circleOrigin.width > 0
        && circleOrigin.height > 0;

    const morphProgress = useSharedValue(hasCircleMorph ? 0 : 1);
    const morphBgOpacity = useSharedValue(hasCircleMorph ? 0 : 1);
    const isClosingMorphRef = useRef(false);
    const allowNativePopRef = useRef(false);
    const didFinishRef = useRef(false);

    useEffect(() => {
        if (!hasCircleMorph) {
            morphProgress.value = 1;
            morphBgOpacity.value = 1;
            return;
        }
        // 80ms hold at p=0 before expanding — without this, view-status's
        // mount cost (useEffect setup, shared-value init, first paint) eats
        // the first few frames of the animation, so the user never actually
        // sees the small thumbnail-sized circle state. The brief hold makes
        // the starting circle visible, then the timing curve takes over for
        // a clean expand. Total perceived: ~580ms cinematic morph from a
        // CLEARLY small circle out to fullscreen, ease-in-out curve so it
        // builds momentum then settles gently.
        morphProgress.value = withDelay(
            80,
            withTiming(1, {
                duration: 500,
                easing: Easing.bezier(0.4, 0, 0.2, 1),
            })
        );
        morphBgOpacity.value = withDelay(
            80,
            withTiming(1, {
                duration: 360,
                easing: Easing.out(Easing.cubic),
            })
        );
    }, [hasCircleMorph, morphProgress, morphBgOpacity]);

    const morphContainerStyle = useAnimatedStyle(() => {
        'worklet';
        if (!hasCircleMorph) {
            return {
                position: 'absolute',
                left: 0,
                top: 0,
                width,
                height,
                borderRadius: 0,
            };
        }
        const p = morphProgress.value;
        const srcX = circleOrigin!.x;
        const srcY = circleOrigin!.y;
        const srcW = circleOrigin!.width;
        const srcH = circleOrigin!.height;
        // Position + size interpolate linearly with the spring. For
        // borderRadius we DON'T want straight linear interp: when width
        // grows but radius doesn't keep up, the shape reads as a sharp
        // rectangle way too early. Instead we keep the radius at ~50% of
        // the current width (i.e. perceptually circular) for most of the
        // morph, and sharpen it down toward zero only at the very end via
        // a (1 - p^4) decay. Visually the container stays a soft pebble
        // shape while it expands, then crisps into a rectangle.
        const curW = interpolate(p, [0, 1], [srcW, width], Extrapolation.CLAMP);
        const curH = interpolate(p, [0, 1], [srcH, height], Extrapolation.CLAMP);
        const shapeFactor = 1 - p * p * p * p;
        const radius = (Math.min(curW, curH) / 2) * shapeFactor;
        return {
            position: 'absolute',
            left: interpolate(p, [0, 1], [srcX, 0], Extrapolation.CLAMP),
            top: interpolate(p, [0, 1], [srcY, 0], Extrapolation.CLAMP),
            width: curW,
            height: curH,
            borderRadius: radius,
        };
    });

    const morphBgStyle = useAnimatedStyle(() => {
        'worklet';
        return { opacity: morphBgOpacity.value };
    });

    const finishDismiss = useCallback(() => {
        if (didFinishRef.current) return;
        didFinishRef.current = true;
        clearStatusMorphOrigin(initialSharedTag);
        allowNativePopRef.current = true;
        router.back();
    }, [initialSharedTag, router]);

    const runDismissAnimation = useCallback(() => {
        if (isClosingMorphRef.current) return;
        isClosingMorphRef.current = true;
        if (!hasCircleMorph) {
            finishDismiss();
            return;
        }
        // Tight, snappy collapse — keeps the dismiss feeling responsive
        // instead of dragging. Bezier eases out hard at the end so the photo
        // "snaps" back into the source circle rather than easing into it.
        const DURATION = 260;
        const dismissEasing = Easing.bezier(0.32, 0, 0.16, 1);
        morphBgOpacity.value = withTiming(0, { duration: 200, easing: dismissEasing });
        morphProgress.value = withTiming(0, { duration: DURATION, easing: dismissEasing }, (finished) => {
            'worklet';
            if (finished) runOnJS(finishDismiss)();
        });
        setTimeout(() => {
            if (isClosingMorphRef.current) finishDismiss();
        }, DURATION + 60);
    }, [hasCircleMorph, finishDismiss, morphBgOpacity, morphProgress]);

    useEffect(() => {
        const unsub = navigation.addListener('beforeRemove' as any, (event: any) => {
            if (!hasCircleMorph || isClosingMorphRef.current || allowNativePopRef.current) return;
            event.preventDefault();
            runDismissAnimation();
        });
        const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!hasCircleMorph || isClosingMorphRef.current) return false;
            runDismissAnimation();
            return true;
        });
        return () => {
            allowNativePopRef.current = false;
            unsub();
            backSub.remove();
        };
    }, [hasCircleMorph, navigation, runDismissAnimation]);

    // Initial Load
    useEffect(() => {
        const load = async () => {
            const feed = await statusService.getStatusFeed();
            const group = feed.find(g => g.user.id === id);
            if (group) {
                setStatusGroup(group);
                if (initialStatusId) {
                    const initialIndex = group.statuses.findIndex(s => s.id === initialStatusId);
                    if (initialIndex !== -1) {
                        setCurrentIndex(initialIndex);
                        return;
                    }
                }
                // Start from first unviewed if not self
                if (!group.isMine) {
                    const firstUnviewed = group.statuses.findIndex(s => !s.isViewed);
                    if (firstUnviewed !== -1) setCurrentIndex(firstUnviewed);
                }
            } else {
                Alert.alert('Error', 'Status not found');
                router.back();
            }
        };
        load();
    }, [id, router]);

    // Media Loading Logic
    useEffect(() => {
        if (!statusGroup) return;
        const currentStatus = statusGroup.statuses[currentIndex];
        if (!currentStatus) return;

        const loadMedia = async () => {
            setIsPaused(false);
            progress.value = 0;
            const immediateSource = buildImmediateMediaSource(
                currentStatus.mediaLocalPath || currentStatus.mediaUrl || '',
                (currentStatus as any).mediaKey || ''
            );
            if (immediateSource) {
                setMediaSource(immediateSource);
                // Keep loading=true until the Image/Video reports onLoadEnd.
                // Before this, setting loading=false for images meant <Image>
                // was mounted with a URI that was still downloading from R2,
                // so the user saw a black frame instead of the SoulLoader.
                setLoading(true);
            } else {
                setLoading(true);
            }
            
            // We need media_key. Since it's not in SQLite (my mistake earlier), 
            // I'll assume we have it or I'll fix the service to include it.
            // Actually, my Refactored StatusService.ts fetch's it from Supabase in onStatusViewed.
            // FOR NOW, I'll pass it if possible or fetch it.
            // Better: update CachedStatus type and migration to include media_key.
            // But to avoid migration drift right now, I'll fetch it from Supabase.
            const source = await statusService.getMediaSource(currentStatus.id, (currentStatus as any).mediaKey);
            if (!source) {
                console.warn(`[ViewStatus] Unable to resolve media for status ${currentStatus.id}`);
                setMediaSource(immediateSource);
                setLoading(false);
                return;
            }
            setMediaSource(source);
            // For images, loading is done. For videos, defer to onLoad callback.
            if (currentStatus.mediaType !== 'video') {
                setLoading(false);
            }

            // Mark as viewed
            if (currentUserId) {
                statusService.onStatusViewed(currentStatus.id, currentUserId);
            }
        };
        loadMedia();

        if (statusGroup.isMine) {
            statusService.getMyStatusViewers(currentStatus.id).then(setViewers);

            // Realtime listener for new viewers
            const channel = supabase
                .channel(`status_views_${currentStatus.id}`)
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'status_views',
                        filter: `status_id=eq.${currentStatus.id}`
                    },
                    async () => {
                        const updated = await statusService.getMyStatusViewers(currentStatus.id);
                        setViewers(updated);
                    }
                )
                .subscribe();

            return () => {
                supabase.removeChannel(channel);
            };
        }
        // We depend on currentUser?.id (a stable primitive) instead of currentUser
        // (the full object). AppContext re-creates currentUser on most renders,
        // which was retriggering this effect and re-loading the media (showing
        // the heartbeat loader) every few seconds even when the status hadn't
        // actually changed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildImmediateMediaSource, currentIndex, currentUserId, statusGroup]);

    const handleNext = useCallback(() => {
        if (statusGroup && currentIndex < statusGroup.statuses.length - 1) {
            setCurrentIndex(prev => prev + 1);
        } else {
            runDismissAnimation();
        }
    }, [currentIndex, runDismissAnimation, statusGroup]);

    const handlePrev = useCallback(() => {
        if (currentIndex > 0) {
            setCurrentIndex(prev => prev - 1);
        } else {
            progress.value = 0;
        }
    }, [currentIndex, progress]);

    // Progress Animation
    useEffect(() => {
        if (loading || !mediaSource) return;
        if (!statusGroup) return;

        if (isPaused) {
            cancelAnimation(progress);
            return;
        }
        
        const currentStatus = statusGroup.statuses[currentIndex];
        const duration = (currentStatus?.duration || 5) * 1000;
        const currentProgress = Math.min(Math.max(progress.value, 0), 0.999);
        const remainingDuration = Math.max(150, Math.round(duration * (1 - currentProgress)));

        cancelAnimation(progress);
        progress.value = withTiming(1, {
            duration: remainingDuration,
            easing: Easing.linear
        }, (finished) => {
            if (finished) runOnJS(handleNext)();
        });

        return () => cancelAnimation(progress);
    }, [handleNext, loading, mediaSource, currentIndex, isPaused, progress, statusGroup]);

    const pauseStatusPlayback = useCallback(() => {
        setIsPaused(true);
    }, []);

    const resumeStatusPlayback = useCallback(() => {
        setIsPaused(false);
    }, []);

    // Gestures
    const tapGesture = Gesture.Tap()
        .onEnd((e) => {
            if (e.x < width * 0.3) {
                runOnJS(handlePrev)();
            } else {
                runOnJS(handleNext)();
            }
        });

    const longPressGesture = Gesture.LongPress()
        .minDuration(200)
        .onStart(() => {
            isLongPressing.value = withTiming(1, { duration: 200 });
            cancelAnimation(progress);
            runOnJS(pauseStatusPlayback)();
        })
        .onFinalize(() => {
            isLongPressing.value = withTiming(0, { duration: 200 });
            runOnJS(resumeStatusPlayback)();
        });


    const panGesture = Gesture.Pan()
        .onUpdate((e) => {
            if (e.translationY > 0) {
                translateY.value = e.translationY;
                scale.value = 1 - (e.translationY / height) * 0.2;
            }
        })
        .onEnd((e) => {
            if (e.translationY > 100) {
                runOnJS(runDismissAnimation)();
            } else {
                translateY.value = withSpring(0);
                scale.value = withSpring(1);
            }
        });

    const composedGestures = Gesture.Simultaneous(longPressGesture, Gesture.Exclusive(panGesture, tapGesture));

    const animatedStyle = useAnimatedStyle(() => {
        'worklet';
        return {
            transform: [
                { translateY: translateY.value },
                { scale: scale.value }
            ] as any,
            borderRadius: translateY.value > 0 ? 30 : 0,
            overflow: 'hidden'
        };
    });

    // Chrome (progress bar, header, reply/viewers footer) lives inside the
    // morph container along with the photo. During the circle→fullscreen
    // expand we hide it so the user only sees the photo growing; once the
    // morph has settled past ~70% we fade chrome in at its final layout
    // position. Reverse on dismiss — chrome out first, then circle collapse.
    const chromeStyle = useAnimatedStyle(() => {
        'worklet';
        return {
            opacity: hasCircleMorph
                ? interpolate(morphProgress.value, [0.55, 1], [0, 1], Extrapolation.CLAMP)
                : 1,
        };
    });

    // Placeholder (cover-fit photo behind the masked main media) is what
    // makes the circle→fullscreen expand look seamless: it's a clean, opaque
    // photo with no gradient feather, so during the morph the user sees a
    // photo growing from the thumbnail circle into a pebble. But at the very
    // end we DON'T want it sitting on top of the bg blur — that hides the
    // blurry-edge immersive effect. So we fade it out in the last 15% of the
    // morph, letting the bg blur + masked photo (with its gradient feather)
    // become the final visible state. Mirror on dismiss.
    const placeholderStyle = useAnimatedStyle(() => {
        'worklet';
        if (!hasCircleMorph) return { opacity: 0 };
        return {
            opacity: interpolate(
                morphProgress.value,
                [0.85, 1],
                [1, 0],
                Extrapolation.CLAMP
            ),
        };
    });

    const mediaAnimatedStyle = useAnimatedStyle(() => {
        'worklet';
        return {
            transform: [
                { scale: withTiming(isLongPressing.value ? 1 : 1.15, { duration: 300 }) }
            ],
        };
    });

    const uiAnimatedStyle = useAnimatedStyle(() => {
        'worklet';
        return {
            opacity: withTiming(1 - isLongPressing.value, { duration: 200 }),
        };
    });

    const overlayAnimatedStyle = useAnimatedStyle(() => {
        'worklet';
        return {
            opacity: withTiming(1 - isLongPressing.value, { duration: 250 }),
        };
    });

    const maskAnimatedStyle = useAnimatedStyle(() => {
        'worklet';
        return {
            opacity: withTiming(isLongPressing.value, { duration: 250 }),
        };
    });

    const currentStatus = statusGroup?.statuses[currentIndex] ?? null;
    const trimmedReplyText = replyText.trim();
    const showSendAction = isReplyComposerActive || trimmedReplyText.length > 0;

    const buildStatusReplyMedia = useCallback(() => {
        if (!currentStatus) return null;

        const remoteStatusUrl = currentStatus.mediaKey
            ? proxySupabaseUrl(currentStatus.mediaKey)
            : (!mediaSource?.isLocal ? mediaSource?.uri : '');

        if (!remoteStatusUrl) return null;

        return {
            type: 'status_reply' as const,
            url: remoteStatusUrl,
            thumbnail: currentStatus.mediaType === 'image' ? remoteStatusUrl : undefined,
            caption: currentStatus.caption?.trim() || undefined,
        };
    }, [currentStatus, mediaSource]);

    const sendStatusReplyMessage = useCallback(async (text: string) => {
        if (!statusGroup || !currentStatus || isReplyActionLoading) return;

        const normalizedText = text.trim();
        const statusReplyMedia = buildStatusReplyMedia();
        if (!statusReplyMedia) {
            Alert.alert('Wait a second', 'Status preview abhi ready nahi hua. Ek baar phir try karo.');
            return;
        }

        setIsReplyActionLoading(true);
        let sendError: unknown = null;
        try {
            await sendChatMessage(statusGroup.user.id, normalizedText, statusReplyMedia);
        } catch (error) {
            sendError = error;
            console.warn('[ViewStatus] Failed to send status reply:', error);
            Alert.alert('Not sent', 'Status response send nahi hua. Dobara try karo.');
        }
        setIsReplyActionLoading(false);
        if (sendError) throw sendError;
    }, [buildStatusReplyMedia, currentStatus, isReplyActionLoading, sendChatMessage, statusGroup]);

    const handleSendReply = useCallback(async () => {
        if (!trimmedReplyText) return;
        try {
            await sendStatusReplyMessage(trimmedReplyText);
        } catch {
            return;
        }
        setReplyText('');
        setIsReplyComposerActive(false);
        replyInputRef.current?.blur();
    }, [sendStatusReplyMessage, trimmedReplyText]);

    const [showLikeAnim, setShowLikeAnim] = useState(false);
    const likeAnimRef = useRef<LottieView>(null);

    const handleLikeStatus = useCallback(async () => {
        setShowLikeAnim(true);
        likeAnimRef.current?.play();
        try {
            await sendStatusReplyMessage('❤️');
        } catch {}
    }, [sendStatusReplyMessage]);
    if (!statusGroup || !currentStatus) return <View style={styles.black} />;

    return (
        <GestureHandlerRootView style={styles.transparentRoot}>
            <Animated.View
                style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, morphBgStyle]}
                pointerEvents="none"
            />
            <Animated.View style={[morphContainerStyle, styles.morphClip]}>
                <Animated.View
                    style={[styles.container, animatedStyle]}
                >
                    <StatusBar hidden />

                {/* Morph placeholder — same URI + cover-fit my-status
                    thumbnail rendered. Cover (not contain) so the photo
                    fills the circle exactly like the source thumbnail —
                    no letterbox gap during the expand, giving a seamless
                    visual handoff from the small circle to the growing
                    pebble shape. Stays visible behind the masked main
                    media; the gradient feather only kicks in at the end. */}
                {initialImmediateSource && (
                    <Animated.View style={[StyleSheet.absoluteFill, placeholderStyle]} pointerEvents="none">
                        <Image
                            source={{ uri: initialImmediateSource.uri }}
                            style={StyleSheet.absoluteFill}
                            contentFit="cover"
                            cachePolicy="memory-disk"
                        />
                    </Animated.View>
                )}

                {/* Background Blur */}
                {mediaSource && (
                    <View style={StyleSheet.absoluteFill}>
                        <Image
                            source={{ uri: mediaSource.uri }}
                            style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
                            blurRadius={100}
                            cachePolicy="memory-disk"
                        />
                        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} />
                    </View>
                )}
                
                {/* Media Content with Progressive Feathering */}
                <GestureDetector gesture={composedGestures}>
                    <MaskedView
                        style={StyleSheet.absoluteFill}
                        maskElement={
                            <View style={StyleSheet.absoluteFill}>
                                <LinearGradient
                                    colors={['transparent', 'white', 'white', 'transparent']}
                                    locations={[0, 0.15, 0.85, 1]}
                                    style={StyleSheet.absoluteFill}
                                />
                                {/* This view reveals the full image on long press by making the mask solid white */}
                                <Animated.View style={[
                                    StyleSheet.absoluteFill, 
                                    { backgroundColor: 'white' },
                                    maskAnimatedStyle
                                ]} />
                            </View>
                        }

                    >
                        <Animated.View style={[styles.mediaContainer, mediaAnimatedStyle]}>
                            {mediaSource ? (
                                currentStatus.mediaType === 'video' ? (
                                    <Video
                                        source={{ uri: mediaSource.uri }}
                                        style={StyleSheet.absoluteFill}
                                        resizeMode={ResizeMode.CONTAIN}
                                        shouldPlay={!loading && !isPaused}
                                        isMuted={false}
                                        onLoad={() => setLoading(false)}
                                    />
                                ) : (
                                    <Image
                                        source={{ uri: mediaSource.uri }}
                                        style={StyleSheet.absoluteFill}
                                        contentFit="contain"
                                        cachePolicy="memory-disk"
                                        onLoad={() => setLoading(false)}
                                    />
                                )
                            ) : null}
                            
                            {loading && (
                                <View style={styles.loader}>
                                    <SoulLoader size={80} />
                                </View>
                            )}
                        </Animated.View>
                    </MaskedView>
                </GestureDetector>

                {/* Overlays (Gradients only, NO sharp blur blocks) */}
                <Animated.View style={[StyleSheet.absoluteFill, overlayAnimatedStyle, chromeStyle]} pointerEvents="none">
                    {/* Top Section Readiness Gradient */}
                    <View style={styles.topGradientContainer}>
                        <LinearGradient
                            colors={[
                                'rgba(0,0,0,0.85)', 
                                'rgba(0,0,0,0.6)', 
                                'rgba(0,0,0,0.3)', 
                                'rgba(0,0,0,0.1)', 
                                'transparent'
                            ]}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>

                    {/* Bottom Section Readiness Gradient */}
                    <View style={styles.bottomGradientContainer}>
                        <LinearGradient
                            colors={[
                                'transparent', 
                                'rgba(0,0,0,0.1)', 
                                'rgba(0,0,0,0.3)', 
                                'rgba(0,0,0,0.6)', 
                                'rgba(0,0,0,0.85)'
                            ]}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>
                </Animated.View>




                {/* UI Content (Progress, Header, Reply) */}
                <Animated.View style={[StyleSheet.absoluteFill, uiAnimatedStyle, chromeStyle]} pointerEvents="box-none">
                    <View style={[styles.overlay, { paddingTop: insets.top + 20 }]}>
                        {/* Progress Bars */}
                            <View style={[styles.progressRow, { marginBottom: 12 }]}>
                            {statusGroup.statuses.map((statusItem, i) => (
                                <StatusProgressBar 
                                    key={statusItem.id} 
                                    idx={i} 
                                    currentIndex={currentIndex} 
                                    progress={progress} 
                                />
                            ))}
                        </View>

                        {/* Header — back circle, user pill, time pill.
                            Matches the app-wide glass-pill chrome used in
                            my-status / chat headers: 40-tall rounded glass
                            surfaces with a hairline white border. */}
                        <View style={styles.header}>
                            {/* Back button — glass circle */}
                            <Pressable onPress={() => runDismissAnimation()} hitSlop={10}>
                                <GlassView intensity={40} tint="dark" style={styles.headerBackBtn}>
                                    <Ionicons name="chevron-back" size={22} color="#fff" />
                                </GlassView>
                            </Pressable>

                            {/* Avatar + name pill (center) */}
                            <GlassView intensity={40} tint="dark" style={styles.headerUserPill}>
                                <SoulAvatar
                                    uri={proxySupabaseUrl(
                                        statusGroup.isMine
                                            ? (currentUser?.avatar || statusGroup.user.avatarUrl)
                                            : statusGroup.user.avatarUrl
                                    )}
                                    localUri={
                                        statusGroup.isMine
                                            ? ((currentUser as any)?.localAvatarUri || statusGroup.user.localAvatarUri)
                                            : statusGroup.user.localAvatarUri
                                    }
                                    avatarType={
                                        statusGroup.isMine
                                            ? (currentUser?.avatarType as any) || (statusGroup.user as any).avatarType
                                            : (statusGroup.user as any).avatarType
                                    }
                                    teddyVariant={
                                        statusGroup.isMine
                                            ? (currentUser?.teddyVariant as any) || (statusGroup.user as any).teddyVariant
                                            : (statusGroup.user as any).teddyVariant
                                    }
                                    size={22}
                                />
                                <Text style={styles.headerUserName} numberOfLines={1}>
                                    {statusGroup.isMine
                                        ? (currentUser?.name || currentUser?.username || statusGroup.user.displayName || statusGroup.user.username)
                                        : (statusGroup.user.displayName || statusGroup.user.username)}
                                </Text>
                            </GlassView>

                            {/* Time pill (right) */}
                            <GlassView intensity={40} tint="dark" style={styles.headerTimePill}>
                                <Text style={styles.headerTimeText}>
                                    {new Date(currentStatus.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </Text>
                            </GlassView>
                        </View>
                    </View>

                    {/* Footer (Caption & Reply) */}
                    <View style={[styles.bottomOverlay, { paddingBottom: insets.bottom + 10 }]}>
                        {currentStatus.caption && (
                            <View style={styles.captionBox}>
                                <Text style={styles.captionText}>{currentStatus.caption}</Text>
                            </View>
                        )}

                        {!statusGroup.isMine ? (
                            <View style={styles.replyRow}>
                                <View style={[
                                    styles.replyInputBox,
                                    isReplyComposerActive && styles.replyInputBoxActive
                                ]}>
                                    <TextInput 
                                        ref={replyInputRef}
                                        style={styles.replyInput}
                                        placeholder="Reply..."
                                        placeholderTextColor="rgba(255,255,255,0.6)"
                                        value={replyText}
                                        onChangeText={setReplyText}
                                        onFocus={() => {
                                            setIsReplyComposerActive(true);
                                            pauseStatusPlayback();
                                        }}
                                        onBlur={() => {
                                            resumeStatusPlayback();
                                            if (!replyText.trim()) {
                                                setIsReplyComposerActive(false);
                                            }
                                        }}
                                        returnKeyType="send"
                                        onSubmitEditing={handleSendReply}
                                    />
                                </View>
                                <Pressable
                                    style={[
                                        styles.iconBtn,
                                        showSendAction ? [styles.iconBtnSend, { backgroundColor: themeAccent }] : styles.iconBtnLike,
                                        isReplyActionLoading && styles.iconBtnDisabled,
                                        showSendAction && !trimmedReplyText && styles.iconBtnDisabled,
                                    ]}
                                    onPress={showSendAction ? handleSendReply : handleLikeStatus}
                                    disabled={isReplyActionLoading || (showSendAction && !trimmedReplyText)}
                                >
                                    {isReplyActionLoading ? (
                                        <SoulLoader size={40} />
                                    ) : (
                                        <Ionicons
                                            name={showSendAction ? "send" : "heart"}
                                            size={24}
                                            color="#fff"
                                        />
                                    )}
                                </Pressable>
                            </View>
                        ) : (
                            <Pressable style={styles.viewersRow} onPress={() => setShowViewers(true)}>
                                <Ionicons name="eye-outline" size={20} color="#fff" style={{ marginRight: 8 }} />
                                <Text style={styles.viewersText}>{viewers.length} views</Text>
                            </Pressable>
                        )}
                    </View>
                </Animated.View>


                {/* Viewers Modal */}
                <Modal visible={showViewers} animationType="slide" transparent>
                    <GlassView intensity={90} tint="dark" style={styles.modal}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Viewed By</Text>
                            <Pressable onPress={() => setShowViewers(false)}>
                                <Ionicons name="close" size={24} color="#fff" />
                            </Pressable>
                        </View>
                        <ScrollView contentContainerStyle={styles.modalList}>
                            {viewers.map((v, i) => (
                                <View key={v.id || v.viewer_id || `viewer-${i}`} style={styles.viewerItem}>
                                    <SoulAvatar
                                        uri={proxySupabaseUrl(v.profiles?.avatar_url)}
                                        size={40}
                                    />
                                    <Text style={styles.viewerName}>{v.profiles?.display_name || v.profiles?.username}</Text>
                                </View>
                            ))}
                        </ScrollView>
                    </GlassView>
                </Modal>

                {/* Like burst animation */}
                {showLikeAnim && (
                    <View style={StyleSheet.absoluteFill} pointerEvents="none">
                        <LottieView
                            ref={likeAnimRef}
                            source={require('../assets/animations/status-like.json')}
                            autoPlay
                            loop={false}
                            style={{ flex: 1 }}
                            onAnimationFinish={() => setShowLikeAnim(false)}
                        />
                    </View>
                )}
                </Animated.View>
            </Animated.View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    black: { flex: 1, backgroundColor: '#000' },
    transparentRoot: { flex: 1, backgroundColor: 'transparent' },
    morphClip: { overflow: 'hidden' },
    container: { flex: 1, backgroundColor: '#000' },
    mediaContainer: { flex: 1, backgroundColor: 'transparent' },
    loader: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
    overlay: { ...StyleSheet.absoluteFillObject, height: 150, paddingHorizontal: 10 },
    progressRow: { flexDirection: 'row', gap: 6, width: '100%', marginBottom: 15 },
    progressBar: { flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: '#fff' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        paddingHorizontal: 4,
    },
    backBtn: { padding: 5 },
    userRow: { flexDirection: 'row', alignItems: 'center', marginLeft: 10 },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#333', marginRight: 12 },
    userName: { color: '#fff', fontSize: 16, fontWeight: '700' },
    timeLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
    // Glass-pill header chrome — matches my-status / chat header pattern.
    // overflow:hidden so GlassView's blur clips to the borderRadius.
    headerBackBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerUserPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 32,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        paddingLeft: 4,
        paddingRight: 10,
        maxWidth: '60%',
    },
    headerUserName: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '700',
    },
    headerTimePill: {
        height: 40,
        paddingHorizontal: 14,
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTimeText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    bottomOverlay: { position: 'absolute', bottom: 0, width: '100%', paddingHorizontal: 20 },
    captionBox: { backgroundColor: 'rgba(0,0,0,0.5)', padding: 12, borderRadius: 12, marginBottom: 20 },
    captionText: { color: '#fff', fontSize: 16, textAlign: 'center' },
    replyRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    replyInputBox: { flex: 1, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 25, height: 50, justifyContent: 'center', paddingHorizontal: 20, borderWidth: 1, borderColor: 'transparent' },
    replyInputBoxActive: { backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.22)' },
    replyInput: { color: '#fff', fontSize: 15 },
    iconBtn: { width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center' },
    iconBtnSend: { backgroundColor: '#8C0016' },
    iconBtnLike: { backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
    iconBtnDisabled: { opacity: 0.45 },
    viewersRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
    viewersText: { color: '#fff', fontWeight: '600' },
    modal: { flex: 1, marginTop: 100, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 25 },
    modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
    modalList: { padding: 25 },
    viewerItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
    viewerAvatar: { width: 44, height: 44, borderRadius: 22, marginRight: 15 },
    viewerName: { color: '#fff', fontSize: 16, fontWeight: '600' },
    topGradientContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 320, // Equalized
        overflow: 'hidden',
    },
    bottomGradientContainer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 320, // Equalized
        overflow: 'hidden',
    }



});
