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
  ScrollView,
} from 'react-native';
import { Svg, Circle } from 'react-native-svg';
// FlashList available but FlatList used for stability
// import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import GlassView from '../../components/ui/GlassView';
import ConnectionBanner from '../../components/ConnectionBanner';
import { SoulPullToRefresh } from '../../components/ui/SoulPullToRefresh';
import ChatListItemSkeleton from '../../components/ui/ChatListItemSkeleton';
import StatusRailSkeleton from '../../components/ui/StatusRailSkeleton';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  Easing,
  SharedTransition,
  interpolate,
  Extrapolation,
  useDerivedValue,
} from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
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

import { useApp } from '../../context/AppContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePresence } from '../../context/PresenceContext';
import { useScrollMotion } from '../../components/navigation/ScrollMotionProvider';
import { normalizeId, getSuperuserName, LEGACY_TO_UUID, UUID_TO_LEGACY } from '../../utils/idNormalization';

import LottieView from 'lottie-react-native';
import { SoulAvatar } from '../../components/SoulAvatar';
import { StatusThumbnail } from '../../components/StatusThumbnail';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { Contact } from '../../types';
import { NoteBubble } from '../../components/NoteBubble';
import { NoteCreatorModal } from '../../components/NoteCreatorModal';
import ChatListContextMenu from '../../components/chat/ChatListContextMenu';
import { SUPPORT_SHARED_TRANSITIONS } from '../../constants/sharedTransitions';
const DEFAULT_AVATAR = '';
const ENABLE_SHARED_TRANSITIONS = SUPPORT_SHARED_TRANSITIONS;
const HOME_MORPH_DURATION = 500;

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
const pillSharedTransition = SharedTransition.custom((values) => {
  'worklet';
  const liquidMorph = {
    duration: 500,
    easing: Easing.bezier(0.5, 0, 0.1, 1),
  };
  return {
    originX: withTiming(values.targetOriginX, liquidMorph),
    originY: withTiming(values.targetOriginY, liquidMorph),
    width: withTiming(values.targetWidth, liquidMorph),
    height: withTiming(values.targetHeight, liquidMorph),
    borderRadius: withTiming(values.targetBorderRadius, liquidMorph),
  };
}).duration(500);
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
}

