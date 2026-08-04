import { useEffect, useRef, useState } from 'react';
import type { VideoPlayer } from 'expo-video';

// "Is this video stuck buffering right now?" — the signal behind the stall
// spinner on the big playback surfaces.
//
// On a bad connection a clip that has ALREADY painted a frame will simply stop
// advancing: expo-video reports `loading` again, the surface keeps showing the
// last decoded frame, and nothing tells the user anything. That frozen frame is
// indistinguishable from an app freeze, which is the single most alarming way a
// video can fail — people force-quit over it.
//
// DEBOUNCED on purpose (same reasoning as the audio engine's buffering flag in
// AudioContext): streaming tops its buffer up in short bursts, so an undebounced
// flag would flash a spinner every few seconds on a perfectly healthy stream and
// read as jank. Only a SUSTAINED stall surfaces.
const STALL_DELAY_MS = 700;

export function useVideoStall(
  player: VideoPlayer | null,
  active: boolean,
  delayMs: number = STALL_DELAY_MS,
): boolean {
  const [stalled, setStalled] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read the live "is this surface the one on screen" flag inside the listener
  // (subscribed once per player, so a plain closure would go stale).
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
    // A new player (pool reassignment, source change) starts clean.
    clearTimer();
    setStalled(false);
    if (!player) return;

    const sub = player.addListener('statusChange', ({ status }: any) => {
      if (status === 'loading') {
        // Arm once — re-arming on every repeat event would push the deadline
        // out forever and the spinner would never appear.
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (activeRef.current) setStalled(true);
          }, delayMs);
        }
      } else {
        // readyToPlay / error / idle — either it recovered or it failed into a
        // path that owns its own UI. Either way, stop claiming it's buffering.
        clearTimer();
        setStalled(false);
      }
    });

    return () => { clearTimer(); sub.remove(); };
  }, [player, delayMs]);

  // Paused, swiped away, or globally suspended → never show the spinner.
  useEffect(() => {
    if (!active) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setStalled(false);
    }
  }, [active]);

  return stalled && active;
}
