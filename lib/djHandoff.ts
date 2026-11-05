// One-shot hand-off from the DJ Booth to the post composer.
//
// The booth records a live edit, stashes the resulting audio file (plus the original
// song it was built from, for credit) here, then navigates to the Post tab. The
// composer consumes it once on focus and pre-fills an audio post — crediting the
// original artist. Kept as a tiny module singleton rather than route params so the
// local file uri + metadata never have to survive URL serialization.

import type { PickedSong } from '../components/SongBrowser';

export type DjEditHandoff = {
  uri: string;          // local file:// uri of the recorded edit
  durationS: number;    // recording length in seconds
  // The original song this edit was made from, as a full PickedSong — set as the post's
  // attached song so the source artist is always credited (song_* columns on publish).
  // Null only if nothing was loaded (shouldn't happen — posting requires a loaded track).
  song: PickedSong | null;
};

let pending: DjEditHandoff | null = null;

/** Booth: stash an edit for the composer to pick up, then navigate to the Post tab. */
export function setPendingDjEdit(edit: DjEditHandoff): void {
  pending = edit;
}

/** Composer: take the pending edit (and clear it) — returns null if there is none. */
export function consumePendingDjEdit(): DjEditHandoff | null {
  const e = pending;
  pending = null;
  return e;
}

/** Whether an edit is waiting (without consuming it). */
export function hasPendingDjEdit(): boolean {
  return pending !== null;
}
