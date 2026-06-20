import { type Tier, tierRank, rawTier, type ProfileBadgeFields } from './badges';

// Page Layout / Profile Templates — single source of truth.
// Schema lives in supabase/sql/page_layout.sql (two profile columns: page_layout +
// layout_blocks). Everything here degrades gracefully: if the SQL isn't applied
// yet the columns read null, activeLayout() returns null, and every profile shows
// the default grid — exactly as before.
//
// A template rearranges the FIRST profile tab (Posts) into an ordered list of
// "feature blocks" rendered above the normal grid; any posts not used by a block
// fall through to that grid underneath (the notes' "rest of their posts underneath
// in regular format"). Big Bell is just "any mix of blocks", so the three templates
// share one block model and one renderer.

// ─── Block model ──────────────────────────────────────────────────────────────
export type LayoutTemplate = 'media_star' | 'big_picture' | 'big_bell';
export type BlockKind = 'media_star' | 'big_picture';

// A Media Star cluster: one image/video on the left, two of the user's OWN songs
// (audio posts) stacked on the right.
export type MediaStarBlock = { kind: 'media_star'; main: string; songs: string[] };
// A Big Picture block: one 2×2 hero media (image/video) on the left, two regular
// 1×1 medias stacked on the right. `loop` (Big Bell / Diamond only) renders the
// hero as a muted ≤12s autoplay video preview instead of a still — at most one per
// profile.
export type BigPictureBlock = { kind: 'big_picture'; big: string; regulars: string[]; loop?: boolean };
export type LayoutBlock = MediaStarBlock | BigPictureBlock;

export type PageLayout = { template: LayoutTemplate; blocks: LayoutBlock[] };

// ─── Template catalog ─────────────────────────────────────────────────────────
export const TEMPLATE_META: Record<LayoutTemplate, {
  label: string;
  minTier: Tier;
  icon: string;          // Ionicons name
  tagline: string;       // one-liner for the picker card
  // Which block kinds this template may contain, and whether multiple blocks are allowed.
  kinds: BlockKind[];
  multi: boolean;
  loop: boolean;         // may a big_picture block carry a 12s video loop?
}> = {
  big_picture: {
    label: 'Big Picture', minTier: 'silver', icon: 'image',
    tagline: 'One hero media, twice the size, with two regulars alongside.',
    kinds: ['big_picture'], multi: false, loop: false,
  },
  media_star: {
    label: 'Media Star', minTier: 'gold', icon: 'star',
    tagline: 'Pair a photo or video with two of your songs. Stack as many as you like.',
    kinds: ['media_star'], multi: true, loop: false,
  },
  big_bell: {
    label: 'Big Bell', minTier: 'diamond', icon: 'diamond',
    tagline: 'Mix Media Star and Big Picture freely — plus one looping video hero.',
    kinds: ['media_star', 'big_picture'], multi: true, loop: true,
  },
};

export const TEMPLATE_ORDER: LayoutTemplate[] = ['big_picture', 'media_star', 'big_bell'];

export function isLayoutTemplate(v: any): v is LayoutTemplate {
  return v === 'media_star' || v === 'big_picture' || v === 'big_bell';
}

// ─── Post helpers ─────────────────────────────────────────────────────────────
// A "visual" post can fill a Media Star main slot or a Big Picture hero slot.
// Slideshows count as visuals (slide 1 is the cover). Audio cannot.
export function isVisualPost(p: any): boolean {
  return p?.type === 'image' || p?.type === 'video' || p?.type === 'slideshow';
}
export function isSongPost(p: any): boolean {
  return p?.type === 'audio';
}
// Post types that can fill the Big Bell animated "loop" hero slot: a video (muted
// ≤12s autoplay loop) or a slideshow (auto-advances its slide thumbnails every 2s).
export function isLoopMedia(p: any): boolean {
  return p?.type === 'video' || p?.type === 'slideshow';
}

export type MediaCounts = { visual: number; audio: number; total: number };
export function countMedia(posts: any[]): MediaCounts {
  let visual = 0, audio = 0;
  for (const p of posts) {
    if (isSongPost(p)) audio++;
    else if (isVisualPost(p)) visual++;
  }
  return { visual, audio, total: visual + audio };
}

// ─── Unlock gating ────────────────────────────────────────────────────────────
// A template is available when the user's EARNED tier (not their displayed badge —
// gating always uses what they've actually earned) meets the bar AND they own
// enough content to build at least one valid block. The content rule is the
// concrete version of the notes' "unlocked based on how many of each media type
// they have posted".
export type UnlockState = { unlocked: boolean; tierOk: boolean; contentOk: boolean; reason: string | null };

export function contentRequirement(template: LayoutTemplate): string {
  switch (template) {
    case 'media_star': return 'Post at least 1 photo/video and 2 songs';
    case 'big_picture': return 'Post at least 3 pieces of media';
    case 'big_bell': return 'Post enough media to fill a block';
  }
}

function contentMet(template: LayoutTemplate, c: MediaCounts): boolean {
  switch (template) {
    case 'media_star': return c.visual >= 1 && c.audio >= 2;
    case 'big_picture': return c.total >= 3 && c.visual >= 1;
    // Big Bell needs enough for at least ONE block of either kind.
    case 'big_bell': return (c.visual >= 1 && c.audio >= 2) || (c.total >= 3 && c.visual >= 1);
  }
}

