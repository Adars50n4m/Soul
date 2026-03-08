import React from 'react';
import { ViewStyle, StyleProp } from 'react-native';
import { Stagger } from '@animatereactnative/stagger';
import { FadeInDown, FadeOutDown } from 'react-native-reanimated';

interface StaggeredViewProps {
  /**
   * Children to apply staggered animations to.
   */
  children: React.ReactNode;
  /**
   * Delay between each child animation in milliseconds.
   * Defaults to 50ms.
   */
  stagger?: number;
  /**
   * Duration of the animation for each child.
   * Defaults to 400ms.
   */
  duration?: number;
  /**
   * Direction of the entering animation (1 for top-to-bottom, -1 for bottom-to-top).
   * Defaults to 1.
   */
  enterDirection?: number;
  /**
   * Direction of the exiting animation.
   * Defaults to -1.
   */
  exitDirection?: number;
  /**
   * Initial delay before the first animation starts.
   */
  initialEnteringDelay?: number;
  /**
   * Style for the container view.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * Custom entering animation function.
   * Defaults to FadeInDown.
   */
  entering?: () => any;
  /**
   * Custom exiting animation function.
   * Defaults to FadeOutDown.
   */
  exiting?: () => any;
}

/**
 * StaggeredView — A global component for smooth, sequenced entry/exit animations.
 * 
 * Perfect for:
 * - Onboarding flows
 * - List item entries
 * - Grid/Gallery animations
 * - Any sequential UI revealing
 */
export const StaggeredView = ({
  children,
  stagger = 50,
  duration = 400,
  enterDirection = 1,
  exitDirection = -1,
  initialEnteringDelay = 0,
  style,
  entering = () => FadeInDown.duration(400),
  exiting = () => FadeOutDown.duration(400),
}: StaggeredViewProps) => {
  return (
    <Stagger
      stagger={stagger}
      duration={duration}
      enterDirection={enterDirection}
      exitDirection={exitDirection}
      initialEnteringDelay={initialEnteringDelay}
      entering={entering}
      exiting={exiting}
      style={style}
    >
      {children}
    </Stagger>
  );
};

export default StaggeredView;
