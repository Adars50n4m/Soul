/**
 * Soul Transition Configuration Constants
 *
 * Spring and timing presets for animations across the app.
 * Note: SharedTransition / sharedTransitionTag is not available
 * in react-native-reanimated 4.1.x (Expo SDK 54).
 */

import { Platform } from 'react-native';
import { Easing, ReduceMotion, SharedTransition, withSpring } from 'react-native-reanimated';

// ─────────────────────────────────────────────────────────────────────────────
// SPRING CONFIGURATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const LIQUID_GLASS_SPRING = {
  damping: 28,
  stiffness: 320,
  mass: 0.8,
  overshootClamping: false,
} as const;

export const SNAPPY_SPRING = {
  damping: 20,
  stiffness: 400,
  mass: 0.6,
  overshootClamping: false,
} as const;

export const GENTLE_SPRING = {
  damping: 32,
  stiffness: 200,
  mass: 1.2,
  overshootClamping: false,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TIMING CONFIGURATIONS
// ─────────────────────────────────────────────────────────────────────────────

export const LIQUID_TIMING = {
  duration: 450,
  easing: Easing.bezier(0.2, 0.95, 0.2, 1),
} as const;

export const FAST_TIMING = {
  duration: 280,
  easing: Easing.bezier(0.33, 0, 0, 1),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TAG GENERATORS (for future shared element transition support)
// ─────────────────────────────────────────────────────────────────────────────

export const SharedTransitionTags = {
  avatar: (userId: string) => `avatar-${userId}`,
  chatCard: (chatId: string) => `chat-card-${chatId}`,
  chatName: (chatId: string) => `chat-name-${chatId}`,
  media: (messageId: string, mediaIndex: number = 0) => `media-${messageId}-${mediaIndex}`,
  status: (statusId: string) => `status-${statusId}`,
  profilePicture: (userId: string) => `profile-picture-${userId}`,
  profileCard: () => 'profile-card-shell',
} as const;

export const getProfileAvatarTransitionTag = (userId: string) =>
  SharedTransitionTags.profilePicture(userId);

export const PROFILE_AVATAR_TRANSITION_TAG = 'avatar-universal-morph';

/**
 * We are now using native Reanimated 3 shared-element transitions for the 
 * profile avatar morph, as it provides a much more "liquid" and hardware-accelerated 
 * feel compared to manual JS-thread overlays.
 *
 * Configuration:
 * - PROFILE_AVATAR_SHARED_TRANSITION handles the path interpolation (rect <-> circle).
 * - SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION toggles the feature globally.
 */
export const SUPPORT_SHARED_TRANSITIONS = true;

/**
 * Targeted opt-in for the chat-avatar -> profile-hero transition.
 * We keep this limited to iOS for now because the current Android build
 * still relies on the older measured morph fallback.
 */
export const SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION = false;

export const PROFILE_AVATAR_SHARED_TRANSITION = SharedTransition.custom((values) => {
  'worklet';
  const liquidSpring = { damping: 26, stiffness: 210, mass: 1.1, reduceMotion: ReduceMotion.Never };
  return {
    width: withSpring(values.targetWidth, liquidSpring),
    height: withSpring(values.targetHeight, liquidSpring),
    originX: withSpring(values.targetOriginX, liquidSpring),
    originY: withSpring(values.targetOriginY, liquidSpring),
    borderRadius: withSpring(values.targetBorderRadius, { ...liquidSpring, damping: 28, stiffness: 280 }), 
  };
}).progressAnimation((values, progress) => {
  'worklet';
  return {
    opacity: 1, // Visible instantly for the expand feel
  };
});

export type SpringConfig = typeof LIQUID_GLASS_SPRING;
export type TimingConfig = typeof LIQUID_TIMING;
