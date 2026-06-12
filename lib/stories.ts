import { supabase } from './supabase';
import { createNotification } from './createNotification';
import { maskHiddenProfile } from './hiddenProfile';

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

// The Home tray: the current user's active stories first, then active stories
// from people they follow — unseen groups sorted ahead of seen ones.
export async function fetchStoryTray(userId: string, localSeen: Set<string> = new Set()): Promise<StoryGroup[]> {
  const { data: follows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);
  const authorIds = Array.from(new Set([userId, ...followingIds]));

  const map = await loadGroups(authorIds, userId, localSeen);
  const list = Array.from(map.values());

  list.sort((a, b) => {
    if (a.user.id === userId) return -1; // your own story always leads
    if (b.user.id === userId) return 1;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1; // unseen first
    const aLast = a.stories[a.stories.length - 1]?.created_at ?? '';
    const bLast = b.stories[b.stories.length - 1]?.created_at ?? '';
    return bLast.localeCompare(aLast); // most recent first
  });
  return list;
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
  await supabase.from('stories').delete().eq('id', storyId);
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
