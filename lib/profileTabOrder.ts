// Profile sub-tab ordering — surface what a profile actually HAS.
//
// Posts is pinned first always (it is the profile's front page, and the outer
// pager's exit-swipe depends on index 0 being Posts — see stepForGesture in
// both profile screens). The remaining tabs sort by how much content they
// hold, so a producer who posts beats and never reposts sees Music before
// Reposts, and someone the other way round sees the reverse.
//
// Ordering is pure and derived from data already in memory (the per-tab
// filters the screens were doing anyway), so it costs one pass over loaded
// rows and no extra queries.
//
// DEFAULT ORDER IS THE FINAL TIEBREAK, which is what makes the empty case
// correct for free: a profile with nothing in any tab sorts entirely on the
// default index and comes out exactly as it was before this existed.

export type TabContent = {
  /** How many items the tab would show. */
  count: number;
  /** ISO timestamp of the newest item, '' when there are none. */
  latest: string;
};

const EMPTY: TabContent = { count: 0, latest: '' };

/** Summarize a tab's rows. Tolerates missing or odd timestamps — a row with no
 *  usable date just never wins the recency tiebreak. */
export function tabContent(rows: readonly any[] | null | undefined): TabContent {
  const list = rows ?? [];
  let latest = '';
  for (const r of list) {
    const t = String(r?.created_at ?? r?.updated_at ?? '');
    if (t > latest) latest = t;
  }
  return { count: list.length, latest };
}

/**
 * @param defaultKeys the screen's own tab order, used verbatim as the fallback
 *   (the two profile screens genuinely differ — one ends playlists/reposts, the
 *   other reposts/playlists — so this is passed in rather than hardcoded).
 * @param content     per-key counts/recency; missing keys count as empty.
 * @param hasPosts    false when the profile has no posts at all (never posted,
 *   or archived/removed everything) — the caller's cue to keep the default
 *   order rather than re-rank a profile with nothing to rank.
 */
export function orderProfileTabs(
  defaultKeys: readonly string[],
  content: Record<string, TabContent>,
  hasPosts: boolean,
): string[] {
  if (!hasPosts || !defaultKeys.includes('posts')) return [...defaultKeys];
  const rest = defaultKeys.filter((k) => k !== 'posts');
  rest.sort((a, b) => {
    const A = content[a] ?? EMPTY;
    const B = content[b] ?? EMPTY;
    if (B.count !== A.count) return B.count - A.count;             // more content first
    const byRecency = String(B.latest).localeCompare(String(A.latest));
    if (byRecency !== 0) return byRecency;                          // then freshest
    return defaultKeys.indexOf(a) - defaultKeys.indexOf(b);         // then as authored
  });
  return ['posts', ...rest];
}
