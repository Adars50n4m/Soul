import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Alert,
  Modal,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  TextInput,
} from 'react-native';
import { supabase } from '../config/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { statusService } from '../services/StatusService';
import { CachedStatus } from '../types';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { SoulAvatar } from '../components/SoulAvatar';
import { StatusThumbnail } from '../components/StatusThumbnail';
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
  const [isActionBusy, setIsActionBusy] = useState(false);
  const [isCaptionModalVisible, setIsCaptionModalVisible] = useState(false);
  const [statusToEdit, setStatusToEdit] = useState<StatusWithViewers | null>(null);
  const [editedCaption, setEditedCaption] = useState('');

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

    // Real-time listener for view updates across all my statuses
    const channel = supabase
      .channel('my_status_views_sync')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'status_views' },
        () => {
          // Whenever ANY status is viewed, we refresh our local list to get updated counts
          // In a high-traffic app, we would filter by our own status IDs first.
          loadData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
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
      mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
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
        mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
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
             try {
               setIsActionBusy(true);
               await statusService.deleteMyStatus(status.id, status.mediaKey || '');
               await loadData();
             } catch (e) {
               const message = e instanceof Error ? e.message : 'Failed to delete status.';
               Alert.alert('Delete failed', message);
             } finally {
               setIsActionBusy(false);
             }
          }
        }
      ]
    );
  };

  const openEditCaptionModal = (status: StatusWithViewers) => {
    setStatusToEdit(status);
    setEditedCaption(status.caption || '');
    setIsCaptionModalVisible(true);
  };

  const handleSaveCaption = async () => {
    if (!statusToEdit) {
      setIsCaptionModalVisible(false);
      return;
    }

    try {
      setIsActionBusy(true);
      await statusService.updateMyStatusCaption(statusToEdit.id, editedCaption);
      setIsCaptionModalVisible(false);
      setStatusToEdit(null);
      await loadData();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to update status caption.';
      Alert.alert('Update failed', message);
    } finally {
      setIsActionBusy(false);
    }
  };

  const openStatusActions = (status: StatusWithViewers) => {
    Alert.alert(
      'Status options',
      'Choose an action',
      [
        { text: 'Edit caption', onPress: () => openEditCaptionModal(status) },
        { text: 'Delete', style: 'destructive', onPress: () => handleDelete(status) },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true }
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
              <View style={styles.statusThumbShell}>
                <StatusThumbnail
                  statusId={item.id}
                  mediaKey={item.mediaKey}
                  uriHint={item.mediaLocalPath || item.mediaUrl}
                  mediaType={item.mediaType}
                  style={styles.statusThumb}
                />
              </View>
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
            onPress={() => openStatusActions(item)}
            disabled={isActionBusy}
          >
            <MaterialIcons name="more-horiz" size={24} color="rgba(255,255,255,0.55)" />
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
        <Pressable onPress={() => setIsMediaPickerVisible(true)} style={styles.editBtn}>
          <Text style={styles.editText}>Add</Text>
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

      <Modal
        transparent
        animationType="fade"
        visible={isCaptionModalVisible}
        onRequestClose={() => setIsCaptionModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit caption</Text>
            <TextInput
              value={editedCaption}
              onChangeText={setEditedCaption}
              placeholder="Write a caption..."
              placeholderTextColor="rgba(255,255,255,0.45)"
              maxLength={200}
              multiline
              style={styles.modalInput}
              editable={!isActionBusy}
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setIsCaptionModalVisible(false)}
                style={[styles.modalBtn, styles.cancelBtn]}
                disabled={isActionBusy}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleSaveCaption}
                style={[styles.modalBtn, styles.saveBtn, { backgroundColor: activeTheme.primary }]}
                disabled={isActionBusy}
              >
                {isActionBusy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.saveBtnText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  statusThumbShell: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
  },
  statusThumb: {
    width: '100%',
    height: '100%',
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
  encryptedText: { fontWeight: '500' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    width: '100%',
    borderRadius: 16,
    backgroundColor: '#131313',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    padding: 16,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 12,
  },
  modalInput: {
    minHeight: 90,
    maxHeight: 150,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    color: '#fff',
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  modalBtn: {
    minWidth: 88,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
    paddingHorizontal: 12,
  },
  cancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  saveBtn: {
    backgroundColor: '#8C0016',
  },
  cancelBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  }
});
