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
