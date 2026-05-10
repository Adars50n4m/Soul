import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { BlurView } from 'expo-blur';
// GlassView uses solid bg on Android; BlurView with dimezisBlurView gives real blur
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withSpring, 
    withTiming, 
    interpolate, 
    Easing, 
    runOnJS 
} from 'react-native-reanimated';
import { Message } from '../../types';
import { ChatStyles, SCREEN_WIDTH, SCREEN_HEIGHT } from './ChatStyles';
import MessageBubble from './MessageBubble';
import { getMessageMediaItems } from '../../utils/chatUtils';

interface MessageContextMenuProps {
    visible: boolean;
    msg: Message | null;
    layout: any;
    onClose: () => void;
    onReaction: (emoji: string) => void;
    onAction: (action: string) => void;
    chatMessages: Message[];
    contactName: string;
    isAdmin?: boolean;
}

const MessageContextMenu = ({ 
    visible, 
    msg, 
    layout, 
    onClose, 
    onReaction, 
    onAction, 
    chatMessages, 
    contactName,
    isAdmin = false
}: MessageContextMenuProps) => {
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
        progress.value = withSpring(0, {
            damping: 25,
            stiffness: 300,
            mass: 1,
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
    const mediaItems = getMessageMediaItems(msg);
    const isGroupedMedia = mediaItems.length > 1;

    const estimatedItemHeight = 49; // 48 padding + 1 border
    const canEdit = isMe && mediaItems.length === 0;
    const numberOfActions = (canEdit ? 8 : 7);
    const IDEAL_ACTION_HEIGHT = numberOfActions * estimatedItemHeight;
    
    const EMOJI_HEIGHT = 54;
    const UNIT_GAP = 8;
    const TOTAL_GAP = UNIT_GAP * 2; 
    
    const safeTop = 60; 
    const safeBottom = SCREEN_HEIGHT - 60; 
    const maxAllowableHeight = safeBottom - safeTop;

    const fixedElementsHeight = layout.height + EMOJI_HEIGHT + TOTAL_GAP;
    
    // Constrain the action menu height so the entire component fits on screen
    const CLAMPED_ACTION_HEIGHT = Math.max(
        150, 
        Math.min(IDEAL_ACTION_HEIGHT, maxAllowableHeight - fixedElementsHeight)
    );
    
    // We use the actual predicted height for position calculations, 
    // but the container will use maxHeight to snap to content.
    const actualActionHeight = Math.min(IDEAL_ACTION_HEIGHT, CLAMPED_ACTION_HEIGHT);
    const unitHeight = fixedElementsHeight + actualActionHeight;

    let topAdjust = 0;
    const startY = layout.y - EMOJI_HEIGHT - UNIT_GAP; 

    if (startY < safeTop) {
        topAdjust = safeTop - startY;
    } else if (startY + unitHeight > safeBottom) {
        topAdjust = safeBottom - (startY + unitHeight);
        
        // Final sanity check: if pushing up makes it bleed past the top, clamp it to top.
        // The ScrollView will handle the squished action menu.
        if (startY + topAdjust < safeTop) {
            topAdjust = safeTop - startY;
        }
    }

    const unitY = startY + topAdjust;

    return (
        <View style={[StyleSheet.absoluteFill, { zIndex: 9999, elevation: 9999 }]}>
            <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
                <BlurView intensity={80} tint="dark" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0, 0, 0, 0.45)' }]} pointerEvents="none" />
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
            </Animated.View>

            <Animated.View style={[StyleSheet.absoluteFill, containerStyle]} pointerEvents="box-none">
                <View style={{
                    position: 'absolute',
                    top: unitY,
                    [isMe ? 'right' : 'left']: isMe ? SCREEN_WIDTH - layout.x - layout.width : layout.x,
                    alignItems: isMe ? 'flex-end' : 'flex-start',
                    gap: UNIT_GAP,
                }}>
                        {/* 1. Emoji Bar */}
                        <View style={{
                            width: 270,
                            height: EMOJI_HEIGHT,
                            shadowColor: '#000',
                            shadowOffset: { width: 0, height: 10 },
                            shadowOpacity: 0.5,
                            shadowRadius: 15,
                            elevation: 10,
                        }}>
                            <BlurView intensity={60} tint="dark" experimentalBlurMethod="dimezisBlurView" style={[ChatStyles.contextEmojiTail, { [isMe ? 'right' : 'left']: 20 }]}  />
                            <BlurView intensity={60} tint="dark" experimentalBlurMethod="dimezisBlurView" style={{ flex: 1, borderRadius: 27, overflow: 'hidden', backgroundColor: 'rgba(30,30,30,0.4)' }} >
                                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 16, gap: 14 }}>
                                    {emojis.map(e => (
                                        <Pressable key={e} onPress={() => { onReaction(e); handleClose(); }} style={{ paddingVertical: 10 }}>
                                            <Text style={{ fontSize: 26 }}>{e}</Text>
                                        </Pressable>
                                    ))}
                                    <Pressable style={{ backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 16, width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: 4 }} onPress={() => { }}>
                                        <MaterialIcons name="add" size={20} color="#fff" />
                                    </Pressable>
                                </ScrollView>
                            </BlurView>
                        </View>

                        <View style={{
                            width: layout.width,
                            height: layout.height,
                        }}>
                            <MessageBubble
                                msg={msg}
                                isClone
                                contactName={contactName}
                                initialAspectRatio={layout.aspectRatio}
                                quotedMessage={msg.replyTo && chatMessages ? chatMessages.find((m: any) => m.id === msg.replyTo) : null}
                            />
                        </View>

                        {/* 3. Action Menu */}
                        <View style={{
                            width: 200,
                            maxHeight: CLAMPED_ACTION_HEIGHT,
                            shadowColor: '#000',
                            shadowOffset: { width: 0, height: 10 },
                            shadowOpacity: 0.5,
                            shadowRadius: 15,
                            elevation: 10,
                        }}>
                            <BlurView intensity={60} tint="dark" experimentalBlurMethod="dimezisBlurView" style={{ borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', backgroundColor: 'rgba(30,30,30,0.4)', height: '100%' }} >
                                <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('reply'); handleClose(); }}>
                                        <MaterialIcons name="reply" size={20} color="#fff" />
                                        <Text style={ChatStyles.contextActionText}>Reply</Text>
                                    </Pressable>
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('copy'); handleClose(); }}>
                                        <MaterialIcons name="content-copy" size={20} color="#fff" />
                                        <Text style={ChatStyles.contextActionText}>Copy</Text>
                                    </Pressable>
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('forward'); handleClose(); }}>
                                        <MaterialIcons name="forward" size={20} color="#fff" />
                                        <Text style={ChatStyles.contextActionText}>Forward</Text>
                                    </Pressable>
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction(msg.isStarred ? 'unstar' : 'star'); handleClose(); }}>
                                        <MaterialIcons name={msg.isStarred ? 'star-outline' : 'star'} size={20} color="#fff" />
                                        <Text style={ChatStyles.contextActionText}>{msg.isStarred ? 'Unstar' : 'Star'}</Text>
                                    </Pressable>
                                    {isMe && mediaItems.length === 0 && (
                                        <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('edit'); handleClose(); }}>
                                            <MaterialIcons name="edit" size={20} color="#fff" />
                                            <Text style={ChatStyles.contextActionText}>Edit</Text>
                                        </Pressable>
                                    )}
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('pin'); handleClose(); }}>
                                        <MaterialIcons name="push-pin" size={20} color="#fff" />
                                        <Text style={ChatStyles.contextActionText}>Pin</Text>
                                    </Pressable>
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('select'); handleClose(); }}>
                                        <MaterialIcons name="check-circle-outline" size={20} color="#fff" />
                                        <Text style={ChatStyles.contextActionText}>Select</Text>
                                    </Pressable>
                                    <Pressable style={ChatStyles.contextActionBtn} onPress={() => {
                                        const msgTime = new Date(msg.timestamp).getTime();
                                        const now = new Date().getTime();
                                        const diffMinutes = (now - msgTime) / (1000 * 60);
                                        // theater_session bubbles aren't user-typed content; they're
                                        // "live room" invites and the sender must always be able to
                                        // tear them down for everyone, otherwise old LIVE bubbles
                                        // zombie back from Supabase on every refresh.
                                        const isTheater = msg.media?.type === 'theater_session';
                                        const canDeleteForEveryone = (isMe || isAdmin) && (isTheater || diffMinutes <= 5);
                                        onAction(canDeleteForEveryone ? 'delete' : 'deleteForMe');
                                        handleClose();
                                    }}>
                                        <MaterialIcons name="delete-outline" size={20} color="#ff4444" />
                                        <Text style={[ChatStyles.contextActionText, { color: '#ff4444' }]}>
                                            {(() => {
                                                const msgTime = new Date(msg.timestamp).getTime();
                                                const now = new Date().getTime();
                                                const diffMinutes = (now - msgTime) / (1000 * 60);
                                                const isTheater = msg.media?.type === 'theater_session';
                                                const canDeleteForEveryone = (isMe || isAdmin) && (isTheater || diffMinutes <= 5);

                                                if (canDeleteForEveryone) {
                                                    return isGroupedMedia ? `Delete for Everyone (${mediaItems.length})` : 'Delete for Everyone';
                                                }
                                                return 'Delete for Me';
                                            })()}
                                        </Text>
                                    </Pressable>
                                </ScrollView>
                            </BlurView>
                        </View>
                </View>
            </Animated.View>
        </View>
    );
};

export default MessageContextMenu;
