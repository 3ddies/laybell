import { supabase } from './supabase';
import { aspectToNumber } from './aspectRatio';

// Laybell TV data layer — a discovery surface for HORIZONTAL video only. No new
// media types: a "TV video" is just an existing video post whose aspect ratio
// is landscape (aspect_ratio > 1). Detection mirrors the reel viewer (there's
// no DB column for orientation on posts — aspect_ratio drives everything).

export function isHorizontalVideo(p: any): boolean {
  return p?.type === 'video' && aspectToNumber(p?.aspect_ratio, 9 / 16) > 1;
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

/** Matches a horizontal video against a text query (title/caption). */
export function matchesQuery(p: any, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${p?.caption ?? ''} ${p?.profiles?.display_name ?? ''} ${p?.profiles?.username ?? ''}`.toLowerCase();
  return hay.includes(needle);
}
