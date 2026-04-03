import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, interpolate, Extrapolation, SharedValue } from 'react-native-reanimated';
import ProgressiveBlur from './chat/ProgressiveBlur';
import GlassView from './ui/GlassView';

interface ProfileHeaderProps {
    image: string | any;
    name: string;
    subtitle?: string;
    username: string;
    onEditPress?: () => void;
    heroRef?: React.Ref<View>;
    hidden?: boolean;
    isVerified?: boolean;
    scrollY?: SharedValue<number>;
}

/**
 * ProfileHeader — Reusable component with iOS-style progressive blur.
 * Matches design specs: 320 height, 28 radius, misty glass blur.
 */
const ProfileHeader = ({
    image,
    name,
    subtitle,
    username,
    onEditPress,
    heroRef,
    hidden = false,
    isVerified = true,
    scrollY,
}: ProfileHeaderProps) => {
    const animatedImageStyle = useAnimatedStyle(() => {
        if (!scrollY) return {};
        
        const translateY = interpolate(
            scrollY.value,
            [-320, 0, 320],
            [-100, 0, 100],
            Extrapolation.CLAMP
        );
        
        const scale = interpolate(
            scrollY.value,
            [-320, 0],
            [1.5, 1],
            Extrapolation.CLAMP
        );

        return {
            transform: [{ translateY }, { scale }] as any,
        };
    });

    return (
        <View style={styles.container}>
            <View
                ref={heroRef}
                collapsable={false}
                renderToHardwareTextureAndroid
                shouldRasterizeIOS
                style={[styles.imageContainer, hidden && styles.imageContainerHidden]}
            >
                <Animated.View style={[styles.imageWrapper, animatedImageStyle as any]}>
                    <Image
                        source={typeof image === 'string' ? { uri: image } : image}
                        style={styles.image}
                        contentFit="cover"
                        transition={0}
                    />
                </Animated.View>
                
                {/* iOS-style progressive blur — fades from clear (top) to blurred (bottom) */}
                <ProgressiveBlur
                    position="bottom"
                    height={260}
                    intensity={70}
                />

                {/* Content Overlay */}
                <View style={styles.contentOverlay}>
                    <View style={styles.mainInfo}>
                        <View style={styles.nameRow}>
                            <Text style={styles.name}>{name}</Text>
                            {isVerified && (
                                <MaterialIcons name="verified" size={20} color="#fff" style={styles.verifiedIcon} />
                            )}
                        </View>
                        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
                    </View>

                    <View style={styles.footerRow}>
                        <View style={styles.usernameRow}>
                            <Text style={styles.username}>{username.startsWith('@') ? username : `@${username}`}</Text>
                        </View>

                        <Pressable style={styles.circularEditButton} onPress={onEditPress}>
                            <GlassView intensity={40} tint="light" style={styles.circularEditGlass}>
                                <MaterialIcons name="edit" size={20} color="#ffffff" />
                            </GlassView>
                        </Pressable>
                    </View>
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        height: 320,
        marginHorizontal: 16,
        marginBottom: 24,
    },
    imageContainer: {
        flex: 1,
        borderRadius: 28,
        overflow: 'hidden',
        backgroundColor: '#1a1a1a',
    },
    imageContainerHidden: {
        opacity: 0,
    },
    imageWrapper: {
        width: '100%',
        height: '140%', // Extra height for parallax movement
        position: 'absolute',
        top: -40, // Offset to account for extra height
    },
    image: {
        width: '100%',
        height: '100%',
    },
    contentOverlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        padding: 20,
        paddingBottom: 20, // Pushed up from 4 to sit better
        zIndex: 10,
    },
    mainInfo: {
        marginBottom: 1,
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    name: {
        color: '#ffffff',
        fontSize: 28,
        fontWeight: '700',
        letterSpacing: -0.5,
    },
    verifiedIcon: {
        marginTop: 4,
    },
    subtitle: {
        color: 'rgba(255,255,255,0.9)',
        fontSize: 15,
        fontWeight: '500',
        marginTop: 2,
    },
    footerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 12,
    },
    usernameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    username: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 15,
        fontWeight: '700',
    },
    circularEditButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
    },
    circularEditGlass: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default ProfileHeader;
