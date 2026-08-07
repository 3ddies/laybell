import { createContext, useContext, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { notifySuccess } from '../lib/haptics';
import { compressVideoIfPossible, ensureLocalFile, fileSizeBytes, getLastCompressError, prepareFilmMezzanine, releaseFilmMezzanine, STREAM_POST_MAX_BYTES } from '../lib/upload';
import { trimVideoIfPossible } from '../lib/videoTrim';
import { uploadVideoToStream, resolveStreamSubdomain, streamHlsUrl, streamPosterUrl, pollStreamReady, deleteStreamVideo, untrackStreamUpload } from '../lib/streamUpload';
import { uploadLongVideoViaCopy, releaseStagedMaster } from '../lib/streamCopy';
import { deleteDraft, patchDraft } from '../lib/drafts';
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
  // Duration of the SOURCE file (seconds; 0 = picker didn't report one). Feeds
  // the adaptive bitrate that keeps long uploads under Cloudflare's POST cap —
  // distinct from durationSeconds above, which is the POST's play length.
  sourceSeconds?: number;
  // FILM intent (the composer decides: Premium+, landscape, publishing past the
  // free window). Films ride the tus pipeline at full source quality. This is
  // deliberately an explicit flag, NOT inferred from file length — a free
  // user's virtually-trimmed long source is not a film and must stay on the
  // POST path it is entitled to.
  film?: boolean;
  // Films: the movie-shelf display title.
  filmTitle?: string | null;
  // The composer's crash-insurance draft: saved BEFORE the upload starts,
  // deleted here only when the post truly exists. If the app dies mid-upload
  // the user finds their post in Drafts, and re-sharing resumes the transfer
  // from the bytes the server already holds.
  resumeDraftId?: string | null;
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
  // 'preparing' = the on-device mezzanine compress that precedes a film's
  // upload (progress = compress fraction). 'done' = finished; the card stays
  // pinned at the top of the feed (playing the local file) until the next
  // manual refresh, so a fresh post is always on top.
  phase: 'preparing' | 'uploading' | 'processing' | 'done' | 'error';
  // Films upload for tens of minutes — the card shows a live time-remaining
  // estimate for them (short videos keep the clean no-numbers look).
  isFilm?: boolean;
  // Cloudflare's own encode progress (0-100) during the 'processing' phase —
  // films show it (plus a derived time-left) so the spinner never reads as
  // stuck through a multi-minute encode.
  processingPct?: number;
  // The post's play length (seconds) — the PRIOR for the encode time estimate
  // (encode duration scales with video length, not with pct velocity).
  durationSec?: number;
  // Measured throughput says the connection is the bottleneck — the card adds
  // a "slow connection" note so a long climb reads as explained, not broken.
  slowLink?: boolean;
  errorMsg?: string;
  // Machine-readable cause for failures the card can explain in the user's own
  // language (errorMsg is a developer string). 'video_too_large' = the prepared
  // file exceeds Cloudflare's POST cap, so retrying can never succeed — the
  // card tells the user to trim instead.
  errorCode?: string;
  postId?: string;                               // set once the DB row is inserted
};

