import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    Image,
    Pressable,
    StyleSheet,
    useWindowDimensions,
    TextInput,
    KeyboardAvoidingView,
    Platform,
    StatusBar,
    ActivityIndicator,
    Modal,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withSpring,
    runOnJS,
    interpolate,
    Extrapolation,
    Easing,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Video, ResizeMode } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MORPH_EASING, MORPH_OUT_EASING } from '../constants/transitions';


interface LayoutRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface EnhancedMediaViewerProps {
    visible: boolean;
    media: {
        url: string;
        type: 'image' | 'video' | 'audio' | 'status_reply';
        caption?: string;
    } | null;
    sourceLayout: LayoutRect | null;
    onClose: () => void;
    onSendComment?: (comment: string) => void;
    onDownload?: () => void;
    onReply?: () => void;
    onForward?: () => void;
    onReaction?: (emoji: string) => void;
    onEdit?: () => void;
    onShare?: () => void;
    userInfo?: {
        name: string;
        avatar?: string;
        timestamp?: string;
    };
}

export const EnhancedMediaViewer: React.FC<EnhancedMediaViewerProps> = ({
    visible,
    media,
    sourceLayout,
    onClose,
    onSendComment,
    onDownload,
    onReply,
    onForward,
    onReaction,
    onEdit,
    onShare,
    userInfo,
}) => {
    const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const bottomOffset =
        Platform.OS === 'ios'
            ? Math.max(insets.bottom - 14, 6)
            : Math.max(insets.bottom, 12);
    const [isFullyOpen, setIsFullyOpen] = useState(false);
    const [comment, setComment] = useState('');
    const [showMenu, setShowMenu] = useState(false);
    
    // Shared values for animation
    const animationProgress = useSharedValue(0);
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const menuProgress = useSharedValue(0);

    const isClosing = useRef(false);

    useEffect(() => {
        if (visible && media && sourceLayout) {
            isClosing.current = false;
            translateY.value = 0;
            scale.value = 1;
            animationProgress.value = 0;
            
            animationProgress.value = withTiming(1, {
                duration: 450,
                easing: MORPH_EASING,
            }, (finished) => {
                if (finished) runOnJS(setIsFullyOpen)(true);
            });
            
            StatusBar.setBarStyle('light-content');
        } else if (!visible) {
            setIsFullyOpen(false);
            setComment('');
            setShowMenu(false);
        }
    }, [visible, media, sourceLayout]);

    const handleClose = useCallback(() => {
        if (isClosing.current) return;
        isClosing.current = true;
        setIsFullyOpen(false);
        setShowMenu(false);
        
        animationProgress.value = withTiming(0, {
            duration: 350,
            easing: MORPH_OUT_EASING,
        }, (finished) => {
            if (finished) runOnJS(onClose)();
        });
    }, [onClose]);

    // Swipe down gesture
    const panGesture = Gesture.Pan()
        .onUpdate((event) => {
            if (event.translationY > 0) {
                translateY.value = event.translationY;
                scale.value = interpolate(
                    event.translationY,
                    [0, 300],
                    [1, 0.8],
                    Extrapolation.CLAMP
                );
            }
        })
        .onEnd((event) => {
            if (event.translationY > 150 || event.velocityY > 1000) {
                runOnJS(handleClose)();
            } else {
                translateY.value = withSpring(0);
                scale.value = withSpring(1);
            }
        });

    // Long press for menu
    const longPressGesture = Gesture.LongPress()
        .onStart(() => {
            runOnJS(setShowMenu)(true);
            menuProgress.value = withSpring(1);
        });

    const animatedContainerStyle = useAnimatedStyle(() => {
        const p = animationProgress.value;
        const opacity = interpolate(p, [0, 0.2], [0, 1]);
        return {
            opacity,
        };
    });

    const animatedMediaStyle = useAnimatedStyle(() => {
        const p = animationProgress.value;
        if (!sourceLayout) return {};

        // Morph from source bubble to MASSIVE Ultra-Immersive card (v3)
        // Fixed Large Bounding Box strategy: card is always large, image contains inside.
        const targetWidth = SCREEN_WIDTH - 16;
        const targetHeight = SCREEN_HEIGHT * 0.82;
        
        const targetX = (SCREEN_WIDTH - targetWidth) / 2;
        const targetY = (SCREEN_HEIGHT - targetHeight) / 2;

        return {
            position: 'absolute',
            left: interpolate(p, [0, 1], [sourceLayout.x, targetX]),
            top: interpolate(p, [0, 1], [sourceLayout.y, targetY]) + translateY.value,
            width: interpolate(p, [0, 1], [sourceLayout.width, targetWidth]),
            height: interpolate(p, [0, 1], [sourceLayout.height, targetHeight]),
            borderRadius: interpolate(p, [0, 1], [16, 36]), // Ultra-smooth corners
            transform: [{ scale: scale.value }],
            overflow: 'hidden',
            backgroundColor: 'rgba(255,255,255,0.03)', // Define the card boundaries subtly
        };
    });

    const animatedOverlayStyle = useAnimatedStyle(() => ({
        opacity: interpolate(animationProgress.value, [0.8, 1], [0, 1]),
        transform: [{ translateY: interpolate(animationProgress.value, [0.8, 1], [20, 0]) }]
    }));

    const menuStyle = useAnimatedStyle(() => ({
        opacity: menuProgress.value,
        transform: [{ scale: interpolate(menuProgress.value, [0, 1], [0.8, 1]) }]
    }));

    const handleReaction = (emoji: string) => {
        if (onReaction) runOnJS(onReaction)(emoji);
        menuProgress.value = withTiming(0, { duration: 150 }, () => runOnJS(setShowMenu)(false));
    };

    if (!visible || !media || !sourceLayout) return null;

    return (
        <Modal
            visible={visible}
            transparent
            presentationStyle="overFullScreen"
            statusBarTranslucent
            animationType="none"
            onRequestClose={handleClose}
        >
            <View style={StyleSheet.absoluteFill} pointerEvents="auto">
                <Animated.View style={[StyleSheet.absoluteFill, animatedContainerStyle]}>
                    <BlurView intensity={95} tint="dark" style={StyleSheet.absoluteFill} experimentalBlurMethod="dimezisBlurView" />
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.15)' }]} />
                    <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                </Animated.View>

            <GestureDetector gesture={Gesture.Exclusive(panGesture, longPressGesture)}>
                <Animated.View style={animatedMediaStyle}>
                    {media.type === 'video' ? (
                        <Video
                            source={{ uri: media.url }}
                            style={styles.fullMedia}
                            resizeMode={ResizeMode.COVER}
                            shouldPlay
                            isLooping
                        />
                    ) : (
                        <Image source={{ uri: media.url }} style={styles.fullMedia} resizeMode="cover" />
                    )}
                    
                </Animated.View>
            </GestureDetector>

            {/* Top Bar - Header & Actions */}
            <Animated.View style={[styles.topBar, animatedOverlayStyle]}>
                <View style={styles.topBarLeft}>
                    <Pressable onPress={handleClose} style={styles.topIcon}>
                        <MaterialIcons name="close" size={28} color="white" />
                    </Pressable>
                    
                    <View style={styles.userHeader}>
                        {userInfo?.avatar ? (
                            <Image source={{ uri: userInfo.avatar }} style={styles.headerAvatar} />
                        ) : (
                            <View style={[styles.headerAvatar, { backgroundColor: '#333' }]} />
                        )}
                        <View style={styles.userInfoText}>
                            <Text style={styles.userNameText}>{userInfo?.name || 'You'}</Text>
                            <Text style={styles.timestampText}>{userInfo?.timestamp || 'Just now'}</Text>
                        </View>
                    </View>
                </View>

            </Animated.View>

            {/* Bottom Keyboard Area */}
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={[
                    styles.bottomArea,
                    { bottom: bottomOffset }
                ]}
            >
                <Animated.View style={[styles.inputContainer, animatedOverlayStyle]}>
                    <View style={styles.inputPill}>
                        <TextInput
                            style={styles.input}
                            placeholder="Reply..."
                            placeholderTextColor="rgba(255,255,255,0.4)"
                            value={comment}
                            onChangeText={setComment}
                            multiline
                        />
                        <Pressable 
                            style={[styles.sendIconBtn, !comment.trim() && { opacity: 0.3 }]}
                            onPress={() => comment.trim() && onSendComment?.(comment)}
                        >
                            <MaterialIcons name="send" size={24} color="white" />
                        </Pressable>
                    </View>
                </Animated.View>
            </KeyboardAvoidingView>

            {/* Long Press Menu Overlay */}
            {showMenu && (
                <View style={styles.menuOverlay}>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => {
                        menuProgress.value = withTiming(0, { duration: 150 }, () => runOnJS(setShowMenu)(false));
                    }} />
                    <Animated.View style={[styles.menuContainer, menuStyle]}>
                        <BlurView intensity={95} tint="dark" style={styles.menuBlur} experimentalBlurMethod="dimezisBlurView">
                            <View style={styles.reactionRow}>
                                {['❤️', '🔥', '😂', '😮', '😢'].map(emoji => (
                                    <Pressable key={emoji} onPress={() => handleReaction(emoji)} style={styles.reactionItem}>
                                        <Text style={styles.reactionText}>{emoji}</Text>
                                    </Pressable>
                                ))}
                            </View>
                            <View style={styles.menuDivider} />
                            <Pressable style={styles.menuItem} onPress={() => {
                                onReply?.();
                                menuProgress.value = withTiming(0, { duration: 150 }, () => runOnJS(setShowMenu)(false));
                            }}>
                                <MaterialIcons name="reply" size={22} color="white" />
                                <Text style={styles.menuItemText}>Reply</Text>
                            </Pressable>
                            <View style={styles.menuDivider} />
                            <Pressable style={styles.menuItem} onPress={() => {
                                onForward?.();
                                menuProgress.value = withTiming(0, { duration: 150 }, () => runOnJS(setShowMenu)(false));
                            }}>
                                <MaterialIcons name="forward" size={22} color="white" />
                                <Text style={styles.menuItemText}>Forward</Text>
                            </Pressable>
                            <View style={styles.menuDivider} />
                            <Pressable style={styles.menuItem} onPress={() => {
                                onDownload?.();
                                menuProgress.value = withTiming(0, { duration: 150 }, () => runOnJS(setShowMenu)(false));
                            }}>
                                <MaterialIcons name="file-download" size={22} color="white" />
                                <Text style={styles.menuItemText}>Save to Gallery</Text>
                            </Pressable>
                        </BlurView>
                    </Animated.View>
                </View>
            )}
        </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    fullMedia: {
        width: '100%',
        height: '100%',
    },
    topBar: {
        position: 'absolute',
        top: 60,
        left: 0,
        right: 0,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10,
    },
    topBarLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    topBarRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    topIcon: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    userHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    headerAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: '#444',
    },
    userInfoText: {
        justifyContent: 'center',
    },
    userNameText: {
        color: 'white',
        fontSize: 14,
        fontWeight: '700',
    },
    timestampText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 11,
    },
    iconButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    bottomArea: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'transparent',
    },
    inputContainer: {
        paddingHorizontal: 15,
    },
    inputPill: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#1c1c1e',
        borderRadius: 26,
        minHeight: 52,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    inputBlur: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 25,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        paddingHorizontal: 15,
        paddingVertical: 8,
        backgroundColor: 'rgba(255,255,255,0.05)',
        overflow: 'hidden',
    },
    input: {
        flex: 1,
        color: 'white',
        fontSize: 15,
        maxHeight: 100,
        paddingVertical: 0,
        paddingHorizontal: 10,
    },
    sendIconBtn: {
        paddingHorizontal: 12,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: '#BC002A',
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 10,
    },
    menuOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.3)',
        zIndex: 1000,
    },
    menuContainer: {
        width: '80%',
        maxWidth: 300,
    },
    menuBlur: {
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(30,30,35,0.8)',
    },
    reactionRow: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingVertical: 15,
        paddingHorizontal: 10,
    },
    reactionItem: {
        padding: 5,
    },
    reactionText: {
        fontSize: 28,
    },
    menuDivider: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 15,
        gap: 15,
    },
    menuItemText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '500',
    },
});

export default EnhancedMediaViewer;
