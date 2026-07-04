import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// Cloudflare Stream upload + playback URLs.
//
// Posting must feel instant, so we DON'T block on encoding. Cloudflare's playback
// URLs are deterministic (customer subdomain + video uid), so the moment the file
// finishes uploading we can build the HLS URL, save the post as `processing`, and
// let a background poll flip it to `ready`. Every playback surface just reads
// media_url (the HLS manifest) and expo-video plays it — with the post's thumbnail
// shown as a poster until the first frame is decodable.

// Your account's public Stream subdomain — the `customer-xxxx` in every playback
// URL (safe to hardcode; it's in every viewer's URL). Left blank on purpose: the
// first upload learns it from Cloudflare and caches it locally, so no manual step
// is required. Filling it in just skips that one-time lookup.
const CF_STREAM_SUBDOMAIN = '';
const SUBDOMAIN_KEY = 'cf_stream_subdomain';
let cachedSubdomain: string | null = CF_STREAM_SUBDOMAIN || null;

function subdomainFromHls(hls: string): string | null {
  // https://customer-xxxx.cloudflarestream.com/<uid>/manifest/video.m3u8
  const m = hls.match(/https?:\/\/([^.]+)\.cloudflarestream\.com/i);
  return m ? m[1] : null;
}

export function streamHlsUrl(subdomain: string, uid: string): string {
  return `https://${subdomain}.cloudflarestream.com/${uid}/manifest/video.m3u8`;
}

export function streamPosterUrl(subdomain: string, uid: string): string {
  return `https://${subdomain}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg?height=720`;
}

// One stream-status round-trip.
async function streamStatus(uid: string): Promise<{ ready: boolean; state: string | null; hls: string | null; poster: string | null }> {
  const { data } = await supabase.functions.invoke('stream-status', { body: { uid } });
  return { ready: !!data?.ready, state: (data?.state as string) ?? null, hls: (data?.hls as string) ?? null, poster: (data?.poster as string) ?? null };
}

// Upload the file to Cloudflare Stream, return the video uid (with progress).
export async function uploadVideoToStream(
  uri: string,
  opts?: { maxDurationSeconds?: number; onProgress?: (fraction: number) => void },
): Promise<string> {
  const { data, error } = await supabase.functions.invoke('stream-direct-upload', {
    body: { maxDurationSeconds: opts?.maxDurationSeconds },
  });
  if (error || !data?.uploadURL || !data?.uid) {
    let detail = '';
    try { detail = ((await (error as any)?.context?.json?.())?.error) ?? ''; } catch {}
    throw new Error(`Could not start the video upload${detail ? ` — ${detail}` : ''}`);
  }
  const { uploadURL, uid } = data as { uploadURL: string; uid: string };

  const task = FileSystem.createUploadTask(
    uploadURL,
    uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      if (totalBytesExpectedToSend > 0) opts?.onProgress?.(Math.min(1, totalBytesSent / totalBytesExpectedToSend));
    },
  );
  const res = await task.uploadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`Video upload failed (${res?.status ?? 'network error'})`);
  }
  return uid;
}

// The account's Stream subdomain — cached after the first lookup so publishing is
// instant thereafter. First time only, we poll Cloudflare until it hands back a
// playback URL (usually seconds) and remember the subdomain from it.
export async function resolveStreamSubdomain(uid: string): Promise<string | null> {
  if (cachedSubdomain) return cachedSubdomain;
  try {
    const stored = await AsyncStorage.getItem(SUBDOMAIN_KEY);
    if (stored) { cachedSubdomain = stored; return stored; }
  } catch {}
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const s = await streamStatus(uid);
    if (s.state === 'error') throw new Error('Video processing failed');
    if (s.hls) {
      const sub = subdomainFromHls(s.hls);
      if (sub) {
        cachedSubdomain = sub;
        try { await AsyncStorage.setItem(SUBDOMAIN_KEY, sub); } catch {}
        return sub;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

// Delete a Cloudflare Stream video (deleted post / abandoned prewarm) so it stops
// costing storage. Best-effort + ownership-checked server-side; never throws.
export async function deleteStreamVideo(uid: string): Promise<void> {
  if (!uid) return;
  try { await supabase.functions.invoke('stream-delete', { body: { uid } }); } catch { /* best-effort */ }
}

// Background: poll until Cloudflare finishes encoding. Returns true when ready.
export async function pollStreamReady(uid: string, timeoutMs = 300_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await streamStatus(uid);
      if (s.state === 'error') return false;
      if (s.ready) return true;
    } catch { /* transient — keep polling */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return false;
}
