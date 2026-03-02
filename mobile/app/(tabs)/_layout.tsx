import React, { useEffect } from 'react';
import { Tabs } from 'expo-router';
import { View, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withTiming 
} from 'react-native-reanimated';
import { useApp } from '../../context/AppContext';

// Tells expo-router how to construct initial tab state during hydration
// Prevents "Cannot read property 'stale' of undefined" in TabRouter.getRehydratedState
export const unstable_settings = {
  initialRouteName: 'index',
};

const TabIcon = ({ name, focused, size = 24 }: { name: any; focused: boolean; size?: number }) => {
  const { activeTheme } = useApp();
  const scale = useSharedValue(1);

  useEffect(() => {
    scale.value = withSpring(focused ? 1.2 : 1, { damping: 15 });
  }, [focused]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }]
  }));

  return (
    <Animated.View style={animatedStyle}>
      <MaterialIcons
        name={name}
        size={size}
        color={focused ? activeTheme.primary : 'rgba(255,255,255,0.4)'}
      />
    </Animated.View>
  );
};

const TabBar = ({ state, descriptors, navigation }: any) => {
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const TAB_BAR_WIDTH = SCREEN_WIDTH - 32;
  const { activeTheme } = useApp();

  // Compute safe values for hooks (hooks must always be called)
  const numTabs = state?.routes?.length || 3;
  const tabWidth = (TAB_BAR_WIDTH - 24) / numTabs;
  const currentIndex = state?.index ?? 0;

  const translateX = useSharedValue(0);

  useEffect(() => {
    translateX.value = withSpring(currentIndex * tabWidth, {
      damping: 18,
      stiffness: 120,
      mass: 0.8
    });
  }, [currentIndex, tabWidth]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    backgroundColor: `${activeTheme.primary}1A`,
  }));

  // Guard: state may be undefined during initial navigation hydration
  if (!state || !state.routes || state.routes.length === 0 || !descriptors) {
    return null;
  }

  const focusedRoute = state.routes[state.index];
  if (!focusedRoute) return null;
  const focusedOptions = descriptors[focusedRoute.key]?.options;

  if (focusedOptions?.tabBarStyle?.display === 'none') {
    return null;
  }

  return (
    <View style={styles.tabBarContainer}>
      <View style={styles.tabBarGlassContainer}>
        {/* Layer 1: The Glass background */}
        <BlurView
          intensity={Platform.OS === 'android' ? 80 : 30}
          tint="dark"
          style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent' }]}
          experimentalBlurMethod="dimezisBlurView"
        />
        <Animated.View style={[
        StyleSheet.absoluteFill, // Keep it filling the container
        {
          width: SCREEN_WIDTH - 32, // This will be overridden by absoluteFill's left/right
          backgroundColor: Platform.OS === 'android'
            ? 'rgba(21,21,21,0.35)'
            : 'rgba(21,21,21,0.75)' }
        ]} />
        
        {/* Layer 2: The Indicator Pill (Vibrant & SOLID) */}
        <Animated.View 
          style={[
            styles.indicatorPill, 
            { width: tabWidth }, 
            indicatorStyle
          ]} 
        />

        {/* Layer 3: The Interactive Icons */}
        <View style={styles.tabBarInner}>
          {state.routes.map((route: any, index: number) => {
            const isFocused = state.index === index;

            const onPress = () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });

              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            };

            let iconName: any = 'home';
            if (route.name === 'index') iconName = 'chat-bubble';
            if (route.name === 'calls') iconName = 'call';
            if (route.name === 'settings') iconName = 'tune';

            return (
              <Pressable
                key={route.key}
                onPress={onPress}
                style={styles.tabButton}
              >
                <TabIcon name={iconName} focused={isFocused} />
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
};

export default function TabLayout() {
  return (
    <Tabs
      tabBar={props => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
      initialRouteName="index"
      backBehavior="initialRoute"
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chats',
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: 'Calls',
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBarContainer: {
    position: 'absolute',
    bottom: 34, // Slightly higher for premium feel
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  tabBarGlassContainer: {
    width: '100%',
    borderRadius: 40,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'transparent',
  },
  tabBarOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  tabBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    height: 72,
  },
  indicatorPill: {
    position: 'absolute',
    top: 10, // Perfectly centered (72 - 52) / 2
    left: 12,
    height: 52,
    borderRadius: 26,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
});
