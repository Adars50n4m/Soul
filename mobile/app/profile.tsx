import React from 'react';
import {
    View, Text, Image, StyleSheet, StatusBar, Dimensions,    useWindowDimensions, Pressable
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { Alert } from 'react-native';
import { useApp } from '../context/AppContext';
import Animated, {
    FadeIn,
    FadeOut,
    SlideInRight,
    SlideOutLeft,
    withSpring,
    useAnimatedScrollHandler,
    useSharedValue,
    useAnimatedStyle,
    interpolate,
    Extrapolation,
} from 'react-native-reanimated';

const HEADER_HEIGHT = 300;

const MenuItem = ({ icon, title, subtitle, onPress, isLast, danger }: any) => (
    <Pressable
        style={({ pressed }) => [
            styles.menuItem,
            pressed && { opacity: 0.7 },
            !isLast && styles.menuItemBorder
        ]}
        onPress={onPress}
    >
        <View style={[styles.menuIconContainer, danger && { backgroundColor: 'rgba(239, 68, 68, 0.1)' }]}>
            <Ionicons name={icon} size={22} color={danger ? '#ef4444' : '#fff'} />
        </View>
        <View style={styles.menuTextContainer}>
            <Text style={[styles.menuTitle, danger && { color: '#ef4444' }]}>{title}</Text>
            {subtitle && <Text style={styles.menuSubtitle}>{subtitle}</Text>}
        </View>
        <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.2)" />
    </Pressable>
);

