import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { getDeviceId } from './deviceId';
import { getPrefs } from './offlinePrefs';
import { getNetworkState } from './network';

// Offline music engine — see docs/OFFLINE_STREAMING_PLAN.md.
//
// Built on expo-file-system/legacy (the new SDK 54 class API has no progress /
// pause / resume — only the legacy createDownloadResumable does, and the rest of
// the codebase already uses the legacy import: lib/upload.ts).
//
// This module is the SINGLE source of truth for what is cached on-device. It owns
// an in-memory manifest (Map) plus a single-writer persist queue so the concurrent
// writers (pin / remove / Layer-0 auto-cache / eviction) can never corrupt the
// AsyncStorage blob via read-modify-write races. UI subscribes via subscribe().
//
// Everything no-ops on web (file:// caching doesn't apply on react-native-web), so
// OfflineContext and the player resolver are safe to call there.

export type OfflineSource = 'auto' | 'pinned';
export type OfflineState = 'downloading' | 'ready' | 'failed' | 'locked';

export type OfflineEntry = {
  postId: string;
  path: string;            // resolved local file path — the source of truth (never reconstructed)
  bytes: number;
  source: OfflineSource;
  mediaUrl: string;        // remote url at download time — compared for drift at resolve
  ext: string;
  title: string;           // display metadata so the Downloads screen renders offline
  artist: string;
  cover: string | null;
  downloadable: boolean;   // last confirmed creator opt-out state
  checkedAt: number;       // last online verification (ms)
  addedAt: number;
  lastPlayedAt: number;    // LRU recency (for Layer-0 auto-cache)
  state: OfflineState;
};

export type OfflineMeta = { title?: string; artist?: string; cover?: string | null; downloadable?: boolean };

// ── Tunables (docs/OFFLINE_STREAMING_PLAN.md §4) ────────────────────────────────
export const OFFLINE_BYTE_CAP = 3 * 1024 * 1024 * 1024;   // 3 GB hard device ceiling (pinned)
export const FREE_SPACE_FLOOR = 200 * 1024 * 1024;        // refuse downloads below this free space
export const AUTO_MAX_TRACKS = 10;                        // Layer-0 LRU count (Phase B)
export const AUTO_BYTE_BUDGET = 200 * 1024 * 1024;        // Layer-0 byte budget (Phase B)
const MAX_ATTEMPTS_PINNED = 5;
const MAX_ATTEMPTS_AUTO = 2;
const BACKOFF_MS = [2000, 8000, 30000];
const MANIFEST_VERSION = 1;

const isWeb = Platform.OS === 'web';
const DOC_DIR = FileSystem.documentDirectory ?? '';
const CACHE_DIR = FileSystem.cacheDirectory ?? '';
// Per-user directories: files are namespaced by uid so the startup orphan-prune
// (which deletes any file not in the CURRENT user's manifest) can't wipe another
// account's downloads on a shared device. Pinned → document dir (persists);
// auto-cache → cache dir (OS-evictable).
const pinnedDir = () => `${DOC_DIR}offline/${loadedUid}/pinned/`;
const autoDir = () => `${CACHE_DIR}offline/${loadedUid}/auto/`;

// ── In-memory state (module singletons) ─────────────────────────────────────────
let manifest = new Map<string, OfflineEntry>();
let loadedUid: string | null = null;
let initPromise: Promise<void> | null = null;
const inUse = new Set<string>();                          // postIds expo-av currently has loaded
// Prefetch "keep-set": the top/recent songs the offline safety net wants kept on
// device (lib/offlinePrefetch.ts). These auto-cache entries are exempt from the
// reactive LRU eviction below, so a frequently-played favourite isn't dropped just
// because it wasn't the most recent thing played. Bounded by the prefetch itself.
let keepSet = new Set<string>();
const listeners = new Set<() => void>();
let persistChain: Promise<void> = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function manifestKey(uid: string) { return `offline_manifest_v${MANIFEST_VERSION}_${uid}`; }

