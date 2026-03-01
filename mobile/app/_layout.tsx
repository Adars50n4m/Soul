import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View, ActivityIndicator, Platform, AppState, AppStateStatus } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppContext, AppProvider } from '../context/AppContext';
import PipOverlay from '../components/PipOverlay';
import { IncomingCallModal } from '../components/IncomingCallModal';
import '../global.css';
import { useContext } from 'react';

function RootContent() {
  const context = useContext(AppContext);
  const router = useRouter();
  const segments = useSegments();

  const { activeCall, currentUser, isReady } = context || { activeCall: null, currentUser: null, isReady: false };

    // --- AUTH GUARD ---
    useEffect(() => {
        if (!context || !isReady || !segments) return;

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
        if (!activeCall || !segments) return;

        const inCallScreen = segments[0] === 'call';

        // 1. If call is outgoing (just initiated) or accepted, navigate to call screen
        const shouldBeInCallScreen = !activeCall.isIncoming || activeCall.isAccepted;

        if (shouldBeInCallScreen && !activeCall.isMinimized && !inCallScreen) {
            console.log('Call active & (Outgoing or Accepted) - Navigating to Call Screen');
            router.push('/call');
        }
    }, [activeCall?.isAccepted, activeCall?.isIncoming, activeCall?.isMinimized, segments, context]);

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
          animation: 'ios_from_right',
          headerShown: false,
          gestureEnabled: true,
          contentStyle: { backgroundColor: '#000' },
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
        <Stack.Screen name="add-status" options={{
          presentation: 'fullScreenModal',
          animation: 'fade',
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
