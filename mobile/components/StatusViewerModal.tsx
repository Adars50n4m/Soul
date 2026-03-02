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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ProgressiveBlur from './chat/ProgressiveBlur';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withTiming,
  withSpring,
  withSequence,
  runOnJS,
  Easing,
  cancelAnimation
} from 'react-native-reanimated';
import { Story } from '../types';
import { useApp } from '../context/AppContext';


interface StatusViewerModalProps {
  visible: boolean;
  stories: Story[];
  contactName: string;
  contactAvatar: string;
  statusOwnerId?: string;
  currentUserId?: string;
  onReact?: (storyId: string) => void;
  onReply?: (story: Story, text: string) => void;
  onDeleteStory?: (storyId: string) => void;
  onStorySeen?: (storyId: string) => void;
  onClose: () => void;
  onComplete: () => void;
}

const ProgressBar = ({ index, currentIndex, duration, onComplete, paused }: { index: number, currentIndex: number, duration: number, onComplete: () => void, paused: boolean }) => {
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
  }, [currentIndex, index, paused, duration, onComplete]);

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
  stories,
  contactName,
  contactAvatar,
  statusOwnerId,
  currentUserId,
  onReact,
  onReply,
  onDeleteStory,
  onStorySeen,
  onClose,
  onComplete,
}: StatusViewerModalProps) => {
  const { width, height } = useWindowDimensions();
  const { activeTheme, contacts, currentUser } = useApp();
  const insets = useSafeAreaInsets();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [replyText, setReplyText] = useState('');
  const [mediaLoadFailed, setMediaLoadFailed] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isUIVisible, setIsUIVisible] = useState(true);
  const [isLongPressActive, setIsLongPressActive] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);

  // Use render-time state reset to avoid cascading renders in useEffect
  if (visible !== prevVisible) {
      if (visible) {
          setCurrentIndex(0);
          setReplyText('');
          setMediaLoadFailed(false);
          setShowViewers(false);
      }
      setPrevVisible(visible);
  }
  
  const heartScale = useSharedValue(1);
  const viewersTranslateY = useSharedValue(0); // Initialize with 0, will update in useEffect
  const backdropOpacity = useSharedValue(0);
  const currentStory = stories[currentIndex] || stories[0] || null;
  const isOwnStatus = !!currentUserId && !!statusOwnerId && statusOwnerId === currentUserId;

  useEffect(() => {
    if (visible) {
      viewersTranslateY.value = height;
      backdropOpacity.value = 0;
    }
  }, [visible, height]);

  useEffect(() => {
    setMediaLoadFailed(false);
    // Sync liked state with current story
    setIsLiked(currentStory?.likes?.includes(currentUserId || '') || false);
  }, [currentStory?.id, currentUserId]);

  useEffect(() => {
    if (visible && currentStory?.id && onStorySeen) {
      onStorySeen(currentStory.id);
    }
  }, [visible, currentStory?.id, onStorySeen]);

  const handleNext = () => {
    if (currentIndex < stories.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      onComplete(); // Finished all stories
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    } else {
      // Create a restart feel or do nothing
       setCurrentIndex(0);
    }
  };

  const handleHeartPress = () => {
    const nextState = !isLiked;
    setIsLiked(nextState);
    if (onReact) onReact(currentStory.id);

    // Bouncy heart pop animation
    heartScale.value = withSequence(
      withSpring(1.4, { damping: 10, stiffness: 100 }),
      withSpring(1, { damping: 12, stiffness: 120 })
    );
  };

  const heartAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }],
  }));

  const viewersAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: viewersTranslateY.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const toggleViewers = (show: boolean) => {
    setShowViewers(show);
    setIsPaused(show);
    
    viewersTranslateY.value = withTiming(show ? 0 : height, {
      duration: 350,
      easing: Easing.out(Easing.quad),
    });
    
    backdropOpacity.value = withTiming(show ? 1 : 0, { duration: 300 });
  };

  const getViewerDetails = (userIds: string[] = []) => {
    return userIds.map(id => {
      if (id === currentUser?.id) return { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar };
      const contact = contacts.find(u => u.id === id);
  return contact || { id, name: 'Unknown User', avatar: '' };
    });
  };


  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (visible) {
      setNow(Date.now());
    }
  }, [visible]);

  const formatStoryTime = (value?: string) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    const diffMs = now - parsed.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  const handleReplySend = () => {
    const text = replyText.trim();
    if (!text || !onReply) return;
    onReply(currentStory, text);
    setReplyText('');
  };

  const handleMediaError = () => {
    setMediaLoadFailed(true);
    if (currentIndex < stories.length - 1) {
      setTimeout(() => {
        setCurrentIndex(prev => Math.min(prev + 1, stories.length - 1));
      }, 250);
    }
  };

  const handlePause = () => {
    setIsPaused(true);
    setIsUIVisible(false);
  };

  const handleResume = () => {
    setIsPaused(false);
    setIsUIVisible(true);
  };

  if (!visible || !currentStory) return null;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.container}>
        <RNStatusBar hidden />
        
        <BlurView intensity={24} tint="dark" style={StyleSheet.absoluteFill} experimentalBlurMethod="dimezisBlurView" />
        
        {isUIVisible && (
          <>
            <ProgressiveBlur position="top" height={220} intensity={400} />
            <ProgressiveBlur position="bottom" height={350} intensity={400} />
          </>
        )}

        {/* Main Content */}
        <View
          style={[
            styles.contentContainer,
            { paddingTop: insets.top, paddingBottom: insets.bottom + 20 },
            currentStory.type === 'text' && { backgroundColor: currentStory.backgroundColor || '#151515' }
          ]}
        >
          {currentStory.type === 'image' && !mediaLoadFailed && (
            <Image
              source={{ uri: currentStory.url }}
              style={styles.mediaBackdrop}
              resizeMode="cover"
              blurRadius={28}
            />
          )}
          {currentStory.type === 'text' ? (
             <View style={styles.textStatusContainer}>
               <Text 
                 style={[
                   styles.captionText, 
                   { 
                     fontSize: Math.max(24, 42 - (currentStory.caption?.length || 0) / 4), 
                     paddingHorizontal: 20,
                     fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }),
                     lineHeight: 52,
                     textAlign: 'center'
                   }
                 ]}
                >
                 {currentStory.caption || currentStory.url} 
               </Text>
             </View>
          ) : currentStory.type === 'image' && !mediaLoadFailed ? (
            <Image
              source={{ uri: currentStory.url }}
              style={[styles.media, { width: width }]}
              resizeMode="contain"
              onError={handleMediaError}
            />
          ) : (
            <View style={[styles.media, styles.videoPlaceholder, { width: width }]}>
              <MaterialIcons
                name={currentStory.type === 'video' ? 'play-circle-filled' : 'broken-image'}
                size={58}
                color="rgba(255,255,255,0.95)"
              />
              <Text style={styles.videoPlaceholderText}>
                {currentStory.type === 'video' ? 'Video playback coming soon' : 'Image unavailable'}
              </Text>
            </View>
          )}
        </View>

        {/* Overlay UI */}
        <SafeAreaView style={[styles.overlay, { opacity: isUIVisible ? 1 : 0 }]} pointerEvents={isUIVisible ? 'auto' : 'none'}>
             {/* Progress Bars */}
             <View style={styles.progressContainer}>
                {stories.map((story, index) => (
                    <ProgressBar 
                        key={story.id} 
                        index={index} 
                        currentIndex={currentIndex} 
                        duration={story.duration || 10} 
                        onComplete={handleNext}
                        paused={isPaused}
                    />
                ))}
            </View>

            {/* Header */}
            <View style={[styles.header, { paddingTop: Math.max(0, insets.top - 160) }]}>
                <View style={styles.userInfo}>
                    <Image source={{ uri: contactAvatar }} style={styles.avatar} />
                    <View style={styles.userTextInfo}>
                      <Text style={styles.userName}>{contactName}</Text>
                      <View style={styles.metaRow}>
                        <Text style={styles.timestamp}>{formatStoryTime(currentStory.timestamp)}</Text>
                      </View>
                    </View>
                </View>
                <View style={styles.headerActions}>
                  <Pressable style={styles.iconButton}>
                    <MaterialIcons name="more-horiz" size={24} color="#fff" />
                  </Pressable>
                  <Pressable onPress={onClose} style={styles.iconButton}>
                    <MaterialIcons name="close" size={24} color="#fff" />
                  </Pressable>
                </View>
            </View>
        </SafeAreaView>

        {/* Touch Navigation Overlay */}
        <View style={[styles.touchOverlay, { bottom: insets.bottom + 188 }]}>
            <Pressable 
              style={styles.touchLeft} 
              onPress={handlePrev} 
              onLongPress={handlePause}
              onPressOut={handleResume}
              delayLongPress={300}
            />
            <Pressable 
              style={styles.touchRight} 
              onPress={handleNext} 
              onLongPress={handlePause}
              onPressOut={handleResume}
              delayLongPress={300}
            />
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? insets.bottom + 4 : 0}
          style={[styles.bottomContainer, { paddingBottom: insets.bottom + 12, opacity: isUIVisible ? 1 : 0 }]}
          pointerEvents={isUIVisible ? 'auto' : 'none'}
        >
          {!!currentStory.caption && currentStory.type !== 'text' && (
            <View style={styles.captionContainer}>
              <Text style={styles.captionText}>{currentStory.caption}</Text>
              <View style={styles.captionDivider} />
            </View>
          )}

          <View style={styles.bottomActionsRow}>
            {isOwnStatus ? (
              <Pressable 
                style={styles.viewsIndicator}
                onPress={() => toggleViewers(true)}
              >
                <Ionicons name="chevron-up" size={20} color="#fff" />
                <Text style={styles.viewsCountText}>{currentStory.views?.length || 0} views</Text>
              </Pressable>
            ) : (
              <>
                <View style={styles.replyInputWrap}>
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    placeholder="Reply"
                    placeholderTextColor="rgba(255,255,255,0.7)"
                    style={styles.replyInput}
                    returnKeyType="send"
                    onSubmitEditing={handleReplySend}
                  />
                </View>
                <Pressable
                  style={styles.heartButton}
                  onPress={handleHeartPress}
                >
                  <Animated.View style={heartAnimatedStyle}>
                    <Ionicons 
                      name={isLiked ? "heart" : "heart-outline"} 
                      size={26} 
                      color={isLiked ? "#FF3B81" : "#fff"} 
                    />
                  </Animated.View>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>

        {/* Viewers List Drawer */}
        {isOwnStatus && (
          <>
            <Animated.View 
              style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 90 }, backdropAnimatedStyle]} 
              pointerEvents={showViewers ? 'auto' : 'none'}
            >
              <Pressable style={{ flex: 1 }} onPress={() => toggleViewers(false)} />
            </Animated.View>
            
            <Animated.View style={[styles.viewersDrawer, { height: height * 0.45 }, viewersAnimatedStyle]}>
              <View style={styles.drawerHeader}>
                <View style={styles.drawerHandle} />
                <View style={styles.drawerTitleRow}>
                  <Text style={styles.drawerTitle}>Views</Text>
                  <Pressable onPress={() => toggleViewers(false)}>
                    <Ionicons name="close" size={24} color="#fff" />
                  </Pressable>
                </View>
              </View>
              
              <View style={styles.viewersList}>
                {currentStory.views && currentStory.views.length > 0 ? (
                  currentStory.views.map((userId, idx) => {
                    const user = userId === currentUser?.id ? currentUser : contacts.find(u => u.id === userId);
                    const liked = currentStory.likes?.includes(userId);
                    return (
                      <View key={userId} style={styles.viewerItem}>
                        <Image source={{ uri: user?.avatar }} style={styles.viewerAvatar} />
                        <View style={styles.viewerInfo}>
                          <Text style={styles.viewerName}>{user?.name || 'Anonymous'}</Text>
                          <Text style={styles.viewerTime}>Just now</Text>
                        </View>
                        {liked && (
                          <Ionicons name="heart" size={20} color="#FF3B81" />
                        )}
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.emptyViewers}>
                    <Ionicons name="eye-off-outline" size={48} color="rgba(255,255,255,0.2)" />
                    <Text style={styles.emptyViewersText}>No views yet</Text>
                  </View>
                )}
              </View>
            </Animated.View>
          </>
        )}

      </View>
    </Modal>
  );
};

