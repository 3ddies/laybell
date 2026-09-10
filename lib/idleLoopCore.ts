// What a video does when the room goes idle, and what it does when somebody
// comes back — as pure functions, so the rules can be tested without a phone.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE ARE TWO MODES
//
// The first version had one rule: when idle, withhold the NEXT loop and let the
// current pass finish. The on-device test showed what that means in practice. On
// Explore a preview kept streaming for minutes after the clock went idle, because
// nearly every video on Laybell is minutes long and "the current pass" was the
// whole video. The clock worked; the rule was wrong for that surface.
//
// But pausing everything on idle is wrong too. Somebody watching a film, a live
// stream, or a story does not touch the phone — that is what watching looks like
// — and cutting them off mid-scene because five minutes passed would be a bug
// they can see. So the surface declares which kind it is:
//
//   'pause'       Ambient previews nobody asked to watch: Explore tiles, the TV
//                 banner, home-feed autoplay, profile loops, inline ad tiles.
//                 Idle → pause immediately. Nothing streams to an empty room.
//
//   'finishPass'  Video somebody opened: the post viewer, reels, stories, live,
//                 ads inside a film. Idle → finish what is playing, then do not
//                 repeat it. Bounded, and never interrupts a viewer mid-watch.

export type IdleMode = 'pause' | 'finishPass';

export type IdleLoopState = {
  /** WE paused it because the room went idle — the only pause we may undo. */
  pausedForIdle: boolean;
  /** A looping pass reached its end while the repeat was being withheld. */
  endedWhileIdle: boolean;
};

export type IdleCmd =
  | { kind: 'none' }
  | { kind: 'pause' }
  | { kind: 'play' }
  | { kind: 'restart'; atSec: number };

const NONE: IdleCmd = { kind: 'none' };

export const initialIdleLoopState = (): IdleLoopState => ({ pausedForIdle: false, endedWhileIdle: false });

/** The native `loop` flag: requested looping, withheld while nobody is here. */
export function nativeLoop(loop: boolean, idle: boolean): boolean {
  return loop && !idle;
}

/** The clock just turned idle. */
export function wentIdle(
  s: IdleLoopState,
  { mode, playing }: { mode: IdleMode; playing: boolean },
): [IdleLoopState, IdleCmd] {
  if (mode === 'pause' && playing) return [{ ...s, pausedForIdle: true }, { kind: 'pause' }];
  return [s, NONE];
}

/** Somebody touched the phone again, or the app came back to the foreground. */
export function cameBack(
  s: IdleLoopState,
  { shouldPlay, restartSec }: { shouldPlay: boolean; restartSec?: number | null },
): [IdleLoopState, IdleCmd] {
  const cleared = initialIdleLoopState();
  // Scrolled away or covered while idle: nothing to resume, and stale flags must
  // not fire later when the surface is shown again for some other reason.
  if (!shouldPlay) return [cleared, NONE];
  // Paused mid-video: carry on from exactly where it stopped.
  if (s.pausedForIdle) return [cleared, { kind: 'play' }];
  // A repeat was withheld and the clip sat on its last frame: start it again.
  if (s.endedWhileIdle) return [cleared, { kind: 'restart', atSec: Math.max(0, restartSec ?? 0) }];
  return [cleared, NONE];
}

/**
 * Playback started or stopped. In 'pause' mode anything that starts playback
 * while idle — a self-heal, a readiness callback, a pooled player reassigned — is
 * paused again. Nothing a person did can start it: a person touching the phone
 * would have ended the idle state first.
 */
export function playingChanged(
  s: IdleLoopState,
  { isPlaying, idle, mode }: { isPlaying: boolean; idle: boolean; mode: IdleMode },
): [IdleLoopState, IdleCmd] {
  if (isPlaying && idle && mode === 'pause') return [{ ...s, pausedForIdle: true }, { kind: 'pause' }];
  return [s, NONE];
}

/**
 * The player reached the end of its item. iOS reports this on every ordinary loop
 * wrap too, so it only counts as a real end while idle, and only for a surface
 * that loops at all — a story that simply ends must stay ended.
 */
export function reachedEnd(s: IdleLoopState, { idle, loop }: { idle: boolean; loop: boolean }): IdleLoopState {
  return idle && loop ? { ...s, endedWhileIdle: true } : s;
}

/** A MANUAL loop (trimEnd) stopped at its end instead of seeking back. */
export function manualEnd(s: IdleLoopState): IdleLoopState {
  return { ...s, endedWhileIdle: true };
}
