// The playback service for react-native-track-player
// This must be a CommonJS module to work correctly with registerRootComponent and background tasks
module.exports = async function() {
  try {
    const { Event } = require('react-native-track-player');

    require('react-native-track-player').addEventListener(Event.RemotePlay, () => {
      require('react-native-track-player').play();
    });

    require('react-native-track-player').addEventListener(Event.RemotePause, () => {
      require('react-native-track-player').pause();
    });

    require('react-native-track-player').addEventListener(Event.RemoteNext, () => {
      require('react-native-track-player').skipToNext();
    });

    require('react-native-track-player').addEventListener(Event.RemotePrevious, () => {
      require('react-native-track-player').skipToPrevious();
    });
  } catch (e) {
    console.warn('[SyncService] TrackPlayer service load error:', e.message);
  }
};
