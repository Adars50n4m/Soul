import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, Image, Pressable, StyleSheet, StatusBar, Dimensions, Alert, FlatList, Platform, TouchableOpacity, RefreshControl, ActionSheetIOS, TextInput, Modal } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import GlassView from '../../components/ui/GlassView';
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
} from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { storageService } from '../../services/StorageService';
import { proxySupabaseUrl } from '../../config/api';
import { chatTransitionState } from '../../services/chatTransitionState';
import SwipeableRow from '../../components/ui/SwipeableRow';

import { useApp } from '../../context/AppContext';
import { usePresence } from '../../context/PresenceContext';
import { useScrollMotion } from '../../components/navigation/ScrollMotionProvider';
import { normalizeId, getSuperuserName, LEGACY_TO_UUID, UUID_TO_LEGACY } from '../../utils/idNormalization';
import { SHRI_ID, HARI_ID } from '../../config/supabase';
import { SoulAvatar } from '../../components/SoulAvatar';
import { StatusViewerModal } from '../../components/StatusViewerModal';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { Contact, Story } from '../../types';
import { NoteBubble } from '../../components/NoteBubble';
import { NoteCreatorModal } from '../../components/NoteCreatorModal';
const DEFAULT_AVATAR = '';
const ENABLE_SHARED_TRANSITIONS = Platform.OS === 'ios';
const HOME_MORPH_DURATION = 480;

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

let hasRenderedHomeOnce = false;

interface ChatListItemProps {
  item: Contact;
  index: number;
  lastMsg: { text?: string; timestamp?: string };
  onSelect: (contact: Contact, y: number) => void;
  isTyping: boolean;
  getPresence: (userId: string) => { isOnline: boolean; lastSeen: string | null };
  connectivity: { isDeviceOnline: boolean; isServerReachable: boolean; isRealtimeConnected: boolean };
  homeMorphProgress: Animated.SharedValue<number>;
}

