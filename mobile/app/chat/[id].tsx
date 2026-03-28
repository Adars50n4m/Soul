import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
// Force re-bundle: 2026-03-10T21:48:59+05:30
import * as ImageManipulator from 'expo-image-manipulator';
import {
    View, Text, TextInput, Pressable,
    StyleSheet, StatusBar, Platform,
    Modal, Animated as RNAnimated, Dimensions, Keyboard, KeyboardEvent, Alert, InteractionManager, ScrollView, FlatList,
    Image as RNImage
} from 'react-native';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';

import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import GlassView from '../../components/ui/GlassView';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as DocumentPicker from 'expo-document-picker';
import { offlineService } from '../../services/LocalDBService';
import VoiceNotePlayer from '../../components/chat/VoiceNotePlayer';
import ProgressiveBlur from '../../components/chat/ProgressiveBlur';
import MessageBubble from '../../components/chat/MessageBubble';
import MessageContextMenu from '../../components/chat/MessageContextMenu';
import { ChatStyles, SCREEN_WIDTH, SCREEN_HEIGHT, HEADER_PILL_HEIGHT, HEADER_PILL_RADIUS } from '../../components/chat/ChatStyles';
import { formatDuration } from '../../utils/formatters';
import { getMessageMediaItems, sanitizeSongTitle } from '../../utils/chatUtils';



import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withDelay,
    withRepeat,
    withSequence,
    SharedTransition,
    interpolate,
    interpolateColor,
    Extrapolation,
    Easing,
    FadeInDown,
    FadeOutDown,
} from 'react-native-reanimated';
import 'react-native-gesture-handler';

import { useApp, USERS } from '../../context/AppContext';
import { usePresence } from '../../context/PresenceContext';
import { LEGACY_TO_UUID } from '../../config/supabase';
import { SoulAvatar } from '../../components/SoulAvatar';
import { chatService } from '../../services/ChatService';
import { chatTransitionState } from '../../services/chatTransitionState';
import { MusicPlayerOverlay } from '../../components/MusicPlayerOverlay';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { storageService } from '../../services/StorageService';
import { EnhancedMediaViewer } from '../../components/EnhancedMediaViewer';
import { Contact, Message } from '../../types';
import { ResizeMode, Video, Audio } from 'expo-av';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';

const IS_IOS = Platform.OS === 'ios';
const ENABLE_SHARED_TRANSITIONS = true;
const ENABLE_INNER_SHARED_TRANSITIONS = true;
const IOS_KEYBOARD_SAFE_ADJUST = 0; 
const HEADER_PILL_TOP = 62;
const LIST_PILL_HEIGHT = 72;
const LIST_PILL_RADIUS = 36;
const MORPH_IN_OUT_DURATION = 520;
const MORPH_OUT_HANDOFF = Math.round(MORPH_IN_OUT_DURATION * 0.82);

const morphTransition = SharedTransition.custom((values) => {
    'worklet';
    return {
        width: withSpring(values.targetWidth, { damping: 15, stiffness: 150 }),
        height: withSpring(values.targetHeight, { damping: 15, stiffness: 150 }),
        originX: withSpring(values.targetOriginX, { damping: 15, stiffness: 150 }),
        originY: withSpring(values.targetOriginY, { damping: 15, stiffness: 150 }),
        borderRadius: withSpring(values.targetBorderRadius, { damping: 15, stiffness: 150 }),
    };
});

type ChatMediaItem = {
    url: string;
    type: 'image' | 'video' | 'audio' | 'file';
    caption?: string;
    name?: string;
};

