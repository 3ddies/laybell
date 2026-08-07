import AsyncStorage from '@react-native-async-storage/async-storage';
import { isAudioPost } from './genres';
import { tg, countLabel } from './i18n';

// Post drafts — saved LOCALLY on the device (AsyncStorage). A draft is a
// snapshot of the composer's state (post type, media references, caption,
// crops, slides, attached song, tags, visibility) taken BEFORE publishing.
// Media is referenced by its on-device URI and is NOT uploaded until the draft
// is resumed and actually shared — so saving a draft is instant and a post
// that's never published never costs storage.
//
// Caveat (inherent to local drafts): the media lives only on this device, so a
// draft's photo/video/audio can become unavailable if the original is deleted
// from the library or the app's cache is cleared. If that happens, the composer
// surfaces a clear "media no longer on your device" message at share time
// (see friendlyShareError) instead of an opaque failure, and the drafts list
// still shows the entry so it can be removed.

const DRAFTS_KEY = 'post_drafts_v1';

// Keep the list bounded — oldest drops off once this many exist.
export const MAX_DRAFTS = 30;

export type DraftCrop = { originX: number; originY: number; width: number; height: number } | null;

export type Draft = {
  id: string;
  createdAt: number;
  updatedAt: number;

  postType: 'image' | 'video' | 'audio' | 'slideshow';
  format: string;
  caption: string;
  genre: string;
  isPublic: boolean;

  // image / video (matches the composer's `media` state shape exactly)
  media: { uri: string; width: number; height: number; posterUri?: string } | null;
  crop: DraftCrop;              // single-image interactive crop (applied on share)
  thumbnailUri: string | null;  // video poster frame
  videoAspect: number;
  videoDuration: number;
  trimStart: number;
  // Optional: drafts saved before draggable trim edges existed have no end,
  // so the composer falls back to a full window from trimStart.
  trimEnd?: number;
  // Horizontal-video band captions (letterbox bubbles); absent on older drafts.
  topCaption?: { text: string; bg: string; color: string; y: number; scale: number } | null;
  bottomCaption?: { text: string; bg: string; color: string; y: number; scale: number } | null;
  // Vertical-video story-style captions (array of sticker objects).
  videoCaptions?: any[];
  // Films (Premium+ landscape >9 min): the movie-shelf title.
  filmTitle?: string;

  // slideshow — PickedSlide[] (kept loosely typed to avoid a UI import cycle)
  slides: any[];

  // audio
  audioFile: any | null;
  audioDuration: number | null;
  coverUri: string | null;
  audioKind: 'audio' | 'podcast' | 'audiobook';

  // attribution
  song: any | null;             // PickedSong attached to an image/video/slideshow
  tagged: any[];                // TaggedPerson[]
  features?: any[];             // Feature[] — song collaborators (audio only)

  // per-post creator controls (both default true). Optional so older drafts load.
  allowDownloads?: boolean;     // audio: whether listeners may download for offline
  allowGifs?: boolean;          // video: whether others may Make GIF from it

  // ── Crash insurance (video uploads) ─────────────────────────────────────────
  // Set by Share when the upload starts; cleared only when the post TRULY
  // exists (uploaded + encoded + row). A draft still flagged at boot means the
  // app died mid-upload — lib/uploadRecovery reconciles it: heal the stranded
  // row if one was inserted, otherwise offer a one-tap resume.
  pendingUpload?: boolean;
  postedId?: string;            // DB row id once the insert landed
  postedUid?: string;           // Cloudflare asset id, for status checks
};

// Sortable, collision-resistant id (device-local only — no server coordination).
export function makeDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadDrafts(): Promise<Draft[]> {
  try {
    const raw = await AsyncStorage.getItem(DRAFTS_KEY);
    if (!raw) return [];
    const list: Draft[] = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Newest first.
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

// Upsert by id (so re-saving a resumed draft updates it instead of duplicating),
// newest first, capped at MAX_DRAFTS. Returns the saved list.
export async function saveDraft(draft: Draft): Promise<Draft[]> {
  try {
    const existing = await loadDrafts();
    const without = existing.filter((d) => d.id !== draft.id);
    const next = [draft, ...without]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DRAFTS);
    await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadDrafts();
  }
}

// Merge a partial update into one draft without touching its position.
export async function patchDraft(id: string, patch: Partial<Draft>): Promise<void> {
  try {
    const existing = await loadDrafts();
    const next = existing.map((d) => (d.id === id ? { ...d, ...patch } : d));
    await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
  } catch { /* a missed patch degrades to a spurious resume offer — harmless */ }
}

// ── Resume handoff ────────────────────────────────────────────────────────────
// The boot-time recovery prompt lives in _layout; the composer that can load a
// draft lives in the create tab. This module-level slot carries the chosen
// draft id across that navigation (same pattern as the spotlight handoff).
let _resumeDraftId: string | null = null;
export function setResumeDraftPending(id: string | null): void { _resumeDraftId = id; }
export function consumeResumeDraftId(): string | null {
  const v = _resumeDraftId;
  _resumeDraftId = null;
  return v;
}

export async function deleteDraft(id: string): Promise<Draft[]> {
  try {
    const existing = await loadDrafts();
    const next = existing.filter((d) => d.id !== id);
    await AsyncStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadDrafts();
  }
}

// The image to show for a draft in the list — mirrors the composer's own
// details-step thumbnail logic.
export function draftThumb(d: Draft): string | null {
  if (d.postType === 'audio' || isAudioPost(d.postType)) return d.coverUri ?? null;
  if (d.postType === 'slideshow') {
    const s = d.slides?.[0];
    if (!s) return null;
    // Prefer the durable ph:// poster over the evictable cache thumbnail for
    // video slides (rendered via ExpoImage, which resolves ph:// reliably).
    return s.type === 'video' ? (s.posterUri ?? s.thumbnailUri ?? null) : s.uri;
  }
  if (d.postType === 'video') return d.media?.posterUri ?? d.thumbnailUri ?? null;
  return d.media?.uri ?? null;
}

// One-line label for the draft card.
export function draftSummary(d: Draft): string {
  if (d.caption.trim()) return d.caption.trim();
  switch (d.postType) {
    case 'audio': return d.audioKind === 'audio'
      ? tg('draft.untitledTrack')
      : d.audioKind === 'podcast' ? tg('draft.untitledPodcast') : tg('draft.untitledAudiobook');
    case 'slideshow': return `${tg('post.slideshow')} · ${countLabel('item', d.slides?.length ?? 0)}`;
    case 'video': return tg('draft.untitledVideo');
    default: return tg('draft.untitledPost');
  }
}
