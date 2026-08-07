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
    /** Fired while waiting out a throttled hand-off, so the card can explain. */
    onCopyRetry?: (attempt: number) => void;
  },
): Promise<CopyResult> {
  // 1) Stage the master. Progress here IS the user-visible upload progress;
  //    everything after it is server-side and quick.
  //
  // Already staged by a previous attempt? Reuse it. The object name is derived
  // from the source file, so a Retry after a throttled hand-off costs seconds
  // instead of re-sending hundreds of megabytes that are already sitting on
  // the server.
  const stagedPath = await uploadToStaging(opts.userId, uri, opts.onProgress);

  // 2) Sign it. One hour is far more than Cloudflare needs to start the fetch.
  const signedUrl = await signStagingUrl(stagedPath, 3600);

  // 3) Ask Cloudflare to pull it — patiently.
  //
  // The whole file is ALREADY SAFELY ON THE SERVER by this point, so the worst
  // thing this step can do is give up early: Cloudflare rate-limits this
  // account routinely (error 971) and the throttle can outlast the function's
  // own short retry budget. Failing here after a completed multi-hundred-MB
  // upload — and making the user tap Retry — is a terrible trade for a wait
  // that costs nothing. So keep asking for ~3 minutes before surfacing it.
  let uid = '';
  let lastDetail = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) {
      // 5s, 10s, 20s, 30s, 30s… — bounded, and gentle on a throttled endpoint.
      await new Promise((r) => setTimeout(r, Math.min(30_000, 5_000 * 2 ** (attempt - 1))));
      opts.onCopyRetry?.(attempt);
    }
    const { data, error } = await supabase.functions.invoke('stream-copy', {
      body: { url: signedUrl, maxDurationSeconds: opts.maxDurationSeconds, name: opts.name },
    });
    if (!error && data?.uid) { uid = data.uid as string; break; }
    lastDetail = '';
    try { lastDetail = ((await (error as any)?.context?.json?.())?.error) ?? ''; } catch {}
    // Definitive rejections cannot be waited out.
    if (lastDetail === 'premium_plus_required') {
      const err: any = new Error('Posting films needs an active Premium+ subscription');
      err.code = 'film_requires_plus';
      throw err;
    }
    if (lastDetail === 'bad_source_url') throw new Error('Could not prepare the video for transfer');
    // Anything else (throttle, 5xx, transient network) → wait and ask again.
  }
  if (!uid) {
    const err: any = new Error(
      lastDetail === 'stream_busy'
        ? 'The video service is busy — your upload is saved, tap Retry'
        : lastDetail || 'Could not hand the video to the video service',
    );
    // Staged file survives, so a retry resumes at the copy step, not the upload.
    err.code = 'stream_busy';
    throw err;
  }
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
