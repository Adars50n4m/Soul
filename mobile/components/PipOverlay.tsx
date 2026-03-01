import React, { useRef, useMemo } from 'react';
import { View, Image, Pressable, Text, StyleSheet, Animated, PanResponder, Platform, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';

// Safe import for RTCView
let RTCView: any = null;
let webRTCService: any = null;
try {
    const webrtc = require('react-native-webrtc');
    RTCView = webrtc.RTCView;
    webRTCService = require('../services/WebRTCService').webRTCService;
} catch(e) {
    console.log("WebRTC not available in PipOverlay");
}

const OVERLAY_WIDTH = 110;
const OVERLAY_HEIGHT = 160;

export default function PipOverlay() {
    const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
    const router = useRouter();
    const { activeCall, contacts, toggleMinimizeCall, endCall } = useApp();
    const contact = contacts.find(c => c.id === activeCall?.contactId);

    const position = useMemo(() => new Animated.ValueXY({
        x: SCREEN_WIDTH - OVERLAY_WIDTH - 20,
        y: 100
    }), [SCREEN_WIDTH]);

    const panResponder = useMemo(() =>
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                position.setOffset({
                    x: (position.x as any)._value,
                    y: (position.y as any)._value,
                });
                position.setValue({ x: 0, y: 0 });
            },
            onPanResponderMove: Animated.event(
                [null, { dx: position.x, dy: position.y }],
                { useNativeDriver: false }
            ),
            onPanResponderRelease: () => {
                position.flattenOffset();

                let finalX = (position.x as any)._value;
                let finalY = (position.y as any)._value;

                // Snap logic
                if (finalX < 0) finalX = 10;
                if (finalX > SCREEN_WIDTH - OVERLAY_WIDTH) finalX = SCREEN_WIDTH - OVERLAY_WIDTH - 10;
                if (finalY < 50) finalY = 60;
                if (finalY > SCREEN_HEIGHT - OVERLAY_HEIGHT - 120) finalY = SCREEN_HEIGHT - OVERLAY_HEIGHT - 120;

                Animated.spring(position, {
                    toValue: { x: finalX, y: finalY },
                    useNativeDriver: false,
                    tension: 40,
                    friction: 8,
                }).start();
            },
        }), [position, SCREEN_WIDTH, SCREEN_HEIGHT]);

    const handlePress = () => {
        if (!activeCall || !contact) return;
        toggleMinimizeCall(false);
        router.push('/call');
    };

    const handleEndCall = () => {
        endCall();
    };

    if (!activeCall || !activeCall.isMinimized || !contact) return null;

    const isVideo = activeCall.type === 'video';
    // Get the remote stream for the PiP window
    const remoteStream = webRTCService ? webRTCService.getRemoteStream() : null;

    return (
        <Animated.View
            style={[
                styles.container,
                { transform: position.getTranslateTransform() },
            ]}
            {...panResponder.panHandlers}
        >
            <Pressable onPress={handlePress} style={styles.pressable}>
                <View style={styles.contentContainer}>
                    {isVideo ? (
                        remoteStream ? (
                            <RTCView
                                streamURL={remoteStream.toURL()}
                                style={styles.videoStream}
                                objectFit="cover"
                                mirror={false}
                                zOrder={2} // Ensure it sits on top
                            />
                        ) : (
                             // Fallback if video stream is missing but call type is video
                            <Image
                                source={{ uri: contact.avatar }}
                                style={styles.videoImage}
                                resizeMode="cover"
                            />
                        )
                    ) : (
                        // Audio Call Look
                        <BlurView intensity={80} tint="dark" style={styles.blur} experimentalBlurMethod="dimezisBlurView">
                            <View style={styles.audioContent}>
                                <View style={styles.avatarContainer}>
                                    <Image source={{ uri: contact.avatar }} style={styles.avatar} />
                                </View>
                                <View style={styles.pulseContainer}>
                                    <View style={styles.pulseDot} />
                                    <View style={styles.pulseDot} />
                                    <View style={styles.pulseDot} />
                                </View>
                            </View>
                        </BlurView>
                    )}

                    {/* Controls Overlay */}
                    <View style={styles.overlayControls}>
                         <Pressable style={styles.endButton} onPress={handleEndCall}>
                            <MaterialIcons name="call-end" size={16} color="#ffffff" />
                        </Pressable>
                    </View>
                </View>
            </Pressable>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        zIndex: 9999, // Very high z-index
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
    },
    pressable: {
        width: '100%',
        height: '100%',
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.3)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.5,
        shadowRadius: 10,
        elevation: 10,
        backgroundColor: '#000',
    },
    contentContainer: {
        flex: 1,
        position: 'relative',
    },
    videoStream: {
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a1a',
    },
    blur: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.6)',
    },
    videoImage: {
        width: '100%',
        height: '100%',
        opacity: 0.8,
    },
    audioContent: {
        alignItems: 'center',
        gap: 12,
    },
    avatarContainer: {
        width: 48,
        height: 48,
        borderRadius: 24,
        borderWidth: 2,
        borderColor: 'rgba(244, 63, 94, 0.5)',
        padding: 2,
    },
    avatar: {
        width: '100%',
        height: '100%',
        borderRadius: 22,
    },
    pulseContainer: {
        flexDirection: 'row',
        gap: 4,
    },
    pulseDot: {
        width: 4,
        height: 4,
        borderRadius: 2,
        backgroundColor: '#f43f5e',
    },
    overlayControls: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        alignItems: 'center',
        paddingBottom: 20,
        zIndex: 10,
    },
    endButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: '#ef4444',
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: 'black',
        shadowOpacity: 0.3,
        shadowRadius: 3,
        elevation: 5,
    },
});
