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
  // "Post to story": a post reshared to this story (story_shared_post.sql). When
  // set, media_url is the ORIGINAL post's still (a backdrop, in the posts bucket —
  // NOT owned by this story) and the viewer draws SharedPostCard over it.
  shared_post_id?: string | null;
};

// A story's `stickers` jsonb is a heterogeneous list of LAYERS. Most are text/emoji
// (kind absent or 'text'). The Post-to-story editor also stores, in the same array
// (no schema change):
//   • kind:'post'  — the reshared post, as a movable/resizable frame (its transform
//     only; the media comes from shared_post_id).
//   • kind:'bg'    — the chosen background behind the post (blurred still / solid /
//     gradient). Absent = the blurred default.
//   • kind:'draw'  — pen strokes, normalised to the frame.
//   • kind:'frame' — how a plain library PHOTO is framed (drag/pinch): x/y are the
//     translate as a FRACTION of the frame, scale is relative to a cover fit, and
//     w/h are the source image's pixels. The viewer redraws the photo with this
//     transform over a blurred backdrop, so a zoomed-OUT photo shows the backdrop
//     around it. Absent → the photo is shown plain cover (unchanged).
// Every field is optional so a plain text sticker (the only kind before this) still
// validates and renders exactly as before.
export type StorySticker = {
  kind?: 'text' | 'post' | 'bg' | 'draw' | 'frame';
  text?: string; x?: number; y?: number; scale?: number; rotation?: number;
  font?: string; color?: string; bg?: string; size?: number; emoji?: boolean;
  id?: string;                                                        // post layer
  background?: { type: 'blur' | 'color' | 'gradient'; color?: string; colors?: string[] }; // bg layer
  strokes?: { c: string; w: number; p: [number, number][] }[];       // draw layer
  w?: number; h?: number;                                             // frame layer: source image px
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
  sharedPostId?: string | null;
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
    ...(input.sharedPostId ? { shared_post_id: input.sharedPostId } : {}),
  });
  if (error) throw error;

  // Notify the original artist when their song is used in a story (deep-links to
  // the poster's story, which is only viewable for the 24h the story is up).
  if (input.song && input.song.artistId && input.song.artistId !== input.userId) {
    createNotification({ userId: input.song.artistId, actorId: input.userId, type: 'song_story' });
  }
}

// Longest a reshared VIDEO plays in the story (Instagram-style cap). The viewer
// stops the segment and advances at this point.
export const REPOST_MAX_SEC = 20;

// "Post to story" (Instagram-style): reshare a post to your 24h story, keeping the
// post's ORIENTATION and, for videos, PLAYING it (with audio, capped at
// REPOST_MAX_SEC) inside a card over a blurred backdrop. `shared_post_id` points at
// the post so the viewer can draw the author chip + open the original on tap.
//   • video post → stored as a VIDEO story (its own media_url), so the viewer's
//     video path plays it; aspect_ratio carries the post's orientation.
//   • everything else → the post's still, as an image story at the post's aspect.
// (No new notification type — the card's link back is the attribution.)
export async function createStoryFromPost(userId: string, postId: string): Promise<void> {
  const { data: post, error: pErr } = await supabase
    .from('posts')
    .select('type, media_url, cover_url, thumbnail_url, aspect_ratio, duration_seconds')
    .eq('id', postId)
    .single();
  if (pErr || !post) throw (pErr ?? new Error('post not found'));
  const p = post as any;
  if (p.type === 'video') {
    await createStory({
      userId,
      mediaUrl: p.media_url,                                   // the actual video — plays
      mediaType: 'video',
      thumbnailUrl: p.thumbnail_url ?? p.cover_url ?? null,    // blurred backdrop + poster
      aspectRatio: p.aspect_ratio ?? '9:16',                  // keeps horizontal/vertical
      durationSeconds: p.duration_seconds != null ? Math.min(p.duration_seconds, REPOST_MAX_SEC) : null,
      sharedPostId: postId,
    });
  } else {
    const still = p.cover_url ?? p.thumbnail_url ?? (p.type === 'image' ? p.media_url : null) ?? p.media_url;
    await createStory({
      userId,
      mediaUrl: still,
      mediaType: 'image',
      aspectRatio: p.aspect_ratio ?? '1:1',
      sharedPostId: postId,
    });
  }
}

