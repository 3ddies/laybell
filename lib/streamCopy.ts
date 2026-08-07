import { supabase } from './supabase';
import { uploadToStaging, signStagingUrl, removeStaged } from './upload';
import { trackStreamUpload } from './streamUpload';
import { logAccess } from './accessLog';

// LONG VIDEO UPLOAD — stage, then let Cloudflare fetch.
//
// Replaces lib/streamTus.ts, which pushed the file from the phone in hundreds
// of JavaScript-driven chunks, each carrying a byte offset that had to be
// reconciled with the server. Every long-video failure traced to that design:
// skipped bytes reported as success, resume state keyed to a filename that
// changed on every attempt, a rate-limited status check mistaken for a dead
// session, a cleanup sweep deleting uploads that were still running.
//
// The transfer is now inverted, and the fragile half simply does not exist:
//
//   1. ONE native upload into the private video-staging bucket. The OS owns
//      it (expo-file-system upload task) — the same path that has carried
//      audio and images reliably since launch. It either completes or fails;
//      there is no partially-correct state to misread.
//   2. A short-lived signed URL is handed to Cloudflare.
//   3. Cloudflare downloads the master itself, datacenter to datacenter.
//   4. The staged master is deleted once Stream has ingested it.
//
// A failed attempt retries the whole staged upload — which is safe and cheap,
// because the object name is derived from the source file, so a retry
// overwrites its own partial object instead of stacking multi-GB copies.

export type CopyResult = {
  uid: string;
  /** Staging path — the caller deletes it once encoding is confirmed. */
  stagedPath: string;
};

export async function uploadLongVideoViaCopy(
  uri: string,
  opts: {
    userId: string;
    maxDurationSeconds: number;
    onProgress?: (fraction: number) => void;
    name?: string;
  },
): Promise<CopyResult> {
  // 1) Stage the master. Progress here IS the user-visible upload progress;
  //    everything after it is server-side and quick.
  const stagedPath = await uploadToStaging(opts.userId, uri, opts.onProgress);

  // 2) Sign it. One hour is far more than Cloudflare needs to start the fetch.
  const signedUrl = await signStagingUrl(stagedPath, 3600);

  // 3) Ask Cloudflare to pull it.
  const { data, error } = await supabase.functions.invoke('stream-copy', {
    body: { url: signedUrl, maxDurationSeconds: opts.maxDurationSeconds, name: opts.name },
  });
  if (error || !data?.uid) {
    let detail = '';
    try { detail = ((await (error as any)?.context?.json?.())?.error) ?? ''; } catch {}
    if (detail === 'premium_plus_required') {
      const err: any = new Error('Posting films needs an active Premium+ subscription');
      err.code = 'film_requires_plus';
      throw err;
    }
    if (detail === 'stream_busy') {
      // The master is already staged, so a retry skips straight back to here.
      const err: any = new Error('The video service is busy — tap Retry in a moment');
      err.code = 'stream_busy';
      throw err;
    }
    throw new Error(detail || 'Could not hand the video to the video service');
  }

  const uid = data.uid as string;
  // Same orphan protection the short-video path uses: the uid is tracked from
  // the moment it exists, so a crash can't leave a paid-for asset unreferenced.
  await trackStreamUpload(uid);
  logAccess('upload', 'stream_video', uid);
  return { uid, stagedPath };
}

/** Called once Cloudflare reports the video ready (or definitively failed). */
export async function releaseStagedMaster(stagedPath: string): Promise<void> {
  await removeStaged(stagedPath);
}
