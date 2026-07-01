// Image / GIF attachments for comments and messages. Encoded INSIDE the text
// body (the same trick shared posts and story replies use), so no schema change
// is needed: the first line is a marker, and anything after it is the caption.
//
//   laybell://attach?type=<image|gif>&url=<encoded>&w=<n>&h=<n>
//   <optional caption on the next line(s)>
//
// GIFs from the Tenor picker are remote URLs (Tenor-hosted). Uploaded images live
// in the `posts` bucket under the user's own folder (reuses its public read +
// per-user write policies, so no new bucket is required).

import { uploadToStorageWithProgress } from './upload';

// `src` = the id of the ORIGINAL Laybell video a GIF was made from (only set for
// Laybell-made GIFs) — lets the viewer offer "go to the original video".
export type Attachment = { type: 'image' | 'gif'; url: string; w?: number; h?: number; src?: string };
export type ParsedAttachment = Attachment & { text: string };

const PREFIX = 'laybell://attach?';

export function attachmentBody(a: Attachment, caption?: string): string {
  let qs = `type=${a.type}&url=${encodeURIComponent(a.url)}`;
  if (a.w) qs += `&w=${Math.round(a.w)}`;
  if (a.h) qs += `&h=${Math.round(a.h)}`;
  if (a.src) qs += `&src=${encodeURIComponent(a.src)}`;
  const cap = (caption ?? '').trim();
  return cap ? `${PREFIX}${qs}\n${cap}` : `${PREFIX}${qs}`;
}

// Parse a body into an attachment (+ caption), or null if it isn't one.
export function parseAttachment(body: string): ParsedAttachment | null {
  if (!body) return null;
  const nl = body.indexOf('\n');
  const first = (nl === -1 ? body : body.slice(0, nl)).trim();
  if (!first.startsWith(PREFIX)) return null;
  const params: Record<string, string> = {};
  for (const pair of first.slice(PREFIX.length).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    params[eq === -1 ? pair : pair.slice(0, eq)] = eq === -1 ? '' : pair.slice(eq + 1);
  }
  const type = params.type;
  if (type !== 'image' && type !== 'gif') return null;
  let url = params.url || '';
  try { url = decodeURIComponent(url); } catch { /* keep raw */ }
  if (!url) return null;
  let src = params.src || '';
  try { src = decodeURIComponent(src); } catch { /* keep raw */ }
  return {
    type,
    url,
    w: Number(params.w) || undefined,
    h: Number(params.h) || undefined,
    src: src || undefined,
    text: nl === -1 ? '' : body.slice(nl + 1).trim(),
  };
}

// Pick an image/GIF from the library and upload it, returning an Attachment.
// Returns null if the user cancels or denies permission.
export async function pickImageAttachment(userId: string): Promise<Attachment | null> {
  const ImagePicker = await import('expo-image-picker');
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.9,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const a = result.assets[0];
  const name = (a.fileName ?? a.uri).toLowerCase();
  const isGif = name.endsWith('.gif') || a.mimeType === 'image/gif';
  const ext = isGif ? 'gif' : (a.mimeType?.split('/')[1] || a.uri.split('.').pop() || 'jpg');
  const mime = a.mimeType || (isGif ? 'image/gif' : 'image/jpeg');
  const url = await uploadToStorageWithProgress('posts', userId, a.uri, ext, mime);
  return { type: isGif ? 'gif' : 'image', url, w: a.width, h: a.height };
}
