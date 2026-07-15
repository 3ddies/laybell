// Custom entry: expo-router bootstraps the app exactly as before; on top of
// that, react-native-track-player registers its playback service — the
// listener that receives iOS lock-screen / Control Center commands for the
// main music player (see lib/trackPlayerService).
import 'expo-router/entry';
import TrackPlayer from 'react-native-track-player';
import { playbackService } from './lib/trackPlayerService';

try {
  TrackPlayer.registerPlaybackService(() => playbackService);
} catch {}
