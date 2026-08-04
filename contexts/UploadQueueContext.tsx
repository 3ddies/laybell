import { createContext, useContext, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { compressVideoIfPossible, ensureLocalFile } from '../lib/upload';
import { trimVideoIfPossible } from '../lib/videoTrim';
import { uploadVideoToStream, resolveStreamSubdomain, streamHlsUrl, streamPosterUrl, pollStreamReady, deleteStreamVideo, untrackStreamUpload } from '../lib/streamUpload';
import { bumpBadge } from '../lib/badges';
import { processMentions } from '../lib/mentions';
import { createNotification } from '../lib/createNotification';
import { activateCampaign } from '../lib/spotlight';

// Background video-upload queue. Posting a video hands the work to this provider
// and returns to the feed IMMEDIATELY — the composer never blocks on the upload.
// The feed shows an optimistic card that plays the LOCAL file with an upload/
// processing badge; when Cloudflare finishes, the card hands off to the real post.
//
// The whole video publish (upload → Stream → insert row → mentions/badges/
// notifications/spotlight) lives here so it survives navigating away from the
// composer. Not persisted across a full app-kill (v1) — force-quitting mid-upload
// loses that one upload.

// Everything the background job needs, snapshotted at enqueue time.
export type VideoJob = {
  userId: string;
  localUri: string;             // the file to upload (compressed in-queue when possible)
  thumbnailUri: string | null;  // file:// poster, uploaded to Supabase for the post thumbnail
  posterUri: string | null;     // ph:// ok — shown in the optimistic card (expo-image renders it)
  aspectRatio: string;
  caption: string;
  isPublic: boolean;
  hasCommunity: boolean;
  genre?: string | null;
  durationSeconds?: number | null;
  trim?: { start: number; end: number } | null;
  song?: { id: string; title: string; artist: string; artistId: string | null; linkOnly?: boolean } | null;
  taggedIds: string[];
  communityIds: string[];
  allowGifs: boolean;
  // TikTok-style bubbles for the black letterbox bands above/below a LANDSCAPE
  // clip in portrait viewing (posts.top_caption / bottom_caption jsonb — see
  // post_top_caption.sql).
  topCaption?: { text: string; bg: string; color: string; y: number; scale: number } | null;
  bottomCaption?: { text: string; bg: string; color: string; y: number; scale: number } | null;
  // Story-style free-placed captions for a VERTICAL clip (posts.captions jsonb,
  // an array of sticker objects). Shown in the reel viewer AND the home feed.
  captions?: unknown[] | null;
  maxDurationSeconds: number;
  spotlight?: { campaignId: string; days: number } | null;
};

// What the feed renders for an in-flight upload.
export type PendingUpload = {
  tempId: string;
  localUri: string;
  hlsUri?: string;                               // Cloudflare HLS — set once uploaded; the card
                                                 // plays THIS (remote works; local files render black),
                                                 // showing the poster until Cloudflare finishes encoding.
  thumbnailUri: string | null;
  aspectRatio: string;
  caption: string;
  song?: { id: string; title: string; artist: string; artistId: string | null; linkOnly?: boolean } | null;
  taggedIds?: string[];
  progress: number;                              // 0..1 during the file upload
  // 'done' = finished; the card stays pinned at the top of the feed (playing the
  // local file) until the next manual refresh, so a fresh post is always on top.
  phase: 'uploading' | 'processing' | 'done' | 'error';
  errorMsg?: string;
  postId?: string;                               // set once the DB row is inserted
};

type Ctx = {
  pending: PendingUpload[];
  completedTick: number;                         // bumps when a row lands / finishes → feed refetch
  // Speculatively start uploading a video (e.g. when the user reaches the details
  // step) so it's already up by the time they hit Share. Idempotent per uri.
  prewarmVideo: (localUri: string, maxDurationSeconds: number) => void;
  // Delete an unpublished prewarm's Cloudflare asset (abandoned clip) so it doesn't
  // linger as paid storage. No-op if it was already claimed by an enqueue.
  discardPrewarm: (localUri: string) => void;
  enqueueVideo: (job: VideoJob) => void;
  retry: (tempId: string) => void;
  dismiss: (tempId: string) => void;
  // Post ids to pin at the top of Home once they finish — the REAL post (rendered
  // as a normal PostCard) holds the top slot until a manual refresh, so a done post
  // behaves exactly like any other post.
  pinnedIds: string[];
  // Manual refresh: release the pins so posts fall back into natural rank.
  clearPinned: () => void;
  // Bumps when the just-posted confirmation asks the Home feed to scroll to top.
  homeScrollTick: number;
  scrollHomeTop: () => void;
};

// A prewarmed upload that's in flight (or done) before the user publishes.
type PrewarmEntry = {
  // trimmedFile is always false here: a prewarm starts before the trim window is
  // final, so it deliberately uploads the source as-is (see prewarmVideo).
  promise: Promise<{ uid: string; subdomain: string; trimmedFile: boolean } | null>;
  progress: number;
  attachedTempId: string | null; // the pending card now mirroring this upload, once enqueued
  claimed: boolean;              // an enqueue is using it — never discard a claimed prewarm
};

// The action half of Ctx: everything that DRIVES the queue, with none of the
// state that churns while an upload runs.
type UploadActions = Pick<Ctx, 'prewarmVideo' | 'discardPrewarm' | 'enqueueVideo' | 'retry' | 'dismiss' | 'clearPinned' | 'scrollHomeTop'>;

const UploadQueueContext = createContext<Ctx | null>(null);
// Split out so callers that only START or CANCEL uploads don't re-render while
// one is running: `pending` is rewritten on every progress tick (throttled to
// 2% / 100ms), and because the provider's value was one object literal, that
// re-rendered every consumer — including the Create screen, which reads nothing
// but four stable functions. Nested like AudioPositionContext below the main
// provider; `children` keeps its identity, so only real consumers re-render.
const UploadActionsContext = createContext<UploadActions | null>(null);

export function useUploadQueue(): Ctx {
  const c = useContext(UploadQueueContext);
  if (!c) throw new Error('useUploadQueue must be used within UploadQueueProvider');
  return c;
}

// Actions only — stable for as long as the provider lives, so consuming this
// never causes a re-render.
export function useUploadActions(): UploadActions {
  const c = useContext(UploadActionsContext);
  if (!c) throw new Error('useUploadActions must be used within UploadQueueProvider');
  return c;
}

let SEQ = 0;

// Minimum time the "Processing" status stays up, so a fast (prewarmed) upload
// still shows the loading state long enough to see.
const MIN_PROCESSING_MS = 2600;

// Upload a local image (the video's poster) to the posts bucket — mirrors the
// composer's own uploadToStorage helper.
async function uploadPoster(userId: string, uri: string): Promise<string> {
  const name = `${Date.now()}.jpg`;
  const path = `${userId}/${name}`;
  const form = new FormData();
  form.append('file', { uri, name, type: 'image/jpeg' } as any);
  const { error } = await supabase.storage.from('posts').upload(path, form, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return supabase.storage.from('posts').getPublicUrl(path).data.publicUrl;
}

// Localize → compress → upload to Cloudflare Stream → resolve the playback
// subdomain. Shared by both the speculative prewarm and the real publish.
async function startStreamUpload(
  localUri: string,
  maxDurationSeconds: number,
  onProgress: (f: number) => void,
  trim?: { start: number; end: number } | null,
): Promise<{ uid: string; subdomain: string; trimmedFile: boolean } | null> {
  const localFile = await ensureLocalFile(localUri);
  // Cut the chosen window FIRST, before compressing or uploading, so the
  // discarded footage never leaves the phone: the upload shrinks in proportion
  // and Cloudflare never stores what the post doesn't show. Falls back to the
  // whole file (trimmedFile:false) when the native trimmer isn't in the build,
  // in which case the caller keeps writing trim_start/trim_end as before.
  const cut = trim ? await trimVideoIfPossible(localFile, trim.start, trim.end) : { uri: localFile, trimmed: false };
  const upUri = await compressVideoIfPossible(cut.uri);
  const uid = await uploadVideoToStream(upUri, { maxDurationSeconds, onProgress });
  const subdomain = await resolveStreamSubdomain(uid);
  if (!subdomain) return null;
  return { uid, subdomain, trimmedFile: cut.trimmed };
}

export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [completedTick, setCompletedTick] = useState(0);
  const [homeScrollTick, setHomeScrollTick] = useState(0);
  const jobsRef = useRef<Map<string, VideoJob>>(new Map());
  const prewarmRef = useRef<Map<string, PrewarmEntry>>(new Map());

  // Upload-task progress callbacks fire once per chunk (hundreds of times on a
  // long video) and `pending` flows into the Home feed's list data — unthrottled,
  // every chunk re-rendered the ENTIRE feed. Progress-only patches are dropped
  // unless they moved ≥2% or ≥100ms passed; phase changes always apply.
  const lastProgress = useRef<Map<string, { p: number; t: number }>>(new Map());
  const update = useCallback((tempId: string, patch: Partial<PendingUpload>) => {
    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'progress' && typeof patch.progress === 'number' && patch.progress < 1) {
      const now = Date.now();
      const last = lastProgress.current.get(tempId);
      if (last && patch.progress - last.p < 0.02 && now - last.t < 100) return;
      lastProgress.current.set(tempId, { p: patch.progress, t: now });
    }
    setPending((list) => list.map((p) => (p.tempId === tempId ? { ...p, ...patch } : p)));
  }, []);

  const remove = useCallback((tempId: string) => {
    setPending((list) => list.filter((p) => p.tempId !== tempId));
    jobsRef.current.delete(tempId);
    lastProgress.current.delete(tempId);
  }, []);

  const run = useCallback(async (tempId: string, job: VideoJob) => {
    try {
      update(tempId, { phase: 'uploading', progress: 0, errorMsg: undefined });

      // Reuse the speculative prewarm if the details step already started it —
      // otherwise start the upload now. Either way we get {uid, subdomain}.
      let result: { uid: string; subdomain: string; trimmedFile: boolean } | null;
      const pre = prewarmRef.current.get(job.localUri);
      if (pre) {
        pre.attachedTempId = tempId; // route its live progress into this card
        update(tempId, { progress: pre.progress });
        result = await pre.promise;
        prewarmRef.current.delete(job.localUri);
      } else {
        result = await startStreamUpload(
          job.localUri,
          job.maxDurationSeconds,
          (f) => update(tempId, { progress: f }),
          job.trim,
        );
      }
      if (!result) throw new Error('Could not prepare the video for playback');
      const { uid, subdomain } = result;
      // If the file was PHYSICALLY cut, the upload already is the window, so the
      // virtual trim must not be written too — the player seeks trim_start on a
      // file that already starts there, which would trim it a second time. A
      // prewarm never trims (it runs before the window is final), so this stays
      // false on that path and the old behaviour is preserved.
      const trimmedFile = result.trimmedFile === true;
      const hls = streamHlsUrl(subdomain, uid);
      // Upload done — the card can now play the HLS (it shows the poster and keeps
      // retrying until Cloudflare finishes encoding, then plays). Move to processing.
      update(tempId, { hlsUri: hls, phase: 'processing' });
      // Prewarm often finishes upload+encode before the user even hits Share, which
      // would flash the status by too fast to see — hold the processing state for a
      // minimum so the "Processing" reveal is actually visible.
      const processingStart = Date.now();

      // Poster: prefer the local thumbnail already generated at pick time.
      let thumbnailUrl: string | null = null;
      try { thumbnailUrl = job.thumbnailUri ? await uploadPoster(job.userId, job.thumbnailUri) : streamPosterUrl(subdomain, uid); }
      catch { thumbnailUrl = streamPosterUrl(subdomain, uid); }

      // The file is up — insert the real, persisted post now.
      const { data: newPost, error } = await supabase.from('posts').insert({
        user_id: job.userId,
        type: 'video',
        media_url: hls,
        caption: job.caption,
        is_public: job.hasCommunity ? true : job.isPublic,
        ...(job.genre ? { genre: job.genre } : {}),
        ...(job.durationSeconds && job.durationSeconds > 0 ? { duration_seconds: job.durationSeconds } : {}),
        aspect_ratio: job.aspectRatio,
        // Spread-conditional: pre-migration databases simply never see the columns.
        ...(job.topCaption?.text ? { top_caption: job.topCaption } : {}),
        ...(job.bottomCaption?.text ? { bottom_caption: job.bottomCaption } : {}),
        ...(job.captions?.length ? { captions: job.captions } : {}),
        ...(job.trim && !trimmedFile ? { trim_start: job.trim.start, trim_end: job.trim.end } : {}),
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        video_uid: uid, video_status: 'processing', video_hls_url: hls,
        ...(job.song ? { song_id: job.song.id, song_title: job.song.title, song_artist: job.song.artist, song_artist_id: job.song.artistId, song_link_only: !!job.song.linkOnly } : {}),
        ...(job.taggedIds.length ? { tagged_user_ids: job.taggedIds } : {}),
        ...(job.communityIds.length ? { community_ids: job.communityIds } : {}),
        allow_gifs: job.allowGifs,
      }).select('id').single();
      if (error) throw error;
      const postId = newPost!.id as string;
      // The row now references the asset, so the crash-recovery tracker can let go
      // of it — otherwise the next launch's sweep would have to prove it's in use.
      untrackStreamUpload(uid);
      update(tempId, { phase: 'processing', postId, progress: 1 });

      // Side effects — mirror the composer's inline publish path.
      if (job.isPublic) bumpBadge('posts_created');
      processMentions({ text: job.caption, actorId: job.userId, postId });
      if (job.song?.artistId && job.song.artistId !== job.userId) {
        createNotification({ userId: job.song.artistId, actorId: job.userId, type: 'song_used', postId });
      }
      for (const t of job.taggedIds) {
        if (t !== job.userId) createNotification({ userId: t, actorId: job.userId, type: 'tag', postId });
      }
      if (job.spotlight) { try { await activateCampaign(job.spotlight.campaignId, postId, job.spotlight.days); } catch {} }

      // Pull the real row into the feed (kept hidden behind the optimistic card by
      // the feed's dedupe), then wait for encoding. We KEEP the card pinned at the
      // top (playing the local file) — it only clears on a manual refresh — so a
      // freshly-posted video is always on top no matter the feed ranking.
      setCompletedTick((n) => n + 1);
      const ready = await pollStreamReady(uid);
      if (!ready) {
        // Cloudflare errored (or never finished) — most often because the source
        // ran past the upload URL's maxDurationSeconds. The row was inserted
        // BEFORE encoding, so bailing out silently here is what used to leave a
        // permanently unplayable post sitting in the feed after the composer had
        // already said "Posted". Roll it back: drop the row and the Stream asset,
        // then fall into the catch so the card shows an error the user can retry
        // or dismiss. Retry re-inserts a fresh row, so removing this one is safe.
        await supabase.from('posts').delete().eq('id', postId).then(undefined, () => {});
        deleteStreamVideo(uid).catch(() => {});
        setCompletedTick((n) => n + 1); // pull the deleted row back out of the feed
        throw new Error('Video processing failed');
      }
      supabase.from('posts').update({ video_status: 'ready' }).eq('id', postId).then(undefined, () => {});
      const shownFor = Date.now() - processingStart;
      if (shownFor < MIN_PROCESSING_MS) await new Promise((r) => setTimeout(r, MIN_PROCESSING_MS - shownFor));
      // Done — hand off from the optimistic card to the REAL post: pin its id at the
      // top of Home (rendered as a normal PostCard, fully interactive) and drop the
      // card. It falls into natural rank on the next manual refresh.
      setPinnedIds((ids) => [postId, ...ids.filter((id) => id !== postId)]);
      remove(tempId);
    } catch (err: any) {
      update(tempId, { phase: 'error', errorMsg: err?.message || 'Upload failed' });
    }
  }, [update, remove]);

  const prewarmVideo = useCallback((localUri: string, maxDurationSeconds: number) => {
    if (!localUri || prewarmRef.current.has(localUri)) return;
    const entry: PrewarmEntry = { progress: 0, attachedTempId: null, claimed: false, promise: Promise.resolve(null) };
    entry.promise = (async () => {
      try {
        return await startStreamUpload(
          localUri,
          maxDurationSeconds,
          (f) => { entry.progress = f; if (entry.attachedTempId) update(entry.attachedTempId, { progress: f }); },
        );
      } catch { return null; }
    })();
    prewarmRef.current.set(localUri, entry);
  }, [update]);

  // Abandoned prewarm (user switched clips or left without posting): once its upload
  // resolves, delete the Cloudflare asset. Claimed prewarms (an enqueue is posting
  // them) are left alone.
  const discardPrewarm = useCallback((localUri: string) => {
    const entry = prewarmRef.current.get(localUri);
    if (!entry || entry.claimed) return;
    prewarmRef.current.delete(localUri);
    entry.promise.then((r) => { if (r?.uid) deleteStreamVideo(r.uid); }).catch(() => {});
  }, []);

  const enqueueVideo = useCallback((job: VideoJob) => {
    // Claim the matching prewarm synchronously so a concurrent discard can't delete
    // the asset we're about to publish.
    const pre = prewarmRef.current.get(job.localUri);
    if (pre) pre.claimed = true;
    const tempId = `up_${++SEQ}`;
    jobsRef.current.set(tempId, job);
    setPending((list) => [
      {
        tempId,
        localUri: job.localUri,
        thumbnailUri: job.posterUri ?? job.thumbnailUri,
        aspectRatio: job.aspectRatio,
        caption: job.caption,
        song: job.song ?? null,
        taggedIds: job.taggedIds,
        progress: 0,
        phase: 'uploading',
      },
      ...list,
    ]);
    run(tempId, job);
  }, [run]);

  const retry = useCallback((tempId: string) => {
    const job = jobsRef.current.get(tempId);
    if (job) run(tempId, job);
  }, [run]);

  const dismiss = useCallback((tempId: string) => { remove(tempId); }, [remove]);

  // Manual refresh: release the top-pins so those posts fall back into natural rank.
  const clearPinned = useCallback(() => setPinnedIds([]), []);

  const scrollHomeTop = useCallback(() => setHomeScrollTick((n) => n + 1), []);

  // Every member is a useCallback above, so this recomputes only if one of them
  // genuinely changes identity — never on a progress tick.
  const actions = useMemo<UploadActions>(
    () => ({ prewarmVideo, discardPrewarm, enqueueVideo, retry, dismiss, clearPinned, scrollHomeTop }),
    [prewarmVideo, discardPrewarm, enqueueVideo, retry, dismiss, clearPinned, scrollHomeTop],
  );

  return (
    <UploadQueueContext.Provider value={{ pending, completedTick, prewarmVideo, discardPrewarm, enqueueVideo, retry, dismiss, pinnedIds, clearPinned, homeScrollTick, scrollHomeTop }}>
      <UploadActionsContext.Provider value={actions}>
        {children}
      </UploadActionsContext.Provider>
    </UploadQueueContext.Provider>
  );
}
