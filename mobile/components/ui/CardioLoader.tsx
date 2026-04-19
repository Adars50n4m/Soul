import React, { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  useAnimatedStyle,
  interpolate,
} from 'react-native-reanimated';

const AnimatedPath = Animated.createAnimatedComponent(Path);

interface CardioLoaderProps {
  size?: number | string;
  stroke?: number | string;
  speed?: number | string;
  color?: string;
}

/**
 * A native React Native implementation of the 'Cardio' loading effect
 * mimics the ldrs (Loading Indicators) aesthetic using SVG and Reanimated.
 */
export const CardioLoader = ({
  size = 50,
  stroke = 4,
  speed = 2,
  color = '#BC002A',
}: CardioLoaderProps) => {
  const s = typeof size === 'string' ? parseFloat(size) : size;
  const sw = typeof stroke === 'string' ? parseFloat(stroke) : stroke;
  const sp = typeof speed === 'string' ? parseFloat(speed) : speed;
  
  // Animation duration in ms (inverse of speed)
  const duration = 1500 / sp;

  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, {
        duration,
        easing: Easing.linear,
      }),
      -1,
      false
    );
  }, [duration]);

  // The path represents a single heartbeat cycle (ECG/EKG wave)
  // Normalized to 100x40 viewbox
  const pathData = "M0 20 L20 20 L25 5 L35 35 L45 0 L55 40 L60 20 L80 20 L100 20";
  
  // We'll use two paths to create the "traveling" pulse effect
  // 1. A dim background "trace"
  // 2. A bright foreground pulse that moves along the dash
  
  const animatedProps = useAnimatedProps(() => {
    // Length of the path is roughly 150 units for this data
    const length = 160; 
    return {
      strokeDasharray: [length * 0.4, length], // A pulse that is 40% of the path length
      strokeDashoffset: length * (1 - progress.value * 2), // Move it along
    };
  });

  return (
    <View style={{ width: s, height: s * 0.4, justifyContent: 'center', alignItems: 'center' }}>
      <Svg
        width={s}
        height={s * 0.4}
        viewBox="0 0 100 40"
        fill="none"
      >
        {/* Background dim line */}
        <Path
          d={pathData}
          stroke={color}
          strokeWidth={sw}
          strokeOpacity={0.15}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        
        {/* Animated pulse line */}
        <AnimatedPath
          d={pathData}
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          animatedProps={animatedProps}
        />
      </Svg>
    </View>
  );
};

export default CardioLoader;
