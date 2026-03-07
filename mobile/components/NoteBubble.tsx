import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import GlassView from './ui/GlassView';

interface NoteBubbleProps {
    text: string;
    isMe?: boolean;
}

export const NoteBubble: React.FC<NoteBubbleProps> = ({ text, isMe }) => {
    if (!text) return null;

    return (
        <Animated.View 
            entering={FadeIn.duration(400).delay(200)}
            exiting={FadeOut.duration(200)}
            style={styles.container}
        >
            <Animated.View 
                entering={ZoomIn.springify().damping(15)}
                style={styles.bubble}
            >
                <Text numberOfLines={2} style={styles.text}>{text}</Text>
                {/* Tail */}
                <View style={styles.tail} />
            </Animated.View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        zIndex: 100,
    },
    bubble: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 18,
        maxWidth: 120, // Increased slightly
        minWidth: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5, // Thicker border for better contrast
        borderColor: 'rgba(255,255,255,0.15)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.4,
        shadowRadius: 8,
        elevation: 10,
    },
    text: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '500',
        textAlign: 'center',
    },
    tail: {
        position: 'absolute',
        bottom: -6,
        width: 12,
        height: 12,
        backgroundColor: '#262626',
        transform: [{ rotate: '45deg' }],
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
});
