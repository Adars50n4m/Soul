import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  StatusBar,
  Dimensions,
  Alert,
  FlatList,
  Platform,
  TouchableOpacity,
  ActionSheetIOS,
  TextInput,
  Modal,
  ActivityIndicator,
  PanResponder,
} from 'react-native';
import { Svg, Circle } from 'react-native-svg';
import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import GlassView from '../../components/ui/GlassView';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  interpolateColor,
  useDerivedValue,
  runOnJS,
  withSpring,
  withTiming,
  withRepeat,
  cancelAnimation,
  Easing,
  SharedTransition,
  interpolate,
  Extrapolation,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { storageService } from '../../services/StorageService';
import { proxySupabaseUrl } from '../../config/api';
import { chatTransitionState } from '../../services/chatTransitionState';
import SwipeableRow from '../../components/ui/SwipeableRow';

import { useApp } from '../../context/AppContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePresence } from '../../context/PresenceContext';
import { useScrollMotion } from '../../components/navigation/ScrollMotionProvider';
import { normalizeId, getSuperuserName, LEGACY_TO_UUID, UUID_TO_LEGACY } from '../../utils/idNormalization';
import { SHRI_ID, HARI_ID } from '../../config/supabase';
import { SoulAvatar } from '../../components/SoulAvatar';
import { StatusThumbnail } from '../../components/StatusThumbnail';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { Contact } from '../../types';
import { NoteBubble } from '../../components/NoteBubble';
import { NoteCreatorModal } from '../../components/NoteCreatorModal';
import { SUPPORT_SHARED_TRANSITIONS } from '../../constants/sharedTransitions';
const DEFAULT_AVATAR = '';
const ENABLE_SHARED_TRANSITIONS = SUPPORT_SHARED_TRANSITIONS;
const HOME_MORPH_DURATION = 480;
const PULL_MAX_DISTANCE = 160;
const PULL_REFRESH_TRIGGER = 85;
const PULL_LOCK_DISTANCE = 80;
const PULL_SPRING = { damping: 20, stiffness: 180, mass: 0.8 } as const;

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

  // Persist picked media into app cache so viewer/home preview can read reliably.
  if (resolvedUri.startsWith('file://')) {
    const ext = asset.fileName?.split('.').pop() || (asset.type === 'video' ? 'mp4' : 'jpg');
    const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    if (!cacheDir) return resolvedUri;
    const target = `${cacheDir}status-${Date.now()}.${ext}`;
    try {
      await FileSystem.copyAsync({ from: resolvedUri, to: target });
      resolvedUri = target;
    } catch {
      // Keep original file URI if copy fails.
    }
  }

  return resolvedUri;
};

// ─── Stable style objects (extracted to avoid inline object creation in render) ──
const typingStyle = { color: '#22c55e', fontWeight: '700' as const };
const chevronColor = 'rgba(255,255,255,0.3)';
const pillSharedTransition = SharedTransition.custom((values) => {
  'worklet';
  const morph = {
    duration: 520,
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  };
  return {
    originX: withTiming(values.targetOriginX, morph),
    originY: withTiming(values.targetOriginY, morph),
    width: withTiming(values.targetWidth, morph),
    height: withTiming(values.targetHeight, morph),
    borderRadius: withTiming(values.targetBorderRadius, morph),
  };
}).duration(520);
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

interface ChatListItemProps {
  item: Contact;
  index: number;
  lastMsg: { text?: string; timestamp?: string };
  onSelect: (contact: Contact, y: number) => void;
  onLongPress: (contact: Contact) => void;
  isTyping: boolean;
  getPresence: (userId: string) => { isOnline: boolean; lastSeen: string | null };
  connectivity: { isDeviceOnline: boolean; isServerReachable: boolean; isRealtimeConnected: boolean };
  homeMorphProgress: Animated.SharedValue<number>;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean;
}

