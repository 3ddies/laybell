import { useCallback, useEffect, useState } from 'react';

// Optimistic seek position for remote (Cast) playback UIs. The receiver only
// reports its position every half-second — and not at all while it processes a
// seek — so a scrubber fed raw positions snaps back to the pre-seek spot for a
// beat, then jumps. Feels broken. Instead: the UI notes where the user seeked
// and SHOWS that immediately; the override dissolves as soon as the receiver
// reports somewhere near it, or after a 4s deadline (seek lost/failed — fall
// back to the truth rather than lying forever).
export function useOptimisticSeek(positionSec: number): [number, (sec: number) => void] {
  const [pending, setPending] = useState<{ sec: number; until: number } | null>(null);

  useEffect(() => {
    if (!pending) return;
    // Receiver caught up (±1.5s covers keyframe snapping) or deadline passed.
    if (Math.abs(positionSec - pending.sec) < 1.5 || Date.now() > pending.until) {
      setPending(null);
      return;
    }
    // No position ticks arrive while idle/buffering — enforce the deadline anyway.
    const t = setTimeout(() => setPending(null), Math.max(0, pending.until - Date.now()));
    return () => clearTimeout(t);
  }, [positionSec, pending]);

  const noteSeek = useCallback((sec: number) => {
    setPending({ sec: Math.max(0, sec), until: Date.now() + 4000 });
  }, []);

  return [pending ? pending.sec : positionSec, noteSeek];
}
