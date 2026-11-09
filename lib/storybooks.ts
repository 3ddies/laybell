import { supabase } from './supabase';
import type { Story } from './stories';

// Storybooks — persistent, chaptered collections of a user's stories (like IG
// story highlights, but with titled chapters). Schema + RLS: supabase/sql/storybooks.sql.
//
// A storybook_item SNAPSHOTS a story's media (url/type/caption/…) so the book keeps
// working after the source story expires or is purged — the public `stories` bucket
// file persists. Every function degrades gracefully if the tables aren't migrated
// yet (reads return empty, writes return null/false), exactly like lib/stories.ts.

export type Storybook = {
  id: string;
  user_id: string;
  title: string;
  cover_url: string | null;
  is_public: boolean;
  kind: 'manual' | 'yearbook';
  period: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type StorybookItem = {
  id: string;
  chapter_id: string;
  story_id: string | null;
  media_url: string;
  media_type: 'image' | 'video';
  thumbnail_url: string | null;
  caption: string | null;
  aspect_ratio: string | null;
  duration_seconds: number | null;
  position: number;
  created_at: string;
};

export type StorybookChapter = {
  id: string;
  storybook_id: string;
  title: string | null;
  position: number;
  created_at: string;
};

// A book with its chapters, each carrying its ordered items — what the viewer and
// the editor both work from.
export type StorybookFull = Storybook & {
  chapters: (StorybookChapter & { items: StorybookItem[] })[];
};

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * The books to show on a profile's shelf. RLS already scopes this: the OWNER sees
 * all of their books; anyone else sees only the public ones. Ordered by the shelf
 * position the owner set, newest-updated breaking ties. Returns [] if the table
 * isn't set up yet.
 */
export async function fetchStorybooks(userId: string): Promise<Storybook[]> {
  const { data, error } = await supabase
    .from('storybooks')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .order('updated_at', { ascending: false });
  if (error) return [];
  return (data ?? []) as Storybook[];
}

// A tiny in-memory cache of the last-opened full books. The shelf pre-fetches a
// book (showing a spinner) BEFORE navigating, so the viewer can open already-loaded
// — no in-viewer data spinner, no black flash. Short-lived (process memory only).
const fullCache = new Map<string, StorybookFull>();
export function getCachedStorybookFull(bookId: string): StorybookFull | null {
  return fullCache.get(bookId) ?? null;
}

/**
 * One full book — chapters in order, each with its items in order. RLS gates the
 * read (a private book returns null for anyone but its owner). Two flat queries
 * then assembled in memory (cheap; a book is small).
 */
export async function fetchStorybookFull(bookId: string): Promise<StorybookFull | null> {
  const { data: book, error } = await supabase
    .from('storybooks').select('*').eq('id', bookId).maybeSingle();
  if (error || !book) return null;

  const { data: chapters } = await supabase
    .from('storybook_chapters').select('*')
    .eq('storybook_id', bookId)
    .order('position', { ascending: true });
  const chapterIds = (chapters ?? []).map((c: any) => c.id);

  let items: StorybookItem[] = [];
  if (chapterIds.length) {
    const { data: it } = await supabase
      .from('storybook_items').select('*')
      .in('chapter_id', chapterIds)
      .order('position', { ascending: true });
    items = (it ?? []) as StorybookItem[];
  }

  const byChapter = new Map<string, StorybookItem[]>();
  for (const i of items) {
    const arr = byChapter.get(i.chapter_id) ?? [];
    arr.push(i);
    byChapter.set(i.chapter_id, arr);
  }
  const full: StorybookFull = {
    ...(book as Storybook),
    chapters: (chapters ?? []).map((c: any) => ({ ...(c as StorybookChapter), items: byChapter.get(c.id) ?? [] })),
  };
  fullCache.set(bookId, full);
  return full;
}

// ── Books ──────────────────────────────────────────────────────────────────

async function nextPosition(table: 'storybooks' | 'storybook_chapters' | 'storybook_items', col: string, id: string): Promise<number> {
  const { data } = await supabase.from(table).select('position').eq(col, id).order('position', { ascending: false }).limit(1).maybeSingle();
  return ((data as any)?.position ?? -1) + 1;
}

export async function createStorybook(input: {
  userId: string;
  title: string;
  coverUrl?: string | null;
  isPublic?: boolean;
}): Promise<string | null> {
  const position = await nextPosition('storybooks', 'user_id', input.userId);
  const { data, error } = await supabase
    .from('storybooks')
    .insert({
      user_id: input.userId,
      title: input.title,
      cover_url: input.coverUrl ?? null,
      is_public: input.isPublic ?? false,
      position,
    })
    .select('id')
    .single();
  if (error) return null;
  return (data as any).id as string;
}

export async function updateStorybook(
  bookId: string,
  patch: Partial<Pick<Storybook, 'title' | 'cover_url' | 'is_public' | 'position'>>,
): Promise<boolean> {
  const { error } = await supabase.from('storybooks').update(patch).eq('id', bookId);
  return !error;
}

export async function deleteStorybook(bookId: string): Promise<boolean> {
  // Chapters + items cascade (FK on delete cascade). The snapshot media lives in
  // the shared stories bucket and may still back a live/other story, so it is NOT
  // removed here.
  const { error } = await supabase.from('storybooks').delete().eq('id', bookId);
  return !error;
}

/** Set the book's cover only if it has none yet — so the first item added becomes the cover. */
export async function setCoverIfEmpty(bookId: string, url: string | null): Promise<void> {
  if (!url) return;
  const { data } = await supabase.from('storybooks').select('cover_url').eq('id', bookId).maybeSingle();
  if (data && !(data as any).cover_url) await supabase.from('storybooks').update({ cover_url: url }).eq('id', bookId);
}

// ── Chapters ──────────────────────────────────────────────────────────────────

export async function addChapter(bookId: string, title: string | null): Promise<string | null> {
  const position = await nextPosition('storybook_chapters', 'storybook_id', bookId);
  const { data, error } = await supabase
    .from('storybook_chapters')
    .insert({ storybook_id: bookId, title: title?.trim() || null, position })
    .select('id')
    .single();
  if (error) return null;
  return (data as any).id as string;
}

export async function updateChapter(chapterId: string, patch: Partial<Pick<StorybookChapter, 'title' | 'position'>>): Promise<boolean> {
  const { error } = await supabase.from('storybook_chapters').update(patch).eq('id', chapterId);
  return !error;
}

export async function deleteChapter(chapterId: string): Promise<boolean> {
  const { error } = await supabase.from('storybook_chapters').delete().eq('id', chapterId);
  return !error;
}

// ── Items (snapshots of stories) ──────────────────────────────────────────────

/** Map a Story to the snapshot columns of a storybook_item. */
function snapshotOf(story: Story) {
  return {
    story_id: story.id,
    media_url: story.media_url,
    media_type: story.media_type,
    thumbnail_url: story.thumbnail_url ?? null,
    caption: story.caption ?? null,
    aspect_ratio: story.aspect_ratio ?? null,
    duration_seconds: story.duration_seconds ?? null,
  };
}

/**
 * Snapshot a story into a chapter (at the end), and make it the book's cover if the
 * book has none yet. `bookId` is passed so the cover can be set without a chapter→book
 * lookup. Returns the new item id, or null.
 */
export async function addStoryToChapter(bookId: string, chapterId: string, story: Story): Promise<string | null> {
  const position = await nextPosition('storybook_items', 'chapter_id', chapterId);
  const snap = snapshotOf(story);
  const { data, error } = await supabase
    .from('storybook_items')
    .insert({ chapter_id: chapterId, position, ...snap })
    .select('id')
    .single();
  if (error) return null;
  await setCoverIfEmpty(bookId, snap.thumbnail_url ?? snap.media_url);
  return (data as any).id as string;
}

export async function deleteItem(itemId: string): Promise<boolean> {
  const { error } = await supabase.from('storybook_items').delete().eq('id', itemId);
  return !error;
}

// ── Reordering ────────────────────────────────────────────────────────────────

// Persist a new order by writing each row's new position. Small lists (a shelf of
// books, a book's chapters, a chapter's items), so a handful of updates is fine.
async function persistOrder(table: 'storybooks' | 'storybook_chapters' | 'storybook_items', orderedIds: string[]): Promise<void> {
  await Promise.all(orderedIds.map((id, i) => supabase.from(table).update({ position: i }).eq('id', id)));
}
export const reorderStorybooks = (orderedIds: string[]) => persistOrder('storybooks', orderedIds);
export const reorderChapters   = (orderedIds: string[]) => persistOrder('storybook_chapters', orderedIds);
export const reorderItems      = (orderedIds: string[]) => persistOrder('storybook_items', orderedIds);
