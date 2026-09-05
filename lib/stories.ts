import { supabase } from './supabase';
import { createNotification } from './createNotification';
import { maskHiddenProfile } from './hiddenProfile';
import { removePublicUrls } from './storageCleanup';

// 24-hour stories. Schema + RLS live in supabase/sql/stories.sql.
// A story is an ephemeral image/video visible to the author and their followers
// for 24h after posting. story_views drives the unseen/seen ring in the tray.

export type StoryProfile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  badge_tier?: string | null;
  badge_show?: boolean | null;
};

export type Story = {
  id: string;
  user_id: string;
  media_url: string;
  media_type: 'image' | 'video';
  thumbnail_url: string | null;
  caption: string | null;
  aspect_ratio: string | null;
  duration_seconds: number | null;
  created_at: string;
  expires_at: string;
  seen?: boolean;
  // Another creator's track used on this story (denormalised — see post_song.sql).
  song_id?: string | null;
  song_title?: string | null;
  song_artist?: string | null;
  song_artist_id?: string | null;
  // Deprecated single-caption placement (story_caption_style.sql).
  caption_style?: { x: number; y: number; scale: number; rotation: number } | null;
  // Draggable text/emoji stickers placed anywhere on the media — see
  // story_stickers.sql. The optional style fields (font/color/bg/emoji) are
  // resolved by components/StickerLayer's resolveSticker() in editor + viewer.
  stickers?: StorySticker[] | null;
};

export type StorySticker = {
  text: string; x: number; y: number; scale: number; rotation: number;
  font?: string; color?: string; bg?: string; emoji?: boolean;
};

export type StoryGroup = {
  user: StoryProfile;
  stories: Story[];
  hasUnseen: boolean;
};

// Screen-space rect of the tapped avatar/thumbnail, used to animate the viewer
// expanding out of it (and shrinking back into it) — Instagram-style.
export type SourceRect = { x: number; y: number; width: number; height: number };

// Upload a local file to the public 'stories' bucket; returns its public URL.
// Mirrors the FormData upload used by the post composer (app/(tabs)/post.tsx).
export async function uploadStoryMedia(
  userId: string,
  uri: string,
  ext: string,
  mime: string,
): Promise<string> {
  const name = `${Date.now()}.${ext}`;
  const path = `${userId}/${name}`;
  const form = new FormData();
  form.append('file', { uri, name, type: mime } as any);
  const { error } = await supabase.storage.from('stories').upload(path, form, {
    contentType: mime,
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from('stories').getPublicUrl(path).data.publicUrl;
}

export async function createStory(input: {
  userId: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  thumbnailUrl?: string | null;
  caption?: string | null;
  aspectRatio?: string | null;
  durationSeconds?: number | null;
  song?: { id: string; title: string; artist: string; artistId: string } | null;
  stickers?: StorySticker[] | null;
}): Promise<void> {
  const { error } = await supabase.from('stories').insert({
    user_id: input.userId,
    media_url: input.mediaUrl,
    media_type: input.mediaType,
    ...(input.thumbnailUrl ? { thumbnail_url: input.thumbnailUrl } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.durationSeconds != null ? { duration_seconds: input.durationSeconds } : {}),
    ...(input.song
      ? { song_id: input.song.id, song_title: input.song.title, song_artist: input.song.artist, song_artist_id: input.song.artistId }
      : {}),
    ...(input.stickers && input.stickers.length ? { stickers: input.stickers } : {}),
  });
  if (error) throw error;

  // Notify the original artist when their song is used in a story (deep-links to
  // the poster's story, which is only viewable for the 24h the story is up).
  if (input.song && input.song.artistId && input.song.artistId !== input.userId) {
    createNotification({ userId: input.song.artistId, actorId: input.userId, type: 'song_story' });
  }
}

// Core loader: active (non-expired) stories for the given authors, grouped by
// author, with a per-story `seen` flag for `viewerId`. Profiles are fetched in a
// second query (manual join) because stories.user_id references auth.users, not
// profiles — so a PostgREST embed/FK hint isn't reliable here.
async function loadGroups(
  authorIds: string[],
  viewerId: string,
  localSeen: Set<string> = new Set(),
): Promise<Map<string, StoryGroup>> {
  const map = new Map<string, StoryGroup>();
  if (authorIds.length === 0) return map;

  const nowIso = new Date().toISOString();
  const { data: stories } = await supabase
    .from('stories')
    .select('*')
    .in('user_id', authorIds)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: true });

  if (!stories || stories.length === 0) return map;

  const distinctAuthors = Array.from(new Set(stories.map((s: any) => s.user_id)));
  const storyIds = stories.map((s: any) => s.id);

  const [{ data: profiles }, { data: views }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme')
      .in('id', distinctAuthors),
    supabase
      .from('story_views')
      .select('story_id')
      .eq('viewer_id', viewerId)
      .in('story_id', storyIds),
  ]);

  const profileById = new Map<string, StoryProfile>(
    (profiles ?? []).map((p: any) => [p.id, p]),
  );
  const seen = new Set<string>((views ?? []).map((v: any) => v.story_id));

  for (const s of stories as any[]) {
    if (!map.has(s.user_id)) {
      map.set(s.user_id, {
        user:
          profileById.get(s.user_id) ??
          { id: s.user_id, username: '', display_name: '', avatar_url: null },
        stories: [],
        hasUnseen: false,
      });
    }
    const group = map.get(s.user_id)!;
    // `localSeen` carries client-side views that may not have round-tripped to the
    // server yet, so a just-watched story never momentarily re-appears as unseen.
    const isSeen = seen.has(s.id) || localSeen.has(s.id);
    group.stories.push({ ...(s as Story), seen: isSeen });
    if (!isSeen) group.hasUnseen = true;
  }
  return map;
}

