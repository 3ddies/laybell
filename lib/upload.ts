import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';

// react-native-compressor 2.x is built on react-native-nitro-modules, which hard
// -crashes in Expo Go ("NitroModules are not supported in Expo Go"). Detect the
// Expo Go client so we can skip the native re-encode there entirely (Cloudflare
// Stream transcodes server-side anyway, so quality is unaffected).
const IS_EXPO_GO = Constants.executionEnvironment === 'storeClient';

// ── Native module switches ────────────────────────────────────────────────────
// These were ONE flag, killed together on 2026-08-05 after the first binary
// containing them showed instant failures and crashes. Six subsequent root
// causes were found in the upload pipeline itself, so the evidence against the
// COMPRESSOR specifically is now weak — and compressing is the only thing that
// makes a long video fit the one transport that has never failed (a single
// POST under 200 MB). Every large app transcodes on device for exactly this
// reason; pushing a raw multi-GB master from a phone is the thing that doesn't
// work, not the thing to keep retrying.
//
// So: compressor ON (it is the fix), trimmer still OFF (a separate native
// module, and virtual trim already produces a correct post — no reason to
// reintroduce that risk for zero gain).
export const NATIVE_COMPRESS_ENABLED = true;
export const NATIVE_TRIM_ENABLED = false;

// Threshold (bytes) above which we transcode before upload. Below it a clip is
// already small/fast enough that re-encoding only adds latency. 12 MB comfortably
// covers a short 1080p clip; anything bigger (4K/HEVC iPhone footage, long HD
// clips) gets shrunk to feed-friendly H.264 first.
const COMPRESS_FLOOR_BYTES = 12 * 1024 * 1024;

// Cloudflare Stream's cap for basic (non-tus) direct uploads — and our uploader
// speaks exactly that: one multipart POST (see lib/streamUpload.ts). A file past
// this is not "risky", it is guaranteed to be rejected server-side, after the
// user has watched the whole progress bar. Callers gate on this BEFORE a byte
// moves. Raising the published video windows past ~9 minutes of 1080p means
// replacing the POST uploader with tus, not editing this number.
export const STREAM_POST_MAX_BYTES = 200 * 1024 * 1024;
// What a LONG video aims for after compression: comfortably under the POST cap.
// The margin covers what the bitrate target doesn't: the audio track (~10 MB at
// the 10-minute source max), VBR overshoot, and the multipart envelope.
const TARGET_LONG_UPLOAD_BYTES = 180 * 1024 * 1024;

// ── Film quality budget ───────────────────────────────────────────────────────
// A FILM does not have to fit Cloudflare's 200 MB direct-upload cap, because it
// travels by staging (upload to our storage → Cloudflare fetches it), so its
// budget is set by what looks good rather than by a transport limit. Squeezing
// a 13-minute film into 180 MB meant ~1.9 Mbps, which is why the first
// successful film looked poor no matter how the pixels were arranged.
//
// 8 Mbps — Cloudflare's OWN recommended input bitrate for 1080p.
//
// This number is not about what viewers receive (Stream's ladder tops out at
// 1080p regardless); it is about DOUBLE COMPRESSION. A film is encoded twice:
// once here, 4K source → 1080p, and again by Cloudflare into its delivery
// renditions. Every artifact the first pass introduces is baked in before the
// second pass ever sees the frame. Handing Stream a near-transparent master is
// the only lever left on final quality — at 5 Mbps the first pass was already
// throwing away detail the second pass could never recover.
const FILM_TARGET_BITRATE = 8_000_000;
// Absolute size ceiling, so the longest film can't produce something
// unuploadable. A 1-hour film at the target lands at 3.6 GB; this leaves room
// for that plus VBR overshoot and audio, and still sits under the 5 GB
// video-staging bucket limit.
const FILM_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Bitrate a film of this length should encode at, in bits/sec. */
export function filmBitrateFor(durationSec: number): number {
  if (!durationSec || durationSec <= 0) return FILM_TARGET_BITRATE;
  return Math.min(FILM_TARGET_BITRATE, Math.floor((FILM_MAX_BYTES * 8) / durationSec));
}
// Above this duration 'auto' can no longer be trusted to land under the cap, so
// the bitrate is computed from the duration instead. At exactly 5 minutes the
// computed target (~4.9 Mbps) is right in 'auto' range, so the handoff between
// the two modes is seamless quality-wise; by the 9-minute landscape window it
// has eased to ~2.7 Mbps, which Stream's own ABR ladder re-encodes anyway.
const ADAPTIVE_BITRATE_ABOVE_SEC = 300;

