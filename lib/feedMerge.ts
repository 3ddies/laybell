// How the Home feed's saved first screen (lib/feedSnapshot) meets the fresh feed.
// Pure, so it can be tested without a phone: scripts/tests/test-feedmerge.mjs.

type FeedItem = { id: string; __ad?: unknown; __spotlight?: unknown };

/**
 * The posts worth saving: the head of the feed, organic posts only. Ads and
 * spotlights carry impression tracking and campaign windows, so they are never
 * replayed from a cache.
 */
export function snapshotHead<T extends FeedItem>(feed: T[], size: number): T[] {
  return feed.filter((p) => !p.__ad && !p.__spotlight).slice(0, size);
}

/**
 * The fresh feed, arriving after the reader has started scrolling the saved one:
 * what is on screen stays exactly where it is, and the fresh feed continues below
 * it without the posts already shown — a spotlight of one of them included, since a
 * spotlight carries its post's id.
 */
export function mergeFreshBelow<T extends FeedItem>(shown: T[], fresh: T[]): T[] {
  const shownIds = new Set(shown.map((p) => p.id));
  return [...shown, ...fresh.filter((p) => !shownIds.has(p.id))];
}
