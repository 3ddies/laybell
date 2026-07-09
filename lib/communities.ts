import { supabase } from './supabase';
import { rawTier, tierRank, evaluateBadgesDebounced, type ProfileBadgeFields } from './badges';

// Communities + community hashtags — data layer.
// Schema + RLS + RPCs live in supabase/sql/communities.sql. Everything here
// degrades gracefully: if the SQL isn't applied yet, the queries/rpcs reject, we
// catch, and the app behaves as if there are simply no communities (the button
// opens an empty discovery screen, the post picker shows the locked empty state).

// A post can be tagged into at most this many communities (also enforced by the
// community_post_guard trigger in supabase/sql/communities.sql).
export const MAX_POST_COMMUNITIES = 3;

export type CommunityRole = 'owner' | 'manager' | 'member';
export type CommunityStatus = 'pending' | 'live' | 'archived';
export type MemberStatus = 'invited' | 'active' | 'banned';

export type Community = {
  id: string;
  name: string;
  hashtag: string;
  genre: string;
  guidelines: string | null;
  banner_url: string | null;
  owner_id: string | null;
  status: CommunityStatus;
  member_count: number;
  post_count: number;
  created_at: string;
  // Laybell-owned "official" communities: default topic tabs everyone can browse
  // and post to WITHOUT joining. `space='girl'` marks the feminine "Girl space"
  // tabs (down-ranked for men in the feed, see lib/feedScorer). `open_posting`
  // lets any user post (the post guard skips the membership check).
  is_official?: boolean;
  space?: string | null;
  open_posting?: boolean;
  // Present when the row was fetched in the context of the current user's
  // membership (the discovery "Your communities" rail, the detail screen).
  myRole?: CommunityRole | null;
  myStatus?: MemberStatus | null;
};

export type CommunityMember = {
  user_id: string;
  role: CommunityRole;
  status: MemberStatus;
  muted_until: string | null;
  joined_at: string | null;
  profile?: {
    id: string;
    username?: string | null;
    display_name?: string | null;
    avatar_url?: string | null;
    badge_tier?: string | null;
    badge_show?: boolean | null;
  } | null;
};

export type CommunityInvite = { user_id: string; role: CommunityRole };

// `founder` groups communities by their founding user for the "one per founder"
// rule (owner_id, or 'laybell' for the official tabs, or the id as a unique
// fallback). The composer blocks picking two communities with the same founder.
export type PostableCommunity = { id: string; name: string; hashtag: string; genre: string; founder: string };

export type CommunityRails = {
  mine: Community[];        // active memberships (any role)
  invites: Community[];     // pending invites awaiting a response
  recommended: Community[]; // live, not joined, in genres you're active in
  trending: Community[];    // live, not joined, most members
  explore: Community[];     // live, not joined, newest first
};

const EMPTY_RAILS: CommunityRails = { mine: [], invites: [], recommended: [], trending: [], explore: [] };

// Minimum-tier gate for creating a community (Diamond). Manager appointment
// (Gold) is enforced server-side at appointment time.
export function canCreateCommunity(profile: ProfileBadgeFields | null | undefined): boolean {
  return tierRank(rawTier(profile)) >= tierRank('diamond');
}

// The discovery screen's rails in one shot.
export async function fetchCommunityRails(userId: string | null): Promise<CommunityRails> {
  try {
    const mine: Community[] = [];
    const invites: Community[] = [];
    const joinedIds = new Set<string>();

    if (userId) {
      const { data, error } = await supabase
        .from('community_members')
        .select('role, status, communities(*)')
        .eq('user_id', userId)
        .in('status', ['active', 'invited']);
      if (error) throw error;
      for (const r of (data as any[]) ?? []) {
        const c = r.communities;
        if (!c || c.status === 'archived') continue;
        joinedIds.add(c.id);
        const withRole: Community = { ...c, myRole: r.role, myStatus: r.status };
        if (r.status === 'active') mine.push(withRole);
        else invites.push(withRole);
      }
    }

    // Most-joined live communities feed Trending + Recommended.
    const { data: live } = await supabase
      .from('communities')
      .select('*')
      .eq('status', 'live')
      .order('member_count', { ascending: false })
      .limit(60);
    const liveNotJoined = ((live as Community[]) ?? []).filter((c) => !joinedIds.has(c.id));

    const myGenres = new Set(mine.map((c) => c.genre));
    const recommended = liveNotJoined.filter((c) => myGenres.has(c.genre)).slice(0, 12);
    const trending = liveNotJoined.slice(0, 12);

    // Newest live communities for the Explore rail.
    const { data: newest } = await supabase
      .from('communities')
      .select('*')
      .eq('status', 'live')
      .order('created_at', { ascending: false })
      .limit(30);
    const explore = ((newest as Community[]) ?? []).filter((c) => !joinedIds.has(c.id));

    return { mine, invites, recommended, trending, explore };
  } catch {
    return EMPTY_RAILS;
  }
}

