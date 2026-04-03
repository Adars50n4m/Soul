import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, StatusBar,
    ScrollView, useWindowDimensions, Alert, Modal, Share, FlatList, Platform, Dimensions, BackHandler
} from 'react-native';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

import { useLocalSearchParams, useNavigation } from 'expo-router';
import GlassView from '../../components/ui/GlassView';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { proxySupabaseUrl } from '../../config/api';
import { useApp } from '../../context/AppContext';
import { useCall } from '../../context/CallContext';
import { normalizeId, getSuperuserName, getSuperuserHandle } from '../../utils/idNormalization';
import {
    PROFILE_AVATAR_SHARED_TRANSITION,
    PROFILE_AVATAR_TRANSITION_TAG,
    SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION,
} from '../../constants/sharedTransitions';
import Animated, {
    useSharedValue, useAnimatedStyle, withTiming, interpolate, runOnJS, Easing,
    useAnimatedScrollHandler, Extrapolation
} from 'react-native-reanimated';
import ProgressiveBlur from '../../components/chat/ProgressiveBlur';

const MediaGalleryItem = ({ item, activeCategory, morphProgress }: any) => {
    const { width, height } = useWindowDimensions();

    const itemStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { scale: interpolate(morphProgress.value, [0, 1], [0.1, 1]) },
                { translateY: interpolate(morphProgress.value, [0, 1], [-height / 4, 0]) }
            ] as any,
            borderRadius: interpolate(morphProgress.value, [0, 1], [40, 0]),
            opacity: morphProgress.value,
        };
    });

    return (
        <View style={styles.viewerContent}>
            <Animated.View style={[styles.morphContainer, itemStyle]}>
                {activeCategory === 'videos' ? (
                    <View style={styles.videoPlaceholder}>
                        <Image source={{ uri: item.url }} style={styles.viewerImage} resizeMode="contain" />
                        <View style={styles.viewerPlayBtn}>
                            <Ionicons name="play" size={40} color="#fff" />
                        </View>
                    </View>
                ) : (
                    <Image 
                        source={{ uri: item.url }} 
                        style={styles.viewerImage} 
                        resizeMode="contain" 
                    />
                )}
            </Animated.View>
        </View>
    );
};

