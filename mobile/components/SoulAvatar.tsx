import React, { useState, useEffect, forwardRef } from 'react';
import Animated from 'react-native-reanimated';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';
import { proxySupabaseUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { SUPPORT_SHARED_TRANSITIONS } from '../constants/sharedTransitions';


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

  useEffect(() => {
    setError(false);
  }, [uri, localUri]);

  const sharedProps = (sharedTransitionTag)
    ? {
        sharedTransitionTag,
        sharedTransitionStyle,
        sharedTransition,
      }
    : {};

  const proxiedUri = proxySupabaseUrl(uri);
  const [currentSource, setCurrentSource] = useState<string | undefined>(localUri || proxiedUri);
  const [hasFallbackToRemote, setHasFallbackToRemote] = useState(false);
  const [hasFallbackToDirect, setHasFallbackToDirect] = useState(false);
  const [hasFallbackToGlobalProxy, setHasFallbackToGlobalProxy] = useState(false);

  useEffect(() => {
    setCurrentSource(localUri || proxiedUri);
    setHasFallbackToRemote(false);
    setHasFallbackToDirect(false);
    setHasFallbackToGlobalProxy(false);
    setError(false);
  }, [uri, localUri, proxiedUri]);

  const avatarShellStyle = {
    width: size,
    height: size,
    borderRadius: Math.floor(size / 2), // Absolute circle for SharedTransition target
    overflow: 'hidden' as const,
    backgroundColor: '#262626',
  };

  const handleImageError = () => {
    if (localUri && currentSource === localUri && proxiedUri && !hasFallbackToRemote) {
      // 1. Local failed, try proxied remote
      console.log(`[SoulAvatar] Local URI failed: ${localUri}. Trying proxy: ${proxiedUri}`);
      setCurrentSource(proxiedUri);
      setHasFallbackToRemote(true);
    } else if (currentSource === proxiedUri && uri && proxiedUri !== uri && !hasFallbackToDirect) {
      // 2. Proxied failed, try direct Supabase URL
      console.log(`[SoulAvatar] Proxy failed: ${proxiedUri}. Trying direct: ${uri}`);
      setCurrentSource(uri);
      setHasFallbackToDirect(true);
    } else if (currentSource === uri && uri && uri.startsWith('http') && !hasFallbackToGlobalProxy) {
      // 3. Direct failed, try Glogal Image Proxy (Weserv)
      // wsrv.nl is a high-reputation CDN proxy that often bypasses carrier blocks
      const globalProxyUrl = `https://wsrv.nl/?url=${encodeURIComponent(uri)}&default=${encodeURIComponent(uri)}`;
      console.log(`[SoulAvatar] Direct failed: ${uri}. Trying global proxy: ${globalProxyUrl}`);
      setCurrentSource(globalProxyUrl);
      setHasFallbackToGlobalProxy(true);
    } else {
      // 4. All attempts failed
      console.warn(`[SoulAvatar] All image sources failed for URI: ${uri}`);
      setError(true);
    }
  };

  const hasAvatar = !!currentSource && currentSource !== '' && !error;

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

        const fallbackId = uri || 'default';
        const avatarUrl = variant === 'boy'
            ? `https://avatar.iran.liara.run/public/boy?username=${fallbackId}`
            : `https://avatar.iran.liara.run/public/girl?username=${fallbackId}`;

        return (
            <Image
                source={{ uri: avatarUrl }}
                style={{ width: '100%', height: '100%' }}
                contentFit="cover"
                onError={() => setError(true)}
            />
        );
    }

    // Show user photo if available
    if (hasAvatar) {
      return (
        <Image
          source={{ uri: currentSource }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          onError={handleImageError}
        />
      );
    }

    // Default: WhatsApp-style person icon placeholder
    return (
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