interface SingleChatScreenProps {
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

const TypingDots = () => {
    const dot1 = useMemo(() => new RNAnimated.Value(0.35), []);
    const dot2 = useMemo(() => new RNAnimated.Value(0.35), []);
    const dot3 = useMemo(() => new RNAnimated.Value(0.35), []);

    useEffect(() => {
        const createLoop = (value: RNAnimated.Value, delay: number) =>
            RNAnimated.loop(
                RNAnimated.sequence([
                    RNAnimated.delay(delay),
                    RNAnimated.timing(value, {
                        toValue: 1,
                        duration: 380,
                        useNativeDriver: true,
                    }),
                    RNAnimated.timing(value, {
                        toValue: 0.35,
                        duration: 380,
                        useNativeDriver: true,
                    }),
                ])
            );
        const animations = [
            createLoop(dot1, 0),
            createLoop(dot2, 140),
            createLoop(dot3, 280),
        ];
        animations.forEach((animation) => animation.start());
        return () => {
            animations.forEach((animation) => animation.stop());
            dot1.stopAnimation();
            dot2.stopAnimation();
            dot3.stopAnimation();
        };
    }, [dot1, dot2, dot3]);

    return (
        <View style={styles.typingAnimationWrap}>
            {[
                { key: 'dot-1', value: dot1 },
                { key: 'dot-2', value: dot2 },
                { key: 'dot-3', value: dot3 },
            ].map(({ key, value }) => (
                <RNAnimated.View
                    key={key}
                    style={[
                        styles.typingDot,
                        {
                            opacity: value,
                            transform: [
                                {
                                    scale: value.interpolate({
                                        inputRange: [0.35, 1],
                                        outputRange: [0.92, 1.15],
                                    }),
                                },
                            ],
                        },
                    ]}
                />
            ))}
        </View>
    );
};

const SiriWaveform = ({ level, active }: { level: number; active: boolean }) => {
    const [phase, setPhase] = useState(0);
    const width = 200;
    const height = 40;
    const centerY = height / 2;

    useEffect(() => {
        if (!active) return;
        const id = setInterval(() => {
            setPhase((prev) => prev + 0.28);
        }, 40);
        return () => clearInterval(id);
    }, [active]);

    const clampedLevel = Math.max(0, Math.min(1, level));
    const amplitude = 4 + clampedLevel * 14;

    const buildWavePath = (phaseOffset: number, ampFactor: number, freq: number) => {
        const step = 5;
        let path = `M 0 ${centerY}`;
        for (let x = 0; x <= width; x += step) {
            const theta = (x / width) * Math.PI * 2 * freq + phase + phaseOffset;
            const theta2 = (x / width) * Math.PI * 2 * (freq * 1.7) + phase * 0.7 + phaseOffset;
            const y = centerY + Math.sin(theta) * amplitude * ampFactor + Math.sin(theta2) * amplitude * 0.2;
            path += ` L ${x} ${y}`;
        }
        return path;
    };

    const mainPath = buildWavePath(0, 1, 1.4);
    const secondPath = buildWavePath(1.2, 0.72, 1.1);
    const thirdPath = buildWavePath(2.1, 0.48, 0.85);

    return (
        <View style={styles.siriWaveWrap}>
            <Svg width={width} height={height}>
                <Defs>
                    <SvgLinearGradient id="siriGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <Stop offset="0%" stopColor="#FF6A88" stopOpacity="0" />
                        <Stop offset="10%" stopColor="#FF6A88" stopOpacity="0.58" />
                        <Stop offset="50%" stopColor="#FF1E56" stopOpacity="1" />
                        <Stop offset="90%" stopColor="#BC002A" stopOpacity="0.58" />
                        <Stop offset="100%" stopColor="#BC002A" stopOpacity="0" />
                    </SvgLinearGradient>
                </Defs>
                <Path d={thirdPath} fill="none" stroke="url(#siriGradient)" strokeWidth={3} opacity={0.28} />
                <Path d={secondPath} fill="none" stroke="url(#siriGradient)" strokeWidth={4} opacity={0.5} />
                <Path d={mainPath} fill="none" stroke="url(#siriGradient)" strokeWidth={5} opacity={0.95} />
            </Svg>
        </View>
    );
};

export default function SingleChatScreen({ user: propsUser, onBack, onBackStart, sourceY: propsSourceY }: SingleChatScreenProps) {
    const { id: paramsId, sourceY: paramsSourceY } = useLocalSearchParams();

    // Support both direct routing (params) and inline rendering (props)
    const rawId = propsUser?.id || (Array.isArray(paramsId) ? paramsId[0] : paramsId);
    // Standardize to UUID if legacy ID is used
    const sourceY = propsSourceY ?? (paramsSourceY ? Number(Array.isArray(paramsSourceY) ? paramsSourceY[0] : paramsSourceY) : undefined);
    const id = (rawId && LEGACY_TO_UUID[rawId as string]) || rawId;
    const stringId = Array.isArray(paramsId) ? paramsId[0] : paramsId;
    const isMorphEntry = sourceY !== undefined;
    
    const router = useRouter();
    const isFocused = useIsFocused();
    const { contacts, messages, sendChatMessage, startCall, activeCall, updateMessage, addReaction, deleteMessage, musicState, currentUser, activeTheme, sendTyping, typingUsers, uploadProgressTracker, connectivity, initializeChatSession, cleanupChatSession, fetchOtherUserProfile } = useApp() as any;
    const { getPresence } = usePresence();
    const [inputText, setInputText] = useState('');
    const [showCallModal, setShowCallModal] = useState(false);
    const [isReady, setIsReady] = useState(false);



    // Defer heavy rendering until transition completes
    useEffect(() => {
        const timeout = setTimeout(() => {
            setIsReady(true);
        }, 400); // Slightly longer for stability
        
        const task = InteractionManager.runAfterInteractions(() => {
            setIsReady(true);
        });
        
        return () => {
             task.cancel();
             clearTimeout(timeout);
        };
    }, []);

    const [callOptionsPosition, setCallOptionsPosition] = useState({ x: 0, y: 0 });
    const [isExpanded, setIsExpanded] = useState(false);

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

    const inputAreaAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -keyboardOffset.value }],
    }));

    const messagesContainerAnimatedStyle = useAnimatedStyle(() => ({
        paddingBottom: keyboardOffset.value,
    }));

    const headerAccessoryAnimatedStyle = useAnimatedStyle(() => ({
        opacity: headerAccessoryOpacity.value,
    }));

    const backgroundMorphAnimatedStyle = useAnimatedStyle(() => ({
        opacity: interpolate(
            backgroundMorphProgress.value,
            [0, 1],
            [0, 1],
            Extrapolation.CLAMP
        ),
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

    const headerMorphAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: headerPillOffsetY.value }],
        height: interpolate(
            headerPillProgress.value,
            [0, 1],
            [LIST_PILL_HEIGHT, HEADER_PILL_HEIGHT],
            Extrapolation.CLAMP
        ),
        borderRadius: interpolate(
            headerPillProgress.value,
            [0, 1],
            [LIST_PILL_RADIUS, HEADER_PILL_RADIUS],
            Extrapolation.CLAMP
        ),
    }));

    useEffect(() => {
        if (isMorphEntry) {
            headerPillOffsetY.value = withTiming(0, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.22, 1, 0.36, 1),
            });
            headerPillProgress.value = withTiming(1, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.22, 1, 0.36, 1),
            });
            backgroundMorphProgress.value = withTiming(1, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.22, 1, 0.36, 1),
            });
            headerAccessoryOpacity.value = withDelay(
                180,
                withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) })
            );
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
            const rawHeight = event.endCoordinates?.height || 0;
            const height = IS_IOS
                ? Math.max(0, rawHeight - keyboardOffset.value)
                : rawHeight;
            const duration = event.duration || 250;
            keyboardOffset.value = withTiming(height, { duration });
        };

        const onHide = () => {
            keyboardOffset.value = withTiming(0, { duration: 200 });
        };

        const showSub = Keyboard.addListener(showEvent, onShow);
        const hideSub = Keyboard.addListener(hideEvent, onHide);

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, [keyboardOffset]);

    const navigation = useNavigation();

    // Cleanup when back morph finishes
    const finishBack = useCallback(() => {
        if (onBack) {
            onBack();
        } else if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            console.warn('Navigation: Cannot go back, history stack is empty.');
        }
    }, [onBack, navigation]);

    const [replyingTo, setReplyingTo] = useState<any>(null);
    const [selectedContextMessage, setSelectedContextMessage] = useState<{ msg: any, layout: any } | null>(null);
    const [showMusicPlayer, setShowMusicPlayer] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
    const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
	
    const isNavigatingRef = useRef(false);

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
        setShowMediaPicker(false);
        setMediaPreview(null);
        setMediaCollection(null);
        setMediaViewer(null);

        // OUT = reverse of IN (same easing + same duration + same path).
        if (isMorphEntry && sourceY !== undefined) {
            chatTransitionState.setPhase('returning');
            headerAccessoryOpacity.value = withTiming(0, { duration: 120 });
            backgroundMorphProgress.value = withTiming(0, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.22, 1, 0.36, 1),
            });
            headerPillOffsetY.value = withTiming(Math.max(0, sourceY - HEADER_PILL_TOP), {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.22, 1, 0.36, 1),
            });
            headerPillProgress.value = withTiming(0, {
                duration: MORPH_IN_OUT_DURATION,
                easing: Easing.bezier(0.22, 1, 0.36, 1),
            });
            // Small handoff delay keeps the return motion closer to the
            // entry feel without changing the pill animation itself.
            setTimeout(() => finishBack(), MORPH_OUT_HANDOFF);
            return;
        }
        chatTransitionState.setPhase('returning');
        headerAccessoryOpacity.value = withTiming(0, { duration: 180 });
        requestAnimationFrame(() => {
            finishBack();
        });
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
                setShowMediaPicker(false);
                setMediaPreview(null);
                setMediaCollection(null);
                setMediaViewer(null);
                setSelectionMode(false);
                setSelectedMessageIds([]);
            };
        }, [])
    );

    // Animation Values
    const plusRotation = useSharedValue(0);
    const optionsHeight = useSharedValue(0);
    const optionsOpacity = useSharedValue(0);
    const modalAnim = useRef(new RNAnimated.Value(0)).current;

    // Refs
    const flatListRef = useRef<any>(null);
    const hasScrolledInitial = useRef(false);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    // Derived State
    const contact = useMemo(() => {
        const found = contacts.find(c => c.id === id);
        if (found) return found;
        
        // Fallback for legacy ID navigation
        const legacyMappedUuid = id ? (USERS[id]?.id) : null;
        if (legacyMappedUuid) {
            console.log(`[Chat] Resolving legacy ID ${id} to UUID ${legacyMappedUuid}`);
            return contacts.find(c => c.id === legacyMappedUuid);
        }
        return undefined;
    }, [contacts, id]);

    // FIX: Use contact.id (UUID) for message lookup, not the raw id param
    const messageKey = contact?.id || id || '';
    const chatMessages = messages[messageKey] || [];
    // Memoize reversed messages to avoid expensive array operations in render
    const reversedMessages = useMemo(() => [...chatMessages].reverse(), [chatMessages]);
    const isTyping = contact ? typingUsers.includes(contact.id) : false;

    useEffect(() => {
        if (!isFocused || !currentUser?.id || !id) {
            return;
        }

        initializeChatSession?.(id);
        fetchOtherUserProfile?.(id);

        return () => {
            cleanupChatSession?.(id);
        };
    }, [cleanupChatSession, id, currentUser?.id, initializeChatSession, fetchOtherUserProfile, isFocused]);

    // Mark incoming messages as read when chat is open
    useEffect(() => {
        const unreadIds = chatMessages
            .filter(m => m.sender === 'them' && m.status !== 'read')
            .map(m => m.id);
        if (unreadIds.length > 0) {
            chatService.markMessagesAsRead(unreadIds);
        }
    }, [chatMessages]);

    // Toggle inline sharing options above the composer
    const toggleOptions = () => {
        const nextExpanded = !isExpanded;
        setIsExpanded(nextExpanded);
        plusRotation.value = withTiming(nextExpanded ? 45 : 0, {
            duration: 220,
            easing: Easing.out(Easing.cubic),
        });
        optionsHeight.value = withTiming(nextExpanded ? 92 : 0, {
            duration: 240,
            easing: Easing.out(Easing.cubic),
        });
        optionsOpacity.value = withTiming(nextExpanded ? 1 : 0, {
            duration: nextExpanded ? 180 : 120,
            easing: Easing.out(Easing.cubic),
        });
    };

    // Close options when typing
    const handleFocus = () => {
        if (isExpanded) {
            toggleOptions();
        }
    };

    const animatedPlusStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${plusRotation.value}deg` }]
    }));

    const animatedOptionsStyle = useAnimatedStyle(() => ({
        height: optionsHeight.value,
        opacity: optionsOpacity.value,
        marginBottom: isExpanded ? 20 : 0
    }));

    const callButtonRef = useRef<View>(null);

    // Media picker state
    const [showMediaPicker, setShowMediaPicker] = useState(false);
    const [mediaPreview, setMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' | 'file'; name?: string }[] | null>(null);
    const [mediaCollection, setMediaCollection] = useState<{ messageId: string; items: ChatMediaItem[]; startIndex: number } | null>(null);
    const [mediaViewer, setMediaViewer] = useState<{ messageId: string; items: ChatMediaItem[]; index: number } | null>(null);
    const [selectedMediaLayout, setSelectedMediaLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [mediaItemReactions, setMediaItemReactions] = useState<Record<string, string[]>>({});
    const [isUploading, setIsUploading] = useState(false);

    // Recording State
    const recordingRef = useRef<Audio.Recording | null>(null);
    const isPreparingRecordingRef = useRef(false);
    const isStoppingRecordingRef = useRef(false);
    const pendingStopAfterPrepareRef = useRef<null | { shouldSend: boolean }>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const [recordingLevel, setRecordingLevel] = useState(0.08);
    const [isRecordingCancelled, setIsRecordingCancelled] = useState(false);
    const recordingTranslateX = useSharedValue(0);
    const touchStartXRef = useRef(0);
    const cancelHapticJSRef = useRef(false);

    const startRecording = async () => {
        if (isPreparingRecordingRef.current || isStoppingRecordingRef.current) {
            return;
        }
        isPreparingRecordingRef.current = true;
        pendingStopAfterPrepareRef.current = null;
        try {
            // Force-cleanup any lingering recording to avoid "Only one Recording" error
            if (recordingRef.current) {
                try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
                recordingRef.current = null;
            }
            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
                recordingTimerRef.current = null;
            }
            setIsRecording(false);

            const permission = await Audio.requestPermissionsAsync();
            if (permission.status !== 'granted') {
                Alert.alert('Permission required', 'Please enable microphone access to record voice notes.');
                isPreparingRecordingRef.current = false;
                return;
            }

            // Reset audio mode first to release any previous recording resources
            try {
                await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
            } catch {}

            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
            });

            const { recording } = await Audio.Recording.createAsync({
                ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
                isMeteringEnabled: true,
            } as any);
            recordingRef.current = recording;
            setIsRecording(true);
            setIsRecordingCancelled(false);
            setRecordingDuration(0);
            setRecordingLevel(0.08);
            recordingTranslateX.value = 0;

            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

            recordingTimerRef.current = setInterval(() => {
                setRecordingDuration(prev => prev + 1);
            }, 1000) as unknown as NodeJS.Timeout;
            recording.setProgressUpdateInterval(90);
            recording.setOnRecordingStatusUpdate((status: any) => {
                if (!status?.isRecording) return;
                if (typeof status?.metering === 'number') {
                    const normalized = Math.max(0, Math.min(1, (status.metering + 60) / 60));
                    setRecordingLevel(prev => prev * 0.62 + normalized * 0.38);
                } else {
                    // fallback pulse when metering is unavailable on some devices
                    setRecordingLevel(prev => Math.max(0.08, prev * 0.92));
                }
            });

            isPreparingRecordingRef.current = false;
            
            // If finger was released while recorder was still preparing, resolve immediately.
            if (pendingStopAfterPrepareRef.current) {
                const { shouldSend } = pendingStopAfterPrepareRef.current;
                pendingStopAfterPrepareRef.current = null;
                await stopRecording(shouldSend);
            }
        } catch (err) {
            console.error('Failed to start recording', err);
            pendingStopAfterPrepareRef.current = null;
            setIsRecording(false);
            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
                recordingTimerRef.current = null;
            }
            try {
                if (recordingRef.current) {
                    await recordingRef.current.stopAndUnloadAsync();
                    recordingRef.current = null;
                }
            } catch {}
            try {
                await Audio.setAudioModeAsync({
                    allowsRecordingIOS: false,
                    playsInSilentModeIOS: true,
                });
            } catch {}
            isPreparingRecordingRef.current = false;
        }
    };

    const stopRecording = async (shouldSend: boolean = true) => {
        if (isStoppingRecordingRef.current) return;
        if (!recordingRef.current) {
            if (isPreparingRecordingRef.current) {
                pendingStopAfterPrepareRef.current = { shouldSend };
            }
            return;
        }
        isStoppingRecordingRef.current = true;

        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);

        const recording = recordingRef.current;
        recordingRef.current = null;

        try {
            await recording.stopAndUnloadAsync();
            const uri = recording.getURI();

            if (shouldSend && uri) {
                const status = await recording.getStatusAsync();
                const durationMillis = status.durationMillis || (recordingDuration * 1000);
                handleSendAudio(uri, durationMillis);
            }
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
            });
            setIsRecordingCancelled(false);
            recordingTranslateX.value = 0;
            pendingStopAfterPrepareRef.current = null;
            isStoppingRecordingRef.current = false;
        } catch (err: any) {
            // "no valid audio data" happens if the recording was too short (quick tap).
            // We suppress the noisy console.error for this specific case.
            if (err.message?.includes('no valid audio data')) {
                console.log('[Chat] Audio recording was too short, skipping send.');
            } else {
                console.error('Failed to stop recording', err);
            }
            
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
            });
            setIsRecordingCancelled(false);
            recordingTranslateX.value = 0;
            pendingStopAfterPrepareRef.current = null;
            isStoppingRecordingRef.current = false;
        }
    };

    const handleSendAudio = async (uri: string, duration?: number) => {
        if (!id) return;
        try {
            const media: Message['media'] = {
                type: 'audio',
                url: '', // will be set by ChatService after background upload
                duration,
            };
            
            // Instantly send message to local DB, passing the local uri for background upload
            sendChatMessage(messageKey,'', media, undefined, uri);
        } catch (error: any) {
            Alert.alert('Send Failed', error.message || 'Please try again.');
        }
    };



    const recordingPulsate = useSharedValue(1);

    useEffect(() => {
        if (isRecording) {
            recordingPulsate.value = withTiming(1.2, { duration: 500, easing: Easing.inOut(Easing.ease) }, (finished) => {
                if (finished) {
                    recordingPulsate.value = withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) });
                }
            });
            const interval = setInterval(() => {
                recordingPulsate.value = withTiming(1.2, { duration: 500, easing: Easing.inOut(Easing.ease) }, (finished) => {
                    if (finished) {
                        recordingPulsate.value = withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) });
                    }
                });
            }, 1000);
            return () => clearInterval(interval);
        } else {
            recordingPulsate.value = 1;
        }
    }, [isRecording]);

    const recordingPulseStyle = useAnimatedStyle(() => ({
        transform: [{ scale: recordingPulsate.value }],
        backgroundColor: interpolateColor(recordingPulsate.value, [1, 1.2], ['rgba(188, 0, 42, 0.4)', 'rgba(188, 0, 42, 0.8)']),
    }));

    const slideToCancelStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: recordingTranslateX.value }],
        opacity: interpolate(recordingTranslateX.value, [-100, 0], [0, 1], Extrapolation.CLAMP),
    }));

    const MIC_TRAVEL_FULL = SCREEN_WIDTH - 150; // drag distance from right mic zone to left delete zone

    const deleteIconAnimatedStyle = useAnimatedStyle(() => {
        const progress = Math.min(1, Math.abs(recordingTranslateX.value) / MIC_TRAVEL_FULL);
        return {
            transform: [{ scale: interpolate(progress, [0, 0.6, 1], [1, 1.15, 1.5], Extrapolation.CLAMP) }],
            opacity: interpolate(progress, [0, 1], [0.55, 1], Extrapolation.CLAMP),
        };
    });

    const recordingMicAnimatedStyle = useAnimatedStyle(() => {
        const progress = Math.min(1, Math.abs(recordingTranslateX.value) / MIC_TRAVEL_FULL);
        return {
            transform: [
                { translateX: recordingTranslateX.value },
                { scale: interpolate(progress, [0, 0.9, 0.98, 1], [1, 1, 0.92, 0.28], Extrapolation.CLAMP) },
            ] as any,
            opacity: interpolate(progress, [0, 0.97, 1], [1, 1, 0], Extrapolation.CLAMP),
            backgroundColor: interpolateColor(
                progress,
                [0, 0.9, 1],
                ['#BC002A', '#D3003B', '#ff4d6d']
            ),
        };
    });

    const recordingWaveAnimatedStyle = useAnimatedStyle(() => {
        const progress = Math.min(1, Math.abs(recordingTranslateX.value) / MIC_TRAVEL_FULL);
        return {
            opacity: interpolate(progress, [0, 0.75, 1], [1, 0.45, 0.08], Extrapolation.CLAMP),
            transform: [{ scaleX: interpolate(progress, [0, 1], [1, 0.92], Extrapolation.CLAMP) }],
        };
    });

    // Cancel only when mic is dragged close to delete target on the left.
    const CANCEL_SWIPE_THRESHOLD = -(MIC_TRAVEL_FULL - 26);

    // Raw touch handlers — guaranteed to fire on every platform (no gesture recognition)
    const handleMicTouchStart = (e: any) => {
        touchStartXRef.current = e.nativeEvent.pageX;
        cancelHapticJSRef.current = false;
        startRecording();
    };

    const handleMicTouchMove = (e: any) => {
        if (!recordingRef.current && !isPreparingRecordingRef.current) return;
        const dx = e.nativeEvent.pageX - touchStartXRef.current;
        recordingTranslateX.value = Math.max(-MIC_TRAVEL_FULL, Math.min(0, dx));
        const shouldCancel = dx < CANCEL_SWIPE_THRESHOLD;
        setIsRecordingCancelled(shouldCancel);
        if (shouldCancel && !cancelHapticJSRef.current) {
            cancelHapticJSRef.current = true;
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        } else if (!shouldCancel) {
            cancelHapticJSRef.current = false;
        }
    };

    const handleMicTouchEnd = (e: any) => {
        const dx = e.nativeEvent.pageX - touchStartXRef.current;
        const shouldCancel = dx < CANCEL_SWIPE_THRESHOLD;
        cancelHapticJSRef.current = false;

        if (shouldCancel) {
            // Animate mic all the way into the delete icon, then cancel
            recordingTranslateX.value = withTiming(-MIC_TRAVEL_FULL, {
                duration: 180,
                easing: Easing.in(Easing.quad),
            });
            setTimeout(() => {
                stopRecording(false);
                recordingTranslateX.value = 0;
            }, 200);
        } else {
            recordingTranslateX.value = withTiming(0, { duration: 200 });
            stopRecording(true);
        }
    };

    useEffect(() => {
        return () => {
            if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            // Stop any active recording when unmounting
            if (recordingRef.current) {
                recordingRef.current.stopAndUnloadAsync().catch(() => {});
                recordingRef.current = null;
            }
            Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
        };
    }, []);



    // Instant scroll to latest message when new messages arrive (animated)
    const prevMsgCount = useRef(chatMessages?.length || 0);
    useEffect(() => {
        if ((chatMessages?.length || 0) > prevMsgCount.current) {
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
        setCallOptionsPosition({ x: 0, y: 110 });
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
                    
                    const finalPos = { x: 0, y: safeY + safeHeight + 8 };
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

    const handleCall = (type: 'audio' | 'video') => {
        closeCallModal();
        setTimeout(() => startCall(id!, type), 300);
    };

    const handleSend = () => {
        if (!inputText.trim() || !id) return;

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        sendTyping(false);

        const content = inputText.trim();
        setInputText('');

        // FIX: Use messageKey (UUID) for sending messages
        const replyToId = replyingTo ? replyingTo.id : undefined;
        sendChatMessage(messageKey, content, undefined, replyToId);

        setReplyingTo(null);
    };

    const handleReaction = (emoji: string) => {
        if (selectedContextMessage && id) {
            addReaction(id, selectedContextMessage.msg.id, emoji);
        }
    };

    const handleAction = (action: string) => {
        if (selectedContextMessage && id) {
            if (action === 'delete') {
                deleteMessage(id, selectedContextMessage.msg.id);
            } else if (action === 'reply') {
                setReplyingTo(selectedContextMessage.msg);
            } else if (action === 'pin') {
                // Future Implementation
            } else if (action === 'forward') {
                // Future Implementation
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

    const handleSelectToggle = useCallback((msgId: string) => {
        setSelectedMessageIds(prev => {
            const next = prev.includes(msgId) ? prev.filter(i => i !== msgId) : [...prev, msgId];
            if (next.length === 0) setSelectionMode(false);
            return next;
        });
    }, []);

    const handleDeleteSelected = () => {
        Alert.alert(
            `Delete ${selectedMessageIds.length} Message${selectedMessageIds.length > 1 ? 's' : ''}`,
            'Are you sure you want to delete?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        selectedMessageIds.forEach(msgId => {
                            if (id) deleteMessage(id, msgId);
                        });
                        setSelectionMode(false);
                        setSelectedMessageIds([]);
                    }
                }
            ]
        );
    };

    const handleDoubleTap = (msgId: string) => {
        if (id) {
            addReaction(id, msgId, '❤️');
        }
    };

    const handleMediaTap = (payload: any) => {
        if (!payload?.mediaItems?.length) return;
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
                Alert.alert('Permission Required', 'Allow media library access to save files.');
                return;
            }

            let localUri = current.url;
            if (!current.url.startsWith('file://')) {
                const extension = current.type === 'video' ? '.mp4' : '.jpg';
                const target = `${FileSystem.cacheDirectory}soulsync_${Date.now()}${extension}`;
                const downloaded = await FileSystem.downloadAsync(current.url, target);
                localUri = downloaded.uri;
            }

            await MediaLibrary.saveToLibraryAsync(localUri);
            Alert.alert('Saved', 'Media saved to your gallery.');
        } catch (error) {
            Alert.alert('Save Failed', 'Could not save this media.');
        }
    };

    const handleMediaDownload = useCallback(async (msgId: string, url: string, index: number) => {
        try {
            console.log(`[ChatScreen] Starting media resolution for msgId: ${msgId}, url: ${url}`);
            const localUri = await storageService.getMediaUrl(url);
            
            if (!localUri) {
               throw new Error('Failed to resolve media URL');
            }

            console.log(`[ChatScreen] Resolved to localUri: ${localUri}`);

            // Update Database
            await offlineService.updateMessageLocalUri(msgId, localUri);

            // Update AppContext State to trigger re-render in UI
            if (updateMessage && id) {
                const currentMsg = (chatMessages || []).find(m => m.id === msgId);
                if (currentMsg) {
                    console.log(`[ChatScreen] Updating AppContext state for msgId: ${msgId}`);
                    updateMessage(id as string, msgId, { 
                         localFileUri: localUri,
                         // Force a partial update that React.memo will see
                         media: currentMsg.media ? { ...currentMsg.media } : {}
                    } as any);
                } else {
                    console.warn(`[ChatScreen] Message ${msgId} not found in current chatMessages state`);
                }
            }
        } catch (error) {
            console.error('[ChatScreen] Media download error:', error);
        }
    }, [id, chatMessages, updateMessage]);

    const renderMessage = useCallback(({ item }: { item: any }) => (
        <MessageBubble
            msg={item}
            contactName={contact?.name || 'Them'}
            isSelected={selectedContextMessage?.msg.id === item.id}
            onLongPress={(mid: string, layout: any) => setSelectedContextMessage({ msg: item, layout })}
            onReply={(m: any) => setReplyingTo(m)}
            onReaction={handleReaction}
            onDoubleTap={handleDoubleTap}
            onMediaTap={handleMediaTap}
            quotedMessage={item.replyTo ? chatMessages.find((m: any) => m.id === item.replyTo) : null}
            selectionMode={selectionMode}
            isChecked={selectedMessageIds.includes(item.id)}
            onSelectToggle={handleSelectToggle}
            isHighlighted={highlightedMessageId === item.id}
            onQuotePress={handleQuotePress}
            uploadProgress={uploadProgressTracker?.[item.id]}
            onMediaDownload={handleMediaDownload}
        />
    ), [selectedContextMessage, chatMessages, contact?.name, handleMediaTap, selectionMode, selectedMessageIds, handleSelectToggle, uploadProgressTracker, handleMediaDownload]);
    
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

    // Media picker handlers
    const handleSelectCamera = async () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
        if (!permissionResult.granted) {
            Alert.alert('Permission Required', 'Camera access is needed to take photos.');
            return;
        }
        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.8,
            allowsEditing: false,
            videoMaxDuration: 120,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const type = asset.type === 'video' ? 'video' : 'image';
            setMediaPreview([{ uri: asset.uri, type }]);
        }
    };

    const handleSelectGallery = async () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.8,
            allowsEditing: false,
            allowsMultipleSelection: true,
            videoMaxDuration: 120,
            legacy: true,
            preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
            const items: { uri: string; type: 'image' | 'video' | 'audio' }[] = result.assets.map(asset => ({
                uri: asset.uri,
                type: asset.type === 'video' ? 'video' : 'image'
            }));
            setMediaPreview(items);
        }
    };

    const handleSelectDocument = async () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
                multiple: true
            });

            if (!result.canceled && result.assets && result.assets.length > 0) {
                const items: { uri: string; type: 'image' | 'video' | 'audio' | 'file'; name?: string }[] = result.assets.map(asset => ({
                    uri: asset.uri,
                    type: 'file',
                    name: asset.name
                }));
                setMediaPreview(items);
            }
        } catch (error) {
            console.error('[ChatScreen] Document picking failed:', error);
            Alert.alert('Error', 'Failed to pick document');
        }
    };

    const handleSelectLocation = () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        Alert.alert('Coming Soon', 'Location sharing will be available soon.');
    };

    const handleSelectContact = () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        Alert.alert('Coming Soon', 'Contact sharing will be available soon.');
    };


    const handleSendMedia = async (mediaList: { uri: string; type: 'image'|'video'|'audio'|'file'; name?: string }[], caption?: string) => {
        if (!mediaList || mediaList.length === 0 || !id) return;
        try {
            for (let i = 0; i < mediaList.length; i++) {
                const item = mediaList[i];
                
                let thumbnail: string | undefined = undefined;
                try {
                    if (item.type === 'image') {
                        const manipResult = await ImageManipulator.manipulateAsync(
                            item.uri,
                            [{ resize: { width: 32 } }],
                            { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true }
                        );
                        thumbnail = `data:image/jpeg;base64,${manipResult.base64}`;
                    }
                    // For videos, in a real app we'd extract a frame. 
                    // For now, we'll skip or use a generic video icon as thumbnail if needed.
                } catch (thumbErr) {
                    console.warn('[ChatScreen] Thumbnail generation failed:', thumbErr);
                }

                const media: Message['media'] = {
                    type: item.type === 'file' ? 'file' : item.type as any,
                    url: '', // will be set by ChatService after background upload
                    caption: i === 0 ? caption || undefined : undefined,
                    thumbnail,
                    name: item.name
                } as any;
                const msgText = i === 0 ? (caption || '') : '';

                // Instantly send to local UI and background queue
                await sendChatMessage(messageKey,msgText, media, undefined, item.uri);
            }
            setMediaPreview(null);
        } catch (error: any) {
            Alert.alert('Send Failed', error.message || 'Please try again.');
        }
    };

    if (!contact) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>Contact not found</Text>
            </View>
        );
    }

    return (
        <View style={styles.container} pointerEvents={isFocused ? 'auto' : 'none'}>
            <StatusBar barStyle="light-content" />

            {/* Screen Background — always solid black so there's never a transparent flash */}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: -1 }]} />

            {/* Content Wrapper */}
            <Animated.View style={[StyleSheet.absoluteFill, { zIndex: 1 }, backgroundMorphAnimatedStyle as any]}>

                {/* Chat body — fades in AFTER the morph transition completes */}
                <View style={StyleSheet.absoluteFill}>

                {/* Chat content - Deferred Rendering for Performance */}
                {isReady && (
                    <View style={{ flex: 1 }}>
                        <Animated.View style={[{ flex: 1 }, messagesContainerAnimatedStyle]}>
                            {/* Messages - Switched to FlatList for better inverted support on Fabric */}
                            <Animated.FlatList
                                ref={flatListRef as any}
                                data={reversedMessages}
                                keyExtractor={keyExtractor}
                                inverted={true}
                                renderItem={renderMessage}
                                style={styles.messagesList}
                                contentContainerStyle={styles.messagesContent}
                                showsVerticalScrollIndicator={false}
                                removeClippedSubviews={false}
                                 ListHeaderComponent={null}
                                ListEmptyComponent={
                                    <View style={styles.emptyChat}>
                                        <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.1)" />
                                        <Text style={styles.emptyChatText}>No messages yet</Text>
                                        <Text style={styles.emptyChatHint}>Say hi to {contact?.name || 'your contact'}!</Text>
                                    </View>
                                }
                            />



                            {/* Progressive Blur — Telegram/iOS style, works on Android too */}
                            <ProgressiveBlur position="top" height={160} intensity={80} />
                            <ProgressiveBlur position="bottom" height={160} intensity={80} />
                        </Animated.View>

                        {/* Input Area */}
                        <Animated.View style={[styles.inputArea, inputAreaAnimatedStyle]}>
                            {/* Typing Indicator above input */}
                            {isTyping && (
                                <Animated.View entering={FadeInDown} exiting={FadeOutDown} style={styles.typingIndicatorWrapper}>
                                    <View style={styles.typingBubbleMini}>
                                        <TypingDots />
                                    </View>
                                </Animated.View>
                            )}
                        {/* Reply Preview */}
                        {replyingTo && (() => {
                            const mediaItems = getMessageMediaItems(replyingTo);
                            const hasMedia = mediaItems.length > 0;
                            const firstMedia = hasMedia ? mediaItems[0] : null;
                            let replyText = replyingTo.text;
                            if (!replyText && hasMedia) {
                                if (firstMedia?.type === 'video') replyText = '🎥 Video';
                                else if (firstMedia?.type === 'audio') replyText = '🎵 Audio Voice Note';
                                else replyText = '📷 Photo';
                            }
                            
                            return (
                                <GlassView intensity={35} tint="dark" style={styles.replyPreview} >
                                    <View style={styles.replyContent}>
                                        <View style={[ChatStyles.quoteBar, { backgroundColor: activeTheme.primary }]} />
                                        <View style={styles.replyTextContainer}>
                                            <Text style={[styles.replySender, { color: activeTheme.primary }]}>
                                                {replyingTo.sender === 'me' ? 'You' : (contact?.name || 'Someone') }
                                            </Text>
                                            <Text numberOfLines={1} style={styles.replyText}>{replyText}</Text>
                                        </View>
                                        {hasMedia && firstMedia?.type !== 'audio' && firstMedia?.url && (
                                            <Image source={{ uri: firstMedia.url }} style={styles.replyThumbnail} resizeMode="cover" />
                                        )}
                                    </View>
                                    <Pressable onPress={() => setReplyingTo(null)} style={{ padding: 4, marginLeft: 8 }}>
                                        <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                                    </Pressable>
                                </GlassView>
                            );
                        })()}
                        {/* Unified Pill Container */}
                        <View style={styles.unifiedPillContainer}>
                            <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill}  />
                            
                            <Animated.View style={[styles.optionsMenu, animatedOptionsStyle]}>
                                <Pressable style={styles.optionItem} onPress={handleSelectCamera}>
                                    <View style={[styles.optionIcon, { backgroundColor: 'rgba(244,63,94,0.16)' }]}>
                                        <MaterialIcons name="photo-camera" size={20} color="#f43f5e" />
                                    </View>
                                    <Text style={styles.optionText}>Camera</Text>
                                </Pressable>
                                <Pressable style={styles.optionItem} onPress={handleSelectGallery}>
                                    <View style={[styles.optionIcon, { backgroundColor: 'rgba(59,130,246,0.16)' }]}>
                                        <MaterialIcons name="photo-library" size={20} color="#60a5fa" />
                                    </View>
                                    <Text style={styles.optionText}>Gallery</Text>
                                </Pressable>
                                <Pressable style={styles.optionItem} onPress={handleSelectDocument}>
                                    <View style={[styles.optionIcon, { backgroundColor: 'rgba(34,197,94,0.16)' }]}>
                                        <MaterialIcons name="insert-drive-file" size={20} color="#4ade80" />
                                    </View>
                                    <Text style={styles.optionText}>Document</Text>
                                </Pressable>
                                <Pressable style={styles.optionItem} onPress={handleSelectContact}>
                                    <View style={[styles.optionIcon, { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
                                        <MaterialIcons name="person-outline" size={20} color="rgba(255,255,255,0.82)" />
                                    </View>
                                    <Text style={styles.optionText}>Contact</Text>
                                </Pressable>
                            </Animated.View>

                            <View
                                style={[styles.inputWrapper, isRecording && styles.inputWrapperHidden]}
                            >
                                    {/* + Button on left inside */}
                                    <Pressable style={styles.attachButton} onPress={toggleOptions}>
                                        <Animated.View style={animatedPlusStyle}>
                                            <MaterialIcons name="add" size={20} color="rgba(255,255,255,0.7)" />
                                        </Animated.View>
                                    </Pressable>

                                    <TextInput
                                        style={styles.input}
                                        value={inputText}
                                        onChangeText={(text) => {
                                            setInputText(text);
                                            
                                            // Typing indicator logic
                                            sendTyping(true);
                                            
                                            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                                            typingTimeoutRef.current = setTimeout(() => {
                                                sendTyping(false);
                                            }, 2000) as unknown as NodeJS.Timeout;
                                        }}
                                        onFocus={handleFocus}
                                        placeholder="Sync fragment..."
                                        placeholderTextColor="rgba(255,255,255,0.3)"
                                        multiline
                                        maxLength={1000}
                                    />

                                    {/* Mic button on right inside */}
                                    {inputText.trim() ? (
                                        <Pressable
                                            style={styles.sendButton}
                                            onPress={handleSend}
                                        >
                                            <MaterialIcons
                                                name="arrow-upward"
                                                size={18}
                                                color={activeTheme.primary}
                                            />
                                        </Pressable>
                                    ) : (
                                        <View
                                            onTouchStart={handleMicTouchStart}
                                            onTouchMove={handleMicTouchMove}
                                            onTouchEnd={handleMicTouchEnd}
                                            onTouchCancel={() => {
                                                cancelHapticJSRef.current = false;
                                                recordingTranslateX.value = withTiming(-MIC_TRAVEL_FULL, { duration: 180, easing: Easing.in(Easing.quad) });
                                                setTimeout(() => {
                                                    stopRecording(false);
                                                    recordingTranslateX.value = 0;
                                                }, 200);
                                            }}
                                        >
                                            <Animated.View style={[styles.sendButton, isRecording && recordingPulseStyle]}>
                                                <MaterialIcons
                                                    name="mic"
                                                    size={18}
                                                    color={isRecording ? '#fff' : 'rgba(255,255,255,0.7)'}
                                                />
                                            </Animated.View>
                                        </View>
                                    )}
                                </View>

                            {/* Recording Overlay */}
                            {isRecording && (
                                <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, zIndex: 10 }]}>
                                    <Animated.View style={[styles.deleteIconWrap, deleteIconAnimatedStyle]}>
                                        <MaterialIcons name="delete" size={20} color={isRecordingCancelled ? '#ff4d6d' : 'rgba(255,255,255,0.72)'} />
                                    </Animated.View>
                                    <Animated.View style={[styles.recordingIndicator, recordingPulseStyle]} />
                                    <Text style={styles.recordingTimer}>{formatDuration(recordingDuration)}</Text>
                                    
                                    <Animated.View style={[{ flex: 1, height: 40, justifyContent: 'center', alignItems: 'center' }, recordingWaveAnimatedStyle]}>
                                        <SiriWaveform level={recordingLevel} active={isRecording} />
                                    </Animated.View>

                                    <Animated.View style={[styles.cancelHintChevron, slideToCancelStyle]}>
                                        <MaterialIcons name="chevron-left" size={20} color="rgba(255,255,255,0.42)" />
                                    </Animated.View>
                                    <Animated.View style={[styles.recordingMicIconWrap, recordingMicAnimatedStyle]}>
                                        <MaterialIcons name="mic" size={20} color="#fff" />
                                    </Animated.View>
                                </Animated.View>
                            )}


                        </View>
                        </Animated.View>
                    </View>
                )}
                </View>
            </Animated.View>

            {/* ─── Header & Morph Pill — OUTSIDE all opacity wrappers ─────────────────
                 These MUST be at the root level with opacity:1 from frame 0.
                 The shared transition engine snapshots them on mount — if they are
                 inside an opacity:0 view, the morph target is invisible → black flash.
            */}
            <View style={[StyleSheet.absoluteFill, { zIndex: 2 }]} pointerEvents="box-none">
                {/* The Morph Target: Dedicated view with matching tag for shared transition */}
                <Animated.View
                    style={[styles.headerPill, headerMorphAnimatedStyle, { 
                        position: 'absolute', 
                        top: HEADER_PILL_TOP, 
                        left: 16, 
                        right: 16, 
                        height: HEADER_PILL_HEIGHT, 
                        backgroundColor: 'rgba(15, 15, 20, 0.4)', 
                        borderRadius: HEADER_PILL_RADIUS, 
                        zIndex: 0,
                        borderWidth: 1,
                        borderColor: 'rgba(255, 255, 255, 0.22)'
                    }]}
                />

                {/* Liquid-glass blur layer (exactly like bottom input pill) */}
                <Animated.View
                    pointerEvents="none"
                    style={[styles.headerGlass, headerMorphAnimatedStyle, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, borderRadius: HEADER_PILL_RADIUS, zIndex: 1 }]}
                >
                    <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill}  />
                </Animated.View>

                    {/* Original Header Content - Rendered exactly over the morph bounds as an absolute overlay */}
                    <Animated.View style={[styles.header, headerMorphAnimatedStyle, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, zIndex: 10 }]} pointerEvents="box-none">
                        {selectionMode ? (
                            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, width: '100%' }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <Pressable onPress={() => { setSelectionMode(false); setSelectedMessageIds([]); }} style={{ marginRight: 24, padding: 4 }}>
                                        <MaterialIcons name="close" size={24} color="#ffffff" />
                                    </Pressable>
                                    <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600' }}>
                                        {selectedMessageIds.length} Selected
                                    </Text>
                                </View>
                                <Pressable onPress={handleDeleteSelected} style={{ padding: 4 }}>
                                    <MaterialIcons name="delete-outline" size={24} color="#ff4444" />
                                </Pressable>
                            </View>
                        ) : (
                          <>
                            <Animated.View style={headerAccessoryAnimatedStyle}>
                                <Pressable onPress={handleBack} style={styles.backButton}>
                                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                                </Pressable>
                            </Animated.View>

                            <Animated.View>
                                <Pressable 
                                    style={styles.avatarWrapper} 
                                    onPress={() => {
                                        router.push(`/profile/${stringId}` as any);
                                    }}
                                >
                                    <SoulAvatar
                                        uri={contact?.avatar}
                                        size={40}
                                        avatarType={contact?.avatarType}
                                        teddyVariant={contact?.teddyVariant}
                                        isOnline={contact?.id ? getPresence(contact.id).isOnline : false}
                                        sharedTransitionTag="avatar-universal-morph"
                                        sharedTransitionStyle={morphTransition}
                                        style={[
                                            contact?.stories && contact.stories.length > 0 && {
                                                borderWidth: 2,
                                                borderColor: contact.stories.some(s => !s.seen) ? '#3b82f6' : 'rgba(255,255,255,0.4)',
                                                padding: 2
                                            }
                                        ]}
                                    />
                                </Pressable>
                            </Animated.View>

                            <View style={styles.headerInfo}>
                                <Animated.View>
                                    <Text style={styles.contactName}>{contact?.name || '...'}</Text>
                                </Animated.View>
                                <Animated.View style={headerAccessoryAnimatedStyle}>
                                    {musicState.isPlaying && musicState.currentSong ? (
                                        <View style={styles.nowPlayingStatus}>
                                            <MaterialIcons name="audiotrack" size={12} color={activeTheme.primary} />
                                            <Text style={[styles.statusText, { color: activeTheme.primary }]} numberOfLines={1}>
                                                {sanitizeSongTitle(musicState.currentSong.name)}
                                            </Text>
                                        </View>
                                    ) : (() => {
                                        const presence = contact?.id ? getPresence(contact.id) : { isOnline: false, lastSeen: null };
                                        let statusText = 'offline';
                                        let statusColor = 'rgba(255,255,255,0.35)';
                                        
                                        if (!connectivity.isDeviceOnline) {
                                            statusText = 'No network';
                                        } else if (!connectivity.isServerReachable) {
                                            statusText = 'Connecting...';
                                        } else if (presence.isOnline) {
                                            statusText = 'ONLINE';
                                            statusColor = activeTheme.primary;
                                        } else if (presence.lastSeen) {
                                            statusText = `last seen ${formatLastSeen(presence.lastSeen)}`;
                                        }

                                        return (
                                            <Text style={[styles.statusText, { color: statusColor }]}>
                                                {statusText}
                                            </Text>
                                        );
                                    })()}
                                </Animated.View>
                            </View>

                            <Animated.View style={headerAccessoryAnimatedStyle}>
                                <Pressable style={styles.headerButton} onPress={() => router.push('/music')}>
                                    {({ pressed }) => (
                                        <MaterialIcons name="audiotrack" size={20} color={pressed ? activeTheme.primary : '#ffffff'} />
                                    )}
                                </Pressable>
                            </Animated.View>

                            <Animated.View style={headerAccessoryAnimatedStyle}>
                                <View ref={callButtonRef} collapsable={false}>
                                    <Pressable style={styles.headerButton} onPress={openCallModal}>
                                        {({ pressed }) => (
                                            <MaterialIcons name="call" size={20} color={pressed ? activeTheme.primary : '#ffffff'} />
                                        )}
                                    </Pressable>
                                </View>
                            </Animated.View>
                          </>
                        )}
                    </Animated.View>
            </View>

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
            />

            {/* Call Options Dropdown */}
            {showCallModal && (
                <View style={[StyleSheet.absoluteFill, { zIndex: 9999, elevation: 9999 }]}>
                    <Pressable style={styles.modalOverlay} onPress={closeCallModal}>
                        <RNAnimated.View
                            style={[
                                styles.callDropdown,
                                {
                                    top: callOptionsPosition.y,
                                    right: 16,
                                    opacity: modalAnim,
                                    transform: [{
                                        scale: modalAnim.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [0.9, 1],
                                        })
                                    }]
                                }
                            ]}
                        >
                            <GlassView intensity={35} tint="dark" style={styles.callDropdownBlur} >
                                <Pressable style={styles.callDropdownItem} onPress={() => handleCall('audio')}>
                                    <View style={[styles.callDropdownIcon, { backgroundColor: 'rgba(34, 197, 94, 0.15)' }]}>
                                        <MaterialIcons name="call" size={20} color="#22c55e" />
                                    </View>
                                    <Text style={styles.callDropdownText}>Audio</Text>
                                </Pressable>
                                <View style={styles.callDropdownDivider} />
                                <Pressable style={styles.callDropdownItem} onPress={() => handleCall('video')}>
                                    <View style={[styles.callDropdownIcon, { backgroundColor: 'rgba(244, 63, 94, 0.15)' }]}>
                                        <MaterialIcons name="videocam" size={20} color="#f43f5e" />
                                    </View>
                                    <Text style={styles.callDropdownText}>Video</Text>
                                </Pressable>
                            </GlassView>
                        </RNAnimated.View>
                    </Pressable>
                </View>
            )}


            <MediaPickerSheet
                visible={showMediaPicker}
                onClose={() => setShowMediaPicker(false)}
                onSelectCamera={handleSelectCamera}
                onSelectGallery={handleSelectGallery}
                onSelectAssets={(assets) => {
                    setShowMediaPicker(false);
                    const formattedAssets = assets.map(a => ({
                        uri: a.uri,
                        type: a.mediaType === 'video' ? 'video' : 'image'
                    }));
                    setMediaPreview(formattedAssets as any);
                }}
                onSelectAudio={handleSelectDocument}
                onSelectNote={() => {
                    setShowMediaPicker(false);
                    Alert.alert("Soul Notes", "Leave a note from the Home screen!");
                }}
            />

            {/* Media Preview Modal */}
            <MediaPreviewModal
                visible={!!mediaPreview && mediaPreview.length > 0}
                initialMediaItems={mediaPreview || undefined}
                onClose={() => setMediaPreview(null)}
                onSend={handleSendMedia}
                isUploading={isUploading}
            />

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
                media={mediaViewer ? mediaViewer.items[mediaViewer.index] as any : null}
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
                        sendChatMessage(messageKey,comment);
                    }
                }}
                onDownload={handleSaveCurrentMedia}
                onReply={() => {
                    if (mediaViewer) {
                        const msg = chatMessages.find((m: any) => m.id === mediaViewer.messageId);
                        if (msg) setReplyingTo(msg);
                        setMediaViewer(null);
                        setSelectedMediaLayout(null);
                    }
                }}
                onForward={() => {
                    Alert.alert('Coming Soon', 'Forwarding will be available soon.');
                }}
                onReaction={(emoji) => {
                    if (mediaViewer && id) {
                        addReaction(id, mediaViewer.messageId, emoji);
                    }
                }}
                onEdit={() => Alert.alert('Edit', 'Media editing will be available soon.')}
                onShare={() => Alert.alert('Share', 'External sharing will be available soon.')}
            />

            {/* Music Player Overlay - Moved to root for z-index and blur reliability */}
            <MusicPlayerOverlay
                isOpen={showMusicPlayer}
                onClose={() => setShowMusicPlayer(false)}
                contactName={contact?.name || 'Someone'}
            />
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
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    backButton: {
        padding: 4,
    },
    avatarWrapper: {
        position: 'relative',
        marginLeft: -4, 
    },
    avatar: {
        width: 42,
        height: 42,
        borderRadius: 21,
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
        borderWidth: 2,
        borderColor: '#151515',
    },
    headerInfo: {
        flex: 1,
        marginLeft: 8,
        justifyContent: 'center',
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
        backgroundColor: 'rgba(255,255,255,0.12)',
        borderRadius: 999,
        minWidth: 74,
        height: 38,
        paddingHorizontal: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 8 },
    },
    typingAnimationWrap: {
        width: 42,
        height: 18,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
    },
    typingDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
        backgroundColor: 'rgba(255,255,255,0.9)',
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
        gap: 10,
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
    unifiedPillContainer: {
        backgroundColor: 'transparent',
        borderRadius: 25,
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        overflow: 'hidden',
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 8,
        minHeight: 40,
        maxHeight: 100,
        gap: 4,
    },
    attachButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        flexShrink: 0,
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
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        flexShrink: 0,
    },
    sendButtonActive: {
        backgroundColor: 'rgba(245, 0, 87, 0.1)',
        borderColor: 'rgba(245, 0, 87, 0.3)',
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
        width: 140,
        borderRadius: 16,
        overflow: 'hidden',
    },
    callDropdownBlur: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        overflow: 'hidden',
    },
    callDropdownItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
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
        gap: 12,
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
        gap: 10,
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
        gap: 4,
    },
    optionsMenu: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-around',
        overflow: 'hidden',
    },
    optionItem: {
        alignItems: 'center',
        margin: 10,
        width: 60,
    },
    optionIcon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 6,
    },
    optionText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 11,
        fontWeight: '500',
    },
    inputWrapperHidden: {
        opacity: 0,
    },
    recordingIndicator: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#BC002A',
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
        shadowColor: '#FF1E56',
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
        backgroundColor: '#BC002A',
        marginLeft: 6,
    },
});