export default function ProfileScreen() {
    const { width } = useWindowDimensions();
    const router = useRouter();
    const navigation = useNavigation();
    const { currentUser, logout, activeTheme } = useApp();
    const scrollY = useSharedValue(0);

    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollY.value = event.contentOffset.y;
        },
    });

    const avatarAnimatedStyle = useAnimatedStyle(() => ({
        opacity: interpolate(scrollY.value, [0, HEADER_HEIGHT / 2], [1, 0], Extrapolation.CLAMP),
        transform: [{ scale: interpolate(scrollY.value, [0, HEADER_HEIGHT], [1, 0.5], Extrapolation.CLAMP) }],
    }));

    const headerTitleStyle = useAnimatedStyle(() => ({
        opacity: interpolate(scrollY.value, [HEADER_HEIGHT / 2, HEADER_HEIGHT], [0, 1], Extrapolation.CLAMP),
    }));

    if (!currentUser) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>Please log in to view profile</Text>
            </View>
        );
    }

    const handleLogout = () => {
        Alert.alert(
            'Logout',
            'Are you sure you want to disconnect your SoulSync?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Logout',
                    style: 'destructive',
                    onPress: async () => {
                        await logout();
                        router.replace('/login' as any);
                    }
                }
            ]
        );
    };

    const handleEditProfile = () => {
        router.push('/profile-edit' as any);
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" translucent />

            {/* Ambient Background Orbs */}
            <View style={StyleSheet.absoluteFill}>
                <LinearGradient
                    colors={['rgba(244, 63, 94, 0.1)', 'transparent']}
                    style={[styles.orb, { top: -100, left: -50 }]}
                />
                <LinearGradient
                    colors={['rgba(168, 85, 247, 0.1)', 'transparent']}
                    style={[styles.orb, { bottom: 100, right: -100 }]}
                />
                <LinearGradient
                    colors={['rgba(59, 130, 246, 0.05)', 'transparent']}
                    style={[styles.orb, { top: '40%', right: -50 }]}
                />
                <LinearGradient
                    colors={['rgba(244, 63, 94, 0.08)', 'transparent']}
                    style={[styles.orb, { top: '60%', left: -100 }]}
                />
            </View>

            {/* Header Content */}
            <View style={styles.topBar}>
                <Pressable 
                    onPress={() => {
                        if (navigation.canGoBack()) navigation.goBack();
                    }} 
                    style={styles.backButton}
                >
                    <Ionicons name="chevron-back" size={28} color="#ffffff" />
                </Pressable>
                <Animated.Text style={[styles.headerTitle, headerTitleStyle]}>
                    Profile
                </Animated.Text>
                <View style={{ width: 44 }} />
            </View>

            <Animated.ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler}
                scrollEventThrottle={16}
            >
                {/* Hero Profile Section */}
                <Animated.View style={[styles.heroSection, avatarAnimatedStyle]}>
                    <Pressable onPress={handleEditProfile}>
                        <Animated.View
                            style={styles.avatarGlowContainer}
                        >
                            <Image source={{ uri: currentUser.avatar }} style={styles.profileAvatar} />
                            <View style={styles.avatarGlassBorder} />
                            <View style={styles.editOverlay}>
                                <MaterialIcons name="edit" size={24} color="#ffffff" />
                            </View>
                        </Animated.View>
                    </Pressable>
                    <Text style={styles.userName}>{currentUser.name}</Text>
                    <Text style={styles.userHandle}>@{currentUser.id || 'soul_sync'}</Text>
                    <Pressable 
                        style={({ pressed }) => [styles.editProfileButton, pressed && styles.editProfileButtonPressed]}
                        onPress={handleEditProfile}
                    >
                        <MaterialIcons name="edit" size={18} color="#ffffff" />
                        <Text style={styles.editProfileText}>Edit Profile</Text>
                    </Pressable>
                </Animated.View>

                {/* Glassmorphism Menu Cards */}
                <View style={styles.menuContainer}>
                    <BlurView intensity={20} tint="dark" style={styles.glassCard} experimentalBlurMethod="dimezisBlurView">
                        <MenuItem 
                            icon="person-outline" 
                            title="Profile Status" 
                            subtitle="Always connected"
                            onPress={() => {}} 
                        />
                        <MenuItem 
                            icon="images-outline" 
                            title="Shared Photos" 
                            subtitle="128 high quality captures"
                            onPress={() => {}} 
                        />
                        <MenuItem 
                            icon="settings-outline" 
                            title="Account Settings" 
                            subtitle="Privacy, Security, Presence"
                            onPress={() => router.push('/settings' as any)} 
                        />
                        <MenuItem 
                            icon="log-out-outline" 
                            title="Log Out" 
                            danger 
                            isLast
                            onPress={handleLogout} 
                        />
                    </BlurView>
                </View>

                <Text style={styles.footerNote}>
                    Your profile is synced with the SoulSync network.
                </Text>
            </Animated.ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#09090E',
    },
    orb: {
        position: 'absolute',
        width: 300,
        height: 300,
        borderRadius: 150,
        opacity: 0.6,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 60,
        paddingHorizontal: 20,
        zIndex: 10,
    },
    backButton: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.05)',
    },
    headerTitle: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '800',
        letterSpacing: 1,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        paddingTop: 20,
        paddingBottom: 100,
    },
    heroSection: {
        alignItems: 'center',
        paddingVertical: 40,
    },
    avatarGlowContainer: {
        position: 'relative',
        padding: 10,
    },
    profileAvatar: {
        width: 140,
        height: 140,
        borderRadius: 70,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    avatarGlassBorder: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 80,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        margin: -5,
    },
    editOverlay: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(244, 63, 94, 0.9)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 3,
        borderColor: '#09090E',
    },
    editProfileButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(244, 63, 94, 0.2)',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 25,
        marginTop: 16,
        borderWidth: 1,
        borderColor: 'rgba(244, 63, 94, 0.3)',
    },
    editProfileButtonPressed: {
        opacity: 0.7,
        transform: [{ scale: 0.96 }],
    },
    editProfileText: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
        marginLeft: 8,
    },
    userName: {
        color: '#ffffff',
        fontSize: 32,
        fontWeight: '900',
        marginTop: 20,
        letterSpacing: -0.5,
    },
    userHandle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 16,
        fontWeight: '500',
        marginTop: 4,
    },
    menuContainer: {
        paddingHorizontal: 20,
        marginTop: 20,
    },
    glassCard: {
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        backgroundColor: 'rgba(255,255,255,0.02)',
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 20,
        paddingVertical: 22,
    },
    menuItemBorder: {
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.05)',
    },
    menuIconContainer: {
        width: 44,
        height: 44,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
    },
    menuTextContainer: {
        flex: 1,
    },
    menuTitle: {
        color: '#ffffff',
        fontSize: 17,
        fontWeight: '600',
    },
    menuSubtitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 13,
        marginTop: 2,
    },
    footerNote: {
        color: 'rgba(255,255,255,0.2)',
        fontSize: 12,
        textAlign: 'center',
        marginTop: 40,
        lineHeight: 18,
    },
    errorText: {
        color: '#ef4444',
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
});
