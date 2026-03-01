import React, { useRef, useCallback, useMemo } from 'react';
import { View, Text, Pressable, Alert, Platform, Image } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withSpring, 
    runOnJS 
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useApp } from '../../context/AppContext';
import { Message } from '../../types';
import { ChatStyles } from './ChatStyles';
import { getMessageMediaItems } from '../../utils/chatUtils';
import VoiceNotePlayer from './VoiceNotePlayer';

interface MessageBubbleProps {
    msg: Message;
    contactName: string;
    onLongPress?: (id: string, layout: any) => void;
    onReply?: (m: Message) => void;
    isSelected?: boolean;
    onReaction?: (emoji: string) => void;
    quotedMessage?: Message | null;
    onDoubleTap?: (id: string) => void;
    onMediaTap?: (data: any) => void;
    isClone?: boolean;
    selectionMode?: boolean;
    isChecked?: boolean;
    onSelectToggle?: (id: string) => void;
}

const formatTime = (ts: string) => {
    if (!ts) return '';
    if (ts.includes('AM') || ts.includes('PM') || ts.includes(':')) {
        if (!ts.includes('T')) return ts; 
    }
    try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch(e) {
        return ts;
    }
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
  isClone,
  selectionMode,
  isChecked,
  onSelectToggle,
}: MessageBubbleProps) => {
    const { activeTheme } = useApp();
    const [aspectRatio, setAspectRatio] = React.useState<number | null>(null);
    const translateX = useSharedValue(0);
    const isMe = msg.sender === 'me';
    const bubbleRef = useRef<View>(null);

    const mediaItems = useMemo(() => getMessageMediaItems(msg), [msg]);
    const hasText = !!msg.text;
    const hasCaption = !!msg.media?.caption;
    const isMediaOnly = mediaItems.length > 0 && !hasText && !hasCaption && mediaItems[0].type !== 'audio';

    const doubleTapGesture = Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(250)
        .onEnd(() => {
            if (onDoubleTap) runOnJS(onDoubleTap)(msg.id);
        });

    const measureAndShowMenu = useCallback((id: string) => {
        bubbleRef.current?.measure((x, y, width, height, pageX, pageY) => {
            if (onLongPress) {
                onLongPress(id, { x: pageX, y: pageY, width, height });
            }
        });
    }, [onLongPress]);

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
        .minDuration(400)
        .runOnJS(true)
        .onStart(() => {
            if (!selectionMode && !isClone) {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                measureAndShowMenu(msg.id);
            }
        });

    const panGesture = Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-10, 10])
        .onUpdate((e) => {
            if (!isMe && !selectionMode && !isClone) {
                translateX.value = Math.max(0, Math.min(e.translationX, 80));
            }
        })
        .onEnd(() => {
            if (translateX.value > 60 && onReply && !isClone) {
                runOnJS(Haptics.notificationAsync)(Haptics.NotificationFeedbackType.Success);
                runOnJS(onReply)(msg);
            }
            translateX.value = withSpring(0);
        });

    const singleTapGesture = Gesture.Tap()
        .onEnd(() => {
            if (selectionMode && onSelectToggle && !isClone) {
                runOnJS(onSelectToggle)(msg.id);
            }
        });

    const composedGestures = selectionMode 
        ? singleTapGesture 
        : Gesture.Simultaneous(panGesture, Gesture.Exclusive(doubleTapGesture, longPressGesture));

    const bubbleStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: translateX.value }]
    }));

    const iconStyle = useAnimatedStyle(() => ({
        opacity: translateX.value / 60,
        transform: [
            { translateX: translateX.value - 60 },
            { scale: Math.min(translateX.value / 60, 1) }
        ]
    }));
    
    // Fetch original aspect ratio for single media items
    React.useEffect(() => {
        if (mediaItems.length === 1 && mediaItems[0].type === 'image') {
            const url = mediaItems[0].url;
            Image.getSize(url, (width: number, height: number) => {
                let ratio = width / height;
                // Limit extreme aspect ratios for better UI
                if (ratio < 0.5) ratio = 0.5;
                if (ratio > 2) ratio = 2;
                setAspectRatio(ratio);
            }, (error) => {
                console.warn('Could not get image size:', error);
                setAspectRatio(1); // Fallback to 1:1
            });
        }
    }, [mediaItems]);

    const handleMediaPress = (index: number, openGallery = false) => {
        if (!isClone) measureAndShowMedia(index, openGallery);
    };

    const handleSelectToggle = () => {
        if (onSelectToggle) onSelectToggle(msg.id);
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
                        ChatStyles.mediaSurface,
                        isMe ? ChatStyles.mediaSurfaceMe : ChatStyles.mediaSurfaceThem,
                        !hasText && !hasCaption && ChatStyles.mediaSingleNoGap,
                        { aspectRatio: aspectRatio || 1 }
                    ]}
                >
                    <Animated.Image 
                        source={{ uri: media.url }} 
                        style={[
                            ChatStyles.mediaSingle,
                            { 
                                aspectRatio: aspectRatio || 1, 
                                height: undefined, // allow aspect ratio to control height
                                width: '100%',
                            }
                        ]} 
                        resizeMode="cover"
                    />
                    {media.type === 'video' && (
                        <View style={ChatStyles.mediaTilePlayOverlay}>
                            <MaterialIcons name="play-circle-filled" size={46} color="rgba(255,255,255,0.92)" />
                        </View>
                    )}
                </Pressable>
            );
        }

        const visibleItems = mediaItems.slice(0, 4);
        const extraCount = mediaItems.length - 4;
        return (
            <View style={[
                ChatStyles.mediaSurface,
                ChatStyles.mediaGridSurface,
                isMe ? ChatStyles.mediaSurfaceMe : ChatStyles.mediaSurfaceThem,
                !hasText && !hasCaption && ChatStyles.mediaGridNoGap
            ]}>
                <View style={ChatStyles.mediaGrid}>
                    {visibleItems.map((media, index) => {
                        const showMore = index === 3 && extraCount > 0;
                        return (
                            <Pressable
                                key={`${media.url}-${index}`}
                                style={ChatStyles.mediaGridTile}
                                onPress={() => handleMediaPress(index, showMore)}
                            >
                                <Animated.Image source={{ uri: media.url }} style={ChatStyles.mediaGridImage} />
                                {media.type === 'video' && !showMore && (
                                    <View style={ChatStyles.mediaTilePlayOverlay}>

                                        <MaterialIcons name="play-circle-filled" size={34} color="rgba(255,255,255,0.92)" />
                                    </View>
                                )}
                                {showMore && (
                                    <View style={ChatStyles.mediaMoreOverlay}>
                                        <Text style={ChatStyles.mediaMoreText}>{`+${extraCount}`}</Text>
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
                    ChatStyles.bubbleContainer,
                    isMe ? ChatStyles.bubbleContainerMe : ChatStyles.bubbleContainerThem,
                    quotedMessage && ChatStyles.bubbleContainerWithQuote,
                    isMediaOnly && ChatStyles.bubbleContainerMediaOnly,
                    { maxWidth: '100%' }
                ]}>
                    <View style={[ChatStyles.messageContent, isMediaOnly && ChatStyles.messageContentMediaOnly]}>
                        {quotedMessage && (
                            <View style={[ChatStyles.quotedContainer, isMe ? ChatStyles.quotedMe : ChatStyles.quotedThem]}>
                                <View style={ChatStyles.quoteContent}>
                                    <Text numberOfLines={1} style={[ChatStyles.quoteSender, { color: isMe ? '#fff' : activeTheme.primary }]}>
                                        {quotedMessage.sender === 'me' ? 'You' : contactName}
                                    </Text>
                                    <Text numberOfLines={1} style={[ChatStyles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                        {quotedMessage.text}
                                    </Text>
                                </View>
                            </View>
                        )}
                        {renderMediaContent()}
                        {msg.media?.caption && (
                            <Text style={[ChatStyles.captionText, isMe ? { color: 'rgba(255,255,255,0.8)' } : { color: 'rgba(255,255,255,0.6)' }]}>
                                {msg.media.caption}
                            </Text>
                        )}
                        {hasText && (
                            <Text style={[ChatStyles.messageText, isMe && ChatStyles.messageTextMe]}>
                                {msg.text}
                            </Text>
                        )}
                    </View>
                </View>
                {msg.reactions && msg.reactions.length > 0 && (
                    <View style={[ChatStyles.reactionsRow, isMe ? ChatStyles.reactionsRight : ChatStyles.reactionsLeft]}>
                        {msg.reactions.map((r, idx) => (
                            <BlurView key={idx} intensity={40} tint="dark" style={ChatStyles.reactionPill} experimentalBlurMethod="dimezisBlurView">
                                <Text style={ChatStyles.reactionEmoji}>{r}</Text>
                            </BlurView>
                        ))}
                    </View>
                )}
            </Animated.View>
        );
    }

    return (
        <View style={[
            ChatStyles.messageWrapper,
            isMe && ChatStyles.messageWrapperMe,
            msg.reactions && msg.reactions.length > 0 && ChatStyles.messageWrapperWithReactions
        ]}>
            {selectionMode && !isClone && (
                <View style={ChatStyles.selectionCheckboxContainer}>
                    <View style={[ChatStyles.selectionCheckbox, isChecked && { backgroundColor: activeTheme.primary, borderColor: activeTheme.primary }]}>
                        {isChecked && <MaterialIcons name="check" size={14} color="#fff" />}
                    </View>
                </View>
            )}

            <View style={ChatStyles.replyIconContainer}>
                <Animated.View style={[ChatStyles.replyIcon, iconStyle]}>
                    <MaterialIcons name="reply" size={24} color={activeTheme.primary} />
                </Animated.View>
            </View>

            <GestureDetector gesture={composedGestures}>
                <Animated.View style={[bubbleStyle, { alignItems: isMe ? 'flex-end' : 'flex-start' }, selectionMode && !isClone && !isMe && { paddingLeft: 34 }]}>
                    <View style={ChatStyles.bubbleReactionAnchor}>
                        <View ref={bubbleRef} style={[
                            ChatStyles.bubbleContainer,
                            isMe ? ChatStyles.bubbleContainerMe : ChatStyles.bubbleContainerThem,
                            quotedMessage && ChatStyles.bubbleContainerWithQuote,
                            isMediaOnly && ChatStyles.bubbleContainerMediaOnly,
                        ]}>
                            <View style={[ChatStyles.messageContent, isMediaOnly && ChatStyles.messageContentMediaOnly]}>
                                {quotedMessage && (
                                    <Pressable
                                        style={[ChatStyles.quotedContainer, isMe ? ChatStyles.quotedMe : ChatStyles.quotedThem]}
                                        onLongPress={() => {
                                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                            Alert.alert(
                                                quotedMessage.sender === 'me' ? 'You' : contactName,
                                                quotedMessage.text || '📎 Media',
                                            );
                                        }}
                                    >
                                        <View style={ChatStyles.quoteContent}>
                                            <Text numberOfLines={1} style={[ChatStyles.quoteSender, { color: isMe ? '#fff' : activeTheme.primary }]}>
                                                {quotedMessage.sender === 'me' ? 'You' : contactName}
                                            </Text>
                                            <Text numberOfLines={1} style={[ChatStyles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                                {quotedMessage.text}
                                            </Text>
                                        </View>
                                    </Pressable>
                                )}

                                {renderMediaContent()}
                                {msg.media?.caption && (
                                    <Text style={[ChatStyles.captionText, isMe ? { color: 'rgba(255,255,255,0.8)' } : { color: 'rgba(255,255,255,0.6)' }]}>
                                        {msg.media.caption}
                                    </Text>
                                )}
                                {hasText && (
                                    <Text style={[ChatStyles.messageText, isMe && ChatStyles.messageTextMe]}>{msg.text}</Text>
                                )}
                            </View>
                        </View>
                        {msg.reactions && msg.reactions.length > 0 && (
                            <View style={[ChatStyles.reactionsRow, isMe ? ChatStyles.reactionsRight : ChatStyles.reactionsLeft]}>
                                {msg.reactions.map((r, idx) => (
                                    <BlurView key={idx} intensity={40} tint="dark" style={ChatStyles.reactionPill} experimentalBlurMethod="dimezisBlurView">
                                        <Text style={ChatStyles.reactionEmoji}>{r}</Text>
                                    </BlurView>
                                ))}
                            </View>
                        )}
                    </View>

                    <View style={[
                        ChatStyles.messageFooter,
                        isMe ? ChatStyles.messageFooterMe : ChatStyles.messageFooterThem,
                        msg.reactions && msg.reactions.length > 0 && ChatStyles.messageFooterWithReaction
                    ]}>
                        <Text style={ChatStyles.timestamp}>{formatTime(msg.timestamp)}</Text>
                        {isMe && (
                            <MaterialIcons
                                name={
                                    msg.status === 'pending' ? 'schedule' :
                                    msg.status === 'failed' ? 'error-outline' :
                                    msg.status === 'delivered' || msg.status === 'read' ? 'done-all' :
                                    'done'
                                }
                                size={msg.status === 'failed' ? 11 : 10}
                                color={
                                    msg.status === 'read' ? '#34B7F1' :
                                    msg.status === 'failed' ? '#ef4444' :
                                    'rgba(255,255,255,0.3)'
                                }
                            />
                        )}
                    </View>
                </Animated.View>
            </GestureDetector>
        </View>
    );
}, (prevProps, nextProps) => {
  if (prevProps.msg?.id !== nextProps.msg?.id) return false;
  if (prevProps.msg?.text !== nextProps.msg?.text) return false;
  if (prevProps.msg?.status !== nextProps.msg?.status) return false;
  const prevReactions = (prevProps.msg?.reactions || []).join('|');
  const nextReactions = (nextProps.msg?.reactions || []).join('|');
  if (prevReactions !== nextReactions) return false;
  if (prevProps.isSelected !== nextProps.isSelected) return false;
  if (prevProps.isClone !== nextProps.isClone) return false;
  if (prevProps.quotedMessage?.id !== nextProps.quotedMessage?.id) return false;
  if (prevProps.selectionMode !== nextProps.selectionMode) return false;
  if (prevProps.isChecked !== nextProps.isChecked) return false;
  return true;
});

export default MessageBubble;
