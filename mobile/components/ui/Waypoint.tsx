import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Dimensions, ViewStyle, StyleProp } from 'react-native';

export interface WaypointProps {
  /**
   * Function called when the waypoint enters the viewport.
   */
  onEnter?: () => void;
  /**
   * Function called when the waypoint leaves the viewport.
   */
  onLeave?: () => void;
  /**
   * Offset from the top/bottom of the screen to trigger the waypoint.
   * Defaults to 0.
   */
  offset?: number;
  /**
   * Whether to only trigger the waypoint once.
   * Defaults to false.
   */
  triggerOnce?: boolean;
  /**
   * Optional style for the waypoint container.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * Child components.
   */
  children?: React.ReactNode;
}

/**
 * Waypoint — A native replacement for `react-waypoint`.
 * Detects when a component enters or leaves the visible screen area.
 * 
 * Note: For high-performance lists, use FlashList's `onViewableItemsChanged`.
 * This component is best for one-off visibility triggers (e.g., lazy loading a specific section).
 */
export const Waypoint = ({
  onEnter,
  onLeave,
  offset = 0,
  triggerOnce = false,
  style,
  children,
}: WaypointProps) => {
  const containerRef = useRef<View>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasTriggered, setHasTriggered] = useState(false);

  useEffect(() => {
    if (triggerOnce && hasTriggered) return;

    const checkVisibility = () => {
      if (!containerRef.current) return;

      containerRef.current.measureInWindow((x, y, width, height) => {
        const screenHeight = Dimensions.get('window').height;
        const isCurrentlyVisible = y + height > -offset && y < screenHeight + offset;

        if (isCurrentlyVisible && !isVisible) {
          setIsVisible(true);
          onEnter?.();
          if (triggerOnce) setHasTriggered(true);
        } else if (!isCurrentlyVisible && isVisible) {
          setIsVisible(false);
          onLeave?.();
        }
      });
    };

    // Initial check
    const initialCheck = setTimeout(checkVisibility, 100);

    // Intersection observer isn't native, so we use a polling mechanism 
    // or call it on significant events. For simplicity in this replacement,
    // we use a short-interval check while active.
    const interval = setInterval(checkVisibility, 500);

    return () => {
      clearTimeout(initialCheck);
      clearInterval(interval);
    };
  }, [isVisible, hasTriggered, onEnter, onLeave, offset, triggerOnce]);

  return (
    <View ref={containerRef} style={style} onLayout={() => {}}>
      {children}
    </View>
  );
};

export default Waypoint;
