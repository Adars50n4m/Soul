import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  TextInput,
  Text,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  ActivityIndicator,
  Animated,
  useWindowDimensions,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons, Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { Video, ResizeMode } from 'expo-av';
import { useApp } from '../context/AppContext';
import * as ImagePicker from 'expo-image-picker';
import Svg, { Path } from 'react-native-svg';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { CropImageModal } from './CropImageModal';

interface MediaPreviewModalProps {
  visible: boolean;
  mediaUri?: string;
  mediaType?: 'image' | 'video' | 'audio';
  initialMediaItems?: { uri: string; type: 'image' | 'video' | 'audio' }[];
  onClose: () => void;
  onSend: (mediaList: { uri: string; type: 'image' | 'video' | 'audio' }[], caption?: string) => void;
  isUploading?: boolean;
  mode?: 'chat' | 'status';
}

interface CanvasTextInputProps {
  t: { id: string; text: string; x: number; y: number; color?: string };
  activeTextId: string | null;
  setActiveTextId: (id: string | null) => void;
  setTextOverlays: any;
  textOverlays: any[];
}

const CanvasTextInput = ({ t, activeTextId, setActiveTextId, setTextOverlays, textOverlays }: CanvasTextInputProps) => {
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (activeTextId === t.id) {
      inputRef.current?.focus();
    }
  }, [activeTextId, t.id]);

  return (
    <TextInput
      ref={inputRef}
      style={[styles.canvasText, { color: t.color || '#FFFFFF' }]}
      value={t.text}
      onChangeText={(v) => setTextOverlays(textOverlays.map(x => x.id === t.id ? { ...x, text: v } : x))}
      onBlur={() => setActiveTextId(null)}
      multiline
      editable={activeTextId === t.id}
      pointerEvents={activeTextId === t.id ? 'auto' : 'none'}
    />
  );
};

