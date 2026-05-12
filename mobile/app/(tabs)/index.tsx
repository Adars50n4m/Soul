console.log('[HomeIndex] Module executing...');
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  StatusBar,
  Alert,
  FlatList,
  Platform,
} from 'react-native';
import { Svg, Circle } from 'react-native-svg';
// FlashList available but FlatList used for stability
// import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import GlassView from '../../components/ui/GlassView';
import { GlassChipButton, GlassPillSurface } from '../../components/ui/IOS26Primitives';
import ConnectionBanner from '../../components/ConnectionBanner';
import { SoulPullToRefresh } from '../../components/ui/SoulPullToRefresh';
import ChatListItemSkeleton from '../../components/ui/ChatListItemSkeleton';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  Easing,
  interpolate,
  Extrapolation,
  useDerivedValue,
  SharedTransition,
  interpolateColor,
  useAnimatedProps,
} from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import {
    cacheDirectory,
    documentDirectory,
    copyAsync,
} from 'expo-file-system';
import { hapticService } from '../../services/HapticService';
import * as Haptics from 'expo-haptics'; // Keeping for type styles if needed, but will swap calls
// import { storageService } from '../../services/StorageService';
import { proxySupabaseUrl } from '../../config/api';
import { chatTransitionState } from '../../services/chatTransitionState';
import SwipeableRow from '../../components/ui/SwipeableRow';
import { profileAvatarTransitionState } from '../../services/profileAvatarTransitionState';
import { myStatusTransitionState } from '../../services/myStatusTransitionState';
import { resolveAvatarImageUri, warmAvatarSource } from '../../utils/avatarSource';

import { useApp } from '../../context/AppContext';
import { supabase } from '../../config/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePresence } from '../../context/PresenceContext';
import { useScrollMotion } from '../../components/navigation/ScrollMotionProvider';
import { normalizeId, getSuperuserName, LEGACY_TO_UUID, UUID_TO_LEGACY } from '../../utils/idNormalization';
import { setStatusMorphOrigin } from '../../utils/statusMorphOrigins';
import {
  getProfileAvatarTransitionTag,
  PROFILE_AVATAR_SHARED_TRANSITION,
  SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION,
  SOUL_LIQUID_TRANSITION,
} from '../../constants/sharedTransitions';

import LottieView from 'lottie-react-native';
import { SoulAvatar } from '../../components/SoulAvatar';
import { StatusThumbnail } from '../../components/StatusThumbnail';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { Contact } from '../../types';
import { NoteBubble } from '../../components/NoteBubble';
import { NoteCreatorModal } from '../../components/NoteCreatorModal';
import ChatListContextMenu from '../../components/chat/ChatListContextMenu';
const DEFAULT_AVATAR = '';
const HOME_MORPH_DURATION = 500;
const ENABLE_PROFILE_AVATAR_SHARED_TRANSITION = SUPPORT_PROFILE_AVATAR_SHARED_TRANSITION;

const statusTransition = SOUL_LIQUID_TRANSITION;

const resolveStatusAssetUri = async (asset: ImagePicker.ImagePickerAsset): Promise<string> => {
  let resolvedUri = asset.uri;

  if (resolvedUri.startsWith('ph://') && asset.assetId) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.assetId);
      resolvedUri = info.localUri || info.uri || resolvedUri;
    } catch {
      // Fall back to original URI if asset info fails.
    }
  }

  // iOS captures photos as HEIC by default, but our R2 worker only accepts
  // jpg/png/webp/mp4/mov. Transcode HEIC → JPEG before caching so the upload
  // round-trip succeeds and the worker doesn't reject it as "Invalid file type".
  const rawExt = (asset.fileName?.split('.').pop() || resolvedUri.split('.').pop() || '').toLowerCase();
  const isImage = asset.type !== 'video';
  const isHeic = isImage && (rawExt === 'heic' || rawExt === 'heif');
  if (isHeic) {
    try {
      const result = await ImageManipulator.manipulateAsync(resolvedUri, [], {
        format: ImageManipulator.SaveFormat.JPEG,
        compress: 0.92,
      });
      resolvedUri = result.uri;
    } catch (err) {
      console.warn('[resolveStatusAssetUri] HEIC → JPEG conversion failed, falling back to original:', err);
    }
  }

  // Persist picked media into app cache so viewer/home preview can read reliably.
  if (resolvedUri.startsWith('file://')) {
    const ext = isHeic ? 'jpg' : (asset.fileName?.split('.').pop() || (asset.type === 'video' ? 'mp4' : 'jpg'));
    const cacheDir = cacheDirectory || documentDirectory;
    if (!cacheDir) return resolvedUri;
    const target = `${cacheDir}status-${Date.now()}.${ext}`;
    try {
      await copyAsync({ from: resolvedUri, to: target });
      resolvedUri = target;
    } catch {
      // Keep original file URI if copy fails.
    }
  }

  return resolvedUri;
};

// ─── Stable style objects (extracted to avoid inline object creation in render) ──
const typingStyle = { color: '#22c55e', fontWeight: '700' as const };
const formatTime = (ts: string) => {
  if (!ts) return '';
  try {
    const date = new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  } catch (e) {
    return ts;
  }
};
// Remove global hasRenderedHomeOnce flag

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

interface ChatListItemProps {
  item: Contact;
  index: number;
  lastMsg: { text?: string; timestamp?: string };
  onSelect: (contact: Contact, y: number) => void;
  onLongPress: (contact: Contact, layout: any) => void;
  isTyping: boolean;
  getPresence: (userId: string) => { isOnline: boolean; lastSeen: string | null };
  connectivity: { isDeviceOnline: boolean; isServerReachable: boolean; isRealtimeConnected: boolean };
  homeMorphProgress: Animated.SharedValue<number>;
  selectedPillId: Animated.SharedValue<string>;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean;
  isClone?: boolean;
  isSelected?: boolean;
  onAvatarPress?: (contact: Contact, layout: { x: number, y: number, width: number, height: number }) => void;
  isScreenFocused: boolean;
  profileAvatarTransition: ReturnType<typeof profileAvatarTransitionState.getState>;
}

