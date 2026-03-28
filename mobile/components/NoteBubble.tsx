import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useApp } from '../context/AppContext';

interface NoteBubbleProps {
    text: string;
    isMe?: boolean;
}

export function NoteBubble({ text, isMe }: NoteBubbleProps) {
    const { activeTheme } = useApp();
    if (!text) return null;

    return (
        <View style={styles.container}>
            <View style={[styles.bubble, { backgroundColor: activeTheme.surface }]}>
                <Text numberOfLines={4} style={styles.text}>{text}</Text>
            </View>
            <View style={styles.tailAnchor}>
                <View style={[styles.tailRoot, { backgroundColor: '#262626' }]} />
                <View style={[styles.tailMain, { backgroundColor: '#262626' }]} />
                <View style={[styles.tailDotSmall, { backgroundColor: '#262626' }]} />
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
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderRadius: 22,
        maxWidth: 160,
        minWidth: 100,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#262626',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
        elevation: 8,
    },
    text: {
        color: '#fff',
        fontSize: 15,
        lineHeight: 18,
        fontWeight: '700',
        textAlign: 'center',
    },
    tailAnchor: {
        position: 'absolute',
        top: '100%',
        left: 20,
        width: 80,
        height: 60,
        overflow: 'visible',
    },
    tailRoot: {
        position: 'absolute',
        top: 2, // Slight adjustment for larger size
        left: 0, // Slight adjustment for larger size
        width: 15.5, // Bada wala
        height: 15.5,
        borderRadius: 7.75,
        zIndex: 1,
    },
    tailMain: {
        position: 'absolute',
        top: 24,
        left: 10,
        width: 8, // Medium
        height: 8,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
    },
    tailDotSmall: {
        position: 'absolute',
        top: 42,
        left: 18,
        width: 4.5, // Chhota wala
        height: 4.5,
        borderRadius: 2.25,
        opacity: 0.7,
    },
});