const lastCreatedAt = (g: StoryGroup) => g.stories[g.stories.length - 1]?.created_at ?? '';

// Fallback ordering when the relevance pass can't run (e.g. a table isn't set up):
// your own story leads, then unseen groups, then most-recent-first.
function baselineTraySort(list: StoryGroup[], userId: string): StoryGroup[] {
  return [...list].sort((a, b) => {
    if (a.user.id === userId) return -1;
    if (b.user.id === userId) return 1;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
    return lastCreatedAt(b).localeCompare(lastCreatedAt(a));
  });
}

const tierWeight = (t?: string | null): number =>
  t === 'diamond' ? 1 : t === 'gold' ? 0.75 : t === 'silver' ? 0.5 : t === 'bronze' ? 0.25 : 0;

// Rank the followed-user story groups by RELEVANCE to `viewerId`, so the most
// relevant appear first in the tray (and therefore in the viewer sequence).
// Blends: story recency, whether it's unseen, the author's badge tier, the
// viewer's own past affinity for this author's stories (liking weighted heavier
// than watching), and the story's popularity among all watchers (views + likes).
// Story replies live in DMs (not a queryable per-story count) so they fold into
// this affinity/popularity signal rather than a separate term. Bounded, parallel
// queries; throws are handled by the caller (falls back to the baseline sort).
async function rankStoryGroups(groups: StoryGroup[], viewerId: string): Promise<StoryGroup[]> {
  if (groups.length <= 1) return groups;

  const authorIds = groups.map((g) => g.user.id);
  const activeStoryIds = groups.flatMap((g) => g.stories.map((s) => s.id));
  const activeAuthor = new Map<string, string>(); // active story id -> author
  groups.forEach((g) => g.stories.forEach((s) => activeAuthor.set(s.id, g.user.id)));

  const [authorStoriesRes, myViewsRes, myLikesRes, popViewsRes, popLikesRes] = await Promise.all([
    // Every story (active + expired-but-not-deleted) by these authors → maps the
    // viewer's historical views/likes below to an author for the affinity signal.
    supabase.from('stories').select('id, user_id').in('user_id', authorIds),
    supabase.from('story_views').select('story_id').eq('viewer_id', viewerId),
    supabase.from('story_likes').select('story_id').eq('user_id', viewerId),
    supabase.from('story_views').select('story_id').in('story_id', activeStoryIds),
    supabase.from('story_likes').select('story_id').in('story_id', activeStoryIds),
  ]);

  const storyAuthor = new Map<string, string>();
  (authorStoriesRes.data ?? []).forEach((r: any) => storyAuthor.set(r.id, r.user_id));

  const watchAff: Record<string, number> = {};
  const likeAff: Record<string, number> = {};
  (myViewsRes.data ?? []).forEach((v: any) => { const a = storyAuthor.get(v.story_id); if (a) watchAff[a] = (watchAff[a] || 0) + 1; });
  (myLikesRes.data ?? []).forEach((l: any) => { const a = storyAuthor.get(l.story_id); if (a) likeAff[a] = (likeAff[a] || 0) + 1; });

  const popV: Record<string, number> = {};
  const popL: Record<string, number> = {};
  (popViewsRes.data ?? []).forEach((v: any) => { const a = activeAuthor.get(v.story_id); if (a) popV[a] = (popV[a] || 0) + 1; });
  (popLikesRes.data ?? []).forEach((l: any) => { const a = activeAuthor.get(l.story_id); if (a) popL[a] = (popL[a] || 0) + 1; });

  const now = Date.now();
  const popRaw = (a: string) => (popV[a] || 0) + 2 * (popL[a] || 0); // a like counts double a view
  const maxPop = Math.max(1, ...authorIds.map(popRaw));

  const scored = groups.map((g) => {
    const a = g.user.id;
    const newest = g.stories.reduce((m, s) => Math.max(m, Date.parse(s.created_at) || 0), 0);
    const recency = Math.max(0, Math.min(1, 1 - (now - newest) / (24 * 60 * 60 * 1000))); // 0..1 over the 24h window
    const score =
      0.35 * recency +
      0.25 * Math.min((likeAff[a] || 0) / 3, 1) +   // liking > watching
      0.12 * Math.min((watchAff[a] || 0) / 5, 1) +
      0.12 * tierWeight((g.user as any).badge_tier) +
      0.16 * (popRaw(a) / maxPop);
    return { g, score };
  });
  // Fully-watched groups always fall to the RIGHT of unwatched ones (they carry no
  // new content); relevance only orders WITHIN each partition. A group flips back to
  // the unwatched partition automatically once its author posts a new (unseen) story.
  scored.sort((x, y) =>
    (x.g.hasUnseen === y.g.hasUnseen)
      ? (y.score - x.score || lastCreatedAt(y.g).localeCompare(lastCreatedAt(x.g)))
      : (x.g.hasUnseen ? -1 : 1));
  return scored.map((s) => s.g);
}