// Long-edge cap for a given bitrate, in the units the compressor's `maxSize`
// takes. Each threshold is roughly the floor at which that resolution still
// looks clean in H.264: below it, the same bits buy a visibly better picture
// at the next size down. bitrate = 0 means 'auto' mode (short clips), which
// picks its own bitrate from the source and can keep full 1080p.
function resolutionCapFor(bitrate: number): number {
  if (!bitrate) return 1920;        // 'auto' — source-driven, leave it alone
  if (bitrate >= 4_000_000) return 1920; // 1080p
  if (bitrate >= 2_000_000) return 1280; // 720p
  return 960;                            // 540p — still sharp, never mush
}

// The upload task (and Cloudflare) only speak file:// — but a picked video can be
// a ph:// / assets-library:// Photos asset when MediaLibrary has no local copy
// (iCloud / storage-optimized clips). Copy such assets into the cache first so the
// uploader has a readable file. (In dev/store builds the compressor already emits
// a file://; this covers Expo Go, where compression is skipped.)
// Stable per-source name. `Date.now()` here was catastrophic for long uploads:
// the localized path IS the identity that tus resume state is keyed by, so a
// fresh timestamp on every attempt meant every retry looked like a different
// video. Resume could never match, so each retry minted a NEW Cloudflare
// upload and re-sent the whole file from zero — three assets for one video,
// none ever finishing. All the resume machinery was correct and unreachable.
// Deriving the name from the SOURCE uri makes a retry land on the same file,
// which both restores resume AND skips re-copying gigabytes.
function stableKey(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

// Is this file inside OUR sandbox (cache/documents), as opposed to somewhere we
// only have read-through access, like the camera roll?
function insideAppSandbox(uri: string): boolean {
  const cache = FileSystem.cacheDirectory ?? '';
  const docs = FileSystem.documentDirectory ?? '';
  return (!!cache && uri.startsWith(cache)) || (!!docs && uri.startsWith(docs));
}

export async function ensureLocalFile(uri: string): Promise<string> {
  if (!uri) return uri;
  // A `file://` path is NOT automatically usable. A camera-roll pick is a
  // file:// URL into the Photos store (…/DCIM/126APPLE/IMG_1234.MOV), and iOS
  // grants the app only limited access to it: AVFoundation opens the container
  // but finds no readable track, which surfaces as the transcoder's
  //   CompressionError("Invalid video URL, no track found")
  // — i.e. compression silently never ran, the master stayed multi-GB, and
  // every transport downstream inherited a file too big to send. Skipping the
  // copy for file:// URIs (the old rule) is what made that inevitable.
  //
  // So the test is not "does it have a scheme", it is "is it OURS".
  if (uri.startsWith('file://') && insideAppSandbox(uri)) return uri;
  try {
    const dest = `${FileSystem.cacheDirectory}upload_${stableKey(uri)}.mp4`;
    // Already localized by an earlier attempt → reuse it verbatim, so a retry
    // never re-copies gigabytes.
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists && ((info as any).size ?? 0) > 0) return dest;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri; // couldn't localize — let the caller surface the original error
  }
}

// Exported so the composer can warn about a huge upload BEFORE the details step
// prewarms it. Returns 0 when the size can't be read (ph:// assets that haven't
// been localized yet) — callers treat 0 as "unknown, don't block".
export async function fileSizeBytes(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? ((info as any).size ?? 0) : 0;
  } catch {
    return 0;
  }
}

