import { useAudio } from '../contexts/AudioContext';

export function useAudioPlayer() {
  const { currentTrack, isPlaying, play, stop } = useAudio();

  async function playTrack(id: string, uri: string, caption = '', artist = '') {
    await play({ id, uri, caption, artist });
  }

  return {
    playingId: isPlaying ? (currentTrack?.id ?? null) : null,
    play: playTrack,
  };
}