function emit() { listeners.forEach((l) => { try { l(); } catch {} }); }

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Serialize every persist through one chain, debounced, so concurrent writers
// (pin/remove/evict) never clobber each other's entries.
function schedulePersist() {
  if (isWeb || !loadedUid) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const uid = loadedUid!;
    const snapshot = JSON.stringify(Array.from(manifest.values()));
    persistChain = persistChain.then(async () => {
      try { await AsyncStorage.setItem(manifestKey(uid), snapshot); } catch {}
    });
  }, 400);
  emit();
}

// ── URL / path helpers ──────────────────────────────────────────────────────────
export function extOf(url: string): string {
  const clean = url.split('?')[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : 'mp3';
}

function localPath(postId: string, source: OfflineSource, ext: string): string {
  return `${source === 'pinned' ? pinnedDir() : autoDir()}${postId}.${ext}`;
}

async function ensureDirs() {
  if (isWeb || !loadedUid) return;
  for (const dir of [pinnedDir(), autoDir()]) {
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    } catch {}
  }
}

async function fileBytes(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? ((info as any).size ?? 0) : 0;
  } catch { return 0; }
}

async function safeDelete(uri: string) {
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
}

// ── Init / reconcile ────────────────────────────────────────────────────────────
// Load the manifest for a user and reconcile it against the real filesystem:
// drop entries whose file vanished (OS purge / failed write), and delete orphan
// files with no entry. Mirrors resolvableBlocks() in lib/pageLayout.ts.
export async function initOffline(uid: string): Promise<void> {
  if (isWeb) { loadedUid = uid; return; }
  if (loadedUid === uid && initPromise) return initPromise;
  // A different user (account switch) — drop the previous user's in-memory state
  // SYNCHRONOUSLY before the async rebuild, so their downloads never flash on the
  // new account during the load gap. Also clears the in-use lock + pending persist.
  if (loadedUid !== uid) {
    manifest = new Map();
    inUse.clear();
    keepSet.clear();   // the prefetch set is per-user; don't protect the old user's ids
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    emit();
  }
  loadedUid = uid;
  initPromise = (async () => {
    await ensureDirs();
    let entries: OfflineEntry[] = [];
    try {
      const raw = await AsyncStorage.getItem(manifestKey(uid));
      if (raw) entries = JSON.parse(raw) as OfflineEntry[];
    } catch { entries = []; }   // corrupt blob → rebuild from disk below

    const next = new Map<string, OfflineEntry>();
    for (const e of entries) {
      if (!e || !e.postId || !e.path) continue;
      const bytes = await fileBytes(e.path);
      if (bytes > 0) next.set(e.postId, { ...e, bytes });   // file present → keep, refresh size
      // else: file gone (OS purge / partial) → drop the entry silently
    }

    // Prune orphan files (on disk but not in the rebuilt manifest) + stray .part.
    // Scans only THIS user's dirs (per-uid namespaced), so it never touches another
    // account's files on a shared device.
    for (const dir of [pinnedDir(), autoDir()]) {
      try {
        const names = await FileSystem.readDirectoryAsync(dir);
        for (const name of names) {
          const postId = name.replace(/\.[^.]+$/, '');
          if (name.endsWith('.part') || !next.has(postId)) await safeDelete(`${dir}${name}`);
        }
      } catch {}
    }

    manifest = next;
    emit();
    schedulePersist();
  })();
  return initPromise;
}

// ── Reads ───────────────────────────────────────────────────────────────────────
export function getEntry(postId: string): OfflineEntry | undefined { return manifest.get(postId); }
export function isReady(postId: string): boolean { return manifest.get(postId)?.state === 'ready'; }
export function isPinned(postId: string): boolean {
  const e = manifest.get(postId);
  return !!e && e.source === 'pinned' && (e.state === 'ready' || e.state === 'downloading' || e.state === 'locked');
}
export function allEntries(): OfflineEntry[] { return Array.from(manifest.values()); }
export function pinnedEntries(): OfflineEntry[] { return allEntries().filter((e) => e.source === 'pinned'); }
export function totalBytes(source?: OfflineSource): number {
  return allEntries()
    .filter((e) => (source ? e.source === source : true) && e.state !== 'failed')
    .reduce((sum, e) => sum + (e.bytes || 0), 0);
}

