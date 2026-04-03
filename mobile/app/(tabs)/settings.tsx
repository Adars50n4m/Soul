import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useApp } from '../../context/AppContext';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import Animated, {
    useAnimatedScrollHandler,
    useSharedValue,
    runOnJS,
} from 'react-native-reanimated';
import { useScrollMotion } from '../../components/navigation/ScrollMotionProvider';

import ProfileHeader from '../../components/ProfileHeader';
import {
    getProfileEditSourceHidden,
    subscribeProfileEditSourceHidden,
} from '../../services/profileEditMorphState';

const SettingItem = ({ icon, title, subtitle, onPress, rightElement, danger, activeTheme }: any) => (
    <Pressable style={styles.settingItem} onPress={onPress}>
        <View style={[styles.settingIcon, { backgroundColor: danger ? 'rgba(239,68,68,0.1)' : `${activeTheme.primary}20` }]}>
            <MaterialIcons name={icon} size={22} color={danger ? '#ef4444' : activeTheme.primary} />
        </View>
        <View style={styles.settingInfo}>
            <Text style={[styles.settingTitle, danger && { color: '#ef4444' }]}>{title}</Text>
            {subtitle && <Text style={styles.settingSubtitle}>{subtitle}</Text>}
        </View>
        {rightElement || <MaterialIcons name="chevron-right" size={24} color="rgba(255,255,255,0.3)" />}
    </Pressable>
);

