import React, { useCallback } from 'react';
import { View, StyleSheet, Pressable, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  runOnJS,
} from 'react-native-reanimated';
import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const BTN   = 52;   // circle diameter
const GAP   = 8;    // gap between buttons
const PAD_R = 10;   // padding from right edge

// Snap-open: row shifts left enough to reveal all 3 circles + gaps + padding
const SNAP = -(BTN * 3 + GAP * 2 + PAD_R);   // ≈ -182

// Delete pill stretch: starts right after SNAP, triggers full-delete further left
const STRETCH_TRIGGER = -(SCREEN_WIDTH * 0.52);

interface SwipeableRowProps {
  children: React.ReactNode;
  onArchive: () => void;
  onDelete: () => void;
  /** Called on full-swipe — skips confirmation dialog. */
  onDeleteDirect?: () => void;
  onUnfriend: () => void;
}

export const SwipeableRow = ({
  children,
  onArchive,
  onDelete,
  onDeleteDirect,
  onUnfriend,
}: SwipeableRowProps) => {
  const tx = useSharedValue(0);
  const hapticFired = useSharedValue(false);

  const triggerHaptic = () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);

  const triggerDelete = useCallback(() => {
    (onDeleteDirect ?? onDelete)();
  }, [onDelete, onDeleteDirect]);

  const close = useCallback(
    (fn: () => void) => {
      tx.value = withSpring(0, { damping: 22, stiffness: 220, mass: 0.6 });
      fn();
    },
    [tx]
  );

  const pan = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-18, 18])
    .onUpdate((e) => {
      tx.value = Math.min(0, e.translationX);
      if (tx.value < STRETCH_TRIGGER && !hapticFired.value) {
        hapticFired.value = true;
        runOnJS(triggerHaptic)();
      } else if (tx.value >= STRETCH_TRIGGER) {
        hapticFired.value = false;
      }
    })
    .onEnd((e) => {
      if (tx.value < STRETCH_TRIGGER) {
        tx.value = withTiming(-SCREEN_WIDTH, { duration: 220 }, () =>
          runOnJS(triggerDelete)()
        );
        return;
      }
      const shouldOpen = tx.value < SNAP * 0.4 || e.velocityX < -500;
      tx.value = withSpring(shouldOpen ? SNAP : 0, {
        damping: 22,
        stiffness: 200,
        mass: 0.7,
      });
    });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  // Archive + Unfollow: scale in during normal reveal, fade out when delete stretches
  const sideStyle = useAnimatedStyle(() => {
    const scale = interpolate(
      tx.value,
      [SNAP, -BTN * 0.6, 0],
      [1, 0.75, 0],
      Extrapolation.CLAMP
    );
    const opacity = interpolate(
      tx.value,
      [SNAP - 20, SNAP],
      [0, 1],
      Extrapolation.CLAMP
    );
    return { opacity, transform: [{ scale }] };
  });

  // Delete: scale in during normal reveal → pill stretch (keeps borderRadius = BTN/2)
  const deleteStyle = useAnimatedStyle(() => {
    const x = tx.value;

    if (x >= SNAP) {
      // Normal reveal phase — circle scaling in
      const scale = interpolate(x, [SNAP, -BTN * 0.6, 0], [1, 0.75, 0], Extrapolation.CLAMP);
      return {
        width: BTN,
        height: BTN,
        borderRadius: BTN / 2,
        transform: [{ scale }],
      };
    }

    // Stretch phase — pill grows leftward, borderRadius stays half of BTN (pill shape)
    const width = interpolate(
      x,
      [STRETCH_TRIGGER, SNAP],
      [SCREEN_WIDTH * 0.82, BTN],
      Extrapolation.CLAMP
    );
    return {
      width,
      height: BTN,
      borderRadius: BTN / 2,   // always pill — never rectangular
      transform: [],
    };
  });

  return (
    <View style={styles.container}>
      <View style={styles.actionsLayer}>
        {/* Archive */}
        <Animated.View style={[styles.btn, sideStyle, { backgroundColor: '#f59e0b' }]}>
          <Pressable onPress={() => close(onArchive)} style={styles.pressable}>
            <MaterialIcons name="archive" size={22} color="#fff" />
          </Pressable>
        </Animated.View>

        {/* Unfollow */}
        <Animated.View style={[styles.btn, sideStyle, { backgroundColor: '#6b7280' }]}>
          <Pressable onPress={() => close(onUnfriend)} style={styles.pressable}>
            <MaterialIcons name="person-remove" size={21} color="#fff" />
          </Pressable>
        </Animated.View>

        {/* Delete — stretches into pill */}
        <Animated.View
          style={[styles.btn, deleteStyle, { backgroundColor: '#ef4444', overflow: 'hidden' }]}
        >
          <Pressable onPress={() => close(onDelete)} style={styles.pressable}>
            <MaterialIcons name="delete-outline" size={22} color="#fff" />
          </Pressable>
        </Animated.View>
      </View>

      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.content, rowStyle]}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    position: 'relative',
    marginBottom: 10,
  },
  actionsLayer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: PAD_R,
    gap: GAP,
  },
  btn: {
    width: BTN,
    height: BTN,
    borderRadius: BTN / 2,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  pressable: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    width: '100%',
    zIndex: 1,
  },
});

export default SwipeableRow;
