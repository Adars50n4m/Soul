import React, { useState, useEffect } from 'react';
import { View, Image, StyleSheet, ActivityIndicator, ImageStyle, StyleProp, ViewStyle } from 'react-native';
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const resolveMedia = async () => {
      try {
        setLoading(true);

        if (uriHint) {
          if (
            uriHint.startsWith('http://') ||
            uriHint.startsWith('https://') ||
            uriHint.startsWith('file://') ||
            uriHint.startsWith('content://')
          ) {
            if (isMounted) setUri(uriHint);
            return;
          }
        }

        const source = await statusService.getMediaSource(statusId, mediaKey || uriHint);
        if (isMounted && source) {
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

  return (
    <View style={[styles.container, style as any, containerStyle]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={styles.image}
          blurRadius={blurRadius}
          resizeMode={resizeMode}
        />
      ) : !loading && (
        <View style={styles.fallback}>
          {/* Subtle dark placeholder if everything fails */}
          <View style={StyleSheet.absoluteFill} />
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
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
});
