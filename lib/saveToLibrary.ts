import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

// Save a REMOTE image/video to the device's camera roll.
//
// Distinct from story-camera's saveToDevice, which hands MediaLibrary a file the
// camera just wrote. Anything already published lives at a URL, so it has to come
// down to disk first — MediaLibrary only accepts local files.
//
// Uses expo-file-system/legacy for the same reason lib/offline.ts does: the SDK
// 54 class API is the newer one, but the rest of this project is on legacy and
// mixing the two in one codebase is how you end up with two cache directories.

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'permission' | 'download' | 'error'; message?: string };

// Extensions MediaLibrary will accept. iOS decides how to file an asset from the
// extension, so an unknown or missing one has to become a sane default rather
// than reach the library as-is and fail there.
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v']);

/**
 * The extension to save under, taken from the URL when it is one we recognise
 * and from the media type otherwise.
 *
 * The query string is stripped first: Supabase public URLs routinely carry
 * `?token=...`, and `split('.').pop()` on the raw URL returns the tail of that
 * token rather than a file type.
 */
export function extensionFor(url: string, kind: 'image' | 'video'): string {
  const path = url.split(/[?#]/)[0];
  const tail = path.split('/').pop() ?? '';
  const ext = tail.includes('.') ? tail.split('.').pop()!.toLowerCase() : '';
  if (kind === 'image' && IMAGE_EXTS.has(ext)) return ext;
  if (kind === 'video' && VIDEO_EXTS.has(ext)) return ext;
  return kind === 'video' ? 'mp4' : 'jpg';
}

export async function saveRemoteToLibrary(
  url: string,
  kind: 'image' | 'video',
): Promise<SaveResult> {
  let localUri: string | null = null;
  try {
    // writeOnly: saving needs "Add Photos Only", not read access to the whole
    // library. Asking for less is both the honest request and the one people
    // are far likelier to grant.
    const perm = await MediaLibrary.requestPermissionsAsync(true);
    if (!perm.granted) return { ok: false, reason: 'permission' };

    const target = `${FileSystem.cacheDirectory}laybell-save-${Date.now()}.${extensionFor(url, kind)}`;
    const dl = await FileSystem.downloadAsync(url, target);
    localUri = dl.uri;
    if (dl.status !== 200) return { ok: false, reason: 'download' };

    await MediaLibrary.saveToLibraryAsync(dl.uri);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  } finally {
    // saveToLibraryAsync COPIES into the photo library, so the download is
    // scratch either way — and leaving it behind would quietly grow the cache by
    // the size of every story anyone ever saved.
    if (localUri) {
      try { await FileSystem.deleteAsync(localUri, { idempotent: true }); } catch {}
    }
  }
}
