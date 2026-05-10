import React, { useEffect } from 'react';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { View, StyleSheet, useWindowDimensions, Platform, Pressable } from 'react-native';
import GlassView, { GlassPressable } from '../../components/ui/GlassView';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { hapticService } from '../../services/HapticService';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  withSequence,
  cancelAnimation,
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
  const opacity = useSharedValue(focused ? 1 : 0.7);

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
    opacity.value = withTiming(focused ? 1 : 0.7, { duration: 200 });
  }, [focused, scale, opacity]);

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
    };
  });

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

const SEARCH_BUTTON_SIZE_CONST = 56;

const ProgressiveBlur = ({ style }: { style?: any }) => {
  return (
    <Animated.View 
      pointerEvents="none" 
      style={[styles.progressiveBlurContainer, style]}
    >
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={
          <LinearGradient
            colors={['transparent', 'black', 'black']}
            locations={[0, 0.5, 1]}
            style={StyleSheet.absoluteFill}
          />
        }
      >
        <BlurView intensity={25} tint="dark" style={StyleSheet.absoluteFill} />
      </MaskedView>
    </Animated.View>
  );
};

const SearchFab = ({
  searchFocused,
  searchFabStyle,
  onPress,
  activeTheme,
}: {
  searchFocused: boolean;
  searchFabStyle: any;
  onPress: () => void;
  activeTheme: any;
}) => {
  return (
    <GlassPressable
      onPress={onPress}
      glassIntensity={40}
      glassTint="dark"
      glowIntensity={0.55}
      glowColor={activeTheme?.primary || '#ffffff'}
      style={[
        styles.searchFabPressable,
        {
          width: SEARCH_BUTTON_SIZE_CONST,
          height: SEARCH_BUTTON_SIZE_CONST,
          borderRadius: SEARCH_BUTTON_SIZE_CONST / 2,
        },
      ]}
    >
      <Animated.View style={searchFabStyle}>
        <View style={[styles.searchFabShell, searchFocused && styles.searchFabShellActive]}>
          <Ionicons
            name="search"
            size={18}
            color={searchFocused ? activeTheme.primary : '#8E8E93'}
          />
        </View>
      </Animated.View>
    </GlassPressable>
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
  const pressHandledRef = React.useRef(false);
  const translateX = useSharedValue(currentIndex * tabWidth);
  const glowProgress = useSharedValue(0);
  const tabBarOpacity = useSharedValue(hasRenderedTabBarOnce ? 0 : 1);
  // 150 > (tabBarInner height 64 + bottom 34 + margin) = fully off-screen on all devices
  const entranceY = useSharedValue(hasRenderedTabBarOnce ? 150 : 0);
  // null = first render (no animation), true/false = was previously hidden/visible
  const prevHiddenRef = React.useRef<boolean | null>(null);

  // Pill position + glow flash — fallback for programmatic navigation.
  // Direct press is handled in onPress for zero-latency response.
  useEffect(() => {
    if (isFirstIndicatorSync.current) {
      isFirstIndicatorSync.current = false;
      translateX.value = currentIndex * tabWidth;
      return;
    }
    if (pressHandledRef.current) {
      pressHandledRef.current = false;
      return;
    }
    glowProgress.value = withTiming(1, { duration: 100 }, () => {
      glowProgress.value = withTiming(0, { duration: 400 });
    });
    translateX.value = withSpring(currentIndex * tabWidth, {
      damping: 20,
      stiffness: 320,
      mass: 0.7,
    });
  }, [currentIndex, glowProgress, tabWidth, translateX]);

  useEffect(() => {
    if (!hasRenderedTabBarOnce) {
      hasRenderedTabBarOnce = true;
      return;
    }
    // iOS: component unmounts on navigation, so this runs on remount
    entranceY.value = withSpring(0, { damping: 22, stiffness: 200, mass: 0.8 });
    tabBarOpacity.value = withDelay(
      30,
      withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) })
    );
  }, [tabBarOpacity, entranceY]);

  // Android: component stays mounted and returns null — detect hidden→visible via pathname.
  // withDelay(16) on Reanimated is unreliable on Android for repeated navigations —
  // Reanimated's animation state machine gets confused after the first run.
  // requestAnimationFrame is processed after React commits the native frame, giving the
  // Animated.View one real frame at (y=150, opacity=0) before the spring fires.
  useEffect(() => {
    const cp = pathname.toLowerCase();
    const tr = ['/', '/calls', '/settings', '/(tabs)', '/(tabs)/index', '/(tabs)/calls', '/(tabs)/settings'];
    const isNowHidden = !tr.some(r => cp === r || cp === r.replace('/(tabs)', '')) || cp.includes('/chat/');
    const wasHidden = prevHiddenRef.current;
    prevHiddenRef.current = isNowHidden;

    if (wasHidden === null) return; // first render — no animation

    if (isNowHidden) {
      // Going to chat — pre-arm while tab bar is null (no visual flash)
      cancelAnimation(entranceY);
      cancelAnimation(tabBarOpacity);
      tabBarOpacity.value = 0;
      entranceY.value = 150;
    } else if (wasHidden) {
      // Returning to tabs — snap to start, then animate via rAF (reliable every time)
      cancelAnimation(entranceY);
      cancelAnimation(tabBarOpacity);
      tabBarOpacity.value = 0;
      entranceY.value = 150;
      requestAnimationFrame(() => {
        entranceY.value = withSpring(0, { damping: 22, stiffness: 200, mass: 0.8 });
        tabBarOpacity.value = withTiming(1, { duration: 250, easing: Easing.out(Easing.cubic) });
      });
    }
  }, [pathname]);

  const indicatorStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  // Glow blob — flashes only on tab tap, idle = invisible.
  // Sized to the indicator pill so the bloom takes the pill's shape.
  const glowStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [
        { translateX: translateX.value } as const,
      ] as const,
      opacity: glowProgress.value,
    };
  });

  const tabBarFadeStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: tabBarOpacity.value,
    };
  });

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

  const dropDownStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ translateY: translateY.value + entranceY.value }],
    };
  });

  const searchFabStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      width: '100%',
      height: '100%',
      transform: [{ scale: searchScale.value }],
    };
  });

  const searchSourceX = SCREEN_WIDTH - 72;
  const searchSourceY = SCREEN_HEIGHT - 90;

  if (!state || !state.routes || state.routes.length === 0 || !descriptors || !focusedRoute) {
    return null;
  }

  if (focusedOptions?.tabBarStyle?.display === 'none') {
    return null;
  }

  // STREAKED FIX: Strictly only render TabBar on base tab paths.
  // If we are in Chat or any other sub-screen, this MUST be null to prevent bleeding artifacts like the "dabba".
  const tabRoutes = ['/', '/calls', '/settings', '/(tabs)', '/(tabs)/index', '/(tabs)/calls', '/(tabs)/settings'];
  const currentPath = pathname.toLowerCase();
  const isTabRoute = tabRoutes.some(route => currentPath === route || currentPath === route.replace('/(tabs)', ''));
  
  if (!isTabRoute || currentPath.includes('/chat/')) {
    return null;
  }

  return (
    <Animated.View style={[styles.tabBarContainer, tabBarFadeStyle, dropDownStyle]}>
      <ProgressiveBlur />
      <View style={styles.bottomActionsRow}>
        <View style={[styles.tabBarGlassContainer, { width: navBarWidth }]}>
          <GlassView intensity={35} tint="dark" style={[StyleSheet.absoluteFillObject, { borderRadius: 40, overflow: 'hidden' }]} />

          {/* Indicator pill — soft iOS 26 liquid-glass tint at rest: base tint + two
              corner specular highlights. No border — keeps the idle state clean. */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicatorPill,
              {
                width: tabWidth,
                backgroundColor: `${activeTheme.primary}1F`,
                overflow: 'hidden',
              },
              indicatorStyle,
            ]}
          >
            <LinearGradient
              colors={[`${activeTheme.primary}33`, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 0.7, y: 0.7 }}
              style={StyleSheet.absoluteFill}
            />
            <LinearGradient
              colors={['transparent', `${activeTheme.primary}22`]}
              start={{ x: 0.3, y: 0.3 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>

          {/* Tap flash — colored fill + red edge appears only on tap, fades back. */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicatorPill,
              {
                width: tabWidth,
                backgroundColor: `${activeTheme.primary}66`,
                borderColor: `${activeTheme.primary}99`,
                borderWidth: 1,
              },
              glowStyle,
            ]}
          />

          <View style={styles.tabBarInner}>
            {state.routes.map((route: any, index: number) => {
              const isFocused = state.index === index;

              const onPress = () => {
                hapticService.impact(Haptics.ImpactFeedbackStyle.Light);
                if (!isFocused) {
                  // Animate immediately — don't wait for navigation re-render cycle
                  pressHandledRef.current = true;
                  glowProgress.value = withTiming(1, { duration: 100 }, () => {
                    glowProgress.value = withTiming(0, { duration: 400 });
                  });
                  translateX.value = withSpring(index * tabWidth, {
                    damping: 20,
                    stiffness: 320,
                    mass: 0.7,
                  });
                }
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
                <Pressable
                  key={route.key}
                  onPress={onPress}
                  style={({ pressed }) => [
                    styles.tabButton,
                    pressed && styles.tabButtonPressed,
                  ]}
                >
                  <TabIcon name={iconName} focused={isFocused} />
                </Pressable>
              );
            })}
          </View>
        </View>

        <SearchFab
          searchFocused={searchFocused}
          searchFabStyle={searchFabStyle}
          onPress={() => {
            hapticService.impact(Haptics.ImpactFeedbackStyle.Light);
            router.push(`/search?context=${searchContext}&sourceX=${searchSourceX}&sourceY=${searchSourceY}&sourceW=${SEARCH_BUTTON_SIZE}&sourceH=${SEARCH_BUTTON_SIZE}`);
          }}
          activeTheme={activeTheme}
        />
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
    overflow: 'hidden', // Re-enabled to contain glow within the bar
    borderWidth: Platform.OS === 'android' ? 1 : 1.2,
    borderColor: Platform.OS === 'android' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.22)',
    backgroundColor: Platform.OS === 'android' ? '#0A0A0A' : 'transparent',
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
    borderRadius: 24,
  },
  tabButtonPressed: {
    opacity: 0.82,
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
  progressiveBlurContainer: {
    position: 'absolute',
    bottom: -34, // Align with the bottom edge of the screen
    left: -16,
    right: -16,
    height: 140, // Height of the blur area
    zIndex: -1,
  },
});
