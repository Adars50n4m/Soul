/**
 * SoulSync Transition Configuration Constants
 *
 * Spring and timing presets for animations across the app.
 * Note: SharedTransition / sharedTransitionTag is not available
 * in react-native-reanimated 4.1.x (Expo SDK 54).
 */

import { Easing, SharedTransition, withSpring } from 'react-native-reanimated';

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

export const PROFILE_AVATAR_TRANSITION_TAG = 'avatar-universal-morph';

/**
 * We intentionally keep native shared-element transitions disabled on both
 * platforms and rely on the app's custom morph overlays instead.
 *
 * Why:
 * - Reanimated 3.x shared transitions remain experimental.
 * - Android is the main source of crashes and missing-tag glitches.
 * - iOS-only shared elements made the app feel different across platforms.
 *
 * The custom morph path in chat/home already gives us a premium transition
 * while keeping motion consistent on iOS and Android.
 */
export const SUPPORT_SHARED_TRANSITIONS = false;

/**
 * Targeted opt-in for the chat-avatar -> profile-hero transition.
 * This keeps the request-specific shared element path enabled without
 * re-enabling experimental shared transitions across the whole app.
 */
export const SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION = false;

export const PROFILE_AVATAR_SHARED_TRANSITION = SharedTransition.custom((values) => {
  'worklet';
  return {
    width: withSpring(values.targetWidth, { damping: 18, stiffness: 180, mass: 0.85 }),
    height: withSpring(values.targetHeight, { damping: 18, stiffness: 180, mass: 0.85 }),
    originX: withSpring(values.targetOriginX, { damping: 18, stiffness: 180, mass: 0.85 }),
    originY: withSpring(values.targetOriginY, { damping: 18, stiffness: 180, mass: 0.85 }),
    borderRadius: withSpring(values.targetBorderRadius, { damping: 18, stiffness: 180, mass: 0.85 }),
  };
}).progressAnimation((values, progress) => {
  'worklet';
  return {
    opacity: progress < 0.04 ? 0 : 1,
  };
});

export type SpringConfig = typeof LIQUID_GLASS_SPRING;
export type TimingConfig = typeof LIQUID_TIMING;
