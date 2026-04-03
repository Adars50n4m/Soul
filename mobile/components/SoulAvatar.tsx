import React, { useState, useEffect } from 'react';
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
  allowExperimentalSharedTransition?: boolean;
  isOnline?: boolean;
}

/**
 * SoulAvatar Component - WhatsApp Style
 * Shows user photo if available, otherwise shows default person icon.
 * Includes optional premium online indicator.
 */
export const SoulAvatar: React.FC<SoulAvatarProps> = ({
  uri,
  localUri,
  size = 50,
  style,
  iconSize,
  avatarType = 'default',
  teddyVariant,
  sharedTransitionTag,
  sharedTransitionStyle,
  allowExperimentalSharedTransition = false,
  isOnline = false
}) => {
  const { activeTheme } = useApp();
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [uri, localUri]);

  const sharedProps = (sharedTransitionTag && (SUPPORT_SHARED_TRANSITIONS || allowExperimentalSharedTransition))
    ? {
        sharedTransitionTag,
        sharedTransitionStyle,
      }
    : {};

  const proxiedUri = proxySupabaseUrl(uri);
  // Initial source choice
  const [currentSource, setCurrentSource] = useState<string | undefined>(localUri || proxiedUri);
  const [hasFallbackToRemote, setHasFallbackToRemote] = useState(false);

  useEffect(() => {
    setCurrentSource(localUri || proxiedUri);
    setHasFallbackToRemote(false);
    setError(false);
  }, [uri, localUri, proxiedUri]);

  const handleImageError = () => {
    if (localUri && currentSource === localUri && proxiedUri && !hasFallbackToRemote) {
      // Local failed, try remote once
      console.log(`[SoulAvatar] Local URI failed: ${localUri}. Falling back to remote.`);
      setCurrentSource(proxiedUri);
      setHasFallbackToRemote(true);
    } else {
      setError(true);
    }
  };

  const hasAvatar = !!currentSource && currentSource !== '' && !error;

  const renderAvatar = () => {
    // Handling Teddy/Memoji types
    if (avatarType === 'teddy' || avatarType === 'memoji') {
        const fallbackId = uri || 'default';
        const avatarUrl = avatarType === 'teddy'
            ? `https://avatar.iran.liara.run/public/boy?username=${fallbackId}`
            : `https://avatar.iran.liara.run/public/girl?username=${fallbackId}`;

        return (
            <Image
                source={{ uri: avatarUrl }}
                style={{ width: size, height: size, borderRadius: size / 2 }}
                contentFit="contain"
            />
        );
    }

    // Show user photo if available
    if (hasAvatar) {
      if (sharedTransitionTag) {
        return (
          <Animated.Image
            source={{ uri: currentSource }}
            {...sharedProps}
            style={{ width: size, height: size, borderRadius: size / 2 }}
            resizeMode="cover"
            onError={handleImageError}
          />
        );
      }

      return (
        <Image
          source={{ uri: currentSource }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
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
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: '#262626',
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.15)',
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
    <View style={[{ width: size, height: size }, style]}>
      {renderAvatar()}
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
};