export async function searchCommunities(query: string): Promise<Community[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const { data } = await supabase
      .from('communities')
      .select('*')
      .eq('status', 'live')
      .ilike('name', `%${q}%`)
      .order('member_count', { ascending: false })
      .limit(30);
    return (data as Community[]) ?? [];
  } catch {
    return [];
  }
}

// A single community + the current user's relationship to it.
export async function fetchCommunity(id: string, userId: string | null): Promise<Community | null> {
  try {
    const { data, error } = await supabase.from('communities').select('*').eq('id', id).single();
    if (error || !data) return null;
    const community = data as Community;
    if (userId) {
      const { data: mem } = await supabase
        .from('community_members')
        .select('role, status')
        .eq('community_id', id)
        .eq('user_id', userId)
        .maybeSingle();
      community.myRole = (mem as any)?.role ?? null;
      community.myStatus = (mem as any)?.status ?? null;
    }
    return community;
  } catch {
    return null;
  }
}

// Full roster (active + invited + banned). Profiles are fetched separately and
// merged — community_members.user_id references auth.users, not profiles, so a
// PostgREST embed wouldn't resolve.
export async function fetchCommunityMembers(id: string): Promise<CommunityMember[]> {
  try {
    const { data: members } = await supabase
      .from('community_members')
      .select('user_id, role, status, muted_until, joined_at')
      .eq('community_id', id)
      .order('role', { ascending: true })
      .order('joined_at', { ascending: true });
    const rows = (members as CommunityMember[]) ?? [];
    if (rows.length === 0) return [];
    const ids = rows.map((m) => m.user_id);
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, badge_tier, badge_show')
      .in('id', ids);
    const byId: Record<string, any> = Object.fromEntries(((profs as any[]) ?? []).map((p) => [p.id, p]));
    return rows.map((m) => ({ ...m, profile: byId[m.user_id] ?? null }));
  } catch {
    return [];
  }
}

// Public posts attributed to this community (the grid). Anyone may view.
export async function fetchCommunityPosts(id: string): Promise<any[]> {
  try {
    const { data } = await supabase
      .from('posts')
      .select('*, profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme), likes(count), comments(count)')
      .contains('community_ids', [id]) // a post can be in several communities
      .eq('is_public', true)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(60);
    return (data as any[]) ?? [];
  } catch {
    return [];
  }
}

// Live communities the user can post into right now (active, not muted) — for
// the post composer's "Community" picker.
export async function fetchMyPostableCommunities(userId: string | null): Promise<PostableCommunity[]> {
  if (!userId) return [];
  try {
    // Two sources, merged: communities the user is an active member of, PLUS the
    // Laybell-official open-posting tabs (anyone can post to those without joining).
    const [memberRes, officialRes] = await Promise.all([
      supabase
        .from('community_members')
        .select('muted_until, communities!inner(id, name, hashtag, genre, status, owner_id, is_official)')
        .eq('user_id', userId)
        .eq('status', 'active')
        .eq('communities.status', 'live'),
      supabase
        .from('communities')
        .select('id, name, hashtag, genre, owner_id, is_official')
        .eq('status', 'live')
        .eq('is_official', true)
        .eq('open_posting', true),
    ]);
    const now = Date.now();
    const out = new Map<string, PostableCommunity>();
    const founderOf = (c: any): string => c.owner_id ?? (c.is_official ? 'laybell' : c.id);
    for (const r of (memberRes.data as any[]) ?? []) {
      const c = r.communities;
      if (c && (!r.muted_until || new Date(r.muted_until).getTime() < now)) {
        out.set(c.id, { id: c.id, name: c.name, hashtag: c.hashtag, genre: c.genre, founder: founderOf(c) });
      }
    }
    for (const c of (officialRes.data as any[]) ?? []) {
      out.set(c.id, { id: c.id, name: c.name, hashtag: c.hashtag, genre: c.genre, founder: founderOf(c) });
    }
    return [...out.values()];
  } catch {
    return [];
  }
}

// The Laybell-owned "official" topic tabs, in a stable order for the Explore rail.
// Everyone can browse these without joining (they're always 'live').
export async function fetchOfficialCommunities(): Promise<Community[]> {
  try {
    const { data } = await supabase
      .from('communities')
      .select('*')
      .eq('is_official', true)
      .eq('status', 'live')
      .order('name', { ascending: true });
    return (data as Community[]) ?? [];
  } catch {
    return [];
  }
}