const ChatListItem = React.memo(({ item, index, lastMsg, onSelect, onLongPress, isTyping, getPresence, connectivity, homeMorphProgress, selectedPillId, unreadCount, isPinned, isMuted, isClone }: ChatListItemProps) => {
  const scaleAnim = useSharedValue(1);
  const opacityAnim = useSharedValue(1);
  const itemRef = useRef<View>(null);

  const animatedStyle = useAnimatedStyle(() => {
    // Only apply shifts and scales to UNSELECTED items to clear them out.
    // The SELECTED item should stay perfectly still relative to its container for the Shared Transition.
    const isItemSelected = selectedPillId.value === item.id;
    
    if (Platform.OS === 'android') {
      return {
        transform: [{ scale: scaleAnim.value }],
        opacity: isItemSelected ? 1 : opacityAnim.value * interpolate(homeMorphProgress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
      };
    }

    const translateShift = isItemSelected ? 0 : interpolate(homeMorphProgress.value, [0, 1], [0, 35 + (index % 5) * 20], Extrapolation.IDENTITY);
    const scaleShift = isItemSelected ? 1 : interpolate(homeMorphProgress.value, [0, 1], [1, 0.92], Extrapolation.IDENTITY);

    return {
      transform: [
        { scale: scaleAnim.value } as any,
        { translateY: translateShift } as any,
        { scale: scaleShift } as any
      ],
      opacity: isClone ? 1 : opacityAnim.value * interpolate(homeMorphProgress.value, [0, 0.7], [1, 0], Extrapolation.CLAMP),
    };
  });

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
      {/* Outer morph target - ONLY handles the shared element transition */}
      <Animated.View 
        {...(ENABLE_SHARED_TRANSITIONS && !isClone
          ? {
              sharedTransitionTag: `pill-${item.id}`,
              sharedTransitionStyle: pillSharedTransition,
            }
          : {})}
        style={[styles.chatPillContainer]}
      >
        {/* Inner container handles the press scale animation */}
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          {/* Glass background — blur on iOS, solid on Android (flattened for perf) */}
          {Platform.OS === 'android' ? (
            <View style={[StyleSheet.absoluteFill, { borderRadius: 36, backgroundColor: '#0A0A0A' }]} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { borderRadius: 36, overflow: 'hidden' }]}>
              <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
            </View>
          )}
        {/* Subtle dark tint overlay */}
        <View
            style={[StyleSheet.absoluteFill, { borderRadius: 36, backgroundColor: 'rgba(0, 0, 0, 0.15)' }]}
        />
            
        {/* Content rendered safely as an overlay, decoupled from Reanimated's snapshot engine */}
        <View style={[styles.pillContent, { position: 'absolute', width: '100%', height: '100%', paddingHorizontal: 16 }]} pointerEvents="box-none">
          <Animated.View 
            {...(ENABLE_SHARED_TRANSITIONS && !isClone
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
              size={46}
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
              {...(ENABLE_SHARED_TRANSITIONS && !isClone
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
    progress.value = withTiming(expanded ? 1 : 0, { duration: 220, easing: Easing.out(Easing.cubic) });
  }, [expanded]);

  useEffect(() => {
    if (isSearching) setExpanded(false);
  }, [isSearching]);

  const containerStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [40, 200]),
    height: interpolate(progress.value, [0, 1], [40, 270]),
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

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.92, { damping: 12, stiffness: 300 });
    opacity.value = withTiming(0.8, { duration: 100 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 12, stiffness: 300 });
    opacity.value = withTiming(1, { duration: 150 });
  };

  return (
    <Pressable
      onPress={() => onPress(id)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      <Animated.View
        style={[
          {
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderRadius: 20,
            backgroundColor: isActive ? `${activeTheme.primary}26` : 'rgba(255,255,255,0.06)',
            borderWidth: isActive ? 1 : 0,
            borderColor: isActive ? activeTheme.primary : 'transparent',
            justifyContent: 'center',
            alignItems: 'center',
          },
          animatedStyle
        ]}
      >
        <Text
          style={{
            color: isActive ? activeTheme.primary : 'rgba(255,255,255,0.5)',
            fontSize: 13,
            fontWeight: '600',
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
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
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [selectedChatForMenu, setSelectedChatForMenu] = useState<Contact | null>(null);
  const [menuLayout, setMenuLayout] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chatFilter, setChatFilter] = useState<'all' | 'unread' | 'favorites' | 'groups'>('all');
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [mutedChatIds, setMutedChatIds] = useState<string[]>([]);
  const [showWelcomeAnim, setShowWelcomeAnim] = useState(false);
  const welcomeAnimRef = useRef<LottieView>(null);

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
  const selectedPillId = useSharedValue('');
  const scrollPosition = useSharedValue(0);
  const statusRefs = useRef<Record<string, any>>({});
  // Telegram-style: status rail collapses as user scrolls down
  const RAIL_FULL_HEIGHT = 200;  // Full status rail height (cards + padding)
  const RAIL_COLLAPSED_HEIGHT = 75; // Collapsed: just circle avatars
  const COLLAPSE_SCROLL = 120;   // Scroll distance to fully collapse

  const statusRailAnimStyle = useAnimatedStyle(() => {
    const scrollY = scrollPosition.value;
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
    opacity: interpolate(homeMorphProgress.value, [0, 0.6], [1, 1], Extrapolation.CLAMP),
  };
});



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
      selectedPillId.value = ''; // Clear selection on return
      if (!hasFocusedOnce.current) {
        hasFocusedOnce.current = true;
        homeMorphProgress.value = 0;
        statusRailOpacity.value = withTiming(1, { duration: 600 });
        statusRailOffset.value = 0;
        return;
      }
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

  // Safety & Ready Trigger: Ensure visibility if focus listener fails or when app becomes ready
  useEffect(() => {
    if (isReady && isFocused) {
        if (statusRailOpacity.value === 0) {
            statusRailOpacity.value = withTiming(1, { duration: 600 });
        }
        if (homeMorphProgress.value === 1 && !chatTransitionState.getPhase().includes('returning')) {
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

  const handleUserSelect = useCallback((contact: Contact, y: number) => {
    chatTransitionState.setPhase('entering');
    selectedPillId.value = contact.id;
    homeMorphProgress.value = withTiming(1, {
      duration: HOME_MORPH_DURATION,
      easing: Easing.bezier(0.5, 0, 0.1, 1),
    });
    router.push({
      pathname: '/chat/[id]',
      params: {
        id: contact.id,
        sourceY: y.toString(),
      }
    });
  }, [homeMorphProgress, router]);

  // Telegram-style card morph: rectangle → circle avatar on scroll
  const StatusCardWrapper = useCallback(({ children, index }: { children: React.ReactNode; index: number }) => {
    const cardStyle = useAnimatedStyle(() => {
      const p = railCollapseProgress.value;
      const scale = interpolate(p, [0, 1], [1, 0.42], Extrapolation.CLAMP);
      const borderRadius = interpolate(p, [0, 1], [28, 50], Extrapolation.CLAMP);
      const translateX = interpolate(p, [0, 1], [0, -index * 42], Extrapolation.CLAMP);
      const translateY = interpolate(p, [0, 1], [0, 10], Extrapolation.CLAMP);

      return {
        transform: [{ scale }, { translateX }, { translateY }] as any,
        borderRadius,
      };
    });

    return (
      <Animated.View style={[styles.statusCard, cardStyle as any]}>
        {children}
      </Animated.View>
    );
  }, [railCollapseProgress]);

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
        <StatusCardWrapper index={index}>
        <Pressable
          ref={ref => statusRefs.current['my-status'] = ref}
          style={{ flex: 1 }}
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
                  {latestMyStatus.mediaType === 'text' ? (
                    <LinearGradient
                      colors={[latestMyStatus.backgroundColor || '#6366f1', (latestMyStatus.backgroundColor || '#6366f1') + 'CC']}
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

    return (
      <StatusCardWrapper index={index}>
      <Pressable
        key={contact.id}
        ref={ref => statusRefs.current[contact.id] = ref}
        style={{ flex: 1 }}
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
                    size={42} 
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
        />
      </SwipeableRow>
    );
  }, [lastMessagesMap, typingUsers, getPresence, connectivity, handleUserSelect, homeMorphProgress, archiveContact, clearChatMessages, unfriendContact, pinnedChatIds, mutedChatIds]);

  const keyExtractor = useCallback((item: Contact) => item.id, []);

  const triggerRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    
    // Premium Haptic: Successful start
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    try {
      await refreshLocalCache();
    } catch (error) {
      console.warn('[HomeScreen] refreshLocalCache failed:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, refreshLocalCache]);


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
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: -1, marginBottom: 8 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 6, gap: 8 }}
      >
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
        <Pressable 
          onPress={() => router.push('/create-group')}
          style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: 'rgba(255,255,255,0.06)',
              justifyContent: 'center',
              alignItems: 'center'
          }}
        >
          <MaterialIcons name="add" size={18} color="rgba(255,255,255,0.6)" />
        </Pressable>
      </ScrollView>
    </View>
  ), [contactsWithStories, renderStatusItem, statusRailAnimStyle, router, chatFilter]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      
      <ConnectionBanner connectivity={connectivity} mode="inline" />

      <SoulPullToRefresh onRefresh={triggerRefresh}>
        {({ onScroll: onPullScroll }) => (
          <Animated.View
            style={[styles.homeContent, homeContentAnimatedStyle]}
          >
            {!isReady ? (
               <View style={{ flex: 1 }}>
                 <StatusRailSkeleton />
                 <View style={{ marginTop: 20 }}>
                   {[1, 2, 3, 4, 5, 6].map(i => <ChatListItemSkeleton key={i} />)}
                 </View>
               </View>
            ) : (
              <Animated.FlatList
                data={filteredVisibleContacts}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                ListHeaderComponent={renderHeader()}
                contentContainerStyle={styles.listContent}
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
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 100 }}>
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
            switch(action) {
                case 'pin': togglePinChat(selectedChatForMenu.id); break;
                case 'mute': toggleMuteChat(selectedChatForMenu.id); break;
                case 'archive': archiveContact(selectedChatForMenu.id); break;
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
  homeHeaderWrapper: { paddingTop: Platform.OS === 'ios' ? 44 : 20, zIndex: 1000, elevation: 10 },
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
  statusRail: { marginTop: 0, marginBottom: 0, overflow: 'visible' },
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
  chatPillContainer: { 
    flex: 1, 
    borderRadius: 36, 
    borderWidth: 1, 
    borderColor: Platform.OS === 'android' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.22)', 
    overflow: 'hidden' 
  },

  pillBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0, 0, 0, 0.15)', opacity: 0.95 },
  pillBlur: { ...StyleSheet.absoluteFillObject },
  pillContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 14 },
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
