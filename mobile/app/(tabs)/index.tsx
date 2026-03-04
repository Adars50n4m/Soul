import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, Image, Pressable, StyleSheet, StatusBar, Dimensions, Alert, FlatList } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { useRouter, useNavigation } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import GlassView from '../../components/ui/GlassView';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  SharedTransition,
  Easing,
  LinearTransition,
  FadeIn,
  FadeOut,
  FadeInDown,
  ZoomIn,
} from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { storageService } from '../../services/StorageService';
import { proxySupabaseUrl } from '../../config/api';

import { useApp } from '../../context/AppContext';
import { SoulSyncLogo } from '../../components/SoulSyncLogo';
import { StatusViewerModal } from '../../components/StatusViewerModal';
import { MediaPreviewModal } from '../../components/MediaPreviewModal';
import { MediaPickerSheet } from '../../components/MediaPickerSheet';
import { Contact, Story } from '../../types';
import { NoteBubble } from '../../components/NoteBubble';
import { NoteCreatorModal } from '../../components/NoteCreatorModal';
const DEFAULT_AVATAR = '';

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
const hiddenStyle = { opacity: 0 };
const pillSharedTransition = SharedTransition.custom((values) => {
  'worklet';
  const morph = {
    duration: 920,
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  };
  return {
    originX: withTiming(values.targetOriginX, morph),
    originY: withTiming(values.targetOriginY, morph),
    width: withTiming(values.targetWidth, morph),
    height: withTiming(values.targetHeight, morph),
    borderRadius: withTiming(values.targetBorderRadius, morph),
  };
}).duration(920);
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
  lastMsg: { text?: string; timestamp?: string };
  onSelect: (contact: Contact, y: number) => void;
  isTyping: boolean;
  isHidden?: boolean;
}