// Eviction lock: never delete a file expo-av currently has loaded.
export function markInUse(postId: string) { inUse.add(postId); }
export function clearInUse(postId: string) { inUse.delete(postId); }

// Resolve a track's playback URI: a verified local file:// when cached, else null
// (caller falls back to the remote URL — that IS our offline detection in Phase A:
// try local first, otherwise stream; on a stream failure the next play retries).
export async function resolveLocalUri(postId: string, remoteUrl: string): Promise<string | null> {
  if (isWeb) return null;
  const e = manifest.get(postId);
  if (!e || e.state === 'failed' || e.state === 'downloading') return null;
  // Drift: the source was re-uploaded to a new path → our copy is stale.
  if (e.mediaUrl && remoteUrl && e.mediaUrl !== remoteUrl) return null;
  // Opted-out since download → don't serve the local copy.
  if (e.downloadable === false) return null;
  // Never trust the manifest alone: confirm the bytes are really there.
  const bytes = await fileBytes(e.path);
  if (bytes <= 0) { manifest.delete(postId); schedulePersist(); return null; }
  // Touch LRU recency cheaply (debounced persist).
  e.lastPlayedAt = Date.now();
  return e.path.startsWith('file://') ? e.path : `file://${e.path}`;
}

// ── Download core ────────────────────────────────────────────────────────────────
async function freeSpaceOk(): Promise<boolean> {
  try { return (await FileSystem.getFreeDiskStorageAsync()) > FREE_SPACE_FLOOR; }
  catch { return true; }   // can't tell → don't block
}

// Download to a .part temp, verify (HTTP 200 + size sane), atomically rename to the
// final path. Returns bytes on success, throws on failure. Stops permanently on
// 403/404 (deleted or opted-out source) by throwing a non-retryable marker.
class PermanentError extends Error {}

async function downloadVerified(
  remoteUrl: string, finalPath: string, onProgress?: (f: number) => void,
): Promise<number> {
  const partPath = `${finalPath}.part`;
  await safeDelete(partPath);
  const task = FileSystem.createDownloadResumable(
    remoteUrl, partPath, {},
    (p) => {
      const total = (p as any).totalBytesExpectedToWrite;
      if (total > 0) onProgress?.(Math.min(1, (p as any).totalBytesWritten / total));
    },
  );
  const res = await task.downloadAsync();
  if (!res) throw new Error('download failed');
  if (res.status === 403 || res.status === 404) { await safeDelete(partPath); throw new PermanentError(`http ${res.status}`); }
  if (res.status < 200 || res.status >= 300) { await safeDelete(partPath); throw new Error(`http ${res.status}`); }

  const written = await fileBytes(partPath);
  const expectedRaw = (res.headers?.['Content-Length'] ?? res.headers?.['content-length']);
  const expected = expectedRaw ? parseInt(String(expectedRaw), 10) : 0;
  if (written <= 0 || (expected > 0 && written < expected)) {
    await safeDelete(partPath);
    throw new Error('incomplete download');
  }
  await safeDelete(finalPath);
  await FileSystem.moveAsync({ from: partPath, to: finalPath });
  return written;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof PermanentError) throw e;   // 403/404 → no point retrying
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]));
      }
    }
  }
  throw lastErr;
}

// ── Pin (Layer 1) ─────────────────────────────────────────────────────────────
export type PinResult = { ok: true } | { ok: false; reason: 'web' | 'space' | 'cap' | 'permanent' | 'error' };

