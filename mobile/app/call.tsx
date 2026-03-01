import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, StatusBar,
    useWindowDimensions, Platform, Alert
} from 'react-native';
import { Camera } from 'expo-camera';
import { Audio as ExpoAudio } from 'expo-av';
import { useRouter, useNavigation } from 'expo-router';
import { BlurView } from 'expo-blur';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
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

// Safe require for WebRTC to prevent Expo Go crashes
const getWebRTCModules = () => {
    try {
        // Only try to require if we are not in Expo Go (checked by constants or just try/catch)
        const webrtc = require('react-native-webrtc');
        return {
            RTCView: webrtc.RTCView,
            MediaStream: webrtc.MediaStream,
            webRTCService: require('../services/WebRTCService').webRTCService
        };
    } catch (e) {
        console.log('[CallScreen] Native WebRTC not available (Expo Go)');
        return { RTCView: null, MediaStream: null, webRTCService: null };
    }
};

const webrtcModules = getWebRTCModules();
const RTCView = webrtcModules.RTCView;
const webRTCService = webrtcModules.webRTCService;



// CallState type
type CallState = 'idle' | 'ringing' | 'connecting' | 'connected' | 'ended';

export default function CallScreen() {
    const { width, height } = useWindowDimensions();
    const router = useRouter();
    const navigation = useNavigation();
    const { activeCall, contacts, currentUser, otherUser, activeTheme, endCall: endAppCall, toggleMute: toggleAppMute, toggleMinimizeCall } = useApp();
    useKeepAwake(); // Prevents screen from sleeping during call

    const [callDuration, setCallDuration] = useState(0);
    const [callState, setCallState] = useState<CallState>('ringing');
    const [localStream, setLocalStream] = useState<any>(null);
    const [remoteStream, setRemoteStream] = useState<any>(null);
    // const [isMuted, setIsMuted] = useState(false); // Managed by activeCall
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isSpeaker, setIsSpeaker] = useState(false);

    // Track if we are minimizing to prevent ending call on unmount
    const isMinimizing = useRef(false);

    // Keep a ref to the latest endAppCall to avoid stale closures in listeners
    const endAppCallRef = useRef(endAppCall);
    useEffect(() => { endAppCallRef.current = endAppCall; }, [endAppCall]);

    // Animations
    const pulseScale = useSharedValue(1);
    const pulseOpacity = useSharedValue(0.5);

    // Draggable self-video
    const selfVideoX = useSharedValue(width - 130);
    const selfVideoY = useSharedValue(120);
    const contextX = useSharedValue(0);
    const contextY = useSharedValue(0);
    const screenTranslateY = useSharedValue(0);

    const contact = contacts.find(c => c.id === activeCall?.contactId);
    const isVideo = activeCall?.type === 'video';

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
        ]
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
                    interruptionModeIOS: 1, // DoNotMix
                    shouldDuckAndroid: true,
                    interruptionModeAndroid: 1, // DoNotMix
                    playThroughEarpieceAndroid: false
                });
            } catch (e) {
                console.warn('Failed to set audio mode:', e);
            }
        })();
    }, [activeCall?.type, router]);

    // Initialize WebRTC
    useEffect(() => {
        if (!activeCall || !currentUser || !otherUser) return;

        if (!webRTCService) {
            Alert.alert(
                "Development Build Required",
                "Real calls require 'react-native-webrtc' which does not work in Expo Go.\n\nPlease run: npx expo run:android"
            );
            if (navigation.canGoBack()) navigation.goBack();
            return;
        }

        console.log('Initializing WebRTC for call...');

        const initCall = async () => {
            try {
                webRTCService.initialize({
                    onStateChange: (state: CallState) => {
                        console.log('[CallScreen] WebRTC state changed:', state);
                        if (state === 'connecting' && callState === 'connected') return;
                        setCallState(state);

                        // If WebRTC ended internally (ICE/connection failure), trigger app-level end
                        if (state === 'ended') {
                            console.log('[CallScreen] WebRTC ended internally — triggering app-level endCall');
                            if (endAppCallRef.current) endAppCallRef.current();
                        }
                    },
                    onLocalStream: (stream: any) => {
                        console.log('Got local stream');
                        setLocalStream(stream);
                    },
                    onRemoteStream: (stream: any) => {
                        console.log('Got remote stream');
                        setRemoteStream(stream);
                    },
                    onError: (error: string) => {
                        console.error('WebRTC error:', error);
                        Alert.alert('Call Error', error);
                    },
                });

                // If call is already active (e.g. returning from PiP), just restore streams
                if (webRTCService.isCallActive()) {
                    console.log('Restoring active call view...');
                    const currentLocal = webRTCService.getLocalStream();
                    const currentRemote = webRTCService.getRemoteStream();
                    if (currentLocal) setLocalStream(currentLocal);
                    if (currentRemote) setRemoteStream(currentRemote);
                    setCallState(webRTCService.getState());
                    return;
                }

                // Prepare media for everyone
                await webRTCService.prepareCall(activeCall.type);

                // Logic to Start or Answer
                if (activeCall.isIncoming) {
                    // We are the Receiver
                    if (activeCall.isAccepted) {
                        // We accepted the call, now wait for Offer from Caller
                        // webRTCService.answerCall will be triggered by handleSignal('offer')
                        console.log('Waiting for offer from Caller...');
                    }
                } else {
                    // We are the Caller
                    console.log('Starting call as Initiator...');
                    await webRTCService.startCall();
                }

            } catch (e) {
                console.warn('WebRTC initialization failed:', e);
                Alert.alert("Call Failed", "Could not initialize Real WebRTC connection.");
                handleEndCall();
            }
        };

        initCall();

        return () => {
            console.log('[CallScreen] ⚠️ WebRTC useEffect CLEANUP triggered. isMinimizing:', isMinimizing.current);
            if (webRTCService) {
                // Always detach callbacks to prevent stale state updates
                // (callbacks point to this component's stale state setters)
                try { webRTCService.setCallbacks(null); } catch (e) { }

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

    // Sync state with activeCall
    useEffect(() => {
        if (!activeCall) {
            console.log('[CallScreen] ⚠️ activeCall became null — navigating back');
            console.trace('[CallScreen] activeCall null trace:');
            if (navigation.canGoBack()) navigation.goBack();
            return;
        }
        if (activeCall?.isAccepted && callState !== 'connected' && callState !== 'ended') {
            setCallState('connected');
            // makeOffer is now handled internally by startCall for the initiator
        }
    }, [activeCall, callState]);

    // Timer - only start if call is connected AND accepted
    useEffect(() => {
        if (callState !== 'connected' || !activeCall?.isAccepted) return;
        const interval = setInterval(() => {
            setCallDuration(prev => prev + 1);
        }, 1000);
        return () => clearInterval(interval);
    }, [callState, activeCall?.isAccepted]);

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

    const handleEndCall = useCallback(() => {
        console.log('[CallScreen] 📴 handleEndCall() called by user');
        // 1. Clear streams immediately to prevent black screen/crash on unmount
        setLocalStream(null);
        setRemoteStream(null);

        // 2. Trigger app-level end call (which handles WebRTC cleanup + signaling + logging)
        // Do NOT call webRTCService.cleanup() here separately — AppContext.endCall() does it
        if (endAppCallRef.current) endAppCallRef.current();
        restoreMusicAudioMode();
        // Do not call navigation.goBack() here. Let the useEffect that watches `!activeCall` handle it.
    }, [restoreMusicAudioMode]);


    const handleToggleMute = () => {
        toggleAppMute();
    };

    const handleToggleVideo = () => {
        if (webRTCService) {
            try {
                const nowOff = webRTCService.toggleVideo();
                setIsVideoOff(nowOff);
            } catch (e) { setIsVideoOff(!isVideoOff); }
        } else {
            setIsVideoOff(!isVideoOff);
        }
    };

    const handleToggleSpeaker = () => {
        setIsSpeaker(!isSpeaker);
        // Implement actual speaker toggle logic if needed
    };

    const handleSwitchCamera = () => {
        if (webRTCService) {
            try { webRTCService.switchCamera(); } catch (e) { }
        }
    };

    const handleMinimize = () => {
        isMinimizing.current = true;
        toggleMinimizeCall(true);
        if (navigation.canGoBack()) navigation.goBack();
    };

    if (!activeCall || !contact) {
        return (
            <View style={[styles.container, { backgroundColor: activeTheme?.bg || '#000', justifyContent: 'center', alignItems: 'center' }]}>
                <StatusBar hidden />
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16 }}>Initializing...</Text>
            </View>
        );
    }

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <GestureDetector gesture={screenPanGesture}>
            <Animated.View style={[styles.container, { backgroundColor: activeTheme?.bg || '#000', width, height }, screenStyle]}>
                <StatusBar hidden />

                {/* Background Layer */}
                {isVideo ? (
                    <View style={StyleSheet.absoluteFill}>
                        {RTCView && remoteStream && activeCall.isAccepted ? (
                            <RTCView
                                streamURL={typeof remoteStream.toURL === 'function' ? remoteStream.toURL() : remoteStream}
                                style={styles.remoteVideo}
                                objectFit="cover"
                                mirror={false}
                                zOrder={0}
                            />
                        ) : (
                            <Image
                                source={{ uri: contact.avatar }}
                                style={[styles.backgroundImage, { width, height }]}
                                blurRadius={50}
                            />
                        )}
                        
                        {/* Connecting / Initializing Overlay */}
                        {(!remoteStream && isVideo && activeCall.isAccepted) && (
                            <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }]}>
                                <Text style={{ color: 'white', fontSize: 18, fontWeight: '600' }}>Connecting Video...</Text>
                            </View>
                        )}
                    </View>
                ) : (
                    <View style={StyleSheet.absoluteFill}>
                        <Image
                            source={{ uri: contact.avatar }}
                            style={[styles.backgroundImage, { width, height }]}
                            blurRadius={60}
                        />
                        <View style={styles.overlay} />
                    </View>
                )}

                {/* Draggable Self Video (Only in Video Call) */}
                {isVideo && (
                    <GestureDetector gesture={panGesture}>
                        <Animated.View style={[styles.selfVideoContainer, selfVideoStyle]}>
                            {RTCView && localStream && !isVideoOff ? (
                                <RTCView
                                    streamURL={typeof localStream.toURL === 'function' ? localStream.toURL() : localStream}
                                    style={styles.selfVideo}
                                    objectFit="cover"
                                    mirror={true}
                                    zOrder={1}
                                />
                            ) : (
                                <View style={styles.selfVideoPlaceholder}>
                                    <MaterialIcons name="videocam-off" size={24} color="rgba(255,255,255,0.5)" />
                                </View>
                            )}
                        </Animated.View>
                    </GestureDetector>
                )}

                {/* Content Layer */}
                <View style={styles.content}>
                    {/* Header */}
                    <View style={styles.header}>
                        {/* Drag Handle for visual cue */}
                        <View style={styles.dragHandle} />
                        
                        <Pressable onPress={handleMinimize} style={styles.iconButton}>
                            <MaterialIcons name="keyboard-arrow-down" size={32} color="white" />
                        </Pressable>
                        <Text style={styles.headerTitle}>
                            {activeCall.type === 'video' ? 'SoulSync Video' : 'SoulSync Audio'}
                        </Text>
                        <View style={{ width: 32 }} />
                    </View>

                    {/* Main Info Area */}
                    <View style={styles.mainInfo}>
                        {!isVideo && (
                            <View style={styles.avatarWrapper}>
                                <Animated.View style={[styles.pulseRing, pulseStyle]} />
                                <Animated.View style={[styles.pulseRing, pulseStyle, { animationDelay: '500ms' }]} />
                                <View style={styles.avatarShadow}>
                                    <View style={styles.avatarContainer}>
                                        <Image 
                                            source={{ uri: contact.avatar }} 
                                            style={styles.avatar} 
                                            resizeMode="cover"
                                        />
                                    </View>
                                </View>
                            </View>
                        )}

                        <View style={styles.textContainer}>
                            <Text style={styles.contactName}>{contact.name}</Text>
                            <Text style={styles.callStatus}>
                                {activeCall.isAccepted
                                    ? formatDuration(callDuration)
                                    : (activeCall.isIncoming ? (activeCall.isRinging ? 'Ringing...' : 'Incoming Call') : 'Calling...')}
                            </Text>
                        </View>
                    </View>

                    {/* Controls Footer */}
                    <BlurView intensity={80} tint="systemThinMaterialDark" style={styles.controlsBar} experimentalBlurMethod="dimezisBlurView">
                        <View style={styles.controlsRow}>
                            <Pressable
                                style={[styles.controlBtn, activeCall?.isMuted && styles.controlBtnActive]}
                                onPress={handleToggleMute}
                            >
                                <MaterialIcons
                                    name={activeCall?.isMuted ? "mic-off" : "mic"}
                                    size={28}
                                    color={activeCall?.isMuted ? "#000000" : "white"}
                                />
                            </Pressable>

                            <Pressable
                                style={[styles.controlBtn, isSpeaker && styles.controlBtnActive]}
                                onPress={handleToggleSpeaker}
                            >
                                <MaterialIcons
                                    name={isSpeaker ? "volume-up" : "volume-down"}
                                    size={28}
                                    color={isSpeaker ? "#000000" : "white"}
                                />
                            </Pressable>

                            {isVideo && (
                                <Pressable style={styles.controlBtn} onPress={handleToggleVideo}>
                                    <MaterialIcons
                                        name={isVideoOff ? "videocam-off" : "videocam"}
                                        size={28}
                                        color={isVideoOff ? "#000000" : "white"}
                                    />
                                </Pressable>
                            )}

                            {isVideo && (
                                <Pressable style={styles.controlBtn} onPress={handleSwitchCamera}>
                                    <Ionicons name="camera-reverse" size={28} color="white" />
                                </Pressable>
                            )}

                            <Pressable
                                style={[styles.controlBtn, styles.endCallBtn]}
                                onPress={handleEndCall}
                            >
                                <MaterialIcons name="call-end" size={32} color="white" />
                            </Pressable>
                        </View>
                    </BlurView>
                </View>
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
        backgroundColor: '#333',
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
    dragHandle: {
        position: 'absolute',
        top: -40,
        left: '50%',
        marginLeft: -20,
        width: 40,
        height: 5,
        backgroundColor: 'rgba(255,255,255,0.3)',
        borderRadius: 10,
    },
    iconButton: {
        padding: 8,
        borderRadius: 20,
        backgroundColor: 'rgba(255,255,255,0.1)',
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
        marginBottom: 8,
        letterSpacing: 0.5,
        ...callContactNameShadow,
    },
    callStatus: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 18,
        fontWeight: '500',
        letterSpacing: 1,
    },
    controlsBar: {
        marginHorizontal: 20,
        marginBottom: 50,
        borderRadius: 40,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    controlsRow: {
        flexDirection: 'row',
        justifyContent: 'space-evenly',
        alignItems: 'center',
        paddingVertical: 20,
    },
    controlBtn: {
        width: 50,
        height: 50,
        borderRadius: 25,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    controlBtnActive: {
        backgroundColor: 'white',
    },
    endCallBtn: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: '#ef4444',
    }
});
