import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Image,
  FlatList,
  Alert,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { statusService } from '../services/StatusService';
import { CachedStatus } from '../types';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { SoulAvatar } from '../components/SoulAvatar';
import { useApp } from '../context/AppContext';
import { MediaPickerSheet } from '../components/MediaPickerSheet';

interface StatusWithViewers extends CachedStatus {
  viewers: any[];
}

const getRelativeTime = (timestamp: number) => {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 60000) return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  return new Date(timestamp).toLocaleDateString();
};

export default function MyStatusScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { currentUser, activeTheme } = useApp();
  const [myStatuses, setMyStatuses] = useState<StatusWithViewers[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const data = await statusService.getMyStatuses();
      const withViewers = await Promise.all(
        data.map(async (status) => {
          const viewers = await statusService.getMyStatusViewers(status.id);
          return { ...status, viewers };
        })
      );
      setMyStatuses(withViewers);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const createStatus = async (asset: any) => {
    setIsMediaPickerVisible(false);
    try {
      setLoading(true);
      await statusService.uploadStory(asset.uri, asset.type === 'video' ? 'video' : 'image', '');
      setTimeout(() => loadData(), 500);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return Alert.alert('Permission needed', 'Camera permission required.');
    
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsEditing: true,
      videoMaxDuration: 60,
    });
    
    if (!result.canceled && result.assets[0]) {
      await createStatus(result.assets[0]);
    }
  };

  const handleSelectGallery = async (providedAsset?: any) => {
    if (providedAsset) {
      await createStatus(providedAsset);
    } else {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: true,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        await createStatus(result.assets[0]);
      }
    }
  };

  const handleDelete = (status: StatusWithViewers) => {
    Alert.alert(
      'Delete status?',
      'This status update will be permanently removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Delete', 
          style: 'destructive', 
          onPress: async () => {
             await statusService.deleteMyStatus(status.id, status.mediaKey || '');
             loadData();
          }
        }
      ]
    );
  };

  const renderItem = ({ item, index }: { item: StatusWithViewers, index: number }) => {
    const timeStr = getRelativeTime(item.createdAt);
    const hasViewers = item.viewers && item.viewers.length > 0;
    
    return (
      <View style={styles.itemWrapper}>
        <View style={styles.statusItem}>
          <Pressable 
            style={styles.itemMain}
            onPress={() => router.push({ pathname: '/view-status', params: { id: currentUser?.id } })}
          >
            <View style={styles.avatarContainer}>
               <SoulAvatar 
                 uri={item.mediaLocalPath || item.mediaUrl}
                 size={48} 
               />
            </View>
            <View style={styles.itemInfo}>
              <Text style={styles.viewText}>
                {hasViewers ? `Seen by ${item.viewers.length}` : 'No views yet'}
              </Text>
              <Text style={styles.relativeTime}>{timeStr}</Text>
            </View>
          </Pressable>
          
          <Pressable 
            style={styles.optionBtn} 
            onPress={() => isEditing ? handleDelete(item) : null}
          >
            {isEditing ? (
              <Ionicons name="trash-outline" size={20} color="#FF3B30" />
            ) : (
              <MaterialIcons name="more-horiz" size={24} color="rgba(255,255,255,0.4)" />
            )}
          </Pressable>
        </View>
        {index < myStatuses.length - 1 && <View style={styles.separator} />}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <LinearGradient colors={['#000', '#0a0a0a']} style={StyleSheet.absoluteFill} />
      <StatusBar barStyle="light-content" />
      
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color="#fff" />
        </Pressable>
        <Text style={styles.headerTitle}>My status</Text>
        <Pressable onPress={() => setIsEditing(!isEditing)} style={styles.editBtn}>
          <Text style={styles.editText}>{isEditing ? 'Done' : 'Edit'}</Text>
        </Pressable>
      </View>

      {loading && !refreshing ? (
        <ActivityIndicator color="#8C0016" style={{ marginTop: 50 }} />
      ) : (
        <View style={styles.content}>
          <View style={styles.card}>
            <FlatList
              data={myStatuses}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              scrollEnabled={myStatuses.length > 5}
              ListEmptyComponent={() => <View style={{ height: 10 }} />}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
              }
            />
            
            {/* Add Status Row (Integrated in Card) */}
            <View style={styles.separator} />
            <Pressable 
              style={styles.addStatusRow}
              onPress={() => setIsMediaPickerVisible(true)}
            >
              <View style={[styles.plusContainer, { backgroundColor: activeTheme.primary }]}>
                <Ionicons name="add" size={24} color="#fff" />
              </View>
              <Text style={styles.addStatusText}>Add status</Text>
            </Pressable>
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <View style={styles.privacyRow}>
              <Ionicons name="lock-closed" size={12} color="rgba(255,255,255,0.4)" style={{ marginRight: 6 }} />
              <Text style={styles.footerText}>
                Your status updates are <Text style={[styles.encryptedText, { color: activeTheme.primary }]}>end-to-end encrypted</Text>. They will disappear after 24 hours.
              </Text>
            </View>
          </View>
        </View>
      )}

      <MediaPickerSheet
        visible={isMediaPickerVisible}
        onClose={() => setIsMediaPickerVisible(false)}
        onSelectCamera={handleSelectCamera}
        onSelectGallery={() => handleSelectGallery()}
        onSelectAudio={() => {}}
        onSelectNote={() => {}}
        onSelectAssets={(assets) => {
          if (assets.length > 0) handleSelectGallery(assets[0]);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'space-between', 
    paddingHorizontal: 20, 
    paddingBottom: 15
  },
  backBtn: { padding: 5, marginLeft: -5 },
  editBtn: { padding: 5 },
  editText: { color: '#fff', fontSize: 17, fontWeight: '400' },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  content: { flex: 1, paddingHorizontal: 16 },
  card: { 
    backgroundColor: 'rgba(255,255,255,0.08)', 
    borderRadius: 16, 
    overflow: 'hidden',
    marginTop: 10
  },
  list: { paddingVertical: 5 },
  itemWrapper: { paddingHorizontal: 16 },
  statusItem: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingVertical: 12,
  },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  avatarContainer: {
    marginRight: 15,
  },
  itemInfo: { flex: 1 },
  viewText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  relativeTime: { color: 'rgba(255,255,255,0.5)', fontSize: 14, marginTop: 2 },
  optionBtn: { padding: 8, marginRight: -8 },
  separator: { 
    height: 0.5, 
    backgroundColor: 'rgba(255,255,255,0.1)', 
    marginLeft: 63 // aligns with the info text
  },
  addStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingLeft: 16,
  },
  plusContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 15,
  },
  addStatusText: { color: '#fff', fontSize: 16, fontWeight: '500' },
  footer: { 
    marginTop: 25, 
    alignItems: 'center', 
    paddingHorizontal: 30 
  },
  privacyRow: { flexDirection: 'row', alignItems: 'flex-start' },
  footerText: { 
    color: 'rgba(255,255,255,0.4)', 
    fontSize: 12, 
    lineHeight: 18,
    textAlign: 'center' 
  },
  encryptedText: { fontWeight: '500' }
});
