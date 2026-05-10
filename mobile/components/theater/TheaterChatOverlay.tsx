import React, { useCallback, useMemo, useRef } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    StyleProp,
    ViewStyle,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    FadeIn,
    FadeOut,
    SlideInDown,
    SlideOutDown,
    useSharedValue,
    useAnimatedStyle,
    withTiming,
} from 'react-native-reanimated';
import GlassView from '../ui/GlassView';
import { useApp } from '../../context/AppContext';
import MessageBubble from '../chat/MessageBubble';
import ChatComposer, { ChatComposerHandle } from '../chat/ChatComposer';
import type { Message } from '../../types';

const BUBBLE_MAX_WIDTH = 280;
const MESSAGE_LIMIT = 50;

interface TheaterChatOverlayProps {
    chatId: string;
    contactName?: string;
    accent: string;
    onClose: () => void;
    /** Bottom inset to keep input above the action bar / safe area. */
    bottomInset?: number;
    style?: StyleProp<ViewStyle>;
    /**
     * When true, render as a normal-flow inline view: no backdrop, no
     * sliding animation, no close button, sheet fills the parent. Used by
     * the theater screen to embed chat permanently below the PIPs.
     */
    inline?: boolean;
    /**
     * Inline-mode handlers forwarded to MessageBubble so theater_session
     * cards' Join/End buttons + media taps still work inside the theater
     * screen. Optional — if omitted the buttons are no-ops.
     */
    onMediaTap?: (payload: any) => void;
    onTheaterEnd?: (messageId: string, theater: any) => void;
    /**
     * Forwarded to ChatComposer — fires when the + attach menu opens or
     * closes. The theater screen uses this to dim its full layout (header,
     * tiles, video) while the menu is open.
     */
    onAttachMenuToggle?: (open: boolean) => void;
    /**
     * Imperative ref forwarded into the underlying ChatComposer so the
     * theater screen can dismiss the attach menu when the user taps the
     * full-screen scrim.
     */
    composerRef?: React.MutableRefObject<ChatComposerHandle | null>;
    /**
     * When true, the inline overlay only renders the message list — the
     * caller is responsible for rendering ChatComposer separately. Theater
     * screen uses this so it can place a full-screen dim scrim BETWEEN
     * the chat list and the composer, which iOS would otherwise clip.
     */
    skipComposer?: boolean;
    /** Bottom padding the FlashList should leave for an externally-rendered composer. */
    listBottomPadding?: number;
}

