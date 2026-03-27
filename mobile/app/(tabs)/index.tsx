import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, Image, Pressable, StyleSheet, StatusBar, Dimensions, Alert, FlatList, Platform, TouchableOpacity, RefreshControl } from 'react-native';
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

import { useApp } from '../../context/AppContext';
import { LEGACY_TO_UUID } from '../../config/supabase';
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
  onlineUsers: string[];
  connectivity: { isDeviceOnline: boolean; isServerReachable: boolean; isRealtimeConnected: boolean };
  homeMorphProgress: Animated.SharedValue<number>;
}

const ChatListItem = React.memo(({ item, index, lastMsg, onSelect, isTyping, onlineUsers, connectivity, homeMorphProgress }: ChatListItemProps) => {
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
              style={[
                item.stories && item.stories.length > 0 && {
                  borderWidth: 2,
                  borderColor: item.stories.some((s) => !s.seen) ? '#3b82f6' : 'rgba(255,255,255,0.4)',
                  padding: 2,
                  overflow: 'hidden'
                }
              ]}
            />
            {(item.status === 'online' || onlineUsers.includes(item.id)) && connectivity.isRealtimeConnected && <View style={styles.onlineIndicator} />}
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
    prevProps.onSelect === nextProps.onSelect
  );
});

ChatListItem.displayName = 'ChatListItem';

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
    sendChatMessage,
    addStatusView,
    connectivity,
    onlineUsers,
    refreshLocalCache,
  } = useApp();
  const navigation = useNavigation();
  const router = useRouter();
  const isFocused = useIsFocused();

  // Status Handlers
  const [selectedStatusContact, setSelectedStatusContact] = useState<Contact | null>(null);
  const [isViewerVisible, setIsViewerVisible] = useState(false);
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [isNoteModalVisible, setIsNoteModalVisible] = useState(false);
  const [statusMediaPreview, setStatusMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' } | null>(null);
  const [isUploadingStatus, setIsUploadingStatus] = useState(false);
  const [statusInitialLayout, setStatusInitialLayout] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
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
    : interpolate(homeMorphProgress.value, [0, 0.6], [1, 0], Extrapolation.CLAMP),
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
        const primaryUserId = (LEGACY_TO_UUID as any)[s.userId] || s.userId;
        if (!map.has(primaryUserId)) map.set(primaryUserId, []);
        map.get(primaryUserId)!.push(story);
      });
    } catch (e) {
      console.warn('[HomeScreen] Error building contactStoriesMap:', e);
    }
    return map;
  }, [statuses]);

  const myStories = useMemo(
    () => currentUser ? (contactStoriesMap.get(currentUser.id) || []) : [],
    [contactStoriesMap, currentUser]
  );

  const visibleContacts = useMemo(() => {
    if (!contacts) return [];
    const legacyToUuid = LEGACY_TO_UUID;
    const uuidToLegacy: Record<string, string> = {
      '4d28b137-66ff-4417-b451-b1a421e34b25': 'shri',
      '02e52f08-6c1e-497f-93f6-b29c275b8ca4': 'hari'
    };
    
    const myLegacyId = currentUser?.id ? uuidToLegacy[currentUser.id] : null;
    const legacyIds = new Set(['shri', 'hari']);
    const superUserUuids = Object.values(legacyToUuid);

    // 1. First pass: group by their "Primary ID" (UUID if available) to merge duplicates
    const unified = new Map<string, Contact>();
    
    contacts.forEach(c => {
      const primaryId = legacyToUuid[c.id] || c.id;
      
      // Filter out self
      if (primaryId === currentUser?.id) return;
      if (c.id === 'shri' || c.id === 'hari') {
         if (legacyToUuid[c.id] === currentUser?.id) return;
      }

      const existing = unified.get(primaryId);
      if (!existing) {
        const finalName = primaryId === legacyToUuid['shri'] ? 'Shri' : 
                          (primaryId === legacyToUuid['hari'] ? 'Hari' : c.name);
                          
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
      return isSelfSuperUserInteraction || hasMessages || hasMeaningfulLastMessage;
    });
  }, [contacts, messages, statuses, currentUser]);

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

    if (currentUser.note) {
      setIsNoteModalVisible(true);
    } else {
      setIsMediaPickerVisible(true);
    }
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
    const isTyping = typingUsers.includes(item.id);
    
    // Inject stories if any
    const storiesForContact = contactStoriesMap.get(item.id) || [];
    const itemWithStories = { ...item, stories: storiesForContact };

    return (
      <ChatListItem 
          item={itemWithStories} 
          index={index}
          lastMsg={lastMsg} 
          onSelect={handleUserSelect} 
          isTyping={isTyping}
          onlineUsers={onlineUsers}
          connectivity={connectivity}
          homeMorphProgress={homeMorphProgress}
      />
    );
  }, [lastMessagesMap, typingUsers, handleUserSelect, contactStoriesMap, onlineUsers, connectivity, homeMorphProgress]);

  // Stable keyExtractor for FlashList
  const keyExtractor = useCallback((item: Contact) => item.id, []);

  // Stable header component to prevent remounting and touch loss on Android
  const renderHeader = useCallback(() => (
    <View style={styles.homeHeaderWrapper}>
      <View style={styles.topHeader}>
        <View style={styles.headerActions}>
           <TouchableOpacity 
             onPress={() => router.push('/requests')} 
             style={styles.headerIconButton}
             activeOpacity={0.7}
           >
             <MaterialIcons name="notifications-none" size={26} color="#fff" />
           </TouchableOpacity>
           <TouchableOpacity 
             onPress={() => router.push('/search')} 
             style={styles.headerIconButton}
             activeOpacity={0.7}
           >
             <MaterialIcons name="person-add-alt-1" size={26} color="#fff" />
           </TouchableOpacity>
        </View>
      </View>
      <Animated.View style={[styles.statusRail, statusRailAnimStyle]}>
      <FlatList
        horizontal
        data={[{ id: 'my-status' }, ...contactsWithStories]}
        keyExtractor={item => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.statusContent}
        removeClippedSubviews={false} // Better touch stability on Android
        renderItem={({ item }) => {
          if (item.id === 'my-status') {
            const myStoryPreviewUrl = myStories[0]?.url;
            return (
              <Pressable 
                ref={ref => statusRefs.current['my-status'] = ref}
                style={styles.statusCard} 
                onPress={() => {
                  statusRefs.current['my-status']?.measureInWindow((x: number, y: number, width: number, height: number) => {
                    handleMyStatusPress({ x, y, width, height });
                  });
                }}
                android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
              >
                <View style={styles.statusCardSurface}>
                <View style={[styles.myStatusBackground, myStories.length > 0 && { justifyContent: 'flex-start', alignItems: 'flex-start' }]}>
                  {!!myStoryPreviewUrl ? (
                    <>
                      <Image source={{ uri: myStoryPreviewUrl }} style={styles.myStatusPreviewBgFull} />
                      <View style={styles.myStatusAvatarBadgeCorner} pointerEvents="none">
                        <SoulAvatar 
                           uri={proxySupabaseUrl(currentUser?.avatar)} 
                           size={28} 
                           avatarType={currentUser?.avatarType as any}
                           style={styles.myStatusAvatarSmall} 
                        />
                        <View style={styles.myStatusAddBadgeBlue}>
                          <MaterialIcons name="add" size={14} color="#fff" />
                        </View>
                      </View>
                      <Text style={[styles.startStoryText, styles.myStatusTextBottom]}>My status</Text>
                    </>
                  ) : (
                    <>
                      <View style={styles.myStatusAvatarContainer} pointerEvents="none">
                        <SoulAvatar 
                           uri={proxySupabaseUrl(currentUser?.avatar)} 
                           size={44} 
                           avatarType={currentUser?.avatarType as any}
                           style={styles.myStatusAvatar} 
                        />
                        <View style={styles.myStatusAddBadge}><MaterialIcons name="add" size={16} color="#fff" /></View>
                      </View>
                      <Text style={styles.startStoryText}>
                        {currentUser?.note && isNoteValid(currentUser.noteTimestamp)
                          ? 'Your Note'
                          : 'Start a story'}
                      </Text>
                    </>
                  )}
                </View>
                </View>
                {currentUser?.note && isNoteValid(currentUser.noteTimestamp) && (
                  <View style={styles.notePositioner} pointerEvents="none">
                     <NoteBubble text={currentUser.note} isMe />
                  </View>
                )}
              </Pressable>
            );
          }
          const contact = item as Contact;
          const hasUnseen = contact.stories?.some(s => !s.seen);
          const storyUrl = contact.stories?.[0]?.url;
          return (
            <Pressable 
                ref={ref => statusRefs.current[contact.id] = ref}
                style={styles.statusCard} 
                onPress={() => {
                  statusRefs.current[contact.id]?.measureInWindow((x: number, y: number, width: number, height: number) => {
                    handleStatusPress(contact, { x, y, width, height });
                  });
                }}
                android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
            >
              <View style={styles.statusCardSurface}>
              {storyUrl ? (
                  <Image source={{ uri: storyUrl }} style={styles.statusMediaBackground} />
              ) : (
                  <View style={[styles.statusMediaBackground, styles.statusPlaceholder]} />
              )}
              <View style={styles.statusOverlay} pointerEvents="none">
                <View style={[styles.contactAvatarBadge, { borderColor: hasUnseen ? '#3b82f6' : 'rgba(255,255,255,0.4)' }]}>
                  <SoulAvatar 
                     uri={proxySupabaseUrl(contact.avatar)} 
                     size={32} 
                     avatarType={contact.avatarType as any}
                     style={styles.smallStatusAvatar} 
                  />
                </View>
                <LinearGradient
                  colors={['transparent', 'rgba(0,0,0,0.8)']}
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
        }}
      />
      </Animated.View>
    </View>
  ), [contactsWithStories, myStories, currentUser, handleMyStatusPress, handleStatusPress, statusRailAnimStyle]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <Animated.View pointerEvents="none" style={[styles.homeMorphBackdrop, homeBackdropAnimatedStyle]} />
      <Animated.View style={[styles.homeContent, homeContentAnimatedStyle]}>
        <FlatList
          data={visibleContacts}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
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
  homeHeaderWrapper: { paddingTop: Platform.OS === 'ios' ? 50 : 30 },
  topHeader: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'flex-end', 
    paddingHorizontal: 20,
    paddingVertical: 10,
    height: 60
  },
  headerActions: { flexDirection: 'row', gap: 15 },
  headerIconButton: { 
    width: 44, 
    height: 44, 
    borderRadius: 22, 
    backgroundColor: 'rgba(255,255,255,0.08)', 
    alignItems: 'center', 
    justifyContent: 'center' 
  },
  statusRail: { marginTop: 10, marginBottom: 0, overflow: 'visible' },
  statusContent: { paddingHorizontal: 20, paddingVertical: 12, paddingTop: 10, gap: 12, overflow: 'visible' },
  statusCard: { width: 140, height: 200, marginTop: 34, borderRadius: 28, backgroundColor: 'transparent', zIndex: 10, overflow: 'visible' },
  statusCardSurface: {
    flex: 1,
    borderRadius: 28,
    backgroundColor: '#1a1a1a',
    overflow: 'hidden',
  },
  myStatusBackground: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#121212', borderRadius: 28, overflow: 'hidden' },
  myStatusPreviewBg: { ...StyleSheet.absoluteFillObject, opacity: 0.42 },
  myStatusPreviewBgFull: { ...StyleSheet.absoluteFillObject, opacity: 1 },
  myStatusAvatarContainer: { position: 'relative', marginBottom: 16 },
  myStatusAvatar: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: '#3b82f6' },
  myStatusAvatarSmall: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: '#fff' },
  myStatusAvatarBadgeCorner: { position: 'absolute', top: 12, left: 12, zIndex: 5 },
  myStatusAddBadge: { position: 'absolute', bottom: -2, right: -2, width: 24, height: 24, borderRadius: 12, backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#262626' },
  myStatusAddBadgeBlue: { position: 'absolute', bottom: -2, right: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#000' },
  startStoryText: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  myStatusTextBottom: { position: 'absolute', bottom: 16, width: '100%', textAlign: 'center', color: '#fff', fontSize: 15, fontWeight: '700' },
  statusMediaBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: '#1a1a1a', borderRadius: 28 },
  statusPlaceholder: { backgroundColor: 'rgba(255,255,255,0.08)' },
  statusOverlay: { ...StyleSheet.absoluteFillObject },
  contactAvatarBadge: { position: 'absolute', top: 12, left: 12, width: 52, height: 52, borderRadius: 26, borderWidth: 2.5, padding: 3, backgroundColor: 'rgba(0,0,0,0.4)' },
  smallStatusAvatar: { width: '100%', height: '100%', borderRadius: 22 },
  statusNameGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 60,
    justifyContent: 'flex-end',
    padding: 12,
  },
  statusNameText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  listContent: { paddingBottom: 100, paddingHorizontal: 4 },
  chatItem: { marginBottom: 8, marginHorizontal: 16, borderRadius: 36, height: 72 },
  notePositioner: {
      position: 'absolute',
      top: -7,
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
});
