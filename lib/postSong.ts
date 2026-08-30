// One place that answers "does this post's attached song actually PLAY?"
//
// There are two kinds of song attachment and they behave oppositely:
//
//   • Normal ("use this song") — the song replaces the host's audio. The host
//     video is MUTED and the ambient engine plays the track over it.
//   • Music video (song_link_only) — the song is already the video's own
//     soundtrack. The card is a credit and a link; playing the track would run
//     it twice, out of sync with itself. The video keeps its sound.
//
// The rule lives here rather than being re-derived at each call site because it
// is read in a dozen places across the feed, post viewer and reel — mute flags,
// prefetch, visible-track tracking, ambient start/stop. One missed site means a
// music video plays its own song on top of itself, which is the single failure
// this feature exists to prevent, so the check needs to be impossible to write
// two different ways.

export type SongAttachable = {
  song_id?: string | null;
  song_link_only?: boolean | null;
} | null | undefined;

/**
 * True when the attached song should be played by the ambient engine (and the
 * host video therefore muted).
 *
 * Note the shape of the fallback: a post with no `song_link_only` column yet —
 * pre-migration, or any query that didn't select it — reads as PLAYS, which is
 * the behaviour that already shipped. New behaviour requires an explicit true.
 */
export function songPlaysFor(post: SongAttachable): boolean {
  return !!post?.song_id && post?.song_link_only !== true;
}

/**
 * True when the post credits a song that must NOT play — the card renders as a
 * link to the track instead of a play button.
 */
export function songIsLinkOnly(post: SongAttachable): boolean {
  return !!post?.song_id && post?.song_link_only === true;
}

// ── Handing a music video over to the real player ────────────────────────────
//
// Continuing the song from where the video had reached is only correct when the
// two actually share a timeline, and there is no way to KNOW that they do. A
// post is a music video because its author said so, and "the song gets promoted"
// is reason enough for someone to say so about a video that is nothing of the
// kind. A position taken on faith there is not a small error: 40 seconds into an
// unrelated clip is 40 seconds into a song the listener has never heard, which
// is worse than any restart.
//
// So the position is trusted only where the evidence supports it. Otherwise the
// song starts at 0:00 — never wrong, merely less clever.

/** Room a position needs at each end of the song to count as inside it. */
const HANDOFF_EDGE_MS = 1500;

/**
 * Where the song should start when a music video hands over, in ms. 0 means
 * "from the top", and is the answer to every doubt.
 *
 * @param wantMs   where the VIDEO had reached
 * @param songMs   the song's real duration — known only once it has loaded
 * @param sourceMs the video's duration
 */
export function handoffPositionMs(wantMs: number, songMs: number, sourceMs: number): number {
  if (!(wantMs > HANDOFF_EDGE_MS) || !(songMs > 0) || !(sourceMs > 0)) return 0;
  // Lengths must agree before positions can mean anything. A video running to a
  // different length is either not this song at all, or carries an intro the song
  // does not — and in that second case the difference IS the drift the handoff
  // would introduce, so both failures are caught by the same test.
  const tolerance = Math.min(10_000, Math.max(3_000, songMs * 0.05));
  if (Math.abs(sourceMs - songMs) > tolerance) return 0;
  if (wantMs >= songMs - HANDOFF_EDGE_MS) return 0;
  return Math.round(wantMs);
}

// ── Titling a post that carries a name of its own ────────────────────────────
//
// A music video has a title the way a film does: the track it is a video of.
// Both feed the alternating title/description block on the feed card (see
// components/RotatingCaption), and both hit the same problem — the same fact
// arriving twice, in two spellings, on one card.
//
// Artists title uploads "Break that - 3ddie" at least as often as "Break that",
// so appending the artist unconditionally yields "Break that - 3ddie · 3ddie".
// And a caption is very often the song name again, or just the artist's own
// name, which would leave the rotation alternating between two ways of saying
// one thing. Both collapse to stating the credit once.

// Leetspeak folded to letters, so "3ddie" and "eddie" are one name. Applied for
// COMPARISON only — nothing displayed is ever rewritten.
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's',
};
// Punctuation, and the symbol/emoji blocks, flattened to spacing. Written as
// explicit ranges rather than \p{…} escapes: a regex the engine cannot parse
// throws at module load, and on a project with no OTA that ships as a feed that
// will not render. CJK ideographs are left alone — they are words here.
const PUNCT = /[\s\-_|/\\,.:;!?"'`()[\]{}#*+=<>~^&%]+/g;
const SYMBOLS = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2000-\u2BFF\u3000-\u303F\uFE00-\uFE0F\u20E3\u00A9\u00AE\u00B7]/g;

