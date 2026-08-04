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
