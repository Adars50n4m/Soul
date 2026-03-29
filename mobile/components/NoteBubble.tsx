import React, { useState } from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle, LayoutChangeEvent } from 'react-native';
import GlassView from './ui/GlassView';
import Svg, { Path } from 'react-native-svg';

interface NoteBubbleProps {
    text: string;
    isMe?: boolean;
    align?: 'center' | 'left';
}

export function NoteBubble({ text, isMe, align = 'center' }: NoteBubbleProps) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    
    if (!text) return null;

    const isLeft = align === 'left';

    const onLayout = (event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize({ width, height });
    };

    // Custom Border Path Logic
    const renderOutline = () => {
        if (size.width === 0 || size.height === 0) return null;
        
        const w = size.width;
        const h = size.height;
        const r = h / 2; // Full pill radius
        const dotX = 26; // Left-aligned dot center
        const dotR = 6.5; // Dot radius
        
        // Path construction: 
        // 1. Top pill edge
        // 2. Right curve
        // 3. Bottom pill edge (interrupted)
        // 4. Dot arc
        // 5. Left curve
        const d = `
            M ${r} 0
            H ${w - r}
            A ${r} ${r} 0 0 1 ${w - r} ${h}
            H ${dotX + dotR}
            A ${dotR} ${dotR} 0 1 1 ${dotX - dotR} ${h}
            H ${r}
            A ${r} ${r} 0 0 1 ${r} 0
            Z
        `;

        return (
            <View style={styles.svgOverlay} pointerEvents="none">
                <Svg width={w} height={h + 8} viewBox={`0 0 ${w} ${h + 8}`}>
                    <Path
                        d={d}
                        fill="transparent"
                        stroke="rgba(255,255,255,0.18)"
                        strokeWidth="1"
                    />
                </Svg>
            </View>
        );
    };

    return (
        <View style={[styles.container, isLeft && styles.containerLeft]}>
            <View style={styles.bubbleWrapper} onLayout={onLayout}>
                <GlassView intensity={88} tint="dark" style={[
                    styles.bubble, 
                    isLeft && styles.bubbleMini
                ]}>
                    <Text numberOfLines={isLeft ? 2 : 4} style={[styles.text, isLeft && styles.textMini]}>
                        {text}
                    </Text>
                </GlassView>
                
                {/* Visual Fix: The "Blended Fill" for the dot trail */}
                <View style={styles.tailFillContainer}>
                    <View style={styles.tailFill} />
                    {/* The Extra Tiny Origin Dot */}
                    <View style={styles.extraTinyDot} />
                </View>

                {/* The Seamless Continuous Outline */}
                {renderOutline()}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        zIndex: 100,
        overflow: 'visible',
        marginLeft: -38, // Shift slightly left for better status alignment
    } as ViewStyle,
    containerLeft: {
        alignItems: 'flex-start',
    } as ViewStyle,
    bubbleWrapper: {
        alignItems: 'center',
        overflow: 'visible',
    } as ViewStyle,
    bubble: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 24,
        maxWidth: 220, // Increased for better text flow
        alignItems: 'center',
        justifyContent: 'center',
        // Border removed - handled by SVG
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.5,
        shadowRadius: 15,
        elevation: 12,
    } as ViewStyle,
    bubbleMini: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 18,
        maxWidth: 150, // Increased for responsive mini-rail
    } as ViewStyle,
    svgOverlay: {
        ...StyleSheet.absoluteFillObject,
        top: 0,
        left: 0,
        overflow: 'visible',
    } as ViewStyle,
    text: {
        color: '#fff',
        fontSize: 14.5,
        lineHeight: 18,
        fontWeight: '700',
        textAlign: 'center',
        letterSpacing: -0.2,
    } as TextStyle,
    textMini: {
        fontSize: 11.5,
        lineHeight: 14,
    } as TextStyle,
    tailFillContainer: {
        position: 'absolute',
        top: '100%',
        marginTop: -10, 
        left: 20,
        zIndex: -1,
        alignItems: 'center',
    } as ViewStyle,
    tailFill: {
        width: 13,
        height: 14,
        borderRadius: 7,
        backgroundColor: '#151515', 
    } as ViewStyle,
    extraTinyDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#151515',
        marginTop: 4, // Space between main tail and tiny dot
        marginLeft: 5, // Shifted slightly right for better alignment
    } as ViewStyle,
});
