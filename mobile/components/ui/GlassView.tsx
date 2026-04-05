import React, { Component } from 'react';
import { View, StyleSheet, ViewProps, StyleProp, ViewStyle, Platform } from 'react-native';
import { BlurView } from 'expo-blur';

export interface GlassViewProps extends ViewProps {
    intensity?: number;
    tint?: 'light' | 'dark' | 'default';
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
    experimentalBlurMethod?: 'none' | 'dimezisBlurView';
    disableExperimental?: boolean;
}

const IS_ANDROID = Platform.OS === 'android';

// Tint applied as a separate View layer (NOT through expo-blur's tint prop)
// This avoids the glow/additive blending artifact on Android
const TINT_BG: Record<string, string> = {
    dark: 'rgba(10, 10, 16, 0.55)',
    light: 'rgba(255, 255, 255, 0.12)',
    default: 'rgba(15, 15, 22, 0.45)',
};

// Fallback if blur crashes
const FALLBACK_BG: Record<string, string> = {
    dark: 'rgba(18, 18, 26, 0.72)',
    light: 'rgba(255, 255, 255, 0.18)',
    default: 'rgba(25, 25, 35, 0.65)',
};

// Global kill switch — one crash disables blur for ALL instances
let blurDisabled = false;

class BlurGuard extends Component<
    { fallback: string; children: React.ReactNode },
    { crashed: boolean }
> {
    state = { crashed: false };
    static getDerivedStateFromError() {
        blurDisabled = true;
        return { crashed: true };
    }
    componentDidCatch() {}
    render() {
        if (this.state.crashed) {
            return <View style={[StyleSheet.absoluteFill, { backgroundColor: this.props.fallback }]} />;
        }
        return this.props.children;
    }
}

export const GlassView = ({
    intensity = 45,
    tint = 'dark',
    style,
    children,
    ...rest
}: GlassViewProps) => {
    const tintBg = TINT_BG[tint] || TINT_BG.dark;
    const fallbackBg = FALLBACK_BG[tint] || FALLBACK_BG.dark;

    // Android: minimal intensity to prevent blue tint/glow artifacts
    // Max 15 — keeps blur subtle, no color artifacts
    const androidBlur = Math.min(15, Math.round(intensity * 0.2));

    return (
        <View style={[styles.container, style]} {...rest}>
            {/* iOS: native blur — works perfectly */}
            {!IS_ANDROID && (
                <BlurView
                    intensity={intensity}
                    tint={tint}
                    style={StyleSheet.absoluteFill}
                />
            )}

            {/* Android: real blur (low intensity, no tint) + separate color overlay */}
            {IS_ANDROID && !blurDisabled && (
                <BlurGuard fallback={fallbackBg}>
                    <BlurView
                        intensity={androidBlur}
                        tint="dark"
                        style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent' }]}
                        experimentalBlurMethod="dimezisBlurView"
                        blurReductionFactor={10}
                    />
                    {/* Color tint as separate layer — avoids additive blending glow */}
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: tintBg }]} />
                </BlurGuard>
            )}

            {/* Android fallback if blur globally disabled */}
            {IS_ANDROID && blurDisabled && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: fallbackBg }]} />
            )}

            {children}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
    },
});

export default GlassView;