export default function ProfileScreen() {
    const { width, height } = useWindowDimensions();

    const params = useLocalSearchParams<{ id: string; avatarX?: string; avatarY?: string; avatarW?: string; avatarH?: string }>();
    const id = normalizeId(Array.isArray(params.id) ? params.id[0] : params.id);
    const navigation = useNavigation();
    const { currentUser, otherUser, contacts, messages, activeTheme, clearChatMessages, connectivity, fetchOtherUserProfile } = useApp();
    const { startCall } = useCall();

    // Determine which user's profile to show
    const isOwnProfile = id === currentUser?.id;

    // Find contact from contacts list (same data as chat screen)
    const contactFromList = contacts.find(c => normalizeId(c.id) === id);

    // For other users, prefer contact from list (same as chat screen), fallback to otherUser
    const otherUserData = contactFromList || otherUser;
    const profileUser = isOwnProfile ? currentUser : otherUserData;
    const profileName = getSuperuserName(id) || profileUser?.name || profileUser?.display_name || (id ? `User_${id.substring(0, 5)}` : 'User');

    // Fetch other user profile data on mount
    useEffect(() => {
        if (id && !isOwnProfile) {
            console.log(`[ProfileScreen] Fetching profile for: ${id}`);
            fetchOtherUserProfile(id);
        }
    }, [id, isOwnProfile, fetchOtherUserProfile]);

    const [activeCategory, setActiveCategory] = useState<'photos' | 'videos' | 'audio' | 'docs'>('photos');
    const [viewerVisible, setViewerVisible] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const avatarOrigin = useMemo(() => ({
        x: Number(Array.isArray(params.avatarX) ? params.avatarX[0] : params.avatarX),
        y: Number(Array.isArray(params.avatarY) ? params.avatarY[0] : params.avatarY),
        width: Number(Array.isArray(params.avatarW) ? params.avatarW[0] : params.avatarW),
        height: Number(Array.isArray(params.avatarH) ? params.avatarH[0] : params.avatarH),
    }), [params.avatarH, params.avatarW, params.avatarX, params.avatarY]);
    const hasAvatarMorph = Number.isFinite(avatarOrigin.x)
        && Number.isFinite(avatarOrigin.y)
        && Number.isFinite(avatarOrigin.width)
        && Number.isFinite(avatarOrigin.height)
        && avatarOrigin.width > 0
        && avatarOrigin.height > 0;
    
    // Reanimated shared values for seamless morph
    const morphProgress = useSharedValue(0);
    const origin = useSharedValue({ x: 0, y: 0, width: 0, height: 0 });
    const isReady = useSharedValue(false);

    const gridRefs = useRef<any[]>([]);

    const fadeAnim = useSharedValue(1);
    const slideAnim = useSharedValue(0);
    const scrollY = useSharedValue(0);
    const heroMorphProgress = useSharedValue(hasAvatarMorph ? 0 : 1);
    const headerOpacity = useSharedValue(hasAvatarMorph ? 0 : 1);
    const isClosingRef = useRef(false);
    const allowNativePopRef = useRef(false);

    const onScroll = useAnimatedScrollHandler((event) => {
        scrollY.value = event.contentOffset.y;
    });

    const headerAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [
                {
                    translateY: interpolate(
                        scrollY.value,
                        [-height, 0, height],
                        [-height / 2, 0, -height * 0.8],
                        Extrapolation.CLAMP
                    )
                },
                {
                    scale: interpolate(
                        scrollY.value,
                        [-height, 0],
                        [2, 1],
                        Extrapolation.CLAMP
                    )
                }
            ] as any,
        };
    });

    const heroEntryAnimatedStyle = useAnimatedStyle(() => {
        if (!hasAvatarMorph) {
            return {
                left: 0,
                top: 0,
                width,
                height: 540,
                borderRadius: 0,
            };
        }

        return {
            left: interpolate(heroMorphProgress.value, [0, 1], [avatarOrigin.x, 0], Extrapolation.CLAMP),
            top: interpolate(heroMorphProgress.value, [0, 1], [avatarOrigin.y, 0], Extrapolation.CLAMP),
            width: interpolate(heroMorphProgress.value, [0, 1], [avatarOrigin.width, width], Extrapolation.CLAMP),
            height: interpolate(heroMorphProgress.value, [0, 1], [avatarOrigin.height, 540], Extrapolation.CLAMP),
            borderRadius: interpolate(heroMorphProgress.value, [0, 1], [avatarOrigin.width / 2, 0], Extrapolation.CLAMP),
        };
    });

    const chromeAnimatedStyle = useAnimatedStyle(() => ({
        opacity: headerOpacity.value,
        transform: [{ translateY: interpolate(headerOpacity.value, [0, 1], [16, 0]) }],
    }));

    const scrollDismissAnimatedStyle = useAnimatedStyle(() => ({
        opacity: headerOpacity.value,
        transform: [{ translateY: interpolate(headerOpacity.value, [0, 1], [32, 0]) }],
    }));

    const contentAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { translateY: 0 }
            ] as any,
        };
    });

    const bgMorphStyle = useAnimatedStyle(() => ({
        opacity: morphProgress.value,
        backgroundColor: 'black'
    }));

    const galleryStyle = useAnimatedStyle(() => ({
        opacity: isReady.value ? 1 : 0
    }));

    const morphImageStyle = useAnimatedStyle(() => {
        const p = morphProgress.value;
        if (isReady.value) return { opacity: 0 };
        
        const targetW = width;
        const targetH = height * 0.8;
        
        const gridCenterX = origin.value.x + (origin.value.width / 2);
        const gridCenterY = origin.value.y + (origin.value.height / 2);
        const screenCenterX = width / 2;
        const screenCenterY = height / 2;

        const initialScaleX = origin.value.width / targetW || 1;
        const initialScaleY = origin.value.height / targetH || 1;

        return {
            width: targetW,
            height: targetH,
            top: (height - targetH) / 2,
            left: 0,
            transform: [
                { translateX: interpolate(p, [0, 1], [gridCenterX - screenCenterX, 0]) },
                { translateY: interpolate(p, [0, 1], [gridCenterY - screenCenterY, 0]) },
                { scaleX: interpolate(p, [0, 1], [initialScaleX, 1]) },
                { scaleY: interpolate(p, [0, 1], [initialScaleY, 1]) }
            ] as any,
            borderRadius: interpolate(p, [0, 1], [18 / initialScaleX, 0]),
            opacity: interpolate(p, [0, 0.05], [0, 1]),
            shadowOpacity: interpolate(p, [0, 0.5, 1], [0, 0.5, 0]),
            shadowRadius: interpolate(p, [0, 1], [0, 20]),
        };
    });

    const controlsStyle = useAnimatedStyle(() => ({
        opacity: isReady.value ? 1 : 0,
        transform: [{ translateY: interpolate(morphProgress.value, [0, 1], [20, 0]) }]
    }));

    const allChatMessages = useMemo(() =>
        (messages[id as string] || []),
    [messages, id]);

    const chatMessages = useMemo(() =>
        allChatMessages.filter(m => m.media),
    [allChatMessages]);

    const categorizedMedia = useMemo(() => ({
        photos: chatMessages.filter(m => m.media?.type === 'image').map(m => m.media!),
        videos: chatMessages.filter(m => m.media?.type === 'video').map(m => m.media!),
        audio: chatMessages.filter(m => m.media?.type === 'audio').map(m => m.media!),
        docs: chatMessages.filter(m => m.media?.type === 'file').map(m => m.media!),
    }), [chatMessages]);

    const sharedMedia = categorizedMedia[activeCategory];


    const openViewer = (index: number, layout: any) => {
        setSelectedIndex(index);
        origin.value = layout;
        setViewerVisible(true);
        isReady.value = false;
        morphProgress.value = withTiming(1, { 
            duration: 600, 
            easing: Easing.bezier(0.16, 1, 0.3, 1) 
        }, () => {
            isReady.value = true;
        });
    };

    const closeViewer = () => {
        isReady.value = false;
        morphProgress.value = withTiming(0, { 
            duration: 450,
            easing: Easing.out(Easing.quad)
        }, () => {
            runOnJS(setViewerVisible)(false);
        });
    };

    const renderViewerItem = useCallback(({ item }: { item: any }) => (
        <View style={[styles.viewerContent, { width }]}>
            <View style={styles.morphContainer}>
                {activeCategory === 'videos' ? (
                    <View style={styles.videoPlaceholder}>
                        <Image source={{ uri: item.url }} style={styles.viewerImage} resizeMode="contain" />
                        <View style={styles.viewerPlayBtn}><Ionicons name="play" size={40} color="#fff" /></View>
                    </View>
                ) : (
                    <Image source={{ uri: item.url }} style={styles.viewerImage} resizeMode="contain" />
                )}
            </View>
        </View>
    ), [width, activeCategory]);

    const handleDownload = (item: any) => {
        if (!item) return;
        const type = item.type === 'image' ? 'Photo' : item.type === 'video' ? 'Video' : item.type === 'audio' ? 'Audio' : 'Document';
        Alert.alert(
            'Download',
            `Save this ${type} to your device?`,
            [
                { text: 'Cancel', style: 'cancel' },
                { 
                    text: 'Save', 
                    onPress: () => {
                        // Simulate download
                        setTimeout(() => {
                            Alert.alert('Success', `${type} saved successfully!`);
                        }, 1000);
                    }
                }
            ]
        );
    };

    const handleShare = async (item: any) => {
        try {
            await Share.share({
                url: item.url,
                message: `Check out this ${item.type} from Soul!`,
            });
        } catch (error) {
            console.error(error);
        }
    };

    const handleClearChat = () => {
        if (!profileUser) return;
        
        Alert.alert(
            'Clear All Chat',
            `Are you sure you want to delete all messages and media with ${profileUser.name}? This action cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                { 
                    text: 'Clear All', 
                    style: 'destructive',
                    onPress: async () => {
                        await clearChatMessages(profileUser.id);
                    }
                }
            ]
        );
    };

    useEffect(() => {
        if (!profileUser) return;
        fadeAnim.value = withTiming(1, { duration: 800 });
        slideAnim.value = withTiming(0, { 
            duration: 800, 
            easing: Easing.out(Easing.back(1.5)) 
        });
    }, [id, profileUser]);

    useEffect(() => {
        if (!hasAvatarMorph) {
            heroMorphProgress.value = 1;
            headerOpacity.value = 1;
            return;
        }

        heroMorphProgress.value = withTiming(1, {
            duration: 460,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
        });
        headerOpacity.value = withTiming(1, {
            duration: 220,
            easing: Easing.out(Easing.cubic),
        });
    }, [hasAvatarMorph, headerOpacity, heroMorphProgress]);

    const finishDismiss = useCallback((action?: any) => {
        allowNativePopRef.current = true;
        if (action) {
            navigation.dispatch(action);
            return;
        }
        if (navigation.canGoBack()) {
            navigation.goBack();
        }
    }, [navigation]);

    const runDismissAnimation = useCallback((action?: any) => {
        if (isClosingRef.current) return;
        isClosingRef.current = true;

        if (!hasAvatarMorph) {
            finishDismiss(action);
            return;
        }

        headerOpacity.value = withTiming(0, { duration: 120 });
        heroMorphProgress.value = withTiming(0, {
            duration: 420,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
        });
        setTimeout(() => {
            finishDismiss(action);
        }, 280);
    }, [finishDismiss, hasAvatarMorph, headerOpacity, heroMorphProgress]);

    useEffect(() => {
        const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
            if (!hasAvatarMorph || isClosingRef.current || allowNativePopRef.current) {
                return;
            }
            event.preventDefault();
            runDismissAnimation(event.data.action);
        });

        const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!hasAvatarMorph || isClosingRef.current) {
                return false;
            }
            runDismissAnimation();
            return true;
        });

        return () => {
            allowNativePopRef.current = false;
            unsubscribe();
            backSubscription.remove();
        };
    }, [hasAvatarMorph, navigation, runDismissAnimation]);

    const headerContentAnimatedStyle = useAnimatedStyle(() => ({
        opacity: fadeAnim.value * headerOpacity.value
    }));

    const mediaSectionAnimatedStyle = useAnimatedStyle(() => ({
        opacity: fadeAnim.value * headerOpacity.value,
        transform: [{ translateY: slideAnim.value + interpolate(headerOpacity.value, [0, 1], [28, 0]) }]
    }));

    const { width: screenWidth, height: screenHeight } = useWindowDimensions();

    if (!profileUser) {
        return (
            <View style={styles.container}>
                <StatusBar barStyle="light-content" translucent />
                <View style={styles.header}>
                    <Pressable 
                        onPress={() => runDismissAnimation()}
                        style={styles.backButton}
                    >
                        <Ionicons name="chevron-back" size={28} color="#ffffff" />
                    </Pressable>
                </View>
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={styles.errorText}>User profile not found</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" translucent />



            {/* Immersive Hero Background */}
            <Animated.View style={[styles.heroBackgroundContainer, headerAnimatedStyle, heroEntryAnimatedStyle]}>
                {(() => {
                    const avatarType = profileUser?.avatarType || profileUser?.avatar_type || 'default';
                    const uri = profileUser?.avatar || profileUser?.avatar_url;
                    const localUri = profileUser?.localAvatarUri || profileUser?.local_avatar_uri;
                    const fallbackId = profileUser?.id || id || 'default';
                    
                    const proxiedUri = proxySupabaseUrl(uri);
                    // Use local if available, otherwise remote or special types
                    let finalUri: string;
                    if (avatarType === 'teddy') {
                        finalUri = `https://avatar.iran.liara.run/public/boy?username=${fallbackId}`;
                    } else if (avatarType === 'memoji') {
                        finalUri = `https://avatar.iran.liara.run/public/girl?username=${fallbackId}`;
                    } else {
                        finalUri = localUri || proxiedUri || uri || '';
                    }

                    return (
                        <Animated.Image
                            source={{ uri: finalUri }}
                            style={[styles.heroImage, { backgroundColor: '#111' }]}
                            resizeMode="cover"
                            {...(SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION ? {
                                sharedTransitionTag: PROFILE_AVATAR_TRANSITION_TAG,
                                sharedTransitionStyle: PROFILE_AVATAR_SHARED_TRANSITION,
                            } : {})}
                        />
                    );
                })()}

                {/* Progressive Blur — subtle bottom fade */}
                <ProgressiveBlur
                    position="bottom"
                    height={240}
                    intensity={Platform.OS === 'ios' ? 80 : 40}
                    tint="dark"
                    maxAlpha={1}
                />
            </Animated.View>


            {/* Header - Transparent & Minimal */}
            <Animated.View style={[styles.header, chromeAnimatedStyle]}>
                <Pressable 
                    onPress={() => runDismissAnimation()}
                    style={styles.headerGlassCircle}
                >
                    <GlassView intensity={40} tint="dark" style={styles.headerIconGlass}>
                        <Ionicons name="chevron-back" size={24} color="#ffffff" />
                    </GlassView>
                </Pressable>

                <View style={styles.headerTitlePill}>
                    <GlassView intensity={40} tint="dark" style={styles.headerTitleGlass}>
                        <Animated.Text style={styles.headerTitle}>PROFILE</Animated.Text>
                    </GlassView>
                </View>

                <Pressable style={styles.headerGlassCircle}>
                    <GlassView intensity={40} tint="dark" style={styles.headerIconGlass}>
                        <Ionicons name="ellipsis-horizontal" size={24} color="#ffffff" />
                    </GlassView>
                </Pressable>
            </Animated.View>

            <Animated.ScrollView
                style={[styles.scrollView, scrollDismissAnimatedStyle]}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={16}
            >
                <Animated.View
                    style={[
                        styles.heroSection,
                        contentAnimatedStyle,
                        headerContentAnimatedStyle
                    ]}
                >
                    {/* Spacer pushes content below the hero image */}
                    <View style={styles.heroSpacer} />

                    {/* Integrated Identity Overlay — moved from absolute to relative for better spacing */}
                    <View style={styles.heroNameOverlay}>
                        <Text style={styles.heroName}>{profileName}</Text>
                        <View style={styles.heroHandleRow}>
                             {/* Correct Username formatting: Handle-first, fallback-second, no status dot */}
                             <Text style={styles.heroHandle}>
                                @{profileUser?.username || getSuperuserHandle(id) || (id ? id.substring(0, 8) : 'soul_user')}
                            </Text>
                        </View>
                    </View>

                    {/* Optimized Multi-Action Row */}
                    {!isOwnProfile && (
                        <View style={styles.actionRow}>
                             <Pressable 
                                style={styles.actionPill}
                                onPress={() => startCall(profileUser.id, 'audio')}
                            >
                                <GlassView intensity={40} tint="light" style={styles.actionPillContent}>
                                    <Ionicons name="call" size={24} color="#fff" />
                                </GlassView>
                            </Pressable>

                            <Pressable 
                                style={styles.actionPill}
                                onPress={() => startCall(profileUser.id, 'video')}
                            >
                                <GlassView intensity={40} tint="light" style={styles.actionPillContent}>
                                    <Ionicons name="videocam" size={24} color="#fff" />
                                </GlassView>
                            </Pressable>

                            <Pressable 
                                style={[styles.actionPill, { borderColor: 'rgba(255,68,68,0.3)' }]}
                                onPress={handleClearChat}
                            >
                                <GlassView intensity={40} tint="dark" style={[styles.actionPillContent, { backgroundColor: 'rgba(255,68,68,0.1)' }]}>
                                    <MaterialIcons name="delete-sweep" size={24} color="#ff4444" />
                                </GlassView>
                            </Pressable>
                        </View>
                    )}
                </Animated.View>

                {/* Shared Media Section */}
                <Animated.View
                    style={[
                        styles.mediaSection,
                        mediaSectionAnimatedStyle
                    ]}
                >
                    <Text style={styles.sectionTitle}>SHARED MEDIA</Text>
                    
                    {/* Category Tabs */}
                    <View style={styles.tabContainer}>
                        <GlassView intensity={20} tint="dark" style={styles.tabGlass} >
                            {(['photos', 'videos', 'audio', 'docs'] as const).map((cat) => (
                                <Pressable
                                    key={cat}
                                    onPress={() => setActiveCategory(cat)}
                                    style={[
                                        styles.tabBtn,
                                        activeCategory === cat && styles.tabBtnActive
                                    ]}
                                >
                                    <Text style={[
                                        styles.tabText,
                                        activeCategory === cat && styles.tabTextActive
                                    ]}>
                                        {cat.toUpperCase()}
                                    </Text>
                                </Pressable>
                            ))}
                        </GlassView>
                    </View>

                        {sharedMedia.length > 0 ? (
                            <View style={activeCategory === 'audio' || activeCategory === 'docs' ? styles.mediaList : styles.mediaGrid}>
                                {sharedMedia.map((item: any, index: number) => {
                                    if (activeCategory === 'photos' || activeCategory === 'videos') {
                                        return (
                                            <Pressable 
                                                key={index} 
                                                ref={(el) => { gridRefs.current[index] = el; }}
                                                style={[
                                                    styles.mediaItem, 
                                                    { width: (width - 60) / 3, height: (width - 60) / 3 },
                                                    (viewerVisible && selectedIndex === index) && { opacity: 0 }
                                                ]}

                                                onPress={() => {
                                                    gridRefs.current[index]?.measure((x: number, y: number, width: number, height: number, px: number, py: number) => {
                                                        openViewer(index, { x: px, y: py, width, height });
                                                    });
                                                }}
                                            >
                                                <Image source={{ uri: item.url }} style={styles.mediaImage} />
                                                {item.type === 'video' && (
                                                    <View style={styles.playIconOverlay}>
                                                        <Ionicons name="play" size={20} color="#fff" />
                                                    </View>
                                                )}
                                            </Pressable>
                                        );
                                    } else {
                                        return (
                                            <Pressable key={index} style={styles.listItemGlass} onPress={() => handleDownload(item)}>
                                                <GlassView intensity={10} tint="dark" style={styles.listItemContent} >
                                                    <View style={[styles.listIconContainer, { backgroundColor: activeCategory === 'audio' ? 'rgba(168, 85, 247, 0.1)' : 'rgba(59, 130, 246, 0.1)' }]}>
                                                        <Ionicons 
                                                            name={activeCategory === 'audio' ? 'musical-notes' : 'document-text'} 
                                                            size={20} 
                                                            color={activeCategory === 'audio' ? '#a855f7' : '#3b82f6'} 
                                                        />
                                                    </View>
                                                    <View style={styles.listTextContainer}>
                                                        <Text style={styles.listTitle} numberOfLines={1}>
                                                            {item.name || (activeCategory === 'audio' ? 'Audio Note' : 'Document')}
                                                        </Text>
                                                        <Text style={styles.listSubtitle}>
                                                            {activeCategory === 'audio' ? 'Voice Message • 0:42' : 'PDF • 2.4 MB'}
                                                        </Text>
                                                    </View>
                                                    <Ionicons name="download-outline" size={18} color="#fff" />
                                                </GlassView>
                                            </Pressable>
                                        );
                                    }
                                })}
                            </View>
                    ) : (
                        <View style={styles.emptyMedia}>
                            <Ionicons 
                                name={
                                    activeCategory === 'photos' ? 'images-outline' : 
                                    activeCategory === 'videos' ? 'videocam-outline' :
                                    activeCategory === 'audio' ? 'musical-note-outline' : 'document-outline'
                                } 
                                size={40} 
                                color="rgba(255,255,255,0.05)" 
                            />
                            <Text style={styles.emptyText}>No {activeCategory} found</Text>
                        </View>
                    )}
                </Animated.View>

                {/* Connection Info */}
                <GlassView intensity={30} tint="dark" style={styles.infoCard} >
                    <View style={styles.infoRow}>
                        <MaterialIcons name="access-time" size={18} color="rgba(255,255,255,0.4)" />
                        <Text style={styles.infoText}>Connected since the beginning</Text>
                    </View>
                    <View style={styles.infoRow}>
                        <MaterialIcons name="favorite" size={18} color={activeTheme.primary} />
                        <Text style={styles.infoText}>Synced forever</Text>
                    </View>

                </GlassView>
            </Animated.ScrollView>

            {/* Liquid Glass Media Viewer Modal with Seamless Morph Transition */}
            <Modal
                visible={viewerVisible}
                transparent={true}
                animationType="none"
                onRequestClose={closeViewer}
            >
                <View style={[styles.viewerContainer, { backgroundColor: 'transparent' }]}>
                    <Animated.View style={[StyleSheet.absoluteFill, bgMorphStyle]}>
                        <GlassView intensity={90} tint="dark" style={StyleSheet.absoluteFill}  />
                    </Animated.View>
                    
                    {/* Integrated Gallery & Transition Layer */}
                    <Animated.View style={[StyleSheet.absoluteFill, galleryStyle]}>
                        <FlatList
                            data={sharedMedia}
                            horizontal
                            pagingEnabled
                            initialScrollIndex={selectedIndex}
                            getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
                            onMomentumScrollEnd={(e) => {
                                const index = Math.round(e.nativeEvent.contentOffset.x / width);
                                if (index !== selectedIndex) {
                                    setSelectedIndex(index);
                                    // Dynamically update return origin for the new active index
                                    gridRefs.current[index]?.measure((x: number, y: number, width: number, height: number, px: number, py: number) => {
                                        origin.value = { x: px, y: py, width, height };
                                    });
                                }
                            }}
                            showsHorizontalScrollIndicator={false}
                            keyExtractor={(_, i) => i.toString()}
                            renderItem={renderViewerItem}
                        />
                    </Animated.View>

                    {/* Morphing Overlay (GPU-Accelerated Butter-Smooth Transition) */}
                    <Animated.View 
                        style={[styles.morphingImageContainer, morphImageStyle]}
                    >
                        <Image 
                            source={{ uri: sharedMedia[selectedIndex]?.url }} 
                            style={styles.fullImage} 
                            resizeMode="contain" 
                        />
                    </Animated.View>

                    {/* Header/Footer Controls */}
                    <Animated.View style={[styles.viewerControlsContainer, controlsStyle]}>
                        <View style={styles.viewerHeader}>
                            <Pressable onPress={closeViewer} style={styles.viewerHeaderBtn}>
                                <Ionicons name="close" size={28} color="#fff" />
                            </Pressable>
                            <View style={styles.viewerHeaderCenter}>
                                <Text style={styles.viewerTitle}>{activeCategory.toUpperCase()}</Text>
                                <Text style={styles.viewerSubtitle}>{selectedIndex + 1} of {sharedMedia.length}</Text>
                            </View>
                            <Pressable onPress={() => handleShare(sharedMedia[selectedIndex])} style={styles.viewerHeaderBtn}>
                                <Ionicons name="share-outline" size={24} color="#fff" />
                            </Pressable>
                        </View>


                    </Animated.View>
                </View>
            </Modal>
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 60,
        paddingHorizontal: 20,
        paddingBottom: 16,
    },
    headerGlassCircle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        overflow: 'hidden',
    },
    headerIconGlass: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitlePill: {
        borderRadius: 20,
        overflow: 'hidden',
    },
    headerTitleGlass: {
        paddingHorizontal: 20,
        paddingVertical: 8,
        alignItems: 'center',
        justifyContent: 'center',
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
        fontSize: 13,
        fontWeight: '900',
        letterSpacing: 3,
        opacity: 0.8,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        paddingBottom: 140,
    },
    heroBackgroundContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 540,
        overflow: 'hidden',
        backgroundColor: '#000', // Ensure a solid base for the melt
    },
    heroImage: {
        width: '100%',
        height: '100%',
    },
    heroGradient: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 2,
    },
    heroNameOverlay: {
        width: '100%',
        alignItems: 'center',
        marginTop: -110, // Pull name UP into the blurred region
        zIndex: 10,
    },
    heroName: {
        color: '#fff',
        fontSize: 38,
        fontWeight: '900',
        letterSpacing: -0.5,
        textAlign: 'center',
        textShadowColor: 'rgba(0,0,0,0.6)',
        textShadowOffset: { width: 0, height: 2 },
        textShadowRadius: 8,
    },
    heroHandleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 6,
    },
    onlineDot: {
        width: 9,
        height: 9,
        borderRadius: 5,
        borderWidth: 1.5,
        borderColor: 'rgba(0,0,0,0.3)',
    },
    heroHandle: {
        color: 'rgba(255,255,255,0.65)',
        fontSize: 16,
        fontWeight: '600',
        letterSpacing: 0.3,
    },
    heroSpacer: {
        height: 380, // Reduced from 540 to eliminate "faltu space"
    },
    glowOrb: {
        position: 'absolute',
        width: 400,
        height: 400,
        borderRadius: 200,
        opacity: 0.6,
        zIndex: 3,
    },
    nameContent: {
        width: '100%',
        paddingHorizontal: 10,
        alignItems: 'center',
    },
    actionPillText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '800',
    },
    heroSection: {
        width: '100%',
        alignItems: 'center',
    },
    actionRow: {
        flexDirection: 'row',
        paddingHorizontal: 20,
        gap: 12,
        marginTop: 10,
        marginBottom: 30,
    },
    actionPill: {
        flex: 1,
        height: 56,
        borderRadius: 28,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    actionPillContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    mediaSection: {
        marginTop: 10,
        paddingHorizontal: 20,
    },
    sectionTitle: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 11,
        fontWeight: '900',
        letterSpacing: 2,
        marginBottom: 16,
    },
    tabContainer: {
        marginBottom: 20,
        borderRadius: 20,
        overflow: 'hidden',
    },
    tabGlass: {
        flexDirection: 'row',
        padding: 4,
        borderRadius: 20,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    tabBtn: {
        flex: 1,
        paddingVertical: 10,
        alignItems: 'center',
        borderRadius: 16,
    },
    tabBtnActive: {
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    tabText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 9,
        fontWeight: '800',
        letterSpacing: 1,
    },
    tabTextActive: {
        color: '#ffffff',
    },
    mediaGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
    },
    mediaList: {
        gap: 12,
    },
    mediaItem: {
        borderRadius: 18,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        position: 'relative',
    },

    playIconOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.2)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    listItemGlass: {
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    listItemContent: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        backgroundColor: 'rgba(255,255,255,0.02)',
    },
    listIconContainer: {
        width: 44,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
    },
    listTextContainer: {
        flex: 1,
    },
    listTitle: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
    },
    listSubtitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12,
        marginTop: 2,
    },
    mediaImage: {
        width: '100%',
        height: '100%',
    },
    emptyMedia: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        borderRadius: 28,
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    emptyText: {
        color: 'rgba(255,255,255,0.2)',
        fontSize: 14,
    },
    infoCard: {
        marginHorizontal: 20,
        marginTop: 32,
        borderRadius: 30,
        overflow: 'hidden',
        padding: 24,
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        gap: 20,
    },
    infoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    infoText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 14,
        fontWeight: '500',
    },
    errorText: {
        color: '#ef4444',
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
    // Media Viewer Styles
    viewerContainer: {
        flex: 1,
    },
    viewerControlsContainer: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'space-between',
        pointerEvents: 'box-none',
    },
    morphingImageContainer: {
        position: 'absolute',
        overflow: 'hidden',
        zIndex: 100,
    },
    fullImage: {
        width: '100%',
        height: '100%',
    },
    viewerHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 60,
        paddingHorizontal: 20,
        zIndex: 10,
    },
    viewerHeaderBtn: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    viewerHeaderCenter: {
        alignItems: 'center',
    },
    viewerTitle: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '900',
        letterSpacing: 2,
    },
    viewerSubtitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 10,
        marginTop: 2,
    },
    viewerContent: {
        justifyContent: 'center',
        alignItems: 'center',
    },

    morphContainer: {
        width: '100%',
        height: '80%',
        overflow: 'hidden',
    },
    viewerImage: {
        width: '100%',
        height: '100%',
    },
    videoPlaceholder: {
        width: '100%',
        height: '80%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    viewerPlayBtn: {
        position: 'absolute',
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
    },
    viewerFooter: {
        paddingBottom: 60,
        paddingHorizontal: 40,
    },
    viewerActionBtn: {
        height: 60,
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
    },
    viewerActionBlur: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
        gap: 12,
    },
    viewerActionText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '800',
        letterSpacing: 1,
    },
    connectionBadge: {
        marginTop: 12,
        alignSelf: 'center',
        borderRadius: 20,
        overflow: 'hidden',
    },
    connectionBadgeGlass: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        paddingHorizontal: 16,
        gap: 8,
    },
});
