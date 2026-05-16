import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Alert,
  Modal,
  StatusBar,
  RefreshControl,
  TextInput,
  useWindowDimensions,
  BackHandler,
  Image as RNImage,
} from 'react-native';
import { supabase } from '../config/supabase';
import { proxySupabaseUrl } from '../config/api';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { statusService } from '../services/StatusService';
import { CachedStatus } from '../types';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { SoulAvatar } from '../components/SoulAvatar';
import { StatusThumbnail } from '../components/StatusThumbnail';
import GlassView from '../components/ui/GlassView';
import { useApp } from '../context/AppContext';
import { MediaPickerSheet } from '../components/MediaPickerSheet';
import { SoulLoader } from '../components/ui/SoulLoader';
import Animated, {
  SharedTransition,
  withSpring,
  withTiming,
  withDelay,
  useSharedValue,
  useDerivedValue,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  Easing,
  runOnJS,
  FadeInDown,
} from 'react-native-reanimated';
import { SheetScreen } from 'react-native-sheet-transitions';
import { myStatusTransitionState } from '../services/myStatusTransitionState';
import { setStatusMorphOrigin } from '../utils/statusMorphOrigins';
import { SOUL_LIQUID_TRANSITION, SOUL_LIQUID_SPRING } from '../constants/sharedTransitions';