// Ids of the feminine "Girl space" official communities, cached briefly (the set
// is tiny and static). Used by the feed to soft-down-rank these posts for men.
let _girlSpaceCache: { ids: Set<string>; at: number } | null = null;
export async function fetchGirlSpaceCommunityIds(): Promise<Set<string>> {
  if (_girlSpaceCache && Date.now() - _girlSpaceCache.at < 3_600_000) return _girlSpaceCache.ids;
  try {
    const { data } = await supabase.from('communities').select('id').eq('space', 'girl');
    const ids = new Set<string>(((data as any[]) ?? []).map((c) => c.id as string));
    _girlSpaceCache = { ids, at: Date.now() };
    return ids;
  } catch {
    return _girlSpaceCache?.ids ?? new Set<string>();
  }
}

// ── Mutations (all routed through the SECURITY DEFINER rpcs) ──────────────────

export async function createCommunity(opts: {
  name: string; genre: string; guidelines: string; invites: CommunityInvite[];
}): Promise<{ id?: string; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('community_create', {
      p_name: opts.name,
      p_genre: opts.genre,
      p_guidelines: opts.guidelines,
      p_invites: opts.invites,
    });
    if (error) return { error: friendlyRpcError(error) };
    evaluateBadgesDebounced(); // owning a community → Silver community badge
    return { id: data as string };
  } catch (e: any) {
    return { error: friendlyRpcError(e) };
  }
}

export async function joinCommunity(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('community_join', { p_community: id });
    if (!error) evaluateBadgesDebounced(); // active membership → Bronze community badge
    return !error;
  } catch { return false; }
}

export async function leaveCommunity(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('community_leave', { p_community: id });
    if (!error) evaluateBadgesDebounced(); // leaving your last one may drop the badge
    return !error;
  } catch { return false; }
}

export async function respondInvite(id: string, accept: boolean): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('community_respond_invite', { p_community: id, p_accept: accept });
    if (!error && accept) evaluateBadgesDebounced(); // accepting = joining
    return !error;
  } catch { return false; }
}

export async function setMemberRole(id: string, target: string, role: CommunityRole): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('community_set_role', { p_community: id, p_target: target, p_role: role });
    return error ? { ok: false, error: friendlyRpcError(error) } : { ok: true };
  } catch (e: any) { return { ok: false, error: friendlyRpcError(e) }; }
}

export async function moderateMember(
  id: string, target: string, action: 'ban' | 'unban' | 'mute' | 'unmute' | 'remove', muteMinutes = 60,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('community_moderate', {
      p_community: id, p_target: target, p_action: action, p_mute_minutes: muteMinutes,
    });
    return error ? { ok: false, error: friendlyRpcError(error) } : { ok: true };
  } catch (e: any) { return { ok: false, error: friendlyRpcError(e) }; }
}

export async function inviteMembers(id: string, userIds: string[]): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('community_invite', {
      p_community: id, p_users: userIds.map((u) => ({ user_id: u })),
    });
    return !error;
  } catch { return false; }
}

export async function updateGuidelines(id: string, guidelines: string): Promise<boolean> {
  try { const { error } = await supabase.rpc('community_update_guidelines', { p_community: id, p_guidelines: guidelines }); return !error; }
  catch { return false; }
}

// Owner-only: edit the core fields (name, hashtag, genre, guidelines, banner).
export async function updateCommunity(opts: {
  id: string; name: string; hashtag: string; genre: string; guidelines: string; bannerUrl: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.rpc('community_update', {
      p_community: opts.id,
      p_name: opts.name,
      p_hashtag: opts.hashtag,
      p_genre: opts.genre,
      p_guidelines: opts.guidelines,
      p_banner_url: opts.bannerUrl,
    });
    return error ? { ok: false, error: friendlyRpcError(error) } : { ok: true };
  } catch (e: any) { return { ok: false, error: friendlyRpcError(e) }; }
}

// Map raw Postgres exceptions to the translation keys the screens render.
function friendlyRpcError(err: any): string {
  const raw = String(err?.message ?? err ?? '').toLowerCase();
  if (raw.includes('name taken')) return 'communities.errNameTaken';
  if (raw.includes('name too short')) return 'communities.errNameShort';
  if (raw.includes('hashtag taken')) return 'communities.errHashtagTaken';
  if (raw.includes('hashtag too short')) return 'communities.errHashtagShort';
  if (raw.includes('diamond badge')) return 'communities.errNeedDiamond';
  if (raw.includes('gold badge') || raw.includes('manager must')) return 'communities.errNeedGold';
  if (raw.includes('banned')) return 'communities.errBanned';
  if (raw.includes('not live')) return 'communities.errNotLive';
  return 'communities.errGeneric';
}
