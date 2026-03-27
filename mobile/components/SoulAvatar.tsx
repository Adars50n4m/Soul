import React, { useState, useEffect } from 'react';
import Animated, { SharedTransition, withSpring } from 'react-native-reanimated';
import { View, StyleSheet, Platform } from 'react-native';
import { Image } from 'expo-image';
import { MaterialIcons } from '@expo/vector-icons';


interface SoulAvatarProps {
  uri?: string;
  size?: number;
  style?: any;
  iconSize?: number;
  avatarType?: 'default' | 'teddy' | 'custom';
  teddyVariant?: 'boy' | 'girl';
  sharedTransitionTag?: string;
  sharedTransitionStyle?: any;
}

/**
 * SoulAvatar Component - WhatsApp Style
 * Shows user photo if available, otherwise shows default person icon
 */
export const SoulAvatar: React.FC<SoulAvatarProps> = ({
  uri,
  size = 50,
  style,
  iconSize,
  avatarType = 'default',
  teddyVariant,
  sharedTransitionTag,
  sharedTransitionStyle
}) => {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [uri]);

  const hasAvatar = !!uri && uri !== '' && !error;
  const imageStyle = [{ width: size, height: size, borderRadius: size / 2 }, style];

  const sharedProps = sharedTransitionTag
    ? {
        sharedTransitionTag,
        sharedTransitionStyle,
      }
    : {};

  // Teddy and other non-standard avatar fallbacks are now handled by the default person icon below
  // to ensure visual consistency across the app.

  // Show user photo if available
  if (hasAvatar) {
    if (sharedTransitionTag) {
      return (
        <Animated.Image
          source={{ uri }}
          {...sharedProps}
          style={imageStyle}
          resizeMode="cover"
          onError={() => setError(true)}
        />
      );
    }

    return (
      <Image
        source={{ uri }}
        style={imageStyle}
        contentFit="cover"
        transition={200}
        onError={() => setError(true)}
      />
    );
  }

  // Default: WhatsApp-style person icon placeholder
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: '#1C1C1E',
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.1)',
        },
        style,
      ]}
    >
      <MaterialIcons
        name="person"
        size={iconSize || size * 0.75}
        color="rgba(255,255,255,0.4)"
      />
    </View>
  );
};
