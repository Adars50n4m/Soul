import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Image,
  Pressable,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialIcons } from '@expo/vector-icons';
import { Video, ResizeMode } from 'expo-av';

interface MediaPreviewModalProps {
  visible: boolean;
  mediaUri: string;
  mediaType: 'image' | 'video' | 'audio';
  onClose: () => void;
  onSend: (caption?: string) => void;
  isUploading?: boolean;
}

export const MediaPreviewModal: React.FC<MediaPreviewModalProps> = ({
  visible,
  mediaUri,
  mediaType,
  onClose,
  onSend,
  isUploading = false,
}) => {
  const [caption, setCaption] = useState('');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const videoRef = useRef<Video>(null);

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

  const handleSend = () => {
    if (isUploading) return;
    onSend(caption.trim() || undefined);
    setCaption('');
  };

  const handleClose = () => {
    setCaption('');
    onClose();
  };

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
      >
        {/* Close Button */}
        <Pressable style={styles.closeButton} onPress={handleClose} disabled={isUploading}>
          <MaterialIcons name="close" size={24} color="#fff" />
        </Pressable>

        {/* Media Preview Area */}
        <View style={styles.mediaContainer}>
          {mediaType === 'image' && (
            <Image source={{ uri: mediaUri }} style={styles.mediaImage} resizeMode="contain" />
          )}
          {mediaType === 'video' && (
            <View style={styles.videoWrapper}>
              <Video
                ref={videoRef}
                source={{ uri: mediaUri }}
                style={styles.mediaImage}
                resizeMode={ResizeMode.CONTAIN}
                useNativeControls={true}
                isLooping={false}
              />
            </View>
          )}
          {mediaType === 'audio' && (
            <View style={styles.audioPreview}>
              <MaterialIcons name="graphic-eq" size={80} color="#BC002A" />
              <MaterialIcons name="play-circle-filled" size={60} color="#fff" />
            </View>
          )}
        </View>

        {/* Caption Input */}
        <BlurView intensity={90} tint="dark" style={styles.inputContainer}>
          <TextInput
            style={styles.captionInput}
            placeholder="Add caption (optional)"
            placeholderTextColor="rgba(255, 255, 255, 0.3)"
            value={caption}
            onChangeText={setCaption}
            maxLength={500}
            editable={!isUploading}
            multiline
          />
        </BlurView>

        {/* Send Button */}
        <View style={styles.sendButtonContainer}>
          <LinearGradient
            colors={['#BC002A', '#c40046']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.sendButtonGradient}
          >
            <Pressable
              style={styles.sendButton}
              onPress={handleSend}
              disabled={isUploading}
            >
              {isUploading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="arrow-upward" size={24} color="#fff" />
              )}
            </Pressable>
          </LinearGradient>
        </View>
      </KeyboardAvoidingView>
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
    zIndex: 998,
  },
  keyboardAvoid: {
    flex: 1,
    justifyContent: 'space-between',
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    left: 16,
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
  mediaContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 60,
  },
  mediaImage: {
    width: '100%',
    height: '100%',
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
  inputContainer: {
    marginHorizontal: 16,
    marginVertical: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    overflow: 'hidden',
    backgroundColor: 'rgba(30, 30, 35, 0.6)',
  },
  captionInput: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    padding: 12,
    maxHeight: 100,
    textAlignVertical: 'top',
  },
  sendButtonContainer: {
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingRight: 20,
    paddingBottom: 24,
  },
  sendButtonGradient: {
    width: 60,
    height: 60,
    borderRadius: 30,
    shadowColor: '#BC002A',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 5,
  },
  sendButton: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
