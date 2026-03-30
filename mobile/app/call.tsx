import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { BlurView } from 'expo-blur';
import {
    View, Text, Image, Pressable, StyleSheet, StatusBar,
    useWindowDimensions, Platform, Alert, AppState, ActivityIndicator
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera } from 'expo-camera';
import { Audio as ExpoAudio } from 'expo-av';
import { useRouter, useNavigation } from 'expo-router';
import GlassView from '../components/ui/GlassView';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import ExpoPip from 'expo-pip';
import Constants from 'expo-constants';
import { useApp } from '../context/AppContext';
import { callService, CallSignal } from '../services/CallService';
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

// Safe require for WebRTC to prevent Expo Go crashes
const getWebRTCModules = () => {
    try {
        // Only try to require if we are not in Expo Go (checked by constants or just try/catch)
        const webrtc = require('react-native-webrtc');
        return {
            RTCView: webrtc.RTCView,
            RTCPIPView: webrtc.RTCPIPView,
            startIOSPIP: webrtc.startIOSPIP,
            stopIOSPIP: webrtc.stopIOSPIP,
            MediaStream: webrtc.MediaStream,
            webRTCService: require('../services/WebRTCService').webRTCService
        };
    } catch (e) {
        console.log('[CallScreen] Native WebRTC not available (Expo Go)');
        return { RTCView: null, RTCPIPView: null, startIOSPIP: null, stopIOSPIP: null, MediaStream: null, webRTCService: null };
    }
};

const webrtcModules = getWebRTCModules();
const RTCView = webrtcModules.RTCView;
const RTCPIPView = webrtcModules.RTCPIPView;
const RemoteVideoComponent = RTCPIPView || RTCView; // Use PIP-enhanced view if available
const startIOSPIP = webrtcModules.startIOSPIP;
const stopIOSPIP = webrtcModules.stopIOSPIP;
const webRTCService = webrtcModules.webRTCService;



// CallState type
type CallState = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';

