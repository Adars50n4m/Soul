/**
 * SoulSync Transition Configuration Constants
 *
 * Spring and timing presets for animations across the app.
 * Note: SharedTransition / sharedTransitionTag is not available
 * in react-native-reanimated 4.1.x (Expo SDK 54).
 */

import { Easing } from 'react-native-reanimated';

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

export type SpringConfig = typeof LIQUID_GLASS_SPRING;
export type TimingConfig = typeof LIQUID_TIMING;
