import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import {
    View, Text, Image, FlatList, TextInput, Pressable,
    StyleSheet, StatusBar, Platform,
    Modal, Animated as RNAnimated, Dimensions, Keyboard, KeyboardEvent, Alert, InteractionManager, ScrollView
} from 'react-native';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withDelay,
    runOnJS,
    interpolate,
    interpolateColor,
    Extrapolation,
    Easing,
} from 'react-native-reanimated';
import { MORPH_EASING, MORPH_IN_DURATION, MORPH_OUT_DURATION, MORPH_OUT_EASING, MORPH_SPRING_CONFIG } from '../../constants/transitions';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { useApp } from '../../context/AppContext';
import { MusicPlayerOverlay } from '../../components/MusicPlayerOverlay';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { storageService } from '../../services/StorageService';
import { EnhancedMediaViewer } from '../../components/EnhancedMediaViewer';
import { Contact, Message } from '../../types';
import { ResizeMode, Video, Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';



// Header Pill Constants
const HEADER_PILL_TOP = 62;
const HEADER_PILL_HEIGHT = 64;
const HEADER_PILL_RADIUS = HEADER_PILL_HEIGHT / 2;

type ChatMediaItem = {
    type: 'image' | 'video' | 'audio' | 'file' | 'status_reply';
    url: string;
    caption?: string;
};

const getMessageMediaItems = (msg: any): ChatMediaItem[] => {
    if (!msg?.media) return [];

    if (Array.isArray(msg.media)) {
        return msg.media.filter((m: any) => m?.url);
    }

    if (Array.isArray(msg.media?.items)) {
        return msg.media.items.filter((m: any) => m?.url);
    }

    if (msg.media?.url) {
        return [msg.media];
    }

    return [];
};

// Sanitize song title - remove metadata like "(From ...)" or "[Album Name]"
const sanitizeSongTitle = (title: string): string => {
    if (!title) return '';
    // Remove text in parentheses and brackets
    return title
        .replace(/\s*\([^)]*\)/g, '')  // Remove (anything)
        .replace(/\s*\[[^\]]*\]/g, '') // Remove [anything]
        .trim();
};

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const IS_IOS = Platform.OS === 'ios';
const IOS_KEYBOARD_SAFE_ADJUST = 16; // Elegant small gap above keyboard

const ProgressiveBlur = ({
    position = 'top',
    height = 180,
    intensity = 300,
    steps = 90,
}: {
    position?: 'top' | 'bottom';
    height?: number;
    intensity?: number;
    steps?: number;
}) => {
    // Progressive blur without dark overlay:
    // Stack many blur layers anchored to the same edge with increasing height.
    // This avoids hard "join lines" because layers overlap fully from the edge.
    return (
        <View
            style={{
                position: 'absolute',
                [position]: 0,
                left: 0,
                right: 0,
                height,
                zIndex: position === 'top' ? 90 : 50,
                overflow: 'hidden',
            }}
            pointerEvents="none"
        >
            {Array.from({ length: steps }).map((_, i) => {
                const ratio = (i + 1) / steps;
                const layerHeight = height * ratio;

                // More weight near the edge, smoother fade out.
                const fade = Math.pow(1 - ratio, 1.4);
                const opacity = Math.max(0, Math.min(1, fade));

                return (
                    <BlurView
                        key={i}
                        intensity={intensity / steps}
                        tint="dark"
                        style={{
                            position: 'absolute',
                            [position]: 0,
                            left: 0,
                            right: 0,
                            height: layerHeight,
                            opacity,
                        }}
                    />
                );
            })}
        </View>
    );
};

