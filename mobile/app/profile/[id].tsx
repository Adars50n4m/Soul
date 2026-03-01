import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
    View, Text, Image, Pressable, StyleSheet, StatusBar,
    ScrollView, Animated, useWindowDimensions, Alert, Modal, Share, FlatList
} from 'react-native';

import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useApp } from '../../context/AppContext';
import Animated2, { 
    useSharedValue, useAnimatedStyle, withSpring, withTiming, interpolate, Extrapolate, runOnJS, Easing
} from 'react-native-reanimated';

const MediaGalleryItem = ({ item, activeCategory, morphProgress }: any) => {
    const { width, height } = useWindowDimensions();

    const itemStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { scale: interpolate(morphProgress.value, [0, 1], [0.1, 1]) },
                { translateY: interpolate(morphProgress.value, [0, 1], [-height / 4, 0]) }
            ],
            borderRadius: interpolate(morphProgress.value, [0, 1], [40, 0]),
            opacity: morphProgress.value,
        };
    });

    return (
        <View style={styles.viewerContent}>
            <Animated2.View style={[styles.morphContainer, itemStyle]}>
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
            </Animated2.View>
        </View>
    );
};

export default function ProfileScreen() {
    const { width, height } = useWindowDimensions();

    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const navigation = useNavigation();
    const { currentUser, otherUser, messages, activeTheme, clearChatMessages, isCloudConnected } = useApp();

    // Determine which user's profile to show
    const isOwnProfile = id === currentUser?.id;
    const profileUser = isOwnProfile ? currentUser : otherUser;

    const [activeCategory, setActiveCategory] = useState<'photos' | 'videos' | 'audio' | 'docs'>('photos');
    const [viewerVisible, setViewerVisible] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    
    // Reanimated shared values for seamless morph
    const morphProgress = useSharedValue(0);
    const origin = useSharedValue({ x: 0, y: 0, width: 0, height: 0 });
    const isReady = useSharedValue(false);

    const gridRefs = useRef<any[]>([]);

    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(30)).current;

    const bgMorphStyle = useAnimatedStyle(() => ({
        opacity: morphProgress.value,
        backgroundColor: 'black' as any
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
            ],
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
                message: `Check out this ${item.type} from SoulSync!`,
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
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 800,
                useNativeDriver: true,
            }),
            Animated.timing(slideAnim, {
                toValue: 0,
                duration: 800,
                easing: Easing.out(Easing.back(1.5)),
                useNativeDriver: true,
            }),
        ]).start();
    }, [id, profileUser]);

    if (!profileUser) {
        return (
            <View style={styles.container}>
                <StatusBar barStyle="light-content" translucent />
                <View style={styles.header}>
                    <Pressable 
                        onPress={() => {
                            if (navigation.canGoBack()) navigation.goBack();
                        }} 
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

            {/* Ambient Background Orbs */}
            <View style={StyleSheet.absoluteFill}>
                <LinearGradient
                    colors={['rgba(244, 63, 94, 0.08)', 'transparent']}
                    style={[styles.orb, { top: -100, left: -50 }]}
                />
                <LinearGradient
                    colors={['rgba(168, 85, 247, 0.08)', 'transparent']}
                    style={[styles.orb, { bottom: 100, right: -100 }]}
                />
            </View>

            {/* Header - Transparent & Minimal */}
            <View style={styles.header}>
                <Pressable 
                    onPress={() => {
                        if (navigation.canGoBack()) navigation.goBack();
                    }} 
                    style={styles.backButton}
                >
                    <Ionicons name="chevron-back" size={28} color="#ffffff" />
                </Pressable>
                <Text style={styles.headerTitle}>PROFILE</Text>
                <View style={{ width: 44 }} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                <Animated.View
                    style={[
                        styles.heroSection,
                        {
                            opacity: fadeAnim,
                            transform: [{ translateY: slideAnim }]
                        }
                    ]}
                >
                    {/* Centered Hero Avatar with Glow */}
                    <View style={styles.avatarGlowContainer}>
                        <Image source={{ uri: profileUser.avatar }} style={styles.profileAvatar} />
                        <View style={styles.avatarGlassBorder} />
                    </View>

                    <View style={styles.nameRow}>
                        <Text style={styles.userName}>{profileUser.name}</Text>
                        <MaterialIcons name="verified" size={24} color="#3b82f6" style={{ marginTop: 8 }} />
                    </View>
                    <Text style={styles.userBio}>{profileUser.bio || 'Forever in sync'}</Text>

                    {/* Glassmorphism Stats Card */}
                    <View style={styles.glassStatsCard}>
                        <BlurView intensity={20} tint="dark" style={styles.glassEffect} experimentalBlurMethod="dimezisBlurView">
                            <View style={styles.statItem}>
                                <Text style={styles.statValue}>{allChatMessages.length}</Text>
                                <Text style={styles.statLabel}>MESSAGES</Text>
                            </View>
                            <View style={styles.statDivider} />
                            <View style={styles.statItem}>
                                <Text style={styles.statValue}>{sharedMedia.length}</Text>
                                <Text style={styles.statLabel}>MEDIA</Text>
                            </View>
                            <View style={styles.statDivider} />
                            <View style={styles.statItem}>
                                <Text style={styles.statValue}>∞</Text>
                                <Text style={styles.statLabel}>BOND</Text>
                            </View>
                        </BlurView>
                    </View>

                    {/* Glass Actions */}
                    {!isOwnProfile && (
                        <View style={styles.actionRow}>
                            <Pressable 
                                style={styles.primaryGlassAction}
                                onPress={handleClearChat}
                            >
                                <BlurView intensity={30} tint="dark" style={styles.actionGlassEffect} experimentalBlurMethod="dimezisBlurView">
                                    <MaterialIcons name="delete-sweep" size={20} color="#ff4444" />
                                    <Text style={[styles.actionText, { color: '#ff4444' }]}>CLEAR ALL CHAT</Text>
                                </BlurView>
                            </Pressable>

                            <Pressable style={styles.secondaryGlassAction}>
                                <BlurView intensity={20} tint="dark" style={styles.actionGlassEffect} experimentalBlurMethod="dimezisBlurView">
                                    <Ionicons name="call" size={20} color="#fff" />
                                </BlurView>
                            </Pressable>

                            <Pressable style={styles.secondaryGlassAction}>
                                <BlurView intensity={20} tint="dark" style={styles.actionGlassEffect} experimentalBlurMethod="dimezisBlurView">
                                    <Ionicons name="videocam" size={20} color="#fff" />
                                </BlurView>
                            </Pressable>
                        </View>
                    )}
                </Animated.View>

                {/* Shared Media Section */}
                <Animated.View
                    style={[
                        styles.mediaSection,
                        {
                            opacity: fadeAnim,
                            transform: [{ translateY: slideAnim }]
                        }
                    ]}
                >
                    <Text style={styles.sectionTitle}>SHARED MEDIA</Text>
                    
                    {/* Category Tabs */}
                    <View style={styles.tabContainer}>
                        <BlurView intensity={20} tint="dark" style={styles.tabGlass} experimentalBlurMethod="dimezisBlurView">
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
                        </BlurView>
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
                                                <BlurView intensity={10} tint="dark" style={styles.listItemContent} experimentalBlurMethod="dimezisBlurView">
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
                                                </BlurView>
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
                <BlurView intensity={30} tint="dark" style={styles.infoCard} experimentalBlurMethod="dimezisBlurView">
                    <View style={styles.infoRow}>
                        <MaterialIcons name="access-time" size={18} color="rgba(255,255,255,0.4)" />
                        <Text style={styles.infoText}>Connected since the beginning</Text>
                    </View>
                    <View style={styles.infoRow}>
                        <MaterialIcons name="favorite" size={18} color={activeTheme.primary} />
                        <Text style={styles.infoText}>Synced forever</Text>
                    </View>

                </BlurView>
            </ScrollView>

            {/* Liquid Glass Media Viewer Modal with Seamless Morph Transition */}
            <Modal
                visible={viewerVisible}
                transparent={true}
                animationType="none"
                onRequestClose={closeViewer}
            >
                <View style={[styles.viewerContainer, { backgroundColor: 'transparent' }]}>
                    <Animated2.View style={[StyleSheet.absoluteFill, bgMorphStyle]}>
                        <BlurView intensity={90} tint="dark" style={StyleSheet.absoluteFill} experimentalBlurMethod="dimezisBlurView" />
                    </Animated2.View>
                    
                    {/* Integrated Gallery & Transition Layer */}
                    <Animated2.View style={[StyleSheet.absoluteFill, galleryStyle]}>
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
                    </Animated2.View>

                    {/* Morphing Overlay (GPU-Accelerated Butter-Smooth Transition) */}
                    <Animated2.View 
                        style={[styles.morphingImageContainer, morphImageStyle]}
                    >
                        <Image 
                            source={{ uri: sharedMedia[selectedIndex]?.url }} 
                            style={styles.fullImage} 
                            resizeMode="contain" 
                        />
                    </Animated2.View>

                    {/* Header/Footer Controls */}
                    <Animated2.View style={[styles.viewerControlsContainer, controlsStyle]}>
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


                    </Animated2.View>
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
        paddingBottom: 120,
    },
    heroSection: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: 20,
    },
    avatarGlowContainer: {
        position: 'relative',
        padding: 10,
        marginBottom: 20,
    },
    profileAvatar: {
        width: 160,
        height: 160,
        borderRadius: 80,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    avatarGlassBorder: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 90,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        margin: -5,
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    userName: {
        color: '#ffffff',
        fontSize: 36,
        fontWeight: '900',
        letterSpacing: -1,
    },
    userBio: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 15,
        fontWeight: '400',
        textAlign: 'center',
        marginTop: 8,
        paddingHorizontal: 40,
        lineHeight: 20,
    },
    glassStatsCard: {
        width: '100%',
        marginTop: 32,
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    glassEffect: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 24,
        paddingHorizontal: 12,
        backgroundColor: 'rgba(255,255,255,0.03)',
    },
    statItem: {
        flex: 1,
        alignItems: 'center',
    },
    statValue: {
        color: '#ffffff',
        fontSize: 24,
        fontWeight: '800',
    },
    statLabel: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 9,
        fontWeight: '800',
        letterSpacing: 1,
        marginTop: 4,
    },
    statDivider: {
        width: 1,
        height: 30,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    actionRow: {
        flexDirection: 'row',
        width: '100%',
        marginTop: 24,
        gap: 12,
    },
    primaryGlassAction: {
        flex: 2,
        height: 64,
        borderRadius: 32,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
    },
    secondaryGlassAction: {
        width: 64,
        height: 64,
        borderRadius: 32,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    actionGlassEffect: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
        gap: 8,
    },
    actionText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '800',
        letterSpacing: 1,
    },
    mediaSection: {
        marginTop: 48,
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
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    connectionText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 12,
        fontWeight: '600',
        letterSpacing: 0.5,
    },
});
