import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
    View, Text, Image, FlatList, TextInput, Pressable,
    StyleSheet, StatusBar, KeyboardAvoidingView, Platform,
    Modal, Animated as RNAnimated,    useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import GlassView from '../../components/ui/GlassView';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withSpring, 
    withTiming,
    runOnJS, 
    interpolate, 
    Extrapolation 
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useApp } from '../../context/AppContext';
import { MusicPlayerOverlay } from '../../components/MusicPlayerOverlay';

const ENABLE_SHARED_TRANSITIONS = Platform.OS === 'ios';


// Sanitize song title - remove metadata like "(From ...)" or "[Album Name]"
const sanitizeSongTitle = (title: string): string => {
    if (!title) return '';
    // Remove text in parentheses and brackets
    return title
        .replace(/\s*\([^)]*\)/g, '')  // Remove (anything)
        .replace(/\s*\[[^\]]*\]/g, '') // Remove [anything]
        .trim();
};

// Animated 3-dot typing indicator (WhatsApp / iMessage style)
const TypingDots = () => {
    const [dot, setDot] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setDot(d => (d + 1) % 3), 400);
        return () => clearInterval(id);
    }, []);
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            {[0, 1, 2].map(i => (
                <View
                    key={i}
                    style={{
                        width: 5,
                        height: 5,
                        borderRadius: 2.5,
                        backgroundColor: dot === i ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
                    }}
                />
            ))}
        </View>
    );
};

const HeartPop = ({ active, onFinish }: { active: boolean, onFinish: () => void }) => {
    const scale = useSharedValue(0);
    const opacity = useSharedValue(0);

    useEffect(() => {
        if (active) {
            scale.value = 0;
            opacity.value = 1;
            scale.value = withSpring(1.5, { damping: 10, stiffness: 100 }, () => {
                scale.value = withTiming(0, { duration: 200 }, () => {
                   runOnJS(onFinish)();
                });
                opacity.value = withTiming(0, { duration: 200 });
            });
        }
    }, [active]);

    const style = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
        opacity: opacity.value,
        position: 'absolute',
        alignSelf: 'center',
        top: '30%',
        zIndex: 100,
    }));

    return (
        <Animated.View style={style} pointerEvents="none">
            <MaterialIcons name="favorite" size={80} color="#ff0080" />
        </Animated.View>
    );
};

