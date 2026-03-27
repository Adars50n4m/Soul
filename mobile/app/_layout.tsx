import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useContext, Component, ReactNode, useState } from 'react';
import { View, ActivityIndicator, Platform, AppState, Text, Pressable } from 'react-native';

import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { AppContext, AppProvider } from '../context/AppContext';
import PipOverlay from '../components/PipOverlay';
import { IncomingCallModal } from '../components/IncomingCallModal';
import { SecurityLockOverlay } from '../components/SecurityLockOverlay';
import { Toaster } from '../components/ui/Toaster';
import { backgroundSyncService } from '../services/BackgroundSyncService';

// Error Boundary to catch rendering errors
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  state = { hasError: false, error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>Something went wrong</Text>
          <Text style={{ color: '#666', fontSize: 12, marginTop: 10 }}>{this.state.error?.message}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}


// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync().catch(() => {
  /* reloading the app might cause some errors here, safe to ignore */
});

// Ensures expo-router constructs valid initial state during hydration
export const unstable_settings = {
  initialRouteName: 'index',
};

function RootContent() {
  const context = useContext(AppContext);
  const router = useRouter();
  const segments = useSegments();

  // Default values if context is not available
  const { activeCall, currentUser, isReady } = context || { activeCall: null, currentUser: null, isReady: false };

  // Show loading indicator while waiting for context to initialize
  if (!context) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#BC002A" />
      </View>
    );
  }

  // Handle Splash Screen hiding
  useEffect(() => {
    if (isReady) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [isReady]);

    useEffect(() => {
        if (!currentUser?.id) return;
        backgroundSyncService.register().catch((error) => {
            console.warn('[RootLayout] Background sync registration failed:', error);
        });
    }, [currentUser?.id]);

    // --- AUTH GUARD ---
    useEffect(() => {
        if (!context || !isReady || !segments || (segments as any[]).length === 0) return;
        const isCallActive = !!activeCall && (!activeCall.isIncoming || activeCall.isAccepted);
        if (isCallActive) return;

        const inAuthGroup = ['login', 'otp', 'username-setup', 'profile-setup', 'forgot-password'].includes(segments[0] as string);
        const timer = setTimeout(() => {
            if (!currentUser && !inAuthGroup) {
                router.replace('/login');
            } else if (currentUser && inAuthGroup) {
                router.replace('/(tabs)');
            }
        }, 100);
        return () => clearTimeout(timer);
    }, [currentUser, isReady, segments, router, !!activeCall]);

    // --- TRAFFIC CONTROLLER FOR CALLS ---
    useEffect(() => {
        if (!activeCall || !segments || !isReady) return;
        const handleNavigation = () => {
            const path = segments.join('/');
            const inCallScreen = path.includes('call');
            const shouldBeInCallScreen = !activeCall.isIncoming || activeCall.isAccepted;
            if (shouldBeInCallScreen && !activeCall.isMinimized && !inCallScreen) {
                const delay = Platform.OS === 'android' ? 250 : 100;
                setTimeout(() => {
                    if (!activeCall.isMinimized) {
                        router.push('/call');
                    }
                }, delay);
            }
        };
        handleNavigation();
        const subscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') handleNavigation();
        });
        return () => subscription.remove();
    }, [activeCall?.isAccepted, activeCall?.isIncoming, activeCall?.isMinimized, segments, isReady]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack screenOptions={{ headerShown: false, gestureEnabled: false, contentStyle: { backgroundColor: '#000' } }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="otp" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="username-setup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="profile-setup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="(tabs)" options={{ 
          headerShown: false,
          gestureEnabled: false 
        }} />
        <Stack.Screen name="call" options={{
          presentation: 'fullScreenModal',
          animation: 'fade',
          gestureEnabled: false
        }} />
        <Stack.Screen name="music" options={{
          presentation: 'transparentModal',
          animation: 'fade',
          headerShown: false
        }} />
        <Stack.Screen name="chat/[id]" options={{
          presentation: 'card',
          animation: 'none',
          headerShown: false,
          gestureEnabled: true,
          contentStyle: { backgroundColor: '#000' },
        }} />
        <Stack.Screen name="profile-edit" options={{
          presentation: 'card',
          animation: 'none',
          gestureEnabled: true,
        }} />
        <Stack.Screen name="profile" options={{
          animation: 'fade',
          headerShown: false,
        }} />
        <Stack.Screen name="profile/[id]" options={{
          animation: 'none',
          headerShown: false,
        }} />
        <Stack.Screen name="theme" options={{
          animation: 'ios_from_right',
          headerShown: false,
        }} />
        <Stack.Screen name="about" options={{
          animation: 'ios_from_right',
          headerShown: false,
        }} />
        <Stack.Screen name="help-center" options={{
          animation: 'ios_from_right',
          headerShown: false,
        }} />
        <Stack.Screen name="storage-management" options={{
          animation: 'ios_from_right',
          headerShown: false,
        }} />
        <Stack.Screen name="add-status" options={{
          presentation: 'fullScreenModal',
          animation: 'fade',
          headerShown: false,
        }} />
      </Stack>

      {/* Global Overlays */}
      {isReady && (
        <>
          <IncomingCallModal />
          <PipOverlay />
          <SecurityLockOverlay />
        </>
      )}
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <AppProvider>
            <ThemeProvider value={DarkTheme}>
              <RootContent />
              <Toaster />
              <StatusBar style="light" />
            </ThemeProvider>
          </AppProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
