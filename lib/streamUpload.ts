import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { logAccess } from './accessLog';
import { uploadFileViaXhr } from './xhrUpload';

// Above this, the 60-second-timeout risk outweighs the memory cost of XHR's
// buffered body (see the note at the upload site). 24 MB keeps every ordinary
// clip on the streaming uploader that has never failed.
const XHR_UPLOAD_ABOVE_BYTES = 24 * 1024 * 1024;

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

// The uid back out of any Stream playback URL (manifest or thumbnail), for callers
// that only kept the URL. Returns null for non-Stream URLs.
export function streamUidFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/cloudflarestream\.com\/([A-Za-z0-9]+)\//i);
  return m ? m[1] : null;
}

// One stream-status round-trip.
async function streamStatus(uid: string): Promise<{ ready: boolean; state: string | null; pct: number | null; errorText: string | null; throttled: boolean; hls: string | null; poster: string | null }> {
  const { data } = await supabase.functions.invoke('stream-status', { body: { uid } });
  const pct = Number(data?.pct);
  return {
    ready: !!data?.ready,
    state: (data?.state as string) ?? null,
    pct: Number.isFinite(pct) && pct > 0 ? pct : null,
    errorText: (data?.errorText as string) ?? (data?.errorCode as string) ?? null,
    // Server flags a 404 asset as state:'missing' — surfaced through `state`
    // below, so no extra field is needed here.
    // Cloudflare rate-limited the lookup — the video's real state is UNKNOWN,
    // not bad. Callers must back off rather than treat it as a failure.
    throttled: data?.throttled === true,
    hls: (data?.hls as string) ?? null,
    poster: (data?.poster as string) ?? null,
  };
}

// ── Orphan protection ─────────────────────────────────────────────────────────
// A Stream asset is created (and billed) the moment we mint an upload URL — which
// is BEFORE the user has decided to post, because the composer prewarms the upload
// on the details step. Until now that uid lived only in memory, so an app kill,
// crash or OS eviction lost it forever: an asset nobody can find, paid for
// indefinitely. Every minted uid is therefore written to disk here first, and
// cleared once it's provably referenced (untrackStreamUpload) or deleted. On the
// next launch, sweepAbandonedStreamUploads() settles whatever is left over.
const PENDING_KEY = 'cf_stream_pending';
type PendingUpload = { uid: string; at: number; owner: string };

async function readPending(): Promise<PendingUpload[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.uid === 'string') : [];
  } catch { return []; }
}

async function writePending(list: PendingUpload[]): Promise<void> {
  try { await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-200))); } catch {}
}

// Record a uid the instant Cloudflare hands it to us. Owner is stamped so a shared
// device never lets one account try (and fail) to delete another's asset.
// Exported for lib/streamCopy.ts — long-video uploads need identical orphan protection.
export async function trackStreamUpload(uid: string): Promise<void> {
  if (!uid) return;
  let owner = '';
  try { owner = (await supabase.auth.getUser()).data.user?.id ?? ''; } catch {}
  const list = await readPending();
  if (list.some((e) => e.uid === uid)) return;
  list.push({ uid, at: Date.now(), owner });
  await writePending(list);
}

// The asset is now safely referenced by a row (or already deleted) — stop tracking.
export async function untrackStreamUpload(uid: string): Promise<void> {
  if (!uid) return;
  const list = await readPending();
  const next = list.filter((e) => e.uid !== uid);
  if (next.length !== list.length) await writePending(next);
}

// Is this uid referenced by anything that would make it a real, wanted asset?
// Both producers (video posts and ad creatives) embed the uid in the playback URL,
// and posts additionally store it in video_uid — check all three, because a row
// written just before the crash must never be swept.
async function isStreamUidReferenced(uid: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('posts').select('id').or(`video_uid.eq.${uid},media_url.ilike.*${uid}*`).limit(1);
    // A query ERROR is not an absence of references — bail out and keep the asset.
    if (error) return true;
    if (data?.length) return true;
  } catch { return true; }
  try {
    const { data, error } = await supabase
      .from('ad_creatives').select('id').ilike('media_url', `%${uid}%`).limit(1);
    if (error) return true;
    if (data?.length) return true;
  } catch { return true; }
  return false;
}