/**
 * How many story-tellers the viewer does NOT follow get added to the tray.
 *
 * Five is the brief, and the reasoning is that it is enough to always have
 * something worth opening — so the tray is never empty for someone who follows
 * nobody, and the feature is discoverable at all — while staying well short of
 * feeling like a wall of strangers. Raising this trades that off directly.
 */
export const DISCOVERY_STORY_AUTHORS = 5;

// How many active stories to look at when picking those five. A cap, because
// this reads across the WHOLE app rather than one person's follows: without it
// the query grows with the platform and the tray gets slower for everybody as
// Laybell succeeds. Newest-first, so the cap trims the stalest candidates.
const DISCOVERY_SCAN_LIMIT = 500;

// How many AUTHORS get their engagement measured, after the scan above narrows
// the field by recency.
//
// This exists because of a URL limit, not a database one. PostgREST sends
// filters in the query string, so `.in('story_id', [...])` over 500 uuids builds
// an ~18KB URL that a gateway will reject long before Postgres sees it. Ranking
// the most recent 40 story-tellers keeps that list small, and costs nothing real:
// stories live 24 hours, so "recent" is nearly everything, and five slots cannot
// be filled from more than five of them anyway.
const DISCOVERY_RANK_AUTHORS = 40;

/**
 * The most-watched active stories from people the viewer does not follow.
 *
 * Ranked on the same currency as rankStoryGroups — a like counts double a view —
 * blended with recency so a story posted an hour ago can beat one that has been
 * accumulating views for twenty. Returns [] rather than throwing: discovery is a
 * bonus rail, and failing to compute it must never cost somebody the stories
 * they actually subscribed to.
 */