/**
 * The comparison form: diacritics stripped, leetspeak folded, punctuation and
 * emoji reduced to spacing, lowercased. "Café — BREAK THAT!! 🔥" and
 * "cafe break that" arrive here identical.
 */
function canon(s?: string | null): string {
  let out = s ?? '';
  // Hermes has normalize, but a missing implementation would throw at the worst
  // possible moment; without it we simply keep the accents.
  try { out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch { /* keep as-is */ }
  return out
    .toLowerCase()
    .replace(SYMBOLS, ' ')
    .replace(/[01345789@$]/g, (c) => LEET[c] ?? c)
    .replace(PUNCT, ' ')
    .trim();
}

/** Runs of a repeated letter collapsed: "thattt" and "that" compare equal. */
function collapse(s: string): string {
  return s.replace(/(.)\1+/g, '$1');
}

/** Levenshtein within `max`, for absorbing a typo rather than a different word. */
function within(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (max <= 0 || Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return false; // no cell on this row can still reach `max`
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * Two words that are the same word. Short ones must match exactly — one edit
 * away from "Ash" is half the dictionary — and the allowance opens up with
 * length, where a typo is likelier than a coincidence.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = collapse(a); const cb = collapse(b);
  if (ca === cb) return true;
  const n = Math.min(ca.length, cb.length);
  return within(ca, cb, n >= 8 ? 2 : n >= 5 ? 1 : 0);
}

/**
 * Does `haystack` already name `needle`?
 *
 * EXACT tokens only — no sameWord() here, deliberately. This one decides whether
 * to leave the artist OFF the credit line, and the two mistakes are not
 * symmetrical: a caption wrongly dropped costs a repetition the user asked us to
 * remove, while an artist wrongly dropped erases a credit nothing else on the
 * card will state.
 */
function names(haystack?: string | null, needle?: string | null): boolean {
  const h = canon(haystack);
  const n = canon(needle);
  if (!h || !n) return false;
  // WHOLE-token match, so the artist "Ash" is not found inside the title
  // "Ashes" and silently dropped from the credit.
  if (` ${h} `.includes(` ${n} `)) return true;
  // Scripts without word spacing never produce those boundaries, so they — and
  // only they — fall back to a plain substring. Allowing that for Latin text is
  // exactly the Ash/Ashes false positive.
  return !/[a-z0-9]/.test(n) && n.length >= 2 && h.includes(n);
}

/**
 * The song credit as ONE line: "Break that · 3ddie" — but "Break that - 3ddie"
 * is returned untouched, because the artist is already in it.
 */
export function songCreditLine(title?: string | null, artist?: string | null): string {
  const t = (title ?? '').trim();
  const a = (artist ?? '').trim();
  if (!t) return a;
  if (!a || names(t, a)) return t;
  return `${t} · ${a}`;
}

// Words that carry nothing once the title and artist are accounted for. Kept to
// genuinely structural ones: "out now" and "new" say something a caption might
// exist to say, so they are not on this list.
const FILLER = new Set([
  'by', 'ft', 'feat', 'featuring', 'prod', 'official', 'video', 'mv', 'audio',
  'music', 'song', 'track', 'single', 'x', 'w', 'with', 'and', 'the', 'a', 'of', 'my',
]);

/**
 * True when a caption says nothing the title and artist have not already said,
 * and should therefore be dropped rather than alternated with them. Films pass
 * their film_title and no artist.
 *
 * The test is per-WORD: every word of the caption has to be one the credit
 * already contains, or filler. Matching is loose about how a word is written —
 * case, accents, emoji, punctuation, leetspeak and a typo's worth of edits all
 * compare equal — because a caption is meant to be recognised as the same thing
 * said again, not matched byte for byte.
 *
 * It is loose about SPELLING and strict about CONTENT. A caption that merely
 * mentions the artist inside a sentence — "shot this with 3ddie in Miami" —
 * keeps all its other words and survives; voiding it would delete a real
 * description to prevent a repetition that was never going to happen.
 */
export function captionEchoesTitle(
  caption?: string | null, title?: string | null, artist?: string | null,
): boolean {
  const cap = canon(caption);
  if (!cap) return true;
  const credit = `${canon(title)} ${canon(artist)}`.trim();
  if (!credit) return false;
  // Whole-string first, spaces removed: "Breakthat", "BREAK-THAT" and
  // "break that" all reduce to something the credit already contains, and none
  // of the first two tokenise into anything the word test would recognise.
  const squash = (s: string) => collapse(s.replace(/ /g, ''));
  if (squash(credit).includes(squash(cap))) return true;
  const known = credit.split(' ').filter(Boolean);
  return cap.split(' ').filter(Boolean)
    .every((w) => FILLER.has(w) || known.some((k) => sameWord(w, k)));
}
