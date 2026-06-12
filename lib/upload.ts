import * as FileSystem from 'expo-file-system/legacy';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';

// Compress a video to a 1080p-class H.264 file before upload (4K iPhone clips
// shrink ~5-10x with no visible loss at feed sizes). react-native-compressor
// is a NATIVE module — until the dev client is rebuilt with it, the dynamic
// import throws and we silently fall back to uploading the original, so this
// ships safely ahead of the rebuild. Files under ~16MB pass through untouched
// (the library's own floor) — no point re-encoding already-small videos.
export async function compressVideoIfPossible(
  uri: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  try {
    const { Video } = await import('react-native-compressor');
    const out = await Video.compress(
      uri,
      { compressionMethod: 'auto', maxSize: 1920, progressDivider: 4 },
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
