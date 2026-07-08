import { supabase } from './supabase';
import { maskHiddenProfile } from './hiddenProfile';

// Premium "Follower insights" data layer.
//  • "Doesn't follow you back" is derived LIVE from the follows graph — people I
//    follow whose follow-back is missing. No history needed.
//  • "Unfollowed you" needs history (a deleted follow leaves no trace), so it
//    reads the follow_events log (supabase/sql/follower_insights.sql). Without the
//    SQL applied it just returns [] — the first tab still works.

export type InsightUser = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  badge_tier?: string | null;
  badge_show?: boolean | null;
  hidden?: boolean | null;
  unfollowed_at?: string;
};

const PROFILE_COLS = 'id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden';

async function myId(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/** People I follow who don't follow me back (newest follow first). */
export async function fetchNotFollowingBack(): Promise<InsightUser[]> {
  const uid = await myId();
  if (!uid) return [];
  try {
    const [followingRes, followersRes] = await Promise.all([
      supabase
        .from('follows')
        .select(`following_id, profiles!follows_following_id_fkey(${PROFILE_COLS})`)
        .eq('follower_id', uid),
      supabase.from('follows').select('follower_id').eq('following_id', uid),
    ]);
    const followerSet = new Set((followersRes.data ?? []).map((f: any) => f.follower_id));
    return (followingRes.data ?? [])
      .filter((f: any) => f.profiles && !followerSet.has(f.following_id))
      .map((f: any) => maskHiddenProfile(f.profiles, false))
      .filter(Boolean) as InsightUser[];
  } catch {
    return [];
  }
}

/**
 * People who unfollowed me in the last `days`, most recent first, EXCLUDING
 * anyone who has since re-followed. Reads follow_events; empty without the SQL.
 */
export async function fetchRecentUnfollowers(days = 30): Promise<InsightUser[]> {
  const uid = await myId();
  if (!uid) return [];
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data: events, error } = await supabase
      .from('follow_events')
      .select('follower_id, created_at')
      .eq('following_id', uid)
      .eq('action', 'unfollow')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error || !events?.length) return [];

    // Latest unfollow per person.
    const latest = new Map<string, string>();
    for (const e of events as any[]) if (!latest.has(e.follower_id)) latest.set(e.follower_id, e.created_at);
    const ids = [...latest.keys()];

    // Drop anyone who currently follows me again (they re-followed).
    const { data: current } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('following_id', uid)
      .in('follower_id', ids);
    const stillFollowing = new Set((current ?? []).map((f: any) => f.follower_id));
    const gone = ids.filter((id) => !stillFollowing.has(id));
    if (!gone.length) return [];

    const { data: profiles } = await supabase.from('profiles').select(PROFILE_COLS).in('id', gone);
    const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    return gone
      .map((id) => {
        const p = byId.get(id);
        if (!p) return null;
        const masked = maskHiddenProfile(p, false) as InsightUser | null;
        return masked ? { ...masked, unfollowed_at: latest.get(id) } : null;
      })
      .filter(Boolean) as InsightUser[];
  } catch {
    return [];
  }
}
