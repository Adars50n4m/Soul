import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, StatusBar,
    useWindowDimensions, Platform, Alert, AppState
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio as ExpoAudio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useNavigation } from 'expo-router';
import GlassView from '../components/ui/GlassView';
import { MaterialIcons, Ionicons, Entypo } from '@expo/vector-icons';
import ExpoPip from 'expo-pip';
import SingleChatScreen from './chat/[id]';

import { useApp } from '../context/AppContext';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withTiming,
    Easing,
    withSpring,
    runOnJS,
    interpolate
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useKeepAwake } from 'expo-keep-awake';
import { SoulAvatar } from '../components/SoulAvatar';
import { normalizeId } from '../utils/idNormalization';

// Load video renderers separately
const getVideoRenderModules = () => {
    try {
        const RTCViewModule = require('react-native-webrtc/lib/commonjs/RTCView');
        const RTCPIPViewModule = require('react-native-webrtc/lib/commonjs/RTCPIPView');
        return {
            RTCView: RTCViewModule.default,
            RTCPIPView: RTCPIPViewModule.default,
            startIOSPIP: RTCPIPViewModule.startIOSPIP,
            stopIOSPIP: RTCPIPViewModule.stopIOSPIP,
        };
    } catch (e: any) {
        console.log('[CallScreen] RTC video renderer not available:', e?.message || 'unknown');
        return { RTCView: null, RTCPIPView: null, startIOSPIP: null, stopIOSPIP: null };
    }
};

const getWebRTCService = () => {
    try {
        return require('../services/WebRTCService').webRTCService;
    } catch (e: any) {
        console.log('[CallScreen] WebRTC service not available:', e?.message || 'unknown');
        return null;
    }
};

const videoRenderModules = getVideoRenderModules();
const RTCView = videoRenderModules.RTCView;
const RTCPIPView = videoRenderModules.RTCPIPView;
const RemoteVideoComponent = RTCPIPView || RTCView; 
const startIOSPIP = videoRenderModules.startIOSPIP;
const stopIOSPIP = videoRenderModules.stopIOSPIP;
const webRTCService = getWebRTCService();

type CallState = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';
const IOS_CALL_INTERRUPTION_MODE = (InterruptionModeIOS as any)?.DoNotMix ?? 1;
const ANDROID_CALL_INTERRUPTION_MODE = (InterruptionModeAndroid as any)?.DoNotMix ?? 1;

