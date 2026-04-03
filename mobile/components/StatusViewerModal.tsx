import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Modal,
  Pressable,
  useWindowDimensions,
  StatusBar as RNStatusBar,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  BackHandler,
  ActivityIndicator
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withTiming,
  withSpring,
  runOnJS,
  Easing,
  cancelAnimation,
  interpolate,
  Extrapolate,
} from 'react-native-reanimated';

import { statusService } from '../services/StatusService';
import { CachedStatus, CachedUser, UserStatusGroup } from '../types';
import { SoulAvatar } from './SoulAvatar';
import GlassView from './ui/GlassView';
import ProgressiveBlur from './chat/ProgressiveBlur';

interface StatusViewerProps {
  visible: boolean;
  group: UserStatusGroup;
  onClose: () => void;
  onComplete?: () => void;
}

const ProgressBar = ({ 
    index, 
    currentIndex, 
    duration, 
    onComplete, 
    paused 
}: { 
    index: number, 
    currentIndex: number, 
    duration: number, 
    onComplete: () => void, 
    paused: boolean 
}) => {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (index === currentIndex) {
      if (paused) {
        cancelAnimation(progress);
      } else {
        const remaining = (1 - progress.value) * duration * 1000;
        progress.value = withTiming(1, { duration: remaining, easing: Easing.linear }, (finished) => {
          if (finished) {
            runOnJS(onComplete)();
          }
        });
      }
    } else if (index < currentIndex) {
      progress.value = 1;
    } else {
      progress.value = 0;
    }
    return () => cancelAnimation(progress);
  }, [currentIndex, index, paused, duration]);

  const animatedStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <View style={styles.progressTrack}>
      <Animated.View style={[styles.progressFill, animatedStyle]} />
    </View>
  );
};

export const StatusViewerModal = ({
  visible,
  group,
  onClose,
  onComplete,
}: StatusViewerProps) => {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [mediaSource, setMediaSource] = useState<{uri: string, isLocal: boolean} | null>(null);
  const [loading, setLoading] = useState(true);

  const currentStatus = group.statuses[currentIndex];

  useEffect(() => {
    if (visible && currentStatus) {
      setLoading(true);
      statusService.getMediaSource(currentStatus.id, (currentStatus as any).mediaKey || '')
        .then(source => {
          setMediaSource(source);
          setLoading(false);
          // Mark viewed
          statusService.onStatusViewed(currentStatus.id, 'me'); // 'me' placeholder, StatusService handles actual viewer context
        });
    }
  }, [currentStatus?.id, visible]);

  const handleNext = () => {
    if (currentIndex < group.statuses.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      if (onComplete) {
        onComplete();
      } else {
        onClose();
      }
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  };

  const handleLongPressStart = () => setIsPaused(true);
  const handleLongPressEnd = () => setIsPaused(false);

  if (!visible || !currentStatus) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.container}>
        <RNStatusBar hidden />
        
        {/* Fill Background */}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />

        {/* Media Display */}
        <View style={StyleSheet.absoluteFill}>
            {mediaSource ? (
                currentStatus.mediaType === 'image' ? (
                    <Image 
                        source={{ uri: mediaSource.uri }} 
                        style={styles.fullMedia} 
                        resizeMode="contain" 
                    />
                ) : (
                    <View style={styles.placeholderContainer}>
                        <ActivityIndicator color="#fff" />
                        <Text style={{color: '#fff', marginTop: 10}}>Video support refactoring...</Text>
                    </View>
                )
            ) : (
                <View style={styles.placeholderContainer}>
                    <ActivityIndicator color="#fff" size="large" />
                </View>
            )}
        </View>

        {/* Top Overlay: Progress Bars & Info */}
        <View style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}>
            <View style={styles.progressContainer}>
                {group.statuses.map((_, i) => (
                    <ProgressBar 
                        key={group.statuses[i].id} 
                        index={i} 
                        currentIndex={currentIndex} 
                        duration={currentStatus.duration || 5} 
                        onComplete={handleNext} 
                        paused={isPaused} 
                    />
                ))}
            </View>

            <View style={styles.header}>
                <View style={styles.userInfo}>
                    <SoulAvatar 
                      uri={group.user.avatarUrl || ''} 
                      localUri={group.user.localAvatarUri}
                      size={40} 
                    />
                    <View style={styles.userNameContainer}>
                        <Text style={styles.userName}>{group.user.displayName || 'Soulmate'}</Text>
                        <Text style={styles.timeAgo}>
                            {new Date(currentStatus.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                    </View>
                </View>
                <Pressable onPress={onClose} style={styles.closeButton}>
                    <MaterialIcons name="close" size={28} color="#fff" />
                </Pressable>
            </View>
        </View>

        {/* Bottom Overlay: Caption */}
        {currentStatus.caption && (
            <View style={[styles.bottomOverlay, { paddingBottom: insets.bottom + 40 }]}>
                <GlassView intensity={30} tint="dark" style={styles.captionGlass}>
                    <Text style={styles.captionText}>{currentStatus.caption}</Text>
                </GlassView>
            </View>
        )}

        {/* Touch Navigation */}
        <View style={styles.touchContainer}>
            <Pressable 
                style={styles.touchSide} 
                onPress={handlePrev} 
                onLongPress={handleLongPressStart}
                onPressOut={handleLongPressEnd}
            />
            <Pressable 
                style={styles.touchSide} 
                onPress={handleNext} 
                onLongPress={handleLongPressStart}
                onPressOut={handleLongPressEnd}
            />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  fullMedia: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  placeholderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 10,
  },
  progressContainer: {
    flexDirection: 'row',
    height: 3,
    gap: 4,
    marginBottom: 10,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userNameContainer: {
    marginLeft: 12,
  },
  userName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  timeAgo: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
  },
  closeButton: {
    padding: 8,
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    alignItems: 'center',
  },
  captionGlass: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 20,
    maxWidth: '85%',
  },
  captionText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
  touchContainer: {
    position: 'absolute',
    top: 100,
    bottom: 100,
    left: 0,
    right: 0,
    flexDirection: 'row',
    zIndex: 5,
  },
  touchSide: {
    flex: 1,
  }
});
