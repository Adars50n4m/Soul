import React, { useRef, useEffect, useState, useMemo } from 'react';
import { View, Pressable, StyleSheet, Animated, PanResponder, useWindowDimensions, FlatList, Text, ActivityIndicator, Platform, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import GlassView from './ui/GlassView';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import Reanimated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { SwiftUIButton } from './SwiftUIButton';

interface MediaPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelectCamera: () => void;
  onSelectGallery: () => void; // Keeps the gallery picker as a fallback or full view if needed
  onSelectAudio: () => void;
  onSelectNote: () => void;
  onSelectAssets?: (assets: MediaLibrary.Asset[]) => void;
  onSelectLocation?: () => void;
  onSelectContact?: () => void;
}

export const MediaPickerSheet: React.FC<MediaPickerSheetProps> = ({
  visible,
  onClose,
  onSelectCamera,
  onSelectGallery,
  onSelectAudio,
  onSelectNote,
  onSelectAssets,
  onSelectLocation,
  onSelectContact,
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
  const [hasNextPage, setHasNextPage] = useState(true);
  const [endCursor, setEndCursor] = useState<string | undefined>(undefined);
  const [isLowerLoading, setIsLowerLoading] = useState(false);
  const [selectedAssets, setSelectedAssets] = useState<MediaLibrary.Asset[]>([]);

  const toggleAssetSelection = (asset: MediaLibrary.Asset) => {
      setSelectedAssets(current => {
          const isSelected = current.some(a => a.id === asset.id);
          if (isSelected) {
              return current.filter(a => a.id !== asset.id);
          } else {
              return [...current, asset];
          }
      });
  };

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

  const loadPhotos = async (album?: MediaLibrary.Album, after?: string) => {
      if (after) {
          setIsLowerLoading(true);
      } else {
          setIsLoading(true);
          setPhotos([]);
          setHasNextPage(true);
          setEndCursor(undefined);
      }

      const { status } = await MediaLibrary.requestPermissionsAsync();
      setHasPermission(status === 'granted');
      
      if (status === 'granted') {
          const assets = await MediaLibrary.getAssetsAsync({
              first: 51, // Load one extra to see if there's more? No, getAssetsAsync handles it via hasNextPage
              after,
              sortBy: ['creationTime'],
              mediaType: ['photo', 'video'],
              album: album ? album.id : undefined,
          });
          
          if (after) {
              setPhotos(prev => [...prev, ...assets.assets]);
          } else {
              setPhotos(assets.assets);
          }
          setHasNextPage(assets.hasNextPage);
          setEndCursor(assets.endCursor);
      }
      setIsLoading(false);
      setIsLowerLoading(false);
  };

  const loadMorePhotos = () => {
      if (!hasNextPage || isLoading || isLowerLoading) return;
      loadPhotos(selectedAlbum || undefined, endCursor);
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

  // Internal state to handle the animation-unmount dance
  const [renderState, setRenderState] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRenderState(true);
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
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: sheetHeight,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start(() => {
         setRenderState(false);
      });
    }
  }, [visible]);

  const handleClose = () => {
    setSelectedAssets([]);
    onClose();
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

      const isSelected = selectedAssets.some(a => a.id === asset.id);

      return (
          <Pressable 
            onPress={() => toggleAssetSelection(asset)}
            style={{ width: tileSize, height: tileSize, padding: 1 }}
          >
              <Image
                source={{ uri: asset.uri }}
                style={{ width: '100%', height: '100%' }}
                contentFit="cover"
              />
              {isSelected && (
                  <View style={styles.selectedOverlay}>
                      <View style={styles.checkCircle}>
                          <Ionicons name="checkmark" size={16} color="#fff" />
                      </View>
                  </View>
              )}
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

  if (!renderState) return null;

  // Combined data: First item is a dummy for "Camera" if not in album, rest are photos
  const gridData = viewMode === 'albums' 
    ? albums 
    : (selectedAlbum ? photos : [ { id: 'camera-tile' }, ...photos ]);

  return (
    <Animated.View 
        style={[styles.overlay, { opacity: opacityAnim }]} 
        pointerEvents={visible ? 'auto' : 'none'}
    >
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
        <GlassView intensity={90} tint="dark" style={styles.container}>
          
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
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false} 
            style={{ flexGrow: 0, height: 65, flexShrink: 0 }}
            contentContainerStyle={styles.optionsRow}
          >
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

          </ScrollView>

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
                style={{ flex: 1 }}
                contentContainerStyle={styles.gridContent}
                showsVerticalScrollIndicator={false}
                onEndReached={loadMorePhotos}
                onEndReachedThreshold={0.5}
                ListFooterComponent={() => isLowerLoading ? (
                    <View style={{ padding: 20 }}>
                        <ActivityIndicator color="#BC002A" />
                    </View>
                ) : null}
            />
          )}

          {/* Floating Confirm Button */}
          {selectedAssets.length > 0 && (
              <Reanimated.View entering={FadeInDown} exiting={FadeOutDown} style={styles.floatingConfirm}>
                  <Pressable 
                      style={styles.confirmButton}
                      onPress={() => {
                          if (onSelectAssets) onSelectAssets(selectedAssets);
                          setSelectedAssets([]);
                      }}
                  >
                      <Text style={styles.confirmText}>Send {selectedAssets.length} item{selectedAssets.length > 1 ? 's' : ''}</Text>
                      <View style={styles.confirmIconWrap}>
                         <MaterialIcons name="arrow-forward" size={18} color="#BC002A" />
                      </View>
                  </Pressable>
              </Reanimated.View>
          )}

        </GlassView>
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
      paddingTop: 12,
      paddingBottom: 6,
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
      fontSize: 13,
  },

  // Options Row
  optionsRow: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      marginBottom: 8,
      gap: 10,
  },
  optionButton: {
      width: 75,
      height: 54,
      backgroundColor: '#1c1c1e',
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
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
      fontSize: 11,
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
  selectedOverlay: {
      position: 'absolute',
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.4)',
      borderWidth: 2,
      borderColor: '#BC002A',
  },
  checkCircle: {
      position: 'absolute',
      bottom: 8,
      right: 8,
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: '#BC002A',
      alignItems: 'center',
      justifyContent: 'center',
  },
  floatingConfirm: {
      position: 'absolute',
      bottom: 40,
      left: 0,
      right: 0,
      alignItems: 'center',
  },
  confirmButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#BC002A',
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 30,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 5,
      elevation: 8,
  },
  confirmText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '600',
      marginRight: 8,
  },
  confirmIconWrap: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
  },
});