const ChatListItem = React.memo(({ item, lastMsg, onSelect, isTyping, isHidden }: ChatListItemProps) => {
  const scaleAnim = useSharedValue(1);
  const opacityAnim = useSharedValue(1);
  const itemRef = useRef<View>(null);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scaleAnim.value }],
    opacity: opacityAnim.value,
  }));

  const handlePressIn = useCallback(() => {
    if (isHidden) return;
    scaleAnim.value = withSpring(0.96, { damping: 15, stiffness: 300 });
    opacityAnim.value = withTiming(0.85, { duration: 100 });
  }, [isHidden]);

  const handlePressOut = useCallback(() => {
    if (isHidden) return;
    scaleAnim.value = withSpring(1, { damping: 15, stiffness: 300 });
    opacityAnim.value = withTiming(1, { duration: 150 });
  }, [isHidden]);

  const handlePress = useCallback(() => {
    if (isHidden) return;
    itemRef.current?.measure((x, y, width, height, pageX, pageY) => {
      onSelect(item, pageY);
    });
  }, [isHidden, item, onSelect]);

  return (
    <Pressable
      ref={itemRef}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={isHidden ? [styles.chatItem, hiddenStyle] : styles.chatItem}
      disabled={isHidden}
    >
      {/* Outer morph target - ONLY handles the shared element transition */}
      <Animated.View 
        sharedTransitionTag={`pill-${item.id}`}
        sharedTransitionStyle={pillSharedTransition}
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
            style={[StyleSheet.absoluteFill, { borderRadius: 36, backgroundColor: 'rgba(15, 15, 20, 0.4)' }]}
        />
            
        {/* Content rendered safely as an overlay, decoupled from Reanimated's snapshot engine */}
        <View style={[styles.pillContent, { position: 'absolute', width: '100%', height: '100%', paddingHorizontal: 16 }]} pointerEvents="box-none">
          <Animated.View
            sharedTransitionTag={`pill-avatar-${item.id}`}
            sharedTransitionStyle={pillSharedTransition}
            style={styles.avatarContainer}
          >
            <Animated.Image
              source={{ uri: proxySupabaseUrl(item.avatar) || DEFAULT_AVATAR }}
              style={[
                styles.avatar,
                item.stories && item.stories.length > 0 && {
                  borderWidth: 2,
                  borderColor: item.stories.some((s) => !s.seen) ? '#3b82f6' : 'rgba(255,255,255,0.4)'
                }
              ]}
            />
            {item.status === 'online' && <View style={styles.onlineIndicator} />}
          </Animated.View>

          <View style={styles.chatContent}>
            <Animated.View
              sharedTransitionTag={`pill-name-${item.id}`}
              sharedTransitionStyle={pillSharedTransition}
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
    prevProps.isHidden === nextProps.isHidden &&
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
  } = useApp();
  const navigation = useNavigation();
  const router = useRouter();

  // Status Handlers
  const [selectedStatusContact, setSelectedStatusContact] = useState<Contact | null>(null);
  const [isViewerVisible, setIsViewerVisible] = useState(false);
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [isNoteModalVisible, setIsNoteModalVisible] = useState(false);
  const [statusMediaPreview, setStatusMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' } | null>(null);
  const [isUploadingStatus, setIsUploadingStatus] = useState(false);
  const statusRailOpacity = useSharedValue(hasRenderedHomeOnce ? 0 : 1);
  const hasFocusedOnce = useRef(false);

  const statusRailAnimStyle = useAnimatedStyle(() => ({
    opacity: statusRailOpacity.value,
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
      if (!hasFocusedOnce.current) {
        hasFocusedOnce.current = true;
        hasRenderedHomeOnce = true;
        statusRailOpacity.value = 1;
        return;
      }
      // Fade-in only status rail on return; keep the rest of Home unchanged.
      statusRailOpacity.value = 0;
      statusRailOpacity.value = withTiming(1, {
        duration: 320,
        easing: Easing.out(Easing.cubic),
      });
    });
    return unsubscribe;
  }, [navigation, statusRailOpacity]);

  const contactStoriesMap = useMemo(() => {
    const map = new Map<string, Story[]>();
    statuses.forEach(s => {
      const story: Story = {
        id: s.id,
        url: proxySupabaseUrl(s.mediaUrl), // Proxy the story URL too
        type: s.mediaType,
        timestamp: s.timestamp,
        seen: false,
        caption: s.caption || '',
        userId: s.userId,
        likes: s.likes || [],
        views: s.views || [],
        music: s.music,
      };
      if (!map.has(s.userId)) map.set(s.userId, []);
      map.get(s.userId)?.push(story);
    });
    return map;
  }, [statuses]);

  const myStories = useMemo(
    () => currentUser ? (contactStoriesMap.get(currentUser.id) || []) : [],
    [contactStoriesMap, currentUser]
  );

  const visibleContacts = useMemo(() => {
    // Hide the current user from their own contact list
    const otherContacts = contacts.filter(c => c.id !== currentUser?.id);
    
    const legacyIds = new Set(['shri', 'hari']);
    const hasRealContacts = otherContacts.some(c => !legacyIds.has(c.id));

    if (!hasRealContacts) return otherContacts;

    return otherContacts.filter(contact => {
      if (!legacyIds.has(contact.id)) return true;

      const hasMessages = (messages[contact.id]?.length || 0) > 0;
      const hasStatus = statuses.some(s => s.userId === contact.id);
      const hasMeaningfulLastMessage =
        !!contact.lastMessage && contact.lastMessage !== 'Start a conversation';

      // Hide legacy placeholder contacts when real contacts exist and placeholder has no activity.
      return hasMessages || hasStatus || hasMeaningfulLastMessage;
    });
  }, [contacts, messages, statuses, currentUser]);

  const contactsWithStories = useMemo(() => {
     return visibleContacts.filter(c => contactStoriesMap.has(c.id)).map(c => ({
         ...c,
         stories: contactStoriesMap.get(c.id)
     }));
  }, [visibleContacts, contactStoriesMap]);

  const isNoteValid = (timestamp?: string) => {
    if (!timestamp) return false;
    const noteDate = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - noteDate.getTime();
    return diff < 24 * 60 * 60 * 1000; // 24 hours
  };

  const handleStatusPress = (contact: Contact) => {
    console.log('[HomeScreen] 牒 handleStatusPress triggered for:', contact.name);
    console.log('[HomeScreen] Stories count:', contact.stories?.length);
    setSelectedStatusContact(contact);
    setIsViewerVisible(true);
  };

  const handleMyStatusPress = () => {
    if (!currentUser) return;

    if (myStories.length > 0) {
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
    setIsViewerVisible(false);
    setIsMediaPickerVisible(false);
    setIsNoteModalVisible(false);
    setStatusMediaPreview(null);
  }, []);

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
      });
      await createStatus(result);
  };

  const handleUserSelect = useCallback((contact: Contact, y: number) => {
    router.push({
      pathname: '/chat/[id]',
      params: { 
        id: contact.id,
        sourceY: y.toString(),
      }
    });
  }, [router]);

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

  const renderItem = useCallback(({ item }: { item: Contact }) => {
    const lastMsg = lastMessagesMap[item.id] || { text: item.lastMessage, timestamp: '' };
    const isTyping = typingUsers.includes(item.id);
    
    // Inject stories if any
    const storiesForContact = contactStoriesMap.get(item.id) || [];
    const itemWithStories = { ...item, stories: storiesForContact };

    return (
      <ChatListItem 
          item={itemWithStories} 
          lastMsg={lastMsg} 
          onSelect={handleUserSelect} 
          isTyping={isTyping}
      />
    );
  }, [lastMessagesMap, typingUsers, handleUserSelect, contactStoriesMap]);

  // Stable keyExtractor for FlashList
  const keyExtractor = useCallback((item: Contact) => item.id, []);

  // Stable header component to prevent remounting and touch loss on Android
  const renderHeader = useCallback(() => (
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
                style={styles.statusCard} 
                onPress={handleMyStatusPress}
                android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
              >
                <View style={[styles.myStatusBackground, myStories.length > 0 && { justifyContent: 'flex-start', alignItems: 'flex-start' }]}>
                  {!!myStoryPreviewUrl ? (
                    <>
                      <Image source={{ uri: myStoryPreviewUrl }} style={styles.myStatusPreviewBgFull} />
                      <View style={styles.myStatusAvatarBadgeCorner} pointerEvents="none">
                        <Image source={{ uri: proxySupabaseUrl(currentUser?.avatar) || '' }} style={styles.myStatusAvatarSmall} />
                        <View style={styles.myStatusAddBadgeBlue}>
                          <MaterialIcons name="add" size={14} color="#fff" />
                        </View>
                      </View>
                      <Text style={[styles.startStoryText, styles.myStatusTextBottom]}>My status</Text>
                    </>
                  ) : (
                    <>
                      <View style={styles.myStatusAvatarContainer} pointerEvents="none">
                        <Image source={{ uri: proxySupabaseUrl(currentUser?.avatar) || '' }} style={styles.myStatusAvatar} />
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
                style={styles.statusCard} 
                onPress={() => handleStatusPress(contact)}
                android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
            >
              {storyUrl ? (
                  <Image source={{ uri: storyUrl }} style={styles.statusMediaBackground} />
              ) : (
                  <View style={[styles.statusMediaBackground, styles.statusPlaceholder]} />
              )}
              <View style={styles.statusOverlay} pointerEvents="none">
                <View style={[styles.contactAvatarBadge, { borderColor: hasUnseen ? '#3b82f6' : 'rgba(255,255,255,0.4)' }]}>
                  <Image source={{ uri: proxySupabaseUrl(contact.avatar) || DEFAULT_AVATAR }} style={styles.smallStatusAvatar} />
                </View>
                <LinearGradient
                  colors={['transparent', 'rgba(0,0,0,0.8)']}
                  style={styles.statusNameGradient}
                >
                  <Text style={styles.statusNameText}>{contact.name}</Text>
                </LinearGradient>
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
  ), [contactsWithStories, myStories, currentUser, handleMyStatusPress, handleStatusPress, statusRailAnimStyle]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <FlatList
        data={visibleContacts}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />

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
        onSelectAsset={handleSelectGallery}
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
  statusRail: { marginTop: 60, marginBottom: 0, overflow: 'visible' },
  statusContent: { paddingHorizontal: 20, paddingVertical: 12, paddingTop: 8, gap: 12, overflow: 'visible' },
  statusCard: { width: 140, height: 200, borderRadius: 28, backgroundColor: '#1a1a1a', zIndex: 10, overflow: 'hidden' },
  myStatusBackground: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#262626', borderRadius: 28, overflow: 'hidden' },
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
      top: -20, // Float above the card
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 100,
  },
  // Removed overflow: 'hidden' to let shared elements escape during flight
  chatPillContainer: { flex: 1, borderRadius: 36, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.22)', overflow: 'hidden' },
  pillBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 15, 20, 0.4)', opacity: 0.95 },
  pillBlur: { ...StyleSheet.absoluteFillObject },
  pillContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12 },
  avatarContainer: { position: 'relative' },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  onlineIndicator: { position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: '#22c55e', borderWidth: 2, borderColor: '#151515' },
  chatContent: { flex: 1, justifyContent: 'center' },
  contactName: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.5 },
  lastMessage: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500' },
  rightSide: { alignItems: 'flex-end', justifyContent: 'center', paddingRight: 4, gap: 4 },
  timestamp: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '600' },
});
