// The playback service for react-native-track-player
// This must be a CommonJS module to work correctly with registerRootComponent and background tasks
module.exports = async function() {
  try {
    const TrackPlayer = require('react-native-track-player');
    const { Event } = TrackPlayer;

    // TrackPlayer v4+ exports methods either as named exports or on the default object
    const player = TrackPlayer.default || TrackPlayer;

    if (typeof player.addEventListener === 'function') {
      player.addEventListener(Event.RemotePlay, async () => {
        try { await player.play(); } catch (e) { console.warn('[SyncService] RemotePlay failed:', e?.message || e); }
      });
      player.addEventListener(Event.RemotePause, async () => {
        try { await player.pause(); } catch (e) { console.warn('[SyncService] RemotePause failed:', e?.message || e); }
      });
      player.addEventListener(Event.RemoteNext, async () => {
        try { await player.skipToNext(); } catch (e) { console.warn('[SyncService] RemoteNext failed:', e?.message || e); }
      });
      player.addEventListener(Event.RemotePrevious, async () => {
        try { await player.skipToPrevious(); } catch (e) { console.warn('[SyncService] RemotePrevious failed:', e?.message || e); }
      });
    } else {
      console.warn('[SyncService] TrackPlayer.addEventListener not found on module');
    }
  } catch (e) {
    console.warn('[SyncService] TrackPlayer service load error:', e.message);
  }
};