const ChatListItem = React.memo(({ item, index, lastMsg, onSelect, isTyping, getPresence, connectivity, homeMorphProgress }: ChatListItemProps) => {
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
    height: interpolate(progress.value, [0, 1], [40, 134]),
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

export default function HomeScreen() {
  const {
    contacts,
    messages,
    activeTheme,
    typingUsers,
    currentUser,
    statuses,
    addStatus,
    deleteStatus,
    toggleStatusLike,
    connectivity,
    refreshLocalCache,
    archiveContact,
    unfriendContact,
    clearChatMessages,
    addStatusView,
    sendChatMessage,
  } = useApp();
  const { getPresence } = usePresence();
  const navigation = useNavigation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { onScroll: handleScrollMotion } = useScrollMotion('index');

  // Status Handlers
  const [selectedStatusContact, setSelectedStatusContact] = useState<Contact | null>(null);
  const [isViewerVisible, setIsViewerVisible] = useState(false);
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [isNoteModalVisible, setIsNoteModalVisible] = useState(false);
  const [statusMediaPreview, setStatusMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' } | null>(null);
  const [isUploadingStatus, setIsUploadingStatus] = useState(false);
  const [statusInitialLayout, setStatusInitialLayout] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  const statusRefs = useRef<Record<string, any>>({});
  const statusRailOpacity = useSharedValue(hasRenderedHomeOnce ? 0 : 1);
  const statusRailOffset = useSharedValue(0);
  const homeMorphProgress = useSharedValue(0);
  const hasFocusedOnce = useRef(false);
  const statusRailAnimStyle = useAnimatedStyle(() => ({
    opacity: statusRailOpacity.value,
    transform: [{ translateY: statusRailOffset.value }],
  }));

const homeContentAnimatedStyle = useAnimatedStyle(() => ({
  transform: [
    { translateY: interpolate(homeMorphProgress.value, [0, 1], [0, 45], Extrapolation.IDENTITY) },
    { scale: interpolate(homeMorphProgress.value, [0, 1], [1, 0.92], Extrapolation.IDENTITY) },
  ] as any,
  opacity: Platform.OS === 'android' 
    ? 1 
    : interpolate(homeMorphProgress.value, [0, 0.6], [1, isViewerVisible ? 0 : 1], Extrapolation.CLAMP),
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
    const shouldHideTabBar = isViewerVisible || isMediaPickerVisible || !!statusMediaPreview || isNoteModalVisible;
    navigation.setOptions({
      tabBarStyle: { display: shouldHideTabBar ? 'none' : 'flex' }
    });
  }, [isViewerVisible, isMediaPickerVisible, statusMediaPreview, isNoteModalVisible, navigation]);

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
        hasRenderedHomeOnce = true;
        homeMorphProgress.value = 0;
        statusRailOpacity.value = 1;
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

  // Safety: Ensure visibility if focus listener fails or is delayed on mount (common on Android cold boots)
  useEffect(() => {
    if (isFocused && homeMorphProgress.value === 1) {
       const timer = setTimeout(() => {
         if (homeMorphProgress.value === 1) {
           console.log('[HomeScreen] Safety Visibility Trigger');
           homeMorphProgress.value = withTiming(0, { 
             duration: 500,
             easing: Easing.bezier(0.22, 1, 0.36, 1)
           });
         }
       }, 800);
       return () => clearTimeout(timer);
    }
  }, [isFocused]);

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

  const contactStoriesMap = useMemo(() => {
    const map = new Map<string, Story[]>();
    try {
      (statuses || []).forEach(s => {
        const story: Story = {
          id: s.id,
          url: proxySupabaseUrl(s.mediaUrl),
          type: s.mediaType,
          timestamp: s.timestamp,
          seen: false,
          caption: s.caption || '',
          userId: s.userId,
          likes: s.likes || [],
          views: s.views || [],
          music: s.music,
        };
        const primaryUserId = normalizeId(s.userId);
        if (!map.has(primaryUserId)) map.set(primaryUserId, []);
        map.get(primaryUserId)!.push(story);
      });
    } catch (e) {
      console.warn('[HomeScreen] Error building contactStoriesMap:', e);
    }
    return map;
  }, [statuses]);

  const myStories = useMemo(
    () => currentUser ? (contactStoriesMap.get(normalizeId(currentUser.id)) || []) : [],
    [contactStoriesMap, currentUser]
  );

  const visibleContacts = useMemo(() => {
    if (!contacts) return [];
    const legacyToUuid = LEGACY_TO_UUID;
    const uuidToLegacy = UUID_TO_LEGACY;
    
    const myNormalizedId = normalizeId(currentUser?.id);
    const myLegacyId = currentUser?.id ? uuidToLegacy[currentUser.id] : null;
    const legacyIds = new Set(['shri', 'hari']);
    const superUserUuids = Object.values(legacyToUuid);

    // 1. First pass: group by their "Primary ID" (UUID if available) to merge duplicates
    const unified = new Map<string, Contact>();
    
    contacts.forEach(c => {
      const primaryId = normalizeId(c.id);
      
      // Filter out self
      if (primaryId === myNormalizedId) return;

      const existing = unified.get(primaryId);
      if (!existing) {
        const finalName = getSuperuserName(primaryId) || c.name;
        unified.set(primaryId, { ...c, id: primaryId, name: finalName });
      }
    });

    // 2. Filter the unified list based on connections/superusers
    return Array.from(unified.values()).filter(contact => {
      const primaryId = contact.id;
      const altId = uuidToLegacy[primaryId] || primaryId;

      // Special Superuser Logic: Both superusers see each other always.
      // But they don't see everyone else unless connected.
      const isSuperUser = legacyIds.has(altId) || superUserUuids.includes(primaryId);
      const amISuperUser = legacyIds.has(currentUser?.id || '') || superUserUuids.includes(currentUser?.id || '');
      
      const isSelfSuperUserInteraction = isSuperUser && amISuperUser;

      // Filtering out "Unknown" users (except if they are superusers for some reason)
      if (!isSuperUser && (!contact.name || contact.name.toLowerCase() === 'unknown')) {
          return false;
      }

      // Check for activity or connections
      const hasMessages = (messages?.[primaryId]?.length || 0) > 0 || (messages?.[altId]?.length || 0) > 0;
      const hasMeaningfulLastMessage = !!contact.lastMessage && contact.lastMessage !== 'Start a conversation';

      // Final criteria:
      // Show if they are superusers seeing each other OR if there's connection activity
      // AND they are not archived
      const isArchived = contact.isArchived === true;
      return (isSelfSuperUserInteraction || hasMessages || hasMeaningfulLastMessage) && !isArchived;
    });
  }, [contacts, messages, statuses, currentUser]);

  const filteredVisibleContacts = useMemo(() => {
    if (!searchQuery.trim()) return visibleContacts;
    return visibleContacts.filter(c => 
      c.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
    );
  }, [visibleContacts, searchQuery]);

  const contactsWithStories = useMemo(() => {
     try {
       return (visibleContacts || []).filter(c => contactStoriesMap.has(c.id)).map(c => ({
           ...c,
           stories: contactStoriesMap.get(c.id) || []
       }));
     } catch (e) {
       console.warn('[HomeScreen] Error building contactsWithStories:', e);
       return [];
     }
  }, [visibleContacts, contactStoriesMap]);

  const isNoteValid = (timestamp?: string) => {
    if (!timestamp) return false;
    const noteDate = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - noteDate.getTime();
    return diff < 24 * 60 * 60 * 1000; // 24 hours
  };

  const handleStatusPress = (contact: Contact, layout?: { x: number, y: number, width: number, height: number }) => {
    console.log('[HomeScreen] 牒 handleStatusPress triggered for:', contact.name);
    setStatusInitialLayout(layout || null);
    homeMorphProgress.value = withSpring(1, {
      damping: 15,
      stiffness: 100,
      mass: 1,
    });
    setSelectedStatusContact(contact);
    setIsViewerVisible(true);
  };

  const handleMyStatusPress = (layout?: { x: number, y: number, width: number, height: number }) => {
    if (!currentUser) return;

    if (myStories.length > 0) {
      setStatusInitialLayout(layout || null);
      homeMorphProgress.value = withSpring(1, {
        damping: 15,
        stiffness: 100,
        mass: 1,
      });
      setSelectedStatusContact({
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar || DEFAULT_AVATAR,
        status: 'online',
        stories: myStories,
      });
      router.push('/my-status');
      return;
    }

    // Always open media picker if no stories exist, even if a note exists
    setIsMediaPickerVisible(true);
  };

  const closeModalRobustly = useCallback(() => {
    homeMorphProgress.value = withSpring(0, {
      damping: 15,
      stiffness: 100,
      mass: 1,
    });
    setIsViewerVisible(false);
    setIsMediaPickerVisible(false);
    setIsNoteModalVisible(false);
    setStatusMediaPreview(null);
    setSelectedStatusContact(null);
  }, [homeMorphProgress]);

  const handleSendStatus = async (mediaList: { uri: string; type: 'image' | 'video' | 'audio' }[], caption?: string) => {
    if (!currentUser || mediaList.length === 0) return;

    const item = mediaList[0];
    if (!item) return;

    try {
      setIsUploadingStatus(true);
      const mediaUrl = await storageService.uploadImage(item.uri, 'status-media', currentUser.id);
      if (!mediaUrl) throw new Error('Upload failed');

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);
      
      const mediaType = item.type === 'video' ? 'video' : 'image';
      const timestamp = new Date().toISOString();
      const expiresAtString = expiresAt.toISOString();

      addStatus({
        userId: currentUser.id,
        mediaUrl,
        localUri: item.uri,
        mediaType,
        timestamp,
        expiresAt: expiresAtString,
        caption: caption || '',
      });
      
      setStatusMediaPreview(null);
      setIsUploadingStatus(false);
      setIsMediaPickerVisible(false);
    } catch (error) {
      console.error('Failed to upload status:', error);
      Alert.alert('Error', 'Failed to upload status. Please try again.');
      setStatusMediaPreview(null);
      setIsUploadingStatus(false);
      setIsMediaPickerVisible(false);
    }
  };

  const createStatus = async (result: ImagePicker.ImagePickerResult) => {
      if (!result.canceled && result.assets?.[0] && currentUser) {
          const asset = result.assets[0];
          // Resolve ph:// URIs to readable file paths before setting preview
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
          // Wrap the MediaLibrary asset into an ImagePicker-like result for createStatus
          const result: ImagePicker.ImagePickerResult = {
              canceled: false,
              assets: [{
                  uri: providedAsset.uri,
                  width: providedAsset.width,
                  height: providedAsset.height,
                  type: providedAsset.mediaType === 'video' ? 'video' : 'image',
                  assetId: providedAsset.id,
                  fileName: providedAsset.filename,
                  fileSize: 0, // Not strictly needed for createStatus
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
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
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
      const myStoryPreviewUrl = myStories[0]?.url;
      const hasStory = myStories.length > 0;
      
      return (
        <Pressable 
          ref={ref => statusRefs.current['my-status'] = ref}
          style={styles.statusCard} 
          onPress={() => {
            statusRefs.current['my-status']?.measureInWindow((x: number, y: number, width: number, height: number) => {
              handleMyStatusPress({ x, y, width, height });
            });
          }}
        >
          <View style={styles.statusCardSurface}>
            <View style={[styles.myStatusBackground, hasStory && { justifyContent: 'center', alignItems: 'center' }]}>
              {hasStory && myStoryPreviewUrl ? (
                <View style={StyleSheet.absoluteFill}>
                  <Image source={{ uri: myStoryPreviewUrl }} style={styles.myStatusPreviewBgFull} />
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
            
            {/* Glassy bottom bar */}
            <View style={styles.statusInfoGlassWrapper}>
              <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={styles.statusInfoContent}>
                <Text style={styles.statusName} numberOfLines={1}>My Status</Text>
              </View>
            </View>
          </View>
          {currentUser?.note && isNoteValid(currentUser.noteTimestamp) && !isNoteModalVisible && (
            <View style={styles.notePositioner} pointerEvents="box-none">
              <Pressable onPress={() => setIsNoteModalVisible(true)}>
                <NoteBubble text={currentUser.note} isMe />
              </Pressable>
            </View>
          )}
        </Pressable>
      );
    }
    
    const contact = item as Contact;
    const stories = contactStoriesMap.get(contact.id) || [];
    const hasUnseen = stories.some(s => !s.seen);
    const storyUrl = stories[0]?.url;

    return (
      <Pressable 
        key={contact.id}
        ref={ref => statusRefs.current[contact.id] = ref}
        style={styles.statusCard} 
        onPress={() => {
          statusRefs.current[contact.id]?.measureInWindow((x: number, y: number, width: number, height: number) => {
            handleStatusPress(contact, { x, y, width, height });
          });
        }}
      >
        <View style={styles.statusCardSurface}>
          {storyUrl ? (
            <Image source={{ uri: storyUrl }} style={styles.statusMediaBackground} />
          ) : (
            <View style={[styles.statusMediaBackground, styles.statusPlaceholder]} />
          )}
          
          <View style={styles.statusOverlay} pointerEvents="none">
            {/* Story Ring - Blue gradient for unseen */}
            <View style={styles.contactAvatarPositioner}>
              <LinearGradient
                colors={hasUnseen ? ['#3b82f6', '#8b5cf6', '#ec4899'] : ['rgba(255,255,255,0.2)', 'rgba(255,255,255,0.2)']}
                style={[styles.storyRing, { padding: 2 }]}
              >
                <View style={styles.storyRingInner}>
                  <SoulAvatar 
                     uri={proxySupabaseUrl(contact.avatar)} 
                     size={42} 
                     avatarType={contact.avatarType as any}
                  />
                </View>
              </LinearGradient>
            </View>

            <LinearGradient
              colors={['transparent', 'rgba(0,0,0,0.85)']}
              style={styles.statusNameGradient}
            >
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
  }, [myStories, currentUser, contactStoriesMap, handleMyStatusPress, handleStatusPress]);

  // Pre-compute last messages map to avoid recalculating in renderItem
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
    // Inject stories if any
    const storiesForContact = contactStoriesMap.get(item.id) || [];
    const itemWithStories = { ...item, stories: storiesForContact };
    const isTyping = typingUsers.includes(item.id);

    return (
      <SwipeableRow
        onArchive={() => archiveContact(item.id, true)}
        onDelete={() => {
          Alert.alert(
            'Delete Chat',
            `Are you sure you want to delete your chat with ${item.name}? This cannot be undone.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => clearChatMessages(item.id) }
            ]
          );
        }}
        onUnfriend={() => {
          Alert.alert(
            'Unfriend',
            `Are you sure you want to unfriend ${item.name}?`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Unfriend', style: 'destructive', onPress: () => unfriendContact(item.id) }
            ]
          );
        }}
      >
        <ChatListItem 
            item={item} 
            index={index}
            lastMsg={lastMsg} 
            isTyping={isTyping}
            getPresence={getPresence}
            connectivity={connectivity}
            onSelect={handleUserSelect}
            homeMorphProgress={homeMorphProgress}
        />
      </SwipeableRow>
    );
  }, [lastMessagesMap, typingUsers, getPresence, connectivity, handleUserSelect, homeMorphProgress, archiveContact, clearChatMessages, unfriendContact]);

  // Stable keyExtractor for FlashList
  const keyExtractor = useCallback((item: Contact) => item.id, []);

  // Stable header component to prevent remounting and touch loss on Android
  const renderHeader = useCallback(() => (
    <View style={styles.homeHeaderWrapper}>
      <View style={styles.topHeader}>
        {isSearching ? (
          <View style={styles.searchBarContainer}>
            <TextInput
              style={styles.searchBarInput}
              placeholder="Search chats..."
              placeholderTextColor="rgba(255,255,255,0.4)"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              selectionColor="#fff"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.searchClearBtn}>
                <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
              </TouchableOpacity>
            )}
            <TouchableOpacity 
              onPress={() => { setIsSearching(false); setSearchQuery(''); }} 
              style={styles.searchCancelBtn}
            >
              <Text style={styles.searchCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.headerActions}>
            <Text style={styles.headerTitle}>Soul</Text>
            <TouchableOpacity 
              onPress={() => setIsSearching(true)} 
              style={styles.headerIconButton}
              activeOpacity={0.7}
            >
              <MaterialIcons name="search" size={24} color="#fff" />
            </TouchableOpacity>
            <AnimatedMoreMenu router={router} isSearching={isSearching} />
          </View>
        )}
      </View>
      <Animated.View style={[styles.statusRail, statusRailAnimStyle]}>
      <FlatList
        horizontal
        data={[{ id: 'my-status' }, ...contactsWithStories]}
        keyExtractor={item => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.statusContent}
        removeClippedSubviews={false} // Better touch stability on Android
        renderItem={renderStatusItem}
      />
      </Animated.View>
    </View>
  ), [contactsWithStories, myStories, currentUser, renderStatusItem, statusRailAnimStyle, router, isSearching, searchQuery]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <Animated.View pointerEvents="none" style={[styles.homeMorphBackdrop, homeBackdropAnimatedStyle]} />
      <Animated.View style={[styles.homeContent, homeContentAnimatedStyle]}>
        <FlatList
          data={filteredVisibleContacts}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          onScroll={handleScrollMotion}
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {
                console.log('[HomeScreen] Manual refresh triggered');
                refreshLocalCache();
              }}
              tintColor="#BC002A"
            />
          }
        />
      </Animated.View>

      <StatusViewerModal
        visible={isViewerVisible}
        stories={selectedStatusContact?.stories || []}
        contactName={selectedStatusContact?.name || ''}
        contactAvatar={proxySupabaseUrl(selectedStatusContact?.avatar) || ''}
        statusOwnerId={selectedStatusContact?.id}
        currentUserId={currentUser?.id}
        onStorySeen={(storyId) => {
          if (!currentUser || selectedStatusContact?.id === currentUser.id) return;
          addStatusView(storyId);
        }}
        onReact={(storyId) => {
          toggleStatusLike(storyId);
        }}
        onDeleteStory={(storyId) => {
          deleteStatus(storyId);
          const remaining = (selectedStatusContact?.stories || []).filter(s => s.id !== storyId);
          if (remaining.length === 0) {
            setIsViewerVisible(false);
          } else {
            setSelectedStatusContact(prev => prev ? { ...prev, stories: remaining } : prev);
          }
        }}
        onReply={(story, text) => {
          if (!selectedStatusContact?.id || !currentUser || selectedStatusContact.id === currentUser.id) return;
          sendChatMessage(selectedStatusContact.id, text, {
            type: 'status_reply',
            url: story.url,
            caption: story.caption,
          });
        }}
        onClose={closeModalRobustly}
        onComplete={closeModalRobustly}
        initialLayout={statusInitialLayout}
      />

      <MediaPreviewModal
        visible={!!statusMediaPreview}
        mediaUri={statusMediaPreview?.uri || ''}
        mediaType={statusMediaPreview?.type || 'image'}
        onClose={closeModalRobustly}
        onSend={handleSendStatus}
        isUploading={isUploadingStatus}
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

      {/* Glass Custom Dropdown Menu */}
      <NoteCreatorModal
        visible={isNoteModalVisible}
        onClose={closeModalRobustly}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
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
  myStatusEmptyPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 20 },
  statusOverlay: { ...StyleSheet.absoluteFillObject },
  contactAvatarPositioner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 50, alignItems: 'center', justifyContent: 'center' },
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
      top: -32, // Adjusted from -38 to be slightly lower
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
});
