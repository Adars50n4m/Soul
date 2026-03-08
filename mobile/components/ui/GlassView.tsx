import React from 'react';
import { View, StyleSheet, ViewProps, StyleProp, ViewStyle, Platform } from 'react-native';
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
        return (
            <View style={[styles.container, style, { backgroundColor: tint === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.4)' }]}>
                <BlurView
                    intensity={Math.min(intensity * 1.5, 100)}
                    tint={tint}
                    style={StyleSheet.absoluteFill}
                />
                {children}
            </View>
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