const ChatListItem = React.memo(({ item, index, lastMsg, onSelect, onLongPress, isTyping, getPresence, connectivity, homeMorphProgress, unreadCount, isPinned, isMuted }: ChatListItemProps) => {
  const scaleAnim = useSharedValue(1);
  const opacityAnim = useSharedValue(1);
  const itemRef = useRef<View>(null);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: scaleAnim.value } as any,
      { translateY: interpolate(homeMorphProgress.value, [0, 1], [0, 35 + (index % 5) * 20], Extrapolation.IDENTITY) } as any,
      { scale: interpolate(homeMorphProgress.value, [0, 1], [1, 0.92], Extrapolation.IDENTITY) } as any
    ],
    opacity: opacityAnim.value * interpolate(homeMorphProgress.value, [0, 0.7], [1, 0], Extrapolation.CLAMP),
  }));

  const handlePressIn = useCallback(() => {
    scaleAnim.value = withSpring(0.96, { damping: 15, stiffness: 300 });
    opacityAnim.value = withTiming(0.92, { duration: 90 });
  }, []);

  const handlePressOut = useCallback(() => {
    scaleAnim.value = withSpring(1, { damping: 15, stiffness: 300 });
    opacityAnim.value = withTiming(1, { duration: 120 });
  }, []);

  const handlePress = useCallback(() => {
    itemRef.current?.measure((x, y, width, height, pageX, pageY) => {
      onSelect(item, pageY);
    });
  }, [item, onSelect]);

  return (
    <Pressable
      ref={itemRef}
      onPress={handlePress}
      onLongPress={() => onLongPress(item)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={styles.chatItem}
    >
      {/* Outer morph target - ONLY handles the shared element transition */}
      <Animated.View 
        {...(ENABLE_SHARED_TRANSITIONS
          ? {
              sharedTransitionTag: `pill-${item.id}`,
              sharedTransitionStyle: pillSharedTransition,
            }
          : {})}
        style={[styles.chatPillContainer]}
      >
        {/* Inner container handles the press scale animation */}
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          {/* Glass blur background — same feel as navbar */}
          <View style={[StyleSheet.absoluteFill, { borderRadius: 36, overflow: 'hidden' }]}>
            <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
          </View>
        {/* Subtle dark tint overlay */}
        <Animated.View
            style={[StyleSheet.absoluteFill, { borderRadius: 36, backgroundColor: 'rgba(0, 0, 0, 0.15)' }]}
        />
            
        {/* Content rendered safely as an overlay, decoupled from Reanimated's snapshot engine */}
        <View style={[styles.pillContent, { position: 'absolute', width: '100%', height: '100%', paddingHorizontal: 16 }]} pointerEvents="box-none">
          <Animated.View 
            {...(ENABLE_SHARED_TRANSITIONS
              ? {
                  sharedTransitionTag: `pill-avatar-${item.id}`,
                  sharedTransitionStyle: pillSharedTransition,
                }
              : {})}
            style={styles.avatarContainer}
          >
            <SoulAvatar
              uri={proxySupabaseUrl(item.avatar) || DEFAULT_AVATAR}
              localUri={item.localAvatarUri}
              size={40}
              avatarType={item.avatarType}
              teddyVariant={item.teddyVariant}
              isOnline={getPresence(item.id).isOnline}
              style={[
                item.stories && item.stories.length > 0 && {
                  borderWidth: 2,
                  borderColor: item.stories.some((s) => !s.seen) ? '#3b82f6' : 'rgba(255,255,255,0.4)',
                  padding: 2,
                  overflow: 'hidden'
                }
              ]}
            />
          </Animated.View>

          <View style={styles.chatContent}>
            <Animated.View
              {...(ENABLE_SHARED_TRANSITIONS
                ? {
                    sharedTransitionTag: `pill-name-${item.id}`,
                    sharedTransitionStyle: pillSharedTransition,
                  }
                : {})}
            >
              <Text style={styles.contactName}>
                {item.name}
              </Text>
            </Animated.View>
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
            <MaterialIcons name="chevron-right" size={20} color={chevronColor} />
          </View>
        </View>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render when meaningful data changes
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.item.name === nextProps.item.name &&
    prevProps.item.avatar === nextProps.item.avatar &&
    prevProps.item.status === nextProps.item.status &&
    prevProps.item.stories?.length === nextProps.item.stories?.length &&
    prevProps.item.stories?.some(s => !s.seen) === nextProps.item.stories?.some(s => !s.seen) &&
    prevProps.lastMsg.text === nextProps.lastMsg.text &&
    prevProps.lastMsg.timestamp === nextProps.lastMsg.timestamp &&
    prevProps.isTyping === nextProps.isTyping &&
    prevProps.unreadCount === nextProps.unreadCount &&
    prevProps.isPinned === nextProps.isPinned &&
    prevProps.isMuted === nextProps.isMuted &&
    prevProps.onSelect === nextProps.onSelect &&
    prevProps.getPresence(prevProps.item.id).isOnline === nextProps.getPresence(nextProps.item.id).isOnline
  );
});

