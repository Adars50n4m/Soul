import { StyleSheet, Dimensions } from 'react-native';

export const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');


export const HEADER_PILL_HEIGHT = 72;
export const HEADER_PILL_RADIUS = 36;
export const GRID_TILE_SIZE = (Math.min(SCREEN_WIDTH * 0.65, 280) - 7) / 2;

export const ChatStyles = StyleSheet.create({
    messageWrapper: {
        width: '100%',
        marginBottom: 4,
        alignItems: 'flex-start',
    },
    messageWrapperWithReactions: {
        marginBottom: 6,
    },
    messageWrapperMe: {
        alignItems: 'flex-end',
    },
    replyIconContainer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 50,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: -1,
    },
    replyIconContainerMe: {
        // Sent bubble swipes LEFT — icon revealed at the right edge of the row.
        right: 0,
    },
    replyIconContainerThem: {
        // Received bubble swipes RIGHT — icon revealed at the left edge.
        left: 0,
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
        minWidth: 120, // Reduced from 70% to be responsive
    },
    bubbleContainerMediaOnly: {
        borderRadius: 14,
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        borderBottomLeftRadius: 14,
        borderBottomRightRadius: 14,
        backgroundColor: 'transparent',
    },
    bubbleReactionAnchor: {
        position: 'relative',
        overflow: 'visible',
    },
    bubbleContainerMe: {
        backgroundColor: 'rgba(188, 0, 42, 0.75)', // Glassy crimson for sender
        borderBottomRightRadius: 4,
    },
    bubbleContainerThem: {
        backgroundColor: 'rgba(255, 255, 255, 0.15)', // Glassy subtle gray for receiver
        borderTopLeftRadius: 4,
    },
    messageContent: {
        paddingVertical: 4,
        paddingHorizontal: 12,
        zIndex: 2,
        overflow: 'hidden',
    },
    messageContentMediaOnly: {
        padding: 0,
        position: 'relative',
    },
    quotedContainer: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 6,
        padding: 8,
        backgroundColor: 'rgba(255,255,255,0.15)', // Lighter background for quote block inside crimson
        borderRadius: 10,
        alignSelf: 'stretch',
        borderLeftWidth: 3,
        borderLeftColor: 'rgba(255,255,255,0.85)',
        minWidth: 100,
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
    quoteThumbnail: {
        width: 36,
        height: 36,
        borderRadius: 4,
        marginLeft: 8,
        backgroundColor: 'rgba(255,255,255,0.1)',
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
        width: Math.min(SCREEN_WIDTH * 0.65, 280),
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
        width: Math.min(SCREEN_WIDTH * 0.65, 280),
        padding: 2,
    },
    mediaGridRow: {
        flexDirection: 'row',
        marginBottom: 3,
    },
    mediaGridRowLast: {
        marginBottom: 0,
    },
    mediaGridNoGap: {
        marginBottom: 0,
    },
    mediaGridTile: {
        width: GRID_TILE_SIZE,
        height: GRID_TILE_SIZE,
        marginHorizontal: 1.5,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    mediaGridImage: {
        width: GRID_TILE_SIZE,
        height: GRID_TILE_SIZE,
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
    mediaLikeOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 8,
    },
    statusReplyCard: {
        width: Math.min(SCREEN_WIDTH * 0.58, 232),
        minHeight: 76,
        borderRadius: 16,
        paddingVertical: 10,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        overflow: 'hidden',
        borderWidth: 1,
        gap: 10,
    },
    statusReplyCardMe: {
        backgroundColor: 'rgba(255,255,255,0.12)',
        borderColor: 'rgba(255,255,255,0.16)',
    },
    statusReplyCardThem: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderColor: 'rgba(255,255,255,0.12)',
    },
    statusReplyAccent: {
        width: 4,
        alignSelf: 'stretch',
        borderRadius: 999,
        backgroundColor: '#ff2d55',
    },
    statusReplyCopy: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    statusReplyLabel: {
        color: '#ff8aa5',
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 0.6,
        marginBottom: 4,
        textTransform: 'uppercase',
    },
    statusReplyLabelMe: {
        color: '#ffd1db',
    },
    statusReplySnippet: {
        fontSize: 13,
        lineHeight: 17,
        fontWeight: '600',
    },
    statusReplySnippetMe: {
        color: 'rgba(255,255,255,0.92)',
    },
    statusReplySnippetThem: {
        color: 'rgba(255,255,255,0.84)',
    },
    statusReplyPreviewFrame: {
        width: 54,
        height: 54,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    statusReplyPreview: {
        width: 54,
        height: 54,
    },
    statusReplyPreviewFallback: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    mediaDownloadScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'transparent',
    },
    mediaDownloadBadge: {
        width: 72,
        height: 72,
        borderRadius: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
        backgroundColor: 'rgba(20,20,24,0.24)',
    },
    mediaDownloadBadgeSmall: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.16)',
        backgroundColor: 'rgba(20,20,24,0.24)',
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
    messageFooterWithReaction: {
        marginTop: 14,
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
        flexDirection: 'row',
        gap: 4,
        zIndex: 12,
    },
    reactionsRight: {
        right: 10,
        bottom: -10,
    },
    reactionsLeft: {
        left: 10,
        bottom: -10,
    },
    reactionPill: {
        borderRadius: 10,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.2)',
        backgroundColor: 'rgba(0,0,0,0.4)',
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 3,
    },
    reactionEmoji: {
        fontSize: 12,
    },
    selectionCheckboxContainer: {
        position: 'absolute',
        left: 8,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        zIndex: 10,
        width: 24,
        alignItems: 'center',
    },
    selectionCheckbox: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 1.5,
        borderColor: 'rgba(255,255,255,0.4)',
        alignItems: 'center',
        justifyContent: 'center',
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
    contextActionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        gap: 14,
    },
    contextActionText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '500',
    },
    senderName: {
        fontSize: 12,
        fontWeight: '700',
        color: 'rgba(255,255,255,0.6)',
        marginBottom: 2,
        marginLeft: 4,
    },
});