const ChatListItem = React.memo(({ item, index, lastMsg, onSelect, onLongPress, isTyping, getPresence, connectivity, homeMorphProgress, selectedPillId, unreadCount, isPinned, isMuted, isClone, isSelected, onAvatarPress, isScreenFocused, profileAvatarTransition }: ChatListItemProps) => {
  const { activeTheme } = useApp();
  // Helper to resolve colors
  const withAlpha = (color: string, alpha: number): string => {
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const normalized = hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex;
      if (normalized.length === 6) {
        return `rgba(${parseInt(normalized.slice(0, 2), 16)}, ${parseInt(normalized.slice(2, 4), 16)}, ${parseInt(normalized.slice(4, 6), 16)}, ${alpha})`;
      }
    }
    if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
    if (color.startsWith('rgba(')) return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
    return color;
  };
  const scaleAnim = useSharedValue(1);
  const opacityAnim = useSharedValue(1);
  const itemRef = useRef<View>(null);
  const avatarShellRef = useRef<View>(null);
  const normalizedProfileId = useMemo(() => normalizeId(item.id), [item.id]);
  const profileAvatarTransitionTag = useMemo(
    () => (normalizedProfileId ? getProfileAvatarTransitionTag(normalizedProfileId) : undefined),
    [normalizedProfileId]
  );
  const profilePreviewAvatarSource = useMemo(() => resolveAvatarImageUri({
    uri: item.avatar,
    localUri: item.localAvatarUri,
    avatarType: (item.avatarType as any) || 'default',
    teddyVariant: (item.teddyVariant as any),
    fallbackId: item.id || 'default',
  }), [item.avatar, item.avatarType, item.id, item.localAvatarUri, item.teddyVariant]);
  const shouldHideAvatarSource = !!normalizedProfileId
    && profileAvatarTransition.phase === 'presented'
    && normalizeId(profileAvatarTransition.profileId || '') === normalizedProfileId;

  // Avatar shell (story-glow shadow + GlassPillSurface ring border) needs to
  // re-appear in lockstep with the profile dismiss morph (320ms). A static
  // 0→1 flip on `phase !== 'presented'` was making the ring "pop in" after
  // the morphing hero landed, because it was hidden behind the SheetScreen
  // bg until the very last frame. Driving it as a delayed fade synchronizes
  // the ring's reveal with the back-half of the morph, when the shrinking
  // hero stops covering the pill.
  const avatarShellOpacity = useSharedValue(shouldHideAvatarSource ? 0 : 1);
  useEffect(() => {
    if (shouldHideAvatarSource) {
      avatarShellOpacity.value = 0; // Instant on present so the entry morph is clean
      return;
    }
    avatarShellOpacity.value = withDelay(
      120,
      withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) })
    );
  }, [shouldHideAvatarSource, avatarShellOpacity]);
  const avatarShellAnimatedStyle = useAnimatedStyle(() => ({
    opacity: avatarShellOpacity.value,
  }));

  useEffect(() => {
    if (!profilePreviewAvatarSource) return;
    void warmAvatarSource(profilePreviewAvatarSource);
  }, [profilePreviewAvatarSource]);

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    // Only apply shifts and scales to UNSELECTED items to clear them out.
    // The SELECTED item should stay perfectly still relative to its container for the Shared Transition.
    const isItemSelected = selectedPillId.value === item.id;
    
    if (Platform.OS === 'android') {
      return {
        transform: [{ scale: scaleAnim.value }],
        opacity: isItemSelected ? 1 : opacityAnim.value * interpolate(homeMorphProgress.value, [0, 0.9], [1, 0], Extrapolation.CLAMP),
      };
    }

    const translateShift = isItemSelected ? 0 : interpolate(homeMorphProgress.value, [0, 1], [0, 20 + (index % 5) * 15], Extrapolation.IDENTITY);
    const scaleShift = isItemSelected ? 1 : interpolate(homeMorphProgress.value, [0, 1], [1, 0.92], Extrapolation.IDENTITY);

    return {
      transform: [
        { scale: scaleAnim.value } as any,
        { translateY: translateShift } as any,
        { scale: scaleShift } as any
      ],
      opacity: isClone ? 1 : opacityAnim.value * interpolate(homeMorphProgress.value, [0, 0.9], [1, 0], Extrapolation.CLAMP),
    };
  });

  const [pressed, setPressed] = useState(false);

  const handlePressIn = useCallback(() => {
    setPressed(true);
    scaleAnim.value = withSpring(0.96, { damping: 15, stiffness: 300 });
    opacityAnim.value = withTiming(0.92, { duration: 90 });
  }, []);

  const handlePressOut = useCallback(() => {
    setPressed(false);
    scaleAnim.value = withSpring(1, { damping: 15, stiffness: 300 });
    opacityAnim.value = withTiming(1, { duration: 120 });
  }, []);

  const handlePress = useCallback(() => {
    const node = itemRef.current;
    if (!node) {
      onSelect(item, 0);
      return;
    }
    try {
      node.measure((_x, _y, _w, _h, _pageX, pageY) => {
        // measure() can fire with undefined coords when the view is
        // detaching, hidden, or mid-animation. Fall back to 0 so the
        // navigation push doesn't crash with `Cannot read 'toString' of
        // undefined` in handleUserSelect.
        onSelect(item, typeof pageY === 'number' ? pageY : 0);
      });
    } catch {
      onSelect(item, 0);
    }
  }, [item, onSelect]);

  return (
    <Pressable
      ref={itemRef}
      onPress={handlePress}
      onLongPress={() => {
        if (isClone) return;
        itemRef.current?.measure((x, y, width, height, pageX, pageY) => {
          onLongPress(item, { x: pageX, y: pageY, width, height });
        });
      }}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={styles.chatItem}
    >
      {/* Outer container — manual morph in chat screen handles the pill expansion */}
      <View
        style={styles.chatPillContainer}
      >
        {isSelected && (
          <View style={{ position: 'absolute', top: 16, right: 16, zIndex: 5, backgroundColor: '#ff4444', borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
            <MaterialIcons name="check" size={16} color="#fff" />
          </View>
        )}
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
            {/* Avatar Pill - Separate circular glass surface with Story Logic */}
            <Animated.View
              collapsable={false}
              ref={avatarShellRef}
              style={[
              avatarShellAnimatedStyle,
              item.stories && item.stories.length > 0 && item.stories.some((s) => !s.seen) && {
                shadowColor: activeTheme.primary,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 0.8,
                shadowRadius: 10,
                elevation: 10,
                borderRadius: 28,
              }
            ]}>
              <Pressable
                onPressIn={(event) => {
                  event.stopPropagation?.();
                }}
                onPressOut={(event) => {
                  event.stopPropagation?.();
                }}
                onPress={(event) => {
                  event.stopPropagation?.();
                  if (onAvatarPress) {
                    const node = avatarShellRef.current;
                    if (node && typeof (node as any).measureInWindow === 'function') {
                      (node as any).measureInWindow((pageX: number, pageY: number, w: number, h: number) => {
                        onAvatarPress(item, { x: pageX, y: pageY, width: w, height: h });
                      });
                    } else if (node && typeof (node as any).measure === 'function') {
                      (node as any).measure((_x: number, _y: number, w: number, h: number, pageX: number, pageY: number) => {
                        onAvatarPress(item, { x: pageX, y: pageY, width: w, height: h });
                      });
                    } else {
                      // Use the press layout if measurement fails, never hardcoded 20/400
                      itemRef.current?.measure((_x, _y, w, h, pageX, pageY) => {
                        onAvatarPress(item, { x: pageX || 20, y: pageY || 400, width: w || 56, height: h || 56 });
                      });
                    }
                  }
                }}
              >
                <GlassPillSurface
                  radius={28}
                  intensity={35}
                  selected={isSelected}
                  selectedColor="#ff4444"
                  pressed={pressed}
                  pressColor={activeTheme.primary}
                  borderColor={
                    item.stories && item.stories.length > 0
                      ? (item.stories.some(s => !s.seen) ? activeTheme.primary : withAlpha(activeTheme.primary, 0.4))
                      : 'rgba(255,255,255,0.14)'
                  }
                  style={{ width: 56, height: 56 }}
                  contentStyle={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
                >
                  <View style={styles.avatarContainer}>
                    <SoulAvatar
                      uri={proxySupabaseUrl(item.avatar) || DEFAULT_AVATAR}
                      localUri={item.localAvatarUri}
                      size={46}
                      avatarType={item.avatarType}
                      teddyVariant={item.teddyVariant}
                      isOnline={getPresence(item.id).isOnline}
                      sharedTransitionTag={ENABLE_PROFILE_AVATAR_SHARED_TRANSITION ? profileAvatarTransitionTag : undefined}
                      sharedTransition={ENABLE_PROFILE_AVATAR_SHARED_TRANSITION ? PROFILE_AVATAR_SHARED_TRANSITION : undefined}
                      allowExperimentalSharedTransition={ENABLE_PROFILE_AVATAR_SHARED_TRANSITION}
                    />
                  </View>
                </GlassPillSurface>
              </Pressable>
            </Animated.View>

            {/* Message Content Pill - Separate elongated glass surface */}
            <GlassPillSurface
              radius={28}
              intensity={35}
              selected={isSelected}
              selectedColor="#ff4444"
              pressed={pressed}
              pressColor={activeTheme.primary}
              style={{ flex: 1, height: 56 }}
              contentStyle={[styles.pillContent, { paddingLeft: 16 }]}
            >
              <View style={styles.chatContent}>
                <Text style={styles.contactName}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={isTyping ? [styles.lastMessage, typingStyle] : styles.lastMessage}>
                  {isTyping ? 'Typing...' : (lastMsg.text || 'Start a conversation')}
                </Text>
              </View>

              <View style={styles.rightSide}>
                {lastMsg.timestamp && <Text style={styles.timestamp}>{formatTime(lastMsg.timestamp)}</Text>}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {isMuted && <MaterialIcons name="volume-off" size={12} color="rgba(255,255,255,0.45)" />}
                  {isPinned && <MaterialIcons name="push-pin" size={12} color="#facc15" />}
                  {unreadCount > 0 && (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                    </View>
                  )}
                </View>
              </View>
            </GlassPillSurface>
          </View>
        </Animated.View>
      </View>
    </Pressable>
  );
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render when meaningful data changes.
  // Every prop that drives a visible difference MUST be listed here —
  // omissions silently freeze the row. Past omissions:
  //   - localAvatarUri/avatarType: blocked group avatar updates
  //   - isSelected: blocked the multi-select checkmark on the 2nd+ tap
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.item.name === nextProps.item.name &&
    prevProps.item.avatar === nextProps.item.avatar &&
    prevProps.item.localAvatarUri === nextProps.item.localAvatarUri &&
    prevProps.item.avatarType === nextProps.item.avatarType &&
    prevProps.item.teddyVariant === nextProps.item.teddyVariant &&
    prevProps.item.status === nextProps.item.status &&
    prevProps.item.stories?.length === nextProps.item.stories?.length &&
    prevProps.item.stories?.some(s => !s.seen) === nextProps.item.stories?.some(s => !s.seen) &&
    prevProps.lastMsg.text === nextProps.lastMsg.text &&
    prevProps.lastMsg.timestamp === nextProps.lastMsg.timestamp &&
    prevProps.isTyping === nextProps.isTyping &&
    prevProps.unreadCount === nextProps.unreadCount &&
    prevProps.isPinned === nextProps.isPinned &&
    prevProps.isMuted === nextProps.isMuted &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isScreenFocused === nextProps.isScreenFocused &&
    prevProps.profileAvatarTransition.phase === nextProps.profileAvatarTransition.phase &&
    prevProps.profileAvatarTransition.profileId === nextProps.profileAvatarTransition.profileId &&
    prevProps.onSelect === nextProps.onSelect &&
    prevProps.getPresence(prevProps.item.id).isOnline === nextProps.getPresence(nextProps.item.id).isOnline
  );
});

ChatListItem.displayName = 'ChatListItem';