ChatListItem.displayName = 'ChatListItem';

const AnimatedMoreMenu = ({ router, isSearching }: { router: any, isSearching: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withSpring(expanded ? 1 : 0, { damping: 16, stiffness: 180 });
  }, [expanded]);

  useEffect(() => {
    if (isSearching) setExpanded(false);
  }, [isSearching]);

  const containerStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [40, 200]),
    height: interpolate(progress.value, [0, 1], [40, 220]),
    borderRadius: interpolate(progress.value, [0, 1], [20, 16]),
    backgroundColor: expanded ? 'rgba(0,0,0,0.6)' : 'transparent',
  }));

  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0]),
    transform: [
      { scale: interpolate(progress.value, [0, 0.5], [1, 0.2]) },
      { rotate: `${interpolate(progress.value, [0, 1], [0, 90])}deg` }
    ] as any,
  }));

  const menuStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.6, 1], [0, 1]),
    transform: [{ translateY: interpolate(progress.value, [0, 1], [-10, 0]) }],
  }));

  return (
    <View style={[{ zIndex: expanded ? 1000 : 1, width: 40, height: 40 }]}>
      {expanded && (
         <Pressable 
           style={[{ position: 'absolute', width: Dimensions.get('window').width * 2, height: Dimensions.get('window').height * 2, top: -Dimensions.get('window').height, right: -Dimensions.get('window').width, bottom: undefined, left: undefined, zIndex: 1 }]}
           onPress={() => setExpanded(false)}
         />
      )}
      <Animated.View style={[
        { position: 'absolute', top: 0, right: 0, overflow: 'hidden', zIndex: 10, borderWidth: expanded ? 1 : 0, borderColor: expanded ? 'rgba(255,255,255,0.1)' : 'transparent' },
        containerStyle
      ]}>
        <GlassView intensity={expanded ? 50 : 0} tint="dark" style={{ flex: 1, backgroundColor: 'transparent' }}>
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
                onPress={() => { setExpanded(false); router.push('/search'); }}
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
                onPress={() => { setExpanded(false); router.push('/search'); }}
              >
                <MaterialIcons name="search" size={20} color="#fff" style={styles.moreMenuIconMorph} />
                <Text style={styles.moreMenuTextMorph}>Search</Text>
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
        </GlassView>
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
    typingUsers,
    connectivity,
    isReady,
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshHint, setRefreshHint] = useState('Pull to refresh');
  const [chatFilter, setChatFilter] = useState<'all' | 'unread'>('all');
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [mutedChatIds, setMutedChatIds] = useState<string[]>([]);
  
  const hasFocusedOnce = useRef(false);
  const statusRailOpacity = useSharedValue(0); // Start at 0, fade in when ready/focused
  const statusRailOffset = useSharedValue(0);
  const homeMorphProgress = useSharedValue(0);
  const pullDownPosition = useSharedValue(0);
  const scrollPosition = useSharedValue(0);
  const isReadyToRefresh = useSharedValue(false);
  const refreshSpin = useSharedValue(0);
  const refreshingProgress = useSharedValue(0);
  const statusRefs = useRef<Record<string, any>>({});
  const readyHintRef = useRef(false);
  const smoothPull = useDerivedValue(() => withSpring(pullDownPosition.value, PULL_SPRING), [pullDownPosition]);
  const statusRailAnimStyle = useAnimatedStyle(() => ({
    opacity: statusRailOpacity.value,
    transform: [{ translateY: statusRailOffset.value }],
  }));