type Ctx = {
  pending: PendingUpload[];
  completedTick: number;                         // bumps when a row lands / finishes → feed refetch
  // Speculatively start uploading a video (e.g. when the user reaches the details
  // step) so it's already up by the time they hit Share. Idempotent per uri.
  prewarmVideo: (localUri: string, maxDurationSeconds: number, sourceSeconds?: number, film?: boolean) => void;
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
  promise: Promise<{ uid: string; subdomain: string; trimmedFile: boolean; stagedPath?: string | null } | null>;
  progress: number;
  // Which stage the prewarm is in — a card that attaches mid-mezzanine must
  // show "Preparing", not a fictional upload at 0%.
  phase: 'preparing' | 'uploading';
  slow?: boolean;                // measured slow-connection state, mirrored on attach
  attachedTempId: string | null; // the pending card now mirroring this upload, once enqueued
  claimed: boolean;              // an enqueue is using it — never discard a claimed prewarm
  // WHY the prewarm died, if it did. The prewarm must swallow its errors (nobody
  // is publishing yet), but claiming a dead prewarm used to surface only a
  // generic "could not prepare" — the real reason (e.g. the file is past the
  // upload cap) was thrown away here, which is exactly where it was known.
  failure?: unknown;
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
// The direct-upload Edge Function's hard ceiling: it clamps every mint to 600s,
// so a FILE longer than that can never ride the POST path — only Premium+ can
// produce one (free sources are refused past 600s at pick time).
const POST_CEILING_MAX_SEC = 600;
// Below this measured throughput (~1.2 Mbps) the connection is the bottleneck
// and the card says so — an explained slow climb frustrates far less than a
// mysterious one.
const SLOW_LINK_BPS = 150_000;

async function startStreamUpload(
  localUri: string,
  maxDurationSeconds: number,
  onProgress: (f: number) => void,
  trim?: { start: number; end: number } | null,
  sourceSeconds?: number,
  film?: boolean,
  onPreparing?: (f: number) => void,
  onBps?: (bps: number) => void,
  /** Dashboard label for the Cloudflare asset — cosmetic, aids manual cleanup. */
  assetName?: string,
): Promise<{ uid: string; subdomain: string; trimmedFile: boolean; stagedPath?: string | null } | null> {
  const localFile = await ensureLocalFile(localUri);
  // Cut the chosen window FIRST, before compressing or uploading, so the
  // discarded footage never leaves the phone: the upload shrinks in proportion
  // and Cloudflare never stores what the post doesn't show. Falls back to the
  // whole file (trimmedFile:false) when the native trimmer isn't in the build,
  // in which case the caller keeps writing trim_start/trim_end as before.
  const cut = trim ? await trimVideoIfPossible(localFile, trim.start, trim.end) : { uri: localFile, trimmed: false };
  // Bitrate targeting needs the duration of the file we ACTUALLY upload: the
  // window when the cut really happened, the whole source when it fell back.
  const uploadSeconds = cut.trimmed && trim ? Math.max(0, trim.end - trim.start) : (sourceSeconds ?? 0);

  // TWO transports, chosen by SIZE — and neither one chunks.
  //
  //   small  → the original single POST straight to Cloudflare (unchanged; it
  //            has carried every short video since launch without a failure).
  //   large  → STAGE-AND-COPY: one native upload into private storage, then
  //            Cloudflare fetches it server-side (lib/streamCopy.ts).
  //
  // The hand-rolled chunked (tus) uploader is gone. It pushed the file from
  // the phone in hundreds of offset-carrying requests, and every long-video
  // failure lived in that reconciliation: bytes skipped but reported as sent,
  // resume keyed to a filename that changed each attempt, a throttled status
  // check read as a dead session, a cleanup sweep deleting live uploads.
  // Staging removes the entire class — there is no partial state to misread.
  //
  // Routing is by SIZE ALONE. Compression runs first and targets ~180 MB for
  // anything long (lib/upload.ts), so a 13-minute film normally lands UNDER the
  // POST cap and takes the simple path — the one transport in this app with a
  // perfect record. Staging exists only for what genuinely won't fit.
  let uid: string;
  let stagedPath: string | null = null;
  const upUri = await compressVideoIfPossible(cut.uri, onPreparing, uploadSeconds);
  const bytes = await fileSizeBytes(upUri);

  // DID COMPRESSION ACTUALLY RUN? compressVideoIfPossible returns its INPUT
  // unchanged on any failure (module missing, native error, Expo Go), so an
  // identical uri on a large file means the transcode silently no-opped. That
  // distinction matters enormously here: the whole plan — fitting the master
  // into the transport that has never failed — depends on it, and pushing a
  // raw multi-GB source instead is the exact thing that has never worked.
  // Say so plainly rather than starting a doomed 40-minute upload.
  const compressed = upUri !== cut.uri;
  if (!compressed && bytes > STREAM_POST_MAX_BYTES) {
    const why = getLastCompressError();
    const err: any = new Error(
      why
        ? `Video preparation failed: ${why}`
        : 'This video could not be prepared for upload on this device — it is too large to send as-is.',
    );
    // Carry the native reason verbatim; the card shows it instead of the
    // translated generic line when we have something specific to say.
    err.code = why ? 'compress_failed_detail' : 'compress_unavailable';
    throw err;
  }

  if (bytes > STREAM_POST_MAX_BYTES) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');
    const copied = await uploadLongVideoViaCopy(upUri, {
      userId: user.id,
      maxDurationSeconds,
      onProgress,
      name: assetName,
    });
    uid = copied.uid;
    stagedPath = copied.stagedPath;
  } else {
    uid = await uploadVideoToStream(upUri, { maxDurationSeconds, onProgress });
  }
  const subdomain = await resolveStreamSubdomain(uid);
  if (!subdomain) return null;
  return { uid, subdomain, trimmedFile: cut.trimmed, stagedPath };
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
      update(tempId, { phase: 'uploading', progress: 0, errorMsg: undefined, errorCode: undefined });

      // Reuse the speculative prewarm if the details step already started it —
      // otherwise start the upload now. Either way we get {uid, subdomain}.
      let result: { uid: string; subdomain: string; trimmedFile: boolean; stagedPath?: string | null } | null;
      const pre = prewarmRef.current.get(job.localUri);
      if (pre) {
        pre.attachedTempId = tempId; // route its live progress into this card
        // The prewarm may still be mid-compress — attach at ITS phase, not a
        // fictional 'uploading' 0%.
        update(tempId, { phase: pre.phase, progress: pre.progress, slowLink: pre.slow });
        result = await pre.promise;
        prewarmRef.current.delete(job.localUri);
        // The prewarm died — fail with ITS reason, not the generic fallback
        // below. (A retry after this runs the whole upload fresh: the entry was
        // just deleted, so the next run takes the else-branch.)
        if (!result && pre.failure) throw pre.failure;
      } else {
        // Phase rides along ONLY when it changes — a {phase, progress} patch on
        // every tick would bypass the progress throttle above and re-render the
        // whole feed per chunk (the exact storm the throttle exists to stop).
        let sentPhase: PendingUpload['phase'] = 'uploading';
        const tick = (phase: 'preparing' | 'uploading') => (f: number) => {
          if (sentPhase !== phase) { sentPhase = phase; update(tempId, { phase, progress: f }); }
          else update(tempId, { progress: f });
        };
        // Slow-connection flag flips only on threshold CROSSINGS — never a
        // per-chunk patch (the progress throttle must stay effective).
        let sentSlow = false;
        result = await startStreamUpload(
          job.localUri,
          job.maxDurationSeconds,
          tick('uploading'),
          job.trim,
          job.sourceSeconds,
          job.film,
          // The film mezzanine compress, surfaced as its own phase so minutes
          // of on-device work never read as a dead upload bar.
          tick('preparing'),
          (bps) => {
            const slow = bps < SLOW_LINK_BPS;
            if (slow !== sentSlow) { sentSlow = slow; update(tempId, { slowLink: slow }); }
          },
          // Film title, else the caption's first words — so the Stream
          // dashboard shows what each asset actually is.
          job.filmTitle || job.caption?.slice(0, 60) || undefined,
        );
      }
      if (!result) throw new Error('Could not prepare the video for playback');
      const { uid, subdomain } = result;
      // The staged master is Cloudflare's source, not ours to keep. Released
      // the moment encoding is confirmed (below); the hourly
      // sweep_video_staging() cron is the backstop if this session dies first.
      const stagedPath = result.stagedPath ?? null;
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
      const row: Record<string, any> = {
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
        ...(job.filmTitle ? { film_title: job.filmTitle } : {}),
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        video_uid: uid, video_status: 'processing', video_hls_url: hls,
        ...(job.song ? { song_id: job.song.id, song_title: job.song.title, song_artist: job.song.artist, song_artist_id: job.song.artistId, song_link_only: !!job.song.linkOnly } : {}),
        ...(job.taggedIds.length ? { tagged_user_ids: job.taggedIds } : {}),
        ...(job.communityIds.length ? { community_ids: job.communityIds } : {}),
        allow_gifs: job.allowGifs,
      };
      let { data: newPost, error } = await supabase.from('posts').insert(row).select('id').single();
      // A column the deployed schema — or PostgREST's CACHED view of it, which
      // lags an ALTER TABLE until the schema is reloaded — does not recognise must
      // never cost the user their post. Drop the optional field and insert again;
      // the post lands, it just loses that one flag. Same degradation the song
      // picker does for the consent columns.
      if (error && /song_link_only/i.test(error.message ?? '')) {
        delete row.song_link_only;
        ({ data: newPost, error } = await supabase.from('posts').insert(row).select('id').single());
      }
      if (error && /film_title/i.test(error.message ?? '')) {
        delete row.film_title;
        ({ data: newPost, error } = await supabase.from('posts').insert(row).select('id').single());
      }
      // One asset = one post, DB-enforced (posts_video_uid_unique). If a racing
      // duplicate (double-Share, retry overlap) loses that race, ADOPT the row
      // that won instead of failing a card whose upload genuinely succeeded.
      if (error && /posts_video_uid_unique|duplicate key/i.test(error.message ?? '')) {
        const { data: existing } = await supabase.from('posts').select('id').eq('video_uid', uid).maybeSingle();
        if (existing?.id) { newPost = existing as any; error = null as any; }
      }
      if (error) throw error;
      const postId = newPost!.id as string;
      // The row now references the asset, so the crash-recovery tracker can let go
      // of it — otherwise the next launch's sweep would have to prove it's in use.
      untrackStreamUpload(uid);
      // Stamp the crash-insurance draft with the row that now exists: if the
      // app dies during the ENCODE wait below, boot recovery heals this exact
      // row (or removes it and offers the draft) instead of leaving a black
      // never-ready post in the feed.
      if (job.resumeDraftId) patchDraft(job.resumeDraftId, { postedId: postId, postedUid: uid }).catch(() => {});
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
      // Films encode for many minutes — the 5-minute default budget (tuned for
      // 3-minute clips) would wrongly roll back a long film that Cloudflare is
      // still happily encoding. Scale the wait with the source length: ~1.5s
      // of budget per source second, floored at the old 5 minutes. Cloudflare's
      // own encode progress feeds the card's time-left display along the way.
      const pollBudgetMs = Math.max(300_000, Math.round((job.sourceSeconds ?? 0) * 1500));
      const poll = await pollStreamReady(uid, pollBudgetMs, (pct) => {
        if (job.film) update(tempId, { processingPct: pct });
      });
      if (poll.incomplete) {
        // Cloudflare has the asset but not all of its bytes. This is the ONE
        // failure that must destroy nothing: the Stream asset stays, the tus
        // resume checkpoint stays, and Retry re-enters the uploader, which
        // HEADs for the true offset and sends only the missing tail. Deleting
        // the asset here (the old behaviour) is what turned a 30-second
        // top-up into a full multi-GB restart — the exact loop that made this
        // feature feel unusable.
        await supabase.from('posts').delete().eq('id', postId).then(undefined, () => {});
        setCompletedTick((n) => n + 1); // the row can't play yet — take it back out
        const err: any = new Error('Almost there — tap Retry to send the last part');
        err.code = 'upload_incomplete';
        throw err;
      }
      if (poll.errored) {
        // Cloudflare REJECTED the encode — the asset is dead server-side, so
        // rolling back the row is correct. But say WHY (Cloudflare's own
        // reason), because "processing failed" after a 15-minute upload with
        // no explanation is where user trust goes to die. Retry re-inserts a
        // fresh row; the crash-insurance draft still holds the whole post.
        await supabase.from('posts').delete().eq('id', postId).then(undefined, () => {});
        deleteStreamVideo(uid).catch(() => {});
        setCompletedTick((n) => n + 1); // pull the deleted row back out of the feed
        throw new Error(`Video processing failed${poll.reason ? ` — ${poll.reason}` : ''}`);
      }
      if (!poll.ready) {
        // TIMEOUT ≠ failure: the encode is (almost certainly) still running on
        // Cloudflare's side. The old behavior DELETED the row and the asset —
        // destroying a quarter hour of the user's upload because our poll got
        // bored. Now the post simply stays: the feed shows its processing
        // cover, the pending card retires quietly, and a detached low-rate
        // babysitter keeps watching so the post flips live THIS session (boot
        // recovery covers the app-was-closed case).
        setCompletedTick((n) => n + 1);
        remove(tempId);
        pollStreamReady(uid, 30 * 60_000, undefined, 20_000).then((late) => {
          if (!late.ready) return; // boot recovery inherits whatever remains
          supabase.from('posts').update({ video_status: 'ready' }).eq('id', postId).then(undefined, () => {});
          if (stagedPath) releaseStagedMaster(stagedPath).catch(() => {});
          if (job.resumeDraftId) deleteDraft(job.resumeDraftId).catch(() => {});
          setCompletedTick((n) => n + 1);
        }).catch(() => {});
        return;
      }
      supabase.from('posts').update({ video_status: 'ready' }).eq('id', postId).then(undefined, () => {});
      if (stagedPath) releaseStagedMaster(stagedPath).catch(() => {});
      const shownFor = Date.now() - processingStart;
      if (shownFor < MIN_PROCESSING_MS) await new Promise((r) => setTimeout(r, MIN_PROCESSING_MS - shownFor));
      // Done — hand off from the optimistic card to the REAL post: pin its id at the
      // top of Home (rendered as a normal PostCard, fully interactive) and drop the
      // card. It falls into natural rank on the next manual refresh.
      setPinnedIds((ids) => [postId, ...ids.filter((id) => id !== postId)]);
      // Bump AGAIN on completion, not just after the insert. The pin alone puts
      // the id at the top, but the feed still has to hold the finished row —
      // this makes it refetch at the moment encoding lands, so the post appears
      // by itself instead of waiting for the user to pull to refresh.
      setCompletedTick((n) => n + 1);
      remove(tempId);
      // THE moment the post actually exists — row inserted, file uploaded,
      // encoding finished. The composer deliberately stays quiet at enqueue
      // time (it can't know any of that yet), so this is the only celebration,
      // and it fires wherever the user happens to be.
      // The crash-insurance draft has served its purpose — the post is real.
      if (job.resumeDraftId) deleteDraft(job.resumeDraftId).catch(() => {});
      // The film is up — its cached mezzanine (hundreds of MB) can leave disk.
      if (job.film) releaseFilmMezzanine(job.localUri).catch(() => {});
      notifySuccess();
    } catch (err: any) {
      update(tempId, { phase: 'error', errorMsg: err?.message || 'Upload failed', errorCode: err?.code });
    }
  }, [update, remove]);

  const prewarmVideo = useCallback((localUri: string, maxDurationSeconds: number, sourceSeconds?: number, film?: boolean) => {
    if (!localUri || prewarmRef.current.has(localUri)) return;
    const entry: PrewarmEntry = { progress: 0, phase: 'uploading', attachedTempId: null, claimed: false, promise: Promise.resolve(null) };
    // Same throttle-respecting rule as run(): phase is patched onto the card
    // only when it CHANGES; plain ticks stay single-key progress patches.
    const forward = (phase: PrewarmEntry['phase']) => (f: number) => {
      const phaseChanged = entry.phase !== phase;
      entry.phase = phase;
      entry.progress = f;
      if (!entry.attachedTempId) return;
      if (phaseChanged) update(entry.attachedTempId, { phase, progress: f });
      else update(entry.attachedTempId, { progress: f });
    };
    entry.promise = (async () => {
      try {
        return await startStreamUpload(
          localUri,
          maxDurationSeconds,
          forward('uploading'),
          null, // a prewarm never trims — it runs before the window is final
          sourceSeconds,
          film,
          forward('preparing'),
          (bps) => {
            const slow = bps < SLOW_LINK_BPS;
            if (slow === !!entry.slow) return;
            entry.slow = slow;
            if (entry.attachedTempId) update(entry.attachedTempId, { slowLink: slow });
          },
        );
      } catch (e) { entry.failure = e; return null; }
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
        isFilm: !!job.film,
        durationSec: job.durationSeconds ?? undefined,
      },
      ...list,
    ]);
    run(tempId, job);
  }, [run]);

  const retry = useCallback((tempId: string) => {
    const job = jobsRef.current.get(tempId);
    if (job) run(tempId, job);
  }, [run]);

  const dismiss = useCallback((tempId: string) => {
    // Deliberate abandonment — free the film's cached mezzanine too. (The
    // crash-insurance draft deliberately survives: dismissing an error is not
    // discarding the post.)
    const job = jobsRef.current.get(tempId);
    if (job?.film) releaseFilmMezzanine(job.localUri).catch(() => {});
    remove(tempId);
  }, [remove]);

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
