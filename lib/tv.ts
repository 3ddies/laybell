import { supabase } from './supabase';
import { aspectToNumber } from './aspectRatio';
import { buildAffinityProfile, loadSeenPostIds, scorePost } from './feedScorer';

// Laybell TV data layer — a discovery surface for HORIZONTAL video only. No new
// media types: a "TV video" is just an existing video post whose aspect ratio
// is landscape (aspect_ratio > 1). Detection mirrors the reel viewer (there's
// no DB column for orientation on posts — aspect_ratio drives everything).

export function isHorizontalVideo(p: any): boolean {
  return p?.type === 'video' && aspectToNumber(p?.aspect_ratio, 9 / 16) > 1;
}

// A FILM = landscape video past the free 9-minute window (Premium+ posts them;
// everyone watches free). The 540 boundary matches FILM_MIN_SEC in
// lib/entitlements.ts and the enforce_film_rights trigger in premium_plus.sql.
export function isFilm(p: any): boolean {
  return isHorizontalVideo(p) && (p?.duration_seconds ?? 0) > 540;
}

/**
 * The Films shelf: public films ranked by the SAME relevance engine as
 * everything else (affinity + follows + engagement decay − seen), so the shelf
 * is "recommended to you", not just newest. Returns [] until any films exist —
 * the shelf hides itself.
 */
export async function fetchFilms(userId: string | null, limit = 12): Promise<any[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, profiles!posts_user_id_fkey (username, display_name, badge_tier, badge_show, profile_theme), likes(count), comments(count)')
    .eq('type', 'video')
    .eq('is_public', true)
    .gt('duration_seconds', 540)
    .order('created_at', { ascending: false })
    .limit(limit * 2);
  if (error) throw error;
  const films = (data ?? []).filter((p: any) => !p.archived_at && isHorizontalVideo(p));
  return (await rankVideosForUser(films, userId)).slice(0, limit);
}

/** A film at or under this runs in the "Short films" row; longer ones are features. */
export const SHORT_FILM_MAX_SEC = 20 * 60;

// A row has to look like a row. Fewer than this and it reads as a stub, so the
// films go to the general grid instead.
const MIN_ROW = 3;
// Below this the catalogue is too small for any SUBJECTIVE cut to mean
// anything — "Recommended" and "Trending" over four films is just the same four
// films twice, which teaches users the labels are decorative.
const MIN_CATALOGUE_FOR_CURATION = 8;
// Trending must reflect actual attention, not merely existing.
const TRENDING_MIN_ENGAGEMENT = 3;

/**
 * The Films page, from ONE query.
 *
 * Rows are a PARTITION, not four views of the same list: every film appears in
 * at most one row, and each row must earn its place — a category that can't be
 * filled honestly is omitted rather than padded. Whatever isn't claimed falls
 * to a general grid, which is the honest home for "films we have" as opposed to
 * "films chosen for you".
 *
 * One request rather than four: films are the rarest content on the platform,
 * so paying for four queries to reshuffle the same few dozen rows is waste —
 * and a row that vanished because its own request failed would read as missing
 * content rather than a network blip.
 */
