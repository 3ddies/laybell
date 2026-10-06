import { supabase } from './supabase';
import { maskHiddenProfile } from './hiddenProfile';

// "Who engaged with this post" — powers the list opened by tapping a like count.
// Likers and reposters are shown by name (both are already public actions). Saves
// stay private: callers read `saveCount` for the owner's own post and never list
// savers, so no change to the locked-down `saves` RLS is needed.

export type EngagementUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  badge_tier?: string | null;
  badge_show?: boolean | null;
  profile_theme?: string | null;
  hidden?: boolean | null;
};

const PROFILE_COLS = 'id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden';

export type PostEngagement = {
  ownerId: string | null;
  likeCount: number;
  saveCount: number;
  repostCount: number;
};

// Authoritative counts + owner, read from the post row's trigger-maintained
// denormalized columns — so the owner's save count never needs to touch the
// private `saves` rows.
export async function fetchPostEngagement(postId: string): Promise<PostEngagement> {
  const { data } = await supabase
    .from('posts')
    .select('user_id, like_count, save_count, repost_count')
    .eq('id', postId)
    .maybeSingle();
  const row = data as any;
  return {
    ownerId: row?.user_id ?? null,
    likeCount: row?.like_count ?? 0,
    saveCount: row?.save_count ?? 0,
    repostCount: row?.repost_count ?? 0,
  };
}

// Pull recent actor ids from an engagement table, then hydrate profiles in a
// second query — likes/reposts FK to auth.users (not profiles), so a PostgREST
// embed isn't available. De-dupes while preserving recency order; hidden
// accounts read as "Hidden account" (the viewer's own row stays real).
async function fetchActors(
  table: 'likes' | 'reposts',
  postId: string,
  viewerId: string | null,
  limit: number,
  offset: number,
): Promise<EngagementUser[]> {
  const { data: rows } = await supabase
    .from(table)
    .select('user_id, created_at')
    .eq('post_id', postId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of (rows ?? []) as any[]) {
    if (r.user_id && !seen.has(r.user_id)) { seen.add(r.user_id); ids.push(r.user_id); }
  }
  if (ids.length === 0) return [];
  const { data: profs } = await supabase.from('profiles').select(PROFILE_COLS).in('id', ids);
  const byId = new Map((profs ?? []).map((p: any) => [p.id, p]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p: any) => maskHiddenProfile(p, p.id === viewerId))
    .filter(Boolean) as EngagementUser[];
}

export function fetchLikers(postId: string, viewerId: string | null, limit = 100, offset = 0) {
  return fetchActors('likes', postId, viewerId, limit, offset);
}

export function fetchReposters(postId: string, viewerId: string | null, limit = 100, offset = 0) {
  return fetchActors('reposts', postId, viewerId, limit, offset);
}