// Telegram-style card morph: rectangular card → circular avatar on scroll.
const StatusCardWrapper = React.memo(({
  children,
  index,
  item,
  avatarOverlay,
  railCollapseProgress,
  homeMorphProgress,
  selectedPillId,
  statusTransition,
}: {
  children: React.ReactNode;
  index: number;
  item: any;
  avatarOverlay?: React.ReactNode;
  railCollapseProgress: Animated.SharedValue<number>;
  homeMorphProgress: Animated.SharedValue<number>;
  selectedPillId: Animated.SharedValue<string>;
  statusTransition: any;
}) => {
  const cardStyle = useAnimatedStyle(() => {
    'worklet';
    const p = railCollapseProgress.value;
    const w = interpolate(p, [0, 1], [115, 56], Extrapolation.CLAMP);
    const h = interpolate(p, [0, 1], [175, 56], Extrapolation.CLAMP);
    const borderRadius = 28;
    const translateX = interpolate(p, [0, 1], [0, -index * 18], Extrapolation.CLAMP);
    return {
      width: w,
      height: h,
      borderRadius,
      transform: [{ translateX }] as any,
      opacity: selectedPillId.value === item.id
        ? 1
        : interpolate(homeMorphProgress.value, [0, 0.9], [1, 0], Extrapolation.CLAMP),
    };
  });

  const chromeStyle = useAnimatedStyle(() => {
    'worklet';
    const p = railCollapseProgress.value;
    const morphP = homeMorphProgress.value;
    const isSelected = selectedPillId.value === item.id;
    
    return {
      opacity: interpolate(p, [0, 0.55], [1, 0], Extrapolation.CLAMP) * 
               (isSelected ? 1 : interpolate(morphP, [0, 0.9], [1, 0], Extrapolation.CLAMP)),
    };
  });

  const overlayStyle = useAnimatedStyle(() => {
    'worklet';
    const p = railCollapseProgress.value;
    return {
      opacity: interpolate(p, [0.45, 1], [0, 1], Extrapolation.CLAMP),
      transform: [
        { scale: interpolate(p, [0.45, 1], [0.6, 1], Extrapolation.CLAMP) },
      ] as any,
    };
  });

  const statusSharedTransitionProps = item.id === 'my-status'
    ? {}
    : ({
        sharedTransitionTag: `status-hero-${item.id}`,
        sharedTransition: statusTransition,
      } as any);

  return (
    <Animated.View 
      style={[styles.statusCard, cardStyle as any]}
      {...statusSharedTransitionProps}
    >
      <Animated.View style={[StyleSheet.absoluteFill, chromeStyle]}>
        {children}
      </Animated.View>
      {avatarOverlay ? (
        <Animated.View 
          style={[StyleSheet.absoluteFill, styles.statusAvatarOverlay, overlayStyle as any]}
          pointerEvents="none"
        >
          {avatarOverlay}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

const AnimatedMoreMenu = ({ router, isSearching }: { router: any, isSearching: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, { duration: 220, easing: Easing.out(Easing.cubic) });
  }, [expanded]);

  useEffect(() => {
    if (isSearching) setExpanded(false);
  }, [isSearching]);

  const containerStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      width: interpolate(progress.value, [0, 1], [40, 200]),
      height: interpolate(progress.value, [0, 1], [40, 270]),
      borderRadius: interpolate(progress.value, [0, 1], [20, 16]),
      backgroundColor: interpolateColor(progress.value, [0, 1], ['rgba(255,255,255,0.08)', 'rgba(0,0,0,0.6)']),
      borderWidth: 1,
      borderColor: interpolateColor(progress.value, [0, 1], ['rgba(255,255,255,0.1)', 'rgba(255,255,255,0.2)']),
    };
  });

  const iconStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: interpolate(progress.value, [0, 0.4], [1, 0]),
      transform: [
        { scale: interpolate(progress.value, [0, 0.5], [1, 0.2]) },
        { rotate: `${interpolate(progress.value, [0, 1], [0, 90])}deg` }
      ] as any,
    };
  });

  const menuStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: interpolate(progress.value, [0.6, 1], [0, 1]),
      transform: [{ translateY: interpolate(progress.value, [0, 1], [-10, 0]) }],
    };
  });

  const animatedGlassProps = useAnimatedProps(() => {
    return {
      intensity: 30 + (progress.value * 20),
    };
  });

  // Backdrop uses a simple fullscreen overlay instead of measuring Dimensions every render
  return (
    <View style={[{ zIndex: expanded ? 1000 : 1, width: 40, height: 40 }]}>
      {expanded && (
         <Pressable
           style={StyleSheet.flatten([StyleSheet.absoluteFillObject, { position: 'absolute', top: -500, right: -500, width: 2000, height: 2000, zIndex: 1 }])}
           onPress={() => setExpanded(false)}
         />
      )}
      <Animated.View style={[
        { position: 'absolute', top: 0, right: 0, overflow: 'hidden', zIndex: 10 },
        containerStyle
      ]}>
        <AnimatedGlassView 
          animatedProps={animatedGlassProps} 
          tint="dark" 
          style={{ flex: 1, backgroundColor: 'transparent' }}
        >
          {/* Menu Items */}
          <Animated.View style={[StyleSheet.absoluteFill, menuStyle, { paddingVertical: 0, justifyContent: 'flex-start' }]} pointerEvents={expanded ? 'auto' : 'none'}>
             {/* Cancel/Cut Option - Takes the exact position of the original 3-dots */}
             <View style={{ flexDirection: 'row', justifyContent: 'flex-end', height: 40, width: '100%', alignItems: 'center', paddingRight: 4 }}>
                <Pressable onPress={() => setExpanded(false)} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}>
                  <MaterialIcons name="close" size={22} color="#fff" />
                </Pressable>
             </View>

             <View style={[styles.moreMenuDividerMorph, { marginHorizontal: 0, opacity: 0.3 }]} />

             <Pressable 
                style={styles.moreMenuItemMorph}
                onPress={() => { setExpanded(false); router.push('/create-group'); }}
              >
                <MaterialIcons name="group-add" size={20} color="#fff" style={styles.moreMenuIconMorph} />
                <Text style={styles.moreMenuTextMorph}>New Group</Text>
              </Pressable>

              <View style={styles.moreMenuDividerMorph} />

              <Pressable 
                 style={styles.moreMenuItemMorph}
                 onPress={() => { setExpanded(false); router.push('/search?context=soulmate'); }}
              >
                <MaterialIcons name="person-search" size={20} color="#fff" style={styles.moreMenuIconMorph} />
                <Text style={styles.moreMenuTextMorph}>Find Soulmates</Text>
              </Pressable>
              
              <View style={styles.moreMenuDividerMorph} />
              
              <Pressable 
                style={styles.moreMenuItemMorph}
                onPress={() => { setExpanded(false); router.push('/requests'); }}
              >
                <MaterialIcons name="notifications-none" size={20} color="#fff" style={styles.moreMenuIconMorph} />
                <Text style={styles.moreMenuTextMorph}>View Requests</Text>
              </Pressable>

              <View style={styles.moreMenuDividerMorph} />

              <Pressable 
                style={styles.moreMenuItemMorph}
                onPress={() => { setExpanded(false); router.push('/archived'); }}
              >
                <MaterialIcons name="archive" size={20} color="#fff" style={styles.moreMenuIconMorph} />
                <Text style={styles.moreMenuTextMorph}>Archived</Text>
              </Pressable>

              <View style={styles.moreMenuDividerMorph} />

              <Pressable 
                style={styles.moreMenuItemMorph}
                onPress={() => { setExpanded(false); /* Global Starred yet to be implemented */ }}
              >
                <MaterialIcons name="star-outline" size={20} color="#fff" style={styles.moreMenuIconMorph} />
                <Text style={styles.moreMenuTextMorph}>Starred Messages</Text>
              </Pressable>
          </Animated.View>

          {/* Trigger Icon */}
          <Pressable 
            style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
            onPress={() => !expanded && setExpanded(true)}
            pointerEvents={expanded ? 'none' : 'auto'}
          >
            <Animated.View style={iconStyle}>
              <MaterialIcons name="more-vert" size={24} color="#fff" />
            </Animated.View>
          </Pressable>
        </AnimatedGlassView>
      </Animated.View>
    </View>
  );
};

const StatusProgressRing = ({ progress, size = 80, strokeWidth = 3, color = '#3b82f6' }: { progress: number, size?: number, strokeWidth?: number, color?: string }) => {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const strokeDashoffset = circumference - (progress * circumference);

    return (
        <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
            <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
                {/* Background circle */}
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke="rgba(255,255,255,0.15)"
                    strokeWidth={strokeWidth}
                    fill="transparent"
                />
                {/* Progress circle */}
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    fill="transparent"
                />
            </Svg>
        </View>
    );
};

const FilterPill = React.memo(({ 
  id, 
  label, 
  isActive, 
  onPress,
  activeTheme 
}: { 
  id: string, 
  label: string, 
  isActive: boolean, 
  onPress: (id: any) => void,
  activeTheme: any
}) => {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
    };
  });

  const handlePressIn = () => {
    scale.value = withSpring(0.92, { damping: 12, stiffness: 300 });
    opacity.value = withTiming(0.8, { duration: 100 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 12, stiffness: 300 });
    opacity.value = withTiming(1, { duration: 150 });
  };

  return (
    <Animated.View style={animatedStyle}>
      <GlassChipButton
        onPress={() => onPress(id)}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        active={isActive}
        themeColor={activeTheme.primary}
        label={label}
      />
    </Animated.View>
  );
});

FilterPill.displayName = 'FilterPill';

