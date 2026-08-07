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

/**
 * The Films page's four rows, from ONE query.
 *
 * They are different ORDERINGS and SLICES of the same catalogue rather than
 * four round-trips: films are the rarest content on the platform, so paying for
 * four queries to shuffle the same few dozen rows would be waste — and a row
 * that disappeared because its own request failed would look like missing
 * content rather than a network blip.
 */
export async function fetchFilmCatalog(userId: string | null, limit = 60): Promise<{
  recommended: any[];
  trending: any[];
  short: any[];
  long: any[];
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

  // Recommended = the same affinity engine the rest of the app ranks by.
  const recommended = await rankVideosForUser(films, userId);

  // Trending = engagement weighted against age, so a strong film from this week
  // outranks an older one that has simply had longer to accumulate taps.
  const now = Date.now();
  const heat = (p: any) => {
    const likes = p.likes?.[0]?.count ?? 0;
    const comments = p.comments?.[0]?.count ?? 0;
    const streams = p.stream_count ?? 0;
    const ageHours = Math.max(1, (now - new Date(p.created_at).getTime()) / 3_600_000);
    return (likes * 3 + comments * 5 + streams) / Math.pow(ageHours + 2, 0.6);
  };
  const trending = [...films].sort((a, b) => heat(b) - heat(a));

  const dur = (p: any) => p.duration_seconds ?? 0;
  return {
    recommended,
    trending,
    short: recommended.filter((p) => dur(p) <= SHORT_FILM_MAX_SEC),
    long: recommended.filter((p) => dur(p) > SHORT_FILM_MAX_SEC),
  };
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
