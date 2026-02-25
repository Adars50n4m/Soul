import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppProvider, useApp } from '../context/AppContext';
import { View } from 'react-native';
import PipOverlay from '../components/PipOverlay';
import { IncomingCallModal } from '../components/IncomingCallModal';
import '../global.css';

function RootContent() {
  const { activeCall, currentUser, isReady } = useApp();
  const router = useRouter();
  const segments = useSegments();

    // --- AUTH GUARD ---
    useEffect(() => {
        if (!isReady) return;

        const inAuthGroup = segments[0] === 'login';

        if (!currentUser && !inAuthGroup) {
            // Redirect to login if user is not authenticated
            router.replace('/login');
        } else if (currentUser && inAuthGroup) {
            // Redirect to home if user is authenticated and tries to access login
            router.replace('/(tabs)');
        }
    }, [currentUser, isReady, segments]);

    // --- TRAFFIC CONTROLLER FOR CALLS ---
    useEffect(() => {
        if (!activeCall) return;

        const inCallScreen = segments[0] === 'call';

        // 1. If call is outgoing (just initiated) or accepted, navigate to call screen
        const shouldBeInCallScreen = !activeCall.isIncoming || activeCall.isAccepted;

        if (shouldBeInCallScreen && !activeCall.isMinimized && !inCallScreen) {
            console.log('Call active & (Outgoing or Accepted) - Navigating to Call Screen');
            router.push('/call');
        }
    }, [activeCall?.isAccepted, activeCall?.isIncoming, activeCall?.isMinimized, segments]);

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
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
          // Use a real transition so Reanimated sharedTransitionTag can run
          // between the chat-list pill and the chat header pill.
          presentation: 'card',
          // Disable screen-level animation; let the shared-element morph be the animation.
          animation: 'none',
          headerShown: false,
          gestureEnabled: true,
          // Keep the previous screen mounted during the transition so the shared element
          // can be captured and morphed smoothly.
          contentStyle: { backgroundColor: 'transparent' },
        }} />
        <Stack.Screen name="profile-edit" options={{
          presentation: 'card',
          animation: 'fade',
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
        <Stack.Screen name="+not-found" />
      </Stack>

      {/* Global Overlays */}
      <IncomingCallModal />
      <PipOverlay />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProvider>
        <ThemeProvider value={DarkTheme}>
          <RootContent />
          <StatusBar style="light" />
        </ThemeProvider>
      </AppProvider>
    </GestureHandlerRootView>
  );
}
