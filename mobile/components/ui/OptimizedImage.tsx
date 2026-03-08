import React, { useMemo } from 'react';
import { StyleSheet, View, ActivityIndicator } from 'react-native';
import { Image, ImageProps, ImageContentFit } from 'expo-image';

interface OptimizedImageProps extends ImageProps {
  /**
   * The BlurHash string for the image. Used as a placeholder while the image loads.
   */
  blurhash?: string;
  /**
   * Whether to show a loading indicator while the image is fetching.
   * Defaults to false.
   */
  showLoader?: boolean;
  /**
   * How the image should be fitted inside its container.
   * Defaults to 'cover'.
   */
  contentFit?: ImageContentFit;
  /**
   * Transition duration in milliseconds.
   * Defaults to 300ms.
   */
  transitionDuration?: number;
}

/**
 * OptimizedImage — A highly performant image component for React Native.
 * Equivalent to `react-ideal-image` but using native-optimized `expo-image`.
 * 
 * Features:
 * - Hardware-accelerated caching
 * - BlurHash placeholder support
 * - Fast transitions
 * - Support for diverse image formats (WebP, GIF, etc.)
 */
export const OptimizedImage = ({
  source,
  blurhash,
  showLoader = false,
  contentFit = 'cover',
  transitionDuration = 300,
  style,
  onLoad,
  onError,
  ...rest
}: OptimizedImageProps) => {
  const placeholder = useMemo(() => {
    if (blurhash) {
      return { blurhash };
    }
    return null;
  }, [blurhash]);

  return (
    <View style={[styles.container, style]}>
      <Image
        source={source}
        placeholder={placeholder}
        contentFit={contentFit}
        transition={transitionDuration}
        autoplay={true}
        onLoad={onLoad}
        onError={onError}
        style={StyleSheet.absoluteFill}
        {...rest}
      />
      {showLoader && (
        <View style={styles.loaderContainer}>
          <ActivityIndicator size="small" color="#9CA3AF" />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: '#111827', // Dark placeholder bg
    position: 'relative',
  },
  loaderContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
});

export default OptimizedImage;