const statusTransition = SOUL_LIQUID_TRANSITION;

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
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    sharedTag?: string;
    cardX?: string;
    cardY?: string;
    cardW?: string;
    cardH?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { currentUser, activeTheme, myStatuses: cachedMyStatuses } = useApp();
  const sharedTag = typeof params.sharedTag === 'string' && params.sharedTag.length > 0
    ? params.sharedTag
    : 'status-hero-card';
  const seedStatuses = useMemo(
    () => cachedMyStatuses.map((status) => ({ ...status, viewers: [] })),
    [cachedMyStatuses]
  );
  const [myStatuses, setMyStatuses] = useState<StatusWithViewers[]>(seedStatuses);
  const [refreshing, setRefreshing] = useState(false);
  const [isMediaPickerVisible, setIsMediaPickerVisible] = useState(false);
  const [isActionBusy, setIsActionBusy] = useState(false);
  const [isCaptionModalVisible, setIsCaptionModalVisible] = useState(false);
  const [statusToEdit, setStatusToEdit] = useState<StatusWithViewers | null>(null);
  const [editedCaption, setEditedCaption] = useState('');

  // ───── Hero morph (home My Status pill ↔ this sheet) ─────
  // Mirrors the profile screen's runDismissAnimation pattern: a single
  // shared value drives the card from the source pill's measured layout
  // to the destination shape (a near-full-width rounded card under the
  // header), and runs in reverse on dismiss.
  const cardOrigin = useMemo(() => ({
    x: Number(Array.isArray(params.cardX) ? params.cardX[0] : params.cardX),
    y: Number(Array.isArray(params.cardY) ? params.cardY[0] : params.cardY),
    width: Number(Array.isArray(params.cardW) ? params.cardW[0] : params.cardW),
    height: Number(Array.isArray(params.cardH) ? params.cardH[0] : params.cardH),
  }), [params.cardH, params.cardW, params.cardX, params.cardY]);
  const useSharedStatusTransition = false; // Reverting to manual morph for maximum stability and control
  const hasCardMorph = Number.isFinite(cardOrigin.x)
    && Number.isFinite(cardOrigin.y)
    && Number.isFinite(cardOrigin.width)
    && Number.isFinite(cardOrigin.height)
    && cardOrigin.width > 0
    && cardOrigin.height > 0;

  // Destination shape — a rounded card centered horizontally, just below
  // the header, sized to wrap the list + add row.
  const cardDestX = 16;
  const cardDestY = insets.top + 60;
  const cardDestW = screenWidth - 32;
  const hasStatuses = myStatuses.length > 0;
  const cardDestH = hasStatuses
    ? Math.min(myStatuses.length, 6) * 76 + 90
    : 104;

  const heroMorphProgress = useSharedValue(hasCardMorph ? 0 : 1);
  const headerOpacity = useSharedValue(hasCardMorph ? 0 : 1);
  const bgOpacity = useSharedValue(1);
  const isClosingRef = useRef(false);
  const allowNativePopRef = useRef(false);
  const dismissedRef = useRef(false);
  const statusItemRefs = useRef<Record<string, any>>({});

  const handleOpenStatus = useCallback((item: StatusWithViewers) => {
    const morphKey = `status-hero-status-${item.id}`;
    const uriHint = item.mediaLocalPath || item.mediaUrl || '';
    // Kick off the network fetch BEFORE navigating so the image is already
    // (or close to) cached by the time view-status mounts and renders <Image>.
    // Local file:// paths are free, http(s) URLs are the ones that gain.
    if (uriHint.startsWith('http://') || uriHint.startsWith('https://')) {
      RNImage.prefetch(uriHint).catch(() => {});
    }
    const navigate = () => router.push({
      pathname: '/view-status' as any,
      params: {
        id: currentUser?.id || item.userId,
        sharedTag: morphKey,
        statusId: item.id,
        mediaKey: item.mediaKey || '',
        uriHint,
        mediaType: item.mediaType || '',
      },
    });
    const node = statusItemRefs.current[item.id];
    if (node?.measureInWindow) {
      try {
        node.measureInWindow((x: number, y: number, w: number, h: number) => {
          if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0) {
            setStatusMorphOrigin(morphKey, { x, y, width: w, height: h, borderRadius: w / 2 });
          }
          navigate();
        });
        return;
      } catch {}
    }
    navigate();
  }, [currentUser?.id, router]);

  useEffect(() => {
    if (!hasCardMorph) {
      heroMorphProgress.value = 1;
      headerOpacity.value = 1;
      return;
    }
    heroMorphProgress.value = withSpring(1, {
      damping: 28,
      stiffness: 180,
      mass: 0.9,
      overshootClamping: true,
    });
    headerOpacity.value = withDelay(
      150,
      withTiming(1, { duration: 250, easing: Easing.out(Easing.cubic) })
    );
  }, [hasCardMorph, headerOpacity, heroMorphProgress]);
  
  const isMorphing = useDerivedValue(() => heroMorphProgress.value < 1);

  const heroCardAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    if (!hasCardMorph) {
      return {
        left: cardDestX,
        top: cardDestY,
        width: cardDestW,
        height: cardDestH,
        borderRadius: 16,
      };
    }
    const p = heroMorphProgress.value;
    const sourceW = cardOrigin.width;
    const sourceH = cardOrigin.height;

    return {
      left: cardDestX,
      top: cardDestY,
      width: interpolate(p, [0, 1], [sourceW, cardDestW], Extrapolation.CLAMP),
      height: interpolate(p, [0, 1], [sourceH, cardDestH], Extrapolation.CLAMP),
      // LIQUID RESHAPE: Start circular, morph through organic shape, land on rounded card
      borderRadius: interpolate(p, [0, 0.7, 1], [sourceW / 2, 32, 16], Extrapolation.CLAMP),
      transform: [
        {
          translateX: interpolate(p, [0, 1], [cardOrigin.x - cardDestX, 0], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(p, [0, 1], [cardOrigin.y - cardDestY, 0], Extrapolation.CLAMP),
        },
        {
          scale: interpolate(p, [0, 1], [0.98, 1], Extrapolation.CLAMP)
        }
      ] as any,
    };
  });

  const chromeAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    const p = heroMorphProgress.value;
    return {
      opacity: headerOpacity.value,
      transform: [
        { translateY: interpolate(headerOpacity.value, [0, 1], [15, 0], Extrapolation.CLAMP) },
        { scale: interpolate(p, [0, 1], [0.95, 1], Extrapolation.CLAMP) }
      ] as any,
    };
  });

  const realContentAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    const p = heroMorphProgress.value;
    // Cross-fade the list content as we approach the destination
    return { 
      opacity: interpolate(p, [0.8, 1], [0, 1], Extrapolation.CLAMP),
      transform: [
        { scale: interpolate(p, [0.8, 1], [0.96, 1], Extrapolation.CLAMP) },
        { translateY: interpolate(p, [0.8, 1], [15, 0], Extrapolation.CLAMP) }
      ] as any
    };
  });

  // Source-pill content (status thumbnail + "My Status" label) sits inside
  // the hero card and is the inverse of the morph progress: fully visible at
  // origin (small pill) and faded out at destination (where the list fades
  // in). On dismiss it re-emerges as the card shrinks, so the user sees the
  // pill content reappear instead of an empty gray rectangle.
  const sourceContentAnimatedStyle = useAnimatedStyle(() => {
    'worklet';
    const p = heroMorphProgress.value;
    return {
      opacity: interpolate(p, [0, 0.9, 1], [1, 1, 0], Extrapolation.CLAMP),
    };
  });

  // Pick the same "latest with media" status the home pill renders, so the
  // morph's source layer matches what the user just tapped pixel-for-pixel.
  const sourceStatus = useMemo(() => {
    const reversed = [...cachedMyStatuses].reverse();
    return (
      reversed.find((status) => !!(status.mediaLocalPath || status.mediaUrl))
      || reversed.find((status) => !!status.mediaKey)
      || cachedMyStatuses[cachedMyStatuses.length - 1]
    );
  }, [cachedMyStatuses]);

  const pageBackgroundStyle = useAnimatedStyle(() => {
    'worklet';
    return { opacity: bgOpacity.value };
  });

  const finishDismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    myStatusTransitionState.clear();
    allowNativePopRef.current = true;
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      router.back();
    }
  }, [navigation, router]);

  const runDismissAnimation = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    myStatusTransitionState.dismiss();

    if (!hasCardMorph) {
      bgOpacity.value = withTiming(0, { duration: 200 });
      headerOpacity.value = withTiming(0, { duration: 200 });
      setTimeout(finishDismiss, 200);
      return;
    }

    const DISMISS_DURATION = 420;
    const dismissEasing = Easing.bezier(0.32, 0, 0.16, 1);

    headerOpacity.value = withTiming(0, {
      duration: 200,
      easing: dismissEasing,
    });
    bgOpacity.value = withTiming(0, {
      duration: 360,
      easing: dismissEasing,
    });
    heroMorphProgress.value = withTiming(0, {
      duration: DISMISS_DURATION,
      easing: dismissEasing,
    }, (finished) => {
      'worklet';
      if (finished) runOnJS(finishDismiss)();
    });

    // Safety net in case the worklet callback doesn't fire.
    setTimeout(() => {
      if (isClosingRef.current) finishDismiss();
    }, DISMISS_DURATION + 60);
  }, [bgOpacity, finishDismiss, hasCardMorph, headerOpacity, heroMorphProgress]);

  // Intercept hardware back + nav-stack pop so the dismiss animates instead
  // of teleporting back to the home screen.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
      if (!hasCardMorph || isClosingRef.current || allowNativePopRef.current) return;
      event.preventDefault();
      runDismissAnimation();
    });
    const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!hasCardMorph || isClosingRef.current) return false;
      runDismissAnimation();
      return true;
    });
    return () => {
      allowNativePopRef.current = false;
      unsubscribe();
      backSub.remove();
    };
  }, [hasCardMorph, navigation, runDismissAnimation]);

  useEffect(() => {
    setMyStatuses((prev) => {
      const viewersById = new Map(prev.map((status) => [status.id, status.viewers || []]));
      return cachedMyStatuses.map((status) => ({
        ...status,
        viewers: viewersById.get(status.id) || [],
      }));
    });
  }, [cachedMyStatuses]);

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
          // Note: We DON'T set loading(true) here to avoid the heartbeat flickering.
          loadData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUser?.id]); // Only re-run if the logged-in user actually changes

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const createStatus = async (asset: any) => {
    setIsMediaPickerVisible(false);
    try {
      await statusService.uploadStory(asset.uri, asset.type === 'video' ? 'video' : 'image', '');
      setTimeout(() => loadData(), 500);
    } catch (e) {
      console.error(e);
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
               setMyStatuses((prev) => prev.filter((s) => s.id !== status.id));
               await statusService.deleteMyStatus(status.id, status.mediaKey || '');
               await loadData();
             } catch (e) {
               await loadData();
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
      <Animated.View 
        entering={FadeInDown.duration(400).delay(150 + index * 40).springify().damping(20).stiffness(120)}
      >
        <View style={styles.statusItem}>
          <Pressable
            style={styles.itemMain}
            onPress={() => handleOpenStatus(item)}
          >
            <View style={styles.avatarContainer}>
              <View
                ref={(node) => {
                  if (node) statusItemRefs.current[item.id] = node;
                  else delete statusItemRefs.current[item.id];
                }}
                style={styles.statusThumbShell}
              >
                <StatusThumbnail
                  statusId={item.id}
                  mediaKey={item.mediaKey}
                  uriHint={item.mediaLocalPath || item.mediaUrl}
                  mediaType={item.mediaType}
                  style={styles.statusThumb}
                  showLoader={false}
                  fallback={(
                    <SoulAvatar
                      uri={currentUser?.avatar}
                      size={48}
                      avatarType={currentUser?.avatarType as any}
                      teddyVariant={currentUser?.teddyVariant as any}
                    />
                  )}
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
      </Animated.View>
    );
  };

  return (
    <SheetScreen
      onClose={() => {
        if (!isClosingRef.current) runDismissAnimation();
      }}
      style={{ backgroundColor: 'transparent' }}
      opacityOnGestureMove
      disableRootScale
      customBackground={
        <Animated.View style={[StyleSheet.absoluteFill, pageBackgroundStyle]} pointerEvents="none">
          <LinearGradient colors={['#000', '#0a0a0a']} style={StyleSheet.absoluteFill} />
        </Animated.View>
      }
    >
      <View style={styles.container}>
        <StatusBar barStyle="light-content" />

        {/* Header — fades in via headerOpacity once the morph settles */}
        <Animated.View style={[styles.header, { paddingTop: insets.top + 10 }, chromeAnimatedStyle]}>
          <Pressable onPress={() => runDismissAnimation()} style={styles.backBtn} hitSlop={10}>
            <Ionicons name="chevron-back" size={22} color="#fff" />
          </Pressable>
          <View style={styles.titlePill}>
            <Text style={styles.headerTitle}>My status</Text>
          </View>
          <Pressable onPress={() => setIsMediaPickerVisible(true)} style={styles.editBtn} hitSlop={10}>
            <Ionicons name="add" size={24} color="#fff" />
          </Pressable>
        </Animated.View>

        {/* Hero card — absolutely positioned so its left/top/width/height
            can morph from the home pill's coords to the destination shape. */}
        <Animated.View
          style={[styles.heroCard, heroCardAnimatedStyle]}
        >
          {/* 1. LIQUID GHOST LAYER (Source image) */}
          {hasStatuses && (
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, sourceContentAnimatedStyle]}
            >
              {sourceStatus && (
                <StatusThumbnail
                  statusId={sourceStatus.id}
                  mediaKey={sourceStatus.mediaKey}
                  uriHint={sourceStatus.mediaLocalPath || sourceStatus.mediaUrl}
                  mediaType={sourceStatus.mediaType as any}
                  style={StyleSheet.absoluteFill}
                  showLoader={false}
                />
              )}
              <LinearGradient
                colors={['rgba(0,0,0,0.5)', 'transparent']}
                style={styles.heroSourceTopGradient}
                pointerEvents="none"
              />
              {/* Mirror of the home pill's corner avatar (see (tabs)/index.tsx
                  myStatusAvatarBadgeCorner). Without this, dismiss would land
                  the morph card on a pill missing the avatar, and the avatar
                  would pop in only after navigation.goBack — looking like a
                  late, abrupt appearance. */}
              <View style={styles.heroSourceAvatarCorner} pointerEvents="none">
                <SoulAvatar
                  uri={proxySupabaseUrl(currentUser?.avatar)}
                  size={34}
                  avatarType={currentUser?.avatarType as any}
                  isOnline={false}
                  style={styles.heroSourceAvatarGlow}
                />
              </View>
              <View style={styles.heroSourceLabelWrapper}>
                <GlassView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
                <View style={styles.heroSourceLabelContent}>
                  <Text style={styles.heroSourceLabelText} numberOfLines={1}>My Status</Text>
                </View>
              </View>
            </Animated.View>
          )}

          {/* 2. REAL CONTENT LAYER (The list) */}
          <Animated.View style={[StyleSheet.absoluteFill, realContentAnimatedStyle as any]}>
            <FlatList
              data={myStatuses}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              scrollEnabled={myStatuses.length > 5}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
              }
            />
            {hasStatuses && <View style={styles.separator} />}
            <Pressable style={styles.addStatusRow} onPress={() => setIsMediaPickerVisible(true)}>
              <View style={[styles.plusContainer, { backgroundColor: activeTheme.primary }]}>
                <Ionicons name="add" size={24} color="#fff" />
              </View>
              <Text style={styles.addStatusText}>Add status</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>

        {/* Footer — sits below the destination card position, fades with chrome */}
        <Animated.View
          style={[
            styles.footer,
            { position: 'absolute', left: 0, right: 0, top: cardDestY + cardDestH + 16 },
            chromeAnimatedStyle,
          ]}
        >
          <View style={styles.privacyRow}>
            <Ionicons name="lock-closed" size={12} color="rgba(255,255,255,0.4)" style={{ marginRight: 6 }} />
            <Text style={styles.footerText}>
              Your status updates are <Text style={[styles.encryptedText, { color: activeTheme.primary }]}>end-to-end encrypted</Text>. They will disappear after 24 hours.
            </Text>
          </View>
        </Animated.View>

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
                  <SoulLoader size={30} />
                ) : (
                  <Text style={styles.saveBtnText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      </View>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 15,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titlePill: {
    paddingHorizontal: 20,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  content: { flex: 1, paddingHorizontal: 16 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 16,
    overflow: 'hidden',
    marginTop: 10,
  },
  // Absolutely-positioned wrapper for the hero card so left/top/width/height
  // can be animated to morph from the home pill's measured layout to its
  // destination shape under the header.
  heroCard: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  // Source-pill mirror styles — match the home StatusCardWrapper so the
  // morph keeps the same visual identity end-to-end.
  heroSourceTopGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 60,
    zIndex: 1,
  },
  heroSourceAvatarCorner: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 10,
  },
  heroSourceAvatarGlow: {
    shadowColor: '#3b82f6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
  },
  heroSourceLabelWrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 54,
    overflow: 'hidden',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  heroSourceLabelContent: {
    flex: 1,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroSourceLabelText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  list: { paddingVertical: 5 },
  itemWrapper: { paddingHorizontal: 16 },
  statusItem: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingVertical: 12,
    paddingHorizontal: 16,
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
    paddingVertical: 14,
    paddingHorizontal: 16,
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