async function fetchDiscoveryGroups(
  viewerId: string,
  exclude: Set<string>,
  limit: number,
  localSeen: Set<string>,
): Promise<StoryGroup[]> {
  const nowIso = new Date().toISOString();
  const { data: active } = await supabase
    .from('stories')
    .select('id, user_id, created_at')
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(DISCOVERY_SCAN_LIMIT);
  if (!active || active.length === 0) return [];

  const candidates = (active as any[]).filter((s) => !exclude.has(s.user_id));
  if (candidates.length === 0) return [];

  const candidateAuthors = Array.from(new Set(candidates.map((s) => s.user_id)));

  // Blocked and hidden accounts are dropped BEFORE ranking, not after, so a
  // hidden author cannot occupy one of the five slots and silently shrink the
  // rail to four. `hidden` is checked in app code because there is no RLS policy
  // on profiles covering it — see the note in docs about public-surface gaps.
  const [{ data: blocks }, { data: profs }] = await Promise.all([
    supabase.from('blocks').select('blocked_id').eq('blocker_id', viewerId),
    supabase.from('profiles').select('id, hidden').in('id', candidateAuthors),
  ]);

  const blocked = new Set<string>((blocks ?? []).map((b: any) => b.blocked_id));
  const hidden = new Set<string>((profs ?? []).filter((p: any) => p.hidden).map((p: any) => p.id));
  const visible = candidates.filter((s) => !blocked.has(s.user_id) && !hidden.has(s.user_id));
  if (visible.length === 0) return [];

  // `active` came back newest-first, so first-seen order here IS recency order —
  // which is what bounds the engagement queries below to a sane size.
  const byRecency: string[] = [];
  for (const s of visible) {
    if (!byRecency.includes(s.user_id)) byRecency.push(s.user_id);
    if (byRecency.length >= DISCOVERY_RANK_AUTHORS) break;
  }
  const shortlist = new Set(byRecency);
  const allowed = visible.filter((s) => shortlist.has(s.user_id));

  const [{ data: views }, { data: likes }] = await Promise.all([
    supabase.from('story_views').select('story_id').in('story_id', allowed.map((s) => s.id)),
    supabase.from('story_likes').select('story_id').in('story_id', allowed.map((s) => s.id)),
  ]);

  const authorOf = new Map<string, string>(allowed.map((s) => [s.id, s.user_id]));
  const pop: Record<string, number> = {};
  (views ?? []).forEach((v: any) => { const a = authorOf.get(v.story_id); if (a) pop[a] = (pop[a] || 0) + 1; });
  (likes ?? []).forEach((l: any) => { const a = authorOf.get(l.story_id); if (a) pop[a] = (pop[a] || 0) + 2; });

  const now = Date.now();
  const newestOf: Record<string, number> = {};
  for (const s of allowed) {
    const t = Date.parse(s.created_at) || 0;
    if (t > (newestOf[s.user_id] ?? 0)) newestOf[s.user_id] = t;
  }

  const authors = Array.from(new Set(allowed.map((s) => s.user_id)));
  const maxPop = Math.max(1, ...authors.map((a) => pop[a] || 0));
  const top = authors
    .map((a) => ({
      a,
      score:
        0.6 * ((pop[a] || 0) / maxPop) +
        0.4 * Math.max(0, Math.min(1, 1 - (now - (newestOf[a] ?? 0)) / (24 * 60 * 60 * 1000))),
    }))
    .sort((x, y) => y.score - x.score || (newestOf[y.a] ?? 0) - (newestOf[x.a] ?? 0))
    .slice(0, limit)
    .map((s) => s.a);
  if (top.length === 0) return [];

  const map = await loadGroups(top, viewerId, localSeen);
  // Back into ranked order — loadGroups keys by author and does not preserve it.
  return top.map((id) => map.get(id)).filter((g): g is StoryGroup => !!g);
}

