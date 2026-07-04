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

async function fileSizeBytes(uri: string): Promise<number> {
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
): Promise<string> {
  try {
    // Expo Go can't load the Nitro-based compressor at all — importing it there
    // throws a fatal error, so bail to the original bytes before touching it.
    if (IS_EXPO_GO) return uri;

    // Already-small clips: skip the re-encode entirely (keeps posting snappy).
    const bytes = await fileSizeBytes(uri);
    if (bytes && bytes < COMPRESS_FLOOR_BYTES) return uri;

    const { Video } = await import('react-native-compressor');
    const out = await Video.compress(
      uri,
      {
        compressionMethod: 'auto',  // adapts bitrate to the source, like the big apps
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
