import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
// Force re-bundle: 2026-03-10T21:48:59+05:30
import {
    View, Text, TextInput, Pressable, AppState,
    StyleSheet, StatusBar, Platform,
    Modal, Animated as RNAnimated, Dimensions, Keyboard, KeyboardEvent, Alert, InteractionManager, ScrollView, FlatList,
    Image as RNImage, KeyboardAvoidingView, PanResponder
} from 'react-native';
import { SoulLoader } from '../../components/ui/SoulLoader';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';

import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaskedView from '@react-native-masked-view/masked-view';
import GlassView from '../../components/ui/GlassView';
import { PressableFlash } from '../../components/ui/IOS26Primitives';
import ConnectionBanner from '../../components/ConnectionBanner';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import LottieView from 'lottie-react-native';
import * as MediaLibrary from 'expo-media-library';
import { cacheDirectory, downloadAsync } from 'expo-file-system';
import { soulFolderService } from '../../services/SoulFolderService';
import VoiceNotePlayer from '../../components/chat/VoiceNotePlayer';
import ProgressiveBlur from '../../components/chat/ProgressiveBlur';
import MessageBubble from '../../components/chat/MessageBubble';
import MessageContextMenu from '../../components/chat/MessageContextMenu';
import TypingBubble from '../../components/chat/TypingBubble';
import { ChatStyles, SCREEN_WIDTH, SCREEN_HEIGHT } from '../../components/chat/ChatStyles';
import { applyGroupedMediaLocalUri, getMessageMediaItems, sanitizeSongTitle, isMessageEmpty } from '../../utils/chatUtils';
import { proxySupabaseUrl } from '../../config/api';

import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withDelay,
    withRepeat,
    withSequence,
    withSpring,
    interpolate,
    interpolateColor,
    Extrapolation,
    Easing,
    FadeInDown,
    FadeOutDown,
    FadeInUp,
    FadeOutUp,
    LinearTransition,
    runOnJS,
    useAnimatedProps,
    useDerivedValue,
    Extrapolate,
} from 'react-native-reanimated';

import 'react-native-gesture-handler';

import { useApp, USERS } from '../../context/AppContext';
import { usePresence } from '../../context/PresenceContext';
import { supabase, LEGACY_TO_UUID } from '../../config/supabase';
import { normalizeId } from '../../utils/idNormalization';
import { SoulAvatar } from '../../components/SoulAvatar';
import { resolveAvatarImageUri, warmAvatarSource } from '../../utils/avatarSource';
import { chatService } from '../../services/ChatService';
import { chatTransitionState } from '../../services/chatTransitionState';
import { profileAvatarTransitionState } from '../../services/profileAvatarTransitionState';
import { MusicPlayerOverlay } from '../../components/MusicPlayerOverlay';
import ChatComposer, { ChatComposerHandle } from '../../components/chat/ChatComposer';
import { downloadQueue } from '../../services/DownloadQueueService';
import { EnhancedMediaViewer } from '../../components/EnhancedMediaViewer';
import {
    getProfileAvatarTransitionTag,
    SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION,
    SUPPORT_SHARED_TRANSITIONS,
    PROFILE_AVATAR_SHARED_TRANSITION,
} from '../../constants/sharedTransitions';
import { Contact, Message } from '../../types';
import GlassAlert, { AlertButton } from '../../components/ui/GlassAlert';
import MusicInviteBanner from '../../components/chat/MusicInviteBanner';

const IS_IOS = Platform.OS === 'ios';
const ENABLE_SHARED_TRANSITIONS = SUPPORT_SHARED_TRANSITIONS;
const ENABLE_INNER_SHARED_TRANSITIONS = SUPPORT_SHARED_TRANSITIONS;
const ENABLE_PROFILE_AVATAR_SHARED_TRANSITION = SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION;
const IOS_KEYBOARD_SAFE_ADJUST = 0;
const HEADER_PILL_RADIUS = 28;
const HEADER_PILL_TOP = 52;
const HEADER_PILL_HEIGHT = 60;
// Match home contact row's actual rendered geometry so the morphing pill
// lands flush with no shape/size snap at handoff: chatItem in (tabs)/index
// uses height 56, marginHorizontal 8, borderRadius 28.
const LIST_PILL_HEIGHT = 56;
const LIST_PILL_RADIUS = 28;
const LIST_PILL_HORIZONTAL_MARGIN = 8;
const MORPH_IN_OUT_DURATION = 500;
const MORPH_OUT_HANDOFF = Math.round(MORPH_IN_OUT_DURATION * 0.94);
const BACK_BTN_SIZE = 46;
const BACK_BTN_GAP = 10;
const MAIN_PILL_LEFT = 16 + BACK_BTN_SIZE + BACK_BTN_GAP;

type ChatMediaItem = {
    url: string;
    type: 'image' | 'video' | 'audio' | 'file';
    caption?: string;
    name?: string;
};



interface SingleChatScreenProps {
    id?: string;
    isOverlay?: boolean;
    user?: Contact;
    onBack?: () => void;
    onBackStart?: () => void;
    sourceY?: number;
}


const AnyFlashList = FlashList as any;

// Format "last seen" relative time (e.g. "today at 2:30 PM", "yesterday at 11:00 AM")
const formatLastSeen = (isoString: string): string => {
    try {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) return `today at ${timeStr}`;
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${timeStr}`;
        return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${timeStr}`;
    } catch {
        return 'offline';
    }
};

const TYPING_LOTTIE = require('../../assets/animations/typing-dots.json');



// One word in a karaoke line. Top-level Animated.Text (not nested inside a Text)
// so Reanimated's UI-thread color updates actually paint on iOS.
const KaraokeWord = React.memo(({ word, index, total, progress, color, baseColor, fontSize }: any) => {
    const animatedStyle = useAnimatedStyle(() => {
        const slot = total > 0 ? (index + 0.5) / total : 0;
        // Word lights up just before its slot is reached, then stays lit.
        const fade = interpolate(progress.value, [slot - 0.12, slot], [0, 1], Extrapolation.CLAMP);
        return {
            color: interpolateColor(fade, [0, 1], [baseColor, color]),
        };
    });
    return (
        <Animated.Text style={[{ fontSize, fontWeight: '700', letterSpacing: 0.3 }, animatedStyle]}>
            {word}
        </Animated.Text>
    );
});

// Karaoke header line. Each word is its own sibling Animated.Text in a row
// (not nested in a Text), so per-word color animations apply on iOS. Font size
// is computed from the measured container width so long Devanagari lines still
// fit without wrapping.
const KaraokeLine = React.memo(({ text, lineStart, lineEnd, color, baseColor, getPlaybackPosition, isPlaying }: any) => {
    const progress = useSharedValue(0);
    const [containerWidth, setContainerWidth] = useState(180);

    useEffect(() => {
        progress.value = 0;
        const span = Math.max(0.5, lineEnd - lineStart);
        const sync = async () => {
            try {
                const posMs = await getPlaybackPosition();
                const p = ((posMs / 1000) - lineStart) / span;
                progress.value = withTiming(Math.max(0, Math.min(1, p)), { duration: 100 });
            } catch { }
        };
        sync();
        if (!isPlaying) return;
        const tick = setInterval(sync, 100);
        return () => clearInterval(tick);
    }, [text, lineStart, lineEnd, isPlaying]);

    const wordTokens = useMemo(() => text.trim().split(/\s+/).filter(Boolean), [text]);

    // Estimate font size to fit the line on one row. Devanagari glyphs are wider
    // than Latin per character, so use a larger char-width factor when present.
    const fontSize = useMemo(() => {
        const isDevanagari = /[ऀ-ॿ]/.test(text);
        const charFactor = isDevanagari ? 0.78 : 0.55;
        const usable = Math.max(40, containerWidth - 4);
        const ideal = usable / Math.max(1, text.length * charFactor);
        return Math.max(9, Math.min(14, Math.floor(ideal)));
    }, [text, containerWidth]);

    return (
        <View
            style={{ height: 20, justifyContent: 'center', overflow: 'hidden', alignSelf: 'stretch' }}
            onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        >
            <Animated.View
                key={text + lineStart}
                entering={FadeInUp.duration(280).springify().damping(16)}
                exiting={FadeOutUp.duration(180)}
                style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}
            >
                {wordTokens.map((word: string, i: number) => (
                    <KaraokeWord
                        key={i}
                        word={i < wordTokens.length - 1 ? word + ' ' : word}
                        index={i}
                        total={wordTokens.length}
                        progress={progress}
                        color={color}
                        baseColor={baseColor}
                        fontSize={fontSize}
                    />
                ))}
            </Animated.View>
        </View>
    );
});