const hexToRgba = (color: string, alpha: number): string => {
    if (!color || !color.startsWith('#')) return `rgba(255, 106, 136, ${alpha})`;
    let hex = color.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map((c) => `${c}${c}`).join('');
    const int = Number.parseInt(hex, 16);
    if (Number.isNaN(int)) return `rgba(255, 106, 136, ${alpha})`;
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export default function CallScreen() {
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const router = useRouter();
    const navigation = useNavigation();
    const { activeCall, contacts, currentUser, activeTheme, endCall: endAppCall, acceptCall: acceptAppCall, toggleMute: toggleAppMute, toggleVideo, toggleMinimizeCall } = useApp();
    useKeepAwake();

    const [callDuration, setCallDuration] = useState(0);
    const [localStream, setLocalStream] = useState<any>(null);
    const [remoteStreams, setRemoteStreams] = useState<Map<string, any>>(new Map());
    const [remoteStreamUpdate, setRemoteStreamUpdate] = useState(0);
    const isMinimizing = useRef(false);
    const rtcPipRef = useRef(null);
    const isMounted = useRef(false);

    const isVideo = activeCall?.type === 'video';
    const [callState, setCallState] = useState<CallState>(() => {
        // If the call is already accepted (e.g. we re-entered this screen or 
        // the acceptor clicked "Accept" already), start in 'connecting'
        if (activeCall?.isAccepted) return 'connecting';
        return 'ringing';
    });
    const [isSlowConnection, setIsSlowConnection] = useState(false);
    const [wasConnected, setWasConnected] = useState(false);
    const [isSpeaker, setIsSpeaker] = useState(() => activeCall?.type === 'video');
    const [isEdgeGlowEnabled, setIsEdgeGlowEnabled] = useState(false);
    const [androidIsInPipMode, setAndroidIsInPipMode] = useState(false);
    const [iosIsInPipMode, setIosIsInPipMode] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [stats, setStats] = useState({ bytesReceived: 0 });
    const [showLiveChat, setShowLiveChat] = useState(false);

    const hasRemoteTracks = useMemo(() => {
        if (remoteStreams.size === 0) return false;
        return Array.from(remoteStreams.values()).some((stream) => {
            try {
                return (stream.getAudioTracks?.() || []).length > 0 || 
                       (stream.getVideoTracks?.() || []).length > 0 || 
                       (stream.getTracks?.() || []).length > 0;
            } catch { return false; }
        });
    }, [remoteStreams, remoteStreamUpdate]);

    const uiConnected = wasConnected || callState === 'connected' || stats.bytesReceived > 0;

    useEffect(() => {
        if (callState === 'connecting') {
            const timer = setTimeout(() => setIsSlowConnection(true), 12000);
            return () => { clearTimeout(timer); setIsSlowConnection(false); };
        } else {
            setIsSlowConnection(false);
        }
    }, [callState]);

    useEffect(() => {
        const interval = setInterval(() => {
            if (!webRTCService) return;
            const svcState = webRTCService.getState();
            const svcRemotes = webRTCService.getRemoteStreams?.() || new Map();
            
            if (svcState === 'connected' && !wasConnected) {
                setWasConnected(true);
                setCallState('connected');
            }

            if (svcRemotes.size !== remoteStreams.size) {
                setRemoteStreams(new Map(svcRemotes));
                setRemoteStreamUpdate(prev => prev + 1);
            }
        }, 2000);
        return () => clearInterval(interval);
    }, [wasConnected, remoteStreams]);

    const canRenderVideo = !!RTCView && !!RemoteVideoComponent;
    const edgeGlowPulse = useSharedValue(0);
    const edgeGlowStrong = useMemo(() => hexToRgba(activeTheme?.accent || '#FF6A88', 0.65), [activeTheme?.accent]);
    const edgeGlowSoft = useMemo(() => hexToRgba(activeTheme?.accent || '#FF6A88', 0), [activeTheme?.accent]);

    useEffect(() => {
        if (isEdgeGlowEnabled && isVideo && uiConnected) {
            edgeGlowPulse.value = withRepeat(
                withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }),
                -1, true
            );
        } else {
            edgeGlowPulse.value = withTiming(0, { duration: 220 });
        }
    }, [isEdgeGlowEnabled, isVideo, uiConnected]);

    useEffect(() => {
        let timeout: NodeJS.Timeout;
        const subscription = AppState.addEventListener('change', nextAppState => {
            const isVideoCall = activeCall?.type === 'video' && activeCall?.isAccepted && !isMinimizing.current;
            
            if (nextAppState.match(/inactive|background/)) {
                if (isVideoCall) {
                    if (Platform.OS === 'ios') {
                        if (startIOSPIP && rtcPipRef.current) {
                            try { startIOSPIP(rtcPipRef); } catch (e) { console.warn('startIOSPIP error:', e); }
                        }
                        timeout = setTimeout(() => setIosIsInPipMode(true), 150);
                    } else if (Platform.OS === 'android') {
                        if (typeof ExpoPip?.enterPipMode !== 'function') {
                            console.log('[CallScreen] Android PiP unavailable in this build.');
                        } else {
                            try {
                                ExpoPip.enterPipMode({
                                    width: Math.floor(width),
                                    height: Math.floor(height),
                                    autoEnterEnabled: true
                                });
                                setAndroidIsInPipMode(true);
                            } catch (e) { setAndroidIsInPipMode(false); }
                        }
                    }
                }
            } else if (nextAppState === 'active') {
                if (Platform.OS === 'ios') {
                    setIosIsInPipMode(false);
                    if (stopIOSPIP) {
                        try { stopIOSPIP(rtcPipRef); } catch (e) { console.warn('stopIOSPIP error:', e); }
                    }
                } else {
                    setAndroidIsInPipMode(false);
                }
            }
        });
        return () => subscription.remove();
    }, [activeCall?.isAccepted, activeCall?.type, width, height]);

    const isInPipMode = Platform.OS === 'android' ? androidIsInPipMode : iosIsInPipMode;

    const contact = useMemo(() => {
        const normalizedId = normalizeId(activeCall?.contactId);
        return contacts.find(c => normalizeId(c.id) === normalizedId) || {
            id: activeCall?.contactId || '',
            name: activeCall?.contactName || 'User',
            avatar: activeCall?.avatar || '',
        };
    }, [contacts, activeCall]);

    const handleMinimize = useCallback(() => {
        isMinimizing.current = true;
        toggleMinimizeCall(true);
        if (navigation.canGoBack()) navigation.goBack();
    }, [navigation, toggleMinimizeCall]);

    const ensureMicrophoneAccess = useCallback(async (): Promise<boolean> => {
        try {
            if (webRTCService?.ensureMicrophonePermission) {
                const granted = await webRTCService.ensureMicrophonePermission(true);
                if (!granted) {
                    Alert.alert(
                        'Microphone Permission Needed',
                        'Voice call ke liye microphone permission allow karna zaroori hai.'
                    );
                }
                return granted;
            }

            const permission = await ExpoAudio.requestPermissionsAsync();
            if (!permission.granted) {
                Alert.alert(
                    'Microphone Permission Needed',
                    'Voice call ke liye microphone permission allow karna zaroori hai.'
                );
                return false;
            }
            return true;
        } catch (error) {
            console.warn('[CallScreen] Failed to request microphone permission:', error);
            return false;
        }
    }, []);

    const applySpeakerOutput = useCallback(async (useSpeaker: boolean, manualOverride: boolean = true): Promise<boolean> => {
        try {
            if (webRTCService?.setAudioOutput) {
                await webRTCService.setAudioOutput(useSpeaker, manualOverride);
            } else {
                await ExpoAudio.setAudioModeAsync({
                    allowsRecordingIOS: true,
                    playsInSilentModeIOS: true,
                    staysActiveInBackground: true,
                    interruptionModeIOS: IOS_CALL_INTERRUPTION_MODE,
                    shouldDuckAndroid: false,
                    interruptionModeAndroid: ANDROID_CALL_INTERRUPTION_MODE,
                    playThroughEarpieceAndroid: !useSpeaker,
                });
                const InCallManager = require('react-native-incall-manager').default;
                InCallManager.setSpeakerphoneOn(useSpeaker);
                if (Platform.OS === 'ios') InCallManager.setForceSpeakerphoneOn(useSpeaker);
            }

            setIsSpeaker(useSpeaker);
            return true;
        } catch (error) {
            console.warn('[CallScreen] Failed to apply speaker output:', error);
            return false;
        }
    }, []);

    const handleToggleMute = useCallback(() => toggleAppMute(), [toggleAppMute]);
    const handleToggleVideo = useCallback(() => toggleVideo?.(), [toggleVideo]);
    const handleToggleEdgeGlow = useCallback(() => isVideo && setIsEdgeGlowEnabled(prev => !prev), [isVideo]);
    const handleToggleSpeaker = useCallback(async () => {
        await applySpeakerOutput(!isSpeaker, true);
    }, [isSpeaker, applySpeakerOutput]);
    const handleSwitchCamera = useCallback(() => webRTCService?.switchCamera(), []);

    const handleAcceptCall = useCallback(async () => {
        try { await acceptAppCall(); } catch (e) { console.error(e); }
    }, [acceptAppCall]);

    const selfVideoX = useSharedValue(width - 130);
    const selfVideoY = useSharedValue(120);
    const screenTranslateY = useSharedValue(0);
    const savedSelfVideoPos = useRef<{ x: number; y: number } | null>(null);

    const panGesture = Gesture.Pan()
        .enabled(!showLiveChat)
        .onUpdate((event) => {
            selfVideoX.value = event.translationX + (width - 130);
            selfVideoY.value = event.translationY + 120;
        })
        .onEnd(() => {
            selfVideoX.value = withSpring(selfVideoX.value < width / 2 ? 20 : width - 130);
            selfVideoY.value = withSpring(Math.max(100, Math.min(height - 250, selfVideoY.value)));
        });

    // Tuck self-video into a safe spot (below close button, above chat) while the
    // Live Chat overlay is open, then restore the user's previous position on close.
    useEffect(() => {
        if (showLiveChat) {
            savedSelfVideoPos.current = { x: selfVideoX.value, y: selfVideoY.value };
            selfVideoX.value = withSpring(20);
            selfVideoY.value = withSpring(Math.max(insets.top + 70, 100));
        } else if (savedSelfVideoPos.current) {
            selfVideoX.value = withSpring(savedSelfVideoPos.current.x);
            selfVideoY.value = withSpring(savedSelfVideoPos.current.y);
            savedSelfVideoPos.current = null;
        }
    }, [showLiveChat, insets.top]);

    const selfVideoStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: selfVideoX.value } as any,
            { translateY: selfVideoY.value } as any
        ]
    }));

    const screenPanGesture = Gesture.Pan()
        .enabled(!showLiveChat)
        .onUpdate((event) => { if (event.translationY > 0) screenTranslateY.value = event.translationY; })
        .onEnd((event) => {
            if (event.translationY > 150) runOnJS(handleMinimize)();
            else screenTranslateY.value = withSpring(0);
        });

    const screenStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: screenTranslateY.value }],
        borderRadius: Platform.OS === 'android' ? (screenTranslateY.value > 10 ? 30 : 0) : interpolate(screenTranslateY.value, [0, 200], [0, 40]),
        overflow: 'hidden',
        flex: 1,
    }));

    const edgeGlowStyle = useAnimatedStyle(() => ({ opacity: edgeGlowPulse.value }));

    // NEW: Mesh Background Animation
    const meshP1 = useSharedValue(0);
    const meshP2 = useSharedValue(0);
    const meshP3 = useSharedValue(0);

    const meshStyle1 = useAnimatedStyle(() => ({
        transform: [
            { translateX: interpolate(meshP1.value, [0, 1], [-width * 0.25, width * 0.25]) },
            { translateY: interpolate(meshP2.value, [0, 1], [-height * 0.1, height * 0.1]) },
            { rotate: `${meshP1.value * 360}deg` }
        ],
        opacity: 0.35
    }));

    const meshStyle2 = useAnimatedStyle(() => ({
        transform: [
            { translateX: interpolate(meshP2.value, [0, 1], [width * 0.2, -width * 0.2]) },
            { translateY: interpolate(meshP3.value, [0, 1], [height * 0.15, -height * 0.15]) },
            { rotate: `${-meshP2.value * 360}deg` }
        ],
        opacity: 0.3
    }));

    const meshStyle3 = useAnimatedStyle(() => ({
        transform: [
            { translateX: interpolate(meshP3.value, [0, 1], [-width * 0.15, width * 0.15]) },
            { translateY: interpolate(meshP1.value, [0, 1], [height * 0.2, -height * 0.2]) },
            { rotate: `${meshP3.value * 360}deg` }
        ],
        opacity: 0.25
    }));

    useEffect(() => {
        meshP1.value = withRepeat(withTiming(1, { duration: 9000, easing: Easing.inOut(Easing.sin) }), -1, true);
        meshP2.value = withRepeat(withTiming(1, { duration: 12000, easing: Easing.inOut(Easing.quad) }), -1, true);
        meshP3.value = withRepeat(withTiming(1, { duration: 15000, easing: Easing.inOut(Easing.exp) }), -1, true);
    }, []);

    // Mount guard: set isMounted after the first render to prevent navigating
    // before the Root Layout navigator is ready (causes "navigate before mount" crash).
    useEffect(() => {
        isMounted.current = true;
        return () => { isMounted.current = false; };
    }, []);

    useEffect(() => {
        if (!isMounted.current) return;
        if (!activeCall && !isMinimizing.current) {
            if (navigation.canGoBack()) {
                navigation.goBack();
            } else {
                router.replace('/(tabs)');
            }
        }
    }, [activeCall, router]);

    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const statusLabel = useMemo(() => {
        if (uiConnected) {
            return formatDuration(callDuration);
        }
        if (activeCall?.isIncoming && !activeCall?.isAccepted) {
            return 'Incoming call...';
        }
        if (activeCall?.isRinging || callState === 'ringing') {
            return 'Ringing...';
        }
        return 'Connecting...';
    }, [activeCall?.isAccepted, activeCall?.isIncoming, activeCall?.isRinging, callDuration, callState, uiConnected]);

    const handleEndCall = useCallback(() => {
        setLocalStream(null);
        setRemoteStreams(new Map());
        endAppCall();
    }, [endAppCall]);

    const pulseScale = useSharedValue(1);
    const pulseOpacity = useSharedValue(0.5);

    useEffect(() => {
        if (callState === 'ringing' || callState === 'connecting') {
            pulseScale.value = withRepeat(
                withSpring(1.4, { damping: 12, stiffness: 60 }),
                -1,
                true
            );
            pulseOpacity.value = withRepeat(
                withTiming(0, { duration: 1800, easing: Easing.out(Easing.quad) }),
                -1,
                false
            );
        } else {
            pulseScale.value = withSpring(1);
            pulseOpacity.value = withTiming(0);
        }
    }, [callState]);

    const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulseScale.value }], opacity: pulseOpacity.value }));

    const restoreMusicAudioMode = useCallback(async () => {
        try {
            await ExpoAudio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                interruptionModeIOS: IOS_CALL_INTERRUPTION_MODE,
                shouldDuckAndroid: true,
                interruptionModeAndroid: ANDROID_CALL_INTERRUPTION_MODE,
                playThroughEarpieceAndroid: false,
            });
        } catch (e) { console.warn(e); }
    }, []);

    // Audio session management is now handled centrally by WebRTCService
    // to prevent hardware conflicts during transition from music to call.

    // PIP params — separate effect that CAN re-run on activeCall changes
    useEffect(() => {
        if (activeCall?.isAccepted && Platform.OS === 'android' && typeof ExpoPip?.setPictureInPictureParams === 'function') {
            try {
                ExpoPip.setPictureInPictureParams({
                    autoEnterEnabled: true,
                    width: Math.floor(width),
                    height: Math.floor(width * 1.5)
                });
            } catch (e) {}
        }
    }, [activeCall?.isAccepted, width]);

    useEffect(() => {
        if (!activeCall) return;
        const audioOutput = webRTCService?.getAudioOutput?.();
        if (audioOutput === 'speaker' || audioOutput === 'earpiece') {
            setIsSpeaker(audioOutput === 'speaker');
            return;
        }
        setIsSpeaker(activeCall.type === 'video');
    }, [activeCall, callState]);

    // WebRTC init — runs once per call session (callId/roomId)
    const initializedCallSessionRef = useRef<string | null>(null);
    useEffect(() => {
        if (!activeCall) {
            initializedCallSessionRef.current = null;
            return;
        }

        const sessionKey = activeCall.callId || activeCall.roomId;
        if (!sessionKey || initializedCallSessionRef.current === sessionKey) return;
        initializedCallSessionRef.current = sessionKey;

        setWasConnected(false);
        setCallDuration(0);
        setStats({ bytesReceived: 0 });
        setCallState(activeCall.isAccepted ? 'connecting' : 'ringing');
        setLocalStream(null);
        setRemoteStreams(new Map());

        // Capture values at init time so we don't depend on activeCall object
        const callType = activeCall.type;
        const isIncoming = activeCall.isIncoming;
        const callId = activeCall.callId || activeCall.roomId || sessionKey;

        const listener = {
            onStateChange: (s: any) => {
                setCallState(s);
                const output = webRTCService?.getAudioOutput?.();
                if (output === 'speaker' || output === 'earpiece') {
                    setIsSpeaker(output === 'speaker');
                }
                if (s === 'connected') {
                    try {
                        const { nativeCallBridge } = require('../services/NativeCallBridge');
                        nativeCallBridge.reportWebRTCConnected(callId, callType);
                    } catch (_) {}
                }
            },
            onLocalStream: (s: any) => setLocalStream(s),
            onRemoteStream: (s: any, userId: string) => { 
                setRemoteStreams(prev => {
                    const next = new Map(prev);
                    if (s) next.set(userId, s);
                    else next.delete(userId);
                    return next;
                });
                setRemoteStreamUpdate(v => v+1); 
            },
            onStats: (st: any) => setStats(prev => ({ ...prev, ...st })),
        };

        webRTCService?.addListener(listener);
        let cancelled = false;

        const init = async () => {
            try {
                const hasMicPermission = await ensureMicrophoneAccess();
                if (cancelled) return;
                if (!hasMicPermission) {
                    if (!isIncoming) {
                        handleEndCall();
                    }
                    return;
                }

                const defaultSpeaker = callType === 'video';
                await applySpeakerOutput(defaultSpeaker, false);

                // Group call support: check if activeCall has a groupId
                const isGroup = !!activeCall.groupId;

                if (isIncoming && webRTCService?.isCallActive()) {
                    console.log('[CallScreen] WebRTC already active for incoming call, skipping init');
                } else {
                    await webRTCService?.prepareCall(callType);
                    if (cancelled) return;
                    if (!isIncoming) {
                        await webRTCService?.startCall(callType, isGroup ? undefined : activeCall.contactId, isGroup ? activeCall.groupId : undefined);
                    }
                }
            } catch (e: any) {
                console.warn('[CallScreen] WebRTC init failed:', e?.message);
            }
        };
        void init();

        return () => {
            cancelled = true;
            webRTCService?.removeListener(listener);
            if (!isMinimizing.current) void restoreMusicAudioMode();
        };
    }, [activeCall?.callId, activeCall?.roomId, ensureMicrophoneAccess, applySpeakerOutput, handleEndCall, restoreMusicAudioMode]);

    useEffect(() => {
        if (uiConnected) {
            const interval = setInterval(() => setCallDuration(p => p + 1), 1000);
            return () => clearInterval(interval);
        }
    }, [uiConnected]);

    // If no active call, show nothing while navigation redirects to tabs
    if (!activeCall) return null;

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <GestureDetector gesture={screenPanGesture}>
                <Animated.View style={[styles.container, { backgroundColor: '#0F0F14', width, height }, screenStyle]}>
                    <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />

                    {/* 1. Background Media Layer */}
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0a0a0c' }]}>
                        {/* Dynamic Liquid Mesh */}
                        <Animated.View style={[StyleSheet.absoluteFill, meshStyle1]}>
                            <LinearGradient 
                                colors={[hexToRgba(activeTheme?.primary || '#BC002A', 0.45), 'transparent']} 
                                start={{x: 0, y: 0}} end={{x: 1, y: 1}} 
                                style={{ width: width * 1.6, height: width * 1.6, borderRadius: width * 0.8 }} 
                            />
                        </Animated.View>
                        <Animated.View style={[StyleSheet.absoluteFill, meshStyle2]}>
                            <LinearGradient 
                                colors={['transparent', hexToRgba(activeTheme?.accent || '#FF6A88', 0.35)]} 
                                start={{x: 1, y: 0}} end={{x: 0, y: 1}} 
                                style={{ width: width * 1.5, height: width * 1.5, borderRadius: width * 0.75, top: height * 0.3 }} 
                            />
                        </Animated.View>
                        <Animated.View style={[StyleSheet.absoluteFill, meshStyle3]}>
                            <LinearGradient 
                                colors={['transparent', hexToRgba('#4C6EF5', 0.25)]} 
                                start={{x: 0.5, y: 0}} end={{x: 0.5, y: 1}} 
                                style={{ width: width * 1.4, height: width * 1.4, borderRadius: width * 0.7, left: width * 0.2, top: -height * 0.1 }} 
                            />
                        </Animated.View>

                        {remoteStreams.size > 0 && activeCall?.isAccepted && isVideo ? (
                            <View style={styles.gridContainer}>
                                {Array.from(remoteStreams.entries()).map(([userId, stream], index) => {
                                    const remoteContact = contacts.find(c => normalizeId(c.id) === normalizeId(userId));
                                    const isVoiceOnly = (activeCall as any).participantsVideoOff?.includes(userId);
                                    
                                    return (
                                        <View key={userId} style={[
                                            styles.videoTile,
                                            remoteStreams.size === 1 ? styles.videoTileFull :
                                            remoteStreams.size === 2 ? styles.videoTileHalf :
                                            styles.videoTileQuarter
                                        ]}>
                                            {(canRenderVideo && !isVoiceOnly) ? (
                                                <RTCView
                                                    key={`${userId}-${remoteStreamUpdate}`}
                                                    streamURL={typeof stream.toURL === 'function' ? stream.toURL() : stream}
                                                    style={StyleSheet.absoluteFill}
                                                    objectFit="cover"
                                                />
                                            ) : (
                                                <View style={styles.tilePlaceholder}>
                                                    <SoulAvatar uri={remoteContact?.avatar} size={remoteStreams.size > 2 ? 60 : 100} />
                                                    <Text style={styles.tileName}>{remoteContact?.name || 'Participant'}</Text>
                                                </View>
                                            )}
                                            <View style={styles.participantNameTag}>
                                                <Text style={styles.participantNameText}>{remoteContact?.name || 'Participant'}</Text>
                                            </View>
                                        </View>
                                    );
                                })}
                            </View>
                        ) : (
                            !!contact.avatar && (
                                <Image 
                                    source={{ uri: contact.avatar }} 
                                    style={[styles.backgroundImage, { width, height }]} 
                                    blurRadius={isVideo ? 60 : 50} 
                                />
                            )
                        )}

                        <View style={[styles.overlay, { zIndex: 1, backgroundColor: 'rgba(5, 5, 8, 0.4)' }]} />
                    </View>

                    {/* 2. Edge Glow */}
                    {isEdgeGlowEnabled && isVideo && (
                        <Animated.View pointerEvents="none" style={[styles.edgeGlowContainer, edgeGlowStyle]}>
                            {Platform.OS === 'ios' ? (
                                <LinearGradient colors={[edgeGlowStrong, edgeGlowSoft]} style={StyleSheet.absoluteFill} />
                            ) : (
                                <View style={[StyleSheet.absoluteFill, { borderWidth: 8, borderColor: edgeGlowStrong, opacity: 0.4 }]} />
                            )}
                        </Animated.View>
                    )}

                    {!isInPipMode ? (
                        <View style={styles.content}>
                            {/* Header */}
                            {!showLiveChat && (
                                <View style={[styles.header, { marginTop: Math.max(insets.top, 20) }]}>
                                    <Pressable onPress={handleMinimize} style={styles.iconButton}>
                                        <MaterialIcons name="keyboard-arrow-down" size={32} color="white" />
                                    </Pressable>
                                    <View style={styles.securityBadge}>
                                        <MaterialIcons name="lock" size={12} color="rgba(255,255,255,0.6)" />
                                        <View style={styles.securityTextContainer}>
                                            <Text style={styles.securityText}>Soul End-to-End Encrypted</Text>
                                        </View>
                                    </View>
                                    <View style={{ width: 44 }} />
                                </View>
                            )}

                            {/* Center Info */}
                            {( (!isVideo || !uiConnected || activeCall?.remoteVideoOff)) && (
                                <View style={styles.mainInfo}>
                                    <View style={styles.avatarWrapper}>
                                        <Animated.View style={[styles.pulseRing, pulseStyle]} />
                                        <SoulAvatar uri={contact.avatar} size={170} />
                                    </View>
                                    <Text style={styles.contactName}>{contact.name}</Text>
                                    <Text style={styles.callStatus}>
                                        {statusLabel}
                                    </Text>
                                </View>
                            )}

                            {/* Self Video - stays visible during Live Chat so the user can still see their own feed */}
                            {(isVideo && uiConnected) && (
                                <GestureDetector gesture={panGesture}>
                                    <Animated.View style={[styles.selfVideoContainer, selfVideoStyle]}>
                                        {localStream && !activeCall?.isVideoOff && RTCView ? (
                                            <RTCView streamURL={typeof localStream.toURL === 'function' ? localStream.toURL() : localStream} style={styles.selfVideo} objectFit="cover" mirror zOrder={2} />
                                        ) : (
                                            <View style={styles.selfVideoPlaceholder}>
                                                <SoulAvatar uri={currentUser?.avatar} size={50} />
                                            </View>
                                        )}
                                    </Animated.View>
                                </GestureDetector>
                            )}

                            {/* Footer Controls */}
                            {!showLiveChat && (
                                <GlassView intensity={35} tint="dark" style={[styles.controlsBar, { marginBottom: Math.max(insets.bottom, 40) }]}>
                                    {callState !== 'connected' && activeCall?.isIncoming && !activeCall?.isAccepted ? (
                                        <View style={styles.incomingActionsRow}>
                                            <Pressable onPress={handleEndCall} style={[styles.controlBtn, {backgroundColor: '#ef4444'}]}><MaterialIcons name="call-end" size={28} color="white" /></Pressable>
                                            <Pressable onPress={handleAcceptCall} style={[styles.controlBtn, {backgroundColor: '#22c55e'}]}><MaterialIcons name="call" size={28} color="white" /></Pressable>
                                        </View>
                                    ) : (
                                        <View style={styles.controlsRow}>
                                            <Pressable style={[styles.controlBtn, activeCall?.isMuted && styles.controlBtnActive]} onPress={handleToggleMute}><Ionicons name={activeCall?.isMuted ? "mic-off" : "mic"} size={24} color={activeCall?.isMuted ? "#000" : "white"} /></Pressable>
                                            <Pressable style={[styles.controlBtn, isSpeaker && styles.controlBtnActive]} onPress={handleToggleSpeaker}><Ionicons name={isSpeaker ? "volume-high" : "volume-low"} size={24} color={isSpeaker ? "#000" : "white"} /></Pressable>
                                            {isVideo && <Pressable style={[styles.controlBtn, activeCall?.isVideoOff && styles.controlBtnActive]} onPress={handleToggleVideo}><MaterialIcons name={activeCall?.isVideoOff ? "videocam-off" : "videocam"} size={24} color={activeCall?.isVideoOff ? "#000" : "white"} /></Pressable>}
                                            <Pressable style={[styles.controlBtn, showLiveChat && styles.controlBtnActive]} onPress={() => setShowLiveChat(true)}>
                                                <Entypo name="chat" size={22} color={showLiveChat ? "#000" : "white"} />
                                            </Pressable>
                                            <Pressable style={styles.controlBtn} onPress={handleMinimize}><MaterialIcons name="picture-in-picture" size={24} color="white" /></Pressable>
                                            <Pressable style={[styles.controlBtn, styles.endCallBtn]} onPress={handleEndCall}><MaterialIcons name="call-end" size={28} color="white" /></Pressable>
                                        </View>
                                    )}
                                </GlassView>
                            )}

                            {/* Diagnostics Toggle */}
                            <Pressable style={{position: 'absolute', top: 10, right: 10, opacity: 0.1}} onLongPress={() => setShowDiagnostics(true)} delayLongPress={5000}>
                                <View style={{width: 20, height: 20}} />
                            </Pressable>

                            {showDiagnostics && (
                                <View style={styles.diagnosticsContainer}>
                                    <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                                    <View style={{ padding: 20 }}>
                                        <Text style={styles.diagnosticTitle}>Soul Diagnostics</Text>
                                        <Text style={styles.diagnosticValue}>State: {callState}</Text>
                                        <Text style={styles.diagnosticValue}>ICE: {webRTCService?.getIceConnectionState()}</Text>
                                        <Text style={styles.diagnosticValue}>Rx Data: {(stats.bytesReceived / 1024).toFixed(1)} KB</Text>
                                        <Pressable onPress={() => setShowDiagnostics(false)} style={styles.closeDiagnostics}>
                                            <Text style={{color: '#fff', fontWeight: 'bold' }}>CLOSE</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}
                        </View>
                    ) : (
                        !isVideo && (
                            <View style={styles.pipOverlay}>
                                <SoulAvatar uri={contact.avatar} size={width * 0.3} />
                                <Text style={styles.pipName}>{contact.name}</Text>
                            </View>
                        )
                    )}

                </Animated.View>
            </GestureDetector>

            {/* 4. Live Chat Overlay - Real Chat Screen Version (Outside gesture detector to avoid conflicts) */}
            {showLiveChat && (
                <View style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}>
                    <SingleChatScreen 
                        id={activeCall?.contactId} 
                        isOverlay={true} 
                        onBack={() => {
                            console.log('[DEBUG] Closing Live Chat from Overlay');
                            setShowLiveChat(false);
                        }} 
                    />
                </View>
            )}
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    backgroundImage: { position: 'absolute', opacity: 0.4 },
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)' },
    content: { flex: 1, justifyContent: 'space-between', zIndex: 10 },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20 },
    securityBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.1)', padding: 6, borderRadius: 12 },
    securityTextContainer: { overflow: 'hidden' },
    securityText: { color: 'rgba(255,255,255,0.6)', fontSize: 10 },
    mainInfo: { alignItems: 'center', marginTop: 40 },
    avatarWrapper: { width: 180, height: 180, justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
    pulseRing: { position: 'absolute', width: 170, height: 170, borderRadius: 85, borderWidth: 1, borderColor: 'rgba(255,100,136,0.25)' },
    contactName: { color: '#fff', fontSize: 28, fontWeight: 'bold' },
    callStatus: { color: 'rgba(255,255,255,0.6)', marginTop: 8 },
    controlsBar: { marginHorizontal: 20, borderRadius: 30, padding: 15 },
    controlsRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
    controlBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
    controlBtnActive: { backgroundColor: '#fff' },
    controlBtnDisabled: { opacity: 0.3 },
    endCallBtn: { backgroundColor: '#ef4444' },
    selfVideoContainer: { position: 'absolute', width: 110, height: 160, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: '#000', zIndex: 100 },
    selfVideo: { flex: 1 },
    selfVideoPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    edgeGlowContainer: { ...StyleSheet.absoluteFillObject, zIndex: 5 },
    pipOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    pipName: { color: '#fff', marginTop: 10, fontSize: 16 },
    incomingActionsRow: { flexDirection: 'row', justifyContent: 'space-around', width: '100%' },
    iconButton: { padding: 8 },
    diagnosticsContainer: { ...StyleSheet.absoluteFillObject, zIndex: 1000, justifyContent: 'center', alignItems: 'center' },
    diagnosticTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
    diagnosticValue: { color: 'rgba(255,255,255,0.8)', fontSize: 14, marginBottom: 5 },
    closeDiagnostics: { marginTop: 20, backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
    gridContainer: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#000' },
    videoTile: { overflow: 'hidden', borderWidth: 1, borderColor: '#222' },
    videoTileFull: { width: '100%', height: '100%' },
    videoTileHalf: { width: '100%', height: '50%' },
    videoTileQuarter: { width: '50%', height: '33.3%' },
    participantNameTag: { position: 'absolute', bottom: 10, left: 10, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, backgroundColor: 'rgba(0,0,0,0.5)' },
    participantNameText: { color: 'white', fontSize: 12 },
    tilePlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1A1A20' },
    tileName: { color: 'white', marginTop: 10, fontSize: 14, opacity: 0.7 },
});