// The Home tray: the current user's active stories first, then active stories from
// people they follow, ordered by relevance (see rankStoryGroups), then up to
// DISCOVERY_STORY_AUTHORS of the most-watched stories from people they do NOT
// follow. Discovery goes LAST on purpose — the people you chose to follow lead
// the rail, and a viewer with no follows sees discovery immediately because
// there is nothing in front of it.
export async function fetchStoryTray(userId: string, localSeen: Set<string> = new Set()): Promise<StoryGroup[]> {
  const { data: follows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);
  const authorIds = Array.from(new Set([userId, ...followingIds]));

  const map = await loadGroups(authorIds, userId, localSeen);
  const list = Array.from(map.values());

  const own = list.find((g) => g.user.id === userId) ?? null;
  const others = list.filter((g) => g.user.id !== userId);

  // Excluded by FOLLOW, not by "has a story in the tray": somebody you follow
  // who has not posted today is still not a stranger, and surfacing them under
  // discovery would be odd. Self is excluded for the obvious reason.
  const exclude = new Set<string>([userId, ...followingIds]);
  let discovery: StoryGroup[] = [];
  try {
    discovery = await fetchDiscoveryGroups(userId, exclude, DISCOVERY_STORY_AUTHORS, localSeen);
  } catch { discovery = []; }

  try {
    const ranked = await rankStoryGroups(others, userId);
    return [...(own ? [own] : []), ...ranked, ...discovery]; // your own story always leads
  } catch {
    return [...baselineTraySort(list, userId), ...discovery];
  }
}

// Stories for the viewer, in the exact order of `userIds` (drops users whose
// stories all expired). Used by the full-screen viewer.
export async function fetchStoriesForUsers(
  userIds: string[],
  viewerId: string,
  localSeen: Set<string> = new Set(),
): Promise<StoryGroup[]> {
  const map = await loadGroups(userIds, viewerId, localSeen);
  return userIds
    .map((id) => map.get(id))
    .filter((g): g is StoryGroup => !!g);
}

// Per-author ring data for an active story: whether the viewer has an unseen story
// from them, plus their badge tier — so any avatar app-wide can render the badge
// ring (in the tier color) while the story is live.
export type StoryRingInfo = { unseen: boolean; badge_tier: string | null; profile_theme: string | null };

// Global ring data: for EVERY active story the viewer can see (per RLS), map each
// author's id → their ring info (unseen + badge tier). Powers story + badge rings
// on avatars anywhere in the app, not just people you follow. Returns an empty map
// if the stories table isn't set up yet.
export async function fetchActiveStoryFlags(viewerId: string, localSeen: Set<string> = new Set()): Promise<Map<string, StoryRingInfo>> {
  const nowIso = new Date().toISOString();
  const { data: stories } = await supabase
    .from('stories')
    .select('id, user_id')
    .gt('expires_at', nowIso);
  if (!stories || stories.length === 0) return new Map();

  const ids = stories.map((s: any) => s.id);
  const authorIds = Array.from(new Set(stories.map((s: any) => s.user_id)));
  // stories.user_id references auth.users, so fetch badge tiers from profiles separately.
  const [{ data: views }, { data: profiles }] = await Promise.all([
    supabase.from('story_views').select('story_id').eq('viewer_id', viewerId).in('story_id', ids),
    supabase.from('profiles').select('id, badge_tier, profile_theme').in('id', authorIds),
  ]);
  const seen = new Set<string>((views ?? []).map((v: any) => v.story_id));
  const profileById = new Map<string, { badge_tier: string | null; profile_theme: string | null }>(
    (profiles ?? []).map((p: any) => [p.id, { badge_tier: p.badge_tier ?? null, profile_theme: p.profile_theme ?? null }]),
  );

  const flags = new Map<string, StoryRingInfo>(); // user_id -> ring info
  for (const s of stories as any[]) {
    // `localSeen` keeps just-watched stories seen even before the view write lands.
    const unseen = !seen.has(s.id) && !localSeen.has(s.id);
    const prev = flags.get(s.user_id);
    const p = profileById.get(s.user_id);
    flags.set(s.user_id, {
      unseen: (prev?.unseen ?? false) || unseen,
      badge_tier: prev?.badge_tier ?? p?.badge_tier ?? null,
      profile_theme: prev?.profile_theme ?? p?.profile_theme ?? null,
    });
  }
  return flags;
}