// Called once per app launch. Everything still tracked at boot is from a previous
// process, so it is either an orphan (delete it) or a row that landed before the
// untrack could run (drop the entry, keep the asset). A grace period guards the
// second case against replication lag; entries that stay unresolved for two weeks
// are dropped so the list can't grow forever.
// GRACE MUST EXCEED THE LONGEST POSSIBLE UPLOAD. A tracked uid is unreferenced
// for the ENTIRE duration of its upload — the post row is only written once the
// bytes are in — so this window is the line between "abandoned prewarm" and
// "someone's film, still uploading". At 10 minutes it was shorter than a film
// transfer, which meant any app relaunch mid-upload had the boot sweep DELETE
// the very asset being uploaded: the post then referenced a 404, showed no
// thumbnail, and polled "Almost done…" forever against a video that no longer
// existed. Short videos never tripped it (seconds, not minutes) — it was a
// landmine laid exclusively for long ones. A day is safely past any upload,
// matches Cloudflare's own 24h uploadExpiry, and costs pennies of storage.
const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_GIVE_UP_MS = 14 * 24 * 60 * 60 * 1000;

export async function sweepAbandonedStreamUploads(): Promise<void> {
  const list = await readPending();
  if (!list.length) return;
  let me = '';
  try { me = (await supabase.auth.getUser()).data.user?.id ?? ''; } catch {}
  if (!me) return; // stream-delete needs an authenticated owner

  const now = Date.now();
  const keep: PendingUpload[] = [];
  let handled = 0;
  for (const entry of list) {
    const age = now - (entry.at || 0);
    // Not ours, too fresh, or we've already burned this launch's budget — hold it
    // for a later sweep rather than risk a wrong delete or a burst of calls.
    if ((entry.owner && entry.owner !== me) || age < SWEEP_GRACE_MS || handled >= 20) {
      if (age < SWEEP_GIVE_UP_MS) keep.push(entry);
      continue;
    }
    handled++;
    if (await isStreamUidReferenced(entry.uid)) continue; // published after all
    await deleteStreamVideo(entry.uid);
  }
  await writePending(keep);
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
  // Persist BEFORE a single byte moves: from here on the uid survives a process kill.
  await trackStreamUpload(uid);
  // Server-captured IP for the uploading session, tied to the Stream asset id.
  // This is the origin record for a piece of media — the single most useful field
  // in a law-enforcement request after the file itself.
  logAccess('upload', 'stream_video', uid);

  // WHICH UPLOADER, and why it matters more than anything else in this file:
  //
  // expo-file-system streams from disk (memory-safe) but hardcodes iOS's
  // 60-second idle timeout — see lib/xhrUpload.ts for the exact line. That wall
  // is what killed every long upload with NSURLErrorDomain -1001, and no JS
  // option can move it. React Native's XHR CAN set the timeout, at the cost of
  // buffering the body in memory.
  //
  // So: small files keep the streaming uploader that has never failed them;
  // anything large enough to risk the wall goes through XHR with a generous
  // timeout. Compression runs before this, so "large" here means a ~180 MB
  // compressed master, not a raw multi-GB source.
  // (Background sessions were tried and fail instantly on this setup — the
  // long-standing expo-file-system NSURLError -1 / #bplist bug.)
  let bytes = 0;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    bytes = info.exists ? ((info as any).size ?? 0) : 0;
  } catch { /* unknown → treat as small and keep the proven path */ }

  if (bytes > XHR_UPLOAD_ABOVE_BYTES) {
    const res = await uploadFileViaXhr(uploadURL, uri, {
      method: 'POST',
      fieldName: 'file',
      mimeType: 'video/mp4',
      onProgress: (f) => opts?.onProgress?.(f),
      timeoutMs: 2 * 60 * 60 * 1000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Video upload failed (${res.status})`);
    }
    return uid;
  }

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
  untrackStreamUpload(uid);
}

// Background: poll until Cloudflare finishes encoding.
// onPct receives Cloudflare's own encode progress (0-100) as it climbs — films
// show it as a live "time left" so the processing spinner never reads as stuck.
//
// TIMEOUT and FAILURE are different worlds and the result says which:
//   ready   → play it.
//   errored → the asset is dead server-side, with Cloudflare's reason attached.
//   neither → the encode is (probably) STILL RUNNING — the caller must treat
//             the post as alive, never roll it back. Deleting 15 minutes of
//             uploaded film because a poll got bored is how users learn to
//             hate an app.
// `incomplete` is deliberately NOT the same as `errored`. Cloudflare parks an
// under-delivered upload in `pendingupload`: the asset is FINE, it is simply
// missing its tail. The remedy is to RESUME the transfer — so the asset and the
// resume checkpoint must survive. Treating it as a hard error (and deleting the
// asset) is what forced full restarts of nearly-finished multi-GB uploads.
export type StreamReadyResult = {
  ready: boolean;
  errored: boolean;      // Cloudflare rejected the encode — the asset is dead
  incomplete?: boolean;  // bytes missing — resumable, destroy nothing
  reason: string | null;
};

export async function pollStreamReady(
  uid: string,
  timeoutMs = 300_000,
  onPct?: (pct: number) => void,
  // 4s suits an attended wait; detached long-tail babysitters pass something
  // gentler so a half-hour watch doesn't burn hundreds of function calls.
  intervalMs = 4000,
): Promise<StreamReadyResult> {
  const start = Date.now();
  // 'pendingupload' means Cloudflare is STILL WAITING FOR BYTES — it will never
  // encode and never error, so polling it is infinite. It is a dead upload, not
  // a slow one, and the only honest thing is to say so. (The uploader now
  // verifies completion before we ever get here; this catches anything that
  // slips through, including posts created by older builds.)
  // Cloudflare can sit in `pendingupload` for minutes after the final byte of a
  // multi-GB file before it flips to queued/inprogress. A tight window here
  // condemned uploads that were merely settling, so this is deliberately long —
  // and the verdict it produces is now RESUMABLE, never destructive.
  const PENDING_GRACE_MS = 420_000; // 7 minutes
  // BACKOFF, not a metronome. A fixed 4s tick across a 13-minute encode is ~200
  // API calls for ONE post — and Cloudflare answers a hammered account with
  // error 971 ("throttle your request speed"). Once throttled, status becomes
  // unreadable, so the card stalls at "finishing up" forever: the polling
  // CAUSED the symptom it was trying to observe. Start responsive, then ease
  // off; a throttled answer backs off hardest, because continuing to hammer a
  // rate-limited endpoint is what keeps it rate-limited.
  let wait = Math.max(2000, intervalMs);
  const MAX_WAIT = 60_000;
  let throttled = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await streamStatus(uid);
      if (s.state === 'error') return { ready: false, errored: true, reason: s.errorText };
      // The asset no longer exists — nothing to wait for, ever.
      if (s.state === 'missing') {
        return { ready: false, errored: true, reason: 'the video was removed before it finished' };
      }
      if (s.ready) return { ready: true, errored: false, reason: null };
      if (s.state === 'pendingupload' && Date.now() - start > PENDING_GRACE_MS) {
        return { ready: false, errored: false, incomplete: true, reason: 'the upload is missing its last part' };
      }
      if (s.throttled) {
        throttled++;
        wait = Math.min(MAX_WAIT, Math.max(wait, 15_000) * 2);
      } else {
        throttled = 0;
        if (s.pct != null) onPct?.(s.pct);
        wait = Math.min(MAX_WAIT, Math.round(wait * 1.5));
      }
    } catch {
      wait = Math.min(MAX_WAIT, Math.round(wait * 1.6)); // transient — ease off too
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  return { ready: false, errored: false, reason: null };
}