const captionTextShadow = Platform.select({
  ios: {
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  default: undefined,
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
    paddingBottom: 100,
    paddingHorizontal: 0,
    overflow: 'hidden',
  },
  mediaBackdrop: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.55,
    transform: [{ scale: 1.08 }],
  },
  media: {
    height: '100%',
    borderRadius: 0,
  },
  textStatusContainer: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  videoPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  videoPlaceholderText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '600',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 2,
    zIndex: 10,
  },
  progressContainer: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    gap: 4,
    height: 3,
    marginBottom: 8,
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
    paddingHorizontal: 16,
    zIndex: 20,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  userTextInfo: {
    justifyContent: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaDivider: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
  },
  musicText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 4,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  userName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  timestamp: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },
  floatingMusicContainer: {
    position: 'absolute',
    top: 100,
    right: 20,
    width: 64,
    height: 64,
    zIndex: 20,
  },
  floatingMusicArt: {
    width: 54,
    height: 54,
    borderRadius: 4,
    position: 'absolute',
    top: 0,
    right: 8,
    zIndex: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
  },
  musicVinyl: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#111',
    position: 'absolute',
    bottom: 0,
    right: 0,
    zIndex: 1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  musicVinylCenter: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#333',
    position: 'absolute',
    top: 17,
    left: 17,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  touchOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 120,
    flexDirection: 'row',
    zIndex: 5,
  },
  touchLeft: {
    flex: 1,
  },
  touchRight: {
    flex: 2, // Larger area for next
  },
  bottomContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    zIndex: 12,
  },
  captionContainer: {
    marginBottom: 16,
    alignItems: 'center',
  },
  captionText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 16,
    ...captionTextShadow,
  },
  captionDivider: {
    width: '100%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  bottomActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  replyInputWrap: {
    flex: 1,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    height: 54,
    justifyContent: 'center',
  },
  replyInput: {
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 20,
  },
  heartButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  viewsIndicator: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
  },
  viewsCountText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  viewersDrawer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    zIndex: 100,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 20,
  },
  drawerHeader: {
    paddingTop: 12,
    paddingBottom: 8,
    alignItems: 'center',
  },
  drawerHandle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    marginBottom: 16,
  },
  drawerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  drawerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  viewersList: {
    flex: 1,
    paddingHorizontal: 20,
  },
  viewerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  viewerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  viewerAvatarSmall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  viewerInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  viewerName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  viewerTime: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginTop: 2,
  },
  emptyViewers: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 40,
    gap: 12,
  },
  emptyViewersText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 16,
    fontWeight: '500',
  },
});