export default function CallScreen() {
    const insets = useSafeAreaInsets();
    const { width, height } = useWindowDimensions();
    const router = useRouter();
    const navigation = useNavigation();
    const { activeCall, contacts, currentUser, otherUser, activeTheme, endCall: endAppCall, acceptCall: acceptAppCall, toggleMute: toggleAppMute, toggleVideo, toggleMinimizeCall } = useApp();
    useKeepAwake(); // Prevents screen from sleeping during call

    const [callDuration, setCallDuration] = useState(0);
    const [localStream, setLocalStream] = useState<any>(null);
    const [remoteStream, setRemoteStream] = useState<any>(null);
    const [remoteStreamUpdate, setRemoteStreamUpdate] = useState(0);
    const webrtcListenerRef = useRef<any>(null);

    const [callState, setCallState] = useState<CallState>(() => {
        // If the call is already accepted (e.g. we re-entered this screen or 
        // the acceptor clicked "Accept" already), start in 'connecting'
        if (activeCall?.isAccepted) return 'connecting';
        return 'ringing';
    });
    const [isSlowConnection, setIsSlowConnection] = useState(false);

    useEffect(() => {
        if (callState === 'connecting') {
            const timer = setTimeout(() => setIsSlowConnection(true), 12000);
            return () => {
                clearTimeout(timer);
                setIsSlowConnection(false);
            };
        } else {
            setIsSlowConnection(false);
        }
    }, [callState]);

    const hasRemoteTracks = useMemo(() => {
        if (!remoteStream) return false;
        try {
            const audio = remoteStream.getAudioTracks?.() || [];
            const video = remoteStream.getVideoTracks?.() || [];
            const generic = remoteStream.getTracks?.() || [];
            const legacy = remoteStream._tracks || [];
            return audio.length > 0 || video.length > 0 || generic.length > 0 || legacy.length > 0;
        } catch (e) {
            return !!remoteStream._tracks?.length;
        }
    }, [remoteStream, remoteStreamUpdate]);

    const [wasConnected, setWasConnected] = useState(false);
    
    // isActuallyConnected: Either the protocol says 'connected' OR we have media flowing
    const isActuallyConnected = callState === 'connected' || (hasRemoteTracks && activeCall?.isAccepted);
    
    // Aggressive Sync: If service is connected or we have tracks, we ARE connected.
    useEffect(() => {
        if (isActuallyConnected && !wasConnected) {
            console.log('[CallScreen] 🎯 Connection confirmed (Aggressive)');
            setWasConnected(true);
        }
    }, [isActuallyConnected]);

    // Safety Sync: Periodically poll service state and streams to ensure React didn't miss a beat
    useEffect(() => {
        const interval = setInterval(() => {
            if (!webRTCService) return;
            
            const svcState = webRTCService.getState();
            const svcRemote = webRTCService.getRemoteStream();
            
            // Sync state
            if (svcState === 'connected' && !wasConnected) {
                console.log('[CallScreen] 🔄 Safety Sync: Forcing connected state');
                setWasConnected(true);
                setCallState('connected');
            }
            
            // Sync remote stream (Critical for video visibility)
            if (svcRemote && !remoteStream) {
                console.log('[CallScreen] 🔄 Safety Sync: Recovered missing remote stream');
                setRemoteStream(svcRemote);
                setRemoteStreamUpdate(prev => prev + 1);
            }
        }, 2000);
        return () => clearInterval(interval);
    }, [wasConnected, remoteStream]);

    const uiConnected = wasConnected || isActuallyConnected || (!!hasRemoteTracks && activeCall?.isAccepted);
    // const [isMuted, setIsMuted] = useState(false); // Managed by activeCall
    const [isSpeaker, setIsSpeaker] = useState(false);

    // Picture-in-Picture (Android) State
    const androidPipState = ExpoPip.useIsInPip();
    const androidIsInPipMode = Platform.OS === 'android' ? androidPipState.isInPipMode : false;
    const [iosIsInPipMode, setIosIsInPipMode] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false); // For user verification

    // Track if we are in PiP manually via AppState for iOS UI treatment
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
                        try { 
                            ExpoPip.enterPipMode({ 
                                width: Math.floor(width), 
                                height: Math.floor(height),
                                autoEnterEnabled: true 
                            }); 
                        } catch (e) { console.warn('ExpoPip error:', e); }
                    }
                }
            } else if (nextAppState === 'active') {
                if (Platform.OS === 'ios') {
                    setIosIsInPipMode(false);
                    if (stopIOSPIP) try { stopIOSPIP(); } catch (e) {}
                }
            }
        });
        return () => {
            if (timeout) clearTimeout(timeout);
            subscription.remove();
        };
    }, [activeCall?.type, activeCall?.isAccepted, width, height]);

    const isInPipMode = Platform.OS === 'android' ? androidIsInPipMode : iosIsInPipMode;

    // Track if we are minimizing to prevent ending call on unmount
    const isMinimizing = useRef(false);
    const rtcPipRef = useRef(null);

    // Keep a ref to the latest endAppCall to avoid stale closures in listeners
    const endAppCallRef = useRef(endAppCall);
    useEffect(() => { endAppCallRef.current = endAppCall; }, [endAppCall]);

    // FIX: When callee accepts (activeCall.isAccepted becomes true on caller side),
    // upgrade callState from 'ringing' → 'connecting' so UI shows "Connecting..."
    // instead of being stuck on "Ringing..." until WebRTC completes.
    useEffect(() => {
        if (activeCall?.isAccepted && callState === 'ringing') {
            console.log(`[CallScreen] Call accepted (Role=${activeCall.isIncoming?'Rx':'Tx'}) — upgrading callState: ringing → connecting`);
            setCallState('connecting');
        }
    }, [activeCall?.isAccepted, callState]);

    // Animations
    const pulseScale = useSharedValue(1);
    const pulseOpacity = useSharedValue(0.5);

    // Draggable self-video
    const selfVideoX = useSharedValue(width - 130);
    const selfVideoY = useSharedValue(120);
    const contextX = useSharedValue(0);
    const contextY = useSharedValue(0);
    const screenTranslateY = useSharedValue(0);

    const contact = useMemo(() => {
        const normalizedId = normalizeId(activeCall?.contactId);
        const found = contacts.find(c => normalizeId(c.id) === normalizedId);
        if (found) return found;
        // Fallback to activeCall metadata if contact not in list (e.g. recent add)
        return {
            id: activeCall?.contactId || '',
            name: activeCall?.contactName || 'User',
            avatar: activeCall?.avatar || activeCall?.contactAvatar || '',
        } as any;
    }, [contacts, activeCall]);

    const isVideo = activeCall?.type === 'video';

    const handleMinimize = useCallback(() => {
        isMinimizing.current = true;
        toggleMinimizeCall(true);
        if (navigation.canGoBack()) navigation.goBack();
    }, [navigation, toggleMinimizeCall]);

    const handleToggleMute = useCallback(() => {
        toggleAppMute();
    }, [toggleAppMute]);

    const handleToggleVideo = useCallback(() => {
        if (toggleVideo) {
            toggleVideo();
        }
    }, [toggleVideo]);

    const handleToggleSpeaker = useCallback(async () => {
        const next = !isSpeaker;
        setIsSpeaker(next);
        try {
            console.log(`[CallScreen] 🔊 Toggling speaker: ${next ? 'ON' : 'OFF'}`);
            await ExpoAudio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                interruptionModeIOS: 1, // DoNotMix
                shouldDuckAndroid: true,
                interruptionModeAndroid: 1, // DoNotMix
                // Android: false = speaker out, true = earpiece
                playThroughEarpieceAndroid: !next,
            });
        } catch (e) {
            console.warn('[CallScreen] Failed to toggle speaker:', e);
        }
    }, [isSpeaker]);

    const handleSwitchCamera = useCallback(() => {
        if (webRTCService) {
            try { webRTCService.switchCamera(); } catch (e) { }
        }
    }, []);

    const handleAcceptCall = useCallback(async () => {
        try {
            await acceptAppCall();
        } catch (e) {
            console.error('[CallScreen] handleAcceptCall failed:', e);
        }
    }, [acceptAppCall]);

    // Gesture for draggable video
    const panGesture = Gesture.Pan()
        .onStart(() => {
            contextX.value = selfVideoX.value;
            contextY.value = selfVideoY.value;
        })
        .onUpdate((event) => {
            selfVideoX.value = contextX.value + event.translationX;
            selfVideoY.value = contextY.value + event.translationY;
        })
        .onEnd(() => {
            // Snap to corners
            const midX = width / 2;
            const destX = selfVideoX.value < midX ? 20 : width - 130;
            const destY = Math.max(100, Math.min(height - 250, selfVideoY.value));

            selfVideoX.value = withSpring(destX);
            selfVideoY.value = withSpring(destY);
        });

    const selfVideoStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: selfVideoX.value },
            { translateY: selfVideoY.value }
        ] as any
    }));

    // Swipe down to minimize gesture (Signal style)
    const screenPanGesture = Gesture.Pan()
        .onUpdate((event) => {
            if (event.translationY > 0) {
                screenTranslateY.value = event.translationY;
            }
        })
        .onEnd((event) => {
            if (event.translationY > 150) {
                runOnJS(handleMinimize)();
            } else {
                screenTranslateY.value = withSpring(0);
            }
        });

    const screenStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: screenTranslateY.value }],
        borderRadius: interpolate(screenTranslateY.value, [0, 200], [0, 40]),
        overflow: 'hidden',
        flex: 1,
    }));

    // Request Permissions on Mount
    useEffect(() => {
        (async () => {
            if (activeCall?.type === 'video') {
                // Check if camera is available (e.g. might be missing on Simulator)
                // We'll proceed but might not get a stream
            }

            const { status: microphoneStatus } = await ExpoAudio.requestPermissionsAsync();
            const needsCamera = activeCall?.type === 'video';
            let cameraStatus = 'granted';
            
            if (needsCamera) {
                try {
                     const req = await Camera.requestCameraPermissionsAsync();
                     cameraStatus = req.status;
                } catch (e) {
                    console.warn('Camera permission request failed (simular?)', e);
                }
            }

            if ((needsCamera && cameraStatus !== 'granted') || microphoneStatus !== 'granted') {
                Alert.alert('Permission Required', 'Microphone (and Camera for video) access are needed.');
                // Don't auto-back immediately, let them know.
            }

            // Set Audio Mode for Calling
            try {
                await ExpoAudio.setAudioModeAsync({
                    allowsRecordingIOS: true,
                    playsInSilentModeIOS: true,
                    staysActiveInBackground: true,
                    // Use iOS interruption mode 0 (MixWithOthers) or 1 (DoNotMix). 
                    // For PiP, it's safer to ensure we don't block the background video rendering
                    interruptionModeIOS: Constants?.platform?.ios ? 1 : 1, 
                    shouldDuckAndroid: true,
                    interruptionModeAndroid: 1, // DoNotMix
                    playThroughEarpieceAndroid: false
                });
            } catch (e) {
                console.warn('Failed to set audio mode:', e);
            }
        })();
    }, [activeCall?.type, router]);

    const hasInitiated = useRef(false);

    // Initialize WebRTC
    useEffect(() => {
        if (!activeCall || !currentUser || !otherUser) return;

        console.log('Initializing WebRTC for call screen...');

        const initCall = async () => {
            try {
                // 1. Setup multi-listener callbacks
                const callbacks = {
                    onStateChange: (state: CallState) => {
                        console.log('[CallScreen] WebRTC state changed callback:', state);
                        setCallState(prev => {
                            if (state === 'connecting' && prev === 'connected') return prev;
                            return state;
                        });

                        if (state === 'ended') {
                            console.log('[CallScreen] WebRTC ended internally — triggering app-level endCall');
                            if (endAppCallRef.current) endAppCallRef.current();
                        }
                    },
                    onLocalStream: (stream: any) => {
                        console.log('[CallScreen] Local stream updated');
                        setLocalStream(stream);
                    },
                    onRemoteStream: (stream: any) => {
                        console.log('[CallScreen] Remote stream updated, version:', remoteStreamUpdate + 1);
                        setRemoteStream(stream);
                        setRemoteStreamUpdate(prev => prev + 1);
                    },
                    onError: (error: string) => {
                        console.error('[CallScreen] WebRTC error:', error);
                    },
                };

                // Store for cleanup
                webrtcListenerRef.current = callbacks;
                webRTCService.addListener(callbacks);

                // 2. Immediate State Sync: 
                // Pick up whatever the service already has (critical for re-mounts/PiP)
                const currentLocal = webRTCService.getLocalStream();
                const currentRemote = webRTCService.getRemoteStream();
                const currentState = webRTCService.getState();
                
                if (currentLocal) setLocalStream(currentLocal);
                if (currentRemote) {
                    setRemoteStream(currentRemote);
                    setRemoteStreamUpdate(prev => prev + 1);
                }
                
                if (currentState !== 'idle') {
                    console.log('[CallScreen] 🔄 Syncing existing service state:', currentState);
                    setCallState(currentState);
                }

                webRTCService.setInitiator(!activeCall.isIncoming);

                // 2. PROTOCOL ENGINE: Only start or answer ONCE per session
                // This prevents re-running logic if UI re-renders (e.g. state change to ringing)
                if (hasInitiated.current) {
                    console.log('[CallScreen] Protocol already initiated, skipping re-init.');
                    return;
                }
                
                // If it's a completely existing call (PiP return), just sync state
                if (webRTCService.isCallActive()) {
                    console.log('Restoring active call view...');
                    hasInitiated.current = true;
                    const currentLocal = webRTCService.getLocalStream();
                    const currentRemote = webRTCService.getRemoteStream();
                    if (currentLocal) setLocalStream(currentLocal);
                    if (currentRemote) setRemoteStream(currentRemote);
                    setCallState(webRTCService.getState());
                    return;
                }

                hasInitiated.current = true;

                // 1. Set Audio Mode for VOIP (Communication)
                // This is CRITICAL for echo cancellation and microphone access on iOS/Android
                try {
                    console.log('[CallScreen] Setting audio mode for VOIP...');
                    await ExpoAudio.setAudioModeAsync({
                        allowsRecordingIOS: true, // Vital for mic
                        playsInSilentModeIOS: true,
                        staysActiveInBackground: true,
                        interruptionModeIOS: 1, // InterruptionModeIOS.DoNotMix
                        shouldDuckAndroid: true,
                        interruptionModeAndroid: 1, // InterruptionModeAndroid.DoNotMix
                        playThroughEarpieceAndroid: false, // Default to speaker for now
                    });
                } catch (audioError) {
                    console.warn('[CallScreen] Failed to set VOIP audio mode:', audioError);
                }

                // 2. Prepare media and start signaling protocol
                await webRTCService.prepareCall(activeCall.type);

                if (activeCall.isIncoming) {
                    // Receiver: wait for Offer signal from Caller (handled by webRTCService internally)
                    console.log('[CallScreen] Waiting for offer as Receiver...');
                } else {
                    // Caller: Start signaling protocol (Create and Send Offer)
                    console.log('[CallScreen] Starting signaling as Caller...');
                    await webRTCService.startCall();
                }

            } catch (e: any) {
                console.warn('WebRTC initialization failed:', e);
                console.warn('Error Stack:', e?.stack);
                Alert.alert("Call Failed", "Could not initialize WebRTC connection.");
                handleEndCall(`init-failed: ${e?.message || 'unknown'}`);
            }
        };

        initCall();

        return () => {
            console.log('[CallScreen] ⚠️ WebRTC useEffect CLEANUP triggered. isMinimizing:', isMinimizing.current);
            if (webRTCService) {
                // Always detach callbacks to prevent stale state updates
                if (webrtcListenerRef.current) {
                    try { webRTCService.removeListener(webrtcListenerRef.current); } catch (e) { }
                    webrtcListenerRef.current = null;
                }

                if (isMinimizing.current) {
                    // Minimizing: keep call alive, just detach the UI callbacks (done above)
                    console.log('[CallScreen] Minimizing — keeping call alive, callbacks detached');
                } else {
                    // Not minimizing: AppContext.endCall() already handled full teardown.
                    // Just reset the audio mode. Do NOT call webRTCService.cleanup/endCall again.
                    console.log('[CallScreen] Unmounting after call end — restoring audio mode only');
                    restoreMusicAudioMode();
                }
            }
        };
    }, []);

    // Sync PiP parameters with activeCall
    useEffect(() => {
        if (!activeCall) {
            console.log('[CallScreen] ⚠️ activeCall became null — navigating back');
            // FIX: Navigate back or to tabs when call ends to prevent white screen
            if (navigation.canGoBack()) {
                navigation.goBack();
            } else {
                // Fallback: navigate to home/tabs if no back stack
                router.replace('/(tabs)');
            }
            return;
        }

        // Enable PIP Auto-Enter for ALL Calls (Android)
        // This ensures that moving to home screen during a call triggers native PiP
        if (activeCall.isAccepted && Platform.OS === 'android') {
            try {
                ExpoPip.setPictureInPictureParams({
                    autoEnterEnabled: true,
                    // Provide aspect ratio hints
                    width: Math.floor(width),
                    height: Math.floor(width * 1.5)
                });
            } catch (e) {
                console.log('Failed to set PIP params:', e);
            }
        }
    }, [activeCall, navigation, router, width]);

    // Timer - only start if call is connected AND accepted
    useEffect(() => {
        if (!uiConnected) return;
        
        // Android Fix: Re-apply communication mode once connected to ensure audio routing is consistent
        if (Platform.OS === 'android') {
            // Wait 500ms (increased) to allow hardware to stabilize
            setTimeout(async () => {
                console.log('[CallScreen] 🔄 Connected! Refreshing VOIP audio session...');
                try {
                    await ExpoAudio.setAudioModeAsync({
                        allowsRecordingIOS: true,
                        playsInSilentModeIOS: true,
                        staysActiveInBackground: true,
                        interruptionModeIOS: 1, 
                        shouldDuckAndroid: true,
                        interruptionModeAndroid: 1, 
                        playThroughEarpieceAndroid: !isSpeaker // Sync with UI state
                    });
                } catch (e) {
                    console.warn('[CallScreen] Post-connect audio sync failed:', e);
                }
            }, 500);
        }

        console.log('[CallScreen] ⏱️ Starting call timer');
        const interval = setInterval(() => {
            setCallDuration(prev => prev + 1);
        }, 1000);
        return () => clearInterval(interval);
    }, [uiConnected]);

    // Pulse Animation
    useEffect(() => {
        if (callState === 'ringing' || callState === 'connecting') {
            pulseScale.value = withRepeat(
                withTiming(1.5, { duration: 1500, easing: Easing.out(Easing.ease) }),
                -1,
                false
            );
            pulseOpacity.value = withRepeat(
                withTiming(0, { duration: 1500, easing: Easing.out(Easing.ease) }),
                -1,
                false
            );
        } else {
            pulseScale.value = withTiming(1);
            pulseOpacity.value = withTiming(0);
        }
    }, [callState]);

    const pulseStyle = useAnimatedStyle(() => ({
        transform: [{ scale: pulseScale.value }],
        opacity: pulseOpacity.value,
    }));

    const restoreMusicAudioMode = useCallback(async () => {
        try {
            await ExpoAudio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
                staysActiveInBackground: true,
                interruptionModeIOS: 1,
                shouldDuckAndroid: true,
                interruptionModeAndroid: 1,
                playThroughEarpieceAndroid: false,
            });
        } catch (e) {
            console.warn('Failed to restore music audio mode:', e);
        }
    }, []);

    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const handleEndCall = useCallback((reason: any = 'manual') => {
        const reasonStr = (typeof reason === 'string') ? reason : 'user-action';
        console.log(`[CallScreen] 📴 handleEndCall() called with reason: ${reasonStr}`);
        // 1. Clear streams immediately to prevent black screen/crash on unmount
        setLocalStream(null);
        setRemoteStream(null);

        // 2. Trigger app-level end call (which handles WebRTC cleanup + signaling + logging)
        // Do NOT call webRTCService.cleanup() here separately — AppContext.endCall() does it
        if (endAppCallRef.current) endAppCallRef.current();
        restoreMusicAudioMode();
        // Do not call navigation.goBack() here. Let the useEffect that watches `!activeCall` handle it.
    }, [restoreMusicAudioMode]);



    // FIX: Prevent white screen by navigating away when call ends before rendering
    if (!activeCall || !contact) {
        return (
            <View style={[styles.container, { backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }]}>
                <StatusBar hidden />
                <ActivityIndicator size="large" color="#BC002A" />
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16, marginTop: 10 }}>Ending Call...</Text>
            </View>
        );
    }

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <GestureDetector gesture={screenPanGesture}>
                <Animated.View style={[
                    styles.container, 
                    { 
                        backgroundColor: '#000', 
                        width, 
                        // Fix Android black gap by using 100% height for translucent mode
                        height: Platform.OS === 'android' ? '100%' : height 
                    }, 
                    screenStyle
                ]}>
                    <StatusBar 
                        translucent={Platform.OS === 'android'} 
                        backgroundColor="transparent" 
                        barStyle="light-content" 
                    />

                        {/* 1. Background Media Layer */}
                        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#111' }]}>
                            {/* PRIORITY A: Remote Video Stream */}
                            {(isVideo && remoteStream && activeCall.isAccepted && !activeCall.remoteVideoOff) ? (
                                <RemoteVideoComponent
                                    key={`remote-video-v${remoteStreamUpdate}`}
                                    ref={rtcPipRef}
                                    streamURL={typeof remoteStream.toURL === 'function' ? remoteStream.toURL() : remoteStream}
                                    style={[StyleSheet.absoluteFill, { zIndex: 0 }]}
                                    objectFit="cover"
                                    mirror={false}
                                    zOrder={0}
                                />
                            ) : (
                                // PRIORITY B: Blurred avatar background (Fallback only)
                                !!contact.avatar && (
                                    <Image
                                        source={{ uri: contact.avatar }}
                                        style={[styles.backgroundImage, { width, height }]}
                                        blurRadius={isVideo ? 60 : 50}
                                    />
                                )
                            )}
                            <View style={[styles.overlay, { zIndex: 1 }]} />
                        </View>

                        {/* Video Toggled Off Overlay (Remote Side) */}
                        {isVideo && activeCall.remoteVideoOff && (
                            <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' }]}>
                                <SoulAvatar uri={contact.avatar || ''} size={150} />
                                <View style={{ marginTop: 20, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }}>
                                    <Text style={{ color: 'white', fontWeight: '600' }}>{contact.name}'s Video is Off</Text>
                                </View>
                            </View>
                        )}
                        
                        {/* 🚫 Connecting Overlay for Video Removed per User Request 🚫 */}

                    {/* 2. Main Content (Visible ONLY when NOT in PiP) */}
                    {!isInPipMode ? (
                        <View style={styles.content}>
                            {/* Diagnostics Overlay (Toggled via long press on status) */}
                            {showDiagnostics && (
                                <View style={styles.diagnosticsContainer}>
                                    <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                                    <Text style={styles.diagnosticTitle}>Soul Diagnostics</Text>
                                    
                                    <View style={styles.diagnosticRow}>
                                        <Text style={styles.diagnosticLabel}>Connection:</Text>
                                        <Text style={[styles.diagnosticValue, { color: callState === 'connected' ? '#22c55e' : '#eab308' }]}>
                                            {callState.toUpperCase()}
                                        </Text>
                                    </View>

                                    <View style={styles.diagnosticRow}>
                                        <Text style={styles.diagnosticLabel}>ICE State:</Text>
                                        <Text style={styles.diagnosticValue}>
                                            {webRTCService?.getIceConnectionState()?.toUpperCase()}
                                        </Text>
                                    </View>

                                    <View style={styles.diagnosticRow}>
                                        <Text style={styles.diagnosticLabel}>Signaling:</Text>
                                        <Text style={styles.diagnosticValue}>
                                            {webRTCService?.getSignalingState()?.toUpperCase()}
                                        </Text>
                                    </View>

                                    <View style={styles.diagnosticRow}>
                                        <Text style={styles.diagnosticLabel}>Local Audio:</Text>
                                        <View style={{alignItems: 'flex-end'}}>
                                            <Text style={styles.diagnosticValue}>{localStream?.getAudioTracks().length || 0} tracks</Text>
                                            {localStream?.getAudioTracks().map((t: any, i: number) => (
                                                <Text key={i} style={{fontSize: 10, color: t.enabled ? '#22c55e' : '#ef4444'}}>
                                                    {t.readyState} {t.enabled ? 'Enabled' : 'Disabled'}
                                                </Text>
                                            ))}
                                        </View>
                                    </View>

                                    <View style={styles.diagnosticRow}>
                                        <Text style={styles.diagnosticLabel}>Remote Audio:</Text>
                                        <View style={{alignItems: 'flex-end'}}>
                                            <Text style={styles.diagnosticValue}>{remoteStream?.getAudioTracks().length || 0} tracks</Text>
                                            {remoteStream?.getAudioTracks().map((t: any, i: number) => (
                                                <Text key={i} style={{fontSize: 10, color: t.enabled ? '#22c55e' : '#ef4444'}}>
                                                    {t.readyState} {t.enabled ? 'Enabled' : 'Disabled'}
                                                </Text>
                                            ))}
                                        </View>
                                    </View>

                                    <View style={styles.diagnosticRow}>
                                        <Text style={styles.diagnosticLabel}>Remote Video:</Text>
                                        <Text style={[styles.diagnosticValue, { color: remoteStream?.getVideoTracks().length ? '#22c55e' : '#ef4444' }]}>
                                            {remoteStream?.getVideoTracks().length || 0} tracks
                                        </Text>
                                    </View>

                                    <Pressable onPress={() => setShowDiagnostics(false)} style={styles.closeDiagnostics}>
                                        <Text style={{color: '#fff', fontWeight: 'bold'}}>CLOSE</Text>
                                    </Pressable>
                                </View>
                            )}

                            {/* Header */}
                            <View style={[styles.header, { marginTop: Math.max(insets.top, 20) }]}>
                                <Pressable onPress={handleMinimize} style={styles.iconButton}>
                                    <MaterialIcons name="keyboard-arrow-down" size={32} color="white" />
                                </Pressable>
                                
                                <View style={styles.securityBadge}>
                                    <MaterialIcons name="lock" size={12} color="rgba(255,255,255,0.6)" />
                                    <Text style={styles.securityText}>Soul End-to-End Encrypted</Text>
                                </View>
                                
                                <View style={{ width: 44 }} />
                            </View>

                            {/* Center Info (Avatar/Name) - Only show if not connected video or no uiConnection */}
                            {(!isVideo || !uiConnected) && (
                                <View style={styles.mainInfo}>
                                    <View style={styles.avatarWrapper}>
                                        <Animated.View style={[styles.pulseRing, pulseStyle]} />
                                        <SoulAvatar uri={contact.avatar} size={170} />
                                    </View>

                                    <View style={styles.textContainer}>
                                        <Text style={styles.contactName}>{contact.name}</Text>
                                        <Pressable 
                                            onLongPress={() => setShowDiagnostics(true)}
                                            delayLongPress={2000}
                                        >
                                            <Text style={styles.callStatus}>
                                                {uiConnected ? formatDuration(callDuration) : 
                                                callState === 'ended' ? 'Ending...' :
                                                (activeCall.isIncoming && !activeCall.isAccepted) ? 'Incoming Soul Call...' : 
                                                (callState === 'ringing' && !activeCall.isIncoming) ? 'Ringing...' : 
                                                isSlowConnection ? 'Connection logic delayed...' : 'Connecting...'}
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            )}

                            {/* Self Video (Draggable) - Replaces the conditional check to ensure PiP stability */}
                            {isVideo && (
                                <GestureDetector gesture={panGesture}>
                                    <Animated.View style={[styles.selfVideoContainer, selfVideoStyle]}>
                                        {localStream && !activeCall.isVideoOff ? (
                                            <RTCView
                                                streamURL={typeof localStream.toURL === 'function' ? localStream.toURL() : localStream}
                                                style={styles.selfVideo}
                                                objectFit="cover"
                                                mirror={true}
                                                zOrder={2}
                                            />
                                        ) : (
                                            <View style={styles.selfVideoPlaceholder}>
                                                <SoulAvatar uri={currentUser?.avatar} size={50} />
                                                <View style={styles.videoOffIndicator}>
                                                    <MaterialIcons name="videocam-off" size={14} color="white" />
                                                </View>
                                            </View>
                                        )}
                                    </Animated.View>
                                </GestureDetector>
                            )}

                            {/* Footer Controls */}
                            <GlassView intensity={35} tint="dark" style={[styles.controlsBar, { marginBottom: Math.max(insets.bottom, 40) }]}>
                                {callState !== 'connected' && activeCall.isIncoming && !activeCall.isAccepted ? (
                                    <View style={styles.incomingActionsRow}>
                                        <View style={styles.incomingAction}>
                                            <Pressable style={[styles.actionButton, { backgroundColor: '#ef4444' }]} onPress={handleEndCall}>
                                                <MaterialIcons name="call-end" size={32} color="white" />
                                            </Pressable>
                                            <Text style={styles.actionText}>Decline</Text>
                                        </View>
                                        <View style={styles.incomingAction}>
                                            <Pressable style={[styles.actionButton, { backgroundColor: '#22c55e' }]} onPress={handleAcceptCall}>
                                                <MaterialIcons name={isVideo ? "videocam" : "call"} size={32} color="white" />
                                            </Pressable>
                                            <Text style={styles.actionText}>Accept</Text>
                                        </View>
                                    </View>
                                ) : (
                                    <View style={styles.controlsRow}>
                                        <Pressable style={[styles.controlBtn, activeCall.isMuted && styles.controlBtnActive]} onPress={handleToggleMute}>
                                            <MaterialIcons name={activeCall.isMuted ? "mic-off" : "mic"} size={28} color={activeCall.isMuted ? "#000" : "white"} />
                                        </Pressable>

                                        {isVideo && (
                                            <Pressable style={[styles.controlBtn, activeCall.isVideoOff && styles.controlBtnActive]} onPress={handleToggleVideo}>
                                                <MaterialIcons name={activeCall.isVideoOff ? "videocam-off" : "videocam"} size={28} color={activeCall.isVideoOff ? "#000" : "white"} />
                                            </Pressable>
                                        )}

                                        <Pressable style={[styles.controlBtn, isSpeaker && styles.controlBtnActive]} onPress={handleToggleSpeaker}>
                                            <MaterialIcons name={isSpeaker ? "volume-up" : "volume-down"} size={28} color={isSpeaker ? "#000" : "white"} />
                                        </Pressable>

                                        {isVideo && (
                                            <Pressable style={styles.controlBtn} onPress={handleSwitchCamera}>
                                                <Ionicons name="camera-reverse" size={28} color="white" />
                                            </Pressable>
                                        )}

                                        <Pressable style={[styles.controlBtn, styles.endCallBtn]} onPress={handleEndCall}>
                                            <MaterialIcons name="call-end" size={36} color="white" />
                                        </Pressable>
                                    </View>
                                )}
                            </GlassView>
                        </View>
                    ) : (
                        // 3. PiP Overlay (Visible ONLY in Native PiP window)
                        // If it's a video call, the RTCView (background) stays visible.
                        // For audio call, we show this branding/info overlay.
                        !isVideo && (
                            <View style={styles.pipOverlay}>
                                <SoulAvatar uri={contact.avatar} size={width * 0.4} />
                                <View style={[styles.pipTitleBar, { marginTop: 15 }]}>
                                    <Text style={styles.pipName}>{contact.name}</Text>
                                    <Text style={styles.pipStatus}>{formatDuration(callDuration)}</Text>
                                </View>
                            </View>
                        )
                    )}
                </Animated.View>
            </GestureDetector>
        </GestureHandlerRootView>
    );
}

