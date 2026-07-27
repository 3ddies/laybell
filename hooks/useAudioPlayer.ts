import { useNowPlaying } from '../contexts/AudioContext';

// Track rails across the app (Music, both profile screens, Saved) use this to
// badge whichever row is currently playing. It used to read the WHOLE
// AudioContext for that, so every consumer re-rendered its entire list on any
// buffering / ad / queue churn — not just on a real track change. useNowPlaying
// publishes exactly the { id, playing } slice, and `play` is stable, so the
// returned shape is unchanged and no call site needed touching.
export function useAudioPlayer() {
  const { id, playing, play } = useNowPlaying();

  async function playTrack(id: string, uri: string, caption = '', artist = '', cover: string | null = null) {
    await play({ id, uri, caption, artist, cover });
  }

  return {
    // Identical to the old `isPlaying ? (currentTrack?.id ?? null) : null` —
    // useNowPlaying's `id` IS `currentTrack?.id ?? null`.
    playingId: playing ? id : null,
    play: playTrack,
  };
}