export const MediaPreviewModal: React.FC<MediaPreviewModalProps> = ({
  visible,
  mediaUri,
  mediaType,
  initialMediaItems,
  onClose,
  onSend,
  isUploading = false,
  mode = 'chat',
}) => {
  const { width } = useWindowDimensions();
  const [caption, setCaption] = useState('');
  const [isTrimming, setIsTrimming] = useState(false);
  
  // Media List state for multi-sending
  const [mediaItems, setMediaItems] = useState<{ uri: string; type: 'image' | 'video' | 'audio' }[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  
  // Crop modal state
  const [showCropModal, setShowCropModal] = useState(false);

  const currentMedia = mediaItems[currentIndex] || (initialMediaItems ? initialMediaItems[0] : { uri: mediaUri || '', type: mediaType || 'image' });
  const currentUri = currentMedia.uri;
  const currentType = currentMedia.type;

  const fadeAnim = useMemo(() => new Animated.Value(0), []);
  const videoRef = useRef<Video>(null);
  const viewShotRef = useRef<View>(null);
  const { activeTheme } = useApp();

  // Tools states
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [paths, setPaths] = useState<{ path: string; color: string; strokeWidth: number }[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  
  // Text Overlays
  const [textOverlays, setTextOverlays] = useState<{ id: string; text: string; x: number; y: number; color: string }[]>([]);
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });


  useEffect(() => {
    Promise.resolve().then(() => {
        if (initialMediaItems && initialMediaItems.length > 0) {
            setMediaItems(initialMediaItems);
        } else if (mediaUri && mediaType) {
            setMediaItems([{ uri: mediaUri, type: mediaType }]);
        } else {
            setMediaItems([]);
        }
        setCaption('');
        setCurrentIndex(0);
        setPaths([]);
        setTextOverlays([]);
    });
  }, [mediaUri, mediaType, initialMediaItems]);

  useEffect(() => {
    if (visible) {
      StatusBar.setHidden(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      StatusBar.setHidden(false);
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible]);

  if (!visible) return null;

  // Tools Handlers
  const applyDrawingsToImage = async () => {
    if (paths.length === 0 && textOverlays.length === 0) return currentUri;
    
    // As native shot is unsupported right now, just fallback warning and return normal. 
    // Ideally, we'd capture.
    Alert.alert(
      'Drawing Not Supported',
      'The view-shot library required to bake drawings is missing from the native build. Your drawings will not be sent.'
    );
    
    setPaths([]);
    setTextOverlays([]);
    return currentUri;
  };

  const handleSend = async () => {
    if (isUploading) return;
    await applyDrawingsToImage(); // fake baking
    onSend(mediaItems, caption.trim() || undefined);
    setCaption('');
  };

  const handleClose = () => {
    setCaption('');
    setPaths([]);
    setTextOverlays([]);
    setIsDrawingMode(false);
    onClose();
  };

  const handlePickGallery = async () => {
    if (isUploading) return;
    Alert.alert('Use Built-In Gallery', 'Please go back and select all photos at once from the custom inline gallery.');
  };

  const handleCrop = () => {
    if (currentType !== 'image' || isUploading) return;
    setShowCropModal(true);
  };

  const handleCropComplete = (croppedUri: string) => {
    setMediaItems(prev =>
      prev.map((item, idx) =>
        idx === currentIndex ? { uri: croppedUri, type: 'image' as const } : item
      )
    );
    setShowCropModal(false);
  };

  const handleCropClose = () => {
    setShowCropModal(false);
  };

  const handleTrimVideo = async () => {
    if (currentType !== 'video' || isUploading || isTrimming) return;
    setIsTrimming(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: true,
        quality: 1,
        videoMaxDuration: 120,
      });

      if (!result.canceled && result.assets?.[0]) {
        const trimmed = result.assets[0];
        setMediaItems(prev => prev.map((item, idx) => (
          idx === currentIndex
            ? { uri: trimmed.uri, type: 'video' as const }
            : item
        )));
      }
      setIsTrimming(false);
    } catch (error) {
      setIsTrimming(false);
      Alert.alert('Trim Failed', 'Could not trim video. Please try again.');
    }
  };

  const toggleDrawing = () => {
    if (!isDrawingMode) setActiveTextId(null);
    setIsDrawingMode(!isDrawingMode);
  };

  const handleUndoPen = () => {
    setPaths(prev => prev.slice(0, -1));
  };

  const handleRemoveCurrentMedia = () => {
    if (mediaItems.length <= 1) {
      handleClose();
      return;
    }
    const newItems = [...mediaItems];
    newItems.splice(currentIndex, 1);
    setMediaItems(newItems);
    if (currentIndex >= newItems.length) {
      setCurrentIndex(newItems.length - 1);
    }
    setPaths([]);
    setTextOverlays([]);
  };

  const handleAddText = () => {
    setIsDrawingMode(false);
    const newId = Date.now().toString();
    setTextOverlays(prev => [...prev, { id: newId, text: 'Tap to edit', x: width / 2.5, y: 150, color: '#FFFFFF' }]);
    setActiveTextId(newId);
  };

  const colors = ['#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#000000'];
  const handleCycleTextColor = (id: string) => {
    setTextOverlays(prev => prev.map(t => {
      if (t.id === id) {
        const nextColorIdx = (colors.indexOf(t.color || '#FFFFFF') + 1) % colors.length;
        return { ...t, color: colors[nextColorIdx] };
      }
      return t;
    }));
  };

  // Text Drag Pan Handlers
  const onTextDragStateChange = (e: any, t: any) => {
    if (e.nativeEvent.state === State.BEGAN) {
      dragStartPos.current = { x: t.x, y: t.y };
    }
  };

  const onTextDrag = (e: any, id: string) => {
    if (activeTextId === id) return; // disable drag while typing
    const { translationX, translationY } = e.nativeEvent;
    setTextOverlays(prev => prev.map(o => o.id === id ? { 
      ...o, 
      x: dragStartPos.current.x + translationX, 
      y: dragStartPos.current.y + translationY 
    } : o));
  };

  // Drawing Handlers
  const onGestureEvent = (e: any) => {
    if (!isDrawingMode) return;
    const { x, y } = e.nativeEvent;
    setCurrentPath((prev) => (prev ? `${prev} L ${x} ${y}` : `M ${x} ${y}`));
  };
  const onHandlerStateChange = (e: any) => {
    if (!isDrawingMode) return;
    if (e.nativeEvent.state === State.END || e.nativeEvent.state === State.CANCELLED) {
      if (currentPath) {
        setPaths(prev => [...prev, { path: currentPath, color: activeTheme.primary, strokeWidth: 5 }]);
        setCurrentPath('');
      }
    }
  };

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
      >
        {/* Top Header Controls */}
        <View style={styles.header}>
          <Pressable style={styles.closeButton} onPress={handleClose} disabled={isUploading}>
            <MaterialIcons name="close" size={26} color="#fff" />
          </Pressable>
          
          <View style={styles.headerActions}>
            <Pressable style={styles.iconButton} onPress={() => Alert.alert("Music", "Coming soon!")}>
              <MaterialIcons name="music-note" size={24} color="#fff" />
            </Pressable>
            <Pressable style={[styles.iconButton, { opacity: currentType === 'video' ? 0.3 : 1 }]} onPress={handleCrop} disabled={isUploading || currentType === 'video'}>
              <MaterialIcons name="crop-rotate" size={24} color="#fff" />
            </Pressable>
            {currentType === 'video' && (
              <Pressable style={styles.iconButton} onPress={handleTrimVideo} disabled={isUploading || isTrimming}>
                {isTrimming ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <MaterialIcons name="content-cut" size={22} color="#fff" />
                )}
              </Pressable>
            )}
            <Pressable style={[styles.iconButton, { opacity: currentType === 'video' ? 0.3 : 1 }]} onPress={handleAddText} disabled={isUploading || currentType === 'video'}>
              <Text style={styles.aaText}>Aa</Text>
            </Pressable>
            <Pressable style={[styles.iconButton, isDrawingMode && styles.iconActive, { opacity: currentType === 'video' ? 0.3 : 1 }]} onPress={toggleDrawing} disabled={isUploading || currentType === 'video'}>
              <MaterialIcons name="edit" size={24} color={isDrawingMode ? activeTheme.primary : '#fff'} />
            </Pressable>
            <Pressable style={styles.iconButton} onPress={handleRemoveCurrentMedia} disabled={isUploading}>
              <MaterialIcons name="delete-outline" size={24} color="#fff" />
            </Pressable>
            {isDrawingMode && paths.length > 0 && (
              <Pressable style={styles.iconButton} onPress={handleUndoPen}>
                <MaterialIcons name="undo" size={24} color="#fff" />
              </Pressable>
            )}
          </View>
        </View>

        {/* Media Preview Area */}
        <View style={styles.mediaContainer}>
          {currentType === 'image' && (
            <PanGestureHandler onGestureEvent={onGestureEvent} onHandlerStateChange={onHandlerStateChange} enabled={isDrawingMode}>
              <Animated.View style={StyleSheet.absoluteFill}>
                <View ref={viewShotRef as any} collapsable={false} style={styles.viewShotCanvas}>
                  <Image source={{ uri: currentUri }} style={styles.mediaImage} contentFit="contain" />
                  
                  {/* Drawing & Text Canvas Overlays */}
                  {(paths.length > 0 || currentPath || textOverlays.length > 0) && (
                    <View style={StyleSheet.absoluteFill} pointerEvents="none">
                      <Svg height="100%" width="100%">
                        {paths.map((p, i) => (
                          <Path key={i} d={p.path} stroke={p.color} strokeWidth={p.strokeWidth} fill="none" strokeLinecap="round" />
                        ))}
                        {currentPath ? (
                          <Path d={currentPath} stroke={activeTheme.primary} strokeWidth={5} fill="none" strokeLinecap="round" />
                        ) : null}
                      </Svg>
                      
                      {textOverlays.map((t) => (
                        <PanGestureHandler
                          key={t.id}
                          onGestureEvent={(e) => onTextDrag(e, t.id)}
                          onHandlerStateChange={(e) => onTextDragStateChange(e, t)}
                        >
                          <Animated.View style={[styles.canvasTextContainer, { left: t.x, top: t.y }]}>
                            <Pressable 
                              onPress={() => setActiveTextId(t.id)} 
                              onLongPress={() => handleCycleTextColor(t.id)}
                            >
                              <CanvasTextInput
                                t={t}
                                activeTextId={activeTextId}
                                setActiveTextId={setActiveTextId}
                                setTextOverlays={setTextOverlays}
                                textOverlays={textOverlays}
                              />
                            </Pressable>
                          </Animated.View>
                        </PanGestureHandler>
                      ))}
                    </View>
                  )}
                </View>
              </Animated.View>
            </PanGestureHandler>
          )}
          {currentType === 'video' && (
            <View style={styles.videoWrapper}>
              <Video
                ref={videoRef}
                source={{ uri: currentUri }}
                style={styles.mediaImage}
                resizeMode={ResizeMode.CONTAIN}
                useNativeControls={true}
                isLooping={false}
              />
            </View>
          )}
          {currentType === 'audio' && (
            <View style={styles.audioPreview}>
              <MaterialIcons name="graphic-eq" size={80} color={activeTheme.primary} />
              <MaterialIcons name="play-circle-filled" size={60} color="#fff" />
            </View>
          )}

          {/* Swipe Controls for Multiple Items */}
          {mediaItems.length > 1 && (
            <View style={styles.swipeIndicators}>
              <Pressable 
                style={[styles.navArrow, { opacity: currentIndex > 0 ? 1 : 0.3 }]} 
                onPress={() => currentIndex > 0 && setCurrentIndex(currentIndex - 1)}
              >
                <MaterialIcons name="chevron-left" size={32} color="#fff" />
              </Pressable>
              
              <View style={styles.dotsRow}>
                {mediaItems.map((_, idx) => (
                  <View key={idx} style={[styles.dot, { backgroundColor: idx === currentIndex ? activeTheme.primary : 'rgba(255,255,255,0.4)' }]} />
                ))}
              </View>

              <Pressable 
                style={[styles.navArrow, { opacity: currentIndex < mediaItems.length - 1 ? 1 : 0.3 }]} 
                onPress={() => currentIndex < mediaItems.length - 1 && setCurrentIndex(currentIndex + 1)}
              >
                <MaterialIcons name="chevron-right" size={32} color="#fff" />
              </Pressable>
            </View>
          )}
        </View>

        {/* Bottom Input Area */}
        <View style={styles.bottomContainer}>
          <View style={styles.inputActionRow}>
            <View style={styles.inputWrapper}>
              <Pressable style={styles.captionIcon} onPress={handlePickGallery} disabled={isUploading}>
                <MaterialIcons name="add-photo-alternate" size={24} color="#fff" />
              </Pressable>
              <TextInput
                style={styles.captionInput}
                placeholder="Add a caption..."
                placeholderTextColor="rgba(255, 255, 255, 0.6)"
                value={caption}
                onChangeText={setCaption}
                maxLength={500}
                editable={!isUploading}
                multiline
              />
            </View>

            <Pressable
              style={[styles.themedSendButton, { backgroundColor: activeTheme.primary }, isUploading && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={isUploading}
            >
              {isUploading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="send" size={18} color="#fff" />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Crop Image Modal */}
      <CropImageModal
        visible={showCropModal}
        imageUri={currentUri}
        onClose={handleCropClose}
        onCropComplete={handleCropComplete}
      />
    </Animated.View>
  );
};

const canvasTextShadow = Platform.select({
  ios: {
    textShadowColor: 'rgba(0,0,0,0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  default: undefined,
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    zIndex: 998,
  },
  keyboardAvoid: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    paddingTop: Platform.OS === 'ios' ? 60 : StatusBar.currentHeight ? StatusBar.currentHeight + 10 : 30,
    paddingBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
  },
  closeButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 23,
  },
  aaText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  mediaContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  viewShotCanvas: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  canvasTextContainer: {
    position: 'absolute',
    padding: 10,
  },
  canvasText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
    minWidth: 100,
    ...canvasTextShadow,
  },
  iconActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8,
  },
  videoWrapper: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  audioPreview: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  swipeIndicators: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  navArrow: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    padding: 4,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  bottomContainer: {
    paddingHorizontal: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    paddingTop: 12,
    backgroundColor: '#000',
  },
  inputActionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    width: '100%',
    marginBottom: 12,
  },
  inputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 56,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    marginRight: 14,
  },
  captionIcon: {
    padding: 2,
  },
  captionInput: {
    flex: 1,
    color: '#fff',
    fontSize: 17,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 8 : 4,
    paddingBottom: Platform.OS === 'ios' ? 8 : 4,
  },
  themedSendButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
});
