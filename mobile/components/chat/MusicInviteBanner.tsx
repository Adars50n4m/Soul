import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withDelay,
    runOnJS,
    Easing,
} from 'react-native-reanimated';
import { MaterialIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import type { MusicInvite } from '../../context/MusicContext';

interface MusicInviteBannerProps {
    invite: MusicInvite;
    accent: string;
    contactName: string;
    onAccept: () => void;
    onDecline: () => void;
}

const AUTO_DISMISS_MS = 18_000;

const MusicInviteBanner: React.FC<MusicInviteBannerProps> = ({
    invite,
    accent,
    contactName,
    onAccept,
    onDecline,
}) => {
    const translateY = useSharedValue(-72);
    const opacity    = useSharedValue(0);
    const contentOp  = useSharedValue(0);
    const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const dismiss = (cb: () => void) => {
        if (dismissTimer.current) clearTimeout(dismissTimer.current);
        translateY.value = withSpring(-72, { damping: 18, stiffness: 260, mass: 0.6 });
        opacity.value    = withTiming(0, { duration: 200 });
        contentOp.value  = withTiming(0, { duration: 120 }, () => runOnJS(cb)());
    };

    useEffect(() => {
        // Slide down
        translateY.value = withSpring(0, { damping: 20, stiffness: 240, mass: 0.65 });
        opacity.value    = withTiming(1, { duration: 220 });
        contentOp.value  = withDelay(120, withTiming(1, { duration: 200 }));

        // Auto-dismiss
        dismissTimer.current = setTimeout(() => dismiss(onDecline), AUTO_DISMISS_MS);
        return () => {
            if (dismissTimer.current) clearTimeout(dismissTimer.current);
        };
    }, [invite.song.id]);

    const wrapStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
        opacity: opacity.value,
    }));
    const innerStyle = useAnimatedStyle(() => ({ opacity: contentOp.value }));

    return (
        <Animated.View style={[styles.pill, wrapStyle]} pointerEvents="box-none">
            <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[styles.accentBar, { backgroundColor: accent }]} />

            {/* Album art */}
            <View style={styles.artWrap}>
                {invite.song.image ? (
                    <Image
                        source={{ uri: invite.song.image }}
                        style={styles.art}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                    />
                ) : (
                    <View style={[styles.art, styles.artFallback]}>
                        <MaterialIcons name="music-note" size={18} color={accent} />
                    </View>
                )}
            </View>

            {/* Text */}
            <Animated.View style={[styles.textWrap, innerStyle]}>
                <Text style={styles.label} numberOfLines={1}>
                    {contactName} is listening
                </Text>
                <Text style={[styles.songName, { color: '#fff' }]} numberOfLines={1}>
                    {invite.song.name}
                </Text>
                <Text style={styles.artist} numberOfLines={1}>
                    {invite.song.artist}
                </Text>
            </Animated.View>

            {/* Buttons */}
            <Animated.View style={[styles.btns, innerStyle]}>
                <Pressable
                    onPress={() => dismiss(onDecline)}
                    style={styles.declineBtn}
                    hitSlop={8}
                >
                    <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.5)" />
                </Pressable>
                <Pressable
                    onPress={() => dismiss(onAccept)}
                    style={[styles.acceptBtn, { backgroundColor: accent }]}
                    hitSlop={4}
                >
                    <MaterialIcons name="headset" size={15} color="#fff" />
                    <Text style={styles.acceptText}>Join</Text>
                </Pressable>
            </Animated.View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        height: 56,
        borderRadius: 28,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        backgroundColor: 'rgba(18,16,28,0.72)',
        paddingHorizontal: 10,
        gap: 8,
        // Shadow
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 14,
        elevation: 12,
    },
    accentBar: {
        width: 3,
        height: 32,
        borderRadius: 2,
        flexShrink: 0,
    },
    artWrap: {
        width: 36,
        height: 36,
        borderRadius: 10,
        overflow: 'hidden',
        flexShrink: 0,
    },
    art: {
        width: 36,
        height: 36,
    },
    artFallback: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    textWrap: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    label: {
        color: 'rgba(255,255,255,0.45)',
        fontSize: 9.5,
        fontWeight: '700',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        marginBottom: 1,
    },
    songName: {
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.1,
    },
    artist: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 11,
        fontWeight: '500',
        marginTop: 1,
    },
    btns: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
    },
    declineBtn: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    acceptBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 16,
    },
    acceptText: {
        color: '#fff',
        fontSize: 12.5,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
});

export default MusicInviteBanner;
