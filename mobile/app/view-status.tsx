import React, { useState, useEffect, useCallback, useRef } from 'react';
import LottieView from 'lottie-react-native';
import {
    View, Text, Image, StyleSheet, StatusBar,
    useWindowDimensions, Pressable, Alert, TextInput, Modal, ScrollView,
    ActivityIndicator
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withTiming, 
    runOnJS, 
    cancelAnimation, 
    Easing,
    withSpring
} from 'react-native-reanimated';
import { Video, ResizeMode } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { statusService } from '../services/StatusService';
import { useApp } from '../context/AppContext';
import { proxySupabaseUrl } from '../config/api';
import { UserStatusGroup } from '../types';
import { supabase } from '../config/supabase';

const StatusProgressBar = ({ idx, currentIndex, progress }: any) => {
    const style = useAnimatedStyle(() => ({
        width: idx < currentIndex
            ? '100%'
            : idx === currentIndex
                ? `${progress.value * 100}%`
                : '0%'
    }));
    return <View style={styles.progressBar}><Animated.View style={[styles.progressFill, style]} /></View>;
};

export default function ViewStatusScreen() {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const { currentUser, sendChatMessage, activeTheme } = useApp();
    const themeAccent = activeTheme.primary;
    
    const [statusGroup, setStatusGroup] = useState<UserStatusGroup | null>(null);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [mediaSource, setMediaSource] = useState<{uri: string, isLocal: boolean} | null>(null);
    const [loading, setLoading] = useState(true);
    const [isPaused, setIsPaused] = useState(false);
    const [replyText, setReplyText] = useState('');
    const [isReplyComposerActive, setIsReplyComposerActive] = useState(false);
    const [isReplyActionLoading, setIsReplyActionLoading] = useState(false);
    const [showViewers, setShowViewers] = useState(false);
    const [viewers, setViewers] = useState<any[]>([]);
    const replyInputRef = useRef<TextInput>(null);

    const progress = useSharedValue(0);
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const isLongPressing = useSharedValue(0);

    // Initial Load
    useEffect(() => {
        const load = async () => {
            const feed = await statusService.getStatusFeed();
            const group = feed.find(g => g.user.id === id);
            if (group) {
                setStatusGroup(group);
                // Start from first unviewed if not self
                if (!group.isMine) {
                    const firstUnviewed = group.statuses.findIndex(s => !s.isViewed);
                    if (firstUnviewed !== -1) setCurrentIndex(firstUnviewed);
                }
            } else {
                Alert.alert('Error', 'Status not found');
                router.back();
            }
        };
        load();
    }, [id, router]);

    // Media Loading Logic
    useEffect(() => {
        if (!statusGroup) return;
        const currentStatus = statusGroup.statuses[currentIndex];
        if (!currentStatus) return;

        const loadMedia = async () => {
            setLoading(true);
            setIsPaused(false);
            progress.value = 0;
            
            // We need media_key. Since it's not in SQLite (my mistake earlier), 
            // I'll assume we have it or I'll fix the service to include it.
            // Actually, my Refactored StatusService.ts fetch's it from Supabase in onStatusViewed.
            // FOR NOW, I'll pass it if possible or fetch it.
            // Better: update CachedStatus type and migration to include media_key.
            // But to avoid migration drift right now, I'll fetch it from Supabase.
            const source = await statusService.getMediaSource(currentStatus.id, (currentStatus as any).mediaKey);
            if (!source) {
                console.warn(`[ViewStatus] Unable to resolve media for status ${currentStatus.id}`);
                setMediaSource(null);
                setLoading(false);
                return;
            }
            setMediaSource(source);
            // For images, loading is done. For videos, defer to onLoad callback.
            if (currentStatus.mediaType !== 'video') {
                setLoading(false);
            }

            // Mark as viewed
            if (currentUser) {
                statusService.onStatusViewed(currentStatus.id, currentUser.id);
            }
        };
        loadMedia();

        if (statusGroup.isMine) {
            statusService.getMyStatusViewers(currentStatus.id).then(setViewers);
            
            // Realtime listener for new viewers
            const channel = supabase
                .channel(`status_views_${currentStatus.id}`)
                .on(
                    'postgres_changes',
                    { 
                        event: 'INSERT', 
                        schema: 'public', 
                        table: 'status_views',
                        filter: `status_id=eq.${currentStatus.id}`
                    },
                    async () => {
                        const updated = await statusService.getMyStatusViewers(currentStatus.id);
                        setViewers(updated);
                    }
                )
                .subscribe();

            return () => {
                supabase.removeChannel(channel);
            };
        }
    }, [currentIndex, currentUser, progress, statusGroup]);

    const handleNext = useCallback(() => {
        if (statusGroup && currentIndex < statusGroup.statuses.length - 1) {
            setCurrentIndex(prev => prev + 1);
        } else {
            router.back();
        }
    }, [currentIndex, router, statusGroup]);

    const handlePrev = useCallback(() => {
        if (currentIndex > 0) {
            setCurrentIndex(prev => prev - 1);
        } else {
            progress.value = 0;
        }
    }, [currentIndex, progress]);

    // Progress Animation
    useEffect(() => {
        if (loading || !mediaSource) return;
        if (!statusGroup) return;

        if (isPaused) {
            cancelAnimation(progress);
            return;
        }
        
        const currentStatus = statusGroup.statuses[currentIndex];
        const duration = (currentStatus?.duration || 5) * 1000;
        const currentProgress = Math.min(Math.max(progress.value, 0), 0.999);
        const remainingDuration = Math.max(150, Math.round(duration * (1 - currentProgress)));

        cancelAnimation(progress);
        progress.value = withTiming(1, {
            duration: remainingDuration,
            easing: Easing.linear
        }, (finished) => {
            if (finished) runOnJS(handleNext)();
        });

        return () => cancelAnimation(progress);
    }, [handleNext, loading, mediaSource, currentIndex, isPaused, progress, statusGroup]);

    const pauseStatusPlayback = useCallback(() => {
        setIsPaused(true);
    }, []);

    const resumeStatusPlayback = useCallback(() => {
        setIsPaused(false);
    }, []);

    // Gestures
    const tapGesture = Gesture.Tap()
        .onEnd((e) => {
            if (e.x < width * 0.3) {
                runOnJS(handlePrev)();
            } else {
                runOnJS(handleNext)();
            }
        });

    const longPressGesture = Gesture.LongPress()
        .minDuration(200)
        .onStart(() => {
            isLongPressing.value = withTiming(1, { duration: 200 });
            cancelAnimation(progress);
            runOnJS(pauseStatusPlayback)();
        })
        .onFinalize(() => {
            isLongPressing.value = withTiming(0, { duration: 200 });
            runOnJS(resumeStatusPlayback)();
        });


    const panGesture = Gesture.Pan()
        .onUpdate((e) => {
            if (e.translationY > 0) {
                translateY.value = e.translationY;
                scale.value = 1 - (e.translationY / height) * 0.2;
            }
        })
        .onEnd((e) => {
            if (e.translationY > 100) {
                runOnJS(router.back)();
            } else {
                translateY.value = withSpring(0);
                scale.value = withSpring(1);
            }
        });

    const composedGestures = Gesture.Simultaneous(longPressGesture, Gesture.Exclusive(panGesture, tapGesture));

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { translateY: translateY.value },
            { scale: scale.value }
        ] as any,
        borderRadius: translateY.value > 0 ? 30 : 0,
        overflow: 'hidden'
    }));

    const mediaAnimatedStyle = useAnimatedStyle(() => ({
        transform: [
            { scale: withTiming(isLongPressing.value ? 1 : 1.15, { duration: 300 }) }
        ],
    }));

    const uiAnimatedStyle = useAnimatedStyle(() => ({
        opacity: withTiming(1 - isLongPressing.value, { duration: 200 }),
    }));

    const overlayAnimatedStyle = useAnimatedStyle(() => ({
        opacity: withTiming(1 - isLongPressing.value, { duration: 250 }),
    }));

    const maskAnimatedStyle = useAnimatedStyle(() => ({
        opacity: withTiming(isLongPressing.value, { duration: 250 }),
    }));

    const currentStatus = statusGroup?.statuses[currentIndex] ?? null;
    const trimmedReplyText = replyText.trim();
    const showSendAction = isReplyComposerActive || trimmedReplyText.length > 0;

    const buildStatusReplyMedia = useCallback(() => {
        if (!currentStatus) return null;

        const remoteStatusUrl = currentStatus.mediaKey
            ? proxySupabaseUrl(currentStatus.mediaKey)
            : (!mediaSource?.isLocal ? mediaSource?.uri : '');

        if (!remoteStatusUrl) return null;

        return {
            type: 'status_reply' as const,
            url: remoteStatusUrl,
            thumbnail: currentStatus.mediaType === 'image' ? remoteStatusUrl : undefined,
            caption: currentStatus.caption?.trim() || undefined,
        };
    }, [currentStatus, mediaSource]);

    const sendStatusReplyMessage = useCallback(async (text: string) => {
        if (!statusGroup || !currentStatus || isReplyActionLoading) return;

        const normalizedText = text.trim();
        const statusReplyMedia = buildStatusReplyMedia();
        if (!statusReplyMedia) {
            Alert.alert('Wait a second', 'Status preview abhi ready nahi hua. Ek baar phir try karo.');
            return;
        }

        setIsReplyActionLoading(true);
        let sendError: unknown = null;
        try {
            await sendChatMessage(statusGroup.user.id, normalizedText, statusReplyMedia);
        } catch (error) {
            sendError = error;
            console.warn('[ViewStatus] Failed to send status reply:', error);
            Alert.alert('Not sent', 'Status response send nahi hua. Dobara try karo.');
        }
        setIsReplyActionLoading(false);
        if (sendError) throw sendError;
    }, [buildStatusReplyMedia, currentStatus, isReplyActionLoading, sendChatMessage, statusGroup]);

    const handleSendReply = useCallback(async () => {
        if (!trimmedReplyText) return;
        try {
            await sendStatusReplyMessage(trimmedReplyText);
        } catch {
            return;
        }
        setReplyText('');
        setIsReplyComposerActive(false);
        replyInputRef.current?.blur();
    }, [sendStatusReplyMessage, trimmedReplyText]);

    const [showLikeAnim, setShowLikeAnim] = useState(false);
    const likeAnimRef = useRef<LottieView>(null);

    const handleLikeStatus = useCallback(async () => {
        setShowLikeAnim(true);
        likeAnimRef.current?.play();
        try {
            await sendStatusReplyMessage('❤️');
        } catch {}
    }, [sendStatusReplyMessage]);
    if (!statusGroup || !currentStatus) return <View style={styles.black} />;

    return (
        <GestureHandlerRootView style={styles.black}>
            <Animated.View style={[styles.container, animatedStyle]}>
                <StatusBar hidden />
                
                {/* Background Blur */}
                {mediaSource && (
                    <View style={StyleSheet.absoluteFill}>
                        <Image 
                            source={{ uri: mediaSource.uri }} 
                            style={[StyleSheet.absoluteFill, { opacity: 0.5 }]} 
                            blurRadius={100}
                        />
                        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} />
                    </View>
                )}
                
                {/* Media Content with Progressive Feathering */}
                <GestureDetector gesture={composedGestures}>
                    <MaskedView
                        style={StyleSheet.absoluteFill}
                        maskElement={
                            <View style={StyleSheet.absoluteFill}>
                                <LinearGradient
                                    colors={['transparent', 'white', 'white', 'transparent']}
                                    locations={[0, 0.15, 0.85, 1]}
                                    style={StyleSheet.absoluteFill}
                                />
                                {/* This view reveals the full image on long press by making the mask solid white */}
                                <Animated.View style={[
                                    StyleSheet.absoluteFill, 
                                    { backgroundColor: 'white' },
                                    maskAnimatedStyle
                                ]} />
                            </View>
                        }

                    >
                        <Animated.View style={[styles.mediaContainer, mediaAnimatedStyle]}>
                            {mediaSource ? (
                                currentStatus.mediaType === 'video' ? (
                                    <Video
                                        source={{ uri: mediaSource.uri }}
                                        style={StyleSheet.absoluteFill}
                                        resizeMode={ResizeMode.CONTAIN}
                                        shouldPlay={!loading && !isPaused}
                                        isMuted={false}
                                        onLoad={() => setLoading(false)}
                                    />
                                ) : (
                                    <Image 
                                        source={{ uri: mediaSource.uri }} 
                                        style={StyleSheet.absoluteFill} 
                                        resizeMode="contain" 
                                    />
                                )
                            ) : null}
                            
                            {loading && (
                                <View style={styles.loader}>
                                    <ActivityIndicator color="#fff" size="large" />
                                </View>
                            )}
                        </Animated.View>
                    </MaskedView>
                </GestureDetector>

                {/* Overlays (Gradients only, NO sharp blur blocks) */}
                <Animated.View style={[StyleSheet.absoluteFill, overlayAnimatedStyle]} pointerEvents="none">
                    {/* Top Section Readiness Gradient */}
                    <View style={styles.topGradientContainer}>
                        <LinearGradient
                            colors={[
                                'rgba(0,0,0,0.85)', 
                                'rgba(0,0,0,0.6)', 
                                'rgba(0,0,0,0.3)', 
                                'rgba(0,0,0,0.1)', 
                                'transparent'
                            ]}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>

                    {/* Bottom Section Readiness Gradient */}
                    <View style={styles.bottomGradientContainer}>
                        <LinearGradient
                            colors={[
                                'transparent', 
                                'rgba(0,0,0,0.1)', 
                                'rgba(0,0,0,0.3)', 
                                'rgba(0,0,0,0.6)', 
                                'rgba(0,0,0,0.85)'
                            ]}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>
                </Animated.View>




                {/* UI Content (Progress, Header, Reply) */}
                <Animated.View style={[StyleSheet.absoluteFill, uiAnimatedStyle]} pointerEvents="box-none">
                    <View style={[styles.overlay, { paddingTop: insets.top + 20 }]}>
                        {/* Progress Bars */}
                            <View style={[styles.progressRow, { marginBottom: 12 }]}>
                            {statusGroup.statuses.map((statusItem, i) => (
                                <StatusProgressBar 
                                    key={statusItem.id} 
                                    idx={i} 
                                    currentIndex={currentIndex} 
                                    progress={progress} 
                                />
                            ))}
                        </View>

                        {/* Header */}
                        <View style={styles.header}>
                            <Pressable onPress={() => router.back()} style={styles.backBtn}>
                                <Ionicons name="chevron-back" size={28} color="#fff" />
                            </Pressable>
                            <View style={styles.userRow}>
                                <SoulAvatar
                                    uri={proxySupabaseUrl(statusGroup.user.avatarUrl)}
                                    localUri={statusGroup.user.localAvatarUri}
                                    size={36}
                                />
                                <View style={{ marginLeft: 12 }}>
                                    <Text style={styles.userName}>{statusGroup.user.displayName || statusGroup.user.username}</Text>
                                    <Text style={styles.timeLabel}>
                                        {new Date(currentStatus.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </Text>
                                </View>
                            </View>
                        </View>
                    </View>

                    {/* Footer (Caption & Reply) */}
                    <View style={[styles.bottomOverlay, { paddingBottom: insets.bottom + 10 }]}>
                        {currentStatus.caption && (
                            <View style={styles.captionBox}>
                                <Text style={styles.captionText}>{currentStatus.caption}</Text>
                            </View>
                        )}

                        {!statusGroup.isMine ? (
                            <View style={styles.replyRow}>
                                <View style={[
                                    styles.replyInputBox,
                                    isReplyComposerActive && styles.replyInputBoxActive
                                ]}>
                                    <TextInput 
                                        ref={replyInputRef}
                                        style={styles.replyInput}
                                        placeholder="Reply..."
                                        placeholderTextColor="rgba(255,255,255,0.6)"
                                        value={replyText}
                                        onChangeText={setReplyText}
                                        onFocus={() => {
                                            setIsReplyComposerActive(true);
                                            pauseStatusPlayback();
                                        }}
                                        onBlur={() => {
                                            resumeStatusPlayback();
                                            if (!replyText.trim()) {
                                                setIsReplyComposerActive(false);
                                            }
                                        }}
                                        returnKeyType="send"
                                        onSubmitEditing={handleSendReply}
                                    />
                                </View>
                                <Pressable
                                    style={[
                                        styles.iconBtn,
                                        showSendAction ? [styles.iconBtnSend, { backgroundColor: themeAccent }] : styles.iconBtnLike,
                                        isReplyActionLoading && styles.iconBtnDisabled,
                                        showSendAction && !trimmedReplyText && styles.iconBtnDisabled,
                                    ]}
                                    onPress={showSendAction ? handleSendReply : handleLikeStatus}
                                    disabled={isReplyActionLoading || (showSendAction && !trimmedReplyText)}
                                >
                                    {isReplyActionLoading ? (
                                        <ActivityIndicator color="#fff" />
                                    ) : (
                                        <Ionicons
                                            name={showSendAction ? "send" : "heart"}
                                            size={24}
                                            color="#fff"
                                        />
                                    )}
                                </Pressable>
                            </View>
                        ) : (
                            <Pressable style={styles.viewersRow} onPress={() => setShowViewers(true)}>
                                <Ionicons name="eye-outline" size={20} color="#fff" style={{ marginRight: 8 }} />
                                <Text style={styles.viewersText}>{viewers.length} views</Text>
                            </Pressable>
                        )}
                    </View>
                </Animated.View>


                {/* Viewers Modal */}
                <Modal visible={showViewers} animationType="slide" transparent>
                    <GlassView intensity={90} tint="dark" style={styles.modal}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Viewed By</Text>
                            <Pressable onPress={() => setShowViewers(false)}>
                                <Ionicons name="close" size={24} color="#fff" />
                            </Pressable>
                        </View>
                        <ScrollView contentContainerStyle={styles.modalList}>
                            {viewers.map((v, i) => (
                                <View key={v.id || v.viewer_id || `viewer-${i}`} style={styles.viewerItem}>
                                    <SoulAvatar
                                        uri={proxySupabaseUrl(v.profiles?.avatar_url)}
                                        size={40}
                                    />
                                    <Text style={styles.viewerName}>{v.profiles?.display_name || v.profiles?.username}</Text>
                                </View>
                            ))}
                        </ScrollView>
                    </GlassView>
                </Modal>

                {/* Like burst animation */}
                {showLikeAnim && (
                    <View style={StyleSheet.absoluteFill} pointerEvents="none">
                        <LottieView
                            ref={likeAnimRef}
                            source={require('../assets/animations/status-like.json')}
                            autoPlay
                            loop={false}
                            style={{ flex: 1 }}
                            onAnimationFinish={() => setShowLikeAnim(false)}
                        />
                    </View>
                )}
            </Animated.View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    black: { flex: 1, backgroundColor: '#000' },
    container: { flex: 1, backgroundColor: '#000' },
    mediaContainer: { flex: 1, backgroundColor: 'transparent' },
    loader: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
    overlay: { ...StyleSheet.absoluteFillObject, height: 150, paddingHorizontal: 10 },
    progressRow: { flexDirection: 'row', gap: 6, width: '100%', marginBottom: 15 },
    progressBar: { flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: '#fff' },
    header: { flexDirection: 'row', alignItems: 'center' },
    backBtn: { padding: 5 },
    userRow: { flexDirection: 'row', alignItems: 'center', marginLeft: 10 },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#333', marginRight: 12 },
    userName: { color: '#fff', fontSize: 16, fontWeight: '700' },
    timeLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
    bottomOverlay: { position: 'absolute', bottom: 0, width: '100%', paddingHorizontal: 20 },
    captionBox: { backgroundColor: 'rgba(0,0,0,0.5)', padding: 12, borderRadius: 12, marginBottom: 20 },
    captionText: { color: '#fff', fontSize: 16, textAlign: 'center' },
    replyRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    replyInputBox: { flex: 1, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 25, height: 50, justifyContent: 'center', paddingHorizontal: 20, borderWidth: 1, borderColor: 'transparent' },
    replyInputBoxActive: { backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.22)' },
    replyInput: { color: '#fff', fontSize: 15 },
    iconBtn: { width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center' },
    iconBtnSend: { backgroundColor: '#8C0016' },
    iconBtnLike: { backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
    iconBtnDisabled: { opacity: 0.45 },
    viewersRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
    viewersText: { color: '#fff', fontWeight: '600' },
    modal: { flex: 1, marginTop: 100, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 25 },
    modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
    modalList: { padding: 25 },
    viewerItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
    viewerAvatar: { width: 44, height: 44, borderRadius: 22, marginRight: 15 },
    viewerName: { color: '#fff', fontSize: 16, fontWeight: '600' },
    topGradientContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 320, // Equalized
        overflow: 'hidden',
    },
    bottomGradientContainer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 320, // Equalized
        overflow: 'hidden',
    }



});
