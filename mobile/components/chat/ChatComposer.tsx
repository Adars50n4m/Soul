import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    StyleProp,
    ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { copyAsync, getInfoAsync, cacheDirectory } from 'expo-file-system';
import LottieView from 'lottie-react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    useAnimatedProps,
    useDerivedValue,
    withTiming,
    withSpring,
    withRepeat,
    interpolate,
    interpolateColor,
    Extrapolation,
    Easing,
    FadeInDown,
    FadeOutDown,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';
import { useRouter } from 'expo-router';

import GlassView from '../ui/GlassView';
import { PressableFlash } from '../ui/IOS26Primitives';
import GlassAlert, { AlertButton } from '../ui/GlassAlert';
import { MediaPickerSheet } from '../MediaPickerSheet';
import { MediaPreviewModal } from '../MediaPreviewModal';
import { ChatStyles, SCREEN_WIDTH } from './ChatStyles';
import { hapticService } from '../../services/HapticService';
import { useApp } from '../../context/AppContext';
import { formatDuration } from '../../utils/formatters';
import { MEDIA_GROUP_MARKER } from '../../utils/chatUtils';
import type { Message } from '../../types';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const TYPING_LOTTIE = require('../../assets/animations/typing-dots.json');

const SiriWaveform = ({
    level,
    active,
    themeColor,
}: {
    level: number;
    active: boolean;
    themeColor: string;
}) => {
    const phase = useSharedValue(0);
    const width = 200;
    const height = 40;
    const centerY = height / 2;

    useEffect(() => {
        if (!active) {
            phase.value = 0;
            return;
        }
        phase.value = withRepeat(
            withTiming(20, { duration: 2500, easing: Easing.linear }),
            -1,
            false
        );
    }, [active]);

    const amplitude = useDerivedValue(() => {
        const clampedLevel = Math.max(0, Math.min(1, level));
        return 4 + clampedLevel * 14;
    }, [level]);

    const buildWavePath = (phaseOffset: number, ampFactor: number, freq: number) => {
        'worklet';
        const p = phase.value;
        const amp = amplitude.value;
        const step = 6;
        let path = `M 0 ${centerY}`;
        for (let x = 0; x <= width; x += step) {
            const theta = (x / width) * Math.PI * 2 * freq + p + phaseOffset;
            const theta2 = (x / width) * Math.PI * 2 * (freq * 1.7) + p * 0.7 + phaseOffset;
            const y =
                centerY + Math.sin(theta) * amp * ampFactor + Math.sin(theta2) * amp * 0.2;
            path += ` L ${x} ${y}`;
        }
        return path;
    };

    const animatedProps1 = useAnimatedProps(() => ({ d: buildWavePath(2.1, 0.48, 0.85) }));
    const animatedProps2 = useAnimatedProps(() => ({ d: buildWavePath(1.2, 0.72, 1.1) }));
    const animatedProps3 = useAnimatedProps(() => ({ d: buildWavePath(0, 1, 1.4) }));

    return (
        <View style={styles.siriWaveWrap}>
            <Svg width={width} height={height}>
                <Defs>
                    <SvgLinearGradient id="siriGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <Stop offset="0%" stopColor={themeColor} stopOpacity="0" />
                        <Stop offset="10%" stopColor={themeColor} stopOpacity="0.58" />
                        <Stop offset="50%" stopColor={themeColor} stopOpacity="1" />
                        <Stop offset="90%" stopColor={themeColor} stopOpacity="0.58" />
                        <Stop offset="100%" stopColor={themeColor} stopOpacity="0" />
                    </SvgLinearGradient>
                </Defs>
                <AnimatedPath animatedProps={animatedProps1} fill="none" stroke="url(#siriGradient)" strokeWidth={3} opacity={0.28} />
                <AnimatedPath animatedProps={animatedProps2} fill="none" stroke="url(#siriGradient)" strokeWidth={4} opacity={0.5} />
                <AnimatedPath animatedProps={animatedProps3} fill="none" stroke="url(#siriGradient)" strokeWidth={5} opacity={0.95} />
            </Svg>
        </View>
    );
};

const TypingDots = () => (
    <LottieView source={TYPING_LOTTIE} autoPlay loop speed={0.9} style={styles.typingLottie} />
);

type MediaItem = { uri: string; type: 'image' | 'video' | 'audio' | 'file'; name?: string };

export interface ChatComposerProps {
    /** Chat id used as messageKey for sendChatMessage / updateMessage. */
    messageKey: string;
    /** Theme accent — drives send button + recording highlight colors. */
    accent: string;
    /** Optional softer accent used during the recording → cancel transition. */
    accentSoft?: string;
    /** Reply-to preview header. Composer renders the chip when present. */
    replyingTo?: any;
    onClearReply?: () => void;
    /** Edit-mode preview header + prefill. */
    editingMessage?: any;
    onClearEdit?: () => void;
    /** Called when the user taps send while editingMessage is set. */
    onSaveEdit?: (text: string) => void;
    /** Fires after a non-edit text/media send so the parent can scroll its list. */
    onAfterSend?: () => void;
    /** Show the Theater action in the + menu. */
    enableTheaterAction?: boolean;
    /** Renders the Theater row as the current mode instead of a navigable action. */
    theaterActionSelected?: boolean;
    /** Used by the Theater action to label the picker route. */
    contactName?: string;
    /** Show the typing-dots indicator (other party typing). */
    isOtherTyping?: boolean;
    /** Outer container style (padding, etc.). Composer adds no horizontal padding. */
    style?: StyleProp<ViewStyle>;
    /** Fired when the attach (+) menu opens or closes. Used by callers to dim
     *  surrounding UI (e.g. theater chat list) so the menu reads as a modal. */
    onAttachMenuToggle?: (open: boolean) => void;
}

