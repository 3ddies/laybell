import AsyncStorage from '@react-native-async-storage/async-storage';
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
  archived_at?: string | null; // soft-hidden from the shelf (and forced private); null/absent = active
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
  // Hide archived books (soft-hidden by the owner). Filtered in-memory so the shelf keeps
  // working even on an older DB where the archived_at column doesn't exist yet.
  return (data ?? []).filter((b: any) => !b.archived_at) as Storybook[];
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

// Soft-hide a book from the shelf and force it private. The row + chapters + media stay, so
// a later restore just clears archived_at. Needs the archived_at column — on a DB that
// predates it, this returns false (and the shelf still works, see fetchStorybooks).
export async function archiveStorybook(bookId: string): Promise<boolean> {
  const { error } = await supabase
    .from('storybooks')
    .update({ archived_at: new Date().toISOString(), is_public: false })
    .eq('id', bookId);
  return !error;
}

export async function unarchiveStorybook(bookId: string): Promise<boolean> {
  const { error } = await supabase.from('storybooks').update({ archived_at: null }).eq('id', bookId);
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

// ── Auto recaps — a "<Month Year> Recap" per completed month + a "<Year> Recap" per
// completed year, compiled from the user's own stories. These are kind='yearbook'
// books keyed by `period` ('YYYY-MM' or 'YYYY'); the schema's unique index on
// (user_id, period) where kind='yearbook' makes them idempotent, so a second device
// (or a re-run) never duplicates one. Best-effort and fully self-degrading: if the
// tables aren't migrated yet, or anything throws, it simply does nothing.
//
// Generated lazily the first time the OWNER views their shelf in a session (no server
// cron needed). COMPLETED periods only — the current month/year is still filling up,
// so we never make a half-recap that would need constant rewriting.

const RECAP_LOOKBACK_DAYS = 420; // ~13 months + buffer — bounds how far back we compile
const RECAP_MAX_PER_RUN = 6;     // backfill a few per session, never a huge burst on first run
const MONTH_ITEM_CAP = 40;       // items per monthly recap (evenly sampled beyond this)
const YEAR_ITEM_CAP = 60;        // items per yearly recap
const MONTH_MIN_STORIES = 3;     // a month with fewer eligible stories isn't worth a recap
const YEAR_MIN_STORIES = 5;      // likewise for a year

const RECAP_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const yearKeyOf = (d: Date) => `${d.getFullYear()}`;
const monthRecapTitle = (key: string) => { const [y, m] = key.split('-'); return `${RECAP_MONTHS[Number(m) - 1] ?? m} ${y} Recap`; };
const yearRecapTitle = (key: string) => `${key} Recap`;

// Evenly thin a list down to `cap`, preserving chronological order.
function evenSample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const out: T[] = [];
  const step = arr.length / cap;
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

const pushTo = (map: Map<string, Story[]>, key: string, s: Story) => {
  const arr = map.get(key);
  if (arr) arr.push(s); else map.set(key, [s]);
};

// Run the compile at most once per user per app session (avoids re-querying on every
// focus); AsyncStorage remembers which periods we've already made so a recap the user
// deleted doesn't keep coming back.
const recapCheckedThisSession = new Set<string>();
const recapMadeKey = (userId: string) => `storybook_recaps_made:${userId}`;

export async function ensureAutoRecaps(userId: string): Promise<boolean> {
  if (!userId || recapCheckedThisSession.has(userId)) return false;
  recapCheckedThisSession.add(userId);
  try {
    // Periods already generated on THIS device — so a deleted recap isn't recreated.
    let made = new Set<string>();
    try {
      const raw = await AsyncStorage.getItem(recapMadeKey(userId));
      if (raw) made = new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }

    // Recaps that already exist in the DB (dedupes across devices / backs the unique index).
    const { data: existing, error: exErr } = await supabase
      .from('storybooks').select('period').eq('user_id', userId).eq('kind', 'yearbook');
    if (exErr) return false; // tables not migrated yet → bail quietly
    const have = new Set((existing ?? []).map((r: any) => r.period as string).filter(Boolean));

    // The user's own ORIGINAL stories in the window (active + expired; RLS lets the owner
    // read both). Only real content counts — recorded clips, photos, uploads — so story
    // REPOSTS (a reshare of someone's post; shared_post_id set) are excluded.
    const since = new Date(Date.now() - RECAP_LOOKBACK_DAYS * 86400000).toISOString();
    const { data: sts } = await supabase
      .from('stories')
      .select('id, media_url, media_type, thumbnail_url, caption, aspect_ratio, duration_seconds, created_at')
      .eq('user_id', userId)
      .is('shared_post_id', null)
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    const stories = (sts ?? []) as Story[];
    if (stories.length === 0) return false;

    const now = new Date();
    const curMonth = monthKeyOf(now), curYear = yearKeyOf(now);
    const byMonth = new Map<string, Story[]>();
    const byYear = new Map<string, Story[]>();
    for (const s of stories) {
      if (!s.media_url || !s.created_at) continue;
      const d = new Date(s.created_at);
      const mk = monthKeyOf(d), yk = yearKeyOf(d);
      if (mk !== curMonth) pushTo(byMonth, mk, s); // completed months only
      if (yk !== curYear) pushTo(byYear, yk, s);   // completed years only
    }

    type Cand = { period: string; title: string; items: Story[] };
    const cands: Cand[] = [];
    // A period only earns a recap if it has ENOUGH eligible stories — a sparse month/year
    // isn't worth one.
    for (const [mk, items] of byMonth) if (items.length >= MONTH_MIN_STORIES && !have.has(mk) && !made.has(mk)) cands.push({ period: mk, title: monthRecapTitle(mk), items: evenSample(items, MONTH_ITEM_CAP) });
    for (const [yk, items] of byYear) if (items.length >= YEAR_MIN_STORIES && !have.has(yk) && !made.has(yk)) cands.push({ period: yk, title: yearRecapTitle(yk), items: evenSample(items, YEAR_ITEM_CAP) });
    cands.sort((a, b) => (a.period < b.period ? 1 : -1)); // newest period first
    const toMake = cands.slice(0, RECAP_MAX_PER_RUN);
    if (toMake.length === 0) return false;

    let created = false;
    for (const c of toMake) {
      const ok = await createRecap(userId, c.period, c.title, c.items);
      made.add(c.period); // mark regardless — a duplicate/failed one shouldn't be retried forever
      if (ok) created = true;
    }
    try { await AsyncStorage.setItem(recapMadeKey(userId), JSON.stringify([...made])); } catch { /* ignore */ }
    return created;
  } catch {
    return false; // never let a recap pass break the shelf
  }
}

// One recap book (kind='yearbook', `period`) with a single chapter of story snapshots.
// Returns false on a unique-index conflict (another device already made it) or any error,
// which the caller treats as "nothing new".
async function createRecap(userId: string, period: string, title: string, stories: Story[]): Promise<boolean> {
  if (stories.length === 0) return false;
  const position = await nextPosition('storybooks', 'user_id', userId);
  const first = stories[0];
  const cover = first.thumbnail_url ?? first.media_url ?? null;
  const { data: book, error } = await supabase
    .from('storybooks')
    .insert({ user_id: userId, title, is_public: false, kind: 'yearbook', period, position, cover_url: cover })
    .select('id')
    .single();
  if (error || !book) return false; // conflict (unique index) or RLS/offline → skip
  const bookId = (book as any).id as string;
  // Title the chapter with the period ("September 2026" / "2026") so the recap shows a title
  // card on open like any other book — and it stays editable in the editor.
  const chapterTitle = title.replace(/\s*recap$/i, '').trim() || title;
  const { data: chap } = await supabase
    .from('storybook_chapters').insert({ storybook_id: bookId, title: chapterTitle, position: 0 }).select('id').single();
  const chapterId = (chap as any)?.id as string | undefined;
  if (!chapterId) return true; // book exists; couldn't attach items, but don't hard-fail
  const rows = stories.map((s, i) => ({ chapter_id: chapterId, position: i, ...snapshotOf(s) }));
  await supabase.from('storybook_items').insert(rows);
  return true;
}
