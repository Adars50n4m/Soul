import React from 'react';
import { View, StyleSheet, ViewStyle, StyleProp, Platform } from 'react-native';
import GlassView from './ui/GlassView';
import { LinearGradient } from 'expo-linear-gradient';

const isAndroid = Platform.OS === 'android';

interface LiquidGlassCardProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    intensity?: number;
    borderRadius?: number;
    glowColor?: string;
    variant?: 'default' | 'elevated' | 'subtle';
    interactive?: boolean;
}

/**
 * LiquidGlassCard - iOS-style glassmorphism card component
 * Creates a frosted glass effect with subtle glow and depth.
 * On Android, adds a dark translucent backing layer so the blur
 * has visible depth instead of appearing as a plain transparent shade.
 */
export const LiquidGlassCard: React.FC<LiquidGlassCardProps> = ({
    children,
    style,
    intensity = 60,
    borderRadius = 24,
    glowColor = 'rgba(244, 63, 94, 0.15)',
    variant = 'default',
    interactive = false,
}) => {
    const getVariantStyles = () => {
        switch (variant) {
            case 'elevated':
                return {
                    borderColor: 'rgba(255, 255, 255, 0.15)',
                    shadowOpacity: 0.4,
                };
            case 'subtle':
                return {
                    borderColor: 'rgba(255, 255, 255, 0.22)',
                    shadowOpacity: 0.1,
                };
            default:
                return {
                    borderColor: 'rgba(255, 255, 255, 0.22)',
                    shadowOpacity: 0.25,
                };
        }
    };

    const variantStyles = getVariantStyles();
    // Android dimezisBlurView needs higher intensity to look comparable to iOS
    const blurIntensity = isAndroid ? Math.min(intensity + 40, 100) : intensity;

    return (
        <View
            style={[
                styles.container,
                {
                    borderRadius,
                    borderColor: variantStyles.borderColor,
                    shadowOpacity: variantStyles.shadowOpacity,
                },
                style,
            ]}
        >

            {/* Glass Background */}
            <GlassView
                intensity={blurIntensity}
                tint="dark"
                style={[styles.blur, { borderRadius }]}
                
            >
                {/* Inner Glow Gradient */}
                <LinearGradient
                    colors={[
                        glowColor,
                        'transparent',
                        'transparent',
                    ]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.gradient, { borderRadius }]}
                />

                {/* Top Highlight */}
                <View style={[styles.topHighlight, { borderRadius }]} />

                {/* Content */}
                <View style={styles.content}>
                    {children}
                </View>
            </GlassView>
        </View>
    );
};

/**
 * LiquidGlassView - Simple glass panel for wrapping content
 */
export const LiquidGlassView: React.FC<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    intensity?: number;
}> = ({ children, style, intensity = 80 }) => {
    const blurIntensity = isAndroid ? Math.min(intensity + 20, 100) : intensity;
    return (
        <View style={[styles.glassViewWrapper, style]}>
            <GlassView
                intensity={blurIntensity}
                tint="dark"
                style={[styles.glassView, style]}
                
            >
                {children}
            </GlassView>
        </View>
    );
};

/**
 * GlassButton - Glass-styled pressable button
 */
export const GlassButton: React.FC<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    variant?: 'primary' | 'secondary' | 'ghost';
}> = ({ children, style, variant = 'primary' }) => {
    const getButtonColors = () => {
        switch (variant) {
            case 'primary':
                return {
                    bg: 'rgba(244, 63, 94, 0.2)',
                    border: 'rgba(244, 63, 94, 0.4)',
                };
            case 'secondary':
                return {
                    bg: 'rgba(255, 255, 255, 0.08)',
                    border: 'rgba(255, 255, 255, 0.15)',
                };
            case 'ghost':
                return {
                    bg: 'transparent',
                    border: 'rgba(255, 255, 255, 0.22)',
                };
        }
    };

    const colors = getButtonColors();

    return (
        <View
            style={[
                styles.glassButton,
                {
                    backgroundColor: colors.bg,
                    borderColor: colors.border,
                },
                style,
            ]}
        >
            {children}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        overflow: 'hidden',
        borderWidth: 1,
        // Shadow for depth
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowRadius: 24,
        elevation: 10,
    },
    blur: {
        overflow: 'hidden',
    },
    gradient: {
        ...StyleSheet.absoluteFillObject,
        opacity: 0.6,
    },
    topHighlight: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
    },
    content: {
        // Content wrapper
    },
    glassViewWrapper: {
        overflow: 'hidden',
    },
    glassView: {
        overflow: 'hidden',
    },
    glassButton: {
        borderWidth: 1,
        borderRadius: 20,
        overflow: 'hidden',
    },
});

export default LiquidGlassCard;
