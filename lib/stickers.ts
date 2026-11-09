import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as RNImage } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Image as ExpoImage } from 'expo-image';
import { liftSubject, subjectLiftAvailable } from '../modules/laybell-subject-lift';

// The user's saved "cutout" stickers — subjects lifted out of photos (Threads-style), kept
// on-device for reuse in the composer. Everything here is local and free: the cutout runs
// on-device (modules/laybell-subject-lift) and the PNGs live in the app's own directory, so
// there's no cloud or per-use cost. A sticker is only uploaded if/when it's baked into a
// posted story, exactly like any other sticker.

export type SavedSticker = { id: string; uri: string; createdAt: number };

const DIR = FileSystem.documentDirectory + 'stickers/';
const INDEX_KEY = 'saved_stickers_v1';
const MAX_STICKERS = 200;

/** Whether this build + device can lift subjects at all (false → never offer it). */
export function stickerLiftAvailable(): boolean {
  return subjectLiftAvailable();
}

async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  } catch { /* ignore */ }
}

// Get a LOCAL file path for the source image so the native lifter can read it. Feed images
// are remote, but expo-image has almost always already cached the one on screen — so we
// reuse that cached file (no re-download). Only if it isn't cached do we fetch it once.
async function ensureLocal(uri: string): Promise<string | null> {
  if (!uri) return null;
  if (uri.startsWith('file://') || uri.startsWith('/')) return uri;
  if (uri.startsWith('http')) {
    try {
      const cached = await ExpoImage.getCachePathAsync(uri);
      if (cached) return cached.startsWith('file') ? cached : `file://${cached}`;
    } catch { /* fall through to a one-off download */ }
    try {
      const tmp = `${FileSystem.cacheDirectory}lift_src_${Date.now()}.img`;
      const res = await FileSystem.downloadAsync(uri, tmp);
      return res.uri;
    } catch { return null; }
  }
  return uri; // content:// / ph:// — let the native side try to open it
}

/**
 * Lift the subject out of a source image and SAVE it to the tray. Returns the saved sticker,
 * or null when there's no clear subject, the source can't be read, or the build/device
 * doesn't support it. Never throws.
 */
export async function captureSubjectSticker(sourceUri: string): Promise<SavedSticker | null> {
  if (!subjectLiftAvailable()) return null;
  try {
    await ensureDir();
    const local = await ensureLocal(sourceUri);
    if (!local) return null;
    const id = `stk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const out = `${DIR}${id}.png`;
    const lifted = await liftSubject(local, out);
    if (!lifted) return null;
    const sticker: SavedSticker = { id, uri: lifted, createdAt: Date.now() };
    const list = await getSavedStickers();
    const next = [sticker, ...list].slice(0, MAX_STICKERS);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(next));
    return sticker;
  } catch {
    return null;
  }
}

/**
 * Lift the subject to a TEMP png (not saved to the tray) so the user can preview it first.
 * Returns the temp file uri, or null if nothing could be cut out. Pair with saveLiftedSticker
 * (keep) or let the cache file be discarded (cancel).
 */
export async function liftPreview(sourceUri: string): Promise<string | null> {
  if (!subjectLiftAvailable()) return null;
  try {
    const local = await ensureLocal(sourceUri);
    if (!local) return null;
    const tmp = `${FileSystem.cacheDirectory}lift_preview_${Date.now()}.png`;
    return await liftSubject(local, tmp);
  } catch {
    return null;
  }
}

/** Keep a previewed cutout: copy it into the tray and index it. Returns the saved sticker. */
export async function saveLiftedSticker(tempUri: string): Promise<SavedSticker | null> {
  try {
    await ensureDir();
    const id = `stk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const dest = `${DIR}${id}.png`;
    await FileSystem.copyAsync({ from: tempUri, to: dest });
    const sticker: SavedSticker = { id, uri: dest, createdAt: Date.now() };
    const list = await getSavedStickers();
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify([sticker, ...list].slice(0, MAX_STICKERS)));
    return sticker;
  } catch {
    return null;
  }
}

/** The saved stickers, newest first. */
export async function getSavedStickers(): Promise<SavedSticker[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as SavedSticker[];
    return Array.isArray(list) ? list.filter((s) => s && s.id && s.uri) : [];
  } catch {
    return [];
  }
}

/** The width/height ratio of a (local) sticker image, so it's placed un-stretched. 1 on error. */
export function getStickerAspect(uri: string): Promise<number> {
  return new Promise((resolve) => {
    try { RNImage.getSize(uri, (w, h) => resolve(h > 0 ? w / h : 1), () => resolve(1)); } catch { resolve(1); }
  });
}

export async function deleteSavedSticker(id: string): Promise<void> {
  try {
    const list = await getSavedStickers();
    const target = list.find((s) => s.id === id);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(list.filter((s) => s.id !== id)));
    if (target) { try { await FileSystem.deleteAsync(target.uri, { idempotent: true }); } catch { /* ignore */ } }
  } catch { /* ignore */ }
}
