import React, { useEffect } from 'react';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { View, Pressable, StyleSheet, useWindowDimensions, Platform } from 'react-native';
import GlassView from '../../components/ui/GlassView';
import { Ionicons } from '@expo/vector-icons';
import { hapticService } from '../../services/HapticService';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { useApp } from '../../context/AppContext';
import { ScrollMotionProvider, useScrollMotion } from '../../components/navigation/ScrollMotionProvider';

export const unstable_settings = {
  initialRouteName: 'index',
};

let hasRenderedTabBarOnce = false;

const TabIcon = ({ name, focused, size = 26 }: { name: string; focused: boolean; size?: number }) => {
  const { activeTheme } = useApp();
  const scale = useSharedValue(1);

  useEffect(() => {
    // Premium spring pop animation
    if (focused) {
      scale.value = withSequence(
        withSpring(1.25, { damping: 10, stiffness: 200 }),
        withSpring(1.15, { damping: 12, stiffness: 150 })
      );
    } else {
      scale.value = withSpring(1, { damping: 15 });
    }
  }, [focused, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: withTiming(focused ? 1 : 0.7, { duration: 200 }),
  }));

  // WhatsApp-style: Use filled version when focused, outline when not
  const iconName = focused ? (name as any) : (`${name}-outline` as any);

  return (
    <Animated.View style={animatedStyle}>
      <Ionicons
        name={iconName}
        size={size}
        color={focused ? activeTheme.primary : '#8E8E93'}
      />
    </Animated.View>
  );
};

