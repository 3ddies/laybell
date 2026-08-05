import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';

// react-native-compressor 2.x is built on react-native-nitro-modules, which hard
// -crashes in Expo Go ("NitroModules are not supported in Expo Go"). Detect the
// Expo Go client so we can skip the native re-encode there entirely (Cloudflare
// Stream transcodes server-side anyway, so quality is unaffected).
const IS_EXPO_GO = Constants.executionEnvironment === 'storeClient';

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
// Above this duration 'auto' can no longer be trusted to land under the cap, so
// the bitrate is computed from the duration instead. At exactly 5 minutes the
// computed target (~4.9 Mbps) is right in 'auto' range, so the handoff between
// the two modes is seamless quality-wise; by the 9-minute landscape window it
// has eased to ~2.7 Mbps, which Stream's own ABR ladder re-encodes anyway.
const ADAPTIVE_BITRATE_ABOVE_SEC = 300;

// The upload task (and Cloudflare) only speak file:// — but a picked video can be
// a ph:// / assets-library:// Photos asset when MediaLibrary has no local copy
// (iCloud / storage-optimized clips). Copy such assets into the cache first so the
// uploader has a readable file. (In dev/store builds the compressor already emits
// a file://; this covers Expo Go, where compression is skipped.)
export async function ensureLocalFile(uri: string): Promise<string> {
  if (!uri || uri.startsWith('file://')) return uri;
  try {
    const dest = `${FileSystem.cacheDirectory}upload_${Date.now()}.mp4`;
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
): Promise<string> {
  try {
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
    const adaptive = !!durationSec && durationSec > ADAPTIVE_BITRATE_ABOVE_SEC;
    const { Video } = await import('react-native-compressor');
    const out = await Video.compress(
      uri,
      {
        ...(adaptive
          ? { compressionMethod: 'manual' as const, bitrate: Math.round((TARGET_LONG_UPLOAD_BYTES * 8) / durationSec!) }
          : { compressionMethod: 'auto' as const }), // adapts bitrate to the source, like the big apps
        maxSize: 1920,              // cap the long edge at ~1080p
        // We already gate on size above, so don't let the library skip anything
        // we decided is worth shrinking.
        minimumFileSizeForCompress: 0,
        progressDivider: 4,
      },
      (p: number) => onProgress?.(Math.min(1, p)),
    );
    return out || uri;
  } catch {
    return uri; // module not in this build / compression failed → original bytes
  }
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