const TheaterChatOverlay: React.FC<TheaterChatOverlayProps> = ({
    chatId,
    contactName,
    accent,
    onClose,
    bottomInset = 0,
    style,
    inline = false,
    onMediaTap,
    onTheaterEnd,
    onAttachMenuToggle,
    composerRef: externalComposerRef,
    skipComposer = false,
    listBottomPadding = 8,
}) => {
    const { messages, currentUser } = useApp() as any;

    const localComposerRef = useRef<ChatComposerHandle>(null);
    const composerRef = externalComposerRef || localComposerRef;

    const dimProgress = useSharedValue(0);
    const dimAnimatedStyle = useAnimatedStyle(() => ({ opacity: dimProgress.value }));
    const handleAttachMenuToggleInternal = useCallback((open: boolean) => {
        dimProgress.value = withTiming(open ? 1 : 0, { duration: 180 });
        onAttachMenuToggle?.(open);
    }, [dimProgress, onAttachMenuToggle]);
    const handleScrimPress = useCallback(() => {
        composerRef.current?.dismissModals();
    }, [composerRef]);

    const chatMessages: Message[] = useMemo(() => {
        const list = (messages?.[chatId] || []) as Message[];
        // Newest first for inverted FlashList — only keep the most recent
        // window so we don't render hundreds of bubbles inside the player.
        return [...list].reverse().slice(0, MESSAGE_LIMIT);
    }, [messages, chatId]);

    const renderItem = useCallback(({ item }: { item: Message }) => {
        const isMe = item.sender === 'me' || item.senderId === currentUser?.id;
        const senderLabel = isMe ? 'You' : (item.senderName || contactName || 'Them');
        const isTheaterCard = item.media?.type === 'theater_session';
        const isMedia = !!item.media && !isTheaterCard;
        // Keep the overlay compact — render text inline. For media or theater
        // session messages we just show a placeholder chip so the bubble does
        // not balloon over the video.
        return (
            <View style={[styles.row, isMe && styles.rowMe]}>
                <Text style={[styles.sender, { color: isMe ? accent : 'rgba(255,255,255,0.85)' }]}>
                    {senderLabel}
                </Text>
                {isTheaterCard ? (
                    <View style={styles.metaChip}>
                        <MaterialIcons name="movie" size={12} color={accent} />
                        <Text style={styles.metaChipText}>started theater</Text>
                    </View>
                ) : isMedia ? (
                    <View style={styles.metaChip}>
                        <MaterialIcons name="image" size={12} color="rgba(255,255,255,0.65)" />
                        <Text style={styles.metaChipText}>sent media</Text>
                    </View>
                ) : null}
                {item.text ? (
                    <Text style={styles.body} numberOfLines={4}>{item.text}</Text>
                ) : null}
            </View>
        );
    }, [accent, contactName, currentUser?.id]);

    // Render messages with the SAME MessageBubble used by /chat/[id] so the
    // user sees the rich theater_session cards (with End/Join buttons +
    // thumbnail), media bubbles, replies, etc. — not a stripped-down
    // text-only list. Most interactive callbacks (long-press menu, reactions)
    // are stubbed out because they don't make sense embedded inside the
    // theater player; the only ones we wire are media-tap and theater-end
    // because those are how the user actually interacts with theater bubbles.
    const renderInlineItem = useCallback(({ item }: { item: Message }) => {
        const quoted = item.replyTo ? chatMessages.find((m) => m.id === item.replyTo) : null;
        return (
            <View style={styles.inlineBubbleRow}>
                <MessageBubble
                    msg={item}
                    contactName={contactName || 'Them'}
                    isSelected={false}
                    onLongPress={() => {}}
                    onReply={() => {}}
                    onReaction={() => {}}
                    onDoubleTap={() => {}}
                    remoteLikePulse={null}
                    onMediaTap={onMediaTap || (() => {})}
                    quotedMessage={quoted as any}
                    selectionMode={false}
                    isChecked={false}
                    onSelectToggle={() => {}}
                    isHighlighted={false}
                    onQuotePress={() => {}}
                    onMediaDownload={() => {}}
                    onRetry={() => {}}
                    isAdmin={false}
                    onTheaterEnd={onTheaterEnd}
                />
            </View>
        );
    }, [chatMessages, contactName, onMediaTap, onTheaterEnd]);

    if (inline) {
        return (
            <View style={[styles.inlineRoot, style]}>
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    keyboardVerticalOffset={0}
                    style={styles.inlineSheet}
                >
                    <FlashList
                        data={chatMessages}
                        inverted
                        keyExtractor={(m) => m.id}
                        estimatedItemSize={120}
                        renderItem={renderInlineItem}
                        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: listBottomPadding }}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                        ListEmptyComponent={
                            <View style={styles.emptyWrap}>
                                <Text style={styles.emptyText}>No messages yet — say hi!</Text>
                            </View>
                        }
                    />

                    {/* Dim scrim sits between the FlashList and the
                        ChatComposer in JSX order. iOS uses sibling-render
                        order for stacking when no zIndex is set, so the
                        composer (and its absolute-positioned morph menu)
                        reliably renders ON TOP of the scrim, while the
                        chat bubbles are dimmed underneath. */}
                    <Animated.View
                        pointerEvents={dimProgress.value > 0 ? 'auto' : 'none'}
                        style={[styles.inlineDimScrim, dimAnimatedStyle]}
                    >
                        <Pressable
                            style={StyleSheet.absoluteFill}
                            onPress={handleScrimPress}
                        />
                    </Animated.View>

                    {/* Shared ChatComposer — same morphing + menu, attach pipeline,
                        slide-to-cancel mic, and send/edit flow as the main chat
                        screen. Theater action is hidden because we're already
                        inside one. */}
                    {!skipComposer ? (
                        <ChatComposer
                            ref={composerRef}
                            messageKey={chatId}
                            accent={accent}
                            contactName={contactName}
                            enableTheaterAction={false}
                            style={styles.inlineComposer}
                            onAttachMenuToggle={handleAttachMenuToggleInternal}
                        />
                    ) : null}
                </KeyboardAvoidingView>
            </View>
        );
    }

    return (
        <Animated.View
            entering={SlideInDown.duration(220)}
            exiting={SlideOutDown.duration(180)}
            style={[styles.root, style]}
        >
            <Pressable
                style={styles.backdrop}
                onPress={onClose}
            >
                <Animated.View
                    entering={FadeIn.duration(160)}
                    exiting={FadeOut.duration(140)}
                    style={StyleSheet.absoluteFill}
                />
            </Pressable>

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={0}
                style={[styles.sheet, { paddingBottom: bottomInset + 8 }]}
            >
                <GlassView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />

                <View style={styles.header}>
                    <View style={styles.handle} />
                    <View style={styles.headerRow}>
                        <View style={styles.titleWrap}>
                            <MaterialIcons name="chat-bubble" size={14} color={accent} />
                            <Text style={styles.title}>Theater chat</Text>
                            <View style={styles.countChip}>
                                <Text style={styles.countText}>{chatMessages.length}</Text>
                            </View>
                        </View>
                        <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
                            <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.7)" />
                        </Pressable>
                    </View>
                </View>

                <FlashList
                    data={chatMessages}
                    inverted
                    keyExtractor={(m) => m.id}
                    estimatedItemSize={48}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8 }}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                    ListEmptyComponent={
                        <View style={styles.emptyWrap}>
                            <Text style={styles.emptyText}>No messages yet — say hi!</Text>
                        </View>
                    }
                />

                <ChatComposer
                    messageKey={chatId}
                    accent={accent}
                    contactName={contactName}
                    enableTheaterAction={false}
                    style={styles.sheetComposer}
                />
            </KeyboardAvoidingView>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    root: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
    },
    // Inline mode: no overlay scaffolding, fills the parent.
    inlineRoot: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    inlineSheet: {
        flex: 1,
    },
    inlineBubbleRow: {
        marginVertical: 2,
    },
    inlineComposer: {
        paddingHorizontal: 8,
        paddingVertical: 6,
        // Lift the composer (and its morphing attach menu) above the chat
        // list. Without this, the menu's translucent glass blur lets the
        // last chat bubble (e.g. theater_session card) bleed through and
        // looks layered behind the menu.
        zIndex: 100,
        elevation: 100,
    },
    inlineDimScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.65)',
        zIndex: 50,
        elevation: 50,
    },
    sheetComposer: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: 'rgba(255,255,255,0.08)',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.18)',
    },
    sheet: {
        height: '62%',
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,15,18,0.5)',
    },
    header: {
        paddingTop: 6,
        paddingHorizontal: 14,
        paddingBottom: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255,255,255,0.08)',
    },
    handle: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.22)',
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 8,
    },
    titleWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    countChip: {
        marginLeft: 4,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 9,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    countText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 10,
        fontWeight: '700',
    },
    closeBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    row: {
        maxWidth: BUBBLE_MAX_WIDTH,
        marginVertical: 5,
        flexDirection: 'row',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: 6,
    },
    rowMe: {
        alignSelf: 'flex-end',
        justifyContent: 'flex-end',
    },
    sender: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.1,
    },
    body: {
        flexShrink: 1,
        color: '#fff',
        fontSize: 13,
        fontWeight: '500',
        lineHeight: 18,
    },
    metaChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 8,
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    metaChipText: {
        color: 'rgba(255,255,255,0.78)',
        fontSize: 11,
        fontWeight: '600',
    },
    emptyWrap: {
        alignItems: 'center',
        paddingVertical: 36,
    },
    emptyText: {
        color: 'rgba(255,255,255,0.45)',
        fontSize: 12,
        fontWeight: '500',
    },
});

export default TheaterChatOverlay;
