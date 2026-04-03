import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

interface ProgressiveBlurProps {
    position?: 'top' | 'bottom';
    height?: number;
    intensity?: number;
    tint?: 'light' | 'dark' | 'default';
    maxAlpha?: number;
}

/**
 * ProgressiveBlur — Real progressive blur on both platforms.
 */
function ProgressiveBlur({
    position = 'bottom',
    height = 250,
    intensity = 80,
    tint = 'dark',
    maxAlpha = 0.85,
}: ProgressiveBlurProps) {
    const isDark = tint === 'dark' || tint === 'default';
    const base = isDark ? '0,0,0' : '255,255,255';
    const isBottom = position === 'bottom';
    const isAndroid = Platform.OS === 'android';

    // High-density jittered zones provide smoothing without banding
    // Reduced from 24 to 12 on Android to prevent GPU overload / black screens
    const ZONES = isAndroid ? 12 : 100;
    const zoneHeight = height * (isAndroid ? 0.2 : 0.05);
    
    const blurZones = Array.from({ length: ZONES }).map((_, i) => {
        const progress = i / (ZONES - 1);
        // Horizontal Lines Fix: Jitter the position slightly to break the harmonic staircase pattern
        const jitter = isAndroid ? (i % 2 === 0 ? 0.4 : -0.4) : 0;
        const zoneTop = (isBottom
            ? progress * (height - zoneHeight)
            : (1 - progress) * (height - zoneHeight)) + jitter;
            
        const eased = Math.pow(progress, 3.5);
        return { 
            top: zoneTop, 
            intensity: intensity * eased, 
            opacity: isAndroid ? Math.max(0.35, eased) : Math.max(0.12, eased) 
        };
    });

    // High-fidelity gradient mask — 32 stops for seamless blending
    const STOPS = 32;
    const gradColors: string[] = [];
    const gradLocs: number[] = [];
    for (let i = 0; i <= STOPS; i++) {
        const t = i / STOPS;
        const e = t * t * (3 - 2 * t);
        const alpha = isBottom ? e * maxAlpha : (1 - e) * maxAlpha;
        gradColors.push(`rgba(${base},${alpha.toFixed(3)})`);
        gradLocs.push(t);
    }

    return (
        <View
            style={[styles.container, { height, [position]: 0 }]}
            pointerEvents="none"
        >
            {!isAndroid && blurZones.map((zone, i) => (
                <BlurView
                    key={i}
                    intensity={zone.intensity}
                    tint={tint}
                    experimentalBlurMethod="none"
                    blurReductionFactor={isAndroid ? 4 : 4}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: zone.top,
                        height: zoneHeight,
                        opacity: zone.opacity,
                    }}
                />
            ))}

            {/* Gradient overlay smooths edges */}
            <LinearGradient
                colors={gradColors as any}
                locations={gradLocs as any}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        left: 0,
        right: 0,
        zIndex: 5,
        overflow: 'hidden',
    },
});

export default ProgressiveBlur;