// Download a track for keeps. Caller MUST have already enforced the per-tier count
// limit (offlinePinLimit) at action time. Here we enforce the hard byte cap + free
// space, then download + record. Idempotent: re-pinning a ready track is a no-op.
export async function pinTrack(
  postId: string, remoteUrl: string, meta: OfflineMeta = {}, onProgress?: (f: number) => void,
): Promise<PinResult> {
  if (isWeb) return { ok: false, reason: 'web' };
  if (!loadedUid) return { ok: false, reason: 'error' };  // not inited → never write to a null-uid path
  await initOffline(loadedUid);
  const existing = manifest.get(postId);
  if (existing?.source === 'pinned' && existing.state === 'ready') return { ok: true };
  if (meta.downloadable === false) return { ok: false, reason: 'permanent' };
  if (!(await freeSpaceOk())) return { ok: false, reason: 'space' };
  if (totalBytes('pinned') >= OFFLINE_BYTE_CAP) return { ok: false, reason: 'cap' };

  await ensureDirs();
  const ext = extOf(remoteUrl);
  const path = localPath(postId, 'pinned', ext);
  const now = Date.now();
  const draft: OfflineEntry = {
    postId, path, bytes: 0, source: 'pinned', mediaUrl: remoteUrl, ext,
    title: meta.title ?? '', artist: meta.artist ?? '', cover: meta.cover ?? null,
    downloadable: true, checkedAt: now, addedAt: now,   // opt-out (=== false) already returned above
    lastPlayedAt: now, state: 'downloading',
  };
  manifest.set(postId, draft);
  emit();

  try {
    const bytes = await withRetry(() => downloadVerified(remoteUrl, path, onProgress), MAX_ATTEMPTS_PINNED);
    manifest.set(postId, { ...draft, bytes, state: 'ready' });
    schedulePersist();
    void recordDownload(postId);
    return { ok: true };
  } catch (e) {
    // If a previous good copy existed (re-pin attempt), keep it; else drop the draft.
    if (existing?.state === 'ready') { manifest.set(postId, existing); }
    else { manifest.delete(postId); }
    await safeDelete(path);
    emit();
    schedulePersist();
    return { ok: false, reason: e instanceof PermanentError ? 'permanent' : 'error' };
  }
}

// ── Auto-cache (Layer 0: the offline safety net) ────────────────────────────────
// Best-effort: opportunistically keep the last few played tracks on-device so a
// dead-zone drop doesn't stop the music. Gated by the user's prefs (on by default,
// Wi-Fi-only by default), connectivity, free space, and the creator opt-out. Stored
// in the OS-evictable cache dir and held to a small LRU budget. Fire-and-forget from
// the player; never blocks playback.
export async function autoCache(postId: string, remoteUrl: string, meta: OfflineMeta = {}): Promise<void> {
  if (isWeb || !loadedUid) return;
  if (meta.downloadable === false) return;
  // Already pinned / cached / downloading → nothing to do.
  const existing = manifest.get(postId);
  if (existing && existing.state !== 'failed') return;

  let prefs;
  try { prefs = await getPrefs(); } catch { return; }
  if (!prefs.autoCache) return;

  const net = await getNetworkState();
  if (!net.isConnected) return;                  // offline → can't fetch
  if (prefs.wifiOnly && !net.isWifi) return;     // respect Wi-Fi-only (no cellular surprise)
  if (!(await freeSpaceOk())) return;

  await ensureDirs();
  const ext = extOf(remoteUrl);
  const path = localPath(postId, 'auto', ext);
  const now = Date.now();
  const draft: OfflineEntry = {
    postId, path, bytes: 0, source: 'auto', mediaUrl: remoteUrl, ext,
    title: meta.title ?? '', artist: meta.artist ?? '', cover: meta.cover ?? null,
    downloadable: true, checkedAt: now, addedAt: now, lastPlayedAt: now, state: 'downloading',
  };
  manifest.set(postId, draft);
  emit();
  try {
    const bytes = await withRetry(() => downloadVerified(remoteUrl, path), MAX_ATTEMPTS_AUTO);
    // If the user pinned this track while we were downloading, the pin wins — keep
    // its entry and discard our auto copy.
    if (manifest.get(postId)?.source === 'pinned') { await safeDelete(path); return; }
    manifest.set(postId, { ...draft, bytes, state: 'ready' });
    schedulePersist();
    await evictAuto();
  } catch {
    if (manifest.get(postId)?.source === 'auto') manifest.delete(postId);
    await safeDelete(path);
    emit();
    schedulePersist();
  }
}

// Mark the prefetch keep-set (top/recent songs). These auto entries are protected
// from the reactive LRU eviction below; the remaining "as you play" auto-cache is
// still bounded by AUTO_MAX_TRACKS / AUTO_BYTE_BUDGET. Called by lib/offlinePrefetch.
export function setKeepSet(ids: string[]) { keepSet = new Set(ids); }

