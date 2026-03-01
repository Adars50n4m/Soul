import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Image,
  Pressable,
  StyleSheet,
  Text,
  Animated,
  StatusBar,
  GestureResponderEvent,
  PanResponder,
    useWindowDimensions,
    Alert,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import { Video, AVPlaybackStatus, ResizeMode } from 'expo-av';

interface MediaPlayerModalProps {
  visible: boolean;
  mediaUrl: string;
  mediaType: 'image' | 'video' | 'audio';
  caption?: string;
  onClose: () => void;
}

export const MediaPlayerModal: React.FC<MediaPlayerModalProps> = ({
  visible,
  mediaUrl,
  mediaType,
  caption,
  onClose,
}) => {
  const fadeAnim = useMemo(() => new Animated.Value(0), []);
  const videoRef = useRef<Video>(null);
  const [isPlaying, setIsPlaying] = useState(mediaType === 'image' ? false : true);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | number | null>(null);
  const { width, height } = useWindowDimensions();

  // Pinch-to-zoom state for images
  const [scale, setScale] = useState(1);
  const scaleAnim = useMemo(() => new Animated.Value(1), []);
  const [lastScale, setLastScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const lastTranslate = useRef({ x: 0, y: 0 });

  const panResponder = useMemo(() => 
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => scale > 1,
      onPanResponderMove: (evt, gestureState) => {
        if (scale > 1) {
          // Pan gesture for zoomed images
        }
      },
      onPanResponderRelease: () => {
        if (scale > 1) {
          Animated.spring(scaleAnim, {
            toValue: 1,
            useNativeDriver: false,
          }).start();
          setScale(1);
        }
      },
    }), [scale, scaleAnim]);

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

  const resetControlsTimeout = () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControls(true);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying && mediaType !== 'image') {
        setShowControls(false);
      }
    }, 3000);
  };

  const togglePlayPause = async () => {
    if (mediaType === 'video' || mediaType === 'audio') {
      if (isPlaying) {
        await videoRef.current?.pauseAsync();
      } else {
        await videoRef.current?.playAsync();
      }
      setIsPlaying(!isPlaying);
      resetControlsTimeout();
    }
  };

  const handleVideoStatusUpdate = (status: AVPlaybackStatus) => {
    if (status.isLoaded) {
      setPosition(status.positionMillis);
      setDuration(status.durationMillis || 0);

      if (status.didJustFinish && !status.isLooping) {
        setIsPlaying(false);
      }
    }
  };

  const handleSeek = (newPosition: number) => {
    videoRef.current?.setPositionAsync(newPosition);
    setPosition(newPosition);
  };

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const displaySeconds = seconds % 60;
    return `${minutes}:${displaySeconds.toString().padStart(2, '0')}`;
  };

  const handleProgressBarPress = (event: GestureResponderEvent) => {
    const { locationX } = event.nativeEvent;
    const percentage = locationX / 250; // Progress bar width is 250
    const newPosition = percentage * duration;
    handleSeek(Math.max(0, Math.min(newPosition, duration)));
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim }]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      {/* Close Button */}
      <Pressable style={styles.closeButton} onPress={onClose}>
        <MaterialIcons name="close" size={24} color="#fff" />
      </Pressable>

      {/* Media Display Area */}
      <Pressable
        style={styles.mediaArea}
        onPress={() => {
          if (mediaType !== 'image') {
            resetControlsTimeout();
          }
        }}
        {...(mediaType === 'image' ? panResponder.panHandlers : {})}
      >
        {mediaType === 'image' && (
          <Image
            source={{ uri: mediaUrl }}
            style={[styles.mediaImage, { transform: [{ scale: scaleAnim }] }]}
            resizeMode="contain"
            onError={() =>
              Alert.alert('Error', 'Failed to load image')
            }
          />
        )}

        {mediaType === 'video' && (
          <>
            <Video
              ref={videoRef}
              source={{ uri: mediaUrl }}
              style={styles.video}
              resizeMode={ResizeMode.CONTAIN}
              onPlaybackStatusUpdate={handleVideoStatusUpdate}
              onError={() => {
                Alert.alert('Error', 'Failed to load video');
                onClose();
              }}
              shouldPlay={true}
              isLooping={false}
            />

            {/* Video Controls Overlay */}
            {showControls && (
              <BlurView intensity={60} tint="dark" style={styles.controlsOverlay} experimentalBlurMethod="dimezisBlurView">
                <View style={styles.playButtonCenter}>
                  <Pressable onPress={togglePlayPause} style={styles.largePlayButton}>
                    <MaterialIcons
                      name={isPlaying ? 'pause-circle-filled' : 'play-circle-filled'}
                      size={64}
                      color="#BC002A"
                    />
                  </Pressable>
                </View>

                {/* Progress Bar */}
                <View style={styles.progressContainer}>
                  <Pressable
                    onPress={handleProgressBarPress}
                    style={styles.progressBarArea}
                  >
                    <View style={styles.progressBarBackground}>
                      <LinearGradient
                        colors={['#BC002A', '#c40046']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={[
                          styles.progressBarFill,
                          { width: `${(position / duration) * 100}%` },
                        ]}
                      />
                    </View>
                  </Pressable>
                  <View style={styles.timeDisplay}>
                    <Text style={styles.timeText}>{formatTime(position)}</Text>
                    <Text style={styles.timeText}>{formatTime(duration)}</Text>
                  </View>
                </View>

                {/* Bottom Controls */}
                <View style={styles.bottomControls}>
                  <Pressable onPress={togglePlayPause}>
                    <MaterialIcons
                      name={isPlaying ? 'pause' : 'play-arrow'}
                      size={28}
                      color="#fff"
                    />
                  </Pressable>
                </View>
              </BlurView>
            )}
          </>
        )}

        {mediaType === 'audio' && (
          <BlurView intensity={100} tint="dark" style={styles.audioContainer} experimentalBlurMethod="dimezisBlurView">
            <MaterialIcons name="graphic-eq" size={120} color="#BC002A" />

            {/* Play Button */}
            <Pressable onPress={togglePlayPause} style={styles.playButton}>
              <MaterialIcons
                name={isPlaying ? 'pause-circle-filled' : 'play-circle-filled'}
                size={80}
                color="#BC002A"
              />
            </Pressable>

            {/* Progress Bar for Audio */}
            <View style={styles.audioProgressContainer}>
              <Pressable
                onPress={handleProgressBarPress}
                style={styles.progressBarArea}
              >
                <View style={styles.progressBarBackground}>
                  <LinearGradient
                    colors={['#BC002A', '#c40046']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={[
                      styles.progressBarFill,
                      { width: `${(position / duration) * 100}%` },
                    ]}
                  />
                </View>
              </Pressable>
              <View style={styles.timeDisplay}>
                <Text style={styles.timeText}>{formatTime(position)}</Text>
                <Text style={styles.timeText}>{formatTime(duration)}</Text>
              </View>
            </View>

            {/* Hidden Audio Player */}
            <Video
              ref={videoRef}
              source={{ uri: mediaUrl }}
              style={{ display: 'none' }}
              onPlaybackStatusUpdate={handleVideoStatusUpdate}
              shouldPlay={true}
              isLooping={false}
            />
          </BlurView>
        )}
      </Pressable>

      {/* Caption Display */}
      {caption && (
        <BlurView intensity={90} tint="dark" style={styles.captionContainer} experimentalBlurMethod="dimezisBlurView">
          <Text style={styles.captionText}>{caption}</Text>
        </BlurView>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    zIndex: 997,
    justifyContent: 'space-between',
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  mediaArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  controlsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  playButtonCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  largePlayButton: {
    opacity: 0.9,
  },
  progressContainer: {
    padding: 16,
    paddingBottom: 32,
  },
  progressBarArea: {
    marginBottom: 8,
  },
  progressBarBackground: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  timeDisplay: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 12,
    fontWeight: '500',
  },
  bottomControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingBottom: 24,
    gap: 24,
  },
  audioContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    backgroundColor: 'rgba(30, 30, 35, 0.6)',
    gap: 40,
  },
  playButton: {
    marginVertical: 20,
  },
  audioProgressContainer: {
    width: '90%',
    paddingVertical: 24,
  },
  captionContainer: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    padding: 12,
    backgroundColor: 'rgba(30, 30, 35, 0.6)',
  },
  captionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
});
