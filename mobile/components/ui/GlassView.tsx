import React from 'react';
import { View, StyleSheet, ViewProps, StyleProp, ViewStyle, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

export interface GlassViewProps extends ViewProps {
    intensity?: number;
    tint?: 'light' | 'dark' | 'default';
    style?: StyleProp<ViewStyle>;
    children?: React.ReactNode;
    experimentalBlurMethod?: 'none' | 'dimezisBlurView';
}

const IS_ANDROID = Platform.OS === 'android';

export const GlassView = ({
    intensity = 45,
    tint = 'dark',
    style,
    children,
    experimentalBlurMethod,
    ...rest
}: GlassViewProps) => {
    const isDark = tint === 'dark' || tint === 'default';
    
    // Safety Fallback Layer Styles
    // We always render a background and gradient on Android behind the blur.
    // This provides "safety" so if the blur fails (black screen), 
    // the user still sees the content on a nice background.
    const baseColor = isDark ? 'rgba(25, 25, 30, 0.75)' : 'rgba(255, 255, 255, 0.75)';
    const gradColors = isDark 
        ? ['rgba(40, 40, 50, 0.45)', 'rgba(20, 20, 30, 0.65)'] 
        : ['rgba(255, 255, 255, 0.5)', 'rgba(240, 240, 250, 0.3)'];

    return (
        <View style={[
            styles.container, 
            style,
            // Optimization for iOS shadow calculation: 
            // Providing a nearly-transparent background helps the shadow engine
            // calculate the shadow efficiently for views with shadows and no background.
            Platform.OS === 'ios' && { backgroundColor: 'rgba(0,0,0,0.01)' }
        ]}>
            {IS_ANDROID && (
                <>
                    {/* Level 1: Static background */}
                    <View style={[StyleSheet.absoluteFill, { backgroundColor: baseColor }]} />
                    {/* Level 2: Aesthetic Gradient */}
                    <LinearGradient
                        colors={gradColors as any}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={StyleSheet.absoluteFill}
                    />
                </>
            )}
            
            {/* Level 3: Native Blur (Highest visual quality) */}
            <BlurView
                intensity={intensity}
                tint={tint}
                style={StyleSheet.absoluteFill}
                experimentalBlurMethod={experimentalBlurMethod || (IS_ANDROID ? 'none' : undefined)}
                {...rest}
            />
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
