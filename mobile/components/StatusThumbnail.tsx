import React, { useState, useEffect } from 'react';
import { View, StyleSheet, ActivityIndicator, ImageStyle, StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';
import { getInfoAsync } from 'expo-file-system';
import { statusService } from '../services/StatusService';

interface StatusThumbnailProps {
  statusId: string;
  mediaKey?: string;
  uriHint?: string;
  mediaType: 'image' | 'video';
  style?: StyleProp<ViewStyle | ImageStyle>;
  containerStyle?: any;
  blurRadius?: number;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'center';
}

/**
 * StatusThumbnail — Asynchronously resolves and displays a status image or video frame.
 * Handles R2 URL signing and local cache lookups automatically.
 */
export const StatusThumbnail: React.FC<StatusThumbnailProps> = ({
  statusId,
  mediaKey,
  uriHint,
  mediaType,
  style,
  containerStyle,
  blurRadius = 0,
  resizeMode = 'cover'
}) => {
  const [uri, setUri] = useState<string | null>(null);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const resolveMedia = async () => {
      try {
        setLoading(true);

        if (uriHint) {
          if (uriHint.startsWith('http://') || uriHint.startsWith('https://') || uriHint.startsWith('content://')) {
            if (isMounted) setUri(uriHint);
            return;
          }

          if (uriHint.startsWith('file://')) {
            const info = await getInfoAsync(uriHint);
            if (info.exists) {
              if (isMounted) setUri(uriHint);
              return;
            }
          }
        }

        const source = await statusService.getMediaSource(statusId, mediaKey || uriHint);
        if (isMounted && source) {
          console.log(`[StatusThumbnail] Resolved URI for ${statusId}: ${source.uri}`);
          setUri(source.uri);
        }
      } catch (error) {
        console.warn(`[StatusThumbnail] Failed to resolve media for ${statusId}:`, error);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    resolveMedia();

    return () => { isMounted = false; };
  }, [statusId, mediaKey, uriHint]);

  useEffect(() => {
    let isMounted = true;

    const buildVideoThumbnail = async () => {
      if (mediaType !== 'video' || !uri) {
        if (isMounted) setThumbnailUri(null);
        return;
      }

      try {
        const VideoThumbnails = require('expo-video-thumbnails');
        if (!VideoThumbnails?.getThumbnailAsync) {
          if (isMounted) setThumbnailUri(null);
          return;
        }

        const result = await VideoThumbnails.getThumbnailAsync(uri, { time: 1000 });
        if (isMounted) {
          setThumbnailUri(result?.uri || null);
        }
      } catch (error) {
        console.warn(`[StatusThumbnail] Failed to build video thumbnail for ${statusId}:`, error);
        if (isMounted) setThumbnailUri(null);
      }
    };

    void buildVideoThumbnail();

    return () => { isMounted = false; };
  }, [mediaType, statusId, uri]);

  const displayUri = mediaType === 'video' ? thumbnailUri : uri;

  return (
    <View style={[styles.container, style as any, containerStyle]}>
      {displayUri ? (
        <Image
          source={{ uri: displayUri }}
          style={styles.image}
          contentFit={resizeMode as any}
          transition={200}
        />
      ) : !loading && (
        <View style={styles.fallback}>
          <MaterialIcons 
            name="image-not-supported" 
            size={24} 
            color="rgba(255,255,255,0.2)" 
          />
        </View>
      )}
      
      {loading && (
        <View style={styles.loader}>
          <ActivityIndicator size="small" color="rgba(255,255,255,0.4)" />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  fallback: {
    width: '100%',
    height: '100%',
    backgroundColor: '#121212',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
});