export function templateUnlock(template: LayoutTemplate, tier: Tier | null, counts: MediaCounts): UnlockState {
  const tierOk = tierRank(tier) >= tierRank(TEMPLATE_META[template].minTier);
  const contentOk = contentMet(template, counts);
  let reason: string | null = null;
  if (!tierOk) reason = `Reach ${cap(TEMPLATE_META[template].minTier)} badge status`;
  else if (!contentOk) reason = contentRequirement(template);
  return { unlocked: tierOk && contentOk, tierOk, contentOk, reason };
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Parse + validate ─────────────────────────────────────────────────────────
// Safely coerce a stored layout_blocks value into typed blocks (drops anything
// malformed). Never throws.
export function parseBlocks(raw: any): LayoutBlock[] {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: LayoutBlock[] = [];
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    if (b.kind === 'media_star' && typeof b.main === 'string' && Array.isArray(b.songs) && b.songs.length === 2 && b.songs.every((s: any) => typeof s === 'string')) {
      out.push({ kind: 'media_star', main: b.main, songs: [b.songs[0], b.songs[1]] });
    } else if (b.kind === 'big_picture' && typeof b.big === 'string' && Array.isArray(b.regulars) && b.regulars.length === 2 && b.regulars.every((s: any) => typeof s === 'string')) {
      out.push({ kind: 'big_picture', big: b.big, regulars: [b.regulars[0], b.regulars[1]], loop: !!b.loop });
    }
  }
  return out;
}

// Every post id referenced by a list of blocks (so the regular grid below can
// exclude them).
export function usedPostIds(blocks: LayoutBlock[]): Set<string> {
  const s = new Set<string>();
  for (const b of blocks) {
    if (b.kind === 'media_star') { s.add(b.main); b.songs.forEach(id => s.add(id)); }
    else { s.add(b.big); b.regulars.forEach(id => s.add(id)); }
  }
  return s;
}

// True if every slot in the block resolves to a post that still exists in `byId`
// (i.e. not deleted/archived/hidden). Used to skip stale blocks at render time.
function blockResolves(b: LayoutBlock, byId: Map<string, any>): boolean {
  if (b.kind === 'media_star') {
    return !!byId.get(b.main) && b.songs.every(id => !!byId.get(id));
  }
  return !!byId.get(b.big) && b.regulars.every(id => !!byId.get(id));
}

// Keep only the blocks whose every referenced post is still visible.
export function resolvableBlocks(blocks: LayoutBlock[], posts: any[]): LayoutBlock[] {
  const byId = new Map(posts.map(p => [p.id, p]));
  return blocks.filter(b => blockResolves(b, byId));
}

// ─── Active layout (render gate) ──────────────────────────────────────────────
// The layout to actually render for a profile, or null for the default grid.
// Enforces the tier gate on READ (losing the status reverts to default without
// touching the saved blocks) and requires at least one well-formed block.
// `posts` is optional; when provided, blocks referencing missing posts are dropped
// and the layout is nulled out if none survive.
export function activeLayout(profile: ProfileBadgeFields | null | undefined, posts?: any[]): PageLayout | null {
  const tpl = profile?.page_layout;
  if (!isLayoutTemplate(tpl)) return null;
  if (tierRank(rawTier(profile)) < tierRank(TEMPLATE_META[tpl].minTier)) return null;
  let blocks = parseBlocks(profile?.layout_blocks);
  if (posts) blocks = resolvableBlocks(blocks, posts);
  if (!blocks.length) return null;
  return { template: tpl, blocks };
}

// Lightweight check (no post resolution) for callers that only need to know
// whether a custom layout is in effect — e.g. skipping the spotlight reorder.
export function hasActiveLayout(profile: ProfileBadgeFields | null | undefined): boolean {
  const tpl = profile?.page_layout;
  if (!isLayoutTemplate(tpl)) return false;
  if (tierRank(rawTier(profile)) < tierRank(TEMPLATE_META[tpl].minTier)) return false;
  return parseBlocks(profile?.layout_blocks).length > 0;
}

// ─── Builder validation ───────────────────────────────────────────────────────
// Whether a draft block has all its slots filled (used to enable Save and to grey
// out incomplete blocks in the preview).
export function blockComplete(b: Partial<LayoutBlock> & { kind: BlockKind }): boolean {
  if (b.kind === 'media_star') {
    const mb = b as Partial<MediaStarBlock>;
    return !!mb.main && Array.isArray(mb.songs) && mb.songs.filter(Boolean).length === 2;
  }
  const pb = b as Partial<BigPictureBlock>;
  return !!pb.big && Array.isArray(pb.regulars) && pb.regulars.filter(Boolean).length === 2;
}

// An empty draft block of a given kind (slots null until the user picks posts).
export function emptyBlock(kind: BlockKind): any {
  return kind === 'media_star'
    ? { kind, main: null, songs: [null, null] }
    : { kind, big: null, regulars: [null, null], loop: false };
}