// Message Bubble with Liquid Glass UI
const MessageBubble = ({ msg, onLongPress, onReply, isSelected, onReaction, quotedMessage, onDoubleTap }: any) => {
    const { activeTheme } = useApp();
    const translateX = useSharedValue(0);
    const [showHeart, setShowHeart] = useState(false);
    const isMe = msg.sender === 'me';

    const doubleTapGesture = Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(300)
        .onEnd(() => {
            if (onDoubleTap) {
                const currentReactions = msg.reactions || [];
                const hasHeart = currentReactions.some((r: string) => ['❤️', '❤', '\u2764\uFE0F', '\u2764'].includes(r) || r.includes('❤️'));
                if (!hasHeart) {
                    runOnJS(setShowHeart)(true);
                }
                runOnJS(onDoubleTap)(msg.id);
            }
        });

    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            runOnJS(onLongPress)(msg.id);
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

    const iconStyle = useAnimatedStyle(() => ({
        opacity: interpolate(translateX.value, [0, 50], [0, 1], Extrapolation.CLAMP),
        transform: [
            { scale: interpolate(translateX.value, [0, 50], [0.5, 1], Extrapolation.CLAMP) },
            { translateX: interpolate(translateX.value, [0, 50], [-20, 0], Extrapolation.CLAMP) }
        ] as any,
    }));

    return (
        <View style={[styles.messageWrapper, isMe && styles.messageWrapperMe]}>
            <View style={styles.replyIconContainer}>
                <Animated.View style={[styles.replyIcon, iconStyle]}>
                    <MaterialIcons name="reply" size={24} color="#ff0080" />
                </Animated.View>
            </View>

            <GestureDetector gesture={composedGestures}>
                <Animated.View style={bubbleStyle}>
                    <View style={[
                        styles.bubbleContainer, 
                        isMe ? styles.bubbleContainerMe : styles.bubbleContainerThem
                    ]}>
                        {/* Liquid Background */}
                        {isMe ? (
                            <LinearGradient
                                // App Branding Magenta Gradient
                                colors={['#ff0080', '#e60073']} 
                                start={{ x: 0, y: 0 }}
                                end={{ x: 1, y: 1 }}
                                style={StyleSheet.absoluteFill}
                            />
                        ) : (
                            // Neutral Glass with subtle Rose tint
                            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255, 255, 255, 0.08)' }]}>
                                <GlassView intensity={20} tint="light" style={StyleSheet.absoluteFill}  />
                            </View>
                        )}
                        
                        {/* Glass Border & Shine */}
                        <View style={[
                            styles.glassBorder, 
                            isMe ? { borderColor: 'rgba(255, 255, 255, 0.2)' } : { borderColor: 'rgba(255, 255, 255, 0.08)' }
                        ]} />

                        <View style={styles.messageContent}>
                            {/* Quoted Message */}
                            {quotedMessage && (
                                <View style={[styles.quotedContainer, isMe ? styles.quotedMe : styles.quotedThem]}>
                                    <View style={[styles.quoteBar, { backgroundColor: isMe ? '#fff' : '#ff0080' }]} />
                                    <View style={styles.quoteContent}>
                                        <Text style={[styles.quoteSender, { color: isMe ? '#fff' : '#f43f5e' }]}>
                                            {quotedMessage.sender === 'me' ? 'YOU' : 'THEM'}
                                        </Text>
                                        <Text numberOfLines={1} style={[styles.quoteText, { color: isMe ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)' }]}>
                                            {quotedMessage.text}
                                        </Text>
                                    </View>
                                </View>
                            )}

                            {/* Media */}
                            {msg.media?.url && (
                                <Image source={{ uri: msg.media.url }} style={styles.mediaImage} />
                            )}

                            {/* Text */}
                            <Text style={[styles.messageText, isMe && styles.messageTextMe]}>
                                {msg.text}
                            </Text>

                            {/* Footer */}
                            <View style={styles.messageFooter}>
                                <Text style={[styles.timestamp, isMe && { color: 'rgba(255,255,255,0.7)' }]}>{msg.timestamp}</Text>
                                {isMe && (
                                    <MaterialIcons
                                        name={msg.status === 'read' ? 'done-all' : 'done'}
                                        size={14}
                                        color={msg.status === 'read' ? '#fff' : 'rgba(255,255,255,0.6)'}
                                    />
                                )}
                            </View>
                        </View>
                    </View>

                    {/* Reactions */}
                    {msg.reactions && msg.reactions.length > 0 && (
                        <View style={[styles.reactionsRow, isMe ? styles.reactionsRight : styles.reactionsLeft]}>
                            {msg.reactions.map((r: string, idx: number) => (
                                <GlassView key={idx} intensity={40} tint="dark" style={styles.reactionPill} >
                                    <Text style={styles.reactionEmoji}>{r}</Text>
                                </GlassView>
                            ))}
                        </View>
                    )}

                    <HeartPop active={showHeart} onFinish={() => setShowHeart(false)} />
                </Animated.View>
            </GestureDetector>
        </View>
    );
};

// Emoji Reaction Modal
const ReactionModal = ({ visible, onClose, onSelect, hasReaction }: any) => {
    const emojis = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.reactionModalOverlay} onPress={onClose}>
                <GlassView intensity={35} tint="dark" style={styles.reactionModalContent} >
                    <View style={styles.emojiBar}>
                        {emojis.map(emoji => (
                            <Pressable key={emoji} onPress={() => onSelect(emoji)} style={styles.emojiButton}>
                                <Text style={styles.emojiText}>{emoji}</Text>
                            </Pressable>
                        ))}
                    </View>
                    <View style={styles.reactionActionsRow}>
                        {hasReaction && (
                            <Pressable style={[styles.reactionActionButton, styles.removeReactionButton]} onPress={() => onSelect('remove_reaction')}>
                                <MaterialIcons name="clear" size={18} color="rgba(255,255,255,0.6)" />
                                <Text style={styles.removeReactionText}>Remove</Text>
                            </Pressable>
                        )}
                        <Pressable style={[styles.reactionActionButton, styles.deleteMsgButton]} onPress={() => onSelect('delete_msg')}>
                            <MaterialIcons name="delete" size={18} color="#ef4444" />
                            <Text style={styles.deleteMsgText}>Delete Message</Text>
                        </Pressable>
                    </View>
                </GlassView>
            </Pressable>
        </Modal>
    );
};