// Idempotent (composite PK on story_id+viewer_id) — safe to call on every view.
export async function recordStoryView(storyId: string, viewerId: string): Promise<void> {
  await supabase
    .from('story_views')
    .upsert(
      { story_id: storyId, viewer_id: viewerId },
      { onConflict: 'story_id,viewer_id', ignoreDuplicates: true },
    );
}

export async function deleteStory(storyId: string): Promise<void> {
  // Grab the media URLs first, delete the row, then best-effort remove the
  // underlying Storage objects so they don't linger in the public bucket.
  let media: string[] = [];
  try {
    const { data } = await supabase.from('stories').select('media_url, thumbnail_url').eq('id', storyId).single();
    if (data) media = [data.media_url, (data as any).thumbnail_url].filter(Boolean) as string[];
  } catch {}
  await supabase.from('stories').delete().eq('id', storyId);
  if (media.length) await removePublicUrls(media);
}

// The Stories archive: the current user's EXPIRED stories (the live tray hides
// these once they pass 24h, but the rows remain — deleting a story removes it
// entirely, so the archive only ever shows expired, never deleted, stories).
export async function fetchArchivedStories(userId: string): Promise<Story[]> {
  const nowIso = new Date().toISOString();
  const { data } = await supabase
    .from('stories')
    .select('*')
    .eq('user_id', userId)
    .lte('expires_at', nowIso)
    .order('created_at', { ascending: false });
  return (data ?? []) as Story[];
}

// Restore (re-publish) an expired story: push created_at/expires_at forward so it
// becomes active again for another 24h. Requires the stories UPDATE policy in
// supabase/sql/stories.sql. Returns false if the write is rejected.
export async function restoreStory(storyId: string): Promise<boolean> {
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const { error } = await supabase
    .from('stories')
    .update({ created_at: now.toISOString(), expires_at: expires.toISOString() })
    .eq('id', storyId);
  return !error;
}

export async function fetchStoryViewerCount(storyId: string): Promise<number> {
  const { count } = await supabase
    .from('story_views')
    .select('*', { count: 'exact', head: true })
    .eq('story_id', storyId);
  return count ?? 0;
}

// Who watched a story (owner-facing list), likers sorted to the top with a
// `liked` flag. Manual two-step join — viewer_id references auth.users, so
// profiles are fetched separately. Degrades gracefully if story_likes.sql
// hasn't been applied (likes just read as empty).
export type StoryViewer = StoryProfile & { liked?: boolean };

export async function fetchStoryViewers(storyId: string): Promise<StoryViewer[]> {
  const [viewsRes, likesRes] = await Promise.all([
    supabase.from('story_views').select('viewer_id').eq('story_id', storyId),
    supabase.from('story_likes').select('user_id').eq('story_id', storyId),
  ]);
  const likedIds = new Set((likesRes.data ?? []).map((l: any) => l.user_id));
  const ids = Array.from(new Set([
    ...(viewsRes.data ?? []).map((v: any) => v.viewer_id),
    ...likedIds, // a liker should appear even if their view write is lagging
  ]));
  if (ids.length === 0) return [];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, badge_tier, badge_show, hidden')
    .in('id', ids);
  // Viewers who have since hidden their account read as "Hidden account".
  return ((profiles ?? []) as StoryProfile[])
    .map((p) => ({ ...maskHiddenProfile(p as any), liked: likedIds.has(p.id) }))
    .sort((a, b) => Number(!!b.liked) - Number(!!a.liked));
}

// Whether the viewer has liked a story (drives the heart button state).
export async function fetchStoryLiked(storyId: string, userId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('story_likes')
      .select('story_id')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

export async function setStoryLike(storyId: string, userId: string, liked: boolean): Promise<void> {
  try {
    if (liked) {
      await supabase.from('story_likes').upsert(
        { story_id: storyId, user_id: userId },
        { onConflict: 'story_id,user_id', ignoreDuplicates: true },
      );
    } else {
      await supabase.from('story_likes').delete().eq('story_id', storyId).eq('user_id', userId);
    }
  } catch {}
}
