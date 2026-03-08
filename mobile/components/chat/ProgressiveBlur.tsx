import React from 'react';
import { View, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Canvas, BackdropFilter, Blur, Fill, LinearGradient as SkiaGradient, Rect, vec, Mask } from '@shopify/react-native-skia';

interface ProgressiveBlurProps {
    position?: 'top' | 'bottom';
    height?: number;
    intensity?: number;
    steps?: number;
    tintColor?: string;
}

/**
 * ProgressiveBlur — smooth gradient blur.
 *
 * iOS:     Skia BackdropFilter with gradient mask → pixel-perfect.
 * Android: Single BlurView + gradient overlay that fades the hard edge.
 *          One blur = zero banding. The gradient creates the "progressive" feel
 *          by transitioning from transparent (blur visible) → background color
 *          (blur hidden) at the inner edge.
 */
const ProgressiveBlur = ({
    position = 'top',
    height = 160,
    intensity = 50,
}: ProgressiveBlurProps) => {
    const { width } = useWindowDimensions();
    const isTop = position === 'top';

    const containerStyle: any = {
        position: 'absolute',
        [position]: 0,
        left: 0,
        right: 0,
        height,
        zIndex: 2,
        overflow: 'hidden',
    };

    // ── iOS: true Skia gradient blur ─────────────────────────────────────────
    if (Platform.OS === 'ios') {
        const blurRadius = Math.max(1, intensity / 2.5);
        return (
            <View style={containerStyle} pointerEvents="none">
                <Canvas style={StyleSheet.absoluteFill}>
                    <Mask
                        mask={
                            <Rect x={0} y={0} width={width} height={height}>
                                <SkiaGradient
                                    start={vec(0, isTop ? 0 : height)}
                                    end={vec(0, isTop ? height : 0)}
                                    colors={['white', 'transparent']}
                                />
                            </Rect>
                        }
                    >
                        <BackdropFilter filter={<Blur blur={blurRadius} />}>
                            <Fill color="transparent" />
                        </BackdropFilter>
                    </Mask>
                </Canvas>
            </View>
        );
    }

    // ── Android: gradient mask (stable fallback) ─────────────────────────
    // 'dimezisBlurView' can still cause white-screen crashes on some Android devices
    // when overlaid on complex lists. A pure gradient fade looks nearly identical
    // against the dark theme background and is 100% stable.

    // Gradient goes from transparent (content shows) → black (fades content out)
    const gradientColors = isTop
        ? (['rgba(0,0,0,1)', 'rgba(0,0,0,0.6)', 'rgba(0,0,0,0)'] as const)
        : (['rgba(0,0,0,0)', 'rgba(0,0,0,0.6)', 'rgba(0,0,0,1)'] as const);

    return (
        <View style={containerStyle} pointerEvents="none">
            <LinearGradient
                colors={gradientColors}
                start={{ x: 0, y: 0 }}
                end={{ x: 0, y: 1 }}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
};

export default ProgressiveBlur;
