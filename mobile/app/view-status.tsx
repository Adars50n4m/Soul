import React, { useState, useEffect, useCallback } from 'react';
import {
    View, Text, Image, StyleSheet, StatusBar,
    useWindowDimensions, Platform, Pressable, Alert, TextInput, Keyboard, Modal, KeyboardAvoidingView, ScrollView
} from 'react-native';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
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
import { useApp } from '../context/AppContext';



const StatusProgressBar = ({ idx, currentIndex, progress }: any) => {
    const style = useAnimatedStyle(() => ({
        width: idx < currentIndex
            ? '100%'
            : idx === currentIndex
                ? `${progress.value * 100}%`
                : '0%'
    }));
    return <Animated.View style={[styles.progressFill, style]} />;
};

export default function ViewStatusScreen() {
    const { width, height } = useWindowDimensions();
    const { id, index } = useLocalSearchParams<{ id: string; index: string }>();
    const router = useRouter();
    const { statuses, contacts, currentUser, deleteStatus, addStatusView, sendChatMessage, toggleStatusLike, activeTheme } = useApp();
    const [currentIndex, setCurrentIndex] = useState(parseInt(index || '0'));
    const [replyText, setReplyText] = useState('');
    const [modalVisible, setModalVisible] = useState(false);
    
    // Reanimated Shared Values
    const progress = useSharedValue(0);
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);

    // Get statuses for this user
    const userStatuses = statuses.filter(s => s.userId === id);
    const currentStatus = userStatuses[currentIndex];

    // Get contact info
    const isMyStatus = id === currentUser?.id;
    const contact = isMyStatus
        ? { name: currentUser?.name || 'Me', avatar: currentUser?.avatar || '' }
        : contacts.find(c => c.id === id);

    // Get viewer info
    const viewers = currentStatus?.views?.map(viewerId => {
        if (viewerId === currentUser?.id) return currentUser;
        return contacts.find(c => c.id === viewerId);
    }).filter(Boolean) as { name: string, avatar: string }[];

    const DURATION = 5000;

    // Record a view
    useEffect(() => {
        if (currentStatus && !isMyStatus) {
            addStatusView(currentStatus.id);
        }
    }, [currentStatus, isMyStatus, addStatusView]);

    const navigation = useNavigation();

    const handleNext = useCallback(() => {
        if (currentIndex < userStatuses.length - 1) {
            progress.value = 0;
            setCurrentIndex(prev => prev + 1);
        } else if (navigation.canGoBack()) {
            navigation.goBack();
        }
    }, [currentIndex, userStatuses.length, navigation]);

    const handlePrev = useCallback(() => {
        if (currentIndex > 0) {
            progress.value = 0;
            setCurrentIndex(prev => prev - 1);
        } else {
            progress.value = 0; // Reset current if at start
        }
    }, [currentIndex]);

    const startProgress = useCallback(() => {
        cancelAnimation(progress);
        progress.value = withTiming(1, {
            duration: DURATION * (1 - progress.value),
            easing: Easing.linear
        }, (finished) => {
            if (finished) {
                runOnJS(handleNext)();
            }
        });
    }, [handleNext]);

    useEffect(() => {
        if (!currentStatus) return;
        progress.value = 0;
        startProgress();
        return () => cancelAnimation(progress);
    }, [currentIndex, currentStatus, startProgress]);

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
            cancelAnimation(progress);
        })
        .onEnd(() => {
            runOnJS(startProgress)();
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
                if (navigation.canGoBack()) runOnJS(navigation.goBack)();
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
        ],
        borderRadius: translateY.value > 0 ? 20 : 0,
    }));

    const handleLike = () => {
        if (currentStatus) {
            toggleStatusLike(currentStatus.id);
        }
    };

    const handleReply = () => {
        if (!replyText.trim() || !currentStatus || !id) return;

        // Send message with status thumbnail
        sendChatMessage(id, replyText, {
            type: 'status_reply',
            url: currentStatus.mediaUrl,
            caption: currentStatus.caption
        });

        // Navigate to chat
        router.push(`/chat/${id}`);
    };

    const handleDelete = () => {
        cancelAnimation(progress);
        Alert.alert(
            "Delete Status",
            "Are you sure you want to delete this status?",
            [
                { 
                    text: "Cancel", 
                    style: "cancel",
                    onPress: () => startProgress()
                },
                { 
                    text: "Delete", 
                    style: "destructive", 
                    onPress: () => {
                        if (currentStatus) deleteStatus(currentStatus.id);
                        if (navigation.canGoBack()) navigation.goBack();
                    }
                }
            ]
        );
    };

    if (!currentStatus || !contact) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>Status not found</Text>
            </View>
        );
    }

    const hasLiked = currentStatus.likes?.includes(currentUser?.id || '');

    return (
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: 'black' }}>
            <Animated.View style={[styles.container, animatedStyle]}>
            <StatusBar hidden />

            {/* Progress Bars */}
            <View style={styles.progressContainer}>
                {userStatuses.map((status, idx) => (
                    <View key={status.id} style={styles.progressBar}>
                        <StatusProgressBar idx={idx} currentIndex={currentIndex} progress={progress} />
                    </View>
                ))}
            </View>

            {/* Header */}
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton}>
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>

                <Image source={{ uri: contact.avatar }} style={styles.avatar} />

                <View style={styles.headerInfo}>
                    <Text style={styles.userName}>{contact.name}</Text>
                    <Text style={styles.timestamp}>{currentStatus.timestamp}</Text>
                </View>

                {isMyStatus ? (
                    <Pressable onPress={handleDelete} style={styles.moreButton}>
                        <MaterialIcons name="delete" size={24} color="#ffffff" />
                    </Pressable>
                ) : (
                    <View style={styles.moreButton}>
                        <MaterialIcons name="more-vert" size={24} color="#ffffff" />
                    </View>
                )}
            </View>

            {/* Status Content */}
            <GestureDetector gesture={composedGestures}>
                <View style={styles.content}>
                    {currentStatus.mediaType === 'video' ? (
                        <Video
                            source={{ uri: currentStatus.mediaUrl }}
                            style={[styles.media, { width, height: height * 0.6 }]}
                            resizeMode={ResizeMode.CONTAIN}
                            shouldPlay
                            isLooping={false}
                            onPlaybackStatusUpdate={(status: any) => {
                                if (status.isLoaded && status.didJustFinish) {
                                    runOnJS(handleNext)();
                                }
                            }}
                        />
                    ) : (
                        <Image
                            source={{ uri: currentStatus.mediaUrl }}
                            style={[styles.media, { width, height: height * 0.6 }]}
                            resizeMode="contain"
                        />
                    )}
                </View>
            </GestureDetector>

            {/* Caption */}
            {currentStatus.caption && (
                <View style={styles.captionContainer}>
                    <Text style={styles.caption}>{currentStatus.caption}</Text>
                </View>
            )}

            {/* Interactions Footer */}
            <View style={styles.interactionsFooter}>
                {/* Views (only for my status) */}
                {isMyStatus ? (
                    <Pressable onPress={() => setModalVisible(true)} style={styles.viewsWrapper}>
                        <MaterialIcons name="visibility" size={20} color="#ffffff" />
                        <Text style={styles.viewsText}>
                            {currentStatus.views?.length || 0}
                        </Text>
                    </Pressable>
                ) : (
                    <View style={styles.likesWrapper}>
                        <Pressable onPress={handleLike} style={styles.likeButton}>
                            <MaterialIcons 
                                name={hasLiked ? "favorite" : "favorite-border"} 
                                size={28} 
                                color={hasLiked ? activeTheme.primary : "#ffffff"} 
                            />
                        </Pressable>
                        {currentStatus.likes?.length > 0 && (
                            <Text style={styles.likesText}>{currentStatus.likes.length}</Text>
                        )}
                    </View>
                )}
            </View>

            {/* Reply (for others' status) */}
            {!isMyStatus && (
                <KeyboardAvoidingView 
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    keyboardVerticalOffset={20}
                    style={styles.keyboardView}
                >
                    <View style={styles.replyContainer}>
                        <View style={styles.replyInput}>
                            <TextInput
                                style={styles.replyPlaceholder}
                                placeholder={`Reply to ${contact.name}...`}
                                placeholderTextColor="rgba(255,255,255,0.5)"
                                value={replyText}
                                onChangeText={setReplyText}
                                onSubmitEditing={handleReply}
                                returnKeyType="send"
                            />
                        </View>
                        <Pressable style={styles.replyButton} onPress={handleReply}>
                            <MaterialIcons name="send" size={24} color="#ffffff" />
                        </Pressable>
                    </View>
                </KeyboardAvoidingView>
            )}

            <Modal
                animationType="slide"
                transparent={true}
                visible={modalVisible}
                onRequestClose={() => setModalVisible(false)}
            >
                <Pressable style={styles.modalOverlay} onPress={() => setModalVisible(false)}>
                    <View style={[styles.modalContent, { maxHeight: height * 0.6 }]}>
                        <Text style={styles.modalTitle}>Viewed By</Text>
                        <ScrollView>
                            {viewers.length > 0 ? viewers.map((viewer: any) => (
                                <View key={viewer.id} style={styles.viewerRow}>
                                    <Image source={{ uri: viewer.avatar }} style={styles.viewerAvatar} />
                                    <Text style={styles.viewerName}>{viewer.name}</Text>
                                </View>
                            )) : <Text style={styles.viewerName}>No one has viewed this status yet.</Text>}
                        </ScrollView>
                    </View>
                </Pressable>
            </Modal>
            </Animated.View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000000',
        overflow: 'hidden',
    },
    errorText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
    progressContainer: {
        flexDirection: 'row',
        paddingHorizontal: 8,
        paddingTop: 50,
        gap: 4,
    },
    progressBar: {
        flex: 1,
        height: 2,
        backgroundColor: 'rgba(255,255,255,0.3)',
        borderRadius: 1,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: '#ffffff',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    backButton: {
        padding: 8,
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginLeft: 8,
    },
    headerInfo: {
        flex: 1,
        marginLeft: 12,
    },
    userName: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '700',
    },
    timestamp: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 12,
        marginTop: 2,
    },
    moreButton: {
        padding: 8,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    media: {
    },
    captionContainer: {
        paddingHorizontal: 24,
        paddingVertical: 16,
    },
    caption: {
        color: '#ffffff',
        fontSize: 16,
        lineHeight: 24,
        textAlign: 'center',
    },
    viewsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 16,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
    },
    viewsText: {
        color: '#ffffff',
        fontSize: 14,
    },
    interactionsFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
        gap: 20,
    },
    viewsWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    likesWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    likeButton: {
        padding: 4,
    },
    likesText: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '600',
    },
    replyContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        paddingBottom: 40,
        gap: 12,
    },
    replyInput: {
        flex: 1,
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 24,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    replyPlaceholder: {
        color: '#ffffff',
        fontSize: 15,
    },
    replyButton: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: '#f43f5e',
        alignItems: 'center',
        justifyContent: 'center',
    },
    keyboardView: {
        width: '100%',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        backgroundColor: '#1c1c1e',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 24,
    },
    modalTitle: {
        color: '#fff',
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 20,
        textAlign: 'center',
    },
    viewerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    viewerAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
    },
    viewerName: {
        color: '#fff',
        fontSize: 16,
    },
});
