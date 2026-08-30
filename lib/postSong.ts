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

/**
 * Lowercased, with punctuation flattened to spaces. Latin scripts come out
 * space-delimited; scripts that do not use spaces (CJK) are left as one token,
 * which the callers below account for.
 */
function norm(s?: string | null): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\s\-–—_·•|/\\,.:;!?"'`’“”()[\]{}]+/g, ' ')
    .trim();
}

/** Does `haystack` already name `needle`? */
function names(haystack?: string | null, needle?: string | null): boolean {
  const h = norm(haystack);
  const n = norm(needle);
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
 * The test is per-WORD and deliberately narrow: every word of the caption has to
 * be one the credit already contains, or filler. A caption that merely mentions
 * the artist inside a sentence — "shot this with 3ddie in Miami" — keeps all its
 * other words and survives, because voiding that would delete a real description
 * to prevent a repetition that was never going to happen.
 */
export function captionEchoesTitle(
  caption?: string | null, title?: string | null, artist?: string | null,
): boolean {
  const words = norm(caption).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const known = new Set(
    [...norm(title).split(' '), ...norm(artist).split(' ')].filter(Boolean),
  );
  return words.every((w) => known.has(w) || FILLER.has(w));
}