// Compress a video to a 1080p-class H.264 file before upload (4K iPhone clips
// shrink ~5-10x with no visible loss at feed sizes, and HEVC/H.265 footage is
// re-encoded to H.264 so it plays everywhere). This is THE reason posting feels
// instant on the big apps: they never push a raw 200 MB capture up the wire.
//
// react-native-compressor is a NATIVE module — until the app binary is rebuilt
// with it (dev client or store build), the dynamic import throws and we fall
// back to the original bytes, so this ships safely ahead of that rebuild. When
// it falls back, large files lean on the raised bucket/global size limit (see
// supabase/sql/storage_limits.sql) to still go through.
export async function compressVideoIfPossible(
  uri: string,
  onProgress?: (fraction: number) => void,
  // Duration (seconds) of THIS file — the one being uploaded, so the physically
  // cut window when a trim really happened, the whole source when it didn't.
  // 0/omitted = unknown → 'auto', never a guessed squeeze on a short clip.
  durationSec?: number,
  // FILM = travels by staging, so it isn't bound by Cloudflare's 200 MB direct
  // upload cap and gets a quality-led budget instead of a size-led one.
  film?: boolean,
): Promise<string> {
  try {
    if (!NATIVE_COMPRESS_ENABLED) return uri; // see the switches at the top of this file
    // Expo Go can't load the Nitro-based compressor at all — importing it there
    // throws a fatal error, so bail to the original bytes before touching it.
    if (IS_EXPO_GO) return uri;

    // Already-small clips: skip the re-encode entirely (keeps posting snappy).
    const bytes = await fileSizeBytes(uri);
    if (bytes && bytes < COMPRESS_FLOOR_BYTES) return uri;

    // LONG uploads (the 9-minute landscape window, or a long source kept whole
    // because the native trimmer isn't in this build) get a bitrate computed so
    // the OUTPUT lands under Cloudflare's 200 MB POST cap by construction —
    // 'auto' picks by source characteristics and knows nothing about that wall.
    // A film is always bitrate-targeted (quality budget); a non-film only once
    // it is long enough that 'auto' can no longer be trusted under the cap.
    const adaptive = !!durationSec && (film || durationSec > ADAPTIVE_BITRATE_ABOVE_SEC);
    const bitrate = !adaptive
      ? 0
      : film
        ? filmBitrateFor(durationSec!)
        : Math.round((TARGET_LONG_UPLOAD_BYTES * 8) / durationSec!);
    const { Video } = await import('react-native-compressor');
    const out = await Video.compress(
      uri,
      {
        ...(adaptive
          ? { compressionMethod: 'manual' as const, bitrate }
          : { compressionMethod: 'auto' as const }), // adapts bitrate to the source, like the big apps
        // RESOLUTION FOLLOWS THE BITRATE. Forcing 1080p at a bitrate 1080p
        // can't sustain is why a 13-minute film looked bad: the size budget
        // works out to ~1.9 Mbps, roughly a quarter of what 1920x1080 needs,
        // so the encoder spread too few bits over too many pixels and
        // everything went soft and blocky. Fewer pixels at the same bitrate is
        // sharper — and Cloudflare rebuilds its own ABR ladder afterwards
        // anyway, so handing it a clean 720p master beats a mushy 1080p one.
        maxSize: resolutionCapFor(bitrate),
        // We already gate on size above, so don't let the library skip anything
        // we decided is worth shrinking.
        minimumFileSizeForCompress: 0,
        progressDivider: 4,
      },
      (p: number) => onProgress?.(Math.min(1, p)),
    );
    return out || uri;
  } catch (e: any) {
    // NEVER swallow this silently again. A failed transcode is the difference
    // between a video that posts and one that cannot, and for days this catch
    // hid the reason behind a generic "too large" — sending us to redesign
    // transports when the real problem was one module refusing to load.
    lastCompressError = e?.message ? String(e.message) : String(e);
    return uri; // module not in this build / compression failed → original bytes
  }
}

// The reason the most recent compression attempt failed, for the error the user
// actually sees. Module-scoped because the failure has to travel from here to
// the upload queue without changing a shared signature.
let lastCompressError: string | null = null;
export function getLastCompressError(): string | null { return lastCompressError; }

// ── Film mezzanine ────────────────────────────────────────────────────────────
// Films used to upload the RAW source ("full quality is the perk") — but
// Cloudflare's playback ladder tops out at 1080p, so a 4K/50-Mbps camera file
// is 3-6× the bytes for zero visible difference after the re-encode. This is
// the actual reason YouTube uploads feel fast: the phone transcodes FIRST.
// Films therefore compress to a HIGH-bitrate 1080p mezzanine — far above the
// squeezed free-tier target, visually transparent at 1080p delivery — and the
// perk stays honest: films remain the highest-bitrate video on the platform.
export const FILM_MEZZANINE_BPS = 7_000_000;

