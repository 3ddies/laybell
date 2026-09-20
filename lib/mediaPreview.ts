import { Image, type ImageProps } from 'expo-image';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { supabase } from './supabase';
import { cfStreamThumbnail } from './cast';
import { slideshowThumb, isSlideshow } from './slideshow';
import { isAudioPost } from './genres';

// Small copies and placeholders for post media (1.0.4; supabase/sql/post_media_previews.sql).
//
// At post time: a ~480px JPEG of the post's picture goes up beside the full file
// (posts.thumb_url), and a thumbhash of it — ~30 characters, generated natively by
// expo-image — rides in the row (posts.placeholder). Grids load the small copy
// instead of a 1440px upload into a 190pt tile, and every surface draws the blurred
// placeholder while the real image loads, instead of an empty gray box.
//
// Posts from before 1.0.4 have neither; every helper here falls back to what the
// surface showed before.

// An Explore tile is ~187pt wide: 560px keeps it sharp on a 3x screen (~50–70 KB).
const THUMB_WIDTH = 560;
const THUMB_QUALITY = 0.8;
// Fade-in on network loads. The iOS and Android image libraries skip the transition
// for images already in the memory cache, so scrolling back past a tile never
// re-fades it — the same behaviour as Instagram.
export const MEDIA_FADE_MS = 150;

export type MediaPreview = { thumbUrl: string | null; placeholder: string | null };
export const NO_PREVIEW: MediaPreview = { thumbUrl: null, placeholder: null };

// Uploaded under its own unique name: the full file goes up at the same moment
// under a Date.now() path, and two uploads in the same millisecond would collide.
async function uploadSmallCopy(userId: string, uri: string): Promise<string> {
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-s.jpg`;
  const path = `${userId}/${name}`;
  const form = new FormData();
  form.append('file', { uri, name, type: 'image/jpeg' } as any);
  const { error } = await supabase.storage.from('posts').upload(path, form, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return supabase.storage.from('posts').getPublicUrl(path).data.publicUrl;
}

/**
 * The small copy (uploaded) and the thumbhash for a LOCAL picture — the file being
 * posted, a cover, a video's poster frame. Never throws: a preview that fails is a
 * post without one, never a failed post.
 */
export async function makeMediaPreview(localUri: string | null | undefined, userId: string): Promise<MediaPreview> {
  if (!localUri) return NO_PREVIEW;
  let small: string | null = null;
  try {
    const out = await manipulateAsync(localUri, [{ resize: { width: THUMB_WIDTH } }], { compress: THUMB_QUALITY, format: SaveFormat.JPEG });
    small = out.uri;
  } catch {}
  const [thumbUrl, placeholder] = await Promise.all([
    small ? uploadSmallCopy(userId, small).catch(() => null) : Promise.resolve(null),
    Image.generateThumbhashAsync(small ?? localUri).catch(() => null),
  ]);
  return { thumbUrl, placeholder: placeholder || null };
}

// ── Reading side ───────────────────────────────────────────────────────────────

type PreviewPost = {
  type?: string | null;
  media_url?: string | null;
  thumbnail_url?: string | null;
  cover_url?: string | null;
  thumb_url?: string | null;
  placeholder?: string | null;
  slides?: unknown;
};

/** expo-image props for the blurred placeholder + fade. Spread onto an <Image>. */
export function previewImageProps(p: { placeholder?: string | null } | null | undefined): Partial<ImageProps> {
  return p?.placeholder
    ? { placeholder: { thumbhash: p.placeholder }, placeholderContentFit: 'cover', transition: MEDIA_FADE_MS }
    : { transition: MEDIA_FADE_MS };
}

/**
 * For a FULL-SIZE picture (feed card, post viewer): the small copy while the full
 * image loads — sharper than a thumbhash — else the thumbhash, plus the fade.
 */
export function fullImagePreviewProps(p: PreviewPost | null | undefined): Partial<ImageProps> {
  if (p?.thumb_url) return { placeholder: { uri: p.thumb_url }, placeholderContentFit: 'cover', transition: MEDIA_FADE_MS };
  return previewImageProps(p);
}

/** The best picture for a grid tile — the small copy when the post has one. */
export function tileImageUri(p: PreviewPost): string | null {
  if (p.thumb_url) return p.thumb_url;
  if (p.type === 'video') return p.thumbnail_url || (p.media_url ? cfStreamThumbnail(p.media_url) : null);
  if (p.type && isSlideshow(p.type)) return slideshowThumb(p as any);
  if (p.type && isAudioPost(p.type)) return p.cover_url ?? null;
  return p.media_url ?? null;
}
