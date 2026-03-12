import React, { useRef, useMemo, useEffect } from 'react';
import { View, Image, Pressable, Text, StyleSheet, Animated, PanResponder, Platform, useWindowDimensions } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import GlassView from './ui/GlassView';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { SoulAvatar } from './SoulAvatar';

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

const OVERLAY_WIDTH = 100;
const OVERLAY_HEIGHT = 140;

export default function PipOverlay() {
    const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
    const router = useRouter();
    const segments = useSegments();
    const { activeCall, contacts, toggleMinimizeCall, endCall } = useApp();
    const contact = contacts.find(c => c.id === activeCall?.contactId);

    const position = useMemo(() => new Animated.ValueXY({
        x: SCREEN_WIDTH - OVERLAY_WIDTH - 16,
        y: 80
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
                if (finalX < 10) finalX = 10;
                if (finalX > SCREEN_WIDTH - OVERLAY_WIDTH - 10) finalX = SCREEN_WIDTH - OVERLAY_WIDTH - 10;
                if (finalY < 40) finalY = 60;
                if (finalY > SCREEN_HEIGHT - OVERLAY_HEIGHT - 100) finalY = SCREEN_HEIGHT - OVERLAY_HEIGHT - 100;

                // Snap to left or right sides
                const snapX = finalX < SCREEN_WIDTH / 2 ? 16 : SCREEN_WIDTH - OVERLAY_WIDTH - 16;

                Animated.spring(position, {
                    toValue: { x: snapX, y: finalY },
                    useNativeDriver: false,
                    tension: 60,
                    friction: 10,
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

    // --- LOGIC: When to show this overlay ---
    // Show if:
    // 1. There is an active call with a valid call ID
    // 2. We are NOT on the /call screen
    // 3. The call is either accepted or it's outgoing (not incoming waiting)
    const inCallScreen = segments[0] === 'call';

    // FIX: More robust check for active call - must have callId and not be ended
    const hasValidCall = activeCall && activeCall.callId && !activeCall.callId.includes('ended');

    const isVisible = hasValidCall && !inCallScreen && contact && (activeCall.isAccepted || !activeCall.isIncoming);

    // Debug log to help diagnose PiP issues
    console.log(`[PipOverlay] visible:${isVisible} callId:${activeCall?.callId} inCallScreen:${inCallScreen} isAccepted:${activeCall?.isAccepted} isIncoming:${activeCall?.isIncoming}`);

    if (!isVisible) return null;

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
            <View style={styles.shadowWrapper}>
                <Pressable onPress={handlePress} style={styles.pressable}>
                    <View style={styles.contentContainer}>
                        {isVideo ? (
                            remoteStream ? (
                                <RTCView
                                    streamURL={typeof remoteStream.toURL === 'function' ? remoteStream.toURL() : remoteStream}
                                    style={styles.videoStream}
                                    objectFit="cover"
                                    mirror={false}
                                    zOrder={2}
                                />
                            ) : (
                                <View style={styles.videoPlaceholder}>
                                    <SoulAvatar uri={contact.avatar} size={50} />
                                    <Text style={styles.placeholderLabel}>No Video</Text>
                                </View>
                            )
                        ) : (
                            <GlassView intensity={60} tint="dark" style={styles.audioBlur}>
                                <View style={styles.audioContent}>
                                    <SoulAvatar uri={contact.avatar} size={44} />
                                    <View style={styles.pulseContainer}>
                                        <Animated.View style={styles.pulseDot} />
                                        <Animated.View style={[styles.pulseDot, { opacity: 0.6 }]} />
                                        <Animated.View style={[styles.pulseDot, { opacity: 0.3 }]} />
                                    </View>
                                </View>
                            </GlassView>
                        )}

                        {/* Top Indicator */}
                        <View style={styles.topBar}>
                            <MaterialIcons name={isVideo ? "videocam" : "call"} size={10} color="rgba(255,255,255,0.8)" />
                            <Text style={styles.topLabel} numberOfLines={1}>{contact.name}</Text>
                        </View>

                        {/* Floating End Button */}
                        <Pressable style={styles.endCallBubble} onPress={handleEndCall}>
                            <MaterialIcons name="call-end" size={14} color="white" />
                        </Pressable>
                    </View>
                </Pressable>
            </View>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        zIndex: 10000, 
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
    },
    shadowWrapper: {
        flex: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 12,
        elevation: 15,
    },
    pressable: {
        width: '100%',
        height: '100%',
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1.5,
        borderColor: 'rgba(255,255,255,0.15)',
        backgroundColor: '#000',
    },
    contentContainer: {
        flex: 1,
        position: 'relative',
    },
    videoStream: {
        width: '100%',
        height: '100%',
        backgroundColor: '#121212',
    },
    videoPlaceholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1C1C1E',
    },
    placeholderLabel: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 10,
        marginTop: 8,
    },
    audioBlur: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    audioContent: {
        alignItems: 'center',
        paddingTop: 10,
    },
    pulseContainer: {
        flexDirection: 'row',
        gap: 4,
        marginTop: 12,
    },
    pulseDot: {
        width: 4,
        height: 4,
        borderRadius: 2,
        backgroundColor: '#3b82f6',
    },
    topBar: {
        position: 'absolute',
        top: 8,
        left: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
        gap: 4,
        zIndex: 10,
    },
    topLabel: {
        color: 'white',
        fontSize: 10,
        fontWeight: '600',
        maxWidth: 60,
        textShadowColor: 'black',
        textShadowRadius: 3,
    },
    endCallBubble: {
        position: 'absolute',
        bottom: 12,
        alignSelf: 'center',
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: '#ef4444',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
    },
});