// Sources already at/below mezzanine bitrate (downloads, prior exports) skip
// the re-encode entirely — re-encoding those wastes minutes AND quality.
const MEZZ_SKIP_FACTOR = 1.15;

// Retries must NOT recompress (minutes of work), and tus RESUME is keyed to
// the file it was uploading — so the compressed output must be the SAME file
// across attempts. Cache maps source → output; entries die with their files.
const MEZZ_CACHE_KEY = 'film_mezz_cache';
const MEZZ_CACHE_MAX = 3;

type MezzEntry = { key: string; out: string; at: number };

async function readMezzCache(): Promise<MezzEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(MEZZ_CACHE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e?.key && e?.out) : [];
  } catch { return []; }
}
async function writeMezzCache(list: MezzEntry[]): Promise<void> {
  try { await AsyncStorage.setItem(MEZZ_CACHE_KEY, JSON.stringify(list.slice(-MEZZ_CACHE_MAX))); } catch {}
}

/** Compress a film to the mezzanine (cache-aware). Returns the file to upload —
 *  the original when compression is unavailable, already-lean, or fails. */
export async function prepareFilmMezzanine(
  uri: string,
  durationSec: number,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  try {
    if (!NATIVE_COMPRESS_ENABLED) return uri; // see the switches at the top of this file
    if (IS_EXPO_GO) return uri;
    const srcBytes = await fileSizeBytes(uri);
    if (!srcBytes) return uri;
    // Already lean → upload as-is (no quality lost re-encoding a re-encode).
    if (durationSec > 0 && (srcBytes * 8) / durationSec <= FILM_MEZZANINE_BPS * MEZZ_SKIP_FACTOR) return uri;

    const key = `${uri}::${srcBytes}`;
    const cache = await readMezzCache();
    const hit = cache.find((e) => e.key === key);
    if (hit && (await fileSizeBytes(hit.out)) > 0) {
      onProgress?.(1);
      return hit.out;
    }

    const { Video } = await import('react-native-compressor');
    const out = await Video.compress(
      uri,
      {
        compressionMethod: 'manual' as const,
        bitrate: FILM_MEZZANINE_BPS,
        maxSize: 1920,
        minimumFileSizeForCompress: 0,
        progressDivider: 4,
      },
      (p: number) => onProgress?.(Math.min(1, p)),
    );
    if (!out || out === uri) return uri;
    const next = cache.filter((e) => e.key !== key);
    next.push({ key, out, at: Date.now() });
    // Evict the oldest beyond the cap — delete their (large) files too.
    while (next.length > MEZZ_CACHE_MAX) {
      const dead = next.shift()!;
      FileSystem.deleteAsync(dead.out, { idempotent: true }).catch(() => {});
    }
    await writeMezzCache(next);
    return out;
  } catch {
    return uri; // any failure → original bytes (slower, never lost)
  }
}

/** The film posted (or was abandoned for good) — drop its mezzanine from disk. */
export async function releaseFilmMezzanine(sourceUri: string): Promise<void> {
  const cache = await readMezzCache();
  const keep: MezzEntry[] = [];
  for (const e of cache) {
    if (e.key.startsWith(`${sourceUri}::`)) {
      FileSystem.deleteAsync(e.out, { idempotent: true }).catch(() => {});
    } else keep.push(e);
  }
  await writeMezzCache(keep);
}

// Storage upload with REAL progress, for big files (3-minute videos can be
// hundreds of MB). The supabase-js client buffers FormData with no progress
// events, so this streams the file straight to the Storage REST endpoint via
// the native uploader (expo-file-system upload task) and reports bytes as
// they leave the device. Returns the file's public URL, like the other
// upload helpers.
export async function uploadToStorageWithProgress(
  bucket: string,
  userId: string,
  uri: string,
  ext: string,
  mime: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const name = `${Date.now()}.${ext}`;
  const path = `${userId}/${name}`;

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const task = FileSystem.createUploadTask(
    `${supabaseUrl}/storage/v1/object/${bucket}/${path}`,
    uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      // FOREGROUND on purpose: iOS defaults upload tasks to a BACKGROUND
      // NSURLSession, which appends a #bplist state fragment to the URL and
      // fails with NSURLError -1 "unknown error" in dev/standalone builds.
      // A foreground session streams the same progress, reliably; the upload
      // just pauses if the app is backgrounded (acceptable for now).
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'Content-Type': mime,
        'x-upsert': 'false',
      },
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      if (totalBytesExpectedToSend > 0) {
        onProgress?.(Math.min(1, totalBytesSent / totalBytesExpectedToSend));
      }
    },
  );

  const res = await task.uploadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    // Surface the server's reason when there is one (e.g. bucket size limit).
    let detail = '';
    try { detail = JSON.parse(res?.body ?? '')?.message ?? ''; } catch {}
    throw new Error(detail || `Upload failed (${res?.status ?? 'network error'})`);
  }
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