export default function SettingsScreen() {
    const router = useRouter();
    const { currentUser, logout, theme, activeTheme } = useApp();
    const [notifications, setNotifications] = useState(true);
    const [isProfileHeroHidden, setIsProfileHeroHidden] = useState(getProfileEditSourceHidden());
    const isNavigatingRef = useRef(false);
    const profileHeroRef = useRef<View>(null);
    const scrollY = useSharedValue(0);

    const { onScrollRaw: handleScrollMotionRaw } = useScrollMotion('settings');

    const onScroll = useAnimatedScrollHandler((event) => {
        scrollY.value = event.contentOffset.y;
        runOnJS(handleScrollMotionRaw)(event.contentOffset.y);
    });

    useFocusEffect(
        useCallback(() => {
            isNavigatingRef.current = false;
            return undefined;
        }, [])
    );

    useEffect(() => subscribeProfileEditSourceHidden(setIsProfileHeroHidden), []);

    const openProfileEdit = () => {
        if (isNavigatingRef.current) return;
        isNavigatingRef.current = true;
        profileHeroRef.current?.measure((x, y, width, height, pageX, pageY) => {
            router.push({
                pathname: '/profile-edit',
                params: width && height ? {
                    heroX: Math.round(pageX).toString(),
                    heroY: Math.round(pageY).toString(),
                    heroW: Math.round(width).toString(),
                    heroH: Math.round(height).toString(),
                    heroScrollY: String(scrollY.value ?? 0),
                } : undefined,
            } as any);
        });
    };

    const handleLogout = () => {
        Alert.alert(
            'Logout',
            'Are you sure you want to logout?',
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

    const handleReportProblem = async () => {
        const url = 'mailto:work.adarshthakur@gmail.com?subject=Soul%20-%20Problem%20Report';
        try {
            await Linking.openURL(url);
        } catch (error) {
            Alert.alert(
                'Unable to open mail',
                'Please contact us directly at:\n\nwork.adarshthakur@gmail.com',
                [{ text: 'OK' }]
            );
        }
    };

    const handleClearCache = () => {
        Alert.alert(
            'Clear Cache',
            'This will clear cached data. Your messages and contacts will be preserved.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Clear',
                    onPress: () => {
                        Alert.alert('Success', 'Cache cleared successfully');
                    }
                }
            ]
        );
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            <Animated.ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={16}
            >
                {/* Cinematic Profile Card */}
                <ProfileHeader
                    image={currentUser?.avatar}
                    name={currentUser?.name || 'User'}
                    subtitle={currentUser?.bio}
                    username={currentUser?.username || 'user'}
                    onEditPress={openProfileEdit}
                    heroRef={profileHeroRef}
                    hidden={isProfileHeroHidden}
                    scrollY={scrollY}
                />

                {/* Theme Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>APPEARANCE</Text>
                    <View style={styles.settingsGroup}>
                        <Pressable style={styles.settingItem} onPress={() => router.push('/theme')}>
                            <View style={[styles.settingIcon, { backgroundColor: `${activeTheme.primary}20` }]}>
                                <MaterialIcons name="palette" size={22} color={activeTheme.primary} />
                            </View>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingTitle}>Theme</Text>
                                <Text style={styles.settingSubtitle}>{theme.replace('-', ' ')}</Text>
                            </View>
                            <View style={styles.themePreviewMini}>
                                <View style={[styles.themeSwatchMini, { backgroundColor: activeTheme.primary }]} />
                                <View style={[styles.themeSwatchMini, { backgroundColor: activeTheme.accent }]} />
                            </View>
                            <MaterialIcons name="chevron-right" size={24} color="rgba(255,255,255,0.3)" />
                        </Pressable>
                    </View>
                </View>

                {/* Account Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>ACCOUNT</Text>
                    <View style={styles.settingsGroup}>
                        <SettingItem
                            icon="key"
                            title="Privacy"
                            subtitle="Last seen, profile photo, status"
                            onPress={() => router.push('/privacy' as any)}
                            activeTheme={activeTheme}
                        />
                        <SettingItem
                            icon="security"
                            title="Security"
                            subtitle="Two-step verification, fingerprint"
                            onPress={() => router.push('/security')}
                            activeTheme={activeTheme}
                        />
                        <SettingItem
                            icon="notifications"
                            title="Notifications"
                            subtitle={notifications ? 'Enabled' : 'Disabled'}
                            onPress={() => setNotifications(!notifications)}
                            activeTheme={activeTheme}
                            rightElement={
                                <View style={[styles.toggle, notifications && { backgroundColor: activeTheme.primary }]}>
                                    <View style={[styles.toggleKnob, notifications && styles.toggleKnobActive]} />
                                </View>
                            }
                        />
                    </View>
                </View>

                {/* Storage Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>STORAGE & DATA</Text>
                    <View style={styles.settingsGroup}>
                        <SettingItem
                            icon="data-usage"
                            title="Storage Usage"
                            subtitle="Manage storage and media"
                            onPress={() => router.push('/storage-management' as any)}
                            activeTheme={activeTheme}
                        />
                        <SettingItem
                            icon="cleaning-services"
                            title="Clear Cache"
                            subtitle="Free up space"
                            onPress={handleClearCache}
                            activeTheme={activeTheme}
                        />
                    </View>
                </View>

                {/* Help Section */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>HELP & SUPPORT</Text>
                    <View style={styles.settingsGroup}>
                        <SettingItem
                            icon="help-outline"
                            title="Help Center"
                            onPress={() => router.push('/help-center' as any)}
                            activeTheme={activeTheme}
                        />
                        <SettingItem
                            icon="bug-report"
                            title="Report a Problem"
                            onPress={handleReportProblem}
                            activeTheme={activeTheme}
                        />
                        <SettingItem
                            icon="info-outline"
                            title="About"
                            subtitle="Version 1.0.0"
                            onPress={() => router.push('/about' as any)}
                            activeTheme={activeTheme}
                        />
                    </View>
                </View>

                {/* Logout Section */}
                <View style={styles.section}>
                    <View style={styles.settingsGroup}>
                        <SettingItem
                            icon="logout"
                            title="Logout"
                            danger
                            onPress={handleLogout}
                            rightElement={null}
                            activeTheme={activeTheme}
                        />
                    </View>
                </View>

                {/* App Info */}
                <View style={styles.appInfo}>
                    <Text style={styles.appName}>Soul</Text>
                    <Text style={styles.appVersion}>Made with ❤️</Text>
                </View>
            </Animated.ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000000',
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        paddingTop: 60,
        paddingBottom: 140,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 11,
        fontWeight: '900',
        letterSpacing: 2,
        paddingHorizontal: 24,
        marginBottom: 12,
    },
    settingsGroup: {
        marginHorizontal: 16,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: 16,
        overflow: 'hidden',
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.05)',
    },
    settingIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingInfo: {
        flex: 1,
    },
    settingTitle: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
    },
    settingSubtitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12,
        marginTop: 2,
    },
    themePreviewMini: {
        flexDirection: 'row',
        gap: 4,
        marginRight: 8,
    },
    themeSwatchMini: {
        width: 16,
        height: 16,
        borderRadius: 8,
    },
    toggle: {
        width: 48,
        height: 28,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.2)',
        padding: 2,
    },
    toggleKnob: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: '#ffffff',
    },
    toggleKnobActive: {
        marginLeft: 20,
    },
    appInfo: {
        alignItems: 'center',
        paddingVertical: 32,
    },
    appName: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 14,
        fontWeight: '700',
    },
    appVersion: {
        color: 'rgba(255,255,255,0.2)',
        fontSize: 12,
        marginTop: 4,
    },
});