// LRU eviction for the auto-cache: keep the REACTIVE (non-keep-set) auto entries within
// AUTO_MAX_TRACKS and AUTO_BYTE_BUDGET, dropping the least-recently-played first. Never
// evicts pinned tracks, the prefetch keep-set, or the file the player currently has
// loaded (in-use lock). The keep-set is bounded by the prefetch (top-N + recent-N), so
// it can sit on top of the reactive budget without being capped here.
async function evictAuto(): Promise<void> {
  const evictable = allEntries()
    .filter((e) => e.source === 'auto' && e.state === 'ready' && !keepSet.has(e.postId))
    .sort((a, b) => (a.lastPlayedAt || a.addedAt) - (b.lastPlayedAt || b.addedAt));
  let count = evictable.length;
  let bytes = evictable.reduce((s, e) => s + (e.bytes || 0), 0);
  let changed = false;
  for (const e of evictable) {
    if (count <= AUTO_MAX_TRACKS && bytes <= AUTO_BYTE_BUDGET) break;
    if (inUse.has(e.postId)) continue;           // never evict the loaded track
    manifest.delete(e.postId);
    await safeDelete(e.path);
    count--; bytes -= (e.bytes || 0);
    changed = true;
  }
  if (changed) { emit(); schedulePersist(); }
}

// Remove a download (user-initiated). Respects the in-use lock: if the track is
// currently loaded in the player we still drop the manifest entry but defer the
// file delete until it's no longer in use (cleaned on next reconcile).
export async function removeTrack(postId: string): Promise<void> {
  if (isWeb) return;
  const e = manifest.get(postId);
  manifest.delete(postId);
  emit();
  schedulePersist();
  if (e && !inUse.has(postId)) await safeDelete(e.path);
  void forgetDownload(postId);
}

// Re-confirm opt-out / drift for cached tracks when back online. Purges any whose
// source post is now opted-out or re-uploaded. Best-effort; safe to call on app
// foreground. `posts` are the freshly-fetched rows for the cached ids. When
// `requestedIds` is given, any requested id MISSING from `posts` is also purged —
// that means the post was deleted, made private, or its author blocked us (the
// fetch is RLS-filtered, so an inaccessible post simply doesn't come back).
export async function reconcileAgainst(
  posts: { id: string; media_url?: string | null; downloadable?: boolean | null }[],
  requestedIds?: string[],
) {
  if (isWeb || !manifest.size) return;
  const byId = new Map(posts.map((p) => [p.id, p]));
  const requested = requestedIds ? new Set(requestedIds) : null;
  let changed = false;
  const purge = async (postId: string, path: string) => {
    manifest.delete(postId);
    if (!inUse.has(postId)) await safeDelete(path);
    changed = true;
  };
  for (const e of Array.from(manifest.values())) {
    const p = byId.get(e.postId);
    if (!p) {
      if (requested?.has(e.postId)) await purge(e.postId, e.path);  // asked but gone → inaccessible
      continue;
    }
    const optedOut = p.downloadable === false;
    const drifted = !!p.media_url && p.media_url !== e.mediaUrl;
    if (optedOut || drifted) await purge(e.postId, e.path);
    else e.checkedAt = Date.now();
  }
  if (changed) { emit(); schedulePersist(); }
}

// ── Analytics RPCs (fire-and-forget; 404 if migration not applied → no-op) ──────
async function recordDownload(postId: string) {
  try {
    const deviceId = await getDeviceId();
    await supabase.rpc('record_download', { p_post_id: postId, p_device_id: deviceId }).then(undefined, () => {});
  } catch {}
}
async function forgetDownload(postId: string) {
  try { await supabase.rpc('forget_download', { p_post_id: postId }).then(undefined, () => {}); } catch {}
}

// Wipe everything for the current user (e.g. account deletion / sign-out cleanup).
export async function clearAllOffline(): Promise<void> {
  if (isWeb || !loadedUid) return;
  for (const dir of [pinnedDir(), autoDir()]) await safeDelete(dir);
  manifest = new Map();
  emit();
  try { await AsyncStorage.removeItem(manifestKey(loadedUid)); } catch {}
}
