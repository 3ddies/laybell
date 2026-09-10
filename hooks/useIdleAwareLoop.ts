import { useCallback, useEffect, useRef } from 'react';
import type { VideoPlayer } from 'expo-video';
import { useLoopIdle } from '../lib/playbackPresence';

// Loop while somebody is here; finish the pass and stop when nobody is.
//
// The ONE writer of `player.loop` and `player.keepScreenOnWhilePlaying` for the
// surface that calls it. Every looping video in the app goes through this —
// AppVideo, FeedVideo, ReelVideo, GridVideo — because a loop that nobody watches
// is not a UX detail on this project, it is a Cloudflare bill: see
// lib/presenceCore.ts for the 8,075-minute post that made this necessary.
//
// HOW IT STOPS, and why it is gentle about it: when the room goes idle this sets
// `loop = false` rather than pausing. Both platforms consult `loop` only at the
// END of a pass — iOS in onPlayedToEnd (`if loop { seek(to: .zero); play() }`),
// Android through REPEAT_MODE_ONE — so the clip in progress always finishes and
// only the next repeat is withheld. A long video is never cut off mid-watch.
// Keep-awake is released at the same moment, so even if something restarts the
// player the phone can still lock, background, and let expo-video pause it.
//
// HOW IT RESUMES: the first touch after an idle stop restarts a clip that ended
// while nobody was here, from `restartSec` (a trimmed clip's start), provided
// the surface still wants to play.
//
// Callers with a MANUAL loop (trimEnd seeking back to trimStart in timeUpdate)
// read `idleRef` at the loop point and pause instead of seeking, then call
// `markEnded()` so the resume path knows to restart them. Callers with a
// self-heal ("resume if it stopped while it should be playing") must stand down
// while `idleRef.current` is true — or the heal restarts the very stop this
// hook exists to make.
export function useIdleAwareLoop(
  player: VideoPlayer | null,
  { loop, shouldPlay, restartSec }: { loop: boolean; shouldPlay: boolean; restartSec?: number | null },
) {
  const idle = useLoopIdle();
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const shouldPlayRef = useRef(shouldPlay);
  shouldPlayRef.current = shouldPlay;
  const restartRef = useRef<number | null>(restartSec ?? null);
  restartRef.current = restartSec ?? null;
  // A looping pass that reached its end while nobody was here. Only these get
  // restarted on return — a story or any other deliberately one-shot video that
  // ends naturally must stay ended.
  const endedRef = useRef(false);

  useEffect(() => {
    if (!player) return;
    try { player.loop = loop && !idle; } catch { /* released player */ }
    try { player.keepScreenOnWhilePlaying = !idle; } catch { /* released player */ }
  }, [player, loop, idle]);

  useEffect(() => {
    endedRef.current = false;
    if (!player) return;
    // iOS also emits playToEnd on every ordinary loop wrap, so this only counts
    // as a real end when the room was idle (loop already false) and the surface
    // is one that loops at all.
    const sub = player.addListener('playToEnd', () => {
      if (idleRef.current && loopRef.current) endedRef.current = true;
    });
    return () => sub.remove();
  }, [player]);

  const wasIdleRef = useRef(idle);
  useEffect(() => {
    const was = wasIdleRef.current;
    wasIdleRef.current = idle;
    if (idle || !was || !player) return;          // only the idle → present edge
    if (!endedRef.current || !shouldPlayRef.current) return;
    endedRef.current = false;
    try { player.currentTime = Math.max(0, restartRef.current ?? 0); } catch {}
    try { player.play(); } catch {}
  }, [idle, player]);

  const markEnded = useCallback(() => { endedRef.current = true; }, []);

  return { idleRef, markEnded };
}