// ── Long-video staging ────────────────────────────────────────────────────────
// ONE native upload of the master into the private video-staging bucket, then
// Cloudflare fetches it server-side (see lib/streamCopy.ts). This replaces the
// hand-rolled chunked uploader entirely: the OS owns the transfer, so there
// are no byte offsets, no resume bookkeeping, and nothing to reconcile — the
// three things that produced every long-video failure.
export const VIDEO_STAGING_BUCKET = 'video-staging';

/** Uploads to video-staging and returns the storage PATH (not a URL — the
 *  bucket is private; callers mint a short-lived signed URL for Cloudflare). */
export async function uploadToStaging(
  userId: string,
  uri: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  // Deterministic per-source name so a retry overwrites its own partial object
  // instead of stacking multi-GB copies (the timestamped-name mistake that
  // silently broke resume in the old uploader).
  const path = `${userId}/${stableKey(uri)}.mp4`;

  // Already fully staged by an earlier attempt → skip the transfer entirely.
  // This is what makes Retry cheap after a throttled hand-off: the bytes are
  // on the server, and re-sending them would punish the user for Cloudflare's
  // rate limiter.
  try {
    const local = await fileSizeBytes(uri);
    const { data: existing } = await supabase.storage
      .from(VIDEO_STAGING_BUCKET)
      .list(userId, { search: `${stableKey(uri)}.mp4`, limit: 1 });
    const staged = existing?.[0]?.metadata?.size ?? 0;
    if (local > 0 && staged === local) {
      onProgress?.(1);
      return path;
    }
  } catch { /* couldn't check — just upload */ }

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const task = FileSystem.createUploadTask(
    `${supabaseUrl}/storage/v1/object/${VIDEO_STAGING_BUCKET}/${path}`,
    uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      // REVERTED to FOREGROUND (2026-08-07). BACKGROUND is theoretically the
      // right session for a large transfer — days-long resource timeout instead
      // of a 60s idle window — but expo-file-system's background session fails
      // INSTANTLY on this setup (the long-known NSURLError -1 / #bplist bug).
      // A foreground session that sometimes times out beats one that never
      // starts, so this stays until the underlying module is fixed.
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'Content-Type': 'video/mp4',
        // Overwrite a previous attempt's object rather than 409-ing on it.
        'x-upsert': 'true',
      },
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      if (totalBytesExpectedToSend > 0) onProgress?.(Math.min(1, totalBytesSent / totalBytesExpectedToSend));
    },
  );

  const res = await task.uploadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    let detail = '';
    try { detail = JSON.parse(res?.body ?? '')?.message ?? ''; } catch {}
    if (res?.status === 413) {
      const err: any = new Error('This video is larger than the upload limit');
      err.code = 'video_too_large';
      throw err;
    }
    throw new Error(detail || `Upload failed (${res?.status ?? 'network error'})`);
  }
  return path;
}

/** Short-lived URL Cloudflare can fetch the staged master from. */
export async function signStagingUrl(path: string, seconds = 3600): Promise<string> {
  const { data, error } = await supabase.storage.from(VIDEO_STAGING_BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw new Error('Could not prepare the video for transfer');
  return data.signedUrl;
}

/** Drop the staged master once Cloudflare has ingested it. Best-effort: the
 *  hourly sweep_video_staging() cron is the backstop. */
export async function removeStaged(path: string): Promise<void> {
  try { await supabase.storage.from(VIDEO_STAGING_BUCKET).remove([path]); } catch { /* cron will get it */ }
}