export default function RemoteChat() {
    const { width: SCREEN_WIDTH } = useWindowDimensions();
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const navigation = useNavigation();
    const { contacts, messages, sendChatMessage, startCall, activeCall, addReaction, toggleHeart, deleteMessage, musicState } = useApp();
    const [inputText, setInputText] = useState('');
    const [showCallModal, setShowCallModal] = useState(false);
    const [replyingTo, setReplyingTo] = useState<any>(null);
    const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null);
    const [isTyping, setIsTyping] = useState(false);
    const [showMusicPlayer, setShowMusicPlayer] = useState(false);
    const flatListRef = useRef<FlatList>(null);
    const modalAnim = useMemo(() => new RNAnimated.Value(0), []);
    const [callOptionsPosition, setCallOptionsPosition] = useState({ x: 0, y: 0 });
    const callButtonRef = useRef<View>(null);

    const contact = contacts.find(c => c.id === id);
    const chatMessages = messages[id || ''] || [];

    useEffect(() => {
        if (chatMessages.length > 0) {
            setTimeout(() => {
                flatListRef.current?.scrollToEnd({ animated: true });
            }, 100);
        }
    }, [chatMessages.length]);

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
        const content = inputText.trim();
        setInputText('');
        setReplyingTo(null);

        // Send message via real-time ChatService
        sendChatMessage(id, content, undefined);
    };

    const handleReaction = (action: string) => {
        if (selectedMsgId && id) {
            if (action === 'delete_msg') {
                deleteMessage(id, selectedMsgId);
            } else if (action === 'remove_reaction') {
                addReaction(id, selectedMsgId, null);
            } else {
                addReaction(id, selectedMsgId, action);
            }
        }
        setSelectedMsgId(null);
    };

    const handleDoubleTap = useCallback((msgId: string) => {
        if (id) {
            toggleHeart(id, msgId);
        }
    }, [id, toggleHeart]);

    const renderMessage = useCallback(({ item }: { item: any }) => (
        <MessageBubble
            msg={item}
            isSelected={selectedMsgId === item.id}
            onLongPress={(mid: string) => setSelectedMsgId(mid)}
            onReply={(m: any) => setReplyingTo(m)}
            onReaction={handleReaction}
            onDoubleTap={handleDoubleTap}
            quotedMessage={item.replyTo ? chatMessages.find((m: any) => m.id === item.replyTo) : null}
        />
    ), [selectedMsgId, chatMessages]);

    if (!contact) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>Contact not found</Text>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={0}
        >
            <StatusBar barStyle="light-content" />

            {/* Header - Pill Shape for Morphing shared element transition */}
            <Animated.View 
                {...(ENABLE_SHARED_TRANSITIONS ? { sharedTransitionTag: `pill-${id}` } : {})}
                style={styles.header}
            >
               <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
                
                <Pressable 
                    onPress={() => {
                        if (navigation.canGoBack()) navigation.goBack();
                    }} 
                    style={styles.backButton}
                >
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>

                <Pressable style={styles.avatarWrapper} onPress={() => router.push(`/profile/${contact.id}` as any)}>
                    <Image source={{ uri: contact.avatar }} style={styles.avatar} />
                    {contact.status === 'online' && <View style={styles.onlineIndicator} />}
                </Pressable>

                <View style={styles.headerInfo}>
                    <Text style={styles.contactName}>{contact.name}</Text>
                    {musicState.currentSong ? (
                        <View style={styles.nowPlayingStatus}>
                            <MaterialIcons name="library-music" size={10} color="#f43f5e" />
                            <Text style={styles.statusText} numberOfLines={1}>
                                {sanitizeSongTitle(musicState.currentSong.name)}
                            </Text>
                        </View>
                    ) : (
                        <Text style={styles.statusText}>
                            {contact.status === 'online' ? 'ONLINE' : 'OFFLINE'}
                        </Text>
                    )}
                </View>

                {/* Music Button - Navigates to 3D Music Screen */}
                <Pressable style={styles.headerButton} onPress={() => router.push('/music')}>
                    <MaterialIcons name="library-music" size={20} color="#f43f5e" />
                </Pressable>

                {/* Call Button */}
                <View ref={callButtonRef} collapsable={false}>
                    <Pressable style={styles.headerButton} onPress={openCallModal}>
                        <MaterialIcons name="call" size={20} color="#f43f5e" />
                    </Pressable>
                </View>
            </Animated.View>

            {/* Messages */}
            <FlatList
                ref={flatListRef}
                data={chatMessages}
                keyExtractor={item => item.id}
                renderItem={renderMessage}
                style={styles.messagesList}
                contentContainerStyle={styles.messagesContent}
                showsVerticalScrollIndicator={false}
                ListFooterComponent={
                    isTyping ? (
                        <View style={styles.typingContainer}>
                            <View style={styles.typingBubble}>
                                <TypingDots />
                            </View>
                        </View>
                    ) : null
                }
                ListEmptyComponent={
                    <View style={styles.emptyChat}>
                        <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.1)" />
                        <Text style={styles.emptyChatText}>No messages yet</Text>
                        <Text style={styles.emptyChatHint}>Say hi to {contact.name}!</Text>
                    </View>
                }
            />

            {/* Reply Preview */}
            {replyingTo && (
                <GlassView intensity={35} tint="dark" style={styles.replyPreview} >
                    <View style={styles.replyContent}>
                        <View style={styles.quoteBar} />
                        <View style={styles.replyTextContainer}>
                            <Text style={styles.replySender}>REPLYING TO</Text>
                            <Text numberOfLines={1} style={styles.replyText}>{replyingTo.text}</Text>
                        </View>
                    </View>
                    <Pressable onPress={() => setReplyingTo(null)}>
                        <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                    </Pressable>
                </GlassView>
            )}

            {/* Input Area */}
            <GlassView intensity={35} tint="dark" style={styles.inputArea} >
                <Pressable style={styles.attachButton}>
                    <MaterialIcons name="add" size={24} color="rgba(255,255,255,0.5)" />
                </Pressable>


                <View style={styles.inputWrapper}>
                    <TextInput
                        style={styles.input}
                        value={inputText}
                        onChangeText={setInputText}
                        placeholder="Sync fragment..."
                        placeholderTextColor="rgba(255,255,255,0.25)"
                        multiline
                        maxLength={1000}
                    />
                    <Pressable style={styles.emojiInputButton}>
                        <MaterialIcons name="emoji-emotions" size={22} color="rgba(255,255,255,0.5)" />
                    </Pressable>
                </View>

                <Pressable
                    style={[styles.sendButton, inputText.trim() && styles.sendButtonActive]}
                    onPress={handleSend}
                >
                    <MaterialIcons
                        name={inputText.trim() ? 'arrow-upward' : 'mic'}
                        size={22}
                        color={inputText.trim() ? '#ffffff' : 'rgba(255,255,255,0.5)'}
                    />
                </Pressable>
            </GlassView>

            {/* Reaction Modal */}
            <ReactionModal
                visible={!!selectedMsgId}
                onClose={() => setSelectedMsgId(null)}
                onSelect={handleReaction}
                hasReaction={!!chatMessages.find(m => m.id === selectedMsgId)?.reactions?.length}
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
                        <GlassView intensity={35} tint="dark" style={styles.callDropdownBlur} >
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
                        </GlassView>
                    </RNAnimated.View>
                </Pressable>
            </Modal>

            {/* Music Player Overlay */}
            <MusicPlayerOverlay
                isOpen={showMusicPlayer}
                onClose={() => setShowMusicPlayer(false)}
                contactName={contact.name}
            />

        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#09090b',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: Platform.OS === 'ios' ? 44 : 24, // Floating pill
        marginHorizontal: 12,
        height: 64,
        paddingHorizontal: 12,
        borderRadius: 32, // Pill shape!
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.22)',
        gap: 2,
        overflow: 'hidden',
        zIndex: 10,
    },
    backButton: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarWrapper: {
        position: 'relative',
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.22)',
    },
    onlineIndicator: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: '#22c55e',
        borderWidth: 1.5,
        borderColor: '#000',
    },
    headerInfo: {
        flex: 1,
        marginLeft: 4,
    },
    contactName: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '800',
    },
    statusText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 8,
        fontWeight: '900',
        letterSpacing: 2,
        marginTop: 1,
    },
    headerButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(244, 63, 94, 0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    messagesList: {
        flex: 1,
    },
    messagesContent: {
        paddingHorizontal: 16,
        paddingTop: Platform.OS === 'ios' ? 120 : 100, // Account for floating pill header
        paddingBottom: 20,
        flexGrow: 1,
    },
    messageWrapper: {
        width: '100%',
        marginBottom: 16,
        alignItems: 'flex-start',
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
        maxWidth: '80%',
        borderRadius: 22,
        overflow: 'hidden',
        position: 'relative',
    },
    bubbleContainerMe: {
        borderBottomRightRadius: 4,
    },
    bubbleContainerThem: {
        borderBottomLeftRadius: 4,
        backgroundColor: 'rgba(255,255,255,0.05)', // Fallback for BlurView
    },
    glassBorder: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.22)',
        zIndex: 1,
    },
    messageContent: {
        padding: 12,
        paddingHorizontal: 16,
        zIndex: 2,
    },
    quotedContainer: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 8,
        padding: 8,
        backgroundColor: 'rgba(0,0,0,0.2)',
        borderRadius: 12,
    },
    quotedMe: {
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    quotedThem: {
        backgroundColor: 'rgba(0,0,0,0.2)',
    },
    quoteBar: {
        width: 2,
        borderRadius: 2,
    },
    quoteContent: {
        flex: 1,
    },
    quoteSender: {
        fontSize: 9,
        fontWeight: '900',
        letterSpacing: 2,
        marginBottom: 2,
    },
    quoteText: {
        fontSize: 11,
    },
    mediaImage: {
        width: 200,
        height: 200,
        borderRadius: 15,
        marginBottom: 10,
    },
    messageText: {
        color: 'rgba(255,255,255,0.9)',
        fontSize: 15,
        lineHeight: 22,
        fontWeight: '500',
    },
    messageTextMe: {
        color: '#ffffff',
        fontWeight: '600',
    },
    messageFooter: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
    },
    timestamp: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 10,
        fontWeight: '600',
    },
    reactionsRow: {
        position: 'absolute',
        bottom: -14,
        flexDirection: 'row',
        gap: 4,
        zIndex: 10,
    },
    reactionsRight: {
        right: 12,
    },
    reactionsLeft: {
        left: 12,
    },
    reactionPill: {
        borderRadius: 12,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.22)',
        backgroundColor: 'rgba(0,0,0,0.5)', 
        overflow: 'hidden',
    },
    reactionEmoji: {
        fontSize: 10,
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
        alignItems: 'flex-start' as const,
    },
    typingBubble: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopLeftRadius: 4,
    },
    replyPreview: {
        marginHorizontal: 16,
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
        color: '#f43f5e',
        letterSpacing: 2,
    },
    replyText: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.5)',
    },
    inputArea: {
        // Removed absolute positioning for proper KeyboardAvoidingView support
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 12,
        paddingBottom: Platform.OS === 'ios' ? 32 : 12, // Increased bottom padding for iOS Home Indicator
        gap: 10,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.08)',
        backgroundColor: '#09090b', // Ensure background is set if using flexible layout
    },
    attachButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.06)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.22)',
    },
    inputWrapper: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'flex-end',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderRadius: 24,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.22)',
    },
    input: {
        flex: 1,
        color: '#ffffff',
        fontSize: 15,
        maxHeight: 100,
        paddingVertical: 4,
        fontWeight: '500',
    },
    emojiInputButton: {
        padding: 4,
        marginLeft: 8,
    },
    sendButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(255,255,255,0.06)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    sendButtonActive: {
        backgroundColor: 'rgba(244, 63, 94, 0.3)',
        borderColor: 'rgba(244, 63, 94, 0.5)',
    },
    errorText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 16,
        textAlign: 'center',
        marginTop: 100,
    },
    // Reaction Modal
    reactionModalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    reactionModalContent: {
        borderRadius: 24,
        padding: 16,
        gap: 12,
        overflow: 'hidden',
    },
    emojiBar: {
        flexDirection: 'row',
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 30,
        padding: 8,
    },
    emojiButton: {
        width: 44,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emojiText: {
        fontSize: 24,
    },
    deleteMsgButton: {
        backgroundColor: 'rgba(239, 68, 68, 0.15)',
        flex: 1,
    },
    deleteMsgText: {
        color: '#ef4444',
        fontSize: 12,
        fontWeight: '700',
    },
    reactionActionsRow: {
        flexDirection: 'row',
        gap: 8,
        width: '100%',
    },
    reactionActionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    removeReactionButton: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        paddingHorizontal: 12,
    },
    removeReactionText: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 12,
        fontWeight: '600',
    },
    // Call Modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalContent: {
        width: '85%',
        maxWidth: 320,
        borderRadius: 24,
        overflow: 'hidden',
    },
    modalBlur: {
        padding: 24,
    },
    modalHeader: {
        alignItems: 'center',
        marginBottom: 24,
    },
    modalAvatar: {
        width: 64,
        height: 64,
        borderRadius: 32,
        marginBottom: 12,
    },
    modalTitle: {
        color: '#ffffff',
        fontSize: 18,
        fontWeight: '700',
    },
    callOptions: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 32,
        marginBottom: 24,
    },
    callOption: {
        alignItems: 'center',
        gap: 10,
    },
    callOptionIcon: {
        width: 64,
        height: 64,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    callOptionText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 13,
        fontWeight: '600',
    },
    cancelButton: {
        paddingVertical: 14,
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
        marginTop: 8,
        marginHorizontal: -24,
        paddingHorizontal: 24,
    },
    cancelText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 15,
        fontWeight: '600',
    },
    nowPlayingStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    playingDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#f43f5e',
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
});