export default function SingleChatScreen({ id: propsId, isOverlay, user: propsUser, onBack, onBackStart, sourceY: propsSourceY }: SingleChatScreenProps) {
    const { id: paramsId, sourceY: paramsSourceY } = useLocalSearchParams();
    const insets = useSafeAreaInsets();

    // Support both direct routing (params) and inline rendering (props)
    const rawId = propsId || propsUser?.id || (Array.isArray(paramsId) ? paramsId[0] : paramsId);
    // Robust parameter parsing to prevent NaN-induced black screens or native crashes
    const parsedSourceY = paramsSourceY ? Number(Array.isArray(paramsSourceY) ? paramsSourceY[0] : paramsSourceY) : undefined;
    const sourceYValue = propsSourceY ?? (typeof parsedSourceY === 'number' && !isNaN(parsedSourceY) ? parsedSourceY : undefined);
    const sourceY = (typeof sourceYValue === 'number' && !isNaN(sourceYValue)) ? sourceYValue : undefined;
    const id = (rawId && LEGACY_TO_UUID[rawId as string]) || rawId;
    const stringId = id as string;
    const isMorphEntry = typeof sourceY === 'number' && !isNaN(sourceY);

    const router = useRouter();
    const isFocused = useIsFocused();
    const { contacts, messages, sendChatMessage, startCall, activeCall, updateMessage, addReaction, toggleHeart, deleteMessage, musicState, getPlaybackPosition, seekTo, isSeeking, setIsSeeking, currentUser, activeTheme, sendTyping, typingUsers, uploadProgressTracker, connectivity, initializeChatSession, cleanupChatSession, fetchOtherUserProfile, setMusicPartner, joinGroupMusicRoom, leaveGroupMusicRoom, requestMusicSync, startGroupCall, sendMediaLikePulse, remoteLikePulse, offlineService, refreshLocalCache, playbackOwnerChatId, lyrics, currentLyricIndex, showLyrics, pendingMusicInvite, acceptMusicInvite, declineMusicInvite } = useApp() as any;
    // Only show music UI in this chat if this chat owns the current playback.
    // Use normalized id for comparison to handle legacy handles.
    const musicVisibleHere = !!musicState?.currentSong && playbackOwnerChatId === id;
    // Karaoke mode in the header: lyrics toggle is on, song has lyrics, this chat owns playback.
    const currentLine = lyrics?.[currentLyricIndex];
    const nextLine = lyrics?.[currentLyricIndex + 1];
    const karaokeText: string = (
        musicVisibleHere && showLyrics && lyrics?.length > 0 && currentLine?.text
    ) || '';
    const karaokeLineStart: number = currentLine?.time ?? 0;
    const karaokeLineEnd: number = nextLine?.time ?? (karaokeLineStart + 5);
    const themeAccent = activeTheme?.primary || '#BC002A';
    const themeAccentSoft = activeTheme?.accent || '#FF6A88';
    const { getPresence } = usePresence();
    const [alertConfig, setAlertConfig] = useState<{
        visible: boolean;
        title: string;
        message?: string;
        buttons?: AlertButton[];
    }>({ visible: false, title: '' });

    const showSoulAlert = useCallback((title: string, message?: string, buttons?: AlertButton[]) => {
        setAlertConfig({ visible: true, title, message, buttons });
    }, []);

    const closeSoulAlert = useCallback(() => {
        setAlertConfig(prev => ({ ...prev, visible: false }));
    }, []);
    const composerRef = useRef<ChatComposerHandle>(null);
    const [showCallModal, setShowCallModal] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [isAdmin, setIsAdmin] = useState(false);
    const [memberRoles, setMemberRoles] = useState<Record<string, string>>({});
    const [isLoadingProfile, setIsLoadingProfile] = useState(false);
    const [remoteContact, setRemoteContact] = useState<Contact | null>(null);



    // Defer heavy rendering (FlatList) until transition completes, but show basic UI immediately
    useEffect(() => {
        // Fast-path: Set ready status after a short delay on Android to avoid total black screens
        // during heavy initialization.
        const timeout = setTimeout(() => {
            setIsReady(true);
        }, Platform.OS === 'android' ? 250 : 400);

        const task = InteractionManager.runAfterInteractions(() => {
            setIsReady(true);
        });

        return () => {
            task.cancel();
            clearTimeout(timeout);
        };
    }, []);

    // Safety Fallback: Ensure screen becomes visible even if animations fail on Android
    useEffect(() => {
        if (isMorphEntry) {
            const fallback = setTimeout(() => {
                if (backgroundMorphProgress.value === 0) {
                    console.log('[Chat] ⚠️ Animation fallback triggered to fix black screen');
                    backgroundMorphProgress.value = withTiming(1, { duration: 300 });
                    headerAccessoryOpacity.value = withTiming(1, { duration: 300 });
                    headerPillProgress.value = withTiming(1, { duration: 300 });
                    headerPillOffsetY.value = withTiming(0, { duration: 300 });
                }
            }, 800);
            return () => clearTimeout(fallback);
        }
    }, [isMorphEntry]);

    const [callOptionsPosition, setCallOptionsPosition] = useState({ x: 0, y: 0 });
    const [isOverlayKeyboardVisible, setIsOverlayKeyboardVisible] = useState(false);

    // Morph Animation — iOS-style smooth bezier, no spring jitter
    const HEADER_TOP = 50;
    const ITEM_HEIGHT = 72;
    const ITEM_MARGIN = 16;
    const ITEM_RADIUS = 36;

    const keyboardOffset = useSharedValue(0);
    const headerAccessoryOpacity = useSharedValue(isMorphEntry ? 0 : 1);
    const backgroundMorphProgress = useSharedValue(isMorphEntry ? 0 : 1);
    const headerPillOffsetY = useSharedValue(
        isMorphEntry ? Math.max(0, sourceY - HEADER_PILL_TOP) : 0
    );
    const headerPillProgress = useSharedValue(isMorphEntry ? 0 : 1);
    const selectionModeProgress = useSharedValue(0);

    const inputAreaAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -keyboardOffset.value }],
    }));

    const messagesContainerAnimatedStyle = useAnimatedStyle(() => ({
        paddingBottom: keyboardOffset.value,
    }));

    const headerAccessoryAnimatedStyle = useAnimatedStyle(() => {
        const progress = headerAccessoryOpacity.value;
        return {
            opacity: interpolate(progress, [0, 0.4, 1], [0, 0, 1], Extrapolation.CLAMP),
            transform: [
                {
                    translateX: interpolate(
                        progress,
                        [0, 1],
                        [-24, 0],
                        Extrapolation.CLAMP
                    )
                },
                {
                    scale: interpolate(
                        progress,
                        [0, 1],
                        [0.85, 1],
                        Extrapolation.CLAMP
                    )
                }
            ] as any,
        };
    });

    // Back button fades and shrinks in lockstep with the pill expanding
    // leftward into its space. Driven by headerPillProgress (1 chat → 0
    // home) so during entry it fades IN as the pill retracts to its chat
    // position, and during back it fades OUT as the pill grows leftward
    // to occupy the full home-row width.
    const backButtonAnimatedStyle = useAnimatedStyle(() => {
        'worklet';
        const progress = headerPillProgress.value;
        // Fade window matches the pill's horizontal expansion (which kicks
        // in at progress=0.5). Back button stays fully opaque while the
        // pill is still chat-width, then fades out smoothly *while* the
        // pill grows leftward into its space — so they "merge" into each
        // other rather than the button popping out before/after the pill
        // arrives. Slight scale-down adds a subtle physical settle.
        return {
            opacity: interpolate(progress, [0, 0.5, 1], [0, 0, 1], Extrapolation.CLAMP),
            transform: [
                { scale: interpolate(progress, [0, 0.5, 1], [0.7, 0.85, 1], Extrapolation.CLAMP) },
            ] as any,
        };
    });

    const backgroundMorphAnimatedStyle = useAnimatedStyle(() => ({
        opacity: backgroundMorphProgress.value,
        transform: [
            {
                translateY: interpolate(
                    backgroundMorphProgress.value,
                    [0, 1],
                    [20, 0],
                    Extrapolation.CLAMP
                ),
            },
            {
                scale: interpolate(
                    backgroundMorphProgress.value,
                    [0, 1],
                    [0.986, 1],
                    Extrapolation.CLAMP
                ),
            },
        ] as any,
    }));

    const [isCallExpanded, setIsCallExpanded] = useState(false);
    const callMorphProgress = useSharedValue(0);


    const toggleCallMenu = useCallback(() => {
        const next = !isCallExpanded;
        setIsCallExpanded(next);
        callMorphProgress.value = withSpring(next ? 1 : 0, { 
            damping: 18, 
            stiffness: 120,
            mass: 0.8
        });
    }, [isCallExpanded]);

    const animatedCallMorphStyle = useAnimatedStyle(() => {
        const p = callMorphProgress.value;
        const entryProgress = backgroundMorphProgress.value;
        const offsetY = headerPillOffsetY.value;

        return {
            width: interpolate(p, [0, 1], [44, 180], Extrapolation.CLAMP),
            height: interpolate(p, [0, 1], [44, 170], Extrapolation.CLAMP),
            borderRadius: interpolate(p, [0, 1], [22, 24], Extrapolation.CLAMP),
            backgroundColor: interpolateColor(p, [0, 1], ['rgba(255, 255, 255, 0.08)', 'transparent']),
            position: 'absolute',
            top: HEADER_PILL_TOP + (HEADER_PILL_HEIGHT - 44) / 2 + offsetY,
            right: 24 + 10,
            opacity: interpolate(entryProgress, [0, 0.6, 1], [0, 0, 1], Extrapolation.CLAMP),
            overflow: 'hidden',
            zIndex: 9999,
            borderWidth: 1.2,
            borderColor: 'rgba(255, 255, 255, 0.22)',
            transform: [
                { scale: interpolate(entryProgress, [0, 1], [0.8, 1], Extrapolation.CLAMP) }
            ] as any,
        };
    });

    const animatedCallContentOpacity = useAnimatedStyle(() => ({
        opacity: interpolate(callMorphProgress.value, [0.4, 1], [0, 1], Extrapolation.CLAMP),
        transform: [{ scale: interpolate(callMorphProgress.value, [0, 1], [0.8, 1], Extrapolation.CLAMP) }]
    }));

    const headerMorphAnimatedStyle = useAnimatedStyle(() => {
        const progress = headerPillProgress.value;
        const selProgress = selectionModeProgress.value;

        // Horizontal extents morph alongside height/radius: at progress=1
        // (chat) the pill sits next to the back button (left=MAIN_PILL_LEFT,
        // right=24); at progress=0 (handoff to home) it expands to match the
        // home contact row's marginHorizontal:8 on both sides. Without this
        // the pill lands ~80px narrower than the row underneath, producing
        // the visible snap the user reported at the end of the slide.
        return {
            transform: [
                { translateY: headerPillOffsetY.value },
                { translateX: interpolate(selProgress, [0, 1], [0, -(MAIN_PILL_LEFT - 16)], Extrapolation.CLAMP) }
            ] as any,
            height: interpolate(
                progress,
                [0, 1],
                [LIST_PILL_HEIGHT, HEADER_PILL_HEIGHT],
                Extrapolation.CLAMP
            ),
            borderRadius: interpolate(
                progress,
                [0, 1],
                [LIST_PILL_RADIUS, HEADER_PILL_RADIUS],
                Extrapolation.CLAMP
            ),
            // Hold the pill at chat width for the first half of the morph
            // and only expand horizontally in the back half. Without this
            // stagger the pill grows wide simultaneously with the slide and
            // mid-flight reads as a stretched bar; staggering makes the
            // expansion feel like the pill "settles" into the home row at
            // the very end of the journey — the liquid feel the user asked
            // for. For entry direction (0→1) it means the pill takes its
            // chat shape early, then just settles vertically.
            left: interpolate(
                progress,
                [0, 0.5, 1],
                [LIST_PILL_HORIZONTAL_MARGIN, MAIN_PILL_LEFT, MAIN_PILL_LEFT],
                Extrapolation.CLAMP
            ),
            right: interpolate(
                progress,
                [0, 0.5, 1],
                [LIST_PILL_HORIZONTAL_MARGIN, 24, 24],
                Extrapolation.CLAMP
            ),
        };
    });

    useEffect(() => {
        if (isMorphEntry) {
            headerPillOffsetY.value = withTiming(0, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.5, 0, 0.1, 1),
            });
            headerPillProgress.value = withTiming(1, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.5, 0, 0.1, 1),
            }, (finished) => {
                if (finished) {
                    runOnJS(setAnimationFinished)(true);
                }
            });
            backgroundMorphProgress.value = withTiming(1, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.5, 0, 0.1, 1),
            });
            // Symmetrical entry for back button to match exit feel
            headerAccessoryOpacity.value = withTiming(1, { duration: 180 });
            return;
        }
        headerPillOffsetY.value = 0;
        headerPillProgress.value = 1;
        backgroundMorphProgress.value = 1;
        headerAccessoryOpacity.value = 1;
    }, [backgroundMorphProgress, headerAccessoryOpacity, headerPillOffsetY, headerPillProgress, isMorphEntry]);

    useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const onShow = (event: KeyboardEvent) => {
            // Android uses "resize" mode (set in app.json), so the OS handles keyboard avoidance.
            // We only need the manual offset for iOS.
            if (Platform.OS !== 'ios') return;

            const rawHeight = event.endCoordinates?.height || 0;
            // iOS can emit multiple keyboard frame updates while the user types
            // (predictive bar / input accessory changes). Re-subtracting the current
            // offset makes the composer fall back down even though the keyboard stays open.
            const height = Math.max(0, rawHeight);
            const duration = event.duration || 250;
            if (isOverlay) {
                setIsOverlayKeyboardVisible(true);
                requestAnimationFrame(() => {
                    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
                });
            }
            keyboardOffset.value = withTiming(height, { duration });
        };

        const onHide = () => {
            if (isOverlay) {
                setIsOverlayKeyboardVisible(false);
            }
            keyboardOffset.value = withTiming(0, { duration: 200 });
        };

        const showSub = Keyboard.addListener(showEvent, onShow);
        const hideSub = Keyboard.addListener(hideEvent, onHide);

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, [isOverlay, keyboardOffset]);

    const navigation = useNavigation();

    // Cleanup when back morph
    const finishBack = useCallback(() => {
        console.log('[ChatScreen] finishBack triggered - isOverlay:', isOverlay);
        if (onBack) {
            onBack();
        } else if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            console.warn('Navigation: Cannot go back, history stack is empty.');
        }
    }, [onBack, navigation]);

    const [replyingTo, setReplyingTo] = useState<any>(null);
    const [editingMessage, setEditingMessage] = useState<Message | null>(null);
    const [selectedContextMessage, setSelectedContextMessage] = useState<{ msg: any, layout: any } | null>(null);
    const [showMusicPlayer, setShowMusicPlayer] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
    const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
    const isNavigatingRef = useRef(false);
    const [topDateLabel, setTopDateLabel] = useState('');
    const [animationFinished, setAnimationFinished] = useState(!isMorphEntry);

    useEffect(() => {
        selectionModeProgress.value = withTiming(selectionMode ? 1 : 0, {
            duration: 350,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
        });
    }, [selectionMode]);

    const formatDateLabel = useCallback((d: Date) => {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
            year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
        });
    }, []);

    const onViewableItemsChanged = useCallback(({ viewableItems }: any) => {
        // Guard: Only update if transition is ready and there's a message
        if (isReady && viewableItems && viewableItems.length > 0) {
            const topViewable = viewableItems[viewableItems.length - 1];
            if (topViewable && topViewable.item && topViewable.item.timestamp) {
                const dateLabel = formatDateLabel(new Date(topViewable.item.timestamp));
                setTopDateLabel(prev => prev !== dateLabel ? dateLabel : prev);
            }
        }
    }, [isReady, formatDateLabel]);

    const onViewableItemsChangedRef = useRef(onViewableItemsChanged);
    useEffect(() => { onViewableItemsChangedRef.current = onViewableItemsChanged; }, [onViewableItemsChanged]);

    const viewabilityConfigCallbackPairs = useRef([
        {
            viewabilityConfig: { itemVisiblePercentThreshold: 10, minimumViewTime: 0 },
            onViewableItemsChanged: (info: any) => onViewableItemsChangedRef.current(info)
        }
    ]);

    // Animate OUT — butter smooth unified morph back to pill
    const handleBack = useCallback(() => {
        if (isNavigatingRef.current) return;

        if (selectionMode) {
            setSelectionMode(false);
            setSelectedMessageIds([]);
            return;
        }

        isNavigatingRef.current = true;
        if (onBackStart) onBackStart();

        // Close transient overlays before navigating back to avoid stale touch blockers.
        setShowCallModal(false);
        setSelectedContextMessage(null);
        composerRef.current?.dismissModals();
        setMediaCollection(null);
        setMediaViewer(null);

        // OUT = reverse of IN (same easing + same duration + same path).
        if (isMorphEntry && sourceY !== undefined) {
            chatTransitionState.setPhase('returning');
            // Fade out accessory slightly slower for smoother merge
            headerAccessoryOpacity.value = withTiming(0, { duration: 180 });
            backgroundMorphProgress.value = withTiming(0, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.5, 0, 0.1, 1),
            });
            headerPillOffsetY.value = withTiming(Math.max(0, sourceY - HEADER_PILL_TOP), {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.5, 0, 0.1, 1),
            });
            headerPillProgress.value = withTiming(0, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.5, 0, 0.1, 1),
            });
            // Small handoff delay keeps the return motion closer to the
            // entry feel without changing the pill animation itself.
            // Overlays (like Status View) need the component to stay mounted
            // for the FULL duration to see the animation finish.
            const handoffDelay = isOverlay ? MORPH_IN_OUT_DURATION : MORPH_OUT_HANDOFF;
            setTimeout(() => finishBack(), handoffDelay);
            return;
        }
        chatTransitionState.setPhase('returning');
        headerAccessoryOpacity.value = withTiming(0, { duration: 180 });
        backgroundMorphProgress.value = withTiming(0, {
            duration: 250,
            easing: Easing.bezier(0.5, 0, 0.1, 1),
        });
        setTimeout(() => finishBack(), 220);
    }, [
        backgroundMorphProgress,
        finishBack,
        headerAccessoryOpacity,
        headerPillOffsetY,
        headerPillProgress,
        isMorphEntry,
        onBackStart,
        selectionMode,
        sourceY,
    ]);

    // Defensive cleanup: if the screen blurs/unmounts while an overlay is open,
    // ensure it cannot keep intercepting touches above the list screen.
    useFocusEffect(
        useCallback(() => {
            return () => {
                setShowCallModal(false);
                setSelectedContextMessage(null);
                composerRef.current?.dismissModals();
                setMediaCollection(null);
                setMediaViewer(null);
                setSelectionMode(false);
                setSelectedMessageIds([]);
            };
        }, [])
    );

    // Animation Values
    const modalAnim = useRef(new RNAnimated.Value(0)).current;

    // Refs
    const flatListRef = useRef<any>(null);
    const profileAvatarRef = useRef<View>(null);
    const inputContainerRef = useRef<View>(null);
    const hasScrolledInitial = useRef(false);

    // Music progress for header glow. Stays visible while paused — we just stop
    // polling. Only resets when there's no song at all or this chat doesn't own
    // the active playback.
    const [musicProgress, setMusicProgress] = useState(0);
    useEffect(() => {
        if (!musicVisibleHere) { setMusicProgress(0); return; }
        if (isSeeking) return;

        const sync = async () => {
            try {
                const pos = await getPlaybackPosition();
                const dur = (musicState.currentSong?.duration || 240) * 1000;
                setMusicProgress(Math.min(pos / dur, 1));
            } catch { }
        };

        // Always sync once so the bar reflects the real position after pause/resume.
        sync();
        if (!musicState.isPlaying) return;

        const interval = setInterval(sync, 200);
        return () => clearInterval(interval);
    }, [musicVisibleHere, musicState?.isPlaying, musicState?.currentSong?.id, isSeeking]);

    const headerPillRef = useRef<View>(null);
    const [headerPillWidth, setHeaderPillWidth] = useState(SCREEN_WIDTH - MAIN_PILL_LEFT - 24);
    const headerBarPageX = useRef(0);
    const handleHeaderSeek = useCallback((locationX: number, commit = false) => {
        if (!musicState?.currentSong?.duration) return;
        const percent = Math.max(0, Math.min(1, locationX / headerPillWidth));
        const targetMs = percent * musicState.currentSong.duration * 1000;
        if (commit) {
            seekTo(targetMs);
            setIsSeeking(false);
        }
        setMusicProgress(percent);
    }, [musicState?.currentSong?.duration, seekTo, headerPillWidth, setIsSeeking]);

    const headerSeekPanResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (e) => {
                setIsSeeking(true);
                const { locationX, pageX } = e.nativeEvent;
                headerBarPageX.current = pageX - locationX;
                handleHeaderSeek(locationX);
            },
            onPanResponderMove: (e) => {
                const relativeX = e.nativeEvent.pageX - headerBarPageX.current;
                handleHeaderSeek(relativeX);
            },
            onPanResponderRelease: (e) => {
                const relativeX = e.nativeEvent.pageX - headerBarPageX.current;
                handleHeaderSeek(relativeX, true);
            },
            onPanResponderTerminate: () => {
                setIsSeeking(false);
            },
            onPanResponderTerminationRequest: () => false,
        })
    ).current;

    // Animation Layout State
    const [inputLayout, setInputLayout] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
    // Derived State
    const contact = useMemo(() => {
        const found = contacts.find(c => c.id === id) || remoteContact;
        if (found) return found;

        // Fallback for legacy ID navigation
        const legacyMappedUuid = id ? (USERS[id]?.id) : null;
        if (legacyMappedUuid) {
            return contacts.find(c => c.id === legacyMappedUuid);
        }
        return undefined;
    }, [contacts, id, remoteContact]);

    // For groups, if the local contact row is missing the avatar (e.g. an
    // earlier saveContact got dropped due to SQLite BUSY), prefer the merged
    // groups+contacts lookup from `remoteContact` whenever it has a richer
    // avatar. This makes the chat header self-heal even when the contacts
    // row is partially populated.
    const isGroupContact = !!(contact?.isGroup);
    const remoteHasBetterAvatar =
        isGroupContact && !!remoteContact && (!contact?.avatar || contact.avatar === '') && !!remoteContact.avatar;

    // Fetch profile if contact not found locally (e.g. after account switch or from discovery)
    const remoteFetchAttemptedRef = React.useRef<string | null>(null);
    useEffect(() => {
        // Trigger the same remote/local-merge fetch we use for missing contacts
        // when the contact exists but is a group with an empty avatar.
        const needsAvatarHeal = isGroupContact && (!contact?.avatar || contact.avatar === '');
        if ((!contact || needsAvatarHeal) && stringId && !isLoadingProfile && remoteFetchAttemptedRef.current !== stringId) {
            remoteFetchAttemptedRef.current = stringId;
            console.log('[Chat] Contact not found locally, fetching remote profile for:', stringId);
            setIsLoadingProfile(true);
            
            // Re-use fetchOtherUserProfile from context but also handle the result locally for this screen
            const fetchRemote = async () => {
                try {
                    const sid = (stringId && LEGACY_TO_UUID[stringId]) || stringId;

                    // Group fallback: if a local group row exists for this id, use it
                    // as the contact. We probe the contacts table too — handleUpdateGroupAvatar
                    // writes the locally-cached file path there (groups table only stores
                    // the remote storage key). And if BOTH local sources are missing the
                    // avatar we hit Supabase's chat_groups table as a last resort to heal
                    // legacy state where an avatar was uploaded before the local-tables
                    // sync was wired up.
                    try {
                        // allSettled so one read failing (e.g. transient SQLite BUSY)
                        // doesn't take down the other.
                        const [groupResult, contactResult] = await Promise.allSettled([
                            offlineService?.getGroup?.(sid),
                            offlineService?.getContact?.(sid),
                        ]);
                        const localGroup = groupResult.status === 'fulfilled' ? groupResult.value : null;
                        const localContact = contactResult.status === 'fulfilled' ? contactResult.value : null;
                        console.log('[Chat] Group fallback probe:', {
                            sid,
                            localGroupAvatar: localGroup?.avatarUrl ?? null,
                            localContactAvatar: localContact?.avatar ?? null,
                            localContactIsGroup: localContact?.isGroup ?? null,
                        });
                        if (localGroup || localContact?.isGroup) {
                            // Prefer the storage key from whichever source has it (contacts is
                            // updated last when the avatar changes, so it's freshest).
                            let avatarKey = localContact?.avatar || localGroup?.avatarUrl;

                            // If local SQLite has the avatar but the chat-list contacts
                            // state was hydrated before the heal landed, copy it onto
                            // contacts.avatar (in case it lives only in groups.avatar_url)
                            // and re-hydrate. Cheap: only fires when the group is missing
                            // its avatar in the contacts row but groups has it.
                            if (avatarKey && (!localContact?.avatar || localContact.avatar === '')) {
                                try {
                                    await offlineService?.upsertContactAvatar?.({
                                        id: sid,
                                        name: localGroup?.name || localContact?.name || 'Group',
                                        avatar: avatarKey,
                                        isGroup: true,
                                    });
                                } catch {}
                                try { await refreshLocalCache?.(true); } catch {}
                            }

                            // Both local sources empty → ask Supabase. Self-heal local
                            // tables for next time so we don't have to round-trip again.
                            if (!avatarKey) {
                                try {
                                    const { data: groupRow } = await supabase
                                        .from('chat_groups')
                                        .select('avatar_url, name, description')
                                        .eq('id', sid)
                                        .maybeSingle();
                                    if (groupRow?.avatar_url) {
                                        avatarKey = groupRow.avatar_url;
                                        // Heal local SQLite, then re-hydrate ChatContext so the
                                        // chat list picks up the avatar without an app restart.
                                        // Without the refresh, the heal writes succeed but the
                                        // contacts state in memory stays stale until next launch.
                                        try {
                                            await offlineService?.saveGroup?.({
                                                id: sid,
                                                name: groupRow.name || localGroup?.name || 'Group',
                                                description: groupRow.description ?? null,
                                                avatarUrl: groupRow.avatar_url,
                                                creatorId: null,
                                                createdAt: null,
                                                updatedAt: new Date().toISOString(),
                                            } as any);
                                        } catch {}
                                        try {
                                            await offlineService?.upsertContactAvatar?.({
                                                id: sid,
                                                name: groupRow.name || localGroup?.name || localContact?.name || 'Group',
                                                avatar: groupRow.avatar_url,
                                                isGroup: true,
                                            });
                                        } catch {}
                                        try { await refreshLocalCache?.(true); } catch {}
                                    }
                                } catch (cloudErr) {
                                    console.warn('[Chat] Cloud group avatar lookup failed:', cloudErr);
                                }
                            }

                            setRemoteContact({
                                id: (localGroup?.id || localContact?.id || sid) as string,
                                name: localGroup?.name || localContact?.name || 'Group',
                                avatar: proxySupabaseUrl(avatarKey),
                                // CRITICAL: never use 'teddy' here — that makes SoulAvatar fetch
                                // a generated avatar URL and ignore the actual group photo.
                                avatarType: 'default',
                                localAvatarUri: localContact?.localAvatarUri,
                                status: 'offline',
                                about: localGroup?.description || '',
                                lastMessage: '',
                                unreadCount: 0,
                                isGroup: true,
                            } as Contact);
                            return;
                        }
                    } catch { /* ignore and fall through to profiles fetch */ }

                    const { data, error } = await supabase.from('profiles').select('*').eq('id', sid).maybeSingle();

                    if (data) {
                        const normalized: Contact = {
                            id: data.id,
                            name: data.display_name || data.name || data.username || 'User',
                            avatar: proxySupabaseUrl(data.avatar_url),
                            avatarType: data.avatar_type || 'teddy',
                            teddyVariant: data.teddy_variant || 'boy',
                            status: 'offline', // Default status for remote fetch
                            about: data.bio || 'Forever in sync',
                            lastMessage: '',
                            unreadCount: 0,
                        };
                        setRemoteContact(normalized);
                    } else {
                        console.warn('[Chat] Remote profile fetch returned no data');
                    }
                } catch (err) {
                    console.error('[Chat] Remote profile fetch failed:', err);
                } finally {
                    setIsLoadingProfile(false);
                }
            };
            
            fetchRemote();
        }
    }, [contact, stringId, isLoadingProfile]);

    const profileAvatarTransitionTag = useMemo(() => {
        const transitionId = normalizeId(contact?.id || String(id || ''));
        return transitionId ? getProfileAvatarTransitionTag(transitionId) : undefined;
    }, [contact?.id, id]);
    const profilePreviewAvatarSource = useMemo(() => resolveAvatarImageUri({
        uri: (remoteHasBetterAvatar ? remoteContact?.avatar : contact?.avatar) || contact?.avatar,
        localUri: contact?.localAvatarUri || remoteContact?.localAvatarUri,
        avatarType: ((contact?.avatarType || remoteContact?.avatarType) as any) || 'default',
        teddyVariant: ((contact as any)?.teddyVariant || (remoteContact as any)?.teddyVariant) as any,
        fallbackId: contact?.id || String(id || 'default'),
    }), [
        contact?.avatar,
        contact?.avatarType,
        contact?.id,
        contact?.localAvatarUri,
        id,
        remoteContact?.avatar,
        remoteContact?.avatarType,
        remoteContact?.localAvatarUri,
        remoteHasBetterAvatar,
    ]);
    const isGroup = contact?.isGroup || false;
    const targetProfileId = String(contact?.id || id || '');
    const normalizedTargetProfileId = useMemo(() => normalizeId(targetProfileId), [targetProfileId]);
    const [profileAvatarTransition, setProfileAvatarTransition] = useState(() =>
        profileAvatarTransitionState.getState()
    );
    const shouldHideHeaderAvatar = !isFocused
        && !!normalizedTargetProfileId
        && profileAvatarTransition.phase !== 'idle'
        && normalizeId(profileAvatarTransition.profileId || '') === normalizedTargetProfileId;

    useEffect(() => {
        const unsubscribe = profileAvatarTransitionState.subscribe(setProfileAvatarTransition);
        return unsubscribe;
    }, []);

    useEffect(() => {
        if (isGroup || !profilePreviewAvatarSource) {
            return;
        }
        void warmAvatarSource(profilePreviewAvatarSource);
    }, [isGroup, profilePreviewAvatarSource]);

    const openProfileWithMorph = useCallback(() => {
        if (isNavigatingRef.current) return;
        try {
            console.log('[ChatScreen] Opening profile for:', targetProfileId);
            const pushProfile = async (origin?: { x: number; y: number; width: number; height: number }) => {
                try {
                    if (!isGroup && profilePreviewAvatarSource) {
                        await Promise.race([
                            warmAvatarSource(profilePreviewAvatarSource),
                            new Promise((resolve) => setTimeout(resolve, 120)),
                        ]);
                    }
                    if (normalizedTargetProfileId) {
                        profileAvatarTransitionState.show(normalizedTargetProfileId);
                    }
                    router.push({
                        pathname: (isGroup ? '/group-info/[id]' : '/profile/[id]') as any,
                        params: !isGroup && ENABLE_PROFILE_AVATAR_SHARED_TRANSITION && profileAvatarTransitionTag
                            ? {
                                id: String(targetProfileId),
                                avatarTransition: '1',
                                avatarSource: profilePreviewAvatarSource || undefined,
                            }
                            : origin
                                ? {
                                    id: String(targetProfileId),
                                    avatarX: Math.round(origin.x).toString(),
                                    avatarY: Math.round(origin.y).toString(),
                                    avatarW: Math.round(origin.width).toString(),
                                    avatarH: Math.round(origin.height).toString(),
                                    avatarSource: !isGroup ? (profilePreviewAvatarSource || undefined) : undefined,
                                }
                                : {
                                    id: String(targetProfileId),
                                    avatarSource: !isGroup ? (profilePreviewAvatarSource || undefined) : undefined,
                                },
                    });
                } catch (pushErr) {
                    console.error('[ChatScreen] Navigation push failed:', pushErr);
                    router.push((isGroup ? `/group-info/${targetProfileId}` : `/profile/${targetProfileId}`) as any);
                }
            };

            if (!isGroup && ENABLE_PROFILE_AVATAR_SHARED_TRANSITION && profileAvatarTransitionTag) {
                void pushProfile();
                return;
            }

            // Measure the avatar's real on-screen position so the dismiss
            // morph lands exactly back on the chat header avatar — no ghost,
            // no offset from safe-area or status-bar insets.
            const node = profileAvatarRef.current;
            if (node && typeof (node as any).measureInWindow === 'function') {
                (node as any).measureInWindow((pageX: number, pageY: number, w: number, h: number) => {
                    if (!Number.isFinite(pageX) || !Number.isFinite(pageY) || !w || !h) {
                        void pushProfile({ x: MAIN_PILL_LEFT + 8, y: HEADER_PILL_TOP + (HEADER_PILL_HEIGHT - 46) / 2, width: 46, height: 46 });
                        return;
                    }
                    void pushProfile({ x: pageX, y: pageY, width: w, height: h });
                });
                return;
            }
            if (node && typeof (node as any).measure === 'function') {
                (node as any).measure((_x: number, _y: number, w: number, h: number, pageX: number, pageY: number) => {
                    if (!Number.isFinite(pageX) || !Number.isFinite(pageY) || !w || !h) {
                        void pushProfile({ x: MAIN_PILL_LEFT + 8, y: HEADER_PILL_TOP + (HEADER_PILL_HEIGHT - 46) / 2, width: 46, height: 46 });
                        return;
                    }
                    void pushProfile({ x: pageX, y: pageY, width: w, height: h });
                });
                return;
            }

            void pushProfile({
                x: MAIN_PILL_LEFT + 8,
                y: HEADER_PILL_TOP + (HEADER_PILL_HEIGHT - 46) / 2,
                width: 46,
                height: 46,
            });
        } catch (err) {
            console.error('[ChatScreen] openProfileWithMorph failed:', err);
            if (normalizedTargetProfileId) {
                profileAvatarTransitionState.clear(normalizedTargetProfileId);
            }
            router.push((isGroup ? `/group-info/${targetProfileId}` : `/profile/${targetProfileId}`) as any);
        }
    }, [isGroup, normalizedTargetProfileId, profileAvatarTransitionTag, profilePreviewAvatarSource, router, targetProfileId]);

    // FIX: Use contact.id (UUID) for message lookup, not the raw id param
    const messageKey = contact?.id || id || '';
    const chatMessages = messages[messageKey] || [];
    // Memoize reversed messages to avoid expensive array operations in render
    const reversedMessages = useMemo(() => [...chatMessages].filter(m => !isMessageEmpty(m)).reverse(), [chatMessages]);
    const isTyping = contact ? typingUsers.includes(normalizeId(contact.id)) : false;
    useEffect(() => {
        console.log('[Typing] chat screen state — contact.id:', contact?.id, '| typingUsers:', typingUsers, '| isTyping:', isTyping);
    }, [isTyping, typingUsers, contact?.id]);

    useEffect(() => {
        if (!isFocused || !currentUser?.id || !id) {
            return;
        }

        const task = InteractionManager.runAfterInteractions(async () => {
            initializeChatSession?.(id, isGroup);
            if (!isGroup) {
                fetchOtherUserProfile?.(id);
                if (id) {
                    setMusicPartner?.(id);
                    setTimeout(() => requestMusicSync?.(), 1000);
                }
            } else {
                if (id) {
                    joinGroupMusicRoom?.(id);
                    setTimeout(() => requestMusicSync?.(), 700);
                }
                // Fetch roles for all group members
                const { data: members } = await supabase
                    .from('group_members')
                    .select('user_id, role')
                    .eq('group_id', id);

                if (members) {
                    const roles: Record<string, string> = {};
                    members.forEach(m => {
                        roles[m.user_id] = m.role;
                    });
                    setMemberRoles(roles);
                    if (roles[currentUser?.id] === 'admin') {
                        setIsAdmin(true);
                    }
                }
            }
        });

        return () => {
            task.cancel();
            if (isGroup && id) {
                void leaveGroupMusicRoom?.(id);
            }
            cleanupChatSession?.(id);
        };
    }, [cleanupChatSession, id, currentUser?.id, initializeChatSession, fetchOtherUserProfile, isFocused, isGroup, joinGroupMusicRoom, leaveGroupMusicRoom, requestMusicSync, setMusicPartner]);

    // Mark incoming messages as read when chat is open or app returns to foreground
    useEffect(() => {
        const markUnread = () => {
            const unreadIds = chatMessages
                .filter(m => m.sender === 'them' && m.status !== 'read')
                .map(m => m.id);
            if (unreadIds.length > 0) {
                chatService.markMessagesAsRead(unreadIds);
            }
        };

        markUnread();

        // Also mark read when app comes back to foreground
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') markUnread();
        });
        return () => subscription.remove();
    }, [chatMessages]);


    const callButtonRef = useRef<View>(null);

    // Media picker state
    const [mediaCollection, setMediaCollection] = useState<{ messageId: string; items: ChatMediaItem[]; startIndex: number } | null>(null);
    const [mediaViewer, setMediaViewer] = useState<{ messageId: string; items: ChatMediaItem[]; index: number } | null>(null);
    const [selectedMediaLayout, setSelectedMediaLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [mediaItemReactions, setMediaItemReactions] = useState<Record<string, string[]>>({});





    // Smart scroll: only auto-scroll to latest message if user is already at bottom.
    // Prevents yanking the user away when they're reading older messages.
    const isNearBottomRef = useRef(true);
    const prevMsgCount = useRef(chatMessages?.length || 0);
    useEffect(() => {
        if ((chatMessages?.length || 0) > prevMsgCount.current && isNearBottomRef.current) {
            setTimeout(() => {
                flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            }, 100);
        }
        prevMsgCount.current = chatMessages?.length || 0;
    }, [chatMessages?.length]);

    // Handle content size change if needed (but inverted handles most cases)
    const handleContentSizeChange = useCallback(() => {
        // Naturally starts at index 0 (bottom) when inverted
    }, []);

    const openCallModal = () => {
        console.log('[Chat] 📞 Opening call modal...');

        // Show immediately with a sensible fallback so the overlay appears
        setCallOptionsPosition({ x: 0, y: 115 });
        setShowCallModal(true);

        RNAnimated.spring(modalAnim, {
            toValue: 1,
            useNativeDriver: true,
            tension: 110,
            friction: 9,
        }).start();

        if (callButtonRef.current) {
            // Refine position if possible
            requestAnimationFrame(() => {
                callButtonRef.current?.measure((x, y, width, height, pageX, pageY) => {
                    console.log(`[Chat] 📍 Measure result: x=${x}, y=${y}, w=${width}, h=${height}, pageX=${pageX}, pageY=${pageY}`);

                    const safeY = (typeof pageY === 'number' && !isNaN(pageY) && pageY > 0) ? pageY : 60;
                    const safeHeight = (typeof height === 'number' && !isNaN(height) && height > 0) ? height : 44;

                    const finalPos = { x: 0, y: safeY + safeHeight + 14 };
                    console.log('[Chat] 🎯 Refining callOptionsPosition:', finalPos);
                    setCallOptionsPosition(finalPos);
                });
            });
        }
    };

    const closeCallModal = () => {
        RNAnimated.timing(modalAnim, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
        }).start(() => setShowCallModal(false));
    };

    const handleCall = async (type: 'audio' | 'video') => {
        closeCallModal();
        if (isGroup && id) {
            try {
                // Fetch group members from supabase
                const { data, error } = await supabase
                    .from('group_members')
                    .select('user_id')
                    .eq('group_id', id);

                if (error) throw error;

                const participantIds = data
                    .map(m => m.user_id)
                    .filter(uid => normalizeId(uid) !== normalizeId(currentUser?.id));

                if (participantIds.length === 0) {
                    Alert.alert('Group Call', 'No other members to call.');
                    return;
                }

                await startGroupCall(id as string, participantIds, type);
            } catch (err) {
                console.error('[Chat] Group call failed:', err);
                Alert.alert('Error', 'Could not start group call.');
            }
        } else if (id) {
            startCall(id as string, type);
        }
    };


    const handleReaction = useCallback((emoji: string) => {
        if (selectedContextMessage && id) {
            addReaction(id, selectedContextMessage.msg.id, emoji);
        }
    }, [addReaction, id, selectedContextMessage]);

    const handleAction = (action: string) => {
        if (selectedContextMessage && id) {
            if (action === 'delete') {
                const mediaItems = getMessageMediaItems(selectedContextMessage.msg);
                const isGroupedMedia = mediaItems.length > 1;
                showSoulAlert(
                    isGroupedMedia ? 'Delete for Everyone' : 'Delete for Everyone',
                    isGroupedMedia
                        ? `This will delete this media group (${mediaItems.length} items) for everyone in this chat.`
                        : 'This will delete this message for everyone in this chat.',
                    [
                        { text: 'Cancel', style: 'cancel' },
                        {
                            text: 'Delete for Me',
                            onPress: () => deleteMessage(id, selectedContextMessage.msg.id, false, true),
                        },
                        {
                            text: 'Delete for Everyone',
                            style: 'destructive',
                            onPress: () => deleteMessage(id, selectedContextMessage.msg.id, isAdmin),
                        },
                    ]
                );
            } else if (action === 'deleteForMe') {
                const mediaItems = getMessageMediaItems(selectedContextMessage.msg);
                const isGroupedMedia = mediaItems.length > 1;
                showSoulAlert(
                    'Delete for Me',
                    isGroupedMedia
                        ? `Delete this media group (${mediaItems.length} items) from your device?`
                        : 'Delete this message from your device?',
                    [
                        { text: 'Cancel', style: 'cancel' },
                        {
                            text: 'Delete for Me',
                            style: 'destructive',
                            onPress: () => {
                                // For 'Delete for Me', we pass false for isAdminOverride 
                                // and we'll ensure ChatContext handles it locally if it's not a global delete.
                                // Actually, we should probably pass a flag to deleteMessage.
                                deleteMessage(id, selectedContextMessage.msg.id, false, true);
                            },
                        },
                    ]
                );
            } else if (action === 'reply') {
                setEditingMessage(null);
                setReplyingTo(selectedContextMessage.msg);
            } else if (action === 'copy') {
                const sourceText =
                    selectedContextMessage.msg.text ||
                    selectedContextMessage.msg.media?.caption ||
                    '';
                if (!sourceText) {
                    Alert.alert('Copy', 'No text to copy in this message.');
                } else {
                    Clipboard.setStringAsync(sourceText).catch(() => { });
                }
            } else if (action === 'forward') {
                const forwardText =
                    selectedContextMessage.msg.text ||
                    selectedContextMessage.msg.media?.caption ||
                    '[Media]';
                setEditingMessage(null);
                setReplyingTo(null);
                composerRef.current?.setInputText(`↪ ${forwardText}`);
            } else if (action === 'star') {
                updateMessage(id as string, selectedContextMessage.msg.id, { isStarred: true } as any);
            } else if (action === 'unstar') {
                updateMessage(id as string, selectedContextMessage.msg.id, { isStarred: false } as any);
            } else if (action === 'edit') {
                if (selectedContextMessage.msg.sender !== 'me') return;
                setReplyingTo(null);
                setEditingMessage(selectedContextMessage.msg as any);
            } else if (action === 'pin') {
                updateMessage(id as string, selectedContextMessage.msg.id, { isPinned: true } as any);
            } else if (action === 'unpin') {
                updateMessage(id as string, selectedContextMessage.msg.id, { isPinned: false } as any);
            } else if (action === 'select') {
                setSelectionMode(true);
                setSelectedMessageIds([selectedContextMessage.msg.id]);
            }
        }
        setSelectedContextMessage(null);
    };

    const handleQuotePress = useCallback((quoteId: string) => {
        const index = reversedMessages.findIndex(m => m.id === quoteId);
        if (index !== -1) {
            flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
            setHighlightedMessageId(quoteId);
            setTimeout(() => setHighlightedMessageId(null), 1500);
        }
    }, [reversedMessages]);



    const unreadIncomingIds = useMemo(
        () => reversedMessages.filter((m: any) => m.sender === 'them' && m.status !== 'read').map((m: any) => m.id),
        [reversedMessages]
    );

    const handleSelectToggle = useCallback((msgId: string) => {
        setSelectedMessageIds(prev => {
            const next = prev.includes(msgId) ? prev.filter(i => i !== msgId) : [...prev, msgId];
            if (next.length === 0) setSelectionMode(false);
            return next;
        });
    }, []);

    const handleDeleteSelected = () => {
        showSoulAlert(
            `Delete ${selectedMessageIds.length} Message${selectedMessageIds.length > 1 ? 's' : ''}`,
            'Are you sure you want to delete these messages for everyone?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        selectedMessageIds.forEach(msgId => {
                            if (id) deleteMessage(id, msgId, isAdmin);
                        });
                        setSelectionMode(false);
                        setSelectedMessageIds([]);
                    }
                }
            ]
        );
    };

    const handleDoubleTap = useCallback((msgId: string, mediaIndex?: number) => {
        if (!id) return;
        if (typeof mediaIndex === 'number' && typeof sendMediaLikePulse === 'function') {
            sendMediaLikePulse(id, msgId, mediaIndex);
        }
        if (typeof toggleHeart === 'function') {
            toggleHeart(id, msgId);
        } else {
            addReaction(id, msgId, '❤️');
        }
    }, [addReaction, id, toggleHeart, sendMediaLikePulse]);

    const handleMediaTap = (payload: any) => {
        if (payload?.theaterSession) {
            const theater = payload.theater || {};
            const sessionId: string | undefined = payload.sessionId || theater.sessionId;
            if (!sessionId) {
                showSoulAlert('Theater', 'Session id missing — try resending the invite.');
                return;
            }
            const youtubeVideoId: string | undefined = theater.youtubeVideoId || payload.youtubeVideoId;
            if (!youtubeVideoId) {
                showSoulAlert('Theater', 'No YouTube video attached to this session.');
                return;
            }
            const isHost = !!(theater.hostId && currentUser?.id && theater.hostId === currentUser.id);
            router.push({
                pathname: '/theater/[sessionId]' as any,
                params: {
                    sessionId: String(sessionId),
                    chatId: messageKey,
                    contactName: contact?.name || '',
                    messageId: payload.messageId || '',
                    title: payload.title || 'Theater Night',
                    mediaTitle: theater.mediaTitle || '',
                    channelTitle: theater.channelTitle || '',
                    thumbnail: payload.thumbnail || '',
                    youtubeVideoId,
                    isLocked: theater.isLocked ? '1' : '0',
                    isHost: isHost ? '1' : '0',
                    hostId: theater.hostId || '',
                },
            });
            return;
        }
        if (!payload?.mediaItems?.length) return;

        // 🛡️ Secondary Check: Prevent viewing expired statuses
        const msg = (chatMessages || []).find(m => m.id === payload.messageId);
        if (msg?.media?.type === 'status_reply') {
            const timestamp = msg.timestamp;
            const STATUS_EXPIRATION_MS = 24 * 60 * 60 * 1000;
            if (timestamp && (Date.now() - new Date(timestamp).getTime()) > STATUS_EXPIRATION_MS) {
                showSoulAlert('Status Expired', 'This status was posted more than 24 hours ago and is no longer available.');
                return;
            }
        }

        const nextViewer = {
            messageId: payload.messageId,
            items: payload.mediaItems,
            index: payload.index || 0,
        };
        if (payload.layout) {
            setSelectedMediaLayout(payload.layout);
        }
        if (payload.openGallery) {
            setMediaCollection({
                messageId: payload.messageId,
                items: payload.mediaItems,
                startIndex: payload.index || 0,
            });
            return;
        }
        setMediaViewer(nextViewer);
    };

    const addReactionToMedia = (messageId: string, mediaIndex: number, emoji: string) => {
        const key = `${messageId}:${mediaIndex}`;
        setMediaItemReactions(prev => ({
            ...prev,
            [key]: [...(prev[key] || []), emoji],
        }));
    };

    const handleReactAllMedia = (messageId: string, emoji: string) => {
        if (!id) return;
        addReaction(id, messageId, emoji);
    };

    const handleSaveCurrentMedia = async () => {
        if (!mediaViewer) return;
        const current = mediaViewer.items[mediaViewer.index];
        if (!current?.url) return;

        try {
            const permission = await MediaLibrary.requestPermissionsAsync();
            if (permission.status !== 'granted') {
                showSoulAlert('Permission Required', 'Allow media library access to save files.');
                return;
            }

            let localUri = current.url;
            if (!current.url.startsWith('file://')) {
                const extension = current.type === 'video' ? '.mp4' : '.jpg';
                const target = `${cacheDirectory}soul_${Date.now()}${extension}`;
                const downloaded = await downloadAsync(current.url, target);
                localUri = downloaded.uri;
            }

            // Save to Soul album in gallery (WhatsApp-style) + device library
            const mediaType = current.type === 'video' ? 'video' : 'image';
            await soulFolderService.saveToDeviceGallery(localUri, mediaType as any, false);
            Alert.alert('Saved', 'Media saved to your gallery.');
        } catch (error) {
            Alert.alert('Save Failed', 'Could not save this media.');
        }
    };

    const handleMediaDownload = useCallback(async (msgId: string, url: string, index: number, manual = false) => {
        try {
            const currentMsg = (chatMessages || []).find(m => m.id === msgId);
            const mediaItems = currentMsg ? getMessageMediaItems(currentMsg) : [];
            const isGroupedMedia = mediaItems.length > 1;
            const downloadKey = isGroupedMedia ? `${msgId}:${index}` : msgId;

            // Route through download queue for concurrency control + wifi-only policy
            const result = await downloadQueue.enqueue(downloadKey, url, undefined, false, 1, manual, downloadKey);

            if (!result.success || !result.localUri) {
                if (result.error !== 'Already downloading') {
                    console.warn(`[ChatScreen] Media download failed for ${msgId}:${index}:`, result.error);
                }
                // Force re-render so MessageBubble clears downloading state via localFileUri check
                if (updateMessage && id) {
                    if (currentMsg) {
                        updateMessage(id as string, msgId, {
                            downloadFailed: true,
                        } as any);
                    }
                }
                if (manual && result.error && result.error !== 'Already downloading') {
                    Alert.alert('Download Failed', result.error);
                }
                return;
            }

            // Update AppContext State to trigger re-render in UI
            if (updateMessage && id) {
                if (currentMsg) {
                    if (isGroupedMedia && currentMsg.media?.thumbnail) {
                        updateMessage(id as string, msgId, {
                            downloadFailed: false,
                            media: {
                                ...currentMsg.media,
                                thumbnail: applyGroupedMediaLocalUri(
                                    currentMsg.media.thumbnail,
                                    index,
                                    result.localUri
                                ) || currentMsg.media.thumbnail,
                            },
                        } as any);
                    } else {
                        updateMessage(id as string, msgId, {
                            downloadFailed: false,
                            localFileUri: result.localUri,
                            media: currentMsg.media ? { ...currentMsg.media } : {}
                        } as any);
                    }
                }
            }
        } catch (error) {
            console.error('[ChatScreen] Media download error:', error);
            // Clear downloading state on exception too
            if (updateMessage && id) {
                updateMessage(id as string, msgId, { downloadFailed: true } as any);
            }
            if (manual) {
                Alert.alert('Download Failed', error instanceof Error ? error.message : 'Could not download this media.');
            }
        }
    }, [id, chatMessages, updateMessage]);

    const handleRetryMessage = useCallback(async (msgId: string) => {
        if (!id) return;
        try {
            await chatService.retryMessage(msgId);
            updateMessage(id as string, msgId, { status: 'pending' } as any);
        } catch (e) {
            showSoulAlert('Retry Failed', 'Could not retry this message.');
        }
    }, [id, updateMessage]);

    const handleTheaterEnd = useCallback((msgId: string, theaterData: any) => {
        if (!id || !currentUser?.id) return;
        
        // 1. Tell everyone in the room to bail out NOW via theater channel
        try {
            const tempTheaterCh = supabase.channel(`theater_${theaterData.sessionId}`, {
                config: { broadcast: { self: false } },
            });
            tempTheaterCh.subscribe((status: string) => {
                if (status === 'SUBSCRIBED') {
                    tempTheaterCh.send({
                        type: 'broadcast',
                        event: 'state_update',
                        payload: { isPlaying: false, action: 'end' },
                    }).catch(() => {});
                    setTimeout(() => {
                        try { supabase.removeChannel(tempTheaterCh); } catch {}
                    }, 500);
                }
            });
        } catch {}

        // 2. Update local message immediately
        try {
            const { encodeTheaterMetaIntoCaption } = require('../../utils/theaterMetaCodec');
            const endedMeta = { ...theaterData, status: 'ended' };
            const updatedCaption = encodeTheaterMetaIntoCaption(endedMeta);

            void updateMessage(id as string, msgId, {
                media: {
                    type: 'theater_session',
                    caption: updatedCaption,
                    theater: endedMeta,
                },
            } as any);

            // 3. Persist to Supabase
            void supabase
                .from('messages')
                .update({ media_caption: updatedCaption })
                .eq('id', msgId)
                .then(() => {});

            // 4. Broadcast theater-ended on the chat channel
            const normalizeId = (uid: string) =>
                uid.startsWith('f00f00f0-0000-0000-0000-') ? uid : uid.toLowerCase();
            const a = normalizeId(currentUser.id);
            const b = normalizeId(id as string);
            const [first, second] = [a, b].sort();
            const chatChannelName = `chat:${first}_${second}`;

            const existingChannels = (supabase as any).getChannels?.() || [];
            const existing = existingChannels.find?.((c: any) => c.topic === `realtime:${chatChannelName}`);
            if (existing && existing.state === 'joined') {
                existing.send({
                    type: 'broadcast',
                    event: 'theater-ended',
                    payload: { messageId: msgId, chatId: id, caption: updatedCaption },
                }).catch(() => {});
            } else {
                const tempCh = supabase.channel(chatChannelName, {
                    config: { broadcast: { self: false } },
                });
                tempCh.subscribe((status: string) => {
                    if (status === 'SUBSCRIBED') {
                        tempCh.send({
                            type: 'broadcast',
                            event: 'theater-ended',
                            payload: { messageId: msgId, chatId: id, caption: updatedCaption },
                        }).catch(() => {});
                        setTimeout(() => {
                            try { supabase.removeChannel(tempCh); } catch {}
                        }, 500);
                    }
                });
            }
        } catch (err) {
            console.warn('[ChatScreen] handleTheaterEnd failed:', err);
        }
    }, [id, currentUser?.id, updateMessage]);

    const renderMessage = useCallback(({ item, index }: { item: any; index: number }) => {
        // Date separator logic (inverted list: index 0 = newest)
        const msgDate = new Date(item.timestamp);
        const nextItem = reversedMessages[index + 1]; // older message
        const showDateSeparator = nextItem && new Date(nextItem.timestamp).toDateString() !== msgDate.toDateString();

        return (
            <Animated.View
                entering={FadeInDown.springify().damping(24).stiffness(200)}
                exiting={FadeOutDown}
                layout={LinearTransition.springify().damping(24).stiffness(200)}
            >
                <MessageBubble
                    msg={item}
                    contactName={contact?.name || 'Them'}
                    isSelected={selectedContextMessage?.msg.id === item.id}
                    onLongPress={(mid: string, layout: any) => setSelectedContextMessage({ msg: item, layout })}
                    onReply={(m: any) => setReplyingTo(m)}
                    onReaction={handleReaction}
                    onDoubleTap={handleDoubleTap}
                    remoteLikePulse={remoteLikePulse?.messageId === item.id ? remoteLikePulse : null}
                    onMediaTap={handleMediaTap}
                    quotedMessage={item.replyTo ? chatMessages.find((m: any) => m.id === item.replyTo) : null}
                    selectionMode={selectionMode}
                    isChecked={selectedMessageIds.includes(item.id)}
                    onSelectToggle={handleSelectToggle}
                    isHighlighted={highlightedMessageId === item.id}
                    onQuotePress={handleQuotePress}
                    uploadProgress={uploadProgressTracker?.[item.id]}
                    onMediaDownload={handleMediaDownload}
                    onRetry={handleRetryMessage}
                    isAdmin={isAdmin}
                    senderRole={memberRoles[item.sender_id]}
                    onTheaterEnd={handleTheaterEnd}
                />

                {showDateSeparator && (
                    <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                        <View style={{
                            backgroundColor: 'rgba(255,255,255,0.08)',
                            borderRadius: 16,
                            paddingHorizontal: 14,
                            paddingVertical: 5,
                        }}>
                            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '600' }}>
                                {formatDateLabel(msgDate)}
                            </Text>
                        </View>
                    </View>
                )}
            </Animated.View>
        );
    }, [selectedContextMessage, chatMessages, contact?.name, handleReaction, handleDoubleTap, handleMediaTap, selectionMode, selectedMessageIds, handleSelectToggle, uploadProgressTracker, handleMediaDownload, handleRetryMessage, handleQuotePress, highlightedMessageId, reversedMessages, unreadIncomingIds, formatDateLabel]);

    const renderCollectionItem = useCallback(({ item, index }: { item: any, index: number }) => (
        <Pressable
            style={styles.mediaCollectionTile}
            onPress={() => {
                if (!mediaCollection) return;
                setMediaCollection(null);
                setMediaViewer({
                    messageId: mediaCollection.messageId,
                    items: mediaCollection.items,
                    index,
                });
            }}
        >
            <Image source={{ uri: item.localFileUri || item.url }} style={styles.mediaCollectionImage} contentFit="cover" transition={200} />
            {item.type === 'video' && (
                <View style={styles.mediaCollectionVideoBadge}>
                    <MaterialIcons name="play-arrow" size={18} color="#fff" />
                </View>
            )}
        </Pressable>
    ), [mediaCollection]);

    // Stable keyExtractor for FlatList - prevents inline function recreation
    const keyExtractor = useCallback((item: any) => item.id, []);


    if (!contact) {
        return (
            <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
                {isLoadingProfile ? (
                    <SoulLoader size={120} />
                ) : (
                    <Text style={styles.errorText}>Contact not found</Text>
                )}
                <Pressable onPress={handleBack} style={{ marginTop: 20, padding: 12 }}>
                    <Text style={{ color: themeAccent, fontWeight: '600' }}>Go Back</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={[styles.container, isOverlay && { backgroundColor: 'transparent' }]} pointerEvents={(isOverlay || isFocused) ? 'auto' : 'none'}>
            <StatusBar barStyle="light-content" />

            {!isOverlay || selectionMode ? (
                <>
                    <ConnectionBanner connectivity={connectivity} mode="absolute" />
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: -1 }]} />

                    {/* Standard Navigation Header (Only in non-overlay mode) */}
                    <View style={[StyleSheet.absoluteFill, { zIndex: 10 }]} pointerEvents="box-none">
                        <Animated.View
                            ref={headerPillRef}
                            onLayout={(e) => {
                                // Block layout updates during exit to prevent "jumping" or "stuttering" in the morph
                                // Using JS-safe phase check here
                                if (chatTransitionState.getPhase() !== 'returning') {
                                    setHeaderPillWidth(e.nativeEvent.layout.width);
                                }
                            }}
                            style={[
                                styles.headerPill,
                                {
                                    position: 'absolute',
                                    top: HEADER_PILL_TOP,
                                    backgroundColor: 'transparent', // Remove solid background to allow GlassView blur to show through
                                    zIndex: 10,
                                    borderWidth: 1,
                                    borderColor: 'rgba(255, 255, 255, 0.22)',
                                    overflow: 'hidden'
                                },
                                headerMorphAnimatedStyle,
                            ]}
                            pointerEvents="box-none"
                        >
                            <View style={StyleSheet.absoluteFill} pointerEvents="none">
                                <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                            </View>

                                                       {musicVisibleHere && (
                                    <View 
                                        {...headerSeekPanResponder.panHandlers}
                                        style={{ 
                                            position: 'absolute', 
                                            bottom: 0, 
                                            left: 0, 
                                            right: 0,
                                            height: 14, 
                                            backgroundColor: 'transparent',
                                            zIndex: 15,
                                            justifyContent: 'flex-end'
                                        }} 
                                    >
                                        <View 
                                            style={{ 
                                                width: '100%',
                                                height: 2, 
                                                backgroundColor: 'rgba(255,255,255,0.05)',
                                            }} 
                                            pointerEvents="none"
                                        >
                                            <View 
                                                style={{ 
                                                    width: `${musicProgress * 100}%`, 
                                                    height: '100%', 
                                                    backgroundColor: activeTheme.primary,
                                                    borderRadius: 2,
                                                    shadowColor: activeTheme.primary,
                                                    shadowOffset: { width: 0, height: 0 },
                                                    shadowOpacity: 0.8,
                                                    shadowRadius: 4,
                                                    elevation: 5
                                                }} 
                                                pointerEvents="none"
                                            />
                                        </View>
                                    </View>
                                )}

                            <View style={[styles.header, { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, height: '100%', paddingRight: 8 }]} pointerEvents="box-none">
                                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                                    <Pressable
                                        collapsable={false}
                                        style={[styles.avatarWrapper, shouldHideHeaderAvatar && styles.avatarWrapperHidden]}
                                        onPress={openProfileWithMorph}
                                    >
                                        <SoulAvatar
                                            ref={profileAvatarRef}
                                            uri={(remoteHasBetterAvatar ? remoteContact?.avatar : contact?.avatar) || contact?.avatar}
                                            localUri={contact?.localAvatarUri || remoteContact?.localAvatarUri}
                                            avatarType={contact?.avatarType as any}
                                            teddyVariant={(contact as any)?.teddyVariant}
                                            size={46}
                                            isOnline={contact?.id ? getPresence(contact.id).isOnline : false}
                                            sharedTransitionTag={ENABLE_PROFILE_AVATAR_SHARED_TRANSITION ? profileAvatarTransitionTag : undefined}
                                            sharedTransition={ENABLE_PROFILE_AVATAR_SHARED_TRANSITION ? PROFILE_AVATAR_SHARED_TRANSITION : undefined}
                                            allowExperimentalSharedTransition={ENABLE_PROFILE_AVATAR_SHARED_TRANSITION}
                                        />
                                    </Pressable>
                                    <View style={styles.headerInfo}>
                                        <Text style={styles.contactName}>{contact?.name || '...'}</Text>
                                        {isTyping ? (
                                            <Animated.View
                                                entering={FadeInDown.duration(180)}
                                                exiting={FadeOutDown.duration(140)}
                                                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                                            >
                                                <Text style={[styles.statusText, { color: activeTheme.primary }]} numberOfLines={1}>
                                                    typing
                                                </Text>
                                                <LottieView
                                                    source={TYPING_LOTTIE}
                                                    autoPlay
                                                    loop
                                                    speed={0.9}
                                                    style={{ width: 32, height: 14 }}
                                                />
                                            </Animated.View>
                                        ) : karaokeText ? (
                                            <KaraokeLine
                                                text={karaokeText}
                                                lineStart={karaokeLineStart}
                                                lineEnd={karaokeLineEnd}
                                                color={activeTheme.primary}
                                                baseColor="rgba(255,255,255,0.55)"
                                                getPlaybackPosition={getPlaybackPosition}
                                                isPlaying={!!musicState?.isPlaying}
                                            />
                                        ) : (
                                            <Text style={[styles.statusText, { color: activeTheme.primary }]} numberOfLines={1}>
                                                {musicVisibleHere
                                                    ? (musicState.currentSong.name.split('(')[0].split('-')[0].split('[')[0].replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').trim())
                                                    : 'ONLINE'
                                                }
                                            </Text>
                                        )}
                                    </View>
                                    <Animated.View style={[{ flexDirection: 'row', marginLeft: 'auto', alignItems: 'center' }, headerAccessoryAnimatedStyle]}>
                                        <PressableFlash
                                            style={[styles.headerButton, { marginRight: 8 }]}
                                            borderRadius={22}
                                            flashColor={activeTheme.primary}
                                            onPress={() => setShowMusicPlayer(true)}
                                        >
                                            <MaterialIcons name="music-note" size={20} color="#ffffff" style={{ marginLeft: -2.5 }} />
                                        </PressableFlash>

                                        {/* Placeholder for Morphing Menu (outside) */}
                                        <View style={{ width: 44, height: 44, marginRight: 2 }} />
                                    </Animated.View>
                                </View>
                            </View>
                        </Animated.View>

                        {/* Seamless Morphing Call Menu (Root Level for breakout expansion) */}
                        <Animated.View style={animatedCallMorphStyle}>
                            <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                            
                            <Pressable 
                                style={{ position: 'absolute', top: 0, right: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center', zIndex: 10 }} 
                                onPress={toggleCallMenu}
                            >
                                <MaterialIcons 
                                    name={isCallExpanded ? "close" : "call"} 
                                    size={20} 
                                    color="#ffffff" 
                                    style={!isCallExpanded ? { marginLeft: 0.8, marginTop: 0.5 } : {}} 
                                />
                            </Pressable>

                                <Animated.View style={[{ flex: 1, padding: 6, marginTop: 38 }, animatedCallContentOpacity]} pointerEvents={isCallExpanded ? 'auto' : 'none'}>
                                    <Pressable style={styles.miniCallItem} onPress={() => { handleCall('audio'); toggleCallMenu(); }}>
                                        <View style={[styles.miniCallIcon, { backgroundColor: 'rgba(34, 197, 94, 0.15)' }]}>
                                            <MaterialIcons name="call" size={18} color="#22c55e" />
                                        </View>
                                        <Text style={styles.miniCallText}>Audio Call</Text>
                                    </Pressable>
                                    <View style={styles.miniCallDivider} />
                                    <Pressable style={styles.miniCallItem} onPress={() => { handleCall('video'); toggleCallMenu(); }}>
                                        <View style={[styles.miniCallIcon, { backgroundColor: 'rgba(244, 63, 94, 0.15)' }]}>
                                            <MaterialIcons name="videocam" size={18} color="#f43f5e" />
                                        </View>
                                        <Text style={styles.miniCallText}>Video Call</Text>
                                    </Pressable>
                                </Animated.View>
                        </Animated.View>

                        {!selectionMode && (
                            <Animated.View style={[
                                {
                                    position: 'absolute',
                                    top: HEADER_PILL_TOP + (HEADER_PILL_HEIGHT - BACK_BTN_SIZE) / 2,
                                    left: 16,
                                    width: BACK_BTN_SIZE,
                                    height: BACK_BTN_SIZE,
                                    borderRadius: BACK_BTN_SIZE / 2,
                                    zIndex: 20,
                                    overflow: 'hidden',
                                    borderWidth: 1,
                                    borderColor: 'rgba(255, 255, 255, 0.22)',
                                    backgroundColor: 'transparent'
                                },
                                backButtonAnimatedStyle,
                            ]}>
                                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                                    <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                                </View>
                                <PressableFlash
                                    onPress={handleBack}
                                    borderRadius={BACK_BTN_SIZE / 2}
                                    flashColor={activeTheme.primary}
                                    style={{
                                        flex: 1,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                >
                                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                                </PressableFlash>
                            </Animated.View>
                        )}
                    </View>
                </>
            ) : null}

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? (isOverlay ? 0 : 0) : 0}
                style={{ flex: 1 }}
            >
                {/* Content Wrapper */}
                <Animated.View 
                    style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent' }, backgroundMorphAnimatedStyle as any]}
                    pointerEvents="box-none"
                >
                    <View style={StyleSheet.absoluteFill}>
                        {/* In overlay mode, let taps on the transparent upper region dismiss the keyboard
                            (the call's remote video sits behind this and stays visible through the transparency). */}
                        {isOverlay && (
                            <Pressable
                                onPress={() => {
                                    console.log('[DEBUG] Keyboard dismissed via overlay tap');
                                    Keyboard.dismiss();
                                }}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    right: 0,
                                    // Keep tap-to-dismiss only on the empty upper region so
                                    // scroll gestures on the live-chat list still reach the FlatList.
                                    height: isOverlayKeyboardVisible ? SCREEN_HEIGHT * 0.22 : SCREEN_HEIGHT * 0.52,
                                    zIndex: 0,
                                }}
                            />
                        )}
                        <View style={{ flex: 1 }}>
                            <Animated.View
                                style={[
                                    { flex: 1 },
                                    isOverlay && {
                                        paddingTop: SCREEN_HEIGHT * (isOverlayKeyboardVisible ? 0.24 : 0.60),
                                    },
                                    messagesContainerAnimatedStyle,
                                ]}
                            >
                                {isOverlay ? (
                                    <View style={{ flex: 1 }}>
                                        {isReady && (
                                            <View style={{ flex: 1 }}>
                                                <MaskedView
                                                    style={{ flex: 1 }}
                                                    maskElement={
                                                        <LinearGradient
                                                            colors={['transparent', 'white', 'white']}
                                                            locations={[0, 0.70, 1]}
                                                            style={StyleSheet.absoluteFill}
                                                        />
                                                    }
                                                >
                                                    <Animated.FlatList
                                                        ref={flatListRef as any}
                                                        data={reversedMessages}
                                                        keyExtractor={keyExtractor}
                                                        inverted={true}
                                                        renderItem={renderMessage}
                                                        style={styles.messagesList}
                                                        contentContainerStyle={[
                                                            styles.messagesContent,
                                                            styles.overlayMessagesContent,
                                                            isOverlayKeyboardVisible && styles.overlayMessagesContentKeyboard,
                                                        ]}
                                                        showsVerticalScrollIndicator={false}
                                                        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                                                        scrollEventThrottle={16}
                                                        keyboardShouldPersistTaps="handled"
                                                        keyboardDismissMode="on-drag"
                                                        ListHeaderComponent={<TypingBubble visible={isTyping} />}
                                                        ListEmptyComponent={
                                                            <View style={styles.emptyChat}>
                                                                <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.1)" />
                                                                <Text style={styles.emptyChatText}>No messages yet</Text>
                                                            </View>
                                                        }
                                                    />
                                                </MaskedView>
                                            </View>
                                        )}
                                    </View>
                                ) : (
                                    <View style={{ flex: 1 }}>
                                        {isReady && (
                                            <Animated.FlatList
                                                ref={flatListRef as any}
                                                data={reversedMessages}
                                                keyExtractor={keyExtractor}
                                                inverted={true}
                                                renderItem={renderMessage}
                                                style={styles.messagesList}
                                                contentContainerStyle={styles.messagesContent}
                                                showsVerticalScrollIndicator={false}
                                                maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                                                scrollEventThrottle={16}
                                                keyboardShouldPersistTaps="handled"
                                                keyboardDismissMode="on-drag"
                                                ListHeaderComponent={<TypingBubble visible={isTyping} />}
                                                ListEmptyComponent={
                                                    <View style={styles.emptyChat}>
                                                        <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.1)" />
                                                        <Text style={styles.emptyChatText}>No messages yet</Text>
                                                    </View>
                                                }
                                            />
                                        )}
                                    </View>
                                )}

                            {!isOverlay && (
                                <ProgressiveBlur
                                    position="top"
                                    height={160}
                                    intensity={60}
                                    maxAlpha={0.85}
                                />
                            )}
                            <ProgressiveBlur position="bottom" height={160} intensity={80} />
                        </Animated.View>

                        {/* Input Area Row — Shared ChatComposer (also used by TheaterChatOverlay) */}
                        <Animated.View style={[styles.inputArea, inputAreaAnimatedStyle]}>
                            <ChatComposer
                                ref={composerRef}
                                messageKey={messageKey}
                                accent={themeAccent}
                                accentSoft={themeAccentSoft}
                                contactName={contact?.name}
                                replyingTo={replyingTo}
                                onClearReply={() => setReplyingTo(null)}
                                editingMessage={editingMessage}
                                onClearEdit={() => setEditingMessage(null)}
                                onSaveEdit={(content) => {
                                    const nextMedia = editingMessage?.media
                                        ? { ...editingMessage.media, caption: content || undefined }
                                        : undefined;
                                    updateMessage(id as string, editingMessage.id, {
                                        text: content,
                                        media: nextMedia as any,
                                    });
                                    setEditingMessage(null);
                                }}
                                onAfterSend={() => {
                                    if (isOverlay) {
                                        requestAnimationFrame(() => {
                                            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
                                        });
                                    }
                                }}
                                isOtherTyping={isTyping}
                            />
                        </Animated.View>
                    </View>
                </View>
            </Animated.View>
            </KeyboardAvoidingView>

            {/* Root-level Close Button for Overlay — Top Priority */}
            {isOverlay && (
                <View style={{ position: 'absolute', top: Math.max(insets.top, 20), right: 20, zIndex: 100000 }} pointerEvents="auto">
                    <Pressable 
                        onPress={() => {
                            Keyboard.dismiss();
                            onBack?.();
                        }} 
                        hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }}
                    >
                        <MaterialIcons name="close" size={24} color="white" />
                    </Pressable>
                </View>
            )}

            {/* Reaction Modal */}
            <MessageContextMenu
                visible={!!selectedContextMessage}
                msg={selectedContextMessage?.msg}
                layout={selectedContextMessage?.layout}
                onClose={() => setSelectedContextMessage(null)}
                onReaction={handleReaction}
                onAction={handleAction}
                chatMessages={chatMessages}
                contactName={contact?.name || 'Them'}
                isAdmin={isAdmin}
            />

            {/* Call Options Dropdown */}






            {/* MediaPickerSheet + MediaPreviewModal now rendered inside ChatComposer */}

            {/* Media Collection Modal */}
            <Modal
                visible={!!mediaCollection}
                transparent
                animationType="fade"
                onRequestClose={() => setMediaCollection(null)}
            >
                <View style={styles.mediaCollectionOverlay}>
                    <View style={styles.mediaCollectionHeader}>
                        <Text style={styles.mediaCollectionTitle}>Media</Text>
                        <Pressable onPress={() => setMediaCollection(null)} style={styles.mediaCollectionCloseBtn}>
                            <MaterialIcons name="close" size={22} color="#fff" />
                        </Pressable>
                    </View>

                    <FlatList
                        data={mediaCollection?.items || []}
                        keyExtractor={(item, index) => `${item.url}-${index}`}
                        numColumns={3}
                        contentContainerStyle={styles.mediaCollectionGrid}
                        renderItem={renderCollectionItem}
                    />

                    {!!mediaCollection?.messageId && (
                        <View style={styles.mediaCollectionReactionBar}>
                            {['❤️', '🔥', '😂'].map(emoji => (
                                <Pressable
                                    key={emoji}
                                    style={styles.mediaCollectionReactionBtn}
                                    onPress={() => handleReactAllMedia(mediaCollection.messageId, emoji)}
                                >
                                    <Text style={styles.mediaCollectionReactionText}>{emoji}</Text>
                                </Pressable>
                            ))}
                        </View>
                    )}
                </View>
            </Modal>

            {/* Single Media Viewer (Old Removed) */}

            {/* Premium Media Viewer (Seamless Morph & Blur) */}
            <EnhancedMediaViewer
                visible={!!mediaViewer}
                isStatus={false}
                media={mediaViewer && mediaViewer.items && typeof mediaViewer.index === 'number' 
                    ? mediaViewer.items[mediaViewer.index] as any 
                    : null}
                sourceLayout={selectedMediaLayout}
                userInfo={(() => {
                    if (!mediaViewer) return undefined;
                    const msg = chatMessages.find((m: any) => m.id === mediaViewer.messageId);
                    if (!msg) return { name: 'You', timestamp: 'Just now' };

                    const isMe = msg.sender === 'me';

                    // Robust timestamp parsing
                    let formattedTime = 'Just now';
                    if (msg.timestamp) {
                        try {
                            const date = new Date(msg.timestamp);
                            if (!isNaN(date.getTime())) {
                                formattedTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            }
                        } catch (e) {
                            console.error('Error parsing date:', e);
                        }
                    }

                    return {
                        name: isMe ? 'You' : (contact?.name || 'Contact'),
                        avatar: isMe ? currentUser?.avatar : contact?.avatar,
                        timestamp: formattedTime
                    };
                })()}
                onClose={() => {
                    setMediaViewer(null);
                    setSelectedMediaLayout(null);
                }}
                onSendComment={(comment) => {
                    if (id && comment.trim()) {
                        sendChatMessage(messageKey, comment);
                    }
                }}
                onDownload={handleSaveCurrentMedia}
                onReply={() => {
                    if (mediaViewer) {
                        const msg = chatMessages.find((m: any) => m.id === mediaViewer.messageId);
                        setEditingMessage(null);
                        if (msg) setReplyingTo(msg);
                        setMediaViewer(null);
                        setSelectedMediaLayout(null);
                    }
                }}
                onForward={() => {
                    showSoulAlert('Coming Soon', 'Forwarding will be available soon.');
                }}
                onReaction={(emoji) => {
                    if (mediaViewer && id) {
                        addReaction(id, mediaViewer.messageId, emoji);
                    }
                }}
                onEdit={() => {
                    if (!mediaViewer) return;
                    const msg = chatMessages.find((m: any) => m.id === mediaViewer.messageId);
                    if (!msg || msg.sender !== 'me') return;
                    setReplyingTo(null);
                    setEditingMessage(msg as any);
                    setMediaViewer(null);
                    setSelectedMediaLayout(null);
                }}
                onShare={() => showSoulAlert('Share', 'External sharing will be available soon.')}
            />

            {/* Music Player Overlay - Moved to root for z-index and blur reliability */}
            <MusicPlayerOverlay
                isOpen={showMusicPlayer}
                onClose={() => setShowMusicPlayer(false)}
                contactName={contact?.name || 'Someone'}
                chatId={rawId}
            />

            <GlassAlert
                visible={alertConfig.visible}
                title={alertConfig.title}
                message={alertConfig.message}
                buttons={alertConfig.buttons}
                onClose={closeSoulAlert}
            />

            {/* Music invite banner — slides in below header pill when partner starts playing */}
            {pendingMusicInvite && (
                <Animated.View
                    style={[
                        styles.musicInviteWrap,
                        { top: HEADER_PILL_TOP + HEADER_PILL_HEIGHT + 8 },
                    ]}
                    pointerEvents="box-none"
                >
                    <MusicInviteBanner
                        key={pendingMusicInvite.song.id}
                        invite={pendingMusicInvite}
                        accent={activeTheme?.primary || '#BC002A'}
                        contactName={contact?.name || 'Your friend'}
                        onAccept={acceptMusicInvite}
                        onDecline={declineMusicInvite}
                    />
                </Animated.View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    headerWrapper: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 999,
        pointerEvents: 'box-none',
    },
    headerPill: {
        height: HEADER_PILL_HEIGHT,
        borderRadius: HEADER_PILL_RADIUS,
        backgroundColor: 'transparent',
        overflow: 'hidden',
        right: 24,
    },
    headerGlass: {
        borderRadius: HEADER_PILL_RADIUS,
        overflow: 'hidden',
        backgroundColor: 'transparent',
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.22)',
    },
    header: {
        flex: 1,
        backgroundColor: 'transparent',
        paddingLeft: 8,
        paddingRight: 10,
        flexDirection: 'row',
        alignItems: 'center',
        // gap: 14,
    },
    backButton: {
        padding: 4,
    },
    avatarWrapper: {
        position: 'relative',
    },
    avatarWrapperHidden: {
        opacity: 0,
    },
    avatar: {
        width: 46,
        height: 46,
        borderRadius: 23,
        borderWidth: 0,
    },
    onlineIndicator: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 14,
        height: 14,
        borderRadius: 7,
        backgroundColor: '#22c55e',
    },
    headerInfo: {
        flex: 1,
        minWidth: 0,
        marginLeft: 10,
        justifyContent: 'center',
        overflow: 'hidden',
    },
    contactName: {
        color: '#ffffff',
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: 0.5,
        marginBottom: 2,
    },
    statusText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 8.5,
        fontWeight: '600',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
    },
    headerButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    messagesList: {
        flex: 1,
    },
    messagesContent: {
        paddingHorizontal: 16,
        paddingTop: 110, // Visually paddingBottom due to inverted
        paddingBottom: 100, // Visually paddingTop due to inverted
        flexGrow: 1,
    },
    overlayMessagesContent: {
        // Inverted list: paddingTop is the visual bottom spacer above the composer.
        // Keep the room here so the user can still scroll naturally like the normal chat.
        paddingTop: 156,
        paddingBottom: 24,
    },
    overlayMessagesContentKeyboard: {
        paddingTop: 88,
        paddingBottom: 12,
    },
    emptyChat: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 100,
    },
    emptyChatText: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 16,
        fontWeight: '600',
        marginTop: 16,
    },
    stickyDateHeaderContainer: {
        position: 'absolute',
        top: 140, // Below header
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 80,
    },
    stickyDateBubble: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
    },
    stickyDateText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    emptyChatHint: {
        color: 'rgba(255,255,255,0.2)',
        fontSize: 13,
        marginTop: 4,
    },
    typingContainer: {
        paddingHorizontal: 20,
        paddingBottom: 10,
        alignItems: 'flex-start' as const,
    },
    typingIndicatorWrapper: {
        position: 'absolute',
        bottom: 85,
        left: 20,
        zIndex: 100,
    },
    typingBubbleMini: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 999,
        width: 48,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    typingLottie: {
        width: 40,
        height: 40,
    },
    typingBubble: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopLeftRadius: 4,
    },
    replyPreview: {
        marginBottom: 8,
        borderRadius: 16,
        padding: 12,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        overflow: 'hidden',
        width: '100%',
        alignSelf: 'center',
    },
    replyContent: {
        flexDirection: 'row',
        // gap: 10,
        flex: 1,
    },
    replyTextContainer: {
        flex: 1,
    },
    replySender: {
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 2,
    },
    replyText: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.5)',
    },
    replyThumbnail: {
        width: 44,
        height: 44,
        borderRadius: 6,
        marginLeft: 10,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    inputArea: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Platform.OS === 'ios' ? 24 : 16,
        backgroundColor: 'transparent',
        zIndex: 60,
    },
    inputAreaRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        // gap: 8,
    },
    unifiedPillContainer: {
        flex: 1,
        backgroundColor: 'transparent',
        borderRadius: 24,
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        overflow: 'hidden',
        minHeight: 44,
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 4,
        minHeight: 44,
        maxHeight: 120,
    },
    attachButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        flexShrink: 0,
        marginBottom: 0,
        marginRight: 6,
        overflow: 'hidden',
    },
    input: {
        flex: 1,
        color: '#ffffff',
        fontSize: 14,
        paddingVertical: 0,
        paddingHorizontal: 8,
        fontWeight: '300',
    },
    sendButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        flexShrink: 0,
        overflow: 'hidden',
        marginLeft: 6,
    },
    sendButtonActive: {
        // Handled via inline themeAccent for dynamic switching
    },
    errorText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
    headerScrollBlur: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 140,
        zIndex: 90,
    },
    bottomScrollBlur: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 140,
        zIndex: 50,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    callDropdown: {
        position: 'absolute',
        width: 160,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        backgroundColor: 'rgba(15, 15, 20, 0.4)',
    },
    callDropdownContent: {
        borderRadius: 16,
        overflow: 'hidden',
    },
    callDropdownItem: {
        flexDirection: 'row',
        alignItems: 'center',
        // gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
    },
    callDropdownIcon: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    callDropdownText: {
        color: '#ffffff',
        fontSize: 14,
        fontWeight: '600',
        marginLeft: 12,
    },
    callDropdownDivider: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.08)',
        marginHorizontal: 16,
    },
    mediaCollectionOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.95)',
        paddingTop: 56,
    },
    mediaCollectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 14,
    },
    mediaCollectionTitle: {
        color: '#fff',
        fontSize: 18,
        fontWeight: '700',
    },
    mediaCollectionCloseBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    mediaCollectionGrid: {
        paddingHorizontal: 10,
        paddingBottom: 20,
    },
    mediaCollectionTile: {
        width: (SCREEN_WIDTH - 20) / 3,
        aspectRatio: 1,
        padding: 2,
    },
    mediaCollectionImage: {
        width: '100%',
        height: '100%',
        borderRadius: 6,
    },
    mediaCollectionVideoBadge: {
        position: 'absolute',
        bottom: 8,
        right: 8,
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    mediaCollectionReactionBar: {
        flexDirection: 'row',
        justifyContent: 'center',
        // gap: 12,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
    },
    mediaCollectionReactionBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    mediaCollectionReactionText: {
        fontSize: 20,
    },
    mediaViewerContainer: {
        flex: 1,
        backgroundColor: '#000',
        justifyContent: 'center',
    },
    mediaViewerCloseBtn: {
        position: 'absolute',
        top: 50,
        left: 16,
        zIndex: 3,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    mediaViewerSaveBtn: {
        position: 'absolute',
        top: 50,
        right: 16,
        zIndex: 3,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    mediaViewerMedia: {
        width: '100%',
        height: '100%',
    },
    mediaViewerBottom: {
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 28,
    },
    mediaViewerReactionsRow: {
        flexDirection: 'row',
        // gap: 10,
    },
    mediaViewerReactionBtn: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.14)',
    },
    mediaViewerReactionText: {
        fontSize: 20,
    },
    mediaViewerReactionList: {
        marginTop: 8,
        color: 'rgba(255,255,255,0.85)',
        fontSize: 14,
    },
    nowPlayingStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        // gap: 4,
    },
    morphingMenuContainer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        backgroundColor: 'transparent',
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.15)',
        overflow: 'hidden',
    },
    morphingInnerContent: {
        flex: 1,
        flexDirection: 'column-reverse',
    },
    persistentToggleArea: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    menuItemsList: {
        padding: 6,
        paddingBottom: 10,
        flex: 1,
    },
    optionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    optionIcon: {
        width: 34,
        height: 34,
        borderRadius: 17,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 14,
    },
    optionText: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '500',
        letterSpacing: -0.2,
    },
    optionDivider: {
        height: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        marginLeft: 56,
        marginRight: 10,
    },
    inputWrapperHidden: {
        opacity: 0,
    },
    recordingIndicator: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 8,
    },
    deleteIconWrap: {
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
        marginRight: 6,
    },
    recordingTimer: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
        width: 45,
    },
    siriWaveWrap: {
        width: 200,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 20,
        overflow: 'hidden',
        shadowOpacity: 0.55,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 0 },
    },
    cancelHintChevron: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        marginLeft: 2,
    },
    recordingMicIconWrap: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
    },
    musicInviteWrap: {
        position: 'absolute',
        left: 16,
        right: 16,
        zIndex: 1100,
    },
    searchBarWrap: {
        position: 'absolute',
        top: HEADER_PILL_TOP + HEADER_PILL_HEIGHT + 10,
        left: 16,
        right: 16,
        zIndex: 999,
    },
    searchBar: {
        minHeight: 42,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        // gap: 6,
    },
    searchInput: {
        flex: 1,
        color: '#fff',
        fontSize: 14,
        paddingVertical: 8,
    },
    searchCount: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 11,
    },
    searchNavBtn: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    starredOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    starredPanel: {
        width: '100%',
        maxHeight: '70%',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        padding: 14,
    },
    starredHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
    },
    starredTitle: {
        color: '#fff',
        fontSize: 17,
        fontWeight: '700',
    },
    starredEmpty: {
        color: 'rgba(255,255,255,0.6)',
        textAlign: 'center',
        marginTop: 20,
    },
    starredItem: {
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.08)',
    },
    starredText: {
        color: '#fff',
        fontSize: 14,
        marginBottom: 4,
    },
    starredTime: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 11,
    },
    miniCallItem: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12 },
    miniCallIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    miniCallText: { color: 'white', fontSize: 15, fontWeight: '700' },
    miniCallDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 8 },
});
