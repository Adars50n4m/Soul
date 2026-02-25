import React, { useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, Image, FlatList, Pressable, StyleSheet, StatusBar, Dimensions, Alert } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  LinearTransition,
  FadeIn,
  FadeOut,
  FadeInDown,
  ZoomIn,
} from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { storageService } from '../../services/StorageService';

import { useApp } from '../../context/AppContext';
import { SoulSyncLogo } from '../../components/SoulSyncLogo';
import { StatusViewerModal } from '../../components/StatusViewerModal';
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
      <Animated.View style={[styles.chatPillContainer, animatedStyle]}>
        
        {/* The solid flying morph background. Isolated with NO CHILDREN to avoid Reanimated capture bugs. */}
        <Animated.View
            {...{ sharedTransitionTag: `chat-pill-${item.id}` } as any}
            style={[StyleSheet.absoluteFill, { borderRadius: 36, backgroundColor: '#151515', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)' }]}
        />
            
        {/* Content rendered safely as an overlay, decoupled from Reanimated's snapshot engine */}
        <View style={[styles.pillContent, { position: 'absolute', width: '100%', height: '100%', paddingHorizontal: 16 }]} pointerEvents="box-none">
          <View style={styles.avatarContainer}>
            <Animated.Image
              {...{ sharedTransitionTag: `chat-avatar-${item.id}` } as any}
              source={{ uri: item.avatar || DEFAULT_AVATAR }}
              style={styles.avatar}
            />
            {item.status === 'online' && <View style={styles.onlineIndicator} />}
          </View>

          <View style={styles.chatContent}>
            <View>
              <Text style={styles.contactName}>
                {item.name}
              </Text>
            </View>
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
    </Pressable>
  );
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render when meaningful data changes
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.item.name === nextProps.item.name &&
    prevProps.item.avatar === nextProps.item.avatar &&
    prevProps.item.status === nextProps.item.status &&
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

  const contactStoriesMap = useMemo(() => {
    const map = new Map<string, Story[]>();
    statuses.forEach(s => {
      const story: Story = {
        id: s.id,
        url: s.mediaUrl,
        type: s.mediaType,
        timestamp: s.timestamp,
        seen: false,
        caption: s.caption,
        userId: s.userId,
        likes: s.likes,
        views: s.views,
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
      setIsViewerVisible(true);
      return;
    }

    if (currentUser.note) {
      setIsNoteModalVisible(true);
    } else {
      setIsMediaPickerVisible(true);
    }
  };

  const createStatus = async (result: ImagePicker.ImagePickerResult) => {
      if (!result.canceled && result.assets?.[0] && currentUser) {
          const asset = result.assets[0];
          const safeMediaUri = await resolveStatusAssetUri(asset);
          let mediaUrl = safeMediaUri;

          // Persist status media to cloud URL so it renders reliably in viewer and home preview.
          if (safeMediaUri.startsWith('file://')) {
            try {
              const uploadedUrl = await storageService.uploadImage(safeMediaUri, 'status-media', currentUser.id);
              if (uploadedUrl) mediaUrl = uploadedUrl;
            } catch (error: any) {
              console.warn('Status upload failed, keeping local URI fallback:', error?.message || error);
            }
          }

          const expiresAt = new Date();
          expiresAt.setHours(expiresAt.getHours() + 24);
          addStatus({
              userId: currentUser.id,
              mediaUrl,
              mediaType: asset.type === 'video' ? 'video' : 'image',
              timestamp: new Date().toISOString(),
              expiresAt: expiresAt.toISOString(),
              caption: ''
          });
      }
      setIsMediaPickerVisible(false);
  };

  const handleSelectCamera = async () => {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return Alert.alert('Permission needed', 'Camera permission required.');
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      await createStatus(result);
  };

  const handleSelectGallery = async () => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) return Alert.alert('Permission needed', 'Gallery permission required.');
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
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
    return (
      <ChatListItem 
          item={item} 
          lastMsg={lastMsg} 
          onSelect={handleUserSelect} 
          isTyping={isTyping} 
      />
    );
  }, [lastMessagesMap, typingUsers, handleUserSelect]);

  // Stable keyExtractor for FlashList
  const keyExtractor = useCallback((item: Contact) => item.id, []);

  return (
    <Animated.View 
        style={styles.container} 
        exiting={FadeOut.duration(200)}
        layout={LinearTransition.springify().damping(20)}
    >
      <StatusBar barStyle="light-content" />
      
      <FlatList
        data={visibleContacts}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        // Performance optimizations
        initialNumToRender={20}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        ListHeaderComponent={() => (
          <View style={styles.statusRail}>
            <FlatList
              horizontal
              data={[{ id: 'my-status' }, ...contactsWithStories]}
              keyExtractor={item => item.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.statusContent}
              renderItem={({ item }) => {
                if (item.id === 'my-status') {
                  const myStoryPreviewUrl = myStories[0]?.url;
                  return (
                    <Pressable style={styles.statusCard} onPress={handleMyStatusPress}>
                      <View style={styles.myStatusBackground}>
                        {!!myStoryPreviewUrl && (
                          <Image source={{ uri: myStoryPreviewUrl }} style={styles.myStatusPreviewBg} />
                        )}
                        <View style={styles.myStatusAvatarContainer}>
                          <Image source={{ uri: currentUser?.avatar || '' }} style={styles.myStatusAvatar} />
                          {myStories.length === 0 && (
                            <View style={styles.myStatusAddBadge}><MaterialIcons name="add" size={16} color="#fff" /></View>
                          )}
                        </View>
                        <Text style={styles.startStoryText}>
                          {myStories.length > 0
                            ? 'My story'
                            : currentUser?.note && isNoteValid(currentUser.noteTimestamp)
                              ? 'Your Note'
                              : 'Start a story'}
                        </Text>
                      </View>
                      {currentUser?.note && isNoteValid(currentUser.noteTimestamp) && (
                        <View style={styles.notePositioner}>
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
                  <Pressable style={styles.statusCard} onPress={() => handleStatusPress(contact)}>
                    {storyUrl ? (
                        <Image source={{ uri: storyUrl }} style={styles.statusMediaBackground} />
                    ) : (
                        <View style={[styles.statusMediaBackground, styles.statusPlaceholder]} />
                    )}
                    <View style={styles.statusOverlay}>
                      <View style={[styles.contactAvatarBadge, { borderColor: hasUnseen ? '#3b82f6' : 'rgba(255,255,255,0.2)' }]}>
                        <Image source={{ uri: contact.avatar || DEFAULT_AVATAR }} style={styles.smallStatusAvatar} />
                      </View>
                    </View>
                    {contact.note && isNoteValid(contact.noteTimestamp) && (
                        <View style={styles.notePositioner}>
                            <NoteBubble text={contact.note} />
                        </View>
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />

      <StatusViewerModal
        visible={isViewerVisible}
        stories={selectedStatusContact?.stories || []}
        contactName={selectedStatusContact?.name || ''}
        contactAvatar={selectedStatusContact?.avatar || ''}
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
        onClose={() => setIsViewerVisible(false)}
        onComplete={() => setIsViewerVisible(false)}
      />

      <MediaPickerSheet
        visible={isMediaPickerVisible}
        onClose={() => setIsMediaPickerVisible(false)}
        onSelectCamera={handleSelectCamera}
        onSelectGallery={handleSelectGallery}
        onSelectAudio={() => Alert.alert("Audio Status", "Coming soon!")}
        onSelectNote={() => {
            setIsMediaPickerVisible(false);
            setIsNoteModalVisible(true);
        }}
      />

      <NoteCreatorModal
        visible={isNoteModalVisible}
        onClose={() => setIsNoteModalVisible(false)}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  statusRail: { marginTop: 60, marginBottom: 0, overflow: 'visible' },
  statusContent: { paddingHorizontal: 20, paddingVertical: 12, paddingTop: 8, gap: 12, overflow: 'visible' },
  statusCard: { width: 110, height: 140, borderRadius: 28, backgroundColor: '#1a1a1a', zIndex: 10 },
  myStatusBackground: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#262626', padding: 12, borderRadius: 28, overflow: 'hidden' },
  myStatusPreviewBg: { ...StyleSheet.absoluteFillObject, opacity: 0.42 },
  myStatusAvatarContainer: { position: 'relative', marginBottom: 12 },
  myStatusAvatar: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: '#3b82f6' },
  myStatusAddBadge: { position: 'absolute', bottom: -2, right: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#262626' },
  startStoryText: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  statusMediaBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: '#1a1a1a', borderRadius: 28 },
  statusPlaceholder: { backgroundColor: 'rgba(255,255,255,0.08)' },
  statusOverlay: { ...StyleSheet.absoluteFillObject, padding: 10 },
  contactAvatarBadge: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, padding: 2, backgroundColor: 'rgba(0,0,0,0.5)' },
  smallStatusAvatar: { width: '100%', height: '100%', borderRadius: 15 },
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
  chatPillContainer: { flex: 1, borderRadius: 36, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)' },
  pillBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: '#151515', opacity: 0.95 },
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
