import React, { useState, useEffect, useRef, useMemo, forwardRef } from 'react';
import Animated from 'react-native-reanimated';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { SUPPORT_SHARED_TRANSITIONS } from '../constants/sharedTransitions';
import {
  normalizeAvatarSource,
  proxyAvatarRemoteUri,
  resolveAvatarImageUri,
  markAvatarSourceWarm,
  isAvatarSourceWarm,
  warmAvatarSource,
} from '../utils/avatarSource';


interface SoulAvatarProps {
  uri?: string;
  localUri?: string;
  size?: number;
  style?: any;
  iconSize?: number;
  avatarType?: 'default' | 'teddy' | 'memoji' | 'custom';
  teddyVariant?: 'boy' | 'girl';
  sharedTransitionTag?: string;
  sharedTransitionStyle?: any;
  sharedTransition?: any; // Reanimated 3 SharedTransition
  allowExperimentalSharedTransition?: boolean;
  isOnline?: boolean;
}

/**
 * SoulAvatar Component - WhatsApp Style
 * Shows user photo if available, otherwise shows default person icon.
 * Includes optional premium online indicator.
 */
export const SoulAvatar = forwardRef<View, SoulAvatarProps>(({
  uri,
  localUri,
  size = 50,
  style,
  iconSize,
  avatarType = 'default',
  teddyVariant,
  sharedTransitionTag,
  sharedTransitionStyle,
  sharedTransition,
  allowExperimentalSharedTransition = false,
  isOnline = false
}, ref) => {
  const { activeTheme } = useApp();
  const [error, setError] = useState(false);
  const normalizedLocalUri = normalizeAvatarSource(localUri);
  const normalizedUri = normalizeAvatarSource(uri);
  const lastSuccessfulSourceRef = useRef<string | undefined>(undefined);

  const sharedProps = (sharedTransitionTag)
    ? {
        sharedTransitionTag,
        sharedTransitionStyle,
        sharedTransition,
      }
    : {};

  const proxiedUri = useMemo(() => {
    if (!normalizedUri) return undefined;
    return proxyAvatarRemoteUri(normalizedUri) || normalizedUri;
  }, [normalizedUri]);
  const preferredSource = normalizedLocalUri || proxiedUri || normalizedUri || undefined;
  const [currentSource, setCurrentSource] = useState<string | undefined>(preferredSource);
  const [imageLoaded, setImageLoaded] = useState(
    Boolean(preferredSource && isAvatarSourceWarm(preferredSource))
  );
  const [hasFallbackToRemote, setHasFallbackToRemote] = useState(false);
  const [hasFallbackToDirect, setHasFallbackToDirect] = useState(false);
  const [hasFallbackToGlobalProxy, setHasFallbackToGlobalProxy] = useState(false);

  useEffect(() => {
    if (preferredSource) {
      setCurrentSource(preferredSource);
      setImageLoaded(isAvatarSourceWarm(preferredSource));
    } else if (!preferredSource && lastSuccessfulSourceRef.current) {
      setCurrentSource(lastSuccessfulSourceRef.current);
      setImageLoaded(isAvatarSourceWarm(lastSuccessfulSourceRef.current));
    }

    setHasFallbackToRemote(false);
    setHasFallbackToDirect(false);
    setHasFallbackToGlobalProxy(false);
    setError(false);
  }, [preferredSource]);

  useEffect(() => {
    if (!preferredSource || !preferredSource.startsWith('http')) return;
    void warmAvatarSource(preferredSource);
  }, [preferredSource]);

  const avatarShellStyle = {
    width: size,
    height: size,
    borderRadius: Math.floor(size / 2), // Absolute circle for SharedTransition target
    overflow: 'hidden' as const,
    backgroundColor: '#262626',
  };

  const handleImageError = () => {
    setImageLoaded(false);
    if (normalizedLocalUri && currentSource === normalizedLocalUri && proxiedUri && !hasFallbackToRemote) {
      // 1. Local failed, try proxied remote
      console.log(`[SoulAvatar] Local URI failed: ${normalizedLocalUri}. Trying proxy: ${proxiedUri}`);
      setCurrentSource(proxiedUri);
      setImageLoaded(isAvatarSourceWarm(proxiedUri));
      setHasFallbackToRemote(true);
    } else if (currentSource === proxiedUri && normalizedUri && proxiedUri !== normalizedUri && !hasFallbackToDirect) {
      // 2. Proxied failed, try direct Supabase URL
      console.log(`[SoulAvatar] Proxy failed: ${proxiedUri}. Trying direct: ${normalizedUri}`);
      setCurrentSource(normalizedUri);
      setImageLoaded(isAvatarSourceWarm(normalizedUri));
      setHasFallbackToDirect(true);
    } else if (currentSource === normalizedUri && normalizedUri && normalizedUri.startsWith('http') && !hasFallbackToGlobalProxy) {
      // 3. Direct failed, try Glogal Image Proxy (Weserv)
      // wsrv.nl is a high-reputation CDN proxy that often bypasses carrier blocks
      const globalProxyUrl = `https://wsrv.nl/?url=${encodeURIComponent(normalizedUri)}&default=${encodeURIComponent(normalizedUri)}`;
      console.log(`[SoulAvatar] Direct failed: ${normalizedUri}. Trying global proxy: ${globalProxyUrl}`);
      setCurrentSource(globalProxyUrl);
      setImageLoaded(isAvatarSourceWarm(globalProxyUrl));
      setHasFallbackToGlobalProxy(true);
    } else {
      // 4. All attempts failed
      console.warn(`[SoulAvatar] All image sources failed for URI: ${normalizedUri}`);
      setError(true);
    }
  };

  const hasAvatar = !!currentSource && currentSource !== '' && !error;
  const placeholderContent = (
    <View
      style={{
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <MaterialIcons
        name="person"
        size={iconSize || size * 0.7}
        color="rgba(255,255,255,0.7)"
      />
    </View>
  );

  const renderAvatarContent = () => {
    // Handling Teddy/Memoji types
    if ((avatarType === 'teddy' || avatarType === 'memoji') && !error) {
        // IMPROVED: Use variant if provided, or derive from name/uri
        let variant = teddyVariant;
        
        if (!variant) {
          // If no variant provided, check the uri/fallbackId for hints
          const nameHint = (uri || '').toLowerCase();
          if (nameHint.includes('shri')) variant = 'girl';
          else if (nameHint.includes('hari')) variant = 'boy';
          else variant = avatarType === 'teddy' ? 'boy' : 'girl'; // legacy defaults
        }

        const avatarUrl = resolveAvatarImageUri({
          uri,
          avatarType,
          teddyVariant: variant,
          fallbackId: uri || 'default',
        });

        return (
            <>
              {!imageLoaded && placeholderContent}
              <Image
                  source={{ uri: avatarUrl }}
                  style={{ width: '100%', height: '100%', position: 'absolute', opacity: imageLoaded ? 1 : 0 }}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={0}
                  onLoad={() => {
                    markAvatarSourceWarm(avatarUrl);
                    lastSuccessfulSourceRef.current = avatarUrl;
                    setImageLoaded(true);
                  }}
                  onDisplay={() => {
                    markAvatarSourceWarm(avatarUrl);
                    lastSuccessfulSourceRef.current = avatarUrl;
                    setImageLoaded(true);
                  }}
                  onError={() => setError(true)}
              />
            </>
        );
    }

    // Show user photo if available
    if (hasAvatar) {
      return (
        <>
          {!imageLoaded && placeholderContent}
          <Image
            source={{ uri: currentSource }}
            style={{ width: '100%', height: '100%', position: 'absolute', opacity: imageLoaded ? 1 : 0 }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={0}
            onLoad={() => {
              markAvatarSourceWarm(currentSource);
              lastSuccessfulSourceRef.current = currentSource;
              setImageLoaded(true);
            }}
            onDisplay={() => {
              markAvatarSourceWarm(currentSource);
              lastSuccessfulSourceRef.current = currentSource;
              setImageLoaded(true);
            }}
            onError={handleImageError}
          />
        </>
      );
    }

    // Default: WhatsApp-style person icon placeholder
    return placeholderContent;
  };

  return (
    <View ref={ref} collapsable={false} style={[{ width: size, height: size, borderRadius: size / 2 }, style]}>
      <Animated.View
        collapsable={false}
        {...sharedProps}
        style={avatarShellStyle}
      >
        {renderAvatarContent()}
      </Animated.View>
      {isOnline && (
        <View 
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: Math.max(10, size * 0.25),
            height: Math.max(10, size * 0.25),
            borderRadius: size * 0.125,
            backgroundColor: activeTheme.primary,
            borderWidth: 2,
            borderColor: '#000',
            zIndex: 10,
          }}
        />
      )}
    </View>
  );
});