const TabBar = ({ state, descriptors, navigation }: any) => {
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
  const TAB_BAR_WIDTH = SCREEN_WIDTH - 32;
  const SEARCH_BUTTON_SIZE = 56;
  const ACTIONS_GAP = 10;
  const { activeTheme } = useApp();
  const router = useRouter();
  const pathname = usePathname();

  const numTabs = state?.routes?.length || 3;
  const navBarWidth = TAB_BAR_WIDTH - SEARCH_BUTTON_SIZE - ACTIONS_GAP;
  const tabWidth = (navBarWidth - 24) / numTabs;
  const currentIndex = state?.index ?? 0;
  const searchFocused = pathname === '/search';

  const focusedTabName = state?.routes?.[currentIndex]?.name;
  const searchContext: 'chats' | 'calls' | 'settings' =
    focusedTabName === 'calls' ? 'calls' : focusedTabName === 'settings' ? 'settings' : 'chats';

  const isFirstIndicatorSync = React.useRef(true);
  const translateX = useSharedValue(currentIndex * tabWidth);
  const glowProgress = useSharedValue(0);
  const tabBarOpacity = useSharedValue(hasRenderedTabBarOnce ? 0 : 1);

  // Pill position + glow flash
  useEffect(() => {
    if (isFirstIndicatorSync.current) {
      isFirstIndicatorSync.current = false;
      translateX.value = currentIndex * tabWidth;
      return;
    }
    // Flash glow during shift, fade back
    glowProgress.value = withTiming(1, { duration: 150 }, () => {
      glowProgress.value = withTiming(0, { duration: 600 });
    });
    translateX.value = withSpring(currentIndex * tabWidth, {
      damping: 18,
      stiffness: 120,
      mass: 0.8,
    });
  }, [currentIndex, glowProgress, tabWidth, translateX]);

  useEffect(() => {
    if (!hasRenderedTabBarOnce) {
      hasRenderedTabBarOnce = true;
      tabBarOpacity.value = 1;
      return;
    }
    tabBarOpacity.value = withDelay(
      60,
      withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) })
    );
  }, [tabBarOpacity]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  }));

  // Glow blob — always visible, locked to pill position
  // offset centers the wider glow on the pill: (tabWidth - glowWidth) / 2
  // iOS glowWidth = tabWidth * 4.5 → offset = -tabWidth * 1.75
  // Android glowWidth = tabWidth * 1.5 → offset = -tabWidth * 0.25
  const glowStyle = useAnimatedStyle(() => {
    'worklet';
    const offset = -tabWidth * 0.25; // Standardized offset for width=tabWidth*1.5
    return {
      transform: [
        { translateX: translateX.value + offset } as const,
      ] as const,
      opacity: glowProgress.value,
    };
  });

  const tabBarFadeStyle = useAnimatedStyle(() => ({
    opacity: tabBarOpacity.value,
  }));

  const searchScale = useSharedValue(1);

  useEffect(() => {
    if (searchFocused) {
      searchScale.value = withSequence(
        withSpring(1.16, { damping: 10, stiffness: 220 }),
        withSpring(1.08, { damping: 12, stiffness: 160 })
      );
    } else {
      searchScale.value = withSpring(1, { damping: 15, stiffness: 180 });
    }
  }, [searchFocused, searchScale]);

  const focusedRoute = state?.routes?.[state.index];
  const focusedOptions = focusedRoute ? descriptors?.[focusedRoute.key]?.options : undefined;
  const focusedRouteId = focusedRoute?.name || 'index';

  const { hidden: isTabBarHidden } = useScrollMotion(focusedRouteId);
  const translateY = useSharedValue(0);

  useEffect(() => {
    translateY.value = withSpring(isTabBarHidden ? 150 : 0, {
      damping: 20,
      stiffness: 160,
      mass: 0.8,
    });
  }, [isTabBarHidden, translateY]);

  const dropDownStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const searchFabStyle = useAnimatedStyle(() => ({
    width: '100%',
    height: '100%',
    transform: [{ scale: searchScale.value }],
  }));

  const searchSourceX = SCREEN_WIDTH - 72;
  const searchSourceY = SCREEN_HEIGHT - 90;

  if (!state || !state.routes || state.routes.length === 0 || !descriptors || !focusedRoute) {
    return null;
  }

  if (focusedOptions?.tabBarStyle?.display === 'none') {
    return null;
  }

  return (
    <Animated.View style={[styles.tabBarContainer, tabBarFadeStyle, dropDownStyle]}>
      <View style={styles.bottomActionsRow}>
        <View style={[styles.tabBarGlassContainer, { width: navBarWidth }]}>
          <GlassView intensity={35} tint="dark" style={StyleSheet.absoluteFillObject} />

          {/* Standardized Glow blob — Unified shadow-based bloom for both platforms */}
          <Animated.View
            style={[
              styles.glowBlob,
              { 
                width: tabWidth * 1.5, 
                borderRadius: 30, 
                shadowColor: activeTheme.primary,
                shadowOpacity: Platform.OS === 'ios' ? 0.9 : 1,
                shadowRadius: Platform.OS === 'ios' ? 25 : 30,
              },
              glowStyle,
            ]}
            pointerEvents="none"
          />

          {/* Indicator pill */}
          <Animated.View style={[styles.indicatorPill, { width: tabWidth }, indicatorStyle]} />

          <View style={styles.tabBarInner}>
            {state.routes.map((route: any, index: number) => {
              const isFocused = state.index === index;

              const onPress = () => {
                hapticService.impact(Haptics.ImpactFeedbackStyle.Light);
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!isFocused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              };

              let iconName: string = 'home';
              if (route.name === 'index') iconName = 'chatbubble-ellipses';
              if (route.name === 'calls') iconName = 'call';
              if (route.name === 'settings') iconName = 'settings';

              return (
                <Pressable key={route.key} onPress={onPress} style={styles.tabButton}>
                  <TabIcon name={iconName} focused={isFocused} />
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable
          onPress={() => {
            hapticService.impact(Haptics.ImpactFeedbackStyle.Light);
            router.push(`/search?context=${searchContext}&sourceX=${searchSourceX}&sourceY=${searchSourceY}&sourceW=${SEARCH_BUTTON_SIZE}&sourceH=${SEARCH_BUTTON_SIZE}`);
          }}
          style={[styles.searchFabPressable, { width: SEARCH_BUTTON_SIZE, height: SEARCH_BUTTON_SIZE, borderRadius: SEARCH_BUTTON_SIZE / 2 }]}
        >
          <Animated.View style={searchFabStyle}>
          <View style={[
            styles.searchFabShell,
            searchFocused && styles.searchFabShellActive,
          ]}>
            <GlassView intensity={40} tint="dark" style={StyleSheet.absoluteFillObject} />
            <Ionicons name="search" size={18} color={searchFocused ? activeTheme.primary : '#8E8E93'} />
          </View>
          </Animated.View>
        </Pressable>
      </View>
    </Animated.View>
  );
};

export default function TabLayout() {
  return (
    <ScrollMotionProvider>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{ headerShown: false }}
        initialRouteName="index"
        backBehavior="initialRoute"
      >
        <Tabs.Screen name="index" options={{ title: 'Chats' }} />
        <Tabs.Screen name="calls" options={{ title: 'Calls' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </ScrollMotionProvider>
  );
}

const styles = StyleSheet.create({
  tabBarContainer: {
    position: 'absolute',
    bottom: 34,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  bottomActionsRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  tabBarGlassContainer: {
    borderRadius: 40,
    overflow: 'hidden',
    borderWidth: Platform.OS === 'android' ? 1 : 1.2,
    borderColor: Platform.OS === 'android' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.22)',
    backgroundColor: Platform.OS === 'android' ? '#0A0A0A' : 'transparent',
  },
  glowBlob: {
    position: 'absolute',
    top: 8,
    height: 48,
    left: 12,
    backgroundColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 30,
    elevation: 20,
  },
  tabBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    height: 64,
  },
  indicatorPill: {
    position: 'absolute',
    top: 8,
    left: 12,
    height: 48,
    borderRadius: 24,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  searchFabPressable: {
    overflow: 'hidden',
  },
  searchFabShell: {
    flex: 1,
    overflow: 'hidden',
    borderRadius: 999,
    borderWidth: Platform.OS === 'android' ? 1 : 1.2,
    borderColor: Platform.OS === 'android' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.22)',
    backgroundColor: Platform.OS === 'android' ? '#0A0A0A' : 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchFabShellActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.07)',
  },
});
