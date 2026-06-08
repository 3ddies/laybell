// Shared "play" thresholds for crediting streams (audio listens) and views (video
// watches). A count is earned by CUMULATIVE play time, scaled by the media's
// duration so short media can't rack up counts unfairly vs. long media. Returns
// the play-seconds needed for the 1st, 2nd and 3rd count.
//
// The curve is CONTINUOUS and MONOTONIC in duration (never decreasing), so there
// are no tier cliffs to game by padding a clip's length just over a boundary:
//   1st : 80% of the media, capped at 15s, with a 5s global floor.
//   2nd : 70% of the media, but at least 30s combined — short media needs genuine
//         replays for a 2nd count, not one quick play.
//   3rd : one more step of the same size. The server credits a 3rd only for
//         accounts older than 24h; new accounts stay capped at 2.
export function playThresholds(durationSec: number): { t1: number; t2: number; t3: number } {
  const t1 = Math.min(Math.max(0.8 * durationSec, 5), 15);
  const t2 = Math.max(30, 0.7 * durationSec);
  const t3 = 2 * t2 - t1; // continue the cadence: another (t2 - t1) of play time
  return { t1, t2, t3 };
}
