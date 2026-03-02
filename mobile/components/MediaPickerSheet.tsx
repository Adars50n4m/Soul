import React, { useRef, useEffect, useState, useMemo } from 'react';
import { View, Pressable, StyleSheet, Animated, PanResponder, useWindowDimensions, FlatList, Text, ActivityIndicator, Platform } from 'react-native';
import { Image } from 'expo-image';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { SwiftUIButton } from './SwiftUIButton';

interface MediaPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelectCamera: () => void;
  onSelectGallery: () => void; // Keeps the gallery picker as a fallback or full view if needed
  onSelectAudio: () => void;
  onSelectNote: () => void;
  onSelectAsset?: (asset: MediaLibrary.Asset) => void;
}

export const MediaPickerSheet: React.FC<MediaPickerSheetProps> = ({
  visible,
  onClose,
  onSelectCamera,
  onSelectGallery,
  onSelectAudio,
  onSelectNote,
  onSelectAsset,
}) => {
  const slideAnim = useMemo(() => new Animated.Value(0), []);
  const opacityAnim = useMemo(() => new Animated.Value(0), []);
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  // Taller sheet for grid view
  const sheetHeight = screenHeight * 0.85; 

  const [photos, setPhotos] = useState<MediaLibrary.Asset[]>([]);
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<MediaLibrary.Album | null>(null);
  const [viewMode, setViewMode] = useState<'photos' | 'albums'>('photos');
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const panResponder = useMemo(() => 
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => {
        if (gestureState.dy > 0) {
          slideAnim.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dy > 150 || gestureState.vy > 0.5) {
          handleClose();
        } else {
          Animated.spring(slideAnim, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }), [slideAnim]);

  const loadPhotos = async (album?: MediaLibrary.Album) => {
      setIsLoading(true);
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setHasPermission(status === 'granted');
      
      if (status === 'granted') {
          const assets = await MediaLibrary.getAssetsAsync({
              first: 50,
              sortBy: ['creationTime'],
              mediaType: ['photo', 'video'],
              album: album ? album.id : undefined,
          });
          setPhotos(assets.assets);
      }
      setIsLoading(false);
  };

  const loadAlbums = async () => {
      setIsLoading(true);
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status === 'granted') {
          const fetchedAlbums = await MediaLibrary.getAlbumsAsync({
              includeSmartAlbums: true,
          });
          // Filter out empty albums
          const filtered = fetchedAlbums.filter(a => a.assetCount > 0);
          setAlbums(filtered);
      }
      setIsLoading(false);
  };

  useEffect(() => {
    if (visible) {
      // Defer state updates to avoid synchronous setState in effect warning
      Promise.resolve().then(() => {
        if (viewMode === 'photos') {
          loadPhotos(selectedAlbum || undefined);
        } else {
          loadAlbums();
        }
      });
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 50,
          friction: 8,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: sheetHeight,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  const handleClose = () => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: sheetHeight,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
      slideAnim.setValue(0);
      opacityAnim.setValue(0);
    });
  };

  const handleHaptic = () => {
    // Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Grid Render Items
  const renderItem = ({ item, index }: { item: any, index: number }) => {
      if (viewMode === 'albums') {
          return renderAlbumItem({ item });
      }

      const isCameraTile = index === 0 && !selectedAlbum;
      const tileSize = (screenWidth) / 3;

      if (isCameraTile) {
          return (
              <Pressable 
                onPress={onSelectCamera}
                style={[styles.cameraTile, { width: tileSize, height: tileSize }]}
              >
                  <View style={styles.cameraIconContainer}>
                     <MaterialIcons name="photo-camera" size={32} color="#fff" />
                  </View>
                  <Text style={styles.cameraText}>Camera</Text>
              </Pressable>
          );
      }

      // Adjust index for photos array (since 0 is camera if no album selected)
      const photoIndex = selectedAlbum ? index : index - 1;
      if (photoIndex >= photos.length || photoIndex < 0) return null;
      const asset = photos[photoIndex];

      return (
          <Pressable 
            onPress={() => onSelectAsset ? onSelectAsset(asset) : onSelectGallery()}
            style={{ width: tileSize, height: tileSize, padding: 1 }}
          >
              <Image
                source={{ uri: asset.uri }}
                style={{ width: '100%', height: '100%' }}
                contentFit="cover"
              />
              {asset.mediaType === 'video' && (
                  <View style={styles.videoIndicator}>
                      <Text style={styles.videoDuration}>{formatDuration(asset.duration)}</Text>
                  </View>
              )}
          </Pressable>
      );
  };

  const renderAlbumItem = ({ item }: { item: MediaLibrary.Album }) => {
      const tileSize = (screenWidth) / 3;
      return (
          <Pressable 
            onPress={() => {
                setSelectedAlbum(item);
                setViewMode('photos');
                loadPhotos(item);
            }}
            style={[styles.albumTile, { width: tileSize, height: tileSize, padding: 4 }]}
          >
              <View style={styles.albumCoverPlaceholder}>
                  <Ionicons name="folder-open" size={40} color="rgba(255,255,255,0.4)" />
                  <View style={styles.albumBadge}>
                      <Text style={styles.albumCount}>{item.assetCount}</Text>
                  </View>
              </View>
              <Text numberOfLines={1} style={styles.albumName}>{item.title}</Text>
          </Pressable>
      );
  };

  const formatDuration = (duration: number) => {
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  if (!visible) return null;

  // Combined data: First item is a dummy for "Camera" if not in album, rest are photos
  const gridData = viewMode === 'albums' 
    ? albums 
    : (selectedAlbum ? photos : [ { id: 'camera-tile' }, ...photos ]);

  return (
    <Animated.View style={[styles.overlay, { opacity: opacityAnim }]}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <Animated.View
        style={[
          styles.sheet,
          {
            height: sheetHeight,
            transform: [
              {
                translateY: slideAnim.interpolate({
                  inputRange: [0, sheetHeight],
                  outputRange: [0, sheetHeight],
                }),
              },
            ],
          },
        ]}
        {...panResponder.panHandlers}
      >
        <BlurView intensity={90} tint="dark" style={styles.container} experimentalBlurMethod="dimezisBlurView">
          
          {/* Header */}
          <View style={styles.header}>
              <Pressable onPress={handleClose} style={styles.headerButton}>
                  <Text style={styles.headerButtonText}>Cancel</Text>
              </Pressable>
              
              <View style={styles.headerTitleContainer}>
                 <Pressable onPress={() => {
                     setViewMode('photos');
                     setSelectedAlbum(null);
                     loadPhotos();
                 }}>
                    <Text style={[styles.headerTitle, viewMode === 'photos' && { color: '#fff' }]}>
                        {selectedAlbum ? selectedAlbum.title : 'Photos'}
                    </Text>
                 </Pressable>
                 <Pressable onPress={() => {
                     setViewMode('albums');
                     loadAlbums();
                 }}>
                    <Text style={[styles.headerTitle, viewMode === 'albums' && { color: '#fff' }]}>Albums</Text>
                 </Pressable>
              </View>

              <View style={styles.headerButton} /> 
          </View>

          {/* Quick Options Row */}
          <View style={styles.optionsRow}>
              <Pressable style={styles.optionButton} onPress={onSelectNote}>
                  <View style={[styles.optionIcon, { backgroundColor: '#1e1e24' }]}>
                      <Text style={{color: '#fff', fontWeight: 'bold', fontSize: 16}}>Aa</Text>
                  </View>
                  <Text style={styles.optionLabel}>Text</Text>
              </Pressable>

              <Pressable style={styles.optionButton} onPress={onSelectAudio}>
                  <View style={[styles.optionIcon, { backgroundColor: '#1e1e24' }]}>
                      <Ionicons name="musical-notes" size={20} color="#fff" />
                  </View>
                  <Text style={styles.optionLabel}>Music</Text>
              </Pressable>
               
          </View>

          {/* Handler Bar */}
          <View style={styles.dragHandleContainer}>
            <View style={styles.dragHandle} />
          </View>
          
          {/* Main Content */}
          {hasPermission === false ? (
               <View style={styles.permissionContainer}>
                   <Text style={styles.permissionText}>Access to photos is required.</Text>
               </View>
          ) : (
            <FlatList
                data={gridData}
                renderItem={renderItem}
                keyExtractor={(item, index) => index.toString()}
                numColumns={3}
                contentContainerStyle={styles.gridContent}
                showsVerticalScrollIndicator={false}
            />
          )}

        </BlurView>
      </Animated.View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 999,
  },
  backdrop: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    backgroundColor: Platform.OS === 'android' ? 'rgba(10, 10, 12, 0.75)' : '#000',
  },
  container: {
    flex: 1,
  },
  dragHandleContainer: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  
  // Header
  header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 10,
  },
  headerButton: {
      width: 60,
  },
  headerButtonText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '500',
  },
  headerTitleContainer: {
      flexDirection: 'row',
      gap: 16,
      backgroundColor: 'rgba(255,255,255,0.1)',
      padding: 6,
      paddingHorizontal: 8,
      borderRadius: 20,
  },
  headerTitle: {
      color: 'rgba(255,255,255,0.5)',
      fontWeight: '600',
      fontSize: 14,
  },

  // Options Row
  optionsRow: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      marginBottom: 10,
      gap: 16,
  },
  optionButton: {
      width: 80,
      height: 60,
      backgroundColor: '#1c1c1e',
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
  },
  optionIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
  },
  optionLabel: {
      color: '#fff',
      fontSize: 12,
      fontWeight: '500',
  },

  // Grid
  gridContent: {
      paddingBottom: 40,
  },
  cameraTile: {
      backgroundColor: '#1c1c1e',
      alignItems: 'center',
      justifyContent: 'center',
      margin: 1,
  },
  cameraIconContainer: {
      width: 50,
      height: 50,
      borderRadius: 25,
      backgroundColor: 'rgba(255,255,255,0.1)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
  },
  cameraText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '500',
  },
  videoIndicator: {
      position: 'absolute',
      bottom: 4,
      right: 4,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: 4,
  },
  videoDuration: {
      color: '#fff',
      fontSize: 10,
      fontWeight: '600',
  },
  permissionContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
  },
  permissionText: {
      color: 'rgba(255,255,255,0.5)',
  },
  
  // Album Styles
  albumTile: {
      margin: 1,
      justifyContent: 'flex-start',
  },
  albumCoverPlaceholder: {
      flex: 1,
      backgroundColor: 'rgba(255,255,255,0.05)',
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
  },
  albumBadge: {
      position: 'absolute',
      bottom: 8,
      right: 8,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
  },
  albumCount: {
      color: '#fff',
      fontSize: 10,
      fontWeight: '700',
  },
  albumName: {
      color: '#fff',
      fontSize: 12,
      fontWeight: '600',
      marginTop: 4,
      paddingHorizontal: 2,
  },
});

