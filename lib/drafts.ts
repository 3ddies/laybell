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
