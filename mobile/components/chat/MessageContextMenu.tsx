import React, { useEffect } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, ScrollView, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
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

    const EMENU_GAP = 12; 
    const AMENU_GAP = 12; 
    const emojiBarHeight = 54;
    const actionMenuHeight = 260;
    
    const safeTop = 110; 
    const safeBottom = SCREEN_HEIGHT - 40; 

    let topAdjust = 0;

    if (layout.y - emojiBarHeight - EMENU_GAP < safeTop) {
        topAdjust = safeTop - (layout.y - emojiBarHeight - EMENU_GAP);
    }
    else if (layout.y + layout.height + AMENU_GAP + actionMenuHeight > safeBottom) {
        topAdjust = safeBottom - (layout.y + layout.height + AMENU_GAP + actionMenuHeight);
    }

    const adjustedY = layout.y + topAdjust;
    const emojiBarY = adjustedY - emojiBarHeight - EMENU_GAP;
    const actionMenuY = adjustedY + layout.height + AMENU_GAP;

    const previewBubbleFrame = Platform.select({
        android: {
            minWidth: layout.width + 8,
            maxWidth: SCREEN_WIDTH * 0.82,
        },
        default: {
            width: layout.width,
        },
    });

    return (
        <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
            <View style={StyleSheet.absoluteFill}>
                <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
                    <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} experimentalBlurMethod="dimezisBlurView" />
                    <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                </Animated.View>

                <Animated.View style={[StyleSheet.absoluteFill, containerStyle]} pointerEvents="box-none">
                    <View style={{
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
                    }}>
                        <BlurView intensity={80} tint="dark" style={[ChatStyles.contextEmojiTail, { [isMe ? 'right' : 'left']: 20 }]} experimentalBlurMethod="dimezisBlurView" />
                        
                        <BlurView intensity={80} tint="dark" style={{ flex: 1, borderRadius: 27, overflow: 'hidden', backgroundColor: 'rgba(30,30,30,0.5)' }} experimentalBlurMethod="dimezisBlurView">
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
                        position: 'absolute',
                        top: adjustedY,
                        [isMe ? 'right' : 'left']: isMe ? SCREEN_WIDTH - layout.x - layout.width : layout.x,
                        ...(previewBubbleFrame as object),
                        minHeight: layout.height,
                    }}>
                        <MessageBubble
                            msg={msg}
                            isClone
                            contactName={contactName}
                            quotedMessage={msg.replyTo && chatMessages ? chatMessages.find((m: any) => m.id === msg.replyTo) : null}
                        />
                    </View>

                    <View style={{
                        position: 'absolute',
                        top: actionMenuY,
                        [isMe ? 'right' : 'left']: isMe ? SCREEN_WIDTH - layout.x - layout.width : layout.x,
                        width: 200,
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 10 },
                        shadowOpacity: 0.5,
                        shadowRadius: 15,
                        elevation: 10,
                    }}>
                        <BlurView intensity={80} tint="dark" style={{ borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', backgroundColor: 'rgba(30,30,30,0.5)' }} experimentalBlurMethod="dimezisBlurView">
                            <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('reply'); handleClose(); }}>
                                <MaterialIcons name="reply" size={20} color="#fff" />
                                <Text style={ChatStyles.contextActionText}>Reply</Text>
                            </Pressable>
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
                                <Text style={[ChatStyles.contextActionText, { color: '#ff4444' }]}>Delete</Text>
                            </Pressable>
                        </BlurView>
                    </View>
                </Animated.View>
            </View>
        </Modal>
    );
};

export default MessageContextMenu;