const homeContentAnimatedStyle = useAnimatedStyle(() => {
  const baseTranslateY = interpolate(homeMorphProgress.value, [0, 1], [0, 45], Extrapolation.IDENTITY);
  return {
    transform: [
      { translateY: baseTranslateY + smoothPull.value },
      { scale: interpolate(homeMorphProgress.value, [0, 1], [1, 0.92], Extrapolation.IDENTITY) },
    ] as any,
    opacity: Platform.OS === 'android'
      ? 1
      : interpolate(homeMorphProgress.value, [0, 0.6], [1, 1], Extrapolation.CLAMP),
  };
});

  const refreshContainerStyle = useAnimatedStyle(() => ({
    height: smoothPull.value,
    opacity: interpolate(smoothPull.value, [0, 20, PULL_LOCK_DISTANCE], [0, 0.35, 1], Extrapolation.CLAMP),
  }));

  const refreshPillStyle = useAnimatedStyle(() => {
    const readyProgress = interpolate(
      smoothPull.value,
      [PULL_REFRESH_TRIGGER - 18, PULL_REFRESH_TRIGGER + 12],
      [0, 1],
      Extrapolation.CLAMP
    );

    const idleToPull = interpolate(
      smoothPull.value,
      [0, PULL_LOCK_DISTANCE, PULL_MAX_DISTANCE],
      [-44, 0, 2],
      Extrapolation.CLAMP
    );

    const refreshingBob = isRefreshing
      ? Math.sin(refreshSpin.value * Math.PI * 2) * 1.7
      : 0;

    return {
      transform: [
        { translateY: idleToPull + refreshingBob },
        {
          scale:
            interpolate(smoothPull.value, [0, PULL_LOCK_DISTANCE], [0.9, 1], Extrapolation.CLAMP)
            + readyProgress * 0.02,
        },
      ] as any,
      opacity: interpolate(smoothPull.value, [0, 20, PULL_LOCK_DISTANCE], [0, 0.62, 1], Extrapolation.CLAMP),
    };
  });

  const refreshRingStyle = useAnimatedStyle(() => {
    const pullProgress = interpolate(smoothPull.value, [0, PULL_LOCK_DISTANCE], [0, 1], Extrapolation.CLAMP);
    const pulse = isRefreshing
      ? (Math.sin(refreshSpin.value * Math.PI * 4) + 1) / 2 // Faster pulse during refresh
      : 0;

    return {
      opacity: 0.2 + pullProgress * 0.45 + (isRefreshing ? 0.25 : 0),
      transform: [{ scale: 0.75 + pullProgress * 0.35 + pulse * 0.08 }] as any,
      borderWidth: interpolate(pullProgress, [0, 1], [1.2, 1.8], Extrapolation.CLAMP),
      borderColor: interpolateColor(
        pullProgress + (isRefreshing ? 1 : 0),
        [0, 1, 2],
        ['rgba(255,255,255,0.2)', 'rgba(59,130,246,0.8)', 'rgba(188,0,42,1)']
      ) as string,
    };
  });

  const refreshIconStyle = useAnimatedStyle(() => {
    const pullScale = interpolate(
      smoothPull.value,
      [0, PULL_LOCK_DISTANCE],
      [0.45, 1],
      Extrapolation.CLAMP
    );
    const pullRotation = interpolate(
      smoothPull.value,
      [0, PULL_MAX_DISTANCE],
      [0, 360],
      Extrapolation.CLAMP
    );
    const refreshingRotation = refreshSpin.value * 360;

    return {
      opacity: interpolate(refreshingProgress.value, [0, 0.45], [1, 0], Extrapolation.CLAMP),
      transform: [
        { scale: interpolate(refreshingProgress.value, [0, 0.5], [pullScale, 0.2], Extrapolation.CLAMP) },
        { rotate: `${pullRotation + refreshingRotation}deg` },
        { perspective: 1000 },
        { rotateY: `${interpolate(refreshingProgress.value, [0, 1], [0, 180])}deg` }
      ] as any,
    };
  });

  const refreshTitleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(smoothPull.value, [10, PULL_LOCK_DISTANCE], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(smoothPull.value, [0, PULL_LOCK_DISTANCE], [8, 0], Extrapolation.CLAMP) }] as any,
  }));

  const refreshHintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(smoothPull.value, [30, PULL_LOCK_DISTANCE], [0, 0.95], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(smoothPull.value, [0, PULL_LOCK_DISTANCE], [10, 0], Extrapolation.CLAMP) }] as any,
  }));

  const refreshLogoStyle = useAnimatedStyle(() => ({
    opacity: interpolate(refreshingProgress.value, [0.35, 0.75], [0, 1], Extrapolation.CLAMP),
    transform: [
      {
        scale: interpolate(refreshingProgress.value, [0, 1], [0.6, 1], Extrapolation.CLAMP),
      },
      { perspective: 1000 },
      { rotateY: `${interpolate(refreshingProgress.value, [0, 1], [-180, 0])}deg` }
    ] as any,
  }));

  const homeBackdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: homeMorphProgress.value * 0.11,
    transform: [
      { scale: 1 + homeMorphProgress.value * 0.012 },
      { translateY: homeMorphProgress.value * -10 },
    ] as any,
  }));

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
      
      chatTransitionState.setPhase('idle');
      homeMorphProgress.value = 1;
      if (!hasFocusedOnce.current) {
        hasFocusedOnce.current = true;
        homeMorphProgress.value = 0;
        statusRailOpacity.value = withTiming(1, { duration: 600 });
        statusRailOffset.value = 0;
        return;
      }
      homeMorphProgress.value = withTiming(0, {
        duration: HOME_MORPH_DURATION,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
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
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      });
    });
    return unsubscribe;
  }, [homeMorphProgress, navigation, statusRailOpacity]);

  // Safety & Ready Trigger: Ensure visibility if focus listener fails or when app becomes ready
  useEffect(() => {
    if (isReady && isFocused) {
        if (statusRailOpacity.value === 0) {
            statusRailOpacity.value = withTiming(1, { duration: 600 });
        }
        if (homeMorphProgress.value === 1 && !chatTransitionState.getPhase().includes('returning')) {
             console.log('[HomeScreen] Ready Visibility Trigger');
             homeMorphProgress.value = withTiming(0, { 
               duration: 600,
               easing: Easing.bezier(0.22, 1, 0.36, 1)
             });
        }
    }
  }, [isReady, isFocused]);

  useEffect(() => {
    const unsubscribe = chatTransitionState.subscribe((phase) => {
      if (phase === 'entering') {
        homeMorphProgress.value = withTiming(1, {
          duration: HOME_MORPH_DURATION,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
        });
        return;
      }

      if (phase === 'returning') {
        homeMorphProgress.value = 1;
        statusRailOpacity.value = 0; // Start from 0 to avoid pop
        statusRailOffset.value = -30;
        homeMorphProgress.value = withTiming(0, {
          duration: HOME_MORPH_DURATION,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
        });
        statusRailOpacity.value = withTiming(1, {
          duration: 400,
          easing: Easing.out(Easing.cubic),
        });
        statusRailOffset.value = withTiming(0, {
          duration: HOME_MORPH_DURATION,
          easing: Easing.bezier(0.22, 1, 0.36, 1),
        });
      }
    });

    return unsubscribe;
  }, [homeMorphProgress, statusRailOpacity]);

  useEffect(() => {
    refreshingProgress.value = withTiming(isRefreshing ? 1 : 0, {
      duration: isRefreshing ? 150 : 110,
      easing: Easing.out(Easing.cubic),
    });

    if (isRefreshing) {
      refreshSpin.value = 0;
      refreshSpin.value = withRepeat(
        withTiming(1, { duration: 980, easing: Easing.linear }),
        -1,
        false
      );
      return;
    }

    cancelAnimation(refreshSpin);
    refreshSpin.value = withTiming(0, { duration: 120 });
  }, [isRefreshing, refreshSpin, refreshingProgress]);

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

      const chatMsgs = messages?.[primaryId] || messages?.[altId] || [];
      const hasMessages = chatMsgs.length > 0;
      const hasMeaningfulLastMessage = !!contact.lastMessage && contact.lastMessage !== 'Start a conversation';

      const isArchived = contact.isArchived === true;
      return (isSelfSuperUserInteraction || hasMessages || hasMeaningfulLastMessage) && !isArchived;
    });
  }, [contacts, messages, statuses, currentUser]);

  const filteredVisibleContacts = useMemo(() => {
    return visibleContacts;
  }, [visibleContacts]);

  const contactsWithStories = useMemo(() => {
    return visibleContacts.filter(c => contactStatusGroupsMap.has(c.id));
  }, [visibleContacts, contactStatusGroupsMap]);

  const isNoteValid = (timestamp?: string) => {
    if (!timestamp) return false;
    const noteDate = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - noteDate.getTime();
    return diff < 24 * 60 * 60 * 1000; // 24 hours
  };

  const handleStatusPress = (contact: Contact) => {
    router.push({ pathname: '/view-status', params: { id: contact.id } });
  };

  const handleMyStatusPress = () => {
    if (!currentUser) return;
    
    // Auto-retry failures
    if (pendingStatusUploads.some(upload => upload.uploadStatus === 'failed')) {
      void retryPendingStatusUploads();
    }

    if (myStatuses.length > 0 || pendingStatusUploads.length > 0) {
      router.push('/my-status');
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
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return Alert.alert('Permission needed', 'Camera permission required.');
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.8,
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: true,
        videoMaxDuration: 60,
      });
      await createStatus(result);
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

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) return Alert.alert('Permission needed', 'Gallery permission required.');
      const result = await ImagePicker.launchImageLibraryAsync({
        quality: 0.8,
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: true,
        videoMaxDuration: 60,
        legacy: true,
      });
      await createStatus(result);
  };

  const handleUserSelect = useCallback((contact: Contact, y: number) => {
    chatTransitionState.setPhase('entering');
    homeMorphProgress.value = withTiming(1, {
      duration: HOME_MORPH_DURATION,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
    requestAnimationFrame(() => {
      router.push({
        pathname: '/chat/[id]',
        params: {
          id: contact.id,
          sourceY: y.toString(),
        }
      });
    });
  }, [homeMorphProgress, router]);

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
      
      return (
        <Pressable 
          ref={ref => statusRefs.current['my-status'] = ref}
          style={styles.statusCard} 
          onPress={() => handleMyStatusPress()}
        >
          <View style={styles.statusCardSurface}>
            <View style={[styles.myStatusBackground, (hasStatus || hasPendingUploads) && { justifyContent: 'center', alignItems: 'center' }]}>
              {hasPendingUploads && firstPending ? (
                <View style={StyleSheet.absoluteFill}>
                  <Image source={{ uri: firstPending.localUri }} style={[styles.myStatusPreviewBgFull, { opacity: 0.6 }]} />
                  <View style={styles.uploadingOverlay}>
                    <View style={{ justifyContent: 'center', alignItems: 'center' }}>
                      <StatusProgressRing 
                          progress={firstPending ? (statusUploadProgress[firstPending.id] || 0) / 100 : 0}
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
                  <StatusThumbnail 
                    statusId={latestMyStatus.id}
                    mediaKey={latestMyStatus.mediaKey}
                    uriHint={latestMyStatus.mediaLocalPath || latestMyStatus.mediaUrl}
                    mediaType={latestMyStatus.mediaType as any}
                    style={styles.myStatusPreviewBgFull}
                  />
                  <LinearGradient
                    colors={['rgba(0,0,0,0.5)', 'transparent']}
                    style={styles.myStatusTopGradient}
                  />
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

    return (
      <Pressable 
        key={contact.id}
        ref={ref => statusRefs.current[contact.id] = ref}
        style={styles.statusCard} 
        onPress={() => handleStatusPress(contact)}
      >
        <View style={styles.statusCardSurface}>
          {hasStatus ? (
            <StatusThumbnail 
              statusId={latestStatus.id}
              mediaKey={latestStatus.mediaKey}
              uriHint={latestStatus.mediaLocalPath || latestStatus.mediaUrl}
              mediaType={latestStatus.mediaType as any}
              style={styles.statusMediaBackground}
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
                    size={34} 
                    avatarType={contact.avatarType as any} 
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
    );
  }, [
    myStatuses,
    currentUser,
    contactStatusGroupsMap,
    pendingStatusUploads,
    isStatusSyncing,
    handleMyStatusPress,
    handleStatusPress
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
          Alert.alert('Delete Chat', `Are you sure?`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => clearChatMessages(item.id) }
          ]);
        }}
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
            onLongPress={() => {}}
            getPresence={getPresence}
            connectivity={connectivity}
            onSelect={handleUserSelect}
            homeMorphProgress={homeMorphProgress}
        />
      </SwipeableRow>
    );
  }, [lastMessagesMap, typingUsers, getPresence, connectivity, handleUserSelect, homeMorphProgress, archiveContact, clearChatMessages, unfriendContact]);

  const keyExtractor = useCallback((item: Contact) => item.id, []);

  const triggerRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setRefreshHint('Syncing chats...');
    
    // Premium Haptic: Successful start
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const startedAt = Date.now();
    try {
      await Promise.resolve(refreshLocalCache());
    } catch (error) {
      console.warn('[HomeScreen] refreshLocalCache failed:', error);
    } finally {
      const elapsed = Date.now() - startedAt;
      const minVisibleDuration = 900;
      if (elapsed < minVisibleDuration) {
        await new Promise((resolve) => setTimeout(resolve, minVisibleDuration - elapsed));
      }
      setIsRefreshing(false);
      setRefreshHint('Pull to refresh');
      readyHintRef.current = false;
      pullDownPosition.value = withSpring(0, PULL_SPRING);
    }
  }, [isRefreshing, refreshLocalCache, pullDownPosition]);

  const onPanRelease = useCallback(() => {
    const shouldRefresh = isReadyToRefresh.value;
    pullDownPosition.value = withSpring(shouldRefresh ? PULL_LOCK_DISTANCE : 0, PULL_SPRING);

    if (shouldRefresh) {
      isReadyToRefresh.value = false;
      void triggerRefresh();
      return;
    }

    setRefreshHint('Pull to refresh');
    readyHintRef.current = false;
  }, [isReadyToRefresh, pullDownPosition, triggerRefresh]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) => {
          if (isRefreshing) return false;
          const isPullingDown = gestureState.dy > 0 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx);
          return scrollPosition.value <= 0 && isPullingDown;
        },
        onPanResponderMove: (_, gestureState) => {
          const dragY = Math.max(gestureState.dy, 0);
          const resistedPull =
            dragY <= PULL_REFRESH_TRIGGER
              ? dragY * 0.94
              : PULL_REFRESH_TRIGGER * 0.94 + (dragY - PULL_REFRESH_TRIGGER) * 0.42;
          const nextPull = Math.min(PULL_MAX_DISTANCE, resistedPull);
          pullDownPosition.value = nextPull;
          const nextReady = nextPull >= PULL_REFRESH_TRIGGER;
          isReadyToRefresh.value = nextReady;

          if (nextReady !== readyHintRef.current) {
            readyHintRef.current = nextReady;
            setRefreshHint(nextReady ? 'Release to sync' : 'Pull to refresh');
            
            // Premium Haptic: Threshold crossed
            if (nextReady) {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            } else {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
          }
        },
        onPanResponderRelease: onPanRelease,
        onPanResponderTerminate: onPanRelease,
      }),
    [isRefreshing, scrollPosition, pullDownPosition, isReadyToRefresh, onPanRelease]
  );

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      scrollPosition.value = y;
      runOnJS(handleScrollMotionRaw)(y);
    },
  });

  const renderHeader = useCallback(() => (
    <View style={styles.homeHeaderWrapper}>
      <View style={styles.topHeader}>
        <View style={styles.headerActions}>
          <Text style={styles.headerTitle}>Soul</Text>
          <AnimatedMoreMenu router={router} isSearching={false} />
        </View>
      </View>
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
    </View>
  ), [contactsWithStories, renderStatusItem, statusRailAnimStyle, router]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      
      {/* Offline Connectivity Banner */}
      {(!connectivity.isDeviceOnline || !connectivity.isServerReachable) && (
        <Animated.View 
          entering={FadeIn} 
          exiting={FadeOut}
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.9)', // Red-500 with slight glass effect
            paddingVertical: 4,
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <MaterialIcons name="wifi-off" size={14} color="#fff" style={{ marginRight: 6 }} />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.5 }}>
              OFFLINE MODE
            </Text>
          </View>
        </Animated.View>
      )}

      <Animated.View pointerEvents="none" style={[styles.refreshContainer, refreshContainerStyle]}>
        <Animated.View style={[styles.refreshPill, refreshPillStyle]}>
          <Animated.View style={[styles.refreshRing, refreshRingStyle]} />
          <Animated.View style={[styles.refreshLogoWrap, refreshLogoStyle]}>
            <Image source={require('../../assets/images/logo.jpg')} style={styles.refreshLogo} />
          </Animated.View>
          <Animated.View style={refreshIconStyle}>
            <MaterialIcons name="autorenew" size={18} color="#fff" />
          </Animated.View>
          <Animated.Text style={[styles.refreshPillTitle, refreshTitleStyle]}>Soul</Animated.Text>
          <Animated.Text style={[styles.refreshPillSubtitle, refreshHintStyle]}>{refreshHint}</Animated.Text>
        </Animated.View>
      </Animated.View>

      <Animated.View pointerEvents="none" style={[styles.homeMorphBackdrop, homeBackdropAnimatedStyle]} />
      <Animated.View
        pointerEvents={isRefreshing ? 'none' : 'auto'}
        style={[styles.homeContent, homeContentAnimatedStyle]}
        {...panResponder.panHandlers}
      >
        <Animated.FlatList
          data={filteredVisibleContacts}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={styles.listContent}
          bounces={!isRefreshing}
          scrollEnabled={!isRefreshing}
          showsVerticalScrollIndicator={false}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
        />
      </Animated.View>

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
            setIsNoteModalVisible(true);
        }}
      />

      <NoteCreatorModal
        visible={isNoteModalVisible}
        onClose={closeModalRobustly}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  refreshContainer: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 108 : 86,
    left: 0,
    right: 0,
    zIndex: 1600,
    alignItems: 'center',
    overflow: 'hidden',
  },
  refreshPill: {
    width: 180,
    height: 92,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 4,
    gap: 1,
  },
  refreshRing: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.4,
  },
  refreshLogoWrap: {
    position: 'absolute',
    top: 7,
  },
  refreshLogo: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  refreshPillTitle: {
    color: '#fff',
    marginTop: 18,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.45,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  refreshPillSubtitle: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 0.2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  homeMorphBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  homeContent: {
    flex: 1,
  },
  homeHeaderWrapper: { paddingTop: Platform.OS === 'ios' ? 50 : 30, zIndex: 1000, elevation: 10 },
  topHeader: { 
    paddingHorizontal: 20,
    paddingVertical: 10,
    height: 60,
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
  statusRail: { marginTop: 15, marginBottom: 0, overflow: 'visible' },
  statusContent: { paddingHorizontal: 20, paddingVertical: 12, paddingTop: 35, gap: 14, overflow: 'visible' },
  statusCard: { 
    width: 115, 
    height: 175, 
    marginTop: 10, 
    borderRadius: 28, 
    backgroundColor: 'transparent', 
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
        elevation: 10,
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
  listContent: { paddingBottom: 100, paddingHorizontal: 4 },
  chatItem: { marginBottom: 8, marginHorizontal: 16, borderRadius: 36, height: 72 },
  notePositioner: {
      position: 'absolute',
      top: -34,
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 100,
  },
  // Removed overflow: 'hidden' to let shared elements escape during flight
  chatPillContainer: { flex: 1, borderRadius: 36, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.22)', overflow: 'hidden' },
  pillBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0, 0, 0, 0.15)', opacity: 0.95 },
  pillBlur: { ...StyleSheet.absoluteFillObject },
  pillContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },
  avatarContainer: { position: 'relative' },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  onlineIndicator: { position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e', borderWidth: 2, borderColor: '#151515' },
  chatContent: { flex: 1, justifyContent: 'center' },
  contactName: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.5 },
  lastMessage: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500' },
  rightSide: { alignItems: 'flex-end', justifyContent: 'center', paddingRight: 4, gap: 4 },
  timestamp: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '600' },
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
