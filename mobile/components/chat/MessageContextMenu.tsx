import React, { useEffect } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, ScrollView, Platform } from 'react-native';
import GlassView from '../ui/GlassView';
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
}

const MessageContextMenu = ({ 
    visible, 
    msg, 
    layout, 
    onClose, 
    onReaction, 
    onAction, 
    chatMessages, 
    contactName 
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
    const mediaItems = getMessageMediaItems(msg);
    const isGroupedMedia = mediaItems.length > 1;

    const ACTION_HEIGHT = 320; // includes copy + copy time + forward + star/edit/pin/select/delete
    const EMOJI_HEIGHT = 54;
    const UNIT_GAP = 8; // Smaller gap for a tighter look
    const TOTAL_GAP = UNIT_GAP * 2; 
    
    // Total footprint of the menu unit
    const unitHeight = layout.height + EMOJI_HEIGHT + ACTION_HEIGHT + TOTAL_GAP;
    
    const safeTop = 60; 
    const safeBottom = SCREEN_HEIGHT - 60; 

    let topAdjust = 0;
    const startY = layout.y - EMOJI_HEIGHT - UNIT_GAP; // Start right above the original position

    if (startY < safeTop) {
        topAdjust = safeTop - startY;
    } else if (startY + unitHeight > safeBottom) {
        topAdjust = safeBottom - (startY + unitHeight);
    }

    const unitY = startY + topAdjust;

    return (
        <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
            <View style={StyleSheet.absoluteFill}>
                <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
                    <GlassView intensity={40} tint="dark" style={StyleSheet.absoluteFill}  />
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
                            <GlassView intensity={80} tint="dark" style={[ChatStyles.contextEmojiTail, { [isMe ? 'right' : 'left']: 20 }]}  />
                            <GlassView intensity={80} tint="dark" style={{ flex: 1, borderRadius: 27, overflow: 'hidden', backgroundColor: 'rgba(30,30,30,0.5)' }} >
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
                            </GlassView>
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
                            shadowColor: '#000',
                            shadowOffset: { width: 0, height: 10 },
                            shadowOpacity: 0.5,
                            shadowRadius: 15,
                            elevation: 10,
                        }}>
                            <GlassView intensity={80} tint="dark" style={{ borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', backgroundColor: 'rgba(30,30,30,0.5)' }} >
                                <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('reply'); handleClose(); }}>
                                    <MaterialIcons name="reply" size={20} color="#fff" />
                                    <Text style={ChatStyles.contextActionText}>Reply</Text>
                                </Pressable>
                                <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('copy'); handleClose(); }}>
                                    <MaterialIcons name="content-copy" size={20} color="#fff" />
                                    <Text style={ChatStyles.contextActionText}>Copy</Text>
                                </Pressable>
                                <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('copy_time'); handleClose(); }}>
                                    <MaterialIcons name="schedule" size={20} color="#fff" />
                                    <Text style={ChatStyles.contextActionText}>Copy Time</Text>
                                </Pressable>
                                <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('forward'); handleClose(); }}>
                                    <MaterialIcons name="forward" size={20} color="#fff" />
                                    <Text style={ChatStyles.contextActionText}>Forward</Text>
                                </Pressable>
                                <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction(msg.isStarred ? 'unstar' : 'star'); handleClose(); }}>
                                    <MaterialIcons name={msg.isStarred ? 'star-outline' : 'star'} size={20} color="#fff" />
                                    <Text style={ChatStyles.contextActionText}>{msg.isStarred ? 'Unstar' : 'Star'}</Text>
                                </Pressable>
                                {isMe && (
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
                                <Pressable style={[ChatStyles.contextActionBtn, { borderBottomWidth: 0 }]} onPress={() => { onAction('delete'); handleClose(); }}>
                                    <MaterialIcons name="delete-outline" size={20} color="#ff4444" />
                                    <Text style={[ChatStyles.contextActionText, { color: '#ff4444' }]}>
                                        {isGroupedMedia ? `Delete (${mediaItems.length})` : 'Delete'}
                                    </Text>
                                </Pressable>
                            </GlassView>
                        </View>
                    </View>
                </Animated.View>
            </View>
        </Modal>
    );
};

export default MessageContextMenu;
