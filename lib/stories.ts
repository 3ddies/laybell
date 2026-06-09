import { supabase } from './supabase';

// 24-hour stories. Schema + RLS live in supabase/sql/stories.sql.
// A story is an ephemeral image/video visible to the author and their followers
// for 24h after posting. story_views drives the unseen/seen ring in the tray.

export type StoryProfile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
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
}): Promise<void> {
  const { error } = await supabase.from('stories').insert({
    user_id: input.userId,
    media_url: input.mediaUrl,
    media_type: input.mediaType,
    ...(input.thumbnailUrl ? { thumbnail_url: input.thumbnailUrl } : {}),
    ...(input.caption ? { caption: input.caption } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.durationSeconds != null ? { duration_seconds: input.durationSeconds } : {}),
  });
  if (error) throw error;
}

// Core loader: active (non-expired) stories for the given authors, grouped by
// author, with a per-story `seen` flag for `viewerId`. Profiles are fetched in a
// second query (manual join) because stories.user_id references auth.users, not
// profiles — so a PostgREST embed/FK hint isn't reliable here.
async function loadGroups(
  authorIds: string[],
  viewerId: string,
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
      .select('id, username, display_name, avatar_url')
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
    const isSeen = seen.has(s.id);
    group.stories.push({ ...(s as Story), seen: isSeen });
    if (!isSeen) group.hasUnseen = true;
  }
  return map;
}

// The Home tray: the current user's active stories first, then active stories
// from people they follow — unseen groups sorted ahead of seen ones.
export async function fetchStoryTray(userId: string): Promise<StoryGroup[]> {
  const { data: follows } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);
  const authorIds = Array.from(new Set([userId, ...followingIds]));

  const map = await loadGroups(authorIds, userId);
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
): Promise<StoryGroup[]> {
  const map = await loadGroups(userIds, viewerId);
  return userIds
    .map((id) => map.get(id))
    .filter((g): g is StoryGroup => !!g);
}

// Global ring data: for EVERY active story the viewer can see (per RLS), map each
// author's id → whether they have at least one UNSEEN story. Powers story rings
// on avatars anywhere in the app, not just people you follow. Lightweight (ids
// only). Returns an empty map if the stories table isn't set up yet.
export async function fetchActiveStoryFlags(viewerId: string): Promise<Map<string, boolean>> {
  const nowIso = new Date().toISOString();
  const { data: stories } = await supabase
    .from('stories')
    .select('id, user_id')
    .gt('expires_at', nowIso);
  if (!stories || stories.length === 0) return new Map();

  const ids = stories.map((s: any) => s.id);
  const { data: views } = await supabase
    .from('story_views')
    .select('story_id')
    .eq('viewer_id', viewerId)
    .in('story_id', ids);
  const seen = new Set<string>((views ?? []).map((v: any) => v.story_id));

  const flags = new Map<string, boolean>(); // user_id -> hasUnseen
  for (const s of stories as any[]) {
    const unseen = !seen.has(s.id);
    flags.set(s.user_id, (flags.get(s.user_id) ?? false) || unseen);
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
