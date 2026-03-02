import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
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
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
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
    interpolate,
    interpolateColor,
    Extrapolation,
    Easing,
} from 'react-native-reanimated';
import { MORPH_EASING, MORPH_IN_DURATION, MORPH_OUT_DURATION, MORPH_OUT_EASING, MORPH_SPRING_CONFIG } from '../../constants/transitions';
import 'react-native-gesture-handler';

import { useApp } from '../../context/AppContext';
import { chatService } from '../../services/ChatService';
import { MusicPlayerOverlay } from '../../components/MusicPlayerOverlay';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { storageService } from '../../services/StorageService';
import { EnhancedMediaViewer } from '../../components/EnhancedMediaViewer';
import { Contact, Message } from '../../types';
import { ResizeMode, Video, Audio } from 'expo-av';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';

const IS_IOS = Platform.OS === 'ios';
const IOS_KEYBOARD_SAFE_ADJUST = 0; 
const HEADER_PILL_TOP = 62;

type ChatMediaItem = {
    url: string;
    type: 'image' | 'video' | 'audio';
    caption?: string;
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

// Animated 3-dot typing indicator (WhatsApp / iMessage style)
const TypingDots = () => {
    const [dot, setDot] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setDot(d => (d + 1) % 3), 400);
        return () => clearInterval(id);
    }, []);
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            {[0, 1, 2].map(i => (
                <View
                    key={i}
                    style={{
                        width: 5,
                        height: 5,
                        borderRadius: 2.5,
                        backgroundColor: dot === i ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
                    }}
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
    const id = propsUser?.id || (Array.isArray(paramsId) ? paramsId[0] : paramsId);
    const sourceY = propsSourceY ?? (paramsSourceY ? Number(Array.isArray(paramsSourceY) ? paramsSourceY[0] : paramsSourceY) : undefined);
    
    const router = useRouter();
    const isFocused = useIsFocused();
    const { contacts, messages, sendChatMessage, startCall, activeCall, addReaction, deleteMessage, musicState, currentUser, activeTheme, sendTyping, typingUsers } = useApp();
    const [inputText, setInputText] = useState('');
    const [showCallModal, setShowCallModal] = useState(false);
    const [isReady, setIsReady] = useState(false);

    // Memoize reversed messages to avoid expensive array operations in render
    const reversedMessages = useMemo(() => [...(messages[id] || [])].reverse(), [messages, id]);

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
    
    const chatBodyOpacity = useSharedValue(sourceY !== undefined ? 0 : 1);
    const keyboardOffset = useSharedValue(0);

    const chatBodyAnimStyle = useAnimatedStyle(() => ({
        opacity: chatBodyOpacity.value,
    }));

    const inputAreaAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -keyboardOffset.value }],
    }));

    const messagesContainerAnimatedStyle = useAnimatedStyle(() => ({
        paddingBottom: keyboardOffset.value,
    }));

    // Animate IN with staggered delay - Using useEffect for more reliable animation start
    useEffect(() => {
        if (sourceY !== undefined) {
            // 1. Full shape morph starts instantly
            // 2. Chat body text/input fades in midway through the morph
            chatBodyOpacity.value = withDelay(MORPH_IN_DURATION * 0.3, withTiming(1, {
                duration: MORPH_IN_DURATION * 0.8,
                easing: Easing.out(Easing.quad)
            }));
        }
    }, [sourceY]);

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

        // Content fades out quickly for smoother perceived transition
        chatBodyOpacity.value = withTiming(0, {
            duration: MORPH_OUT_DURATION * 0.35,
            easing: Easing.out(Easing.quad),
        });

        // Close transient overlays before navigating back to avoid stale touch blockers.
        setShowCallModal(false);
        setSelectedContextMessage(null);
        setShowMediaPicker(false);
        setMediaPreview(null);
        setMediaCollection(null);
        setMediaViewer(null);

        // Use native navigation goBack to trigger shared transition OUT
        if (onBack) {
            onBack();
        } else if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            console.warn('Navigation: Cannot go back');
            isNavigatingRef.current = false;
        }
    }, [onBackStart, onBack, navigation, chatBodyOpacity, selectionMode]);

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
    const contact = contacts.find(c => c.id === id);
    const chatMessages = messages[id || ''] || [];
    const isTyping = contact ? typingUsers.includes(contact.id) : false;

    // Mark incoming messages as read when chat is open
    useEffect(() => {
        const unreadIds = chatMessages
            .filter(m => m.sender === 'them' && m.status !== 'read')
            .map(m => m.id);
        if (unreadIds.length > 0) {
            chatService.markMessagesAsRead(unreadIds);
        }
    }, [chatMessages]);

    // Toggle Options Menu
    const toggleOptions = () => {
        if (isExpanded) {
            // Close
            plusRotation.value = withSpring(0);
            optionsHeight.value = withTiming(0);
            optionsOpacity.value = withTiming(0);
            setIsExpanded(false);
        } else {
            // Open
            plusRotation.value = withSpring(45); // Rotate to X
            optionsHeight.value = withTiming(90);
            optionsOpacity.value = withTiming(1);
            setIsExpanded(true);
        }
    };

    // Close options when typing
    const handleFocus = () => {
        if (isExpanded) toggleOptions();
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
    const [mediaPreview, setMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' } | null>(null);
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
                handleSendAudio(uri);
            }
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
            });
            setIsRecordingCancelled(false);
            recordingTranslateX.value = 0;
            pendingStopAfterPrepareRef.current = null;
            isStoppingRecordingRef.current = false;
        } catch (err) {
            console.error('Failed to stop recording', err);
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

    const handleSendAudio = async (uri: string) => {
        if (!id) return;
        setIsUploading(true);
        try {
            const media: Message['media'] = {
                type: 'audio',
                url: '', // will be set after upload
            };
            try {
                const publicUrl = await storageService.uploadImage(uri, 'chat-media', currentUser?.id || '');
                if (!publicUrl) throw new Error('Upload failed');
                media.url = publicUrl;
                sendChatMessage(id, '', media);
            } catch (err) {
                throw err; // Re-throw to be caught by outer catch
            }
            setIsUploading(false);
        } catch (error: any) {
            Alert.alert('Upload Failed', error.message || 'Please try again.');
            setIsUploading(false);
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
            ],
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
    const prevMsgCount = useRef(chatMessages.length);
    useEffect(() => {
        if (chatMessages.length > prevMsgCount.current) {
            setTimeout(() => {
                flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            }, 100);
        }
        prevMsgCount.current = chatMessages.length;
    }, [chatMessages.length]);

    // Handle content size change if needed (but inverted handles most cases)
    const handleContentSizeChange = useCallback(() => {
        // Naturally starts at index 0 (bottom) when inverted
    }, []);

    const openCallModal = () => {
        // Measure call button position
        callButtonRef.current?.measure((x, y, width, height, pageX, pageY) => {
            setCallOptionsPosition({ x: pageX - 80, y: pageY + height + 8 });
        });
        setShowCallModal(true);
        RNAnimated.spring(modalAnim, {
            toValue: 1,
            useNativeDriver: true,
            tension: 100,
            friction: 10,
        }).start();
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

        const replyToId = replyingTo ? replyingTo.id : undefined;
        sendChatMessage(id, content, undefined, replyToId);

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
        />
    ), [selectedContextMessage, chatMessages, contact?.name, handleMediaTap, selectionMode, selectedMessageIds, handleSelectToggle]);
    
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
            <Image source={{ uri: item.url }} style={styles.mediaCollectionImage} contentFit="cover" transition={200} />
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
            allowsEditing: true,
            videoMaxDuration: 120,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const type = asset.type === 'video' ? 'video' : 'image';
            setMediaPreview({ uri: asset.uri, type });
        }
    };

    const handleSelectGallery = async () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.8,
            allowsEditing: true,
            videoMaxDuration: 120,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const type = asset.type === 'video' ? 'video' : 'image';
            setMediaPreview({ uri: asset.uri, type });
        }
    };

    const handleSelectAudio = async () => {
        setShowMediaPicker(false);
        Alert.alert('Coming Soon', 'Audio file selection will be available soon.');
    };

    const handleSendMedia = async (mediaList: { uri: string; type: 'image'|'video'|'audio' }[], caption?: string) => {
        if (!mediaList || mediaList.length === 0 || !id) return;
        setIsUploading(true);
        try {
            for (let i = 0; i < mediaList.length; i++) {
                const item = mediaList[i];
                
                const media: Message['media'] = {
                    type: item.type,
                    url: '', // will be set after upload
                    caption: i === 0 ? caption || undefined : undefined,
                };
                const msgText = i === 0 ? (caption || '') : '';

                try {
                    const publicUrl = await storageService.uploadImage(item.uri, 'chat-media', currentUser?.id || '');
                    if (!publicUrl) throw new Error('Upload failed');
                    media.url = publicUrl;
                    await sendChatMessage(id, msgText, media);
                } catch (err) {
                    throw err; // Re-throw to be caught by outer catch
                }
            }
            setMediaPreview(null);
            setIsUploading(false);
        } catch (error: any) {
            Alert.alert('Upload Failed', error.message || 'Please try again.');
            setIsUploading(false);
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
            <View style={[StyleSheet.absoluteFill, { zIndex: 1 }]}>

                {/* Chat body — fades in AFTER the morph transition completes */}
                <Animated.View style={[StyleSheet.absoluteFill, chatBodyAnimStyle]}>

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
                                removeClippedSubviews={Platform.OS === 'android'}
                                ListEmptyComponent={
                                    <View style={styles.emptyChat}>
                                        <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.1)" />
                                        <Text style={styles.emptyChatText}>No messages yet</Text>
                                        <Text style={styles.emptyChatHint}>Say hi to {contact.name}!</Text>
                                    </View>
                                }
                            />



                            {/* iOS-style Progressive Blur Effects */}
                            <ProgressiveBlur position="top" height={280} intensity={120} />
                            <ProgressiveBlur position="bottom" height={200} intensity={120} />

                            {/* Typing Indicator — animated 3-dot bubble */}
                            {isTyping && (
                                <View style={styles.typingContainer}>
                                    <View style={styles.typingBubble}>
                                        <TypingDots />
                                    </View>
                                </View>
                            )}
                        </Animated.View>

                        {/* Input Area */}
                        <Animated.View style={[styles.inputArea, inputAreaAnimatedStyle]}>
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
                                <BlurView intensity={60} tint="dark" style={styles.replyPreview} experimentalBlurMethod="dimezisBlurView">
                                    <View style={styles.replyContent}>
                                        <View style={[ChatStyles.quoteBar, { backgroundColor: activeTheme.primary }]} />
                                        <View style={styles.replyTextContainer}>
                                            <Text style={[styles.replySender, { color: activeTheme.primary }]}>
                                                {replyingTo.sender === 'me' ? 'You' : contact.name}
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
                                </BlurView>
                            );
                        })()}
                        {/* Unified Pill Container */}
                        <View style={styles.unifiedPillContainer}>
                            <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} experimentalBlurMethod="dimezisBlurView" />
                            
                            {/* Expandable Options Menu - Now above inputWrapper to open upwards */}
                            <Animated.View style={[styles.optionsMenu, animatedOptionsStyle]}>
                                 <Pressable style={styles.optionItem} onPress={handleSelectGallery}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#3b82f6' }]}>
                                        <MaterialIcons name="image" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Gallery</Text>
                                 </Pressable>
                                 <Pressable style={styles.optionItem} onPress={handleSelectCamera}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#ef4444' }]}>
                                        <MaterialIcons name="camera-alt" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Camera</Text>
                                 </Pressable>
                                 <Pressable style={styles.optionItem}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#a855f7' }]}>
                                        <MaterialIcons name="location-pin" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Location</Text>
                                 </Pressable>
                                 <Pressable style={styles.optionItem}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#10b981' }]}>
                                        <MaterialIcons name="person" size={24} color="white" />
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

                                    {/* Emoji button (optional, can remove if not needed) */}
                                    <Pressable style={styles.emojiInputButton}>
                                        <MaterialIcons name="sentiment-satisfied" size={20} color="rgba(255,255,255,0.5)" />
                                    </Pressable>

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
                </Animated.View>
            </View>

            {/* ─── Header & Morph Pill — OUTSIDE all opacity wrappers ─────────────────
                 These MUST be at the root level with opacity:1 from frame 0.
                 The shared transition engine snapshots them on mount — if they are
                 inside an opacity:0 view, the morph target is invisible → black flash.
            */}
            <View style={[StyleSheet.absoluteFill, { zIndex: 2 }]} pointerEvents="box-none">
                {/* The Morph Target: Solid pill background — NO CHILDREN, opacity always 1 */}
                <Animated.View
                    style={[styles.headerPill, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, backgroundColor: 'rgba(30, 30, 35, 0.4)', borderRadius: HEADER_PILL_RADIUS, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.06)', zIndex: 0 }]}
                />

                {/* Liquid-glass blur layer (exactly like bottom input pill) */}
                <View
                    pointerEvents="none"
                    style={[styles.headerGlass, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, borderRadius: HEADER_PILL_RADIUS, zIndex: 1 }]}
                >
                    <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} experimentalBlurMethod="dimezisBlurView" />
                </View>

                    {/* Original Header Content - Rendered exactly over the morph bounds as an absolute overlay */}
                    <View style={[styles.header, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, zIndex: 10 }]} pointerEvents="box-none">
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
                            <Pressable onPress={handleBack} style={styles.backButton}>
                                <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                            </Pressable>

                            <Pressable style={styles.avatarWrapper} onPress={() => router.push(`/profile/${contact.id}` as any)}>
                                <Animated.Image
                                    source={{ uri: contact.avatar }}
                                    style={styles.avatar}
                                />
                                {contact.status === 'online' && <View style={styles.onlineIndicator} />}
                            </Pressable>

                            <View style={styles.headerInfo}>
                                <View>
                                    <Text style={styles.contactName}>{contact.name}</Text>
                                </View>
                                {isTyping ? (
                                    <Text style={[styles.statusText, { color: '#22c55e' }]}>
                                        typing...
                                    </Text>
                                ) : musicState.currentSong ? (
                                    <View style={styles.nowPlayingStatus}>
                                        <MaterialIcons name="audiotrack" size={12} color={activeTheme.primary} />
                                        <Text style={[styles.statusText, { color: activeTheme.primary }]} numberOfLines={1}>
                                            {sanitizeSongTitle(musicState.currentSong.name)}
                                        </Text>
                                    </View>
                                ) : contact.status === 'online' ? (
                                    <Text style={[styles.statusText, { color: '#22c55e' }]}>
                                        online
                                    </Text>
                                ) : (
                                    <Text style={[styles.statusText, { color: 'rgba(255,255,255,0.35)' }]}>
                                        {contact.lastSeen
                                            ? `last seen ${formatLastSeen(contact.lastSeen)}`
                                            : 'offline'}
                                    </Text>
                                )}
                            </View>

                            <Pressable style={styles.headerButton} onPress={() => router.push('/music')}>
                                <MaterialIcons name="audiotrack" size={20} color={activeTheme.primary} />
                            </Pressable>

                            <View ref={callButtonRef} collapsable={false}>
                                <Pressable style={styles.headerButton} onPress={openCallModal}>
                                    <MaterialIcons name="call" size={20} color={activeTheme.primary} />
                                </Pressable>
                            </View>
                          </>
                        )}
                    </View>
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
            <Modal visible={showCallModal} transparent animationType="none" onRequestClose={closeCallModal}>
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
                        <BlurView intensity={100} tint="dark" style={styles.callDropdownBlur} experimentalBlurMethod="dimezisBlurView">
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
                        </BlurView>
                    </RNAnimated.View>
                </Pressable>
            </Modal>

            {/* Music Player Overlay */}
            <MusicPlayerOverlay
                isOpen={showMusicPlayer}
                onClose={() => setShowMusicPlayer(false)}
                contactName={contact.name}
            />

            {/* Media Picker Sheet */}
            <MediaPickerSheet
                visible={showMediaPicker}
                onClose={() => setShowMediaPicker(false)}
                onSelectCamera={handleSelectCamera}
                onSelectGallery={handleSelectGallery}
                onSelectAudio={handleSelectAudio}
                onSelectNote={() => {
                    setShowMediaPicker(false);
                    Alert.alert("SoulSync Notes", "Leave a note from the Home screen!");
                }}
            />

            {/* Media Preview Modal */}
            <MediaPreviewModal
                visible={!!mediaPreview}
                mediaUri={mediaPreview?.uri || ''}
                mediaType={mediaPreview?.type || 'image'}
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
                        sendChatMessage(id, comment);
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
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)',
        backgroundColor: 'rgba(30, 30, 35, 0.4)',
        overflow: 'hidden',
    },
    headerGlass: {
        borderRadius: HEADER_PILL_RADIUS,
        overflow: 'hidden',
        backgroundColor: 'rgba(30, 30, 35, 0.22)',
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
        backgroundColor: '#252525',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.05)',
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
        backgroundColor: 'rgba(30, 30, 35, 0.4)',
        borderRadius: 25,
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
        borderColor: 'rgba(255, 255, 255, 0.05)',
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
    emojiInputButton: {
        padding: 4,
        flexShrink: 0,
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.05)',
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