export default function HomeScreen() {
  const {
    currentUser,
    contacts,
    messages,
    statuses,
    myStatuses,
    addStatus,
    deleteStatus,
    addStatusView,
    pendingStatusUploads,
    statusUploadProgress,
    retryPendingStatusUploads,
    isStatusSyncing,
    sendChatMessage,
    clearChatMessages,
    archiveContact,
    unfriendContact,
    activeTheme,
    refreshLocalCache,
    refreshStatuses,
    typingUsers,
    connectivity,
    isReady,
    offlineService,
  } = useApp();
  const { getPresence } = usePresence();
  const navigation = useNavigation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { onScrollRaw: handleScrollMotionRaw } = useScrollMotion('index');

  // Status Handlers
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [statusMediaPreview, setStatusMediaPreview] = useState<{ uri: string; type: 'image' | 'video' } | null>(null);
  const [isNoteModalVisible, setIsNoteModalVisible] = useState(false);
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [selectedChatForMenu, setSelectedChatForMenu] = useState<Contact | null>(null);
  const [menuLayout, setMenuLayout] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chatFilter, setChatFilter] = useState<'all' | 'unread' | 'favorites' | 'groups'>('all');
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [mutedChatIds, setMutedChatIds] = useState<string[]>([]);
  const [showWelcomeAnim, setShowWelcomeAnim] = useState(false);
  const welcomeAnimRef = useRef<LottieView>(null);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const selectionMode = selectedChatIds.length > 0;
  const toggleSelection = useCallback((id: string) => {
    setSelectedChatIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }, []);
  const exitSelectionMode = useCallback(() => setSelectedChatIds([]), []);

  const bulkDeleteSelected = useCallback(() => {
    if (selectedChatIds.length === 0) return;
    Alert.alert(
      `Delete ${selectedChatIds.length} chat${selectedChatIds.length > 1 ? 's' : ''}?`,
      'This removes the conversations from your device. Groups you created will also be deleted for everyone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const ids = [...selectedChatIds];
            for (const id of ids) {
              const c = contacts.find(x => x.id === id);
              if (c?.isGroup) {
                try {
                  await supabase.from('chat_group_members').delete().eq('group_id', id).eq('user_id', currentUser?.id);
                } catch {}
                try { await supabase.from('chat_groups').delete().eq('id', id); } catch {}
              } else {
                try { await clearChatMessages?.(id); } catch {}
              }
              try { await offlineService?.deleteContact?.(id); } catch {}
            }
            try { await refreshLocalCache(true); } catch {}
            setSelectedChatIds([]);
          }
        }
      ]
    );
  }, [selectedChatIds, contacts, currentUser?.id, clearChatMessages, offlineService, refreshLocalCache]);

  // Load persisted pin/mute on mount
  useEffect(() => {
    AsyncStorage.getItem('ss_pinned_chats').then(v => { if (v) setPinnedChatIds(JSON.parse(v)); }).catch(() => {});
    AsyncStorage.getItem('ss_muted_chats').then(v => { if (v) setMutedChatIds(JSON.parse(v)); }).catch(() => {});
  }, []);

  // Show welcome animation once for new users who have completed setup
  useEffect(() => {
    if (!currentUser?.id || !currentUser?.username || !currentUser?.avatar_url) return;
    const key = `ss_welcome_shown_${currentUser.id}`;
    AsyncStorage.getItem(key).then(seen => {
      if (!seen) {
        AsyncStorage.setItem(key, '1');
        setShowWelcomeAnim(true);
      }
    });
  }, [currentUser?.id, currentUser?.username, currentUser?.avatar_url]);

  const togglePinChat = useCallback((chatId: string) => {
    setPinnedChatIds(prev => {
      const next = prev.includes(chatId) ? prev.filter(id => id !== chatId) : [...prev, chatId];
      AsyncStorage.setItem('ss_pinned_chats', JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleMuteChat = useCallback((chatId: string) => {
    setMutedChatIds(prev => {
      const next = prev.includes(chatId) ? prev.filter(id => id !== chatId) : [...prev, chatId];
      AsyncStorage.setItem('ss_muted_chats', JSON.stringify(next));
      return next;
    });
  }, []);
  
  const hasFocusedOnce = useRef(false);
  const statusRailOpacity = useSharedValue(0); // Start at 0, fade in when ready/focused
  const statusRailOffset = useSharedValue(0);
  const homeMorphProgress = useSharedValue(0);
  const myStatusSourceOpacity = useSharedValue(1);
  const selectedPillId = useSharedValue('');
  const scrollPosition = useSharedValue(0);
  const statusRefs = useRef<Record<string, any>>({});
  // Telegram-style: status rail collapses as user scrolls down
  const RAIL_FULL_HEIGHT = 200;  // Full status rail height (cards + padding)
  const RAIL_COLLAPSED_HEIGHT = 80; // Increased from 70 for better breathing room
  const COLLAPSE_SCROLL = 100;    // Scroll distance to fully collapse

  const statusRailAnimStyle = useAnimatedStyle(() => {
    'worklet';
    const scrollY = Math.max(0, scrollPosition.value);
    const collapseProgress = interpolate(scrollY, [0, COLLAPSE_SCROLL], [0, 1], Extrapolation.CLAMP);
    const railHeight = interpolate(collapseProgress, [0, 1], [RAIL_FULL_HEIGHT, RAIL_COLLAPSED_HEIGHT], Extrapolation.CLAMP);

    return {
      opacity: statusRailOpacity.value,
      height: railHeight,
      transform: [{ translateY: statusRailOffset.value }],
      overflow: 'hidden' as const,
    };
  });

  // Shared value for child items to read collapse progress
  const railCollapseProgress = useDerivedValue(() => {
    return interpolate(scrollPosition.value, [0, COLLAPSE_SCROLL], [0, 1], Extrapolation.CLAMP);
  });

const homeContentAnimatedStyle = useAnimatedStyle(() => {
  'worklet';
  // Android: skip morph entirely — no translateY/scale per frame on the whole list
  if (Platform.OS === 'android') {
    return { transform: [], opacity: 1 };
  }
  const baseTranslateY = interpolate(homeMorphProgress.value, [0, 1], [0, 45], Extrapolation.IDENTITY);
  return {
    transform: [
      { translateY: baseTranslateY },
      { scale: interpolate(homeMorphProgress.value, [0, 1], [1, 0.92], Extrapolation.IDENTITY) },
    ] as any,
    opacity: 1, // Keep home content opaque so the morphing hero stays visible
  };
});

const homeChromeFadeStyle = useAnimatedStyle(() => {
  'worklet';
  // Title stays pinned at the top, we only fade it if needed
  return {
    opacity: interpolate(homeMorphProgress.value, [0, 0.9], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: 0 }] 
  };
});

const headerBackgroundStyle = useAnimatedStyle(() => {
  'worklet';
  const scrollY = Math.max(0, scrollPosition.value);
  // Become solid black quickly as user scrolls
  const opacity = interpolate(scrollY, [0, 20], [0, 1], Extrapolation.CLAMP);
  return {
    backgroundColor: `rgba(0,0,0,${opacity})`,
  };
});


  const homeBackdropAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: homeMorphProgress.value * 0.11,
      transform: [
        { scale: 1 + homeMorphProgress.value * 0.012 },
        { translateY: homeMorphProgress.value * -10 },
      ] as any,
    };
  });

  // Hide tab bar when fullscreen overlays are open — useLayoutEffect ensures
  // the tab bar is hidden before the first paint, avoiding a flash on Android
  // where the View overlay (not Modal) is used for the status viewer.
  useLayoutEffect(() => {
    const shouldHideTabBar = isMediaPickerVisible || !!statusMediaPreview || isNoteModalVisible;
    navigation.setOptions({
      tabBarStyle: { display: shouldHideTabBar ? 'none' : 'flex' }
    });
  }, [isMediaPickerVisible, statusMediaPreview, isNoteModalVisible, navigation]);

  useEffect(() => {
    const unsubscribe = (navigation as any).addListener('focus', () => {
      // If we are already in the middle of a 'returning' animation handled by subscriber,
      // do NOT reset the shared values here as it causes jitter.
      if (chatTransitionState.getPhase() === 'returning') {
        return;
      }

      // Only run the chat-morph reset if we actually went TO a chat screen.
      // Coming back from profile/other screens, items are already managed by
      // their own transition (profileAvatarTransitionState) — touching morph
      // here causes a second animation that fights with the first.
      const cameFromChat = chatTransitionState.getPhase() === 'entering';

      chatTransitionState.setPhase('idle');
      selectedPillId.value = ''; // Clear selection on return

      if (!hasFocusedOnce.current) {
        hasFocusedOnce.current = true;
        homeMorphProgress.value = 0;
        statusRailOpacity.value = withTiming(1, { duration: 600 });
        statusRailOffset.value = 0;
        return;
      }

      if (!cameFromChat) {
        // Profile dismiss / non-chat return — items should be unconditionally
        // visible. Snap morph to 0 in case any prior animation left it mid-flight.
        homeMorphProgress.value = 0;
        return;
      }

      homeMorphProgress.value = 1;
      homeMorphProgress.value = withTiming(0, {
        duration: HOME_MORPH_DURATION,
        easing: Easing.bezier(0.5, 0, 0.1, 1),
      });
      // Smooth fade-in and downward motion for status rail on return
      statusRailOpacity.value = 0;
      statusRailOffset.value = -30;
      statusRailOpacity.value = withTiming(1, {
        duration: 400,
        easing: Easing.out(Easing.cubic),
      });
      statusRailOffset.value = withTiming(0, {
        duration: 520,
        easing: Easing.bezier(0.5, 0, 0.1, 1),
      });
    });
    return unsubscribe;
  }, [homeMorphProgress, navigation, statusRailOpacity, statusRailOffset]);

  // Safety & Ready Trigger: Ensure visibility if focus listener fails or when app becomes ready.
  // Skip the morph reset whenever the profile transition is driving things — its
  // dismiss subscription animates morphProgress 1→0 over 320ms in lockstep with
  // the profile screen, and we don't want a 600ms reset overriding that.
  useEffect(() => {
    if (isReady && isFocused) {
        if (statusRailOpacity.value === 0) {
            statusRailOpacity.value = withTiming(1, { duration: 600 });
        }
        const profilePhase = profileAvatarTransitionState.getState().phase;
        const profileDriving = profilePhase === 'presented' || profilePhase === 'dismissing';
        if (!profileDriving
            && homeMorphProgress.value === 1
            && !chatTransitionState.getPhase().includes('returning')) {
             homeMorphProgress.value = withTiming(0, {
               duration: 600,
               easing: Easing.bezier(0.5, 0, 0.1, 1)
             });
        }
    }
  }, [isReady, isFocused]);

  useEffect(() => {
    const unsubscribe = chatTransitionState.subscribe((phase) => {
      if (phase === 'entering') {
        homeMorphProgress.value = withTiming(1, {
          duration: HOME_MORPH_DURATION,
          easing: Easing.bezier(0.5, 0, 0.1, 1),
        });
        return;
      }

      if (phase === 'returning') {
        homeMorphProgress.value = 1;
        statusRailOpacity.value = 0; // Start from 0 to avoid pop
        statusRailOffset.value = -30;
        homeMorphProgress.value = withTiming(0, {
          duration: HOME_MORPH_DURATION,
          easing: Easing.bezier(0.5, 0, 0.1, 1),
        });
        statusRailOpacity.value = withTiming(1, {
          duration: 400,
          easing: Easing.out(Easing.cubic),
        });
        statusRailOffset.value = withTiming(0, {
          duration: HOME_MORPH_DURATION,
          easing: Easing.bezier(0.5, 0, 0.1, 1),
        });
      }
    });

    return unsubscribe;
  }, [homeMorphProgress, statusRailOpacity, statusRailOffset]);

  const [profileAvatarTransition, setProfileAvatarTransition] = useState(() =>
    profileAvatarTransitionState.getState()
  );

  useEffect(() => {
    const unsubscribe = profileAvatarTransitionState.subscribe((state) => {
      setProfileAvatarTransition(state);
      // Unlike the chat-card morph, profile-avatar morph should not dim or
      // translate the whole home screen. We only coordinate source-avatar
      // hiding and clear any stale selection once the transition is done.
      if (state.phase === 'idle') {
        selectedPillId.value = '';
        if (chatTransitionState.getPhase() === 'idle') {
          homeMorphProgress.value = 0;
        }
      }
    });
    return unsubscribe;
  }, [homeMorphProgress, selectedPillId]);

  // Track the my-status hero morph state so the source pill can hide while
  // the my-status sheet is presented (so the morphing card is the only
  // visible representation on screen — same pattern as profileAvatarTransition).
  const [myStatusTransition, setMyStatusTransition] = useState(() =>
    myStatusTransitionState.getState()
  );
  useEffect(() => {
    const unsubscribe = myStatusTransitionState.subscribe((state) => {
      setMyStatusTransition(state);

      // Keep the home screen visually stable during the my-status transition.
      // The source pill itself hides/reappears, but the whole home feed should
      // not fade/scale out, otherwise dismiss shows a black/empty frame.
      homeMorphProgress.value = 0;
      if (state.phase === 'presented') {
        myStatusSourceOpacity.value = 0; // Instant hide on present
      } else if (state.phase === 'dismissing' || state.phase === 'idle') {
        if (state.phase === 'idle') {
          selectedPillId.value = '';
        }
        // Reappear immediately on dismiss so the shrinking card has a live
        // target to land into, avoiding the black-delay frame.
        myStatusSourceOpacity.value = withTiming(1, { duration: 120 });
      }
    });
    return unsubscribe;
  }, [homeMorphProgress, myStatusSourceOpacity]);
  const myStatusSourceAnimatedStyle = useAnimatedStyle(() => ({
    opacity: myStatusSourceOpacity.value,
  }));

  const contactStatusGroupsMap = useMemo(() => {
    const map = new Map<string, any>();
    if (statuses) {
      statuses.forEach(group => {
        if (group.user?.id) {
          map.set(group.user.id, group);
        }
      });
    }
    return map;
  }, [statuses]);

  const myStories = useMemo(() => myStatuses || [], [myStatuses]);

  const visibleContacts = useMemo(() => {
    if (!contacts) return [];
    
    const myNormalizedId = normalizeId(currentUser?.id);
    const legacyIds = new Set(['shri', 'hari']);
    const legacyToUuid = LEGACY_TO_UUID;
    const uuidToLegacy = UUID_TO_LEGACY;
    const superUserUuids = Object.values(legacyToUuid);

    const unified = new Map<string, Contact>();
    
    contacts.forEach(c => {
      const primaryId = normalizeId(c.id);
      if (primaryId === myNormalizedId) return;

      const existing = unified.get(primaryId);
      if (!existing) {
        const finalName = getSuperuserName(primaryId) || c.name;
        unified.set(primaryId, { ...c, id: primaryId, name: finalName });
      }
    });

    return Array.from(unified.values()).filter(contact => {
      const primaryId = contact.id;
      const altId = uuidToLegacy[primaryId] || primaryId;

      const isSuperUser = legacyIds.has(altId) || superUserUuids.includes(primaryId);
      const amISuperUser = legacyIds.has(currentUser?.id || '') || superUserUuids.includes(currentUser?.id || '');
      
      const isSelfSuperUserInteraction = isSuperUser && amISuperUser;

      if (!isSuperUser && (!contact.name || contact.name.toLowerCase() === 'unknown')) {
          return false;
      }

      const isArchived = contact.isArchived === true;
      // Always show verified friends/connections in the list so that new chats can be initiated
      return !isArchived;
    });
  }, [contacts, messages, statuses, currentUser]);

  const filteredVisibleContacts = useMemo(() => {
    let list = [...visibleContacts];

    if (chatFilter === 'unread') {
      list = list.filter(c => (c.unreadCount || 0) > 0);
    } else if (chatFilter === 'favorites') {
      list = list.filter(c => pinnedChatIds.includes(c.id));
    } else if (chatFilter === 'groups') {
      list = list.filter(c => (c as any).isGroup === true);
    }

    // Sort pinned chats to top (Signal/WhatsApp style)
    return list.sort((a, b) => {
      const aPinned = pinnedChatIds.includes(a.id) ? 1 : 0;
      const bPinned = pinnedChatIds.includes(b.id) ? 1 : 0;
      return bPinned - aPinned; // pinned first
    });
  }, [visibleContacts, pinnedChatIds, chatFilter]);

  const contactsWithStories = useMemo(() => {
    const filtered = visibleContacts.filter(c => contactStatusGroupsMap.has(c.id));
    console.log('[HomeScreen] status rail join →', {
      visibleContactIds: visibleContacts.map(c => ({ id: c.id, name: c.name })),
      statusGroupUserIds: Array.from(contactStatusGroupsMap.keys()),
      matchedContacts: filtered.map(c => ({ id: c.id, name: c.name })),
    });
    return filtered;
  }, [visibleContacts, contactStatusGroupsMap]);

  const isNoteValid = (timestamp?: string) => {
    if (!timestamp) return false;
    const noteDate = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - noteDate.getTime();
    return diff < 24 * 60 * 60 * 1000; // 24 hours
  };

  const handleStatusPress = (contact: Contact, latestStatus?: any) => {
    const morphKey = `status-hero-${contact.id}`;
    const navigate = () => router.push({
      pathname: '/view-status',
      params: {
        id: contact.id,
        sharedTag: morphKey,
        statusId: latestStatus?.id || '',
        mediaKey: latestStatus?.mediaKey || '',
        uriHint: latestStatus?.mediaLocalPath || latestStatus?.mediaUrl || '',
        mediaType: latestStatus?.mediaType || '',
      },
    });
    // Capture the rail card's screen-space rect at tap time so view-status
    // can morph from this exact position into fullscreen and back.
    const node = statusRefs.current[contact.id];
    if (node && typeof node.measureInWindow === 'function') {
      try {
        node.measureInWindow((x: number, y: number, w: number, h: number) => {
          if (typeof x === 'number' && typeof y === 'number' && w > 0 && h > 0) {
            setStatusMorphOrigin(morphKey, { x, y, width: w, height: h, borderRadius: 24 });
          }
          navigate();
        });
        return;
      } catch {}
    }
    navigate();
  };

  const handleProfilePress = useCallback(async (contact: Contact, layout: { x: number, y: number, width: number, height: number }) => {
    if (!contact?.id) {
      return;
    }
    const isGroup = contact.isGroup === true;
    const targetPathname = (isGroup ? '/group-info/[id]' : '/profile/[id]') as any;
    const fallbackRoute = {
      pathname: targetPathname,
      params: { id: String(contact.id) },
    } as any;
    const normalizedId = normalizeId(contact.id);
    const profileAvatarTransitionTag = normalizedId ? getProfileAvatarTransitionTag(normalizedId) : undefined;

    try {
      // Resolve the avatar source URI (same logic as chat screen)
      const avatarSourceUri = resolveAvatarImageUri({
        uri: contact.avatar,
        localUri: contact.localAvatarUri,
        avatarType: (contact.avatarType as any) || 'default',
        teddyVariant: (contact as any)?.teddyVariant,
        fallbackId: contact.id || 'default',
      });

      // Signal the transition state (coordinates the morph lifecycle)
      if (normalizedId) {
        selectedPillId.value = contact.id; // Exempt this card from list fade-out
        profileAvatarTransitionState.show(normalizedId);
      }

      // Keep warming opportunistically, but don't block the morph on this network/cache path.
      if (!isGroup && avatarSourceUri) {
        void warmAvatarSource(avatarSourceUri);
      }

      router.push({
        pathname: targetPathname,
        params: ENABLE_PROFILE_AVATAR_SHARED_TRANSITION && profileAvatarTransitionTag
          ? {
              id: contact.id,
              avatarTransition: '1',
              avatarSource: avatarSourceUri || undefined,
            }
          : {
              id: contact.id,
              avatarX: Math.round(layout.x).toString(),
              avatarY: Math.round(layout.y).toString(),
              avatarW: Math.round(layout.width).toString(),
              avatarH: Math.round(layout.height).toString(),
              avatarSource: !isGroup ? (avatarSourceUri || undefined) : undefined,
            },
      });
    } catch (err) {
      console.error('[HomeScreen] Profile morph failed:', err);
      router.push(fallbackRoute);
    }
  }, [router, selectedPillId]);

  const handleMyStatusPress = (latestStatus?: any) => {
    if (!currentUser) return;

    // Auto-retry failures
    if (pendingStatusUploads.some(upload => upload.uploadStatus === 'failed')) {
      void retryPendingStatusUploads();
    }

    if (myStatuses.length > 0 || pendingStatusUploads.length > 0) {
      const navigateWithLayout = (layout: { x: number; y: number; width: number; height: number }) => {
        selectedPillId.value = 'my-status'; // Exempt this card from list fade-out
        myStatusTransitionState.show();
        router.push({
          pathname: '/my-status',
          params: {
            sharedTag: 'status-hero-card',
            statusId: latestStatus?.id || '',
            mediaKey: latestStatus?.mediaKey || '',
            uriHint: latestStatus?.mediaLocalPath || latestStatus?.mediaUrl || '',
            mediaType: latestStatus?.mediaType || '',
            cardX: Math.round(layout.x).toString(),
            cardY: Math.round(layout.y).toString(),
            cardW: Math.round(layout.width).toString(),
            cardH: Math.round(layout.height).toString(),
          },
        });
      };

      const node = statusRefs.current['my-status'];
      if (node && typeof (node as any).measureInWindow === 'function') {
        (node as any).measureInWindow((x: number, y: number, w: number, h: number) => {
          navigateWithLayout({ x, y, width: w, height: h });
        });
      } else if (node && typeof (node as any).measure === 'function') {
        (node as any).measure((_x: number, _y: number, w: number, h: number, pageX: number, pageY: number) => {
          navigateWithLayout({ x: pageX, y: pageY, width: w, height: h });
        });
      } else {
        // Sensible fallback if measurement is unavailable; matches the
        // home rail's actual position on most phones (paddingHorizontal: 20,
        // status card width 115 / height 175).
        navigateWithLayout({ x: 20, y: 200, width: 115, height: 175 });
      }
    } else {
      setIsMediaPickerVisible(true);
    }
  };

  const closeModalRobustly = useCallback(() => {
    setIsMediaPickerVisible(false);
    setIsNoteModalVisible(false);
    setStatusMediaPreview(null);
  }, []);

  const handleSendStatus = async (mediaList: { uri: string; type: 'image' | 'video' | 'audio' }[], caption?: string) => {
    if (!currentUser || mediaList.length === 0) return;
    const item = mediaList[0];
    if (!item) return;

    try {
      await addStatus(item.uri, item.type === 'video' ? 'video' : 'image', caption || '');
      setStatusMediaPreview(null);
      setIsMediaPickerVisible(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start upload.';
      console.warn('[Status] Failed to initiate status upload:', message);
      Alert.alert('Error', message || 'Failed to start upload.');
      setStatusMediaPreview(null);
      setIsMediaPickerVisible(false);
    }
  };

  const createStatus = async (result: ImagePicker.ImagePickerResult) => {
      if (!result.canceled && result.assets?.[0] && currentUser) {
          const asset = result.assets[0];
          const resolvedUri = await resolveStatusAssetUri(asset);
          setStatusMediaPreview({
            uri: resolvedUri,
            type: asset.type === 'video' ? 'video' : 'image'
          });
      }
      setIsMediaPickerVisible(false);
  };

  const handleSelectCamera = async () => {
      try {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission?.granted) {
          return Alert.alert('Permission needed', 'Camera permission required.');
        }
        const result = await ImagePicker.launchCameraAsync({
          quality: 0.8,
          mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
          allowsEditing: true,
          videoMaxDuration: 60,
        });
        await createStatus(result);
      } catch (error: any) {
        const message = error instanceof Error ? error.message : 'Failed to open camera.';
        console.warn('[Status] Camera picker failed:', message);
        Alert.alert('Camera Error', message || 'Failed to open camera.');
      }
  };

  const handleSelectGallery = async (providedAsset?: MediaLibrary.Asset) => {
      if (providedAsset) {
          const result: ImagePicker.ImagePickerResult = {
              canceled: false,
              assets: [{
                  uri: providedAsset.uri,
                  width: providedAsset.width,
                  height: providedAsset.height,
                  type: providedAsset.mediaType === 'video' ? 'video' : 'image',
                  assetId: providedAsset.id,
                  fileName: providedAsset.filename,
                  fileSize: 0,
              }]
          };
          await createStatus(result);
          return;
      }

      try {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission?.granted) return Alert.alert('Permission needed', 'Gallery permission required.');
        const result = await ImagePicker.launchImageLibraryAsync({
          quality: 0.8,
          mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
          allowsEditing: true,
          videoMaxDuration: 60,
          legacy: true,
        });
        await createStatus(result);
      } catch (error: any) {
        const message = error instanceof Error ? error.message : 'Failed to open gallery.';
        console.warn('[Status] Gallery picker failed:', message);
        Alert.alert('Gallery Error', message || 'Failed to open gallery.');
      }
  };

  const handleUserSelect = useCallback((contact: Contact, y?: number) => {
    if (selectionMode) {
      toggleSelection(contact.id);
      return;
    }
    chatTransitionState.setPhase('entering');
    selectedPillId.value = contact.id;
    homeMorphProgress.value = withTiming(1, {
      duration: HOME_MORPH_DURATION,
      easing: Easing.bezier(0.5, 0, 0.1, 1),
    });
    // y can be undefined when measure() races with a view detach — coerce so
    // the route push never throws "Cannot read 'toString' of undefined".
    const safeY = typeof y === 'number' && Number.isFinite(y) ? y : 0;
    router.push({
      pathname: '/chat/[id]',
      params: {
        id: contact.id,
        sourceY: safeY.toString(),
      }
    });
  }, [homeMorphProgress, router, selectionMode, toggleSelection]);

  // Telegram-style card morph: rectangular card → circular avatar on scroll.
  // Card shrinks from 115×175 to 56×56 with circular borderRadius, the
  // original chrome fades out, and an avatar overlay fades in centered.

  const renderStatusItem = useCallback(({ item, index }: { item: any; index: number }) => {
    if (item.id === 'my-status') {
      const reversedMine = [...myStatuses].reverse();
      const latestMyStatus =
        reversedMine.find((status) => !!(status.mediaLocalPath || status.mediaUrl))
        || reversedMine.find((status) => !!status.mediaKey)
        || myStatuses[myStatuses.length - 1];
      const hasStatus = !!latestMyStatus;
      const hasPendingUploads = pendingStatusUploads.length > 0;
      const isUploading = isStatusSyncing || pendingStatusUploads.some(upload => upload.uploadStatus === 'uploading');
      const hasFailedPendingUpload = pendingStatusUploads.some(upload => upload.uploadStatus === 'failed');
      const firstPending = pendingStatusUploads[0];
      const statusLabel = isUploading
        ? 'Uploading...'
        : hasFailedPendingUpload
          ? 'Retrying...'
          : hasPendingUploads
            ? 'Queued...'
            : 'My Status';
      
      const myStatusOverlay = (
        <SoulAvatar
          uri={proxySupabaseUrl(currentUser?.avatar)}
          size={48}
          avatarType={currentUser?.avatarType as any}
        />
      );

      return (
        <StatusCardWrapper 
          index={index} 
          item={item} 
          avatarOverlay={myStatusOverlay}
          railCollapseProgress={railCollapseProgress}
          homeMorphProgress={homeMorphProgress}
          selectedPillId={selectedPillId}
          statusTransition={statusTransition}
        >
        <Animated.View style={[{ flex: 1 }, myStatusSourceAnimatedStyle]}>
        <Pressable
          ref={ref => statusRefs.current['my-status'] = ref}
          style={{ flex: 1 }}
          onPress={() => handleMyStatusPress(latestMyStatus)}
        >
          <View style={styles.statusCardSurface}>
            <View style={[styles.myStatusBackground, (hasStatus || hasPendingUploads) && { justifyContent: 'center', alignItems: 'center' }]}>
              {hasPendingUploads && firstPending ? (
                <View style={StyleSheet.absoluteFill}>
                  <Image source={{ uri: firstPending.localUri }} style={[styles.myStatusPreviewBgFull, { opacity: 0.6 }]} />
                  <View style={styles.uploadingOverlay}>
                    <View style={{ justifyContent: 'center', alignItems: 'center' }}>
                      <StatusProgressRing
                          progress={firstPending ? Math.min(1, statusUploadProgress[firstPending.id] || 0) : 0}
                          size={78}
                          color={activeTheme.primary}
                      />
                      <View style={{ position: 'absolute' }}>
                          <SoulAvatar 
                              uri={proxySupabaseUrl(currentUser?.avatar)} 
                              size={64} 
                          />
                      </View>
                    </View>
                  </View>
                </View>
              ) : hasStatus ? (
                <View style={StyleSheet.absoluteFill}>
                  {((latestMyStatus as any)?.mediaType === 'text') ? (
                    <LinearGradient
                      colors={[
                        (latestMyStatus as any)?.backgroundColor || '#6366f1',
                        `${(latestMyStatus as any)?.backgroundColor || '#6366f1'}CC`,
                      ]}
                      style={[styles.myStatusPreviewBgFull, { justifyContent: 'center', alignItems: 'center', padding: 15 }]}
                    >
                      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 10 }} numberOfLines={4}>
                        {latestMyStatus.caption}
                      </Text>
                    </LinearGradient>
                  ) : (
                    <>
                      <StatusThumbnail 
                        statusId={latestMyStatus.id}
                        mediaKey={latestMyStatus.mediaKey}
                        uriHint={latestMyStatus.mediaLocalPath || latestMyStatus.mediaUrl}
                        mediaType={latestMyStatus.mediaType as any}
                        style={styles.myStatusPreviewBgFull}
                        showLoader={false}
                      />
                      <LinearGradient
                        colors={['rgba(0,0,0,0.5)', 'transparent']}
                        style={styles.myStatusTopGradient}
                      />
                    </>
                  )}
                  <View style={styles.myStatusAvatarBadgeCorner} pointerEvents="none">
                    <SoulAvatar 
                       uri={proxySupabaseUrl(currentUser?.avatar)} 
                       size={34} 
                       avatarType={currentUser?.avatarType as any}
                       isOnline={false}
                       style={styles.avatarGlow}
                    />
                  </View>
                </View>
              ) : (
                <View style={styles.myStatusEmptyPlaceholder}>
                  <View style={styles.myStatusAvatarMain}>
                    <SoulAvatar 
                       uri={proxySupabaseUrl(currentUser?.avatar)} 
                       size={64} 
                       avatarType={currentUser?.avatarType as any}
                       isOnline={false}
                    />
                    <View style={styles.addStatusBadgeContainer}>
                      <LinearGradient
                        colors={['#3b82f6', '#2563eb']}
                        style={styles.addStatusBadgeGradient}
                      >
                        <MaterialIcons name="add" size={18} color="#fff" />
                      </LinearGradient>
                    </View>
                  </View>
                </View>
              )}
            </View>
            <View style={styles.statusInfoGlassWrapper}>
              <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={styles.statusInfoContent}>
                <Text style={styles.statusName} numberOfLines={1}>
                  {statusLabel}
                </Text>
              </View>
            </View>
          </View>
          {currentUser?.note && isNoteValid(currentUser.noteTimestamp) && !isNoteModalVisible && (
            <View style={styles.notePositioner} pointerEvents="box-none">
              <Pressable onPress={() => setIsNoteModalVisible(true)}>
                <NoteBubble text={currentUser.note} isMe align="center" />
              </Pressable>
            </View>
          )}
        </Pressable>
        </Animated.View>
        </StatusCardWrapper>
      );
    }

    const contact = item as Contact;
    const group = contactStatusGroupsMap.get(contact.id);
    const latestStatus = group?.statuses
      ? [...group.statuses].reverse().find((status) => !!(status.mediaLocalPath || status.mediaUrl))
        || group.statuses[group.statuses.length - 1]
      : undefined;
    const hasStatus = !!latestStatus;
    const hasUnviewed = group?.hasUnviewed || false;

    const contactOverlay = (
      <LinearGradient
        colors={hasUnviewed ? ['#8C0016', '#B5001E'] : ['rgba(255,255,255,0.2)', 'rgba(255,255,255,0.2)']}
        style={{ width: 52, height: 52, borderRadius: 26, padding: 2, alignItems: 'center', justifyContent: 'center' }}
      >
        <View style={{ backgroundColor: '#000', borderRadius: 25, padding: 2 }}>
          <SoulAvatar
            uri={proxySupabaseUrl(contact.avatar)}
            localUri={contact.localAvatarUri}
            size={44}
            avatarType={contact.avatarType as any}
            teddyVariant={contact.teddyVariant as any}
          />
        </View>
      </LinearGradient>
    );

    return (
      <StatusCardWrapper 
        index={index} 
        item={item} 
        avatarOverlay={contactOverlay}
        railCollapseProgress={railCollapseProgress}
        homeMorphProgress={homeMorphProgress}
        selectedPillId={selectedPillId}
        statusTransition={statusTransition}
      >
      <Pressable
        key={contact.id}
        ref={ref => statusRefs.current[contact.id] = ref}
        style={{ flex: 1 }}
        onPress={() => handleStatusPress(contact, latestStatus)}
      >
        <View style={styles.statusCardSurface}>
          {hasStatus ? (
            <StatusThumbnail 
              statusId={latestStatus.id}
              mediaKey={latestStatus.mediaKey}
              uriHint={latestStatus.mediaLocalPath || latestStatus.mediaUrl}
              mediaType={latestStatus.mediaType as any}
              style={styles.statusMediaBackground}
              showLoader={false}
            />
          ) : (
            <View style={[styles.statusMediaBackground, styles.statusPlaceholder]} />
          )}
          
          <View style={styles.statusOverlay} pointerEvents="none">
            <View style={styles.contactAvatarCorner}>
              <LinearGradient
                colors={hasUnviewed ? ['#8C0016', '#B5001E'] : ['rgba(255,255,255,0.2)', 'rgba(255,255,255,0.2)']}
                style={[styles.storyRing, { padding: 2 }]}
              >
                <View style={styles.storyRingInner}>
                  <SoulAvatar
                    uri={proxySupabaseUrl(contact.avatar)}
                    localUri={contact.localAvatarUri}
                    size={32}
                    avatarType={contact.avatarType as any}
                    teddyVariant={contact.teddyVariant as any}
                    style={styles.avatarGlow}
                  />
                </View>
              </LinearGradient>
            </View>
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.statusNameGradient}>
              <Text style={styles.statusNameText}>{contact.name}</Text>
            </LinearGradient>
          </View>
        </View>
        {contact.note && isNoteValid(contact.noteTimestamp) && (
            <View style={styles.notePositioner} pointerEvents="none">
                <NoteBubble text={contact.note} />
            </View>
        )}
      </Pressable>
      </StatusCardWrapper>
    );
  }, [
    myStatuses,
    currentUser,
    contactStatusGroupsMap,
    pendingStatusUploads,
    isStatusSyncing,
    handleMyStatusPress,
    handleStatusPress,
    StatusCardWrapper,
    myStatusSourceAnimatedStyle,
  ]);

  const lastMessagesMap = useMemo(() => {
    const map: Record<string, { text?: string; timestamp?: string }> = {};
    for (const contact of visibleContacts) {
      const chatMsgs = messages[contact.id] || [];
      const lastMsg = chatMsgs[chatMsgs.length - 1];
      map[contact.id] = lastMsg
        ? { text: lastMsg.text, timestamp: lastMsg.timestamp }
        : { text: contact.lastMessage, timestamp: '' };
    }
    return map;
  }, [visibleContacts, messages]);

  const renderItem = useCallback(({ item, index }: { item: Contact; index: number }) => {
    const lastMsg = lastMessagesMap[item.id] || { text: item.lastMessage, timestamp: '' };
    const isTyping = typingUsers.includes(item.id);

    return (
      <SwipeableRow
        onArchive={() => archiveContact(item.id, true)}
        onDelete={() => {
          Alert.alert('Delete Chat', 'Are you sure?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => clearChatMessages(item.id) },
          ]);
        }}
        onDeleteDirect={() => clearChatMessages(item.id)}
        onUnfriend={() => unfriendContact(item.id)}
      >
        <ChatListItem 
            item={item} 
            index={index}
            lastMsg={lastMsg} 
            isTyping={isTyping}
            unreadCount={item.unreadCount}
            isMuted={mutedChatIds.includes(item.id)}
            isPinned={pinnedChatIds.includes(item.id)}
            isSelected={selectedChatIds.includes(item.id)}
            onLongPress={(chat, layout) => {
                setSelectedChatForMenu(chat);
                setMenuLayout(layout);
                setContextMenuVisible(true);
                void hapticService.impact(Haptics.ImpactFeedbackStyle.Light);
            }}
            getPresence={getPresence}
            connectivity={connectivity}
            onSelect={handleUserSelect}
            homeMorphProgress={homeMorphProgress}
            selectedPillId={selectedPillId}
            onAvatarPress={handleProfilePress}
            isScreenFocused={isFocused}
            profileAvatarTransition={profileAvatarTransition}
        />
      </SwipeableRow>
    );
  }, [lastMessagesMap, typingUsers, getPresence, connectivity, handleUserSelect, homeMorphProgress, archiveContact, clearChatMessages, unfriendContact, pinnedChatIds, mutedChatIds, selectedChatIds, handleProfilePress, isFocused, profileAvatarTransition]);

  const keyExtractor = useCallback((item: Contact) => item.id, []);

  const triggerRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);

    // Premium Haptic: Successful start
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    try {
      // Refresh contacts AND statuses in parallel. Previously only contacts
      // were refreshed, so a manual pull-down never pulled in a friend's
      // newly-posted status if realtime didn't fire.
      await Promise.all([
        refreshLocalCache(),
        refreshStatuses(),
      ]);
    } catch (error) {
      console.warn('[HomeScreen] refresh failed:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refreshLocalCache, refreshStatuses]);


  const renderHeader = useCallback(() => (
    <Animated.View style={[styles.floatingHeader, headerBackgroundStyle]}>
      <Animated.View style={[styles.topHeader, homeChromeFadeStyle]}>
        {selectionMode ? (
          <View style={styles.headerActions}>
            <Pressable onPress={exitSelectionMode} hitSlop={10} style={{ marginRight: 12 }}>
              <MaterialIcons name="close" size={24} color="#fff" />
            </Pressable>
            <Text style={[styles.headerTitle, { fontSize: 20 }]}>{selectedChatIds.length} selected</Text>
            <Pressable onPress={bulkDeleteSelected} hitSlop={10}>
              <MaterialIcons name="delete-outline" size={24} color="#ff4444" />
            </Pressable>
          </View>
        ) : (
          <View style={styles.headerActions}>
            <Text style={styles.headerTitle}>Soul</Text>
            <AnimatedMoreMenu router={router} isSearching={false} />
          </View>
        )}
      </Animated.View>
      <Animated.View style={[styles.statusRail, statusRailAnimStyle]}>
        <FlatList
          horizontal
          data={[{ id: 'my-status' }, ...contactsWithStories]}
          keyExtractor={item => item.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.statusContent}
          removeClippedSubviews={false}
          renderItem={renderStatusItem}
        />
      </Animated.View>
      {/* Filter chip row — fixed flex layout (not a ScrollView) so the chips
          stay locked in place. */}
      <Animated.View style={[styles.filterRow, homeChromeFadeStyle]}>
        {[
          { id: 'all', label: 'All' },
          { id: 'unread', label: 'Unread' },
          { id: 'favorites', label: 'Favourites' },
          { id: 'groups', label: 'Groups' }
        ].map(filter => (
          <FilterPill
            key={filter.id}
            id={filter.id}
            label={filter.label}
            isActive={chatFilter === filter.id}
            onPress={setChatFilter}
            activeTheme={activeTheme}
          />
        ))}
        <GlassChipButton
          onPress={() => router.push('/create-group')}
          active={false}
          themeColor={activeTheme.primary}
          iconOnly
          radius={16}
          style={styles.addChip}
          contentStyle={styles.addChipContent}
        >
          <MaterialIcons name="add" size={18} color="rgba(255,255,255,0.6)" />
        </GlassChipButton>
      </Animated.View>
    </Animated.View>
  ), [contactsWithStories, renderStatusItem, statusRailAnimStyle, router, chatFilter, selectionMode, selectedChatIds.length, exitSelectionMode, bulkDeleteSelected, homeChromeFadeStyle, headerBackgroundStyle]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      
      <ConnectionBanner connectivity={connectivity} mode="inline" />

      <SoulPullToRefresh onRefresh={triggerRefresh}>
        {({ onScroll: onPullScroll }) => (
          <Animated.View
            style={[styles.homeContent, homeContentAnimatedStyle]}
          >
            {/* Header is rendered OUTSIDE the FlatList so the Soul title,
                status rail, and filter pills stay pinned to the top while
                the user scrolls. The rail still morphs to circles in place
                because its animated style reads the FlatList's scroll
                offset via shared values. */}
            {renderHeader()}
            {!isReady ? (
               <View style={{ flex: 1 }}>
                 <View style={{ marginTop: 20 }}>
                   {[1, 2, 3, 4, 5, 6].map(i => <ChatListItemSkeleton key={i} />)}
                 </View>
               </View>
            ) : (
              <Animated.FlatList
                data={filteredVisibleContacts}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                contentContainerStyle={[
                  styles.listContent,
                  { paddingTop: 330 } // Adjusted for compact header
                ]}
                bounces={false}
                scrollEnabled={!isRefreshing}
                showsVerticalScrollIndicator={false}
                onScroll={(e) => {
                  const y = e.nativeEvent?.contentOffset?.y ?? 0;
                  scrollPosition.value = y;
                  if (typeof handleScrollMotionRaw === 'function') handleScrollMotionRaw(y);
                  if (typeof onPullScroll === 'function') onPullScroll(e);
                }}
                scrollEventThrottle={16}
                ListEmptyComponent={() => (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 200 }}>
                    <MaterialIcons name="chat-bubble-outline" size={60} color="rgba(255,255,255,0.2)" />
                    <Text style={{ color: 'rgba(255,255,255,0.4)', marginTop: 16, fontSize: 16 }}>No chats yet</Text>
                  </View>
                )}
              />
            )}
          </Animated.View>
        )}
      </SoulPullToRefresh>

      <MediaPreviewModal
        visible={!!statusMediaPreview}
        mediaUri={statusMediaPreview?.uri || ''}
        mediaType={statusMediaPreview?.type || 'image'}
        onClose={closeModalRobustly}
        onSend={handleSendStatus}
        isUploading={isStatusSyncing || pendingStatusUploads.length > 0}
        mode="status"
      />

      <MediaPickerSheet
        visible={isMediaPickerVisible}
        onClose={closeModalRobustly}
        onSelectCamera={handleSelectCamera}
        onSelectGallery={() => handleSelectGallery()}
        onSelectAssets={(assets) => {
            if (assets && assets.length > 0) {
              handleSelectGallery(assets[0]);
            }
        }}
        onSelectAudio={() => Alert.alert("Audio Status", "Coming soon!")}
        onSelectNote={() => {
            setIsMediaPickerVisible(false);
            setTimeout(() => setIsNoteModalVisible(true), 260);
        }}
      />

      <NoteCreatorModal
        visible={isNoteModalVisible}
        onClose={closeModalRobustly}
      />

      {/* Welcome animation — plays once for new users with completed profiles */}
      {showWelcomeAnim && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <LottieView
            ref={welcomeAnimRef}
            source={require('../../assets/animations/welcome-new-user.json')}
            autoPlay
            loop={false}
            style={{ flex: 1 }}
            onAnimationFinish={() => setShowWelcomeAnim(false)}
          />
        </View>
      )}

      <ChatListContextMenu
        visible={contextMenuVisible}
        chatItem={selectedChatForMenu}
        layout={menuLayout}
        isPinned={selectedChatForMenu ? pinnedChatIds.includes(selectedChatForMenu.id) : false}
        isMuted={selectedChatForMenu ? mutedChatIds.includes(selectedChatForMenu.id) : false}
        onClose={() => setContextMenuVisible(false)}
        onAction={(action) => {
            if (!selectedChatForMenu) return;
            const item = selectedChatForMenu;
            switch(action) {
                case 'pin': togglePinChat(item.id); break;
                case 'mute': toggleMuteChat(item.id); break;
                case 'archive': archiveContact(item.id); break;
                case 'select': setSelectedChatIds([item.id]); break;
                case 'delete': {
                    if (item.isGroup) {
                        // WhatsApp-style: Exit (always) + Delete (creator only).
                        // We use deleteGroup (not deleteContact) so contacts + groups +
                        // group_members all come out together — otherwise an orphan
                        // groups row resurrects the tile on the next reconcile pass.
                        const removeLocally = async () => {
                            try { await offlineService?.deleteGroup?.(item.id); } catch {}
                            try { await refreshLocalCache(true); } catch {}
                        };
                        Alert.alert(
                            item.name || 'Group',
                            'What do you want to do?',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Exit Group',
                                    style: 'destructive',
                                    onPress: async () => {
                                        try {
                                            await supabase
                                                .from('chat_group_members')
                                                .delete()
                                                .eq('group_id', item.id)
                                                .eq('user_id', currentUser?.id);
                                        } catch {}
                                        await removeLocally();
                                    }
                                },
                                {
                                    text: 'Delete Group',
                                    style: 'destructive',
                                    onPress: async () => {
                                        try {
                                            const { error } = await supabase
                                                .from('chat_groups')
                                                .delete()
                                                .eq('id', item.id);
                                            if (error) {
                                                Alert.alert('Cannot delete', error.message || 'Only the group creator can delete the group.');
                                                return;
                                            }
                                        } catch (err: any) {
                                            Alert.alert('Error', err?.message || 'Failed to delete group');
                                            return;
                                        }
                                        await removeLocally();
                                    }
                                },
                            ]
                        );
                    } else {
                        Alert.alert(
                            'Delete chat',
                            `Delete chat with ${item.name}? This removes the conversation from your device.`,
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Delete',
                                    style: 'destructive',
                                    onPress: async () => {
                                        try { await clearChatMessages?.(item.id); } catch {}
                                        try { await offlineService?.deleteContact?.(item.id); } catch {}
                                        try { await refreshLocalCache(true); } catch {}
                                    }
                                }
                            ]
                        );
                    }
                    break;
                }
            }
        }}
        renderItem={() => {
            if (!selectedChatForMenu) return null;
            const item = selectedChatForMenu;
            const lastMsg = lastMessagesMap[item.id] || { text: item.lastMessage, timestamp: '' };
            const isTyping = typingUsers.includes(item.id);
            return (
                <View style={[styles.chatItem, { marginHorizontal: 0, marginBottom: 0 }]}>
                    <ChatListItem
                        item={item}
                        index={0}
                        lastMsg={lastMsg}
                        isTyping={isTyping}
                        unreadCount={item.unreadCount}
                        isMuted={mutedChatIds.includes(item.id)}
                        isPinned={pinnedChatIds.includes(item.id)}
                        onSelect={() => {}}
                        onLongPress={() => {}}
                        getPresence={getPresence}
                        connectivity={connectivity}
                        homeMorphProgress={homeMorphProgress}
                        selectedPillId={selectedPillId}
                        onAvatarPress={handleProfilePress}
                        isScreenFocused={isFocused}
                        profileAvatarTransition={profileAvatarTransition}
                        isClone
                    />
                </View>
            );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  homeContent: {
    flex: 1,
  },
  floatingHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 10,
    paddingTop: Platform.OS === 'ios' ? 44 : 20,
  },
  topHeader: { 
    paddingHorizontal: 20,
    paddingVertical: 4,
    height: 48,
    justifyContent: 'center',
    zIndex: 1000,
    elevation: 10,
  },
  headerActions: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 15,
  },
  headerTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  searchBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
  },
  searchBarInput: {
    flex: 1,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 20,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
  },
  searchClearBtn: {
    position: 'absolute',
    right: 76,
    padding: 10,
  },
  searchCancelBtn: {
    marginLeft: 12,
    paddingVertical: 8,
  },
  searchCancelText: {
    color: '#bcbbbb',
    fontSize: 16,
    fontWeight: '500',
  },
  headerIconButton: { 
    width: 44, 
    height: 44, 
    borderRadius: 22, 
    backgroundColor: 'rgba(255,255,255,0.08)', 
    alignItems: 'center', 
    justifyContent: 'center' 
  },
  statusRail: { marginTop: 0, marginBottom: 4, overflow: 'visible' },
  statusContent: { paddingHorizontal: 20, paddingVertical: 8, paddingTop: 5, gap: 14, overflow: 'visible' },
  statusCard: { 
    width: 115, 
    height: 175, 
    marginTop: 5, 
    borderRadius: 28, 
    backgroundColor: '#1a1a1a', 
    zIndex: 10, 
    overflow: 'visible',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: {
        elevation: 4,
      }
    })
  },
  statusCardSurface: {
    flex: 1,
    borderRadius: 28,
    backgroundColor: '#1a1a1a',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  myStatusBackground: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f0f0f', borderRadius: 28, overflow: 'hidden' },
  myStatusPreviewBg: { ...StyleSheet.absoluteFillObject, opacity: 0.42 },
  myStatusPreviewBgFull: { ...StyleSheet.absoluteFillObject, opacity: 1 },
  myStatusTopGradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 60, zIndex: 1 },
  myStatusAvatarMain: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  myStatusAvatarBadgeCorner: { position: 'absolute', top: 12, left: 12, zIndex: 10 },
  avatarGlow: { shadowColor: '#3b82f6', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 10 },
  addStatusBadgeContainer: { 
    position: 'absolute', 
    bottom: -2, 
    right: -2, 
    width: 28, 
    height: 28, 
    borderRadius: 14, 
    backgroundColor: '#000', 
    alignItems: 'center', 
    justifyContent: 'center',
    zIndex: 15
  },
  addStatusBadgeGradient: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#000',
  },
  statusInfoGlassWrapper: { 
    position: 'absolute', 
    bottom: 0, 
    left: 0, 
    right: 0, 
    height: 54, 
    overflow: 'hidden',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)'
  },
  statusInfoContent: { padding: 12, alignItems: 'center', justifyContent: 'center' },
  statusName: { color: '#fff', fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textAlign: 'center' },
  statusTime: { color: 'rgba(255,255,255,0.6)', fontSize: 10.5, fontWeight: '500', textAlign: 'center' },
  statusMediaBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0f0f0f', borderRadius: 28 },
  statusPlaceholder: { backgroundColor: 'rgba(255,255,255,0.05)' },
  myStatusEmptyPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 38 },
  statusOverlay: { ...StyleSheet.absoluteFillObject },
  statusAvatarOverlay: { 
    ...StyleSheet.absoluteFillObject,
    borderRadius: 28,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactAvatarPositioner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 50, alignItems: 'center', justifyContent: 'center' },
  contactAvatarCorner: { position: 'absolute', top: 12, left: 12, zIndex: 10 },
  storyRing: { borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  storyRingInner: { backgroundColor: '#000', borderRadius: 28, padding: 2 },
  statusNameGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 70,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 14,
    paddingTop: 24,
  },
  statusNameText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  // paddingBottom is intentionally large so the list is always scrollable
  // past COLLAPSE_SCROLL (~90px) — drives the status-rail morph even when
  // the user has only a handful of chats.
  listContent: { paddingBottom: 600, paddingHorizontal: 4 },
  chatItem: { marginBottom: 5, marginHorizontal: 8, borderRadius: 28, height: 56 },
  notePositioner: {
      position: 'absolute',
      top: -34,
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 100,
  },
  // Removed overflow: 'hidden' to let shared elements escape during flight
  chatPillContainer: { 
    flex: 1, 
    borderRadius: 32,
  },
  chatPillSurface: {
    flex: 1,
  },

  pillBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0, 0, 0, 0.15)', opacity: 0.95 },
  pillBlur: { ...StyleSheet.absoluteFillObject },
  pillContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingRight: 16, gap: 12 },
  avatarContainer: { position: 'relative' },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  onlineIndicator: { position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e', borderWidth: 2, borderColor: '#151515' },
  chatContent: { flex: 1, justifyContent: 'center' },
  contactName: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.5 },
  lastMessage: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500' },
  rightSide: { alignItems: 'flex-end', justifyContent: 'center', paddingRight: 4, gap: 4 },
  timestamp: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '600' },
  addChip: {
    width: 32,
    height: 32,
  },
  addChipContent: {
    minHeight: 32,
    minWidth: 32,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // Center the chip row in the available width so the spacing on the left
    // and the right is always symmetric — the previous left-aligned padding
    // made the row look like it was pushed to the right because "Favourites"
    // is a wide pill and shoved the "+" close to the right edge.
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 6,
    marginTop: -8,
    marginBottom: 8,
  },
  moreMenuItemMorph: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  moreMenuIconMorph: {
    marginRight: 10,
  },
  moreMenuTextMorph: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  moreMenuDividerMorph: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 14,
  },
  uploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-start', // Shift to top
    alignItems: 'center',
    paddingTop: 36, // Precise margin from top to keep it clear of Note Bubble and Bottom Bar
  },
  uploadingText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
  },
  unreadBadge: {
    backgroundColor: '#3b82f6',
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  unreadBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
});