export interface ChatComposerHandle {
    setInputText: (text: string) => void;
    focus: () => void;
    dismissModals: () => void;
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(({
    messageKey,
    accent,
    accentSoft,
    replyingTo,
    onClearReply,
    editingMessage,
    onClearEdit,
    onSaveEdit,
    onAfterSend,
    enableTheaterAction = true,
    theaterActionSelected = false,
    contactName,
    isOtherTyping,
    style,
    onAttachMenuToggle,
}, ref) => {
    const router = useRouter();
    const { sendChatMessage, sendTyping } = useApp() as any;

    const accentSoftResolved = accentSoft || accent;

    const [inputText, setInputText] = useState('');
    const inputRef = useRef<TextInput>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const isExpandedRef = useRef(false);
    const toggleOptionsRef = useRef<(() => void) | null>(null);
    isExpandedRef.current = isExpanded;

    useImperativeHandle(
        ref,
        () => ({
            setInputText: (text: string) => setInputText(text),
            focus: () => inputRef.current?.focus(),
            dismissModals: () => {
                setShowMediaPicker(false);
                setMediaPreview(null);
                if (isExpandedRef.current) toggleOptionsRef.current?.();
            },
        }),
        []
    );
    const [showMediaPicker, setShowMediaPicker] = useState(false);
    const [mediaPreview, setMediaPreview] = useState<MediaItem[] | null>(null);
    const [isUploading, setIsUploading] = useState(false);

    // Typing refs
    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isTypingRef = useRef(false);

    // Recording state
    const recordingRef = useRef<Audio.Recording | null>(null);
    const isPreparingRecordingRef = useRef(false);
    const isStoppingRecordingRef = useRef(false);
    const pendingStopAfterPrepareRef = useRef<null | { shouldSend: boolean }>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [recordingLevel, setRecordingLevel] = useState(0.08);
    const [, setIsRecordingCancelled] = useState(false);

    // Shared values — + menu morph
    const plusRotation = useSharedValue(0);
    const optionsOpacity = useSharedValue(0);
    const optionsTranslateY = useSharedValue(50);
    const optionsScale = useSharedValue(0.01);

    // Shared values — recording
    const recordingPulsate = useSharedValue(1);
    const micScale = useSharedValue(1);
    const recordingTranslateX = useSharedValue(0);
    const touchStartXRef = useRef(0);
    const cancelHapticJSRef = useRef(false);

    // Alert state (composer-local so theater overlay doesn't need its own)
    const [alertConfig, setAlertConfig] = useState<{
        visible: boolean;
        title: string;
        message?: string;
        buttons?: AlertButton[];
    }>({ visible: false, title: '' });
    const showSoulAlert = useCallback(
        (title: string, message?: string, buttons?: AlertButton[]) => {
            setAlertConfig({ visible: true, title, message, buttons });
        },
        []
    );
    const closeSoulAlert = useCallback(() => {
        setAlertConfig((prev) => ({ ...prev, visible: false }));
    }, []);

    // When the parent activates edit mode, prefill the input.
    useEffect(() => {
        if (editingMessage) {
            setInputText(editingMessage.text || editingMessage.media?.caption || '');
        }
    }, [editingMessage?.id]);

    // Reset closed state on mount (in case shared values are stale from fast refresh)
    useEffect(() => {
        plusRotation.value = 0;
        optionsOpacity.value = 0;
        optionsTranslateY.value = 50;
        optionsScale.value = 0;
    }, []);

    const toggleOptions = useCallback(() => {
        const nextExpanded = !isExpanded;
        setIsExpanded(nextExpanded);
        onAttachMenuToggle?.(nextExpanded);
        const springConfig = { damping: 15, stiffness: 150, mass: 0.5 };
        plusRotation.value = withSpring(nextExpanded ? 45 : 0, { damping: 15, stiffness: 200 });
        optionsOpacity.value = withTiming(nextExpanded ? 1 : 0, { duration: 100 });
        optionsTranslateY.value = withSpring(nextExpanded ? 0 : 50, springConfig);
        optionsScale.value = withSpring(nextExpanded ? 1 : 0.01, springConfig);
        if (nextExpanded) hapticService.impact(Haptics.ImpactFeedbackStyle.Medium);
    }, [isExpanded, onAttachMenuToggle]);
    toggleOptionsRef.current = toggleOptions;

    const handleFocus = useCallback(() => {
        if (isExpanded) toggleOptions();
    }, [isExpanded, toggleOptions]);

    const animatedMorphStyle = useAnimatedStyle(() => {
        const progress = optionsScale.value;
        return {
            width: interpolate(progress, [0, 1], [44, 200], Extrapolation.CLAMP),
            height: interpolate(progress, [0, 1], [44, 340], Extrapolation.CLAMP),
            borderRadius: interpolate(progress, [0, 1], [22, 28], Extrapolation.CLAMP),
        };
    });

    const animatedContentOpacity = useAnimatedStyle(() => ({
        opacity: interpolate(optionsScale.value, [0.3, 1], [0, 1], Extrapolation.CLAMP),
        transform: [
            { translateY: interpolate(optionsScale.value, [0, 1], [40, 0], Extrapolation.CLAMP) },
        ],
    }));

    const animatedIconRotation = useAnimatedStyle(() => ({
        transform: [
            { rotate: `${plusRotation.value}deg` },
            { scale: interpolate(optionsScale.value, [0, 1], [1, 1.1], Extrapolation.CLAMP) },
        ] as any,
    }));

    // ─── Recording animations ──────────────────────────────────────────
    const MIC_TRAVEL_FULL = SCREEN_WIDTH - 110;
    const CANCEL_SWIPE_THRESHOLD = -(MIC_TRAVEL_FULL - 32);

    useEffect(() => {
        if (isRecording) {
            recordingPulsate.value = withTiming(
                1.2,
                { duration: 500, easing: Easing.inOut(Easing.ease) },
                (finished) => {
                    if (finished)
                        recordingPulsate.value = withTiming(1, {
                            duration: 500,
                            easing: Easing.inOut(Easing.ease),
                        });
                }
            );
            const interval = setInterval(() => {
                recordingPulsate.value = withTiming(
                    1.2,
                    { duration: 500, easing: Easing.inOut(Easing.ease) },
                    (finished) => {
                        if (finished)
                            recordingPulsate.value = withTiming(1, {
                                duration: 500,
                                easing: Easing.inOut(Easing.ease),
                            });
                    }
                );
            }, 1000);
            return () => clearInterval(interval);
        } else {
            recordingPulsate.value = 1;
        }
    }, [isRecording]);

    const recordingPulseStyle = useAnimatedStyle(
        () => ({
            transform: [{ scale: isRecording ? recordingPulsate.value : micScale.value }],
            backgroundColor: isRecording
                ? interpolateColor(
                      recordingPulsate.value,
                      [1, 1.2],
                      ['rgba(188, 0, 42, 0.5)', 'rgba(188, 0, 42, 0.8)']
                  )
                : 'transparent',
        }),
        [isRecording]
    );

    const slideToCancelStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: recordingTranslateX.value / 4 }],
        opacity: interpolate(recordingTranslateX.value, [-60, 0], [0, 1], Extrapolation.CLAMP),
    }));

    const cancelTextAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: recordingTranslateX.value / 3 }],
        opacity: interpolate(
            recordingTranslateX.value,
            [-120, -10],
            [0, 0.8],
            Extrapolation.CLAMP
        ),
    }));

    const deleteIconAnimatedStyle = useAnimatedStyle(() => {
        const absX = Math.abs(recordingTranslateX.value);
        const popProgress = interpolate(absX, [0, 40, 100], [0, 0.3, 1], Extrapolation.CLAMP);
        return {
            transform: [
                { scale: interpolate(popProgress, [0, 0.8, 1], [0, 1.2, 1], Extrapolation.CLAMP) },
                { rotate: `${interpolate(popProgress, [0, 1], [45, 0], Extrapolation.CLAMP)}deg` },
            ],
            opacity: interpolate(popProgress, [0, 1], [0, 1], Extrapolation.CLAMP),
            backgroundColor: interpolateColor(
                absX,
                [CANCEL_SWIPE_THRESHOLD - 20, CANCEL_SWIPE_THRESHOLD],
                ['rgba(255,255,255,0.08)', 'rgba(239, 68, 68, 0.2)']
            ),
        } as any;
    });

    const recordingMicAnimatedStyle = useAnimatedStyle(() => {
        const progress = Math.min(1, Math.abs(recordingTranslateX.value) / MIC_TRAVEL_FULL);
        return {
            transform: [
                { translateX: recordingTranslateX.value },
                {
                    scale: interpolate(
                        progress,
                        [0, 0.85, 0.95, 1],
                        [1, 1, 0.85, 0.2],
                        Extrapolation.CLAMP
                    ),
                },
            ] as any,
            opacity: interpolate(progress, [0, 0.96, 1], [1, 1, 0], Extrapolation.CLAMP),
            backgroundColor: interpolateColor(
                progress,
                [0, 0.8, 1],
                [accent, accentSoftResolved, '#ef4444']
            ),
        } as any;
    });

    const recordingWaveAnimatedStyle = useAnimatedStyle(() => {
        const progress = Math.min(1, Math.abs(recordingTranslateX.value) / MIC_TRAVEL_FULL);
        return {
            opacity: interpolate(progress, [0, 0.75, 1], [1, 0.45, 0.08], Extrapolation.CLAMP),
            transform: [
                { scaleX: interpolate(progress, [0, 1], [1, 0.92], Extrapolation.CLAMP) },
            ],
        };
    });

    // ─── Recording lifecycle ───────────────────────────────────────────
    const handleSendAudio = useCallback(
        async (uri: string, duration?: number) => {
            if (!messageKey) return;
            try {
                const media: Message['media'] = { type: 'audio', url: '', duration };
                sendChatMessage(messageKey, '', media, undefined, uri);
            } catch (error: any) {
                showSoulAlert('Send Failed', error?.message || 'Please try again.');
            }
        },
        [messageKey, sendChatMessage, showSoulAlert]
    );

    const startRecording = useCallback(async () => {
        if (isPreparingRecordingRef.current || isStoppingRecordingRef.current) return;
        isPreparingRecordingRef.current = true;
        pendingStopAfterPrepareRef.current = null;
        try {
            if (recordingRef.current) {
                try {
                    await recordingRef.current.stopAndUnloadAsync();
                } catch {}
                recordingRef.current = null;
            }
            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
                recordingTimerRef.current = null;
            }
            setIsRecording(false);

            const permission = await Audio.requestPermissionsAsync();
            if (permission.status !== 'granted') {
                showSoulAlert(
                    'Permission required',
                    'Please enable microphone access to record voice notes.'
                );
                isPreparingRecordingRef.current = false;
                return;
            }

            // Reset, then forcibly take the audio session. DoNotMix +
            // !staysActiveInBackground convinces iOS to hand the session over
            // even when a YouTube WebView (theater) or other module is
            // currently holding it.
            try {
                await Audio.setAudioModeAsync({
                    allowsRecordingIOS: false,
                    playsInSilentModeIOS: true,
                    staysActiveInBackground: false,
                    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
                    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
                });
            } catch {}

            // Give iOS a tick to release the previous session before we ask
            // for the recording category. Without this delay, the activate
            // call races with the WebView's audio session and bails out with
            // "experience is in the background".
            await new Promise((resolve) => setTimeout(resolve, 80));

            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
                staysActiveInBackground: false,
                interruptionModeIOS: InterruptionModeIOS.DoNotMix,
                interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
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
                setRecordingDuration((prev) => prev + 1);
            }, 1000);
            recording.setProgressUpdateInterval(90);
            recording.setOnRecordingStatusUpdate((status: any) => {
                if (!status?.isRecording) return;
                if (typeof status?.metering === 'number') {
                    const normalized = Math.max(0, Math.min(1, (status.metering + 60) / 60));
                    setRecordingLevel((prev) => prev * 0.62 + normalized * 0.38);
                } else {
                    setRecordingLevel((prev) => Math.max(0.08, prev * 0.92));
                }
            });

            isPreparingRecordingRef.current = false;
            if (pendingStopAfterPrepareRef.current) {
                const { shouldSend } = pendingStopAfterPrepareRef.current;
                pendingStopAfterPrepareRef.current = null;
                await stopRecording(shouldSend);
            }
        } catch (err: any) {
            console.warn('[ChatComposer] Failed to start recording:', err?.message || err);
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
            // Friendly, theater-aware messaging instead of the raw expo error.
            const msg = String(err?.message || '');
            if (msg.includes('background') || msg.includes('audio session')) {
                showSoulAlert(
                    'Audio busy',
                    'Voice recording could not start because another player is using the audio. Pause the theater video and try again.'
                );
            } else {
                showSoulAlert('Recording', 'Could not start voice recording. Please try again.');
            }
        }
    }, [showSoulAlert]);

    const stopRecording = useCallback(
        async (shouldSend: boolean = true) => {
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
                    const durationMillis = status.durationMillis || recordingDuration * 1000;
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
                if (!err?.message?.includes('no valid audio data')) {
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
        },
        [recordingDuration, handleSendAudio]
    );

    const handleMicTouchStart = useCallback(
        (e: any) => {
            touchStartXRef.current = e.nativeEvent.pageX;
            cancelHapticJSRef.current = false;
            startRecording();
        },
        [startRecording]
    );

    const handleMicTouchMove = useCallback(
        (e: any) => {
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
        },
        [CANCEL_SWIPE_THRESHOLD, MIC_TRAVEL_FULL]
    );

    const handleMicTouchEnd = useCallback(
        (e: any) => {
            const dx = e.nativeEvent.pageX - touchStartXRef.current;
            const shouldCancel = dx < CANCEL_SWIPE_THRESHOLD;
            cancelHapticJSRef.current = false;

            if (shouldCancel) {
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
        },
        [CANCEL_SWIPE_THRESHOLD, MIC_TRAVEL_FULL, stopRecording]
    );

    // Cleanup any pending recording on unmount
    useEffect(() => {
        return () => {
            if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            if (recordingRef.current) {
                recordingRef.current.stopAndUnloadAsync().catch(() => {});
                recordingRef.current = null;
            }
        };
    }, []);

    // ─── Send + edit ──────────────────────────────────────────────────
    const handleSend = useCallback(() => {
        if (!inputText.trim() || !messageKey) return;

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        isTypingRef.current = false;
        try {
            sendTyping?.(false);
        } catch {}

        const content = inputText.trim();
        setInputText('');

        if (editingMessage) {
            onSaveEdit?.(content);
            return;
        }

        const nextMessageId = Crypto.randomUUID();
        const replyToId = replyingTo ? replyingTo.id : undefined;
        sendChatMessage(messageKey, content, undefined, replyToId, undefined, nextMessageId);
        if (replyingTo) onClearReply?.();
        onAfterSend?.();
    }, [
        inputText,
        messageKey,
        editingMessage,
        onSaveEdit,
        replyingTo,
        sendChatMessage,
        sendTyping,
        onClearReply,
        onAfterSend,
    ]);

    // ─── + menu actions ───────────────────────────────────────────────
    const closeMenu = useCallback(() => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
    }, [isExpanded, toggleOptions]);

    const handleSelectCamera = useCallback(async () => {
        closeMenu();
        const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
        if (!permissionResult.granted) {
            showSoulAlert('Permission Required', 'Camera access is needed to take photos.');
            return;
        }
        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
            quality: 0.8,
            allowsEditing: false,
            videoMaxDuration: 600,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const type = asset.type === 'video' ? 'video' : 'image';
            setMediaPreview([{ uri: asset.uri, type }]);
        }
    }, [closeMenu, showSoulAlert]);

    const handleSelectGallery = useCallback(async () => {
        closeMenu();
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
            quality: 0.8,
            allowsEditing: false,
            allowsMultipleSelection: true,
            videoMaxDuration: 600,
            legacy: true,
            preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
            const items: MediaItem[] = result.assets.map((asset) => ({
                uri: asset.uri,
                type: asset.type === 'video' ? 'video' : 'image',
            }));
            setMediaPreview(items);
        }
    }, [closeMenu]);

    const handleSelectDocument = useCallback(async () => {
        closeMenu();
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
                multiple: true,
            });
            if (!result.canceled && result.assets && result.assets.length > 0) {
                const items: MediaItem[] = result.assets.map((asset) => ({
                    uri: asset.uri,
                    type: 'file',
                    name: asset.name,
                }));
                setMediaPreview(items);
            }
        } catch (error) {
            console.error('[ChatComposer] Document picking failed:', error);
            showSoulAlert('Error', 'Failed to pick document');
        }
    }, [closeMenu, showSoulAlert]);

    const handleSelectContact = useCallback(() => {
        closeMenu();
        showSoulAlert('Coming Soon', 'Contact sharing will be available soon.');
    }, [closeMenu, showSoulAlert]);

    const handleStartTheater = useCallback(() => {
        closeMenu();
        if (!messageKey) return;
        router.push({
            pathname: '/theater/picker' as any,
            params: { chatId: messageKey, contactName: contactName || '' },
        });
    }, [closeMenu, messageKey, contactName, router]);

    // ─── Send media (mirrors chat screen handleSendMedia) ─────────────
    const handleSendMedia = useCallback(
        async (mediaList: MediaItem[], caption?: string) => {
            if (!mediaList || mediaList.length === 0 || !messageKey) return;
            try {
                const preparedItems: any[] = [];
                for (let i = 0; i < mediaList.length; i++) {
                    const item = mediaList[i];
                    let thumbnail: string | undefined;
                    let finalUri = item.uri;

                    try {
                        if (item.type === 'video') {
                            if (finalUri.startsWith('content://')) {
                                const extFromName = item.name?.split('.').pop()?.toLowerCase();
                                const extFromUri = finalUri
                                    .split('.')
                                    .pop()
                                    ?.split('?')[0]
                                    ?.toLowerCase();
                                const extension = extFromName || extFromUri || 'mp4';
                                const localCopyPath = `${cacheDirectory}chat-video-${Date.now()}-${i}.${extension}`;
                                await copyAsync({ from: finalUri, to: localCopyPath });
                                finalUri = localCopyPath;
                            }

                            const info = await getInfoAsync(item.uri);
                            const resolvedInfo =
                                finalUri !== item.uri ? await getInfoAsync(finalUri) : info;
                            const sizeBytes = (resolvedInfo as any)?.size || 0;
                            const sizeMB = sizeBytes / (1024 * 1024);
                            if (sizeBytes > 500 * 1024 * 1024) {
                                throw new Error(
                                    `Video is too large (${sizeMB.toFixed(1)}MB). Please send a video under 500MB.`
                                );
                            }
                        }

                        if (item.type === 'video') {
                            try {
                                const VideoThumbnails = require('expo-video-thumbnails');
                                if (
                                    VideoThumbnails &&
                                    typeof VideoThumbnails.getThumbnailAsync === 'function'
                                ) {
                                    const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(
                                        finalUri,
                                        { time: 1000, quality: 0.6 }
                                    );
                                    const thumbResult = await ImageManipulator.manipulateAsync(
                                        thumbUri,
                                        [{ resize: { width: 160 } }],
                                        {
                                            compress: 0.4,
                                            format: ImageManipulator.SaveFormat.JPEG,
                                            base64: true,
                                        }
                                    );
                                    thumbnail = `data:image/jpeg;base64,${thumbResult.base64}`;
                                }
                            } catch (err) {
                                console.warn('[ChatComposer] Video thumbnail generation failed:', err);
                            }
                        }

                        if (item.type === 'image') {
                            const thumbResult = await ImageManipulator.manipulateAsync(
                                item.uri,
                                [{ resize: { width: 160 } }],
                                {
                                    compress: 0.45,
                                    format: ImageManipulator.SaveFormat.JPEG,
                                    base64: true,
                                }
                            );
                            thumbnail = `data:image/jpeg;base64,${thumbResult.base64}`;

                            const compressed = await ImageManipulator.manipulateAsync(
                                item.uri,
                                [{ resize: { width: 1280 } }],
                                { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
                            );
                            finalUri = compressed.uri;
                        }
                    } catch (thumbErr) {
                        console.warn('[ChatComposer] Media processing failed:', thumbErr);
                    }

                    preparedItems.push({
                        type: item.type === 'file' ? 'file' : item.type,
                        url: '',
                        localFileUri: finalUri,
                        thumbnail,
                        name: item.name,
                    });
                }

                const isGrouped = preparedItems.length > 1;
                if (isGrouped) {
                    const media: Message['media'] = {
                        type: 'image',
                        url: '',
                        caption: caption || undefined,
                        thumbnail: `${MEDIA_GROUP_MARKER}${JSON.stringify(preparedItems)}`,
                    } as any;
                    await sendChatMessage(
                        messageKey,
                        caption || '',
                        media,
                        undefined,
                        preparedItems[0].localFileUri
                    );
                } else {
                    const single = preparedItems[0];
                    const media: Message['media'] = {
                        type: single.type as any,
                        url: '',
                        caption: caption || undefined,
                        thumbnail: single.thumbnail,
                        name: single.name,
                    } as any;
                    await sendChatMessage(
                        messageKey,
                        caption || '',
                        media,
                        undefined,
                        single.localFileUri
                    );
                }
                setMediaPreview(null);
                onAfterSend?.();
            } catch (error: any) {
                showSoulAlert('Send Failed', error?.message || 'Please try again.');
            }
        },
        [messageKey, sendChatMessage, showSoulAlert, onAfterSend]
    );

    const menuOptions = useMemo(() => {
        const items: {
            name: string;
            label: string;
            color: string;
            bg: string;
            action: () => void;
            selected?: boolean;
        }[] = [];
        if (enableTheaterAction || theaterActionSelected) {
            items.push({
                name: 'movie',
                label: 'Theater',
                color: '#ff0080',
                bg: 'rgba(255, 0, 128, 0.14)',
                action: theaterActionSelected ? () => {} : handleStartTheater,
                selected: theaterActionSelected,
            });
        }
        items.push(
            {
                name: 'photo-camera',
                label: 'Camera',
                color: '#f43f5e',
                bg: 'rgba(244, 63, 94, 0.12)',
                action: handleSelectCamera,
            },
            {
                name: 'photo-library',
                label: 'Gallery',
                color: '#60a5fa',
                bg: 'rgba(96, 165, 250, 0.12)',
                action: handleSelectGallery,
            },
            {
                name: 'insert-drive-file',
                label: 'Document',
                color: '#4ade80',
                bg: 'rgba(74, 222, 128, 0.12)',
                action: handleSelectDocument,
            },
            {
                name: 'person-outline',
                label: 'Contact',
                color: 'rgba(255,255,255,0.85)',
                bg: 'rgba(255,255,255,0.06)',
                action: handleSelectContact,
            }
        );
        return items;
    }, [
        enableTheaterAction,
        theaterActionSelected,
        handleStartTheater,
        handleSelectCamera,
        handleSelectGallery,
        handleSelectDocument,
        handleSelectContact,
    ]);

    return (
        <View style={[styles.composerRoot, style]}>
            {isOtherTyping && (
                <Animated.View
                    entering={FadeInDown}
                    exiting={FadeOutDown}
                    style={styles.typingIndicatorWrapper}
                >
                    <View style={styles.typingBubbleMini}>
                        <TypingDots />
                    </View>
                </Animated.View>
            )}

            {editingMessage && (
                <GlassView intensity={35} tint="dark" style={styles.replyPreview}>
                    <View style={styles.replyContent}>
                        <MaterialIcons
                            name="edit"
                            size={16}
                            color={accent}
                            style={{ marginRight: 8 }}
                        />
                        <View style={styles.replyTextContainer}>
                            <Text style={[styles.replySender, { color: accent }]}>Editing</Text>
                            <Text numberOfLines={1} style={styles.replyText}>
                                {editingMessage.text || 'Media'}
                            </Text>
                        </View>
                        <Pressable
                            onPress={() => {
                                setInputText('');
                                onClearEdit?.();
                            }}
                        >
                            <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.7)" />
                        </Pressable>
                    </View>
                </GlassView>
            )}

            {replyingTo && (
                <GlassView intensity={35} tint="dark" style={styles.replyPreview}>
                    <View style={styles.replyContent}>
                        <View style={[ChatStyles.quoteBar, { backgroundColor: accent }]} />
                        <View style={styles.replyTextContainer}>
                            <Text style={[styles.replySender, { color: accent }]}>
                                {replyingTo.sender === 'me' ? 'You' : contactName || 'Them'}
                            </Text>
                            <Text numberOfLines={1} style={styles.replyText}>
                                {replyingTo.text || 'Media'}
                            </Text>
                        </View>
                        <Pressable onPress={() => onClearReply?.()} style={{ padding: 4 }}>
                            <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                        </Pressable>
                    </View>
                </GlassView>
            )}

            <View style={styles.inputAreaRow}>
                {/* Spacer reserves room for the absolutely-positioned morphing button */}
                <View style={{ width: 44, height: 44, marginRight: 6 }} />

                <View style={[styles.unifiedPillContainer, isRecording && { opacity: 0 }]}>
                    <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
                    <View style={styles.inputWrapper}>
                        <TextInput
                            ref={inputRef}
                            style={styles.input}
                            value={inputText}
                            onChangeText={(text) => {
                                setInputText(text);
                                if (!isTypingRef.current) {
                                    isTypingRef.current = true;
                                    try {
                                        sendTyping?.(true);
                                    } catch {}
                                }
                                if (typingTimeoutRef.current)
                                    clearTimeout(typingTimeoutRef.current);
                                typingTimeoutRef.current = setTimeout(() => {
                                    isTypingRef.current = false;
                                    try {
                                        sendTyping?.(false);
                                    } catch {}
                                }, 2000);
                            }}
                            placeholder="Message"
                            placeholderTextColor="rgba(255,255,255,0.3)"
                            multiline
                            onFocus={handleFocus}
                        />
                    </View>
                </View>

                <Animated.View
                    style={[styles.morphingMenuContainer, animatedMorphStyle, { zIndex: 9999 }]}
                >
                    <PressableFlash
                        style={StyleSheet.absoluteFill}
                        borderRadius={22}
                        flashColor={accent}
                        onPress={toggleOptions}
                    >
                        <GlassView intensity={65} tint="dark" style={StyleSheet.absoluteFill} />
                        <View style={styles.morphingInnerContent}>
                            <View style={styles.persistentToggleArea}>
                                <Animated.View style={animatedIconRotation}>
                                    <MaterialIcons
                                        name={isExpanded ? 'close' : 'add'}
                                        size={26}
                                        color={
                                            isExpanded
                                                ? 'rgba(255,255,255,0.4)'
                                                : 'rgba(255,255,255,0.8)'
                                        }
                                    />
                                </Animated.View>
                            </View>

                            <Animated.View
                                style={[styles.menuItemsList, animatedContentOpacity]}
                                pointerEvents={isExpanded ? 'auto' : 'none'}
                            >
                                {menuOptions.map((opt, idx, arr) => (
                                    <React.Fragment key={opt.label}>
                                        <Pressable
                                            style={[
                                                styles.optionItem,
                                                opt.selected && styles.optionItemSelected,
                                            ]}
                                            accessibilityState={{ selected: !!opt.selected }}
                                            onPress={(e) => {
                                                e.stopPropagation();
                                                if (opt.selected) return;
                                                opt.action();
                                                toggleOptions();
                                            }}
                                        >
                                            <View
                                                style={[
                                                    styles.optionIcon,
                                                    { backgroundColor: opt.bg },
                                                    opt.selected && {
                                                        borderColor: opt.color,
                                                        borderWidth: 1,
                                                    },
                                                ]}
                                            >
                                                <MaterialIcons
                                                    name={opt.name as any}
                                                    size={22}
                                                    color={opt.color}
                                                />
                                            </View>
                                            <Text
                                                style={[
                                                    styles.optionText,
                                                    opt.selected && {
                                                        color: opt.color,
                                                        fontWeight: '700',
                                                    },
                                                ]}
                                            >
                                                {opt.label}
                                            </Text>
                                            {opt.selected ? (
                                                <MaterialIcons
                                                    name="check-circle"
                                                    size={18}
                                                    color={opt.color}
                                                    style={styles.optionSelectedIcon}
                                                />
                                            ) : null}
                                        </Pressable>
                                        {idx < arr.length - 1 && (
                                            <View style={styles.optionDivider} />
                                        )}
                                    </React.Fragment>
                                ))}
                            </Animated.View>
                        </View>
                    </PressableFlash>
                </Animated.View>

                {inputText.trim() ? (
                    <PressableFlash
                        style={styles.sendButton}
                        borderRadius={22}
                        flashColor={accent}
                        onPress={handleSend}
                    >
                        <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
                        <MaterialIcons name="arrow-upward" size={22} color="#fff" />
                    </PressableFlash>
                ) : (
                    <View
                        onTouchStart={handleMicTouchStart}
                        onTouchMove={handleMicTouchMove}
                        onTouchEnd={handleMicTouchEnd}
                        style={isRecording ? { opacity: 0 } : {}}
                    >
                        <Animated.View style={[styles.sendButton, recordingPulseStyle]}>
                            <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
                            <MaterialIcons
                                name="mic"
                                size={22}
                                color={isRecording ? '#fff' : 'rgba(255,255,255,0.7)'}
                            />
                        </Animated.View>
                    </View>
                )}

                {isRecording && (
                    <Animated.View
                        style={[
                            StyleSheet.absoluteFill,
                            {
                                flexDirection: 'row',
                                alignItems: 'center',
                                paddingHorizontal: 4,
                                zIndex: 10,
                            },
                        ]}
                    >
                        <Animated.View style={[styles.deleteIconWrap, deleteIconAnimatedStyle]}>
                            <MaterialIcons name="delete-outline" size={24} color="#ef4444" />
                        </Animated.View>
                        <Animated.View
                            style={[
                                styles.deleteIconWrap,
                                deleteIconAnimatedStyle,
                                {
                                    position: 'absolute',
                                    left: 4,
                                    backgroundColor: 'transparent',
                                },
                            ]}
                        >
                            <MaterialIcons name="delete" size={24} color="#ef4444" />
                        </Animated.View>

                        <View
                            style={{
                                flex: 1,
                                flexDirection: 'row',
                                alignItems: 'center',
                                backgroundColor: 'rgba(18, 16, 26, 0.4)',
                                borderRadius: 24,
                                height: 44,
                                marginHorizontal: 4,
                                paddingHorizontal: 12,
                                borderWidth: 1.2,
                                borderColor: 'rgba(255,255,255,0.22)',
                                overflow: 'hidden',
                            }}
                        >
                            <GlassView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
                            <Animated.View
                                style={[styles.recordingIndicator, recordingPulseStyle]}
                            />
                            <Text style={styles.recordingTimer}>
                                {formatDuration(recordingDuration)}
                            </Text>

                            <View style={{ flex: 1, paddingHorizontal: 8, justifyContent: 'center' }}>
                                <Animated.View
                                    style={[
                                        {
                                            position: 'absolute',
                                            width: '100%',
                                            alignItems: 'center',
                                        },
                                        cancelTextAnimatedStyle,
                                    ]}
                                >
                                    <Text
                                        style={{
                                            color: 'rgba(255,255,255,0.4)',
                                            fontSize: 13,
                                            fontWeight: '500',
                                        }}
                                    >
                                        Slide to cancel
                                    </Text>
                                </Animated.View>
                                <Animated.View style={recordingWaveAnimatedStyle}>
                                    <SiriWaveform
                                        level={recordingLevel}
                                        active={isRecording}
                                        themeColor={accent}
                                    />
                                </Animated.View>
                            </View>

                            <Animated.View style={[{ opacity: 0.4 }, slideToCancelStyle]}>
                                <MaterialIcons name="chevron-left" size={20} color="white" />
                            </Animated.View>
                        </View>

                        <Animated.View
                            style={[
                                styles.recordingMicIconWrap,
                                recordingMicAnimatedStyle,
                                {
                                    width: 44,
                                    height: 44,
                                    borderRadius: 22,
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                },
                            ]}
                        >
                            <MaterialIcons name="mic" size={24} color="#fff" />
                        </Animated.View>
                    </Animated.View>
                )}
            </View>

            <MediaPickerSheet
                visible={showMediaPicker}
                onClose={() => setShowMediaPicker(false)}
                onSelectCamera={handleSelectCamera}
                onSelectGallery={handleSelectGallery}
                onSelectAssets={(assets) => {
                    setShowMediaPicker(false);
                    const formattedAssets = assets.map((a) => ({
                        uri: a.uri,
                        type: a.mediaType === 'video' ? 'video' : 'image',
                    }));
                    setMediaPreview(formattedAssets as any);
                }}
                onSelectAudio={handleSelectDocument}
                onSelectNote={() => {
                    setShowMediaPicker(false);
                    showSoulAlert('Soul Notes', 'Leave a note from the Home screen!');
                }}
            />

            <MediaPreviewModal
                visible={!!mediaPreview && mediaPreview.length > 0}
                initialMediaItems={(mediaPreview as any) || undefined}
                onClose={() => setMediaPreview(null)}
                onSend={handleSendMedia as any}
                isUploading={isUploading}
            />

            <GlassAlert
                visible={alertConfig.visible}
                title={alertConfig.title}
                message={alertConfig.message}
                buttons={alertConfig.buttons}
                onClose={closeSoulAlert}
            />
        </View>
    );
});

ChatComposer.displayName = 'ChatComposer';

export default ChatComposer;

const styles = StyleSheet.create({
    composerRoot: {
        position: 'relative',
    },
    inputAreaRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
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
    morphingMenuContainer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        // Semi-opaque base under the GlassView blur so the menu reads as a
        // solid layer instead of letting whatever sits behind it (chat
        // bubbles, theater session card, video poster) bleed through.
        backgroundColor: 'rgba(14,14,18,0.82)',
        borderWidth: 1.2,
        borderColor: 'rgba(255, 255, 255, 0.15)',
        overflow: 'hidden',
        zIndex: 9999,
        elevation: 24,
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
        borderRadius: 18,
    },
    optionItemSelected: {
        backgroundColor: 'rgba(255, 0, 128, 0.08)',
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
        flex: 1,
    },
    optionSelectedIcon: {
        marginLeft: 10,
    },
    optionDivider: {
        height: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        marginLeft: 56,
        marginRight: 10,
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
    recordingMicIconWrap: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
    },
    typingIndicatorWrapper: {
        position: 'absolute',
        bottom: 85,
        left: 4,
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
});