const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// Message Bubble with Liquid Glass UI - wrapped with React.memo for performance
const VoiceNotePlayer = ({ uri, isMe, theme }: any) => {
    const soundRef = useRef<Audio.Sound | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);

    const onPlaybackStatusUpdate = (status: any) => {
        if (status.isLoaded) {
            setPosition(status.positionMillis);
            setDuration(status.durationMillis || 0);
            if (status.didJustFinish) {
                setIsPlaying(false);
                setPosition(0);
                soundRef.current?.setPositionAsync(0);
            }
        }
    };

    const togglePlayPause = async () => {
        try {
            if (!soundRef.current) {
                const { sound } = await Audio.Sound.createAsync(
                    { uri },
                    { shouldPlay: true },
                    onPlaybackStatusUpdate
                );
                soundRef.current = sound;
                setIsPlaying(true);
            } else {
                if (isPlaying) {
                    await soundRef.current.pauseAsync();
                    setIsPlaying(false);
                } else {
                    await soundRef.current.playAsync();
                    setIsPlaying(true);
                }
            }
        } catch (err) {
            console.error('Playback failed', err);
        }
    };

    useEffect(() => {
        return () => {
            if (soundRef.current) {
                soundRef.current.unloadAsync();
            }
        };
    }, []);

    const progress = duration > 0 ? position / duration : 0;

    return (
        <View style={styles.voiceNoteContainer}>
            <Pressable onPress={togglePlayPause} style={[styles.vnPlayButton, { backgroundColor: isMe ? 'rgba(255,255,255,0.2)' : theme.primary }]}>
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={24} color="white" />
            </Pressable>
            <View style={styles.vnProgressWrapper}>
                <View style={[styles.vnProgressBackground, { backgroundColor: isMe ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)' }]} />
                <View style={[styles.vnProgressBar, { width: `${progress * 100}%`, backgroundColor: isMe ? '#fff' : theme.primary }]} />
            </View>
            <Text style={styles.vnDuration}>{formatDuration(Math.floor((duration || 0) / 1000))}</Text>
        </View>
    );
};

const MessageBubble = React.memo(({ 
  msg, 
  contactName, 
  onLongPress, 
  onReply, 
  isSelected, 
  onReaction, 
  quotedMessage, 
  onDoubleTap, 
  onMediaTap, 
  isClone
}: any) => {
  const { activeTheme } = useApp();
    const translateX = useSharedValue(0);
    const isMe = msg.sender === 'me';

    const doubleTapGesture = Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(250)
        .onEnd(() => {
            if (onDoubleTap) runOnJS(onDoubleTap)(msg.id);
        });

    const bubbleRef = useRef<View>(null);

    const measureAndShowMenu = useCallback((id: string) => {
        bubbleRef.current?.measure((x, y, width, height, pageX, pageY) => {
            if (onLongPress) {
                onLongPress(id, { x: pageX, y: pageY, width, height });
            }
        });
    }, [onLongPress]);

    const mediaItems = getMessageMediaItems(msg);

    const measureAndShowMedia = useCallback((index: number, openGallery: boolean) => {
        bubbleRef.current?.measure((x, y, width, height, pageX, pageY) => {
            if (onMediaTap) {
                onMediaTap({
                    messageId: msg.id,
                    mediaItems,
                    index,
                    openGallery,
                    layout: { x: pageX, y: pageY, width, height }
                });
            }
        });
    }, [onMediaTap, msg.id, mediaItems]);

    const longPressGesture = Gesture.LongPress()
        .minDuration(400) // slightly faster response
        .runOnJS(true)
        .onStart(() => {
            if (isClone) return; // Prevent interaction on cloned bubbles
            measureAndShowMenu(msg.id);
        });

    const panGesture = Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onUpdate((event) => {
            if (event.translationX > 0) translateX.value = event.translationX * 0.3;
        })
        .onEnd((event) => {
            if (event.translationX > 60) runOnJS(onReply)(msg);
            translateX.value = withSpring(0);
        });

    const composedGestures = Gesture.Simultaneous(panGesture, Gesture.Exclusive(doubleTapGesture, longPressGesture));

    const bubbleStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: translateX.value }]
    }));

    const formatTime = (ts: string) => {
        if (!ts) return '';
        if (ts.includes('AM') || ts.includes('PM') || ts.includes(':')) {
            // If it already looks formatted like '10:30 AM' or '14:30' but not an ISO string containing 'T'
            if (!ts.includes('T')) return ts; 
        }
        try {
            return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch(e) {
            return ts;
        }
    };

    const iconStyle = useAnimatedStyle(() => ({
        opacity: interpolate(translateX.value, [0, 50], [0, 1], Extrapolation.CLAMP),
        transform: [
            { scale: interpolate(translateX.value, [0, 50], [0.5, 1], Extrapolation.CLAMP) },
            { translateX: interpolate(translateX.value, [0, 50], [-20, 0], Extrapolation.CLAMP) }
        ]
    }));

    // const mediaItems = getMessageMediaItems(msg); // Removed duplicate/later declaration
    const hasText = !!msg.text?.trim();
    const hasCaption = !!msg.media?.caption?.trim();
    const isMediaOnly = mediaItems.length > 0 && !hasText && !hasCaption && !quotedMessage;

    const handleMediaPress = (index: number, openGallery = false) => {
        if (!onMediaTap) return;
        measureAndShowMedia(index, openGallery);
    };

    const renderMediaContent = () => {
        if (!mediaItems.length) return null;

        if (mediaItems.length === 1) {
            const media = mediaItems[0];
            
            if (media.type === 'audio') {
                return <VoiceNotePlayer uri={media.url} isMe={isMe} theme={activeTheme} />;
            }

            return (
                <Pressable
                    onPress={() => handleMediaPress(0)}
                    style={[
                        styles.mediaSurface,
                        isMe ? styles.mediaSurfaceMe : styles.mediaSurfaceThem,
                        !hasText && !hasCaption && styles.mediaSingleNoGap
                    ]}
                >
                    <Animated.Image
                        source={{ uri: media.url }}
                        style={styles.mediaSingle}
                    />
                    {media.type === 'video' && (
                        <View style={styles.mediaTilePlayOverlay}>
                            <MaterialIcons name="play-circle-filled" size={46} color="rgba(255,255,255,0.92)" />
                        </View>
                    )}
                </Pressable>
            );
        }

        const visibleItems = mediaItems.slice(0, 4);
        const extraCount = mediaItems.length - 4;
        return (
            <View
                style={[
                    styles.mediaSurface,
                    styles.mediaGridSurface,
                    isMe ? styles.mediaSurfaceMe : styles.mediaSurfaceThem,
                    !hasText && !hasCaption && styles.mediaGridNoGap
                ]}
            >
                <View style={styles.mediaGrid}>
                    {visibleItems.map((media, index) => {
                        const showMore = index === 3 && extraCount > 0;
                        return (
                            <Pressable
                                key={`${media.url}-${index}`}
                                style={styles.mediaGridTile}
                                onPress={() => handleMediaPress(index, showMore)}
                            >
                                <Animated.Image
                                    source={{ uri: media.url }}
                                    style={styles.mediaGridImage}
                                />
                                {media.type === 'video' && !showMore && (
                                    <View style={styles.mediaTilePlayOverlay}>
                                        <MaterialIcons name="play-circle-filled" size={34} color="rgba(255,255,255,0.92)" />
                                    </View>
                                )}
                                {showMore && (
                                    <View style={styles.mediaMoreOverlay}>
                                        <Text style={styles.mediaMoreText}>{`+${extraCount}`}</Text>
                                    </View>
                                )}
                            </Pressable>
                        );
                    })}
                </View>
            </View>
        );
    };

    if (isClone) {
        return (
            <Animated.View style={[bubbleStyle, { alignItems: isMe ? 'flex-end' : 'flex-start' }]}>
                <View style={[
                    styles.bubbleContainer,
                    isMe ? styles.bubbleContainerMe : styles.bubbleContainerThem,
                    quotedMessage && styles.bubbleContainerWithQuote,
                    isMediaOnly && styles.bubbleContainerMediaOnly,
                    { maxWidth: '100%' }
                ]}>
                    <View style={[styles.messageContent, isMediaOnly && styles.messageContentMediaOnly]}>
                        {quotedMessage && (
                            <View style={[styles.quotedContainer, isMe ? styles.quotedMe : styles.quotedThem]}>
                                <View style={styles.quoteContent}>
                                    <Text numberOfLines={1} style={[styles.quoteSender, { color: isMe ? '#fff' : activeTheme.primary }]}>
                                        {quotedMessage.sender === 'me' ? 'You' : contactName}
                                    </Text>
                                    <Text style={[styles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                        {quotedMessage.text}
                                    </Text>
                                </View>
                            </View>
                        )}

                        {/* Media */}
                        {renderMediaContent()}

                        {/* Caption */}
                        {msg.media?.caption && (
                            <Text style={[styles.captionText, isMe ? { color: 'rgba(255,255,255,0.8)' } : { color: 'rgba(255,255,255,0.6)' }]}>
                                {msg.media.caption}
                            </Text>
                        )}

                        {/* Text */}
                        {hasText && (
                            <Text style={[styles.messageText, isMe && styles.messageTextMe]}>
                                {msg.text}
                            </Text>
                        )}
                    </View>
                </View>

                {/* Reactions */}
                {msg.reactions && msg.reactions.length > 0 && (
                    <View style={[styles.reactionsRow, isMe ? styles.reactionsRight : styles.reactionsLeft]}>
                        {msg.reactions.map((r: string, idx: number) => (
                            <BlurView key={idx} intensity={40} tint="dark" style={styles.reactionPill}>
                                <Text style={styles.reactionEmoji}>{r}</Text>
                            </BlurView>
                        ))}
                    </View>
                )}
            </Animated.View>
        );
    }

    return (
        <View style={[
            styles.messageWrapper,
            isMe && styles.messageWrapperMe,
            msg.reactions && msg.reactions.length > 0 && styles.messageWrapperWithReactions
        ]}>
            <View style={styles.replyIconContainer}>
                <Animated.View style={[styles.replyIcon, iconStyle]}>
                    <MaterialIcons name="reply" size={24} color={activeTheme.primary} />
                </Animated.View>
            </View>

            <GestureDetector gesture={composedGestures}>
                <Animated.View style={[bubbleStyle, { alignItems: isMe ? 'flex-end' : 'flex-start' }]}>
                    <View ref={bubbleRef} style={[
                        styles.bubbleContainer,
                        isMe ? styles.bubbleContainerMe : styles.bubbleContainerThem,
                        quotedMessage && styles.bubbleContainerWithQuote,
                        isMediaOnly && styles.bubbleContainerMediaOnly,
                    ]}>
                        <View style={[styles.messageContent, isMediaOnly && styles.messageContentMediaOnly]}>
                            {quotedMessage && (
                                <Pressable style={[styles.quotedContainer, isMe ? styles.quotedMe : styles.quotedThem]}>
                                    <View style={styles.quoteContent}>
                                        <Text numberOfLines={1} style={[styles.quoteSender, { color: isMe ? '#fff' : activeTheme.primary }]}>
                                            {quotedMessage.sender === 'me' ? 'You' : contactName}
                                        </Text>
                                        <Text style={[styles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                            {quotedMessage.text}
                                        </Text>
                                    </View>
                                </Pressable>
                            )}

                            {renderMediaContent()}

                            {msg.media?.caption && (
                                <Text style={[styles.captionText, isMe ? { color: 'rgba(255,255,255,0.8)' } : { color: 'rgba(255,255,255,0.6)' }]}>
                                    {msg.media.caption}
                                </Text>
                            )}

                            {hasText && (
                                <Text style={[styles.messageText, isMe && styles.messageTextMe]}>{msg.text}</Text>
                            )}
                        </View>
                    </View>

                    {/* Timestamp outside the bubble */}
                    <View style={[styles.messageFooter, isMe ? styles.messageFooterMe : styles.messageFooterThem]}>
                        <Text style={styles.timestamp}>{formatTime(msg.timestamp)}</Text>
                        {isMe && (
                            <MaterialIcons
                                name={msg.status === 'read' ? 'done-all' : 'done'}
                                size={10}
                                color={msg.status === 'read' ? '#34B7F1' : 'rgba(255,255,255,0.3)'}
                            />
                        )}
                    </View>

                    {msg.reactions && msg.reactions.length > 0 && (
                        <View style={[styles.reactionsRow, isMe ? styles.reactionsRight : styles.reactionsLeft]}>
                            {msg.reactions.map((r: string, idx: number) => (
                                <BlurView key={idx} intensity={40} tint="dark" style={styles.reactionPill}>
                                    <Text style={styles.reactionEmoji}>{r}</Text>
                                </BlurView>
                            ))}
                        </View>
                    )}
                </Animated.View>
            </GestureDetector>
        </View>
    );
}, (prevProps: any, nextProps: any) => {
  // Custom comparison: only re-render if these specific props change
  if (prevProps.msg?.id !== nextProps.msg?.id) return false;
  if (prevProps.msg?.text !== nextProps.msg?.text) return false;
  if (prevProps.msg?.status !== nextProps.msg?.status) return false;
  if (prevProps.isSelected !== nextProps.isSelected) return false;
  if (prevProps.isClone !== nextProps.isClone) return false;
  if (prevProps.quotedMessage?.id !== nextProps.quotedMessage?.id) return false;
  return true; // Props are equal - don't re-render
});

// Sophisticated Context Menu Overlay
const MessageContextMenu = ({ visible, msg, layout, onClose, onReaction, onAction }: any) => {
    const emojis = ['❤️', '👍', '👎', '🔥', '🥰', '👏', '😁'];
    const progress = useSharedValue(0);

    useEffect(() => {
        if (visible && layout) {
            progress.value = 0;
            progress.value = withSpring(1, {
                damping: 20,
                stiffness: 250,
                mass: 1,
            });
        }
    }, [visible, layout, progress]);

    const handleClose = () => {
        progress.value = withTiming(0, {
            duration: 150,
            easing: Easing.out(Easing.quad)
        }, (finished) => {
            if (finished && onClose) {
                runOnJS(onClose)();
            }
        });
    };

    const containerStyle = useAnimatedStyle(() => {
        return {
            opacity: progress.value,
            transform: [
                { scale: interpolate(progress.value, [0, 1], [0.95, 1]) }
            ]
        };
    });

    const backdropStyle = useAnimatedStyle(() => {
        return {
            opacity: progress.value
        };
    });

    if (!visible || !msg || !layout) return null;

    const isMe = msg.sender === 'me';

    // Dimensions and safe areas
    // Dimensions and spacing gaps
    const EMENU_GAP = 12; // Air gap between emoji bar and top of message
    const AMENU_GAP = 12; // Air gap between action menu and bottom of message
    const emojiBarHeight = 54;
    const actionMenuHeight = 260;
    
    const safeTop = 110; // Header buffer
    const safeBottom = SCREEN_HEIGHT - 40; // Bottom screen buffer

    let topAdjust = 0;

    // Shift whole cluster down if emoji bar is cut off at the top edge
    if (layout.y - emojiBarHeight - EMENU_GAP < safeTop) {
        topAdjust = safeTop - (layout.y - emojiBarHeight - EMENU_GAP);
    }
    // Shift whole cluster up if action menu is cut off at the bottom edge
    else if (layout.y + layout.height + AMENU_GAP + actionMenuHeight > safeBottom) {
        topAdjust = safeBottom - (layout.y + layout.height + AMENU_GAP + actionMenuHeight);
    }

    const adjustedY = layout.y + topAdjust;
    const emojiBarY = adjustedY - emojiBarHeight - EMENU_GAP;
    const actionMenuY = adjustedY + layout.height + AMENU_GAP;

    return (
        <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
            <View style={StyleSheet.absoluteFill}>
                {/* Backdrop Blur */}
                <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
                    <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
                    <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                </Animated.View>

                {/* Animated Menu Elements */}
                <Animated.View style={[StyleSheet.absoluteFill, containerStyle]} pointerEvents="box-none">
                    
                    {/* Emoji Reaction Bar */}
                    <View style={[{
                        position: 'absolute',
                        top: emojiBarY,
                        [isMe ? 'right' : 'left']: isMe ? SCREEN_WIDTH - layout.x - layout.width : layout.x,
                        width: 270,
                        height: 54,
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 10 },
                        shadowOpacity: 0.5,
                        shadowRadius: 15,
                        elevation: 10,
                    }]}>
                        <BlurView intensity={80} tint="dark" style={[styles.contextEmojiTail, { [isMe ? 'right' : 'left']: 20 }]} />
                        
                        <BlurView intensity={80} tint="dark" style={{ flex: 1, borderRadius: 27, overflow: 'hidden', backgroundColor: 'rgba(30,30,30,0.5)' }}>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 16, gap: 14 }}>
                                {emojis.map(e => (
                                    <Pressable key={e} onPress={() => { onReaction(e); handleClose(); }} style={{ paddingVertical: 10 }}>
                                        <Text style={{ fontSize: 26 }}>{e}</Text>
                                    </Pressable>
                                ))}
                                <Pressable style={{ backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 16, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: 4 }} onPress={() => { /* Open wide picker later */ }}>
                                    <MaterialIcons name="add" size={20} color="#fff" />
                                </Pressable>
                            </ScrollView>
                        </BlurView>
                    </View>

                    {/* Exact Cloned Message */}
                    <View style={{
                        position: 'absolute',
                        top: adjustedY,
                        left: layout.x,
                        width: layout.width,
                        height: layout.height,
                    }}>
                        <MessageBubble msg={msg} isClone />
                    </View>

                    {/* Action Menu (Reply, Pin, Forward...) */}
                    <View style={[{
                        position: 'absolute',
                        top: actionMenuY,
                        [isMe ? 'right' : 'left']: isMe ? SCREEN_WIDTH - layout.x - layout.width : layout.x,
                        width: 200,
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 10 },
                        shadowOpacity: 0.5,
                        shadowRadius: 15,
                        elevation: 10,
                    }]}>
                        <BlurView intensity={80} tint="dark" style={{ borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', backgroundColor: 'rgba(30,30,30,0.5)' }}>
                            <Pressable style={styles.contextActionBtn} onPress={() => { onAction('reply'); handleClose(); }}>
                                <MaterialIcons name="reply" size={20} color="#fff" />
                                <Text style={styles.contextActionText}>Reply</Text>
                            </Pressable>
                            <Pressable style={styles.contextActionBtn} onPress={() => { onAction('pin'); handleClose(); }}>
                                <MaterialIcons name="push-pin" size={20} color="#fff" />
                                <Text style={styles.contextActionText}>Pin</Text>
                            </Pressable>
                            <Pressable style={styles.contextActionBtn} onPress={() => { /* Select */ handleClose(); }}>
                                <MaterialIcons name="check-circle-outline" size={20} color="#fff" />
                                <Text style={styles.contextActionText}>Select</Text>
                            </Pressable>
                            <Pressable style={[styles.contextActionBtn, { borderBottomWidth: 0 }]} onPress={() => { onAction('delete'); handleClose(); }}>
                                <MaterialIcons name="delete-outline" size={20} color="#ff4444" />
                                <Text style={[styles.contextActionText, { color: '#ff4444' }]}>Delete</Text>
                            </Pressable>
                        </BlurView>
                    </View>

                </Animated.View>
            </View>
        </Modal>
    );
};

interface SingleChatScreenProps {
    user?: Contact;
    onBack?: () => void;
    onBackStart?: () => void;
    sourceY?: number;
}

MessageBubble.displayName = 'MessageBubble';

export default function SingleChatScreen({ user: propsUser, onBack, onBackStart, sourceY: propsSourceY }: SingleChatScreenProps) {
    const { id: paramsId, sourceY: paramsSourceY } = useLocalSearchParams();

    // Support both direct routing (params) and inline rendering (props)
    const id = propsUser?.id || (Array.isArray(paramsId) ? paramsId[0] : paramsId);
    const sourceY = propsSourceY ?? (paramsSourceY ? Number(Array.isArray(paramsSourceY) ? paramsSourceY[0] : paramsSourceY) : undefined);
    
    const router = useRouter();
    const { contacts, messages, sendChatMessage, startCall, activeCall, addReaction, deleteMessage, musicState, currentUser, activeTheme, sendTyping, typingUsers } = useApp();
    const [inputText, setInputText] = useState('');
    const [showCallModal, setShowCallModal] = useState(false);
    const [isReady, setIsReady] = useState(false);

    // Defer heavy rendering until transition completes
    useEffect(() => {
        const timeout = setTimeout(() => {
            setIsReady(true);
        }, 400); // Slightly longer for stability
        
        const task = InteractionManager.runAfterInteractions(() => {
            setIsReady(true);
        });
        
        return () => {
             task.cancel();
             clearTimeout(timeout);
        };
    }, []);

    const [callOptionsPosition, setCallOptionsPosition] = useState({ x: 0, y: 0 });
    const [isExpanded, setIsExpanded] = useState(false);

    // Morph Animation — iOS-style smooth bezier, no spring jitter
    const HEADER_TOP = 50;
    const ITEM_HEIGHT = 72;
    const ITEM_MARGIN = 16;
    const ITEM_RADIUS = 36;
    
    const chatBodyOpacity = useSharedValue(sourceY !== undefined ? 0 : 1);
    const keyboardOffset = useSharedValue(0);

    const chatBodyAnimStyle = useAnimatedStyle(() => ({
        opacity: chatBodyOpacity.value,
    }));

    const inputAreaAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -keyboardOffset.value }],
    }));

    const messagesContainerAnimatedStyle = useAnimatedStyle(() => ({
        paddingBottom: keyboardOffset.value,
    }));

    // Animate IN with staggered delay - Using useEffect for more reliable animation start
    useEffect(() => {
        if (sourceY !== undefined) {
            // 1. Full shape morph starts instantly
            // 2. Chat body text/input fades in midway through the morph
            chatBodyOpacity.value = withDelay(MORPH_IN_DURATION * 0.3, withTiming(1, {
                duration: MORPH_IN_DURATION * 0.8,
                easing: Easing.out(Easing.quad)
            }));
        }
    }, [sourceY]);

    useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const onShow = (event: KeyboardEvent) => {
            const rawHeight = event.endCoordinates?.height || 0;
            const height = IS_IOS
                ? Math.max(0, rawHeight - IOS_KEYBOARD_SAFE_ADJUST)
                : rawHeight;
            const duration = event.duration || 250;
            keyboardOffset.value = withTiming(height, { duration });
        };

        const onHide = () => {
            keyboardOffset.value = withTiming(0, { duration: 200 });
        };

        const showSub = Keyboard.addListener(showEvent, onShow);
        const hideSub = Keyboard.addListener(hideEvent, onHide);

        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, [keyboardOffset]);

    const navigation = useNavigation();

    // Cleanup when back morph finishes
    const finishBack = useCallback(() => {
        if (onBack) {
            onBack();
        } else if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            console.warn('Navigation: Cannot go back, history stack is empty.');
        }
    }, [onBack, navigation]);

    // Animate OUT — butter smooth unified morph back to pill
        const handleBack = useCallback(() => {
        if (onBackStart) onBackStart();

        // Content fades out quickly for smoother perceived transition
        chatBodyOpacity.value = withTiming(0, {
            duration: MORPH_OUT_DURATION * 0.35,
            easing: Easing.out(Easing.quad),
        });

        // Use native navigation goBack to trigger shared transition OUT
        if (onBack) {
            runOnJS(onBack)();
        } else if (navigation.canGoBack()) {
            runOnJS(navigation.goBack)();
        } else {
            console.warn('Navigation: Cannot go back');
        }
    }, [onBackStart, onBack, navigation, chatBodyOpacity]);

    // Animation Values
    const plusRotation = useSharedValue(0);
    const optionsHeight = useSharedValue(0);
    const optionsOpacity = useSharedValue(0);
    const modalAnim = useRef(new RNAnimated.Value(0)).current;

    // Refs
    const flatListRef = useRef<FlatList>(null);
    const hasScrolledInitial = useRef(false);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [replyingTo, setReplyingTo] = useState<any>(null);
    const [selectedContextMessage, setSelectedContextMessage] = useState<{ msg: any, layout: any } | null>(null);
    const [showMusicPlayer, setShowMusicPlayer] = useState(false);

    // Derived State
    const contact = contacts.find(c => c.id === id);
    const chatMessages = messages[id || ''] || [];
    const isTyping = contact ? typingUsers.includes(contact.id) : false;

    // Toggle Options Menu
    const toggleOptions = () => {
        if (isExpanded) {
            // Close
            plusRotation.value = withSpring(0);
            optionsHeight.value = withTiming(0);
            optionsOpacity.value = withTiming(0);
            setIsExpanded(false);
        } else {
            // Open
            plusRotation.value = withSpring(45); // Rotate to X
            optionsHeight.value = withTiming(90);
            optionsOpacity.value = withTiming(1);
            setIsExpanded(true);
        }
    };

    // Close options when typing
    const handleFocus = () => {
        if (isExpanded) toggleOptions();
    };

    const animatedPlusStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${plusRotation.value}deg` }]
    }));

    const animatedOptionsStyle = useAnimatedStyle(() => ({
        height: optionsHeight.value,
        opacity: optionsOpacity.value,
        marginBottom: isExpanded ? 20 : 0
    }));

    const callButtonRef = useRef<View>(null);

    // Media picker state
    const [showMediaPicker, setShowMediaPicker] = useState(false);
    const [mediaPreview, setMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' } | null>(null);
    const [mediaCollection, setMediaCollection] = useState<{ messageId: string; items: ChatMediaItem[]; startIndex: number } | null>(null);
    const [mediaViewer, setMediaViewer] = useState<{ messageId: string; items: ChatMediaItem[]; index: number } | null>(null);
    const [selectedMediaLayout, setSelectedMediaLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [mediaItemReactions, setMediaItemReactions] = useState<Record<string, string[]>>({});
    const [isUploading, setIsUploading] = useState(false);

    // Recording State
    const recordingRef = useRef<Audio.Recording | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const [isRecordingCancelled, setIsRecordingCancelled] = useState(false);
    const recordingTranslateX = useSharedValue(0);

    const startRecording = async () => {
        try {
            const permission = await Audio.requestPermissionsAsync();
            if (permission.status !== 'granted') {
                Alert.alert('Permission required', 'Please enable microphone access to record voice notes.');
                return;
            }

            await Audio.setAudioModeAsync({
                allowsRecordingIOS: true,
                playsInSilentModeIOS: true,
            });

            const { recording } = await Audio.Recording.createAsync(
                Audio.RecordingOptionsPresets.HIGH_QUALITY
            );
            recordingRef.current = recording;
            setIsRecording(true);
            setIsRecordingCancelled(false);
            setRecordingDuration(0);
            recordingTranslateX.value = 0;

            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

            recordingTimerRef.current = setInterval(() => {
                setRecordingDuration(prev => prev + 1);
            }, 1000) as unknown as NodeJS.Timeout;
        } catch (err) {
            console.error('Failed to start recording', err);
        }
    };

    const stopRecording = async (shouldSend: boolean = true) => {
        if (!recordingRef.current) return;

        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);

        try {
            await recordingRef.current.stopAndUnloadAsync();
            const uri = recordingRef.current.getURI();
            recordingRef.current = null;

            if (shouldSend && uri && !isRecordingCancelled) {
                handleSendAudio(uri);
            }
        } catch (err) {
            console.error('Failed to stop recording', err);
        } finally {
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
            });
        }
    };

    const handleSendAudio = async (uri: string) => {
        if (!id) return;
        setIsUploading(true);
        try {
            const publicUrl = await storageService.uploadImage(
                uri,
                'chat-media',
                currentUser?.id || ''
            );
            if (!publicUrl) throw new Error('Upload failed');

            const media: Message['media'] = {
                type: 'audio',
                url: publicUrl,
            };

            sendChatMessage(id, '', media);
        } catch (error: any) {
            Alert.alert('Upload Failed', error.message || 'Please try again.');
        } finally {
            setIsUploading(false);
        }
    };



    const recordingPulsate = useSharedValue(1);

    useEffect(() => {
        if (isRecording) {
            recordingPulsate.value = withTiming(1.2, { duration: 500, easing: Easing.inOut(Easing.ease) }, (finished) => {
                if (finished) {
                    recordingPulsate.value = withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) });
                }
            });
            const interval = setInterval(() => {
                recordingPulsate.value = withTiming(1.2, { duration: 500, easing: Easing.inOut(Easing.ease) }, (finished) => {
                    if (finished) {
                        recordingPulsate.value = withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) });
                    }
                });
            }, 1000);
            return () => clearInterval(interval);
        } else {
            recordingPulsate.value = 1;
        }
    }, [isRecording]);

    const recordingPulseStyle = useAnimatedStyle(() => ({
        transform: [{ scale: recordingPulsate.value }],
        backgroundColor: interpolateColor(recordingPulsate.value, [1, 1.2], ['rgba(188, 0, 42, 0.4)', 'rgba(188, 0, 42, 0.8)']),
    }));

    const slideToCancelStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: recordingTranslateX.value }],
        opacity: interpolate(recordingTranslateX.value, [-100, 0], [0, 1], Extrapolation.CLAMP),
    }));

    const micGesture = Gesture.Pan()
        .activateAfterLongPress(200)
        .onStart(() => {
            runOnJS(startRecording)();
        })
        .onUpdate((event) => {
            recordingTranslateX.value = Math.min(0, event.translationX);
            if (event.translationX < -100 && !isRecordingCancelled) {
                runOnJS(setIsRecordingCancelled)(true);
                runOnJS(Haptics.notificationAsync)(Haptics.NotificationFeedbackType.Warning);
            } else if (event.translationX >= -100 && isRecordingCancelled) {
                runOnJS(setIsRecordingCancelled)(false);
            }
        })
        .onEnd(() => {
            if (isRecordingCancelled) {
                runOnJS(stopRecording)(false);
            } else {
                runOnJS(stopRecording)(true);
            }
        });



    // Instant scroll to latest message when new messages arrive (animated)
    const prevMsgCount = useRef(chatMessages.length);
    useEffect(() => {
        if (chatMessages.length > prevMsgCount.current) {
            setTimeout(() => {
                flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            }, 100);
        }
        prevMsgCount.current = chatMessages.length;
    }, [chatMessages.length]);

    // Handle content size change if needed (but inverted handles most cases)
    const handleContentSizeChange = useCallback(() => {
        // Naturally starts at index 0 (bottom) when inverted
    }, []);

    const openCallModal = () => {
        // Measure call button position
        callButtonRef.current?.measure((x, y, width, height, pageX, pageY) => {
            setCallOptionsPosition({ x: pageX - 80, y: pageY + height + 8 });
        });
        setShowCallModal(true);
        RNAnimated.spring(modalAnim, {
            toValue: 1,
            useNativeDriver: true,
            tension: 100,
            friction: 10,
        }).start();
    };

    const closeCallModal = () => {
        RNAnimated.timing(modalAnim, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
        }).start(() => setShowCallModal(false));
    };

    const handleCall = (type: 'audio' | 'video') => {
        closeCallModal();
        setTimeout(() => startCall(id!, type), 300);
    };

    const handleSend = () => {
        if (!inputText.trim() || !id) return;

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        sendTyping(false);

        const content = inputText.trim();
        setInputText('');

        const replyToId = replyingTo ? replyingTo.id : undefined;
        sendChatMessage(id, content, undefined, replyToId);

        setReplyingTo(null);
    };

    const handleReaction = (emoji: string) => {
        if (selectedContextMessage && id) {
            addReaction(id, selectedContextMessage.msg.id, emoji);
        }
    };

    const handleAction = (action: string) => {
        if (selectedContextMessage && id) {
            if (action === 'delete') {
                deleteMessage(id, selectedContextMessage.msg.id);
            } else if (action === 'reply') {
                setReplyingTo(selectedContextMessage.msg);
            } else if (action === 'pin') {
                // Future Implementation
            } else if (action === 'forward') {
                // Future Implementation
            }
        }
        setSelectedContextMessage(null);
    };

    const handleDoubleTap = (msgId: string) => {
        if (id) {
            addReaction(id, msgId, '❤️');
        }
    };

    const handleMediaTap = (payload: any) => {
        if (!payload?.mediaItems?.length) return;
        const nextViewer = {
            messageId: payload.messageId,
            items: payload.mediaItems,
            index: payload.index || 0,
        };
        if (payload.layout) {
            setSelectedMediaLayout(payload.layout);
        }
        if (payload.openGallery) {
            setMediaCollection({
                messageId: payload.messageId,
                items: payload.mediaItems,
                startIndex: payload.index || 0,
            });
            return;
        }
        setMediaViewer(nextViewer);
    };

    const addReactionToMedia = (messageId: string, mediaIndex: number, emoji: string) => {
        const key = `${messageId}:${mediaIndex}`;
        setMediaItemReactions(prev => ({
            ...prev,
            [key]: [...(prev[key] || []), emoji],
        }));
    };

    const handleReactAllMedia = (messageId: string, emoji: string) => {
        if (!id) return;
        addReaction(id, messageId, emoji);
    };

    const handleSaveCurrentMedia = async () => {
        if (!mediaViewer) return;
        const current = mediaViewer.items[mediaViewer.index];
        if (!current?.url) return;

        try {
            const permission = await MediaLibrary.requestPermissionsAsync();
            if (permission.status !== 'granted') {
                Alert.alert('Permission Required', 'Allow media library access to save files.');
                return;
            }

            let localUri = current.url;
            if (!current.url.startsWith('file://')) {
                const extension = current.type === 'video' ? '.mp4' : '.jpg';
                const target = `${FileSystem.cacheDirectory}soulsync_${Date.now()}${extension}`;
                const downloaded = await FileSystem.downloadAsync(current.url, target);
                localUri = downloaded.uri;
            }

            await MediaLibrary.saveToLibraryAsync(localUri);
            Alert.alert('Saved', 'Media saved to your gallery.');
        } catch (error) {
            Alert.alert('Save Failed', 'Could not save this media.');
        }
    };

    const renderMessage = useCallback(({ item }: { item: any }) => (
        <MessageBubble
            msg={item}
            contactName={contact?.name || 'Them'}
            isSelected={selectedContextMessage?.msg.id === item.id}
            onLongPress={(mid: string, layout: any) => setSelectedContextMessage({ msg: item, layout })}
            onReply={(m: any) => setReplyingTo(m)}
            onReaction={handleReaction}
            onDoubleTap={handleDoubleTap}
            onMediaTap={handleMediaTap}
            quotedMessage={item.replyTo ? chatMessages.find((m: any) => m.id === item.replyTo) : null}
        />
    ), [selectedContextMessage, chatMessages, contact?.name, handleMediaTap]);

    // Stable keyExtractor for FlatList - prevents inline function recreation
    const keyExtractor = useCallback((item: any) => item.id, []);

    // Media picker handlers
    const handleSelectCamera = async () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
        if (!permissionResult.granted) {
            Alert.alert('Permission Required', 'Camera access is needed to take photos.');
            return;
        }
        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.8,
            allowsEditing: false,
            videoMaxDuration: 120,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const type = asset.type === 'video' ? 'video' : 'image';
            setMediaPreview({ uri: asset.uri, type });
        }
    };

    const handleSelectGallery = async () => {
        if (isExpanded) toggleOptions();
        setShowMediaPicker(false);
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.8,
            allowsEditing: false,
            videoMaxDuration: 120,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const type = asset.type === 'video' ? 'video' : 'image';
            setMediaPreview({ uri: asset.uri, type });
        }
    };

    const handleSelectAudio = async () => {
        setShowMediaPicker(false);
        Alert.alert('Coming Soon', 'Audio file selection will be available soon.');
    };

    const handleSendMedia = async (caption?: string) => {
        if (!mediaPreview || !id) return;
        setIsUploading(true);
        try {
            const publicUrl = await storageService.uploadImage(
                mediaPreview.uri,
                'chat-media',
                currentUser?.id || ''
            );
            if (!publicUrl) throw new Error('Upload failed');

            const media: Message['media'] = {
                type: mediaPreview.type,
                url: publicUrl,
                caption: caption || undefined,
            };

            sendChatMessage(id, caption || '', media);
            setMediaPreview(null);
        } catch (error: any) {
            Alert.alert('Upload Failed', error.message || 'Please try again.');
        } finally {
            setIsUploading(false);
        }
    };

    if (!contact) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>Contact not found</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {/* Screen Background — always solid black so there's never a transparent flash */}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: -1 }]} />

            {/* Content Wrapper */}
            <View style={[StyleSheet.absoluteFill, { zIndex: 1 }]}>

                {/* Chat body — fades in AFTER the morph transition completes */}
                <Animated.View style={[StyleSheet.absoluteFill, chatBodyAnimStyle]}>

                {/* Chat content - Deferred Rendering for Performance */}
                {isReady && (
                    <View style={{ flex: 1 }}>
                        <Animated.View style={[{ flex: 1 }, messagesContainerAnimatedStyle]}>
                            {/* Messages - optimized with React.memo */}
                            <FlatList
                                ref={flatListRef}
                                data={[...chatMessages].reverse()}
                                inverted
                                keyExtractor={keyExtractor}
                                renderItem={renderMessage}
                                style={styles.messagesList}
                                contentContainerStyle={styles.messagesContent}
                                showsVerticalScrollIndicator={false}
                                onContentSizeChange={handleContentSizeChange}
                                // Performance Optimizations
                                initialNumToRender={15}
                                maxToRenderPerBatch={10}
                                windowSize={5}
                                removeClippedSubviews={Platform.OS === 'android'}
                                ListEmptyComponent={
                                    <View style={styles.emptyChat}>
                                        <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.1)" />
                                        <Text style={styles.emptyChatText}>No messages yet</Text>
                                        <Text style={styles.emptyChatHint}>Say hi to {contact.name}!</Text>
                                    </View>
                                }
                            />

                            {/* iOS-style Progressive Blur Effects */}
                            <ProgressiveBlur position="top" height={280} intensity={120} steps={28} />
                            <ProgressiveBlur position="bottom" height={200} intensity={120} steps={28} />

                            {/* Typing Indicator */}
                            {isTyping && (
                                <View style={styles.typingContainer}>
                                    <Text style={[styles.typingText, { color: activeTheme.primary }]}>typing...</Text>
                                </View>
                            )}
                        </Animated.View>

                        {/* Input Area */}
                        <Animated.View style={[styles.inputArea, inputAreaAnimatedStyle]}>
                        {/* Reply Preview */}
                        {replyingTo && (
                            <BlurView intensity={60} tint="dark" style={styles.replyPreview}>
                                <View style={styles.replyContent}>
                                    <View style={styles.quoteBar} />
                                    <View style={styles.replyTextContainer}>
                                        <Text style={[styles.replySender, { color: activeTheme.primary }]}>REPLYING TO</Text>
                                        <Text numberOfLines={1} style={styles.replyText}>{replyingTo.text}</Text>
                                    </View>
                                </View>
                                <Pressable onPress={() => setReplyingTo(null)}>
                                    <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                                </Pressable>
                            </BlurView>
                        )}
                        {/* Unified Pill Container */}
                        <View style={styles.unifiedPillContainer}>
                            <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} />
                            
                            {/* Expandable Options Menu - Now above inputWrapper to open upwards */}
                            <Animated.View style={[styles.optionsMenu, animatedOptionsStyle]}>
                                 <Pressable style={styles.optionItem} onPress={handleSelectGallery}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#3b82f6' }]}>
                                        <MaterialIcons name="image" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Gallery</Text>
                                 </Pressable>
                                 <Pressable style={styles.optionItem} onPress={handleSelectCamera}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#ef4444' }]}>
                                        <MaterialIcons name="camera-alt" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Camera</Text>
                                 </Pressable>
                                 <Pressable style={styles.optionItem}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#a855f7' }]}>
                                        <MaterialIcons name="location-pin" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Location</Text>
                                 </Pressable>
                                 <Pressable style={styles.optionItem}>
                                    <View style={[styles.optionIcon, { backgroundColor: '#10b981' }]}>
                                        <MaterialIcons name="person" size={24} color="white" />
                                    </View>
                                    <Text style={styles.optionText}>Contact</Text>
                                 </Pressable>
                            </Animated.View>

                            <View style={styles.inputWrapper}>
                                {/* + Button on left inside */}
                                <Pressable style={styles.attachButton} onPress={toggleOptions}>
                                    <Animated.View style={animatedPlusStyle}>
                                        <MaterialIcons name="add" size={20} color="rgba(255,255,255,0.7)" />
                                    </Animated.View>
                                </Pressable>

                                <TextInput
                                    style={styles.input}
                                    value={inputText}
                                    onChangeText={(text) => {
                                        setInputText(text);
                                        
                                        // Typing indicator logic
                                        sendTyping(true);
                                        
                                        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                                        typingTimeoutRef.current = setTimeout(() => {
                                            sendTyping(false);
                                        }, 2000) as unknown as NodeJS.Timeout;
                                    }}
                                    onFocus={handleFocus}
                                    placeholder="Sync fragment..."
                                    placeholderTextColor="rgba(255,255,255,0.3)"
                                    multiline
                                    maxLength={1000}
                                />

                                {/* Emoji button (optional, can remove if not needed) */}
                                <Pressable style={styles.emojiInputButton}>
                                    <MaterialIcons name="sentiment-satisfied" size={20} color="rgba(255,255,255,0.5)" />
                                </Pressable>

                                {/* Mic button on right inside */}
                                {inputText.trim() ? (
                                    <Pressable
                                        style={styles.sendButton}
                                        onPress={handleSend}
                                    >
                                        <MaterialIcons
                                            name="arrow-upward"
                                            size={18}
                                            color={activeTheme.primary}
                                        />
                                    </Pressable>
                                ) : (
                                    <GestureDetector gesture={micGesture}>
                                        <Animated.View style={[styles.sendButton, isRecording && recordingPulseStyle]}>
                                            <MaterialIcons
                                                name="mic"
                                                size={18}
                                                color={isRecording ? '#fff' : 'rgba(255,255,255,0.7)'}
                                            />
                                        </Animated.View>
                                    </GestureDetector>
                                )}
                            </View>

                            {/* Recording Overlay */}
                            {isRecording && (
                                <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, zIndex: 10 }]}>
                                    <Animated.View style={[styles.recordingIndicator, recordingPulseStyle]} />
                                    <Text style={styles.recordingTimer}>{formatDuration(recordingDuration)}</Text>
                                    
                                    <Animated.View style={[{ flex: 1, alignItems: 'center' }, slideToCancelStyle]}>
                                        <Text style={styles.slideToCancel}>
                                            <MaterialIcons name="chevron-left" size={16} color="rgba(255,255,255,0.5)" /> Slide to cancel
                                        </Text>
                                    </Animated.View>
                                </Animated.View>
                            )}


                        </View>
                        </Animated.View>
                    </View>
                )}
                </Animated.View>
            </View>

            {/* ─── Header & Morph Pill — OUTSIDE all opacity wrappers ─────────────────
                 These MUST be at the root level with opacity:1 from frame 0.
                 The shared transition engine snapshots them on mount — if they are
                 inside an opacity:0 view, the morph target is invisible → black flash.
            */}
            <View style={[StyleSheet.absoluteFill, { zIndex: 2 }]} pointerEvents="box-none">
                {/* The Morph Target: Solid pill background — NO CHILDREN, opacity always 1 */}
                <Animated.View
                    {...{ sharedTransitionTag: `chat-pill-${id}` } as any}
                    style={[styles.headerPill, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, backgroundColor: 'rgba(30, 30, 35, 0.4)', borderRadius: HEADER_PILL_RADIUS, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.06)', zIndex: 0 }]}
                />

                {/* Liquid-glass blur layer (exactly like bottom input pill) */}
                <View
                    pointerEvents="none"
                    style={[styles.headerGlass, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, borderRadius: HEADER_PILL_RADIUS, zIndex: 1 }]}
                >
                    <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} />
                </View>

                    {/* Original Header Content - Rendered exactly over the morph bounds as an absolute overlay */}
                    <View style={[styles.header, { position: 'absolute', top: HEADER_PILL_TOP, left: 16, right: 16, height: HEADER_PILL_HEIGHT, zIndex: 10 }]} pointerEvents="box-none">
                        <Pressable onPress={handleBack} style={styles.backButton}>
                            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                        </Pressable>

                        <Pressable style={styles.avatarWrapper} onPress={() => router.push(`/profile/${contact.id}` as any)}>
                            <Animated.Image
                                {...{ sharedTransitionTag: `chat-avatar-${id}` } as any}
                                source={{ uri: contact.avatar }}
                                style={styles.avatar}
                            />
                            {contact.status === 'online' && <View style={styles.onlineIndicator} />}
                        </Pressable>

                        <View style={styles.headerInfo}>
                            <View>
                                <Text style={styles.contactName}>{contact.name}</Text>
                            </View>
                            {musicState.currentSong ? (
                                <View style={styles.nowPlayingStatus}>
                                    <MaterialIcons name="audiotrack" size={12} color={activeTheme.primary} />
                                    <Text style={[styles.statusText, { color: activeTheme.primary }]} numberOfLines={1}>
                                        {sanitizeSongTitle(musicState.currentSong.name)}
                                    </Text>
                                </View>
                            ) : (
                                <Text style={[styles.statusText, { color: 'rgba(255,255,255,0.5)' }]}>
                                    {contact.status === 'online' ? 'ONLINE' : 'OFFLINE'}
                                </Text>
                            )}
                        </View>

                        <Pressable style={styles.headerButton} onPress={() => router.push('/music')}>
                            <MaterialIcons name="audiotrack" size={20} color={activeTheme.primary} />
                        </Pressable>

                        <View ref={callButtonRef} collapsable={false}>
                            <Pressable style={styles.headerButton} onPress={openCallModal}>
                                <MaterialIcons name="call" size={20} color={activeTheme.primary} />
                            </Pressable>
                        </View>
                    </View>
            </View>

            {/* Reaction Modal */}
            <MessageContextMenu
                visible={!!selectedContextMessage}
                msg={selectedContextMessage?.msg}
                layout={selectedContextMessage?.layout}
                onClose={() => setSelectedContextMessage(null)}
                onReaction={handleReaction}
                onAction={handleAction}
            />

            {/* Call Options Dropdown */}
            <Modal visible={showCallModal} transparent animationType="none" onRequestClose={closeCallModal}>
                <Pressable style={styles.modalOverlay} onPress={closeCallModal}>
                    <RNAnimated.View
                        style={[
                            styles.callDropdown,
                            {
                                top: callOptionsPosition.y,
                                right: 16,
                                opacity: modalAnim,
                                transform: [{
                                    scale: modalAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0.9, 1],
                                    })
                                }]
                            }
                        ]}
                    >
                        <BlurView intensity={100} tint="dark" style={styles.callDropdownBlur}>
                            <Pressable style={styles.callDropdownItem} onPress={() => handleCall('audio')}>
                                <View style={[styles.callDropdownIcon, { backgroundColor: 'rgba(34, 197, 94, 0.15)' }]}>
                                    <MaterialIcons name="call" size={20} color="#22c55e" />
                                </View>
                                <Text style={styles.callDropdownText}>Audio</Text>
                            </Pressable>
                            <View style={styles.callDropdownDivider} />
                            <Pressable style={styles.callDropdownItem} onPress={() => handleCall('video')}>
                                <View style={[styles.callDropdownIcon, { backgroundColor: 'rgba(244, 63, 94, 0.15)' }]}>
                                    <MaterialIcons name="videocam" size={20} color="#f43f5e" />
                                </View>
                                <Text style={styles.callDropdownText}>Video</Text>
                            </Pressable>
                        </BlurView>
                    </RNAnimated.View>
                </Pressable>
            </Modal>

            {/* Music Player Overlay */}
            <MusicPlayerOverlay
                isOpen={showMusicPlayer}
                onClose={() => setShowMusicPlayer(false)}
                contactName={contact.name}
            />

            {/* Media Picker Sheet */}
            <MediaPickerSheet
                visible={showMediaPicker}
                onClose={() => setShowMediaPicker(false)}
                onSelectCamera={handleSelectCamera}
                onSelectGallery={handleSelectGallery}
                onSelectAudio={handleSelectAudio}
                onSelectNote={() => {
                    setShowMediaPicker(false);
                    Alert.alert("SoulSync Notes", "Leave a note from the Home screen!");
                }}
            />

            {/* Media Preview Modal */}
            <MediaPreviewModal
                visible={!!mediaPreview}
                mediaUri={mediaPreview?.uri || ''}
                mediaType={mediaPreview?.type || 'image'}
                onClose={() => setMediaPreview(null)}
                onSend={handleSendMedia}
                isUploading={isUploading}
            />

            {/* Media Collection Modal */}
            <Modal
                visible={!!mediaCollection}
                transparent
                animationType="fade"
                onRequestClose={() => setMediaCollection(null)}
            >
                <View style={styles.mediaCollectionOverlay}>
                    <View style={styles.mediaCollectionHeader}>
                        <Text style={styles.mediaCollectionTitle}>Media</Text>
                        <Pressable onPress={() => setMediaCollection(null)} style={styles.mediaCollectionCloseBtn}>
                            <MaterialIcons name="close" size={22} color="#fff" />
                        </Pressable>
                    </View>

                    <FlatList
                        data={mediaCollection?.items || []}
                        keyExtractor={(item, index) => `${item.url}-${index}`}
                        numColumns={3}
                        contentContainerStyle={styles.mediaCollectionGrid}
                        renderItem={({ item, index }) => (
                            <Pressable
                                style={styles.mediaCollectionTile}
                                onPress={() => {
                                    if (!mediaCollection) return;
                                    setMediaCollection(null);
                                    setMediaViewer({
                                        messageId: mediaCollection.messageId,
                                        items: mediaCollection.items,
                                        index,
                                    });
                                }}
                            >
                                <Image source={{ uri: item.url }} style={styles.mediaCollectionImage} />
                                {item.type === 'video' && (
                                    <View style={styles.mediaCollectionVideoBadge}>
                                        <MaterialIcons name="play-arrow" size={18} color="#fff" />
                                    </View>
                                )}
                            </Pressable>
                        )}
                    />

                    {!!mediaCollection?.messageId && (
                        <View style={styles.mediaCollectionReactionBar}>
                            {['❤️', '🔥', '😂'].map(emoji => (
                                <Pressable
                                    key={emoji}
                                    style={styles.mediaCollectionReactionBtn}
                                    onPress={() => handleReactAllMedia(mediaCollection.messageId, emoji)}
                                >
                                    <Text style={styles.mediaCollectionReactionText}>{emoji}</Text>
                                </Pressable>
                            ))}
                        </View>
                    )}
                </View>
            </Modal>

            {/* Single Media Viewer (Old Removed) */}

            {/* Premium Media Viewer (Seamless Morph & Blur) */}
            <EnhancedMediaViewer
                visible={!!mediaViewer}
                media={mediaViewer ? mediaViewer.items[mediaViewer.index] as any : null}
                sourceLayout={selectedMediaLayout}
                userInfo={(() => {
                    if (!mediaViewer) return undefined;
                    const msg = chatMessages.find((m: any) => m.id === mediaViewer.messageId);
                    if (!msg) return { name: 'You', timestamp: 'Just now' };
                    
                    const isMe = msg.sender === 'me';
                    
                    // Robust timestamp parsing
                    let formattedTime = 'Just now';
                    if (msg.timestamp) {
                        try {
                            const date = new Date(msg.timestamp);
                            if (!isNaN(date.getTime())) {
                                formattedTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            }
                        } catch (e) {
                            console.error('Error parsing date:', e);
                        }
                    }

                    return {
                        name: isMe ? 'You' : (contact?.name || 'Contact'),
                        avatar: isMe ? currentUser?.avatar : contact?.avatar,
                        timestamp: formattedTime
                    };
                })()}
                onClose={() => {
                    setMediaViewer(null);
                    setSelectedMediaLayout(null);
                }}
                onSendComment={(comment) => {
                    if (id && comment.trim()) {
                        sendChatMessage(id, comment);
                    }
                }}
                onDownload={handleSaveCurrentMedia}
                onReply={() => {
                    if (mediaViewer) {
                        const msg = chatMessages.find((m: any) => m.id === mediaViewer.messageId);
                        if (msg) setReplyingTo(msg);
                        setMediaViewer(null);
                        setSelectedMediaLayout(null);
                    }
                }}
                onForward={() => {
                    Alert.alert('Coming Soon', 'Forwarding will be available soon.');
                }}
                onReaction={(emoji) => {
                    if (mediaViewer && id) {
                        addReaction(id, mediaViewer.messageId, emoji);
                    }
                }}
                onEdit={() => Alert.alert('Edit', 'Media editing will be available soon.')}
                onShare={() => Alert.alert('Share', 'External sharing will be available soon.')}
            />

        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    headerWrapper: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0, // Allow full screen bounds for the transition flight
        zIndex: 999, // Ensure it's above the ProgressiveBlur (zIndex 90) and Messages
        pointerEvents: 'box-none', // Let touches pass through the empty areas
    },
    headerPill: {
        height: HEADER_PILL_HEIGHT,
        borderRadius: HEADER_PILL_RADIUS,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)',
        backgroundColor: 'rgba(30, 30, 35, 0.4)',
        overflow: 'hidden', // Add hidden back ONLY because the parent acts as the morph now
    },
    headerGlass: {
        borderRadius: HEADER_PILL_RADIUS,
        overflow: 'hidden',
        // Slightly more transparent so the blur is visible even on dark backgrounds.
        backgroundColor: 'rgba(30, 30, 35, 0.22)',
    },
    header: {
        flex: 1,
        backgroundColor: 'transparent',
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    backButton: {
        padding: 4,
    },
    avatarWrapper: {
        position: 'relative',
        marginLeft: -4, 
    },
    avatar: {
        width: 42,
        height: 42,
        borderRadius: 21,
        borderWidth: 0, // No border in screenshot
    },
    onlineIndicator: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 14,
        height: 14,
        borderRadius: 7,
        backgroundColor: '#22c55e',
        borderWidth: 2,
        borderColor: '#151515', // Match header bg
    },
    headerInfo: {
        flex: 1,
        marginLeft: 8,
        justifyContent: 'center',
    },
    contactName: {
        color: '#ffffff',
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: 0.5,
        marginBottom: 2,
    },
    statusText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 8.5,
        fontWeight: '600',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
    },
    headerButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: '#252525', // Slightly lighter than header bg
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.05)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    messagesList: {
        flex: 1,
    },
    messagesContent: {
        paddingHorizontal: 16,
        paddingTop: 100, // Reduced from 170 to fix excessive bottom space (inverted list)
        paddingBottom: 110, // Reduced from 130
        flexGrow: 1,
    },
    messageWrapper: {
        width: '100%',
        marginBottom: 8,
        alignItems: 'flex-start',
    },
    messageWrapperWithReactions: {
        marginBottom: 22,
    },
    messageWrapperMe: {
        alignItems: 'flex-end',
    },
    replyIconContainer: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 50,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: -1,
    },
    replyIcon: {
        // Shared value handles this
    },
    bubbleContainer: {
        maxWidth: '82%',
        minWidth: 7,
        borderRadius: 20, 
        overflow: 'hidden',
        position: 'relative',
    },
    bubbleContainerWithQuote: {
        minWidth: '70%',
    },
    bubbleContainerMediaOnly: {
        borderRadius: 14,
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        borderBottomLeftRadius: 14,
        borderBottomRightRadius: 14,
        backgroundColor: 'transparent',
    },
    bubbleContainerMe: {
        backgroundColor: '#BC002A', // Deep crimson for sender
        borderBottomRightRadius: 4,
    },
    bubbleContainerThem: {
        backgroundColor: 'rgba(255, 255, 255, 0.12)', // Darker subtle gray for receiver
        borderTopLeftRadius: 4,
    },
    // glassBorder removed - we want solid cinematic bubbles, not glass
    messageContent: {
        paddingVertical: 6,
        paddingHorizontal: 16,
        zIndex: 2,
        overflow: 'hidden',
    },
    messageContentMediaOnly: {
        padding: 0,
        position: 'relative',
    },
    quotedContainer: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 10,
        padding: 10,
        backgroundColor: 'rgba(255,255,255,0.15)', // Lighter background for quote block inside crimson
        borderRadius: 10,
        alignSelf: 'stretch',
        borderLeftWidth: 3,
        borderLeftColor: 'rgba(255,255,255,0.85)',
    },
    quotedMe: {
        // Inherits from quotedContainer
    },
    quotedThem: {
        // Inherits from quotedContainer
    },
    quoteBar: {
        width: 3,
        borderRadius: 2,
    },
    quoteContent: {
        flex: 1,
        minWidth: 0,
    },
    quoteSender: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.5,
        marginBottom: 3,
        lineHeight: 14,
        flexShrink: 1,
    },
    quoteText: {
        fontSize: 13,
        lineHeight: 18,
        flexShrink: 1,
        flexWrap: 'wrap',
    },
    messageText: {
        color: '#FFFFFF', // Clean white for all text for maximum contrast against the deep solids
        fontSize: 16,
        lineHeight: 22,
        letterSpacing: 0.1,
    },
    messageTextMe: {
        color: '#FFFFFF', // Keep it white for sent messages too
    },
    mediaSingle: {
        width: Math.min(SCREEN_WIDTH * 0.56, 250),
        aspectRatio: 1,
        borderRadius: 0,
    },
    mediaSingleNoGap: {
        marginBottom: 0,
    },
    mediaSurface: {
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: 1,
    },
    mediaSurfaceMe: {
        borderColor: 'rgba(245, 0, 87, 0.58)',
    },
    mediaSurfaceThem: {
        borderColor: 'rgba(255,255,255,0.16)',
    },
    mediaGridSurface: {
        width: Math.min(SCREEN_WIDTH * 0.58, 252),
    },
    mediaGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
    },
    mediaGridNoGap: {
        marginBottom: 0,
    },
    mediaGridTile: {
        width: (Math.min(SCREEN_WIDTH * 0.58, 252) - 4) / 2,
        aspectRatio: 1,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    mediaGridImage: {
        width: '100%',
        height: '100%',
    },
    mediaTilePlayOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.3)',
        borderRadius: 12,
    },
    mediaMoreOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    mediaMoreText: {
        color: '#fff',
        fontSize: 28,
        fontWeight: '700',
    },
    audioWaveform: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 12,
        padding: 12,
        minWidth: 200,
    },
    audioDuration: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 13,
        fontWeight: '500',
        flex: 1,
    },
    captionText: {
        color: 'rgba(255,255,255,0.8)',
        fontSize: 13,
        lineHeight: 18,
        marginTop: 4,
        fontWeight: '500',
    },
    messageFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 4, // Tight spacing right under the bubble
    },
    messageFooterMe: {
        alignSelf: 'flex-end',
        marginRight: 4,
    },
    messageFooterThem: {
        alignSelf: 'flex-start',
        marginLeft: 4,
    },
    timestamp: {
        color: 'rgba(255,255,255,0.35)', // Faint color outside the bubble
        fontSize: 9, // Reduced from 11 for extreme subtlety
        fontWeight: '500', 
    },
    reactionsRow: {
        position: 'absolute',
        bottom: -16,
        flexDirection: 'row',
        gap: 6,
        zIndex: 10,
    },
    reactionsRight: {
        right: 16,
    },
    reactionsLeft: {
        left: 16,
    },
    reactionPill: {
        borderRadius: 14,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
        backgroundColor: 'rgba(0,0,0,0.7)',
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 3,
    },
    reactionEmoji: {
        fontSize: 14,
    },
    emptyChat: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 100,
    },
    emptyChatText: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 16,
        fontWeight: '600',
        marginTop: 16,
    },
    emptyChatHint: {
        color: 'rgba(255,255,255,0.2)',
        fontSize: 13,
        marginTop: 4,
    },
    typingContainer: {
        paddingHorizontal: 20,
        paddingBottom: 10,
    },
    typingText: {
        fontSize: 8,
        fontWeight: '900',
        color: '#f43f5e', // Keeping default for now, or dynamic? Let's verify if user wants ALL pinks changed.
        letterSpacing: 4,
    },
    replyPreview: {
        marginBottom: 8,
        borderRadius: 16,
        padding: 12,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        overflow: 'hidden',
    },
    replyContent: {
        flexDirection: 'row',
        gap: 10,
        flex: 1,
    },
    replyTextContainer: {
        flex: 1,
    },
    replySender: {
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 2,
    },
    replyText: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.5)',
    },
    inputArea: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Platform.OS === 'ios' ? 24 : 16,
        backgroundColor: 'transparent',
        zIndex: 60,
    },
    unifiedPillContainer: {
        backgroundColor: 'rgba(30, 30, 35, 0.4)',
        borderRadius: 25,
        overflow: 'hidden',
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 8,
        minHeight: 40,
        maxHeight: 100,
        gap: 4,
    },
    attachButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.05)',
        flexShrink: 0,
    },
    input: {
        flex: 1,
        color: '#ffffff',
        fontSize: 14,
        paddingVertical: 0,
        paddingHorizontal: 8,
        fontWeight: '300',
    },
    emojiInputButton: {
        padding: 4,
        flexShrink: 0,
    },
    sendButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.05)',
        flexShrink: 0,
    },
    sendButtonActive: {
        backgroundColor: 'rgba(245, 0, 87, 0.1)',
        borderColor: 'rgba(245, 0, 87, 0.3)',
    },
    errorText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
    headerScrollBlur: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 140, // Height to cover header and status bar
        zIndex: 90,
    },
    bottomScrollBlur: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 140, // Height to cover input area's float zone (reduced from 180)
        zIndex: 50,
    },
    // Context Menu Styles
    contextEmojiBar: {
        flexDirection: 'row',
        backgroundColor: '#2a2a2a',
        borderRadius: 30,
        paddingHorizontal: 12,
        paddingVertical: 10,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.5,
        shadowRadius: 15,
        elevation: 10,
        gap: 8,
    },
    contextEmojiBtn: {
        paddingHorizontal: 4,
    },
    contextEmojiTail: {
        position: 'absolute',
        bottom: -5,
        width: 13,
        height: 13,
        backgroundColor: 'rgba(30,30,30,0.5)',
        overflow: 'hidden',
        borderLeftWidth: 1,
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        transform: [{ rotate: '45deg' }],
    },
    contextActionMenu: {
        backgroundColor: '#1e1e1e',
        borderRadius: 18,
        width: 200,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.5,
        shadowRadius: 15,
        elevation: 10,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    contextActionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.03)',
        gap: 14,
    },
    contextActionText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '500',
    },
    // Call Options Modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    callDropdown: {
        position: 'absolute',
        width: 140,
        borderRadius: 16,
        overflow: 'hidden',
    },
    callDropdownBlur: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        overflow: 'hidden',
    },
    callDropdownItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
    },
    callDropdownIcon: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    callDropdownText: {
        color: '#ffffff',
        fontSize: 14,
        fontWeight: '600',
    },
    callDropdownDivider: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.08)',
        marginHorizontal: 16,
    },
    mediaCollectionOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.95)',
        paddingTop: 56,
    },
    mediaCollectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 14,
    },
    mediaCollectionTitle: {
        color: '#fff',
        fontSize: 18,
        fontWeight: '700',
    },
    mediaCollectionCloseBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    mediaCollectionGrid: {
        paddingHorizontal: 10,
        paddingBottom: 20,
    },
    mediaCollectionTile: {
        width: (SCREEN_WIDTH - 20) / 3,
        aspectRatio: 1,
        padding: 2,
    },
    mediaCollectionImage: {
        width: '100%',
        height: '100%',
        borderRadius: 6,
    },
    mediaCollectionVideoBadge: {
        position: 'absolute',
        bottom: 8,
        right: 8,
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.55)',
    },
    mediaCollectionReactionBar: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 12,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
    },
    mediaCollectionReactionBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    mediaCollectionReactionText: {
        fontSize: 20,
    },
    mediaViewerContainer: {
        flex: 1,
        backgroundColor: '#000',
        justifyContent: 'center',
    },
    mediaViewerCloseBtn: {
        position: 'absolute',
        top: 50,
        left: 16,
        zIndex: 3,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    mediaViewerSaveBtn: {
        position: 'absolute',
        top: 50,
        right: 16,
        zIndex: 3,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    mediaViewerMedia: {
        width: '100%',
        height: '100%',
    },
    mediaViewerBottom: {
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 28,
    },
    mediaViewerReactionsRow: {
        flexDirection: 'row',
        gap: 10,
    },
    mediaViewerReactionBtn: {
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.14)',
    },
    mediaViewerReactionText: {
        fontSize: 20,
    },
    mediaViewerReactionList: {
        marginTop: 8,
        color: 'rgba(255,255,255,0.85)',
        fontSize: 14,
    },
    nowPlayingStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    optionsMenu: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-around',
        overflow: 'hidden',
        // Removed margins/padding/border radius as it's now inside the unified pill
    },
    optionItem: {
        alignItems: 'center',
        margin: 10,
        width: 60,
    },
    optionIcon: {
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 3,
        elevation: 4,
    },
    optionText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 11,
        fontWeight: '500',
    },
    recordingIndicator: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#BC002A',
        marginRight: 8,
    },
    recordingTimer: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
        width: 45,
    },
    slideToCancel: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 14,
    },
    voiceNoteContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 8,
        minWidth: 200,
        gap: 12,
    },
    vnPlayButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    vnProgressWrapper: {
        flex: 1,
        height: 4,
        position: 'relative',
        justifyContent: 'center',
    },
    vnProgressBackground: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: 4,
        borderRadius: 2,
    },
    vnProgressBar: {
        height: 4,
        borderRadius: 2,
        zIndex: 1,
    },
    vnDuration: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 12,
        width: 35,
        textAlign: 'right',
    },
});
