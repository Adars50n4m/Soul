import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface NoteBubbleProps {
    text: string;
    isMe?: boolean;
}

export function NoteBubble({ text, isMe }: NoteBubbleProps) {
    if (!text) return null;

    return (
        <View style={styles.container}>
            <View style={styles.bubble}>
                <Text numberOfLines={4} style={styles.text}>{text}</Text>
            </View>
            <View style={styles.tailAnchor}>
                <View style={styles.tailMain} />
                <View style={styles.tailDot} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        zIndex: 100,
        overflow: 'visible',
    },
    bubble: {
        paddingHorizontal: 24,
        paddingVertical: 18,
        borderRadius: 28,
        maxWidth: 176,
        minWidth: 116,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#2f3138',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.28,
        shadowRadius: 18,
        elevation: 12,
    },
    text: {
        color: '#fff',
        fontSize: 14,
        lineHeight: 18,
        fontWeight: '500',
        textAlign: 'center',
    },
    tailAnchor: {
        position: 'absolute',
        left: 22,
        bottom: -14,
        width: 26,
        height: 26,
        overflow: 'visible',
    },
    tailMain: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 18,
        height: 18,
        borderBottomLeftRadius: 16,
        borderBottomRightRadius: 14,
        borderTopLeftRadius: 2,
        borderTopRightRadius: 12,
        backgroundColor: '#2f3138',
        transform: [{ rotate: '8deg' }],
    },
    tailDot: {
        position: 'absolute',
        left: 8,
        top: 20,
        width: 10,
        height: 10,
        borderRadius: 999,
        backgroundColor: '#2f3138',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.04)',
    },
});
