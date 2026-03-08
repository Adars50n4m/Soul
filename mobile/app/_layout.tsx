import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator, Platform, AppState, AppStateStatus } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppContext, AppProvider } from '../context/AppContext';
import PipOverlay from '../components/PipOverlay';
import { IncomingCallModal } from '../components/IncomingCallModal';
import { SecurityLockOverlay } from '../components/SecurityLockOverlay';
import { Toaster } from '../components/ui/Toaster';
import '../global.css';
import { useContext } from 'react';

// Ensures expo-router constructs valid initial state during hydration
export const unstable_settings = {
  initialRouteName: 'index',
};

function RootContent() {
  const context = useContext(AppContext);
  const router = useRouter();
  const segments = useSegments();

  const { activeCall, currentUser, isReady } = context || { activeCall: null, currentUser: null, isReady: false };

    // --- AUTH GUARD ---
    useEffect(() => {
        // Wait for everything to be ready before attempting any navigation
        if (!context || !isReady || !segments || (segments as any[]).length === 0) return;

        // Skip auth guard redirections if there is an active call that needs the screen
        const isCallActive = !!activeCall && (!activeCall.isIncoming || activeCall.isAccepted);
        if (isCallActive) return;

        const inAuthGroup = ['login', 'signup', 'otp', 'username-setup', 'profile-setup', 'forgot-password'].includes(segments[0] as string);

        // Use a small timeout to let the navigation state settle on Android
        const timer = setTimeout(() => {
            if (!currentUser && !inAuthGroup) {
                console.log('[RootLayout] Redirecting to login');
                router.replace('/login');
            } else if (currentUser && inAuthGroup) {
                console.log('[RootLayout] Redirecting to (tabs)');
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

            // 1. If call is outgoing (just initiated) or accepted, navigate to call screen
            const shouldBeInCallScreen = !activeCall.isIncoming || activeCall.isAccepted;

            if (shouldBeInCallScreen && !activeCall.isMinimized && !inCallScreen) {
                console.log(`[TrafficController] Navigating to Call Screen. Current: ${path}, Should: /call`);
                // Force a slightly longer delay on Android to ensure UI stack is ready
                const delay = Platform.OS === 'android' ? 250 : 100;
                setTimeout(() => {
                    // Re-check condition before pushing
                    if (!activeCall.isMinimized) {
                        router.push('/call');
                    }
                }, delay);
            }
        };

        handleNavigation();

        // Re-check navigation when app comes to foreground (important for CallKit/lock screen answer)
        const subscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                handleNavigation();
            }
        });

        return () => subscription.remove();
    }, [activeCall?.isAccepted, activeCall?.isIncoming, activeCall?.isMinimized, segments, isReady]);

  if (!context) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#BC002A" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="signup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="otp" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="username-setup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="profile-setup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="forgot-password" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="(tabs)" options={{ 
          headerShown: false,
          gestureEnabled: false // Prevents root-level GO_BACK crash on swipe
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
          animation: 'ios_from_right',
          headerShown: false,
        }} />
        <Stack.Screen name="profile/[id]" options={{
          animation: 'ios_from_right',
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
        <Stack.Screen name="+not-found" />
      </Stack>

      {/* Global Overlays - Only render when ready to avoid backdrop glitches */}
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProvider>
        <ThemeProvider value={DarkTheme}>
          <RootContent />
          <Toaster />
          <StatusBar style="light" />
        </ThemeProvider>
      </AppProvider>
    </GestureHandlerRootView>
  );
}
