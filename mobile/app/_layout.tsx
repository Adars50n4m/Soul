console.log('[LayoutLoad] Entry point loading...');
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useContext, Component, ReactNode, useState, useRef, useCallback } from 'react';
import { View, ActivityIndicator, Platform, AppState, Text, Pressable, StyleSheet as ViewStyle } from 'react-native';

import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts, DancingScript_700Bold } from '@expo-google-fonts/dancing-script';
import { AppContext, AppProvider } from '../context/AppContext';
import { PresenceProvider } from '../context/PresenceContext';
import { backgroundSyncService } from '../services/BackgroundSyncService';
import { notificationService } from '../services/NotificationService';
import PipOverlay from '../components/PipOverlay';
// MiniPlayer disabled — music shown in chat header pill instead
import { IncomingCallModal } from '../components/IncomingCallModal';
import { SecurityLockOverlay } from '../components/SecurityLockOverlay';
import { Toaster } from '../components/ui/Toaster';
import { SheetProvider } from 'react-native-sheet-transitions';
import { CardioLoader } from '../components/ui/CardioLoader';


// Error Boundary to catch rendering errors
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  state = { hasError: false, error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    // Report to crash reporting service
    try {
      const { crashReporting } = require('../services/CrashReportingService');
      crashReporting.captureComponentError(error, errorInfo?.componentStack);
    } catch {}
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

const SPLASH_FAILSAFE_MS = 3500;

function RootContent() {
  const context = useContext(AppContext);
  const router = useRouter();
  const segments = useSegments();

  // Handle Splash Screen hiding separately to keep it outside the context switch if possible,
  // but since we need isReady, we must handle it carefully.
  const { activeCall, currentUser, isReady, activeTheme } = context || { activeCall: null, currentUser: null, isReady: false, activeTheme: null };
  const themeAccent = activeTheme?.primary || '#BC002A';
  const [showSkip, setShowSkip] = useState(false);
  const splashHiddenRef = useRef(false);
  const hideSplashSafely = useCallback((reason: string) => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    console.log(`[RootContent] Hiding splash screen (${reason})...`);
    SplashScreen.hideAsync().catch((err) => {
      console.warn('[RootContent] Error hiding splash screen:', err);
    });
  }, []);

  // Handle Background Service registration (DEFERRED)
  useEffect(() => {
    console.log('[RootContent] Mounted - scheduling background services...');
    
    // DELAY registration of non-critical services to allow JS thread to breathe
    const deferTimer = setTimeout(() => {
      console.log('[RootContent] 🔄 Registering background services now.');
      backgroundSyncService.register().catch(e => console.warn('[BackgroundSync] Registration error:', e));
    }, 5000);

    const cleanupListener = backgroundSyncService.setupListener();

    return () => {
        clearTimeout(deferTimer);
        cleanupListener();
    };
  }, []); // This useEffect runs once on mount for deferred setup

  // Absolute fail-safe: never allow splash to block app forever on slow/hung init.
  useEffect(() => {
    const splashFailsafe = setTimeout(() => {
      if (!splashHiddenRef.current) {
        console.warn(`[RootLayout] Splash failsafe fired after ${SPLASH_FAILSAFE_MS}ms`);
        hideSplashSafely('failsafe-timeout');
        setShowSkip(true);
      }
    }, SPLASH_FAILSAFE_MS);

    return () => clearTimeout(splashFailsafe);
  }, [hideSplashSafely]);

  useEffect(() => {
    if (isReady) {
      console.log('[RootContent] isReady is now TRUE. Unblocking UI...');
      hideSplashSafely('auth-ready');
    }
    
    // Safety timeout: if isReady is still false after 3 seconds, show skip button
    const timer = setTimeout(() => {
        if (!isReady) {
            console.warn('[RootLayout] NOT READY after 3s - offering emergency skip');
            setShowSkip(true);
        }
    }, 3000);
    return () => clearTimeout(timer);
  }, [isReady, segments, hideSplashSafely]);

    useEffect(() => {
        if (!currentUser?.id) return;
        console.log('[RootLayout] User synced:', currentUser.id);
    }, [currentUser?.id]);

    // --- AUTH GUARD ---
    useEffect(() => {
        if (!context || !isReady || !segments || (segments as any[]).length === 0) return;
        
        // A call is considered "blocking" for auth purposes ONLY if it's already accepted OR we are actively connecting
        // and NOT on the call screen already. This prevents stale activeCall objects from blocking the /login redirect.
        const isCallActive = !!activeCall && (activeCall.isAccepted || (!activeCall.isIncoming && activeCall.callId));
        const inCallScreen = segments[0] === 'call';
        
        if (isCallActive && inCallScreen) return;

        const inAuthGroup = ['login', 'otp', 'username-setup', 'profile-setup', 'forgot-password'].includes(segments[0] as string);
        const needsProfileSetup = !currentUser?.isSuperUser && !!currentUser?.username && (
          currentUser.username.startsWith('temp_') ||
          currentUser.username.startsWith('user_')
        );

        if (!currentUser && !inAuthGroup) {
            router.replace('/login');
            return;
        }

        if (currentUser && needsProfileSetup && segments[0] !== 'username-setup' && segments[0] !== 'profile-setup') {
            router.replace('/username-setup?oauthMode=true');
            return;
        }

        if (currentUser && inAuthGroup && !needsProfileSetup) {
            router.replace('/(tabs)');
        }
    }, [currentUser, isReady, segments, router, !!activeCall, activeCall?.isAccepted]);

    // --- TRAFFIC CONTROLLER FOR CALLS ---
    useEffect(() => {
        if (!activeCall || !segments || !isReady) return;
        const handleNavigation = () => {
            const path = segments.join('/');
            const inCallScreen = path.includes('call') || path.includes('IncomingCallModal');
            
            // Only push to call screen if the call is accepted OR it's an OUTGOING call that we just started.
            // Stale/idle calls (Incoming=false, Accepted=false, but no active signaling) should NOT trigger navigation.
            const shouldBeInCallScreen = activeCall.isAccepted || (!activeCall.isIncoming && (activeCall.roomId || activeCall.callId));

            if (shouldBeInCallScreen && !activeCall.isMinimized && !inCallScreen) {
                console.log(`[RootLayout] 🚀 Navigating to /call (Accepted=${activeCall.isAccepted}, Incoming=${activeCall.isIncoming}, Room=${activeCall.roomId || activeCall.callId})`);
                const delay = Platform.OS === 'android' ? 300 : 100;
                setTimeout(() => {
                    // Re-check state inside timeout to ensure we still need to navigate
                    if (context?.activeCall && (context.activeCall.isAccepted || !context.activeCall.isIncoming) && !context.activeCall.isMinimized) {
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
    }, [activeCall?.isAccepted, activeCall?.isIncoming, activeCall?.isMinimized, segments, isReady, !!context]);

  // Note: We always render the Stack navigator below to satisfy Expo Router's requirement.
  // We use absolute-positioned overlays for loading/stuck states.

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
          headerShown: false,
          contentStyle: { backgroundColor: 'transparent' },
        }} />
        <Stack.Screen name="chat/[id]" options={{
          presentation: 'card',
          animation: 'none',
          headerShown: false,
          gestureEnabled: true,
          contentStyle: { backgroundColor: '#000' },
        }} />
        <Stack.Screen name="profile-edit" options={{
          presentation: 'transparentModal',
          animation: 'none',
          gestureEnabled: false,
          contentStyle: { backgroundColor: 'transparent' },
        }} />
        <Stack.Screen name="profile" options={{
          animation: 'fade',
          headerShown: false,
        }} />
        <Stack.Screen
          name="profile/[id]"
          options={({ route }: any) => {
            const avatarTransition = route?.params?.avatarTransition === '1';
            return {
              animation: 'none',
              presentation: 'transparentModal',
              headerShown: false,
              gestureEnabled: true,
              contentStyle: { backgroundColor: 'transparent' },
              detachPreviousScreen: false,
            };
          }}
        />
        <Stack.Screen name="group-info/[id]" options={{
          presentation: 'transparentModal',
          animation: 'none',
          headerShown: false,
          contentStyle: { backgroundColor: 'transparent' },
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

      {/* Persistence / Loading Overlay: Always sits on top until isReady is true */}
      {!isReady && (
        <View 
          style={{ 
            ...ViewStyle.absoluteFillObject, 
            backgroundColor: '#000', 
            justifyContent: 'center', 
            alignItems: 'center',
            zIndex: 99999 
          }}
        >
          {(!showSkip) ? (
            <>
              <CardioLoader size={60} stroke={4} speed={1.5} color={themeAccent} />
              <Text style={{ color: '#666', marginTop: 20, fontSize: 12 }}>Initializing Soul...</Text>
            </>
          ) : (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <CardioLoader size={60} stroke={4} speed={1.5} color={themeAccent} />
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '600', marginTop: 30, textAlign: 'center' }}>Taking longer than usual...</Text>
              <Text style={{ color: '#999', fontSize: 14, marginTop: 10, textAlign: 'center', marginBottom: 40 }}>
                We're having trouble connecting to the local database or sync server.
              </Text>
              
              <Pressable 
                onPress={() => {
                  console.log('[RootLayout] User triggered emergency skip');
                  hideSplashSafely('manual-skip');
                  // Forcing isReady is handled at the context level if needed, 
                  // but for UI layout, we just hide the splash.
                }}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? '#444' : '#222',
                  paddingVertical: 12,
                  paddingHorizontal: 24,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: '#333'
                })}
              >
                <Text style={{ color: '#fff', fontWeight: 'bold' }}>Emergency Skip Splash</Text>
              </Pressable>

              <Pressable 
                onPress={() => {
                  console.log('[RootLayout] User requested retry');
                  setShowSkip(false);
                }}
                style={{ marginTop: 20 }}
              >
                <Text style={{ color: themeAccent, fontSize: 14 }}>Try Again</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

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
  const [fontsLoaded] = useFonts({ DancingScript_700Bold });

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <AppProvider>
            <PresenceProvider>
              <ThemeProvider value={DarkTheme}>
                <SheetProvider>
                  <RootContent />
                </SheetProvider>
                <Toaster />
                <StatusBar style="light" />
              </ThemeProvider>
            </PresenceProvider>

          </AppProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
