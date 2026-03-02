import React, { useState, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Image,
  FlatList,
  Alert,
  StatusBar,
  ScrollView,
  TextInput,
  RefreshControl,
  Platform,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { StatusViewerModal } from '../components/StatusViewerModal';
import { MediaPickerSheet } from '../components/MediaPickerSheet';
import { MediaPreviewModal } from '../components/MediaPreviewModal';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { storageService } from '../services/StorageService';

const DEFAULT_AVATAR = 'https://via.placeholder.com/150';

export default function MyStatusScreen() {
  const router = useRouter();
  const {
    currentUser,
    statuses,
    addStatus,
    deleteStatus,
    activeTheme,
    toggleStatusLike,
    addStatusView,
  } = useApp();

  const [isStatusViewerVisible, setIsStatusViewerVisible] = useState(false);
  const [selectedStoryIndex, setSelectedStoryIndex] = useState(0);
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [statusMediaPreview, setStatusMediaPreview] = useState<{ uri: string; type: 'image' | 'video' | 'audio' } | null>(null);
  const [isUploadingStatus, setIsUploadingStatus] = useState(false);

  const myStories = useMemo(() => {
    if (!currentUser) return [];
    return statuses
      .filter((s) => s.userId === currentUser.id)
      .map((s) => ({
        id: s.id,
        url: s.mediaUrl,
        type: s.mediaType,
        timestamp: s.timestamp,
        seen: false, // Not used for own stories anyway
        caption: s.caption,
        userId: s.userId,
        likes: s.likes,
        views: s.views,
        music: s.music,
      }));
  }, [statuses, currentUser]);

  const handleBack = () => router.back();

  const handleStoryPress = (index: number) => {
    setSelectedStoryIndex(index);
    setIsStatusViewerVisible(true);
  };

  const resolveStatusAssetUri = async (asset: ImagePicker.ImagePickerAsset): Promise<string> => {
    let resolvedUri = asset.uri;
    if (resolvedUri.startsWith('ph://') && asset.assetId) {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.assetId);
        resolvedUri = info.localUri || info.uri || resolvedUri;
      } catch {}
    }
    if (resolvedUri.startsWith('file://')) {
      const ext = asset.fileName?.split('.').pop() || (asset.type === 'video' ? 'mp4' : 'jpg');
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!cacheDir) return resolvedUri;
      const target = `${cacheDir}status-${Date.now()}.${ext}`;
      try {
        await FileSystem.copyAsync({ from: resolvedUri, to: target });
        resolvedUri = target;
      } catch {}
    }
    return resolvedUri;
  };

  const handleSendStatus = async (mediaList: { uri: string; type: 'image' | 'video' | 'audio' }[], caption?: string) => {
    if (!currentUser || mediaList.length === 0) return;
    setIsUploadingStatus(true);
    
    try {
      const item = mediaList[0];
      const safeUri = item.uri;

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);
      
      const mediaType = item.type === 'video' ? 'video' : 'image';
      const timestamp = new Date().toISOString();
      const expiresAtString = expiresAt.toISOString();
      const statusCaption = caption || '';

      // Offline First: pass the local URI! AppContext handles the actual storage/upload
      addStatus({
        userId: currentUser.id,
        mediaUrl: safeUri, // Will be swapped with the remote URL after upload
        localUri: safeUri,
        mediaType,
        timestamp,
        expiresAt: expiresAtString,
        caption: statusCaption,
      });
      
      setStatusMediaPreview(null);
      setIsUploadingStatus(false);
      setIsMediaPickerVisible(false);
    } catch (error) {
      console.error('Failed to create status:', error);
      Alert.alert('Error', 'Failed to create status. Please try again.');
      setIsUploadingStatus(false);
      setIsMediaPickerVisible(false);
    }
  };

  const createStatus = async (result: ImagePicker.ImagePickerResult) => {
    if (!result.canceled && result.assets?.[0] && currentUser) {
      const asset = result.assets[0];
      setStatusMediaPreview({
        uri: asset.uri,
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
    });
    await createStatus(result);
  };

  const formatRelativeTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHr = Math.floor(diffMin / 60);

      if (diffSec < 60) return 'Just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      if (diffHr < 24) return `${diffHr}h ago`;
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (e) {
      return 'Just now';
    }
  };

  const renderStoryItem = ({ item, index }: { item: any; index: number }) => {
    const viewCount = item.views?.length || 0;
    const viewText = viewCount === 0 ? 'No views yet' : `${viewCount} views`;
    
    return (
      <View style={styles.storyRow}>
        <Pressable style={styles.storyInfo} onPress={() => handleStoryPress(index)}>
          <Image source={{ uri: item.url }} style={styles.storyThumbnail} />
          <View style={styles.storyDetails}>
            <Text style={styles.viewCountText}>{viewText}</Text>
            <Text style={styles.timeText}>{formatRelativeTime(item.timestamp)}</Text>
          </View>
        </Pressable>
        <Pressable 
          style={styles.moreButton} 
          onPress={() => {
            Alert.alert(
              'Delete status?',
              'This status update will be permanently deleted.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => deleteStatus(item.id) },
              ]
            );
          }}
        >
          <MaterialIcons name="more-horiz" size={24} color="rgba(255,255,255,0.6)" />
        </Pressable>
      </View>
    );
  };


  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={handleBack} style={styles.headerIcon}>
          <MaterialIcons name="chevron-left" size={32} color="#fff" />
        </Pressable>
        <Text style={styles.headerTitle}>My status</Text>
        <Pressable style={styles.headerIcon}>
          <Text style={styles.editText}>Edit</Text>
        </Pressable>
      </View>

      <View style={styles.content}>
        <View style={styles.statusBox}>
          <FlatList
            data={myStories}
            renderItem={renderStoryItem}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
          />
          
          <Pressable style={styles.addStatusRow} onPress={() => setIsMediaPickerVisible(true)}>
            <View style={styles.addIconContainer}>
              <MaterialIcons name="add" size={24} color={activeTheme.primary} />
            </View>
            <Text style={styles.addStatusText}>Add status</Text>
          </Pressable>
        </View>

        <View style={styles.encryptionNotice}>
          <View style={styles.encryptionIconRow}>
             <MaterialIcons name="lock" size={12} color="rgba(255,255,255,0.4)" />
             <Text style={styles.encryptionText}>
               Your status updates are <Text style={{ color: activeTheme.primary }}>end-to-end encrypted</Text>. They will disappear after 24 hours.
             </Text>
          </View>
        </View>
      </View>

      <StatusViewerModal
        visible={isStatusViewerVisible}
        stories={myStories}
        contactName="My status"
        contactAvatar={currentUser?.avatar || DEFAULT_AVATAR}
        statusOwnerId={currentUser?.id}
        currentUserId={currentUser?.id}
        onDeleteStory={(storyId) => {
          deleteStatus(storyId);
          if (myStories.length <= 1) setIsStatusViewerVisible(false);
        }}
        onClose={() => setIsStatusViewerVisible(false)}
        onComplete={() => setIsStatusViewerVisible(false)}
      />

      <MediaPickerSheet
        visible={isMediaPickerVisible}
        onClose={() => setIsMediaPickerVisible(false)}
        onSelectCamera={handleSelectCamera}
        onSelectGallery={() => handleSelectGallery()}
        onSelectAsset={handleSelectGallery}
        onSelectAudio={() => {
            setIsMediaPickerVisible(false);
            Alert.alert("SoulSync Audio", "Audio status coming soon!");
        }}
        onSelectNote={() => {
            setIsMediaPickerVisible(false);
            Alert.alert("SoulSync Notes", "Leave a note from the Home screen!");
        }}
      />

      <MediaPreviewModal
        visible={!!statusMediaPreview}
        mediaUri={statusMediaPreview?.uri || ''}
        mediaType={statusMediaPreview?.type || 'image'}
        onClose={() => setStatusMediaPreview(null)}
        onSend={handleSendStatus}
        isUploading={isUploadingStatus}
        mode="status"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    height: 56,
  },
  headerIcon: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  editText: {
    color: '#fff',
    fontSize: 16,
  },
  content: {
    flex: 1,
    paddingTop: 20,
  },
  statusBox: {
    backgroundColor: '#1c1c1e',
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  storyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  storyInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  storyThumbnail: {
    width: 48,
    height: 48,
    borderRadius: 24,
    marginRight: 12,
  },
  storyDetails: {
    flex: 1,
  },
  viewCountText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  timeText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 14,
    marginTop: 2,
  },
  moreButton: {
    padding: 8,
  },
  addStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  addIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  addStatusText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
  encryptionNotice: {
    marginTop: 30,
    paddingHorizontal: 30,
    alignItems: 'center',
  },
  encryptionIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  encryptionText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
});
