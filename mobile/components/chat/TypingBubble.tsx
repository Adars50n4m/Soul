import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import { ChatStyles } from './ChatStyles';

// Renders as `ListHeaderComponent` on the *inverted* message FlatList —
// always mounted so the FlatList's contentSize doesn't jump when typing
// flips. Height + opacity animate based on `visible`, so older messages
// slide up smoothly to make room (no overlap with the latest bubble) and
// slide back down when typing stops. When a real message lands in the
// same beat, the new bubble's FadeInDown crossfades into where the
// typing dots were, giving the WhatsApp-style morph.

const BUBBLE_HEIGHT = 44;

const Dot = ({ delay }: { delay: number }) => {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 380, easing: Easing.out(Easing.cubic) }),
          withTiming(0, { duration: 380, easing: Easing.in(Easing.cubic) }),
        ),
        -1,
        false,
      ),
    );
  }, [delay, v]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.4 + v.value * 0.55,
    transform: [{ translateY: -2 * v.value }],
  }));
  return <Animated.View style={[styles.dot, style]} />;
};

export default function TypingBubble({ visible }: { visible: boolean }) {
  const progress = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(visible ? 1 : 0, {
      duration: 240,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
  }, [visible, progress]);

  const containerStyle = useAnimatedStyle(() => ({
    height: progress.value * BUBBLE_HEIGHT,
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 6 }],
  }));

  return (
    <Animated.View style={[styles.container, containerStyle]} pointerEvents="none">
      <View style={styles.row}>
        <View
          style={[
            ChatStyles.bubbleContainer,
            ChatStyles.bubbleContainerThem,
            styles.bubble,
          ]}
        >
          <View style={styles.dotsRow}>
            <Dot delay={0} />
            <Dot delay={140} />
            <Dot delay={280} />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 12,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.85)',
    marginHorizontal: 2,
  },
});
