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
// The ONE writer of `player.loop` for the surface that calls it. Every looping or
// autoplaying video goes through here.
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
// gentle.
//
// Keep-awake is deliberately left alone. A playing video holds the screen on
// (expo-video's default), and that is right for whoever is watching it. By the
// time the room counts as idle, the phone's own screen timeout has usually run
// out already — an iPhone's longest, short of Never, is 5 minutes — so releasing
// keep-awake here locks the screen almost at once: a live stream or a long post
// cut off mid-watch, the one thing 'finishPass' promises not to do. The first
// version did exactly that. It is not needed either: a paused preview and a video
// that finished its pass are not playing, so neither holds the screen, and the
// phone locks on its own.
//
// Callers with a MANUAL loop (trimEnd seeking back) read `idleRef` at the loop
// point, pause instead of seeking, and call `markEnded()`. Callers with a
// self-heal must stand down while `idleRef.current` is true.

// Dev builds narrate every decision with the playhead, so an on-device test reads
// as a log — "paused at 41.2s … resumed at 41.2s" — rather than a judgement call
// about whether a muted tile moved. Two tests came back ambiguous without it.
function at(p: VideoPlayer): string {
  try { return `${p.currentTime.toFixed(1)}s of ${Math.round(p.duration)}s`; } catch { return '(released)'; }
}
function narrate(text: string): void {
  // eslint-disable-next-line no-console
  console.log(`[idle] ${text}`);
}

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
  }, [player, loop, idle]);

  useEffect(() => {
    stateRef.current = initialIdleLoopState();
    if (!player) return;
    const subs = [
      player.addListener('playToEnd', () => {
        const before = stateRef.current;
        stateRef.current = reachedEnd(before, { idle: idleRef.current, loop: loopRef.current });
        if (__DEV__ && stateRef.current !== before) {
          narrate(`opened video ended while idle — stopped at ${at(player)}, not repeating`);
        }
      }),
      player.addListener('playingChange', (e) => {
        const [next, cmd] = playingChanged(stateRef.current, {
          isPlaying: e.isPlaying, idle: idleRef.current, mode: modeRef.current,
        });
        stateRef.current = next;
        if (__DEV__ && cmd.kind === 'pause') {
          narrate(`preview started playing while idle — paused again at ${at(player)}`);
        }
        run(player, cmd);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [player, run]);

  // Idle edges — and a player that ARRIVES while already idle: a pooled player
  // handed to this surface, a banner that swapped posts. Whoever handed it over
  // may have called play() before the playingChange listener above was attached,
  // so that event is gone. The player's state is not, so read it.
  const wasIdleRef = useRef(idle);
  const lastPlayerRef = useRef<VideoPlayer | null>(null);
  useEffect(() => {
    const was = wasIdleRef.current;
    wasIdleRef.current = idle;
    const arrived = player !== lastPlayerRef.current;
    lastPlayerRef.current = player;
    let tripwire: ReturnType<typeof setInterval> | null = null;

    if (player && idle && (!was || arrived)) {
      const p = player;
      const mode = modeRef.current;
      let playing = false;
      try { playing = p.playing; } catch { /* released */ }
      const [next, cmd] = wentIdle(stateRef.current, { mode, playing });
      stateRef.current = next;
      if (__DEV__ && playing) {
        narrate(cmd.kind === 'pause'
          ? `preview ${was ? 'arrived playing while idle — paused' : 'paused'} at ${at(p)}`
          : `opened video finishing its pass at ${at(p)} — will not repeat`);
      }
      run(p, cmd);
      if (__DEV__ && mode === 'pause') {
        // Dev-only tripwire. Nothing should be able to start a preview while idle
        // without the listener above catching it; if this ever prints, something can.
        tripwire = setInterval(() => {
          let still = false;
          try { still = p.playing; } catch { /* released */ }
          if (still) narrate(`⚠ preview STILL PLAYING while idle at ${at(p)}`);
        }, 10_000);
      }
    } else if (player && !idle && was) {
      const [next, cmd] = cameBack(stateRef.current, {
        shouldPlay: shouldPlayRef.current, restartSec: restartRef.current,
      });
      stateRef.current = next;
      if (__DEV__) {
        if (cmd.kind === 'play') narrate(`preview resumed at ${at(player)}`);
        else if (cmd.kind === 'restart') narrate(`opened video restarting from ${cmd.atSec.toFixed(1)}s`);
      }
      run(player, cmd);
    }

    return () => { if (tripwire) clearInterval(tripwire); };
  }, [idle, player, run]);

  const markEnded = useCallback(() => {
    stateRef.current = manualEnd(stateRef.current);
    if (__DEV__) narrate('opened video hit its trim end while idle — stopped, not repeating');
  }, []);

  return { idleRef, markEnded };
}