export async function fetchFilmCatalog(userId: string | null, limit = 60): Promise<{
  recommended: any[];
  trending: any[];
  short: any[];
  long: any[];
  /** Everything no row claimed — rendered as a scrollable grid. */
  more: any[];
}> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, profiles!posts_user_id_fkey (username, display_name, badge_tier, badge_show, profile_theme), likes(count), comments(count)')
    .eq('type', 'video')
    .eq('is_public', true)
    .gt('duration_seconds', 540)
    .order('created_at', { ascending: false })
    .limit(limit * 2);
  if (error) throw error;
  const films = (data ?? []).filter((p: any) => !p.archived_at && isHorizontalVideo(p)).slice(0, limit);

  const now = Date.now();
  const engagement = (p: any) =>
    (p.likes?.[0]?.count ?? 0) * 3 + (p.comments?.[0]?.count ?? 0) * 5 + (p.stream_count ?? 0);
  // Weighted against age, so a strong film from this week outranks an older one
  // that has merely had longer to accumulate taps.
  const heat = (p: any) => {
    const ageHours = Math.max(1, (now - new Date(p.created_at).getTime()) / 3_600_000);
    return engagement(p) / Math.pow(ageHours + 2, 0.6);
  };

  // Each film is claimed at most once. Without this every row was the same
  // handful of films reordered, which is what made the labels meaningless.
  const claimed = new Set<string>();
  const claim = (rows: any[]) => { rows.forEach((p) => claimed.add(p.id)); return rows; };
  const unclaimed = (arr: any[]) => arr.filter((p) => !claimed.has(p.id));
  // A row ships only if it can be filled honestly; otherwise its films stay in
  // the pool for the grid.
  const rowOrNothing = (arr: any[]) => (arr.length >= MIN_ROW ? claim(arr.slice(0, 12)) : []);

  const curate = films.length >= MIN_CATALOGUE_FOR_CURATION;

  // TRENDING — real attention only. Films nobody has watched are not trending,
  // they are simply the films that exist.
  const trending = curate
    ? rowOrNothing([...films].filter((p) => engagement(p) >= TRENDING_MIN_ENGAGEMENT).sort((a, b) => heat(b) - heat(a)))
    : [];

  // RECOMMENDED — needs someone to recommend TO. rankVideosForUser returns the
  // input order unchanged for a signed-out or history-less viewer, and calling
  // that "Recommended" would be a lie, so the row is dropped when the ranking
  // didn't actually reorder anything.
  let recommended: any[] = [];
  if (curate && userId) {
    const ranked = await rankVideosForUser(films, userId);
    const personalised = ranked.some((p, i) => p.id !== films[i]?.id);
    if (personalised) recommended = rowOrNothing(unclaimed(ranked));
  }

  // LENGTH — objective, so these need no curation gate; they just need enough
  // unclaimed films to look like rows.
  const dur = (p: any) => p.duration_seconds ?? 0;
  const short = rowOrNothing(unclaimed(films).filter((p) => dur(p) <= SHORT_FILM_MAX_SEC));
  const long = rowOrNothing(unclaimed(films).filter((p) => dur(p) > SHORT_FILM_MAX_SEC));

  // Whatever no row earned. Newest first — the honest default.
  return { recommended, trending, short, long, more: unclaimed(films) };
}

/**
 * Public horizontal videos, newest first — the TV Videos grid. Fetches a wide
 * window of recent videos and keeps the landscape ones (aspect_ratio isn't
 * indexable as a computed comparison, so the landscape filter is client-side).
 */
export async function fetchHorizontalVideos(limit = 60): Promise<any[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, profiles!posts_user_id_fkey (username, display_name, badge_tier, badge_show, profile_theme), likes(count), comments(count)')
    .eq('type', 'video')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(limit * 3);
  if (error) throw error;
  return (data ?? [])
    .filter((p: any) => !p.archived_at && isHorizontalVideo(p))
    .slice(0, limit);
}

/**
 * Personalize the horizontal-video list for one user — same relevance engine the
 * home/explore feeds use (lib/feedScorer): time-decayed engagement lifted by the
 * user's creator/type/genre affinity, follows, earned badges, minus a seen
 * penalty. The TV screen takes the top few of this as the "Recommended" row.
 * Falls back to the incoming order (newest-first) for a signed-out or cold user.
 */
export async function rankVideosForUser(videos: any[], userId: string | null): Promise<any[]> {
  if (!userId || videos.length === 0) return videos;
  try {
    const [profile, followingRes, seen] = await Promise.all([
      buildAffinityProfile(userId),
      supabase.from('follows').select('following_id').eq('follower_id', userId),
      loadSeenPostIds(),
    ]);
    const followingSet = new Set<string>((followingRes.data ?? []).map((f: any) => f.following_id));
    const now = Date.now();
    return [...videos].sort(
      (a, b) => scorePost(b, profile, followingSet, seen, now) - scorePost(a, profile, followingSet, seen, now),
    );
  } catch {
    return videos;
  }
}

/** Matches a horizontal video against a text query (film title/caption/author). */
export function matchesQuery(p: any, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${p?.film_title ?? ''} ${p?.caption ?? ''} ${p?.profiles?.display_name ?? ''} ${p?.profiles?.username ?? ''}`.toLowerCase();
  return hay.includes(needle);
}
