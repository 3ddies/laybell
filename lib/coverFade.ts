// First-seen fade-in for cover art on the music surfaces.
//
// expo-image's `transition` is applied UNCONDITIONALLY by the native view
// (expo-image/ios/ImageView.swift `renderSourceImage`) — there is no "skip the
// fade when the bitmap came from the memory cache" logic. Putting a plain
// `transition` on list covers would therefore re-fade every row remount while
// scrolling, which reads as shimmer, not polish. This registry gives the
// Spotify behavior instead: a cover fades in the FIRST time it appears this
// session, and paints instantly ever after.
//
// The grace window keeps the fade alive across re-renders that land while the
// first load is still in flight (a mid-load re-render would otherwise flip the
// prop to 0 and cancel the fade). A remount inside that window re-fades once —
// rare, and 180ms is subtle. The failure mode of every edge case is "no fade",
// i.e. exactly the pre-existing behavior; playback and layout are untouched.
//
// Plain function, not a hook, so it can be called inside list renderItem and
// .map() bodies.

const FADE_MS = 180;
const GRACE_MS = 1000;

// uri -> timestamp of the first render that showed it this session.
const firstSeen = new Map<string, number>();

export function coverFade(uri?: string | null): number {
  if (!uri) return 0;
  const now = Date.now();
  const first = firstSeen.get(uri);
  if (first === undefined) {
    firstSeen.set(uri, now);
    return FADE_MS;
  }
  return now - first < GRACE_MS ? FADE_MS : 0;
}
