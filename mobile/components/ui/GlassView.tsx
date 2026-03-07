import React from 'react';
import { StyleSheet, ViewProps, StyleProp, ViewStyle, Platform } from 'react-native';
import { BlurView } from 'expo-blur';

export interface GlassViewProps extends ViewProps {
    intensity?: number;
    tint?: 'light' | 'dark' | 'default';
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
}

export const GlassView = ({
    intensity = 45,
    tint = 'dark',
    style,
    children,
    ...rest
}: GlassViewProps) => {
    if (Platform.OS === 'android') {
        // On Android, use dimezisBlurView for real backdrop blur.
        // blurReductionFactor reduces the perceived intensity on Android
        // to match iOS visually. Increase intensity to compensate for the reduction.
        return (
            <BlurView
                intensity={Math.min(intensity * 2.5, 100)}
                tint={tint}
                experimentalBlurMethod="dimezisBlurView"
                blurReductionFactor={4}
                style={[styles.container, style]}
                {...rest}
            >
                {children}
            </BlurView>
        );
    }

    return (
        <BlurView
            intensity={intensity}
            tint={tint}
            style={[styles.container, style]}
            {...rest}
        >
            {children}
        </BlurView>
    );
};

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
    },
});

export default GlassView;
