/**
 * MediaBubble - WhatsApp-style offline media component
 * 
 * Handles displaying media with offline support:
 * - Shows blurred thumbnail for undownloaded media
 * - Shows download button for media not yet downloaded
 * - Shows actual media from local storage when downloaded
 * - Handles sending media with optimistic local save
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Image,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { mediaDownloadService, formatBytes } from '../services/MediaDownloadService';
import { offlineService, MediaStatus } from '../services/LocalDBService';
import { Message } from '../types';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MAX_MEDIA_WIDTH = SCREEN_WIDTH * 0.65;

interface MediaBubbleProps {
  message: Message;
  isOwn: boolean; // true if sent by current user
  onMediaTap?: (message: Message) => void;
  theme?: {
    primary: string;
    background: string;
    text: string;
  };
}

export const MediaBubble: React.FC<MediaBubbleProps> = ({
  message,
  isOwn,
  onMediaTap,
  theme = { primary: '#007AFF', background: '#1C1C1E', text: '#FFFFFF' }
}) => {
  const [mediaStatus, setMediaStatus] = useState<MediaStatus>(message.mediaStatus || 'not_downloaded');
  const [localUri, setLocalUri] = useState<string | null>(message.localFileUri || null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const media = message.media;
  const mediaWidth = MAX_MEDIA_WIDTH;
  const mediaHeight = media?.type === 'video' ? mediaWidth * 0.75 : mediaWidth;

  // Check if media is available locally
  useEffect(() => {
    checkLocalMedia();
  }, [message.id, message.localFileUri]);

  const checkLocalMedia = async () => {
    if (message.localFileUri) {
      const exists = await mediaDownloadService.localFileExists(message.localFileUri);
      if (exists) {
        setLocalUri(message.localFileUri);
        setMediaStatus('downloaded');
        return;
      }
    }
    // Check database for latest status
    const msg = await offlineService.getMessageById(message.id);
    if (msg?.localFileUri) {
      const exists = await mediaDownloadService.localFileExists(msg.localFileUri);
      if (exists) {
        setLocalUri(msg.localFileUri);
        setMediaStatus('downloaded');
      }
    }
  };

  // Handle download button press
  const handleDownload = useCallback(async () => {
    if (isDownloading || !media?.url) return;

    setIsDownloading(true);
    setMediaStatus('downloading');
    setError(null);

    try {
      const result = await mediaDownloadService.downloadMediaWithProgress(
        message.id,
        media.url,
        (progress) => {
          setDownloadProgress(progress.progress);
        }
      );

      if (result.success && result.localUri) {
        setLocalUri(result.localUri);
        setMediaStatus('downloaded');
      } else {
        setMediaStatus('download_failed');
        setError(result.error || 'Download failed');
      }
    } catch (err) {
      setMediaStatus('download_failed');
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setIsDownloading(false);
    }
  }, [message.id, media?.url, isDownloading]);

  // Handle media tap
  const handleTap = useCallback(() => {
    if (mediaStatus === 'downloaded' && localUri) {
      onMediaTap?.({ ...message, localFileUri: localUri });
    } else if (mediaStatus === 'not_downloaded' || mediaStatus === 'download_failed') {
      handleDownload();
    }
  }, [mediaStatus, localUri, message, onMediaTap, handleDownload]);

  // Render based on media status
  const renderContent = () => {
    if (!media) return null;
    // Media is downloaded and available locally
    if (mediaStatus === 'downloaded' && localUri) {
      return (
        <Animated.View entering={FadeIn.duration(200)}>
          <Pressable onPress={() => onMediaTap?.({ ...message, localFileUri: localUri })}>
            {media.type === 'image' || media.type === 'status_reply' ? (
              <Image
                source={{ uri: localUri }}
                style={[styles.media, { width: mediaWidth, height: mediaHeight }]}
                resizeMode="cover"
              />
            ) : media.type === 'video' ? (
              <View style={[styles.videoContainer, { width: mediaWidth, height: mediaHeight }]}>
                <Image
                  source={{ uri: localUri }}
                  style={styles.videoThumbnail}
                  resizeMode="cover"
                />
                <View style={styles.playOverlay}>
                  <MaterialIcons name="play-circle-fill" size={48} color="white" />
                </View>
              </View>
            ) : (
              <View style={[styles.fileContainer, { width: mediaWidth }]}>
                <MaterialIcons name="insert-drive-file" size={32} color={theme.primary} />
                <Text style={styles.fileName} numberOfLines={1}>
                  {media.name || 'File'}
                </Text>
              </View>
            )}
          </Pressable>
          {media.caption && (
            <Text style={styles.caption}>{media.caption}</Text>
          )}
        </Animated.View>
      );
    }

    // Media is downloading
    if (mediaStatus === 'downloading' || isDownloading) {
      return (
        <View style={[styles.placeholder, { width: mediaWidth, height: mediaHeight }]}>
          <BlurView intensity={80} style={styles.blurOverlay}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={styles.downloadingText}>
              {downloadProgress > 0 ? `${downloadProgress}%` : 'Downloading...'}
            </Text>
          </BlurView>
        </View>
      );
    }

    // Media download failed
    if (mediaStatus === 'download_failed') {
      return (
        <Pressable onPress={handleDownload} style={[styles.placeholder, { width: mediaWidth, height: mediaHeight }]}>
          <BlurView intensity={80} style={styles.blurOverlay}>
            <MaterialIcons name="error-outline" size={40} color="#FF3B30" />
            <Text style={styles.errorText}>{error || 'Download failed'}</Text>
            <Text style={styles.retryText}>Tap to retry</Text>
          </BlurView>
        </Pressable>
      );
    }

    // Media not downloaded yet - show download button
    return (
      <Pressable onPress={handleDownload} style={[styles.placeholder, { width: mediaWidth, height: mediaHeight }]}>
        <BlurView intensity={80} style={styles.blurOverlay}>
          {message.thumbnailUri ? (
            <Image
              source={{ uri: message.thumbnailUri }}
              style={styles.thumbnailBg}
              blurRadius={20}
            />
          ) : null}
          <View style={styles.downloadButton}>
            <MaterialIcons name="download" size={28} color="white" />
          </View>
          <Text style={styles.downloadText}>
            {media.type === 'image' ? '📷 Photo' : media.type === 'video' ? '🎬 Video' : '📎 File'}
          </Text>
          {message.fileSize && (
            <Text style={styles.fileSizeText}>{formatBytes(message.fileSize)}</Text>
          )}
        </BlurView>
      </Pressable>
    );
  };

  if (!media) return null;

  return (
    <View style={[styles.container, isOwn ? styles.ownMedia : styles.theirMedia]}>
      {renderContent()}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    overflow: 'hidden',
    marginVertical: 4,
  },
  ownMedia: {
    alignSelf: 'flex-end',
  },
  theirMedia: {
    alignSelf: 'flex-start',
  },
  media: {
    borderRadius: 16,
  },
  videoContainer: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  videoThumbnail: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  fileContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16,
    gap: 12,
  },
  fileName: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
  },
  placeholder: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  blurOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  thumbnailBg: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.5,
  },
  downloadButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,122,255,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  downloadText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  fileSizeText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    marginTop: 4,
  },
  downloadingText: {
    color: '#FFFFFF',
    fontSize: 14,
    marginTop: 12,
  },
  errorText: {
    color: '#FF3B30',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  retryText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    marginTop: 4,
  },
  caption: {
    color: '#FFFFFF',
    fontSize: 14,
    padding: 8,
    paddingTop: 4,
  },
});

export default MediaBubble;
