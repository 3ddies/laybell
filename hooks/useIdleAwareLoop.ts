import { useCallback, useEffect, useRef } from 'react';
import type { VideoPlayer } from 'expo-video';
import { useLoopIdle } from '../lib/playbackPresence';
import {
  cameBack, initialIdleLoopState, manualEnd, nativeLoop, playingChanged, reachedEnd, wentIdle,
  type IdleCmd, type IdleMode,
} from '../lib/idleLoopCore';

export type { IdleMode } from '../lib/idleLoopCore';

// What a video does when nobody is here — see lib/presenceCore.ts for the
// 8,075-minute post that made this necessary, and lib/idleLoopCore.ts for the
// rules, which are pure and tested.
//
// The ONE writer of `player.loop` and `player.keepScreenOnWhilePlaying` for the
// surface that calls it. Every looping or autoplaying video goes through here.
//
// `whenIdle` is the surface declaring what it is:
//   'pause'       an ambient preview nobody asked to watch — paused the moment
//                 the room goes idle, resumed from the same spot on return;
//   'finishPass'  (default) a video somebody opened — the current pass finishes,
//                 the next repeat is withheld, nobody is cut off mid-watch.
//
// The default is 'finishPass' on purpose. A surface that forgets to say still
// gets a bounded stop, and the mistake costs a few minutes of delivery rather
// than interrupting somebody watching a film. Previews must opt in to 'pause'.
//
// Both platforms read native `loop` only at the END of a pass (iOS in
// onPlayedToEnd, Android via REPEAT_MODE_ONE), which is what makes 'finishPass'
// gentle. Keep-awake is released whenever idle, so the phone can lock, the app
// background, and expo-video's own background pause take over.
//
// Callers with a MANUAL loop (trimEnd seeking back) read `idleRef` at the loop
// point, pause instead of seeking, and call `markEnded()`. Callers with a
// self-heal must stand down while `idleRef.current` is true.
export function useIdleAwareLoop(
  player: VideoPlayer | null,
  { loop, shouldPlay, restartSec, whenIdle = 'finishPass' }: {
    loop: boolean;
    shouldPlay: boolean;
    restartSec?: number | null;
    whenIdle?: IdleMode;
  },
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
  const modeRef = useRef<IdleMode>(whenIdle);
  modeRef.current = whenIdle;
  const stateRef = useRef(initialIdleLoopState());

  const run = useCallback((p: VideoPlayer, cmd: IdleCmd) => {
    switch (cmd.kind) {
      case 'pause': try { p.pause(); } catch { /* released */ } return;
      case 'play': try { p.play(); } catch { /* released */ } return;
      case 'restart':
        try { p.currentTime = cmd.atSec; } catch { /* released */ }
        try { p.play(); } catch { /* released */ }
        return;
      default: return;
    }
  }, []);

  useEffect(() => {
    if (!player) return;
    try { player.loop = nativeLoop(loop, idle); } catch { /* released */ }
    try { player.keepScreenOnWhilePlaying = !idle; } catch { /* released */ }
  }, [player, loop, idle]);

  useEffect(() => {
    stateRef.current = initialIdleLoopState();
    if (!player) return;
    const subs = [
      player.addListener('playToEnd', () => {
        stateRef.current = reachedEnd(stateRef.current, { idle: idleRef.current, loop: loopRef.current });
      }),
      player.addListener('playingChange', (e) => {
        const [next, cmd] = playingChanged(stateRef.current, {
          isPlaying: e.isPlaying, idle: idleRef.current, mode: modeRef.current,
        });
        stateRef.current = next;
        run(player, cmd);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [player, run]);

  const wasIdleRef = useRef(idle);
  useEffect(() => {
    const was = wasIdleRef.current;
    wasIdleRef.current = idle;
    if (!player || idle === was) return;
    if (idle) {
      let playing = false;
      try { playing = player.playing; } catch { /* released */ }
      const [next, cmd] = wentIdle(stateRef.current, { mode: modeRef.current, playing });
      stateRef.current = next;
      run(player, cmd);
    } else {
      const [next, cmd] = cameBack(stateRef.current, {
        shouldPlay: shouldPlayRef.current, restartSec: restartRef.current,
      });
      stateRef.current = next;
      run(player, cmd);
    }
  }, [idle, player, run]);

  const markEnded = useCallback(() => { stateRef.current = manualEnd(stateRef.current); }, []);

  return { idleRef, markEnded };
}
