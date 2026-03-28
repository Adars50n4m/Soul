import 'expo-router/entry';
import { registerRootComponent } from 'expo';

// Only load and register TrackPlayer service in actual native environments
// This prevents build-time environment (Node 20) from crashing on strict ESM dependencies
if (process.env.NODE_ENV !== 'production' || typeof registerRootComponent !== 'undefined') {
  try {
    const TrackPlayer = require('react-native-track-player').default || require('react-native-track-player');
    TrackPlayer.registerPlaybackService(() => require('./service'));
  } catch (e) {
    console.warn('[Index] TrackPlayer register error:', e.message);
  }
}
