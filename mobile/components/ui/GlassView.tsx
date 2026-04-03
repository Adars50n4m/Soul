import React from 'react';
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

export const GlassView = ({
    intensity = 45,
    tint = 'dark',
    style,
    children,
    experimentalBlurMethod,
    disableExperimental = false,
    ...rest
}: GlassViewProps) => {
    // If not Android, handle blur normally.
    // If Android, disable BlurView entirely because it's causing total black screens on many devices.
    const blurMethod = disableExperimental 
        ? 'none' 
        : (experimentalBlurMethod || (IS_ANDROID ? 'none' : 'none'));

    // Android needs a slightly higher intensity to match iOS visual density.
    const resolvedIntensity = IS_ANDROID ? Math.min(100, intensity * 1.15) : intensity;

    // Reduction factor: higher = less blur radius for same intensity.
    const blurReduction = IS_ANDROID ? 3 : 4;
    
    // Fallback background color to prevent total black screen.
    // Increased opacity slightly to maintain the glass feel without real blur.
    const androidTintColor = tint === 'dark' ? 'rgba(30,30,40,0.72)' : 'rgba(255,255,255,0.18)';

    return (
        <View style={[styles.container, style]}>
            {!IS_ANDROID && (
                <BlurView
                    intensity={resolvedIntensity}
                    tint={tint}
                    style={StyleSheet.absoluteFill}
                    experimentalBlurMethod={blurMethod}
                    blurReductionFactor={blurReduction}
                    {...rest}
                />
            )}
            
            {IS_ANDROID && (
                <View 
                    style={[
                        StyleSheet.absoluteFill, 
                        { backgroundColor: androidTintColor }
                    ]} 
                />
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
