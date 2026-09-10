// "Is anyone actually here?" — the rule that stops Laybell streaming video into
// an empty room.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// One 11.8-minute post delivered 8,075 Cloudflare minutes in 30 days against 44
// recorded views — about 684 full plays. The mechanism was not background
// playback: expo-video already pauses on background (staysActiveInBackground is
// false and nothing in the app overrides it). It was the opposite. A PLAYING
// video keeps the screen from sleeping (preventsDisplaySleepDuringVideoPlayback
// on iOS, keepScreenOn on Android, both default true), so a looping video never
// ends, the phone never auto-locks, the app never backgrounds, and expo-video's
// background pause never gets its chance. Put the phone down on a looping post
// and it streams, in the foreground, until the battery dies.
//
// Looping is the right behaviour for someone watching. It is only wrong for a
// room with nobody in it — and the one signal that separates the two is whether
// anybody has touched the phone lately.
//
// ─────────────────────────────────────────────────────────────────────────────
// PURE ON PURPOSE
//
// No React Native, no timers of its own: the clock is injected. That keeps the
// part that decides "idle" testable in plain Node with a fake clock, which is
// the only way to prove timing behaviour without waiting five real minutes. The
// app's instance lives in lib/playbackPresence.ts.

export type PresenceClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type Presence = {
  /** A human did something: a touch anywhere, or the app returning to the foreground. */
  markInteraction: () => void;
  /** True once `idleAfterMs` has passed with no interaction. */
  isIdle: () => boolean;
  msSinceInteraction: () => number;
  /** Notified on the idle ↔ present TRANSITIONS only — never once per touch. */
  subscribe: (cb: () => void) => () => void;
};

export function createPresence(idleAfterMs: number, clock: PresenceClock): Presence {
  let last = clock.now();
  let idle = false;
  let timer: unknown = null;
  const subs = new Set<() => void>();

  const emit = () => {
    // Snapshot first: a subscriber that unsubscribes during the callback must
    // not skip the next one in line.
    for (const cb of Array.from(subs)) {
      try { cb(); } catch { /* one bad subscriber must not starve the rest */ }
    }
  };

  const arm = (ms: number) => {
    if (timer != null) clock.clearTimeout(timer);
    timer = clock.setTimeout(check, Math.max(0, ms));
  };

  // ONE timer, never re-armed per touch. A touch only moves `last`; when the
  // timer fires it measures from `last` and, if someone touched in the meantime,
  // re-arms for exactly the remainder. Scrolling a feed is dozens of touches a
  // minute, and cancelling-and-rescheduling a timer on every one of them would
  // be churn on the JS thread for nothing.
  function check() {
    timer = null;
    const since = clock.now() - last;
    if (since >= idleAfterMs) {
      if (!idle) { idle = true; emit(); }
      // Deliberately left unarmed: nothing needs checking again until someone
      // comes back, and markInteraction re-arms at that moment. No polling while
      // the room is empty.
      return;
    }
    arm(idleAfterMs - since);
  }

  arm(idleAfterMs);

  return {
    markInteraction() {
      last = clock.now();
      if (idle) {
        idle = false;
        arm(idleAfterMs);
        emit();
      } else if (timer == null) {
        arm(idleAfterMs); // defensive — should not happen while present
      }
    },
    isIdle: () => idle,
    msSinceInteraction: () => clock.now() - last,
    subscribe(cb) {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
  };
}
