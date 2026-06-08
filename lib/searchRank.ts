// Relevance ranking helpers for search results, shared by Explore and Music.
// "Tier" = how closely a result resembles the query (higher = closer): exact >
// starts-with > contains > matched-only-via-author. Ties are broken by the
// post's algorithm score (scorePost) so virality surfaces among equal matches.

export function postMatchTier(item: any, q: string): number {
  const fields = [item.caption, item.profiles?.username, item.profiles?.display_name]
    .map((s: any) => (s || '').toLowerCase());
  if (fields.some((f: string) => f === q)) return 4;
  if (fields.some((f: string) => f.startsWith(q))) return 3;
  if (fields.some((f: string) => f.includes(q))) return 2;
  return 1; // pulled in via author match but no direct text hit
}

export function profileMatchTier(p: any, q: string): number {
  const fields = [(p.username || '').toLowerCase(), (p.display_name || '').toLowerCase()];
  if (fields.some((f) => f === q)) return 3;
  if (fields.some((f) => f.startsWith(q))) return 2;
  return 1;
}