const callContactNameShadow = Platform.select({
  ios: {
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  default: undefined,
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    diagnosticsContainer: {
        position: 'absolute',
        top: 100,
        left: 20,
        right: 20,
        padding: 20,
        borderRadius: 20,
        backgroundColor: 'rgba(0,0,0,0.8)',
        zIndex: 1000,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    diagnosticTitle: {
        color: '#fff',
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 15,
        textAlign: 'center',
    },
    diagnosticRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 10,
    },
    diagnosticLabel: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 14,
    },
    diagnosticValue: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '600',
    },
    closeDiagnostics: {
        marginTop: 15,
        backgroundColor: '#BC002A',
        padding: 10,
        borderRadius: 10,
        alignItems: 'center',
    },
    backgroundImage: {
        resizeMode: 'cover',
        opacity: 0.6,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.3)',
    },
    remoteVideo: {
        flex: 1,
        backgroundColor: '#1a1a1a',
    },
    selfVideoContainer: {
        position: 'absolute',
        width: 110,
        height: 160,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: '#333',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
        zIndex: 50,
        elevation: 10,
        shadowColor: 'black',
        shadowOpacity: 0.3,
        shadowRadius: 10,
    },
    selfVideo: {
        flex: 1,
    },
    selfVideoPlaceholder: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#1f1f1f',
    },
    videoOffIndicator: {
        position: 'absolute',
        bottom: 8,
        right: 8,
        backgroundColor: 'rgba(0,0,0,0.5)',
        padding: 4,
        borderRadius: 10,
    },
    content: {
        flex: 1,
        justifyContent: 'space-between',
        zIndex: 20,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 60,
        paddingHorizontal: 20,
    },
    headerTitle: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 14,
        fontWeight: '600',
        letterSpacing: 1,
        textTransform: 'uppercase',
    },
    mainInfo: {
        alignItems: 'center',
        marginBottom: 40,
    },
    avatarWrapper: {
        width: 180,
        height: 180,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 30,
    },
    avatarContainer: {
        width: 170,
        height: 170,
        borderRadius: 85,
        overflow: 'hidden',
        backgroundColor: '#000',
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatar: {
        width: '100%',
        height: '100%',
    },
    avatarShadow: {
        shadowColor: 'black',
        shadowOpacity: 0.5,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 10 },
        elevation: 15,
    },
    pulseRing: {
        position: 'absolute',
        width: 170,
        height: 170,
        borderRadius: 85,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.5)',
        backgroundColor: 'rgba(255,255,255,0.05)',
    },
    textContainer: {
        alignItems: 'center',
    },
    contactName: {
        color: 'white',
        fontSize: 32,
        fontWeight: 'bold',
        ...callContactNameShadow,
    },
    callStatus: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 18,
        marginTop: 8,
    },
    controlsBar: {
        marginHorizontal: 20,
        borderRadius: 35,
        paddingVertical: 15,
        paddingHorizontal: 10,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    controlsRow: {
        flexDirection: 'row',
        justifyContent: 'space-evenly',
        alignItems: 'center',
    },
    controlBtn: {
        width: 54,
        height: 54,
        borderRadius: 27,
        backgroundColor: 'rgba(255,255,255,0.1)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    controlBtnActive: {
        backgroundColor: 'rgba(255,255,255,0.9)',
    },
    iconButton: {
        padding: 8,
        borderRadius: 20,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    securityBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 6,
    },
    securityText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 10,
        fontWeight: '600',
    },
    incomingActionsRow: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        width: '100%',
        paddingHorizontal: 20,
    },
    endCallBtn: {
        backgroundColor: '#ef4444',
        width: 64,
        height: 64,
        borderRadius: 32,
    },
    incomingAction: {
        alignItems: 'center',
        gap: 10,
    },
    actionButton: {
        width: 70,
        height: 70,
        borderRadius: 35,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 5,
    },
    actionText: {
        color: 'white',
        fontSize: 14,
        fontWeight: '600',
    },
    // PiP Specific Styles
    pipOverlay: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#000',
    },
    pipAvatarContainer: {
        marginBottom: 10,
    },
    pipTitleBar: {
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 15,
    },
    pipName: {
        color: 'white',
        fontSize: 12,
        fontWeight: 'bold',
    },
    pipStatus: {
        color: 'rgba(255,255,255,0.8)',
        fontSize: 10,
    },
});
