import { createAudioPlayer } from 'expo-audio';

// One-shot audio-duration probe, in SECONDS. expo-audio reports duration via the
// 'playbackStatusUpdate' status once the file is loaded (seconds — not the ms
// expo-av's Audio.Sound used). We spin up a throwaway player, wait for it to
// load, read the duration, and release it. Resolves null on failure/timeout so
// callers can no-op gracefully. The player is released on the next tick (never
// from inside its own status callback — see AudioContext.releaseSound).
export function probeAudioDurationSec(uri: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    let player: ReturnType<typeof createAudioPlayer> | null = null;
    let sub: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sub?.remove(); } catch {}
      const p = player;
      player = null;
      setTimeout(() => { try { p?.remove(); } catch {} }, 0);
      resolve(v);
    };

    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      player = createAudioPlayer({ uri });
      sub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (st?.isLoaded) {
          const d = st.duration; // seconds
          finish(typeof d === 'number' && d > 0 ? d : null);
        }
      });
    } catch {
      finish(null);
    }
  });
}