// The EDITED "Post to story": the reshared post placed/resized on a chosen
// background with drawings, text and emoji (app/story/repost/[id].tsx). Same media
// rules as createStoryFromPost — a video is stored as a VIDEO story so it plays,
// everything else as the still — but the composition (background + post transform +
// strokes + text) rides along in the stickers jsonb, and the viewer composes it
// live. `post` is the row the editor already fetched.
export async function createStoryRepost(input: {
  userId: string;
  postId: string;
  post: { type: string; media_url: string | null; cover_url?: string | null; thumbnail_url?: string | null; aspect_ratio?: string | null; duration_seconds?: number | null };
  layers: StorySticker[];
  caption?: string | null;
  song?: { id: string; title: string; artist: string; artistId: string } | null;
}): Promise<void> {
  const p = input.post;
  const isVideo = p.type === 'video';
  const still = p.cover_url ?? p.thumbnail_url ?? (p.type === 'image' ? p.media_url : null) ?? p.media_url;
  await createStory({
    userId: input.userId,
    mediaUrl: isVideo ? (p.media_url ?? '') : (still ?? ''),
    mediaType: isVideo ? 'video' : 'image',
    thumbnailUrl: isVideo ? (p.thumbnail_url ?? p.cover_url ?? null) : null,
    aspectRatio: p.aspect_ratio ?? (isVideo ? '9:16' : '1:1'),
    durationSeconds: isVideo && p.duration_seconds != null ? Math.min(p.duration_seconds, REPOST_MAX_SEC) : null,
    caption: input.caption ?? null,
    song: input.song ?? null,
    stickers: input.layers.length ? input.layers : null,
    sharedPostId: input.postId,
  });
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

/**
 * How full the tray should be before discovery stops topping it up.
 *
 * Ten, so the rail reads as a rail rather than a gap — for somebody who follows
 * nobody, and for somebody whose follows all happen to be quiet today. Discovery
 * makes up the difference; see fetchStoryTray.
 *
 * This is a FLOOR ON THE ASK, not a promise. The tray cannot hold more stories
 * than the app has: with a handful of accounts and nobody posting, ten slots and
 * five slots produce the identical empty rail. It starts mattering the day there
 * is a surplus of stories to draw on, which is exactly when it should.
 *
 * Someone who follows plenty of active people still gets DISCOVERY_STORY_AUTHORS
 * on the end — the point of discovery is not only to fill space.
 */
export const TRAY_MIN_SLOTS = 10;

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

  // Ask for enough to reach TRAY_MIN_SLOTS, never fewer than the baseline five.
  // A viewer following nobody asks for ten; one whose follows already fill the
  // rail still asks for five, because discovery is a way to meet people and not
  // just padding. Counted off `others` rather than `followingIds`: what matters
  // is how many followed people actually POSTED, not how many were followed.
  const haveAlready = (own ? 1 : 0) + others.length;
  const wantDiscovery = Math.max(DISCOVERY_STORY_AUTHORS, TRAY_MIN_SLOTS - haveAlready);

  let discovery: StoryGroup[] = [];
  try {
    discovery = await fetchDiscoveryGroups(userId, exclude, wantDiscovery, localSeen);
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
  // A shared-post story's media is the ORIGINAL post's image (posts bucket) — NOT
  // owned by this story — so it must NEVER be cleaned up here, or we'd delete the
  // source post's cover.
  let media: string[] = [];
  try {
    const { data } = await supabase.from('stories').select('media_url, thumbnail_url, shared_post_id').eq('id', storyId).single();
    if (data && !(data as any).shared_post_id) media = [data.media_url, (data as any).thumbnail_url].filter(Boolean) as string[];
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

// Owner-facing per-story analytics (the Insights "Analytics" tab). Everything
// here is derived from data we ACTUALLY store — unique viewers (story_views) and
// likes (story_likes) — plus a followers/non-followers split of those viewers.
// Deeper Instagram-style metrics (repeat-view counts, navigation forward/exit/
// next, profile taps from a story) would need per-view event tracking we don't
// record yet, so they're deliberately absent rather than faked.
export type StoryAnalytics = {
  viewers: number;        // unique accounts that watched this story
  likes: number;          // likes on this story
  followers: number;      // of those viewers, how many follow the author
  nonFollowers: number;   // viewers − followers
};

export async function fetchStoryAnalytics(storyId: string, authorId: string): Promise<StoryAnalytics> {
  const [viewsRes, likesRes] = await Promise.all([
    supabase.from('story_views').select('viewer_id').eq('story_id', storyId),
    supabase.from('story_likes').select('story_id', { count: 'exact', head: true }).eq('story_id', storyId),
  ]);
  const viewerIds = Array.from(new Set((viewsRes.data ?? []).map((v: any) => v.viewer_id)));
  const viewers = viewerIds.length;
  const likes = likesRes.count ?? 0;

  let followers = 0;
  if (viewerIds.length) {
    // Bounded by the viewer list (small), so this stays cheap even for a popular
    // account — we only ask which of THESE viewers follow the author, never the
    // author's whole follower graph.
    const { data } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('following_id', authorId)
      .in('follower_id', viewerIds);
    followers = new Set((data ?? []).map((r: any) => r.follower_id)).size;
  }
  return { viewers, likes, followers, nonFollowers: Math.max(0, viewers - followers) };
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
