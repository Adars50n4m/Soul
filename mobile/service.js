// The playback service for react-native-track-player
// This must be a CommonJS module to work correctly with registerRootComponent and background tasks
module.exports = async function() {
  try {
    const TrackPlayer = require('react-native-track-player');
    const { Event } = TrackPlayer;

    // TrackPlayer v4+ exports methods either as named exports or on the default object
    const player = TrackPlayer.default || TrackPlayer;

    if (typeof player.addEventListener === 'function') {
      player.addEventListener(Event.RemotePlay, () => player.play());
      player.addEventListener(Event.RemotePause, () => player.pause());
      player.addEventListener(Event.RemoteNext, () => player.skipToNext());
      player.addEventListener(Event.RemotePrevious, () => player.skipToPrevious());
    } else {
      console.warn('[SyncService] TrackPlayer.addEventListener not found on module');
    }
  } catch (e) {
    console.warn('[SyncService] TrackPlayer service load error:', e.message);
  }
};
