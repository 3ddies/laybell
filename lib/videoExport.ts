import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { AppState, Dimensions } from 'react-native';
import { supabase } from './supabase';
import { ensureLocalFile } from './upload';
import { postStickers } from './stickerTiming';
import { isBandSticker } from './bandCaptions';
import { captionSegments, outputSize, screenRectInFrame, UPRIGHT_FRAME, type Rect, type Size } from './exportPlan';
import VideoExport, { videoExportAvailable, videoFitAvailable, type ExportOverlay, type ExportSong } from '../modules/laybell-video-export';
import type { Sticker } from '../components/StickerLayer';

// "Save to camera roll" for a video post (the details step's Advanced settings, on
// by default). The FINISHED video — the posted window, its song mixed in at its part
// and levels, its captions timed over it — is written by the native exporter and
// added to the camera roll.
//
// It starts the moment the post is shared, beside the upload rather than after it:
// the person is still in the app then, and iOS stops an export the moment the app
// leaves the foreground. An export that failed while the app was away is tried again
// when it is back.
//
// Best-effort by design: whatever goes wrong only ever costs the copy, never the
// post. It works quietly (the owner's call, 2026-09-11): components/VideoSavedToast
// speaks only when a copy the switch promised couldn't be made. Every step finishes
// or fails, so nothing waits forever.
//
// Dev builds narrate every step under [save-video] in the Metro log.

export type FinishedVideo = {
  /** The clip as the composer picked it; a camera-roll URI is copied first. */
  localUri: string;
  /** The posted window on the source clock; an end of 0 means "to the end". */
  windowStart: number;
  windowEnd: number;
  /** A vertical clip's captions are drawn over it; a horizontal clip with band captions is saved upright, with them in the bands. */
  vertical: boolean;
  captions: unknown[] | null;
  timedCaptions: unknown[] | null;
  songId: string | null;
  /** False for a music video, whose song is a credit and never plays. */
  songPlays: boolean;
  songMix: { song_start_sec: number; song_volume: number; video_volume: number } | null;
};

/** What the root capture host is asked to draw: one caption image. */
export type FrameJob = {
  width: number;
  height: number;
  /** The screen the captions were placed on, and where it sits in the frame. */
  screen: Size;
  rect: Rect;
  stickers: Sticker[];
  outputUri: string;
  /** A horizontal clip's band captions, drawn in its upright frame (lib/bandCaptions exportBandZone). */
  bands?: { ratio: number };
};

export type SaveStatus =
  | { phase: 'saving' }
  | { phase: 'saved' }
  | { phase: 'failed'; reason: 'permission' | 'error' | 'interrupted' };

// iOS stops an export when the app leaves the foreground; such a copy is tried again
// when the app is back. One that failed with the app open gets one more try after a
// pause: the upload may have been encoding the same clip beside it.
const MAX_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 4000;
// A caption image takes a couple of frames; one that isn't back by now never will be.
const CAPTION_TIMEOUT_MS = 15_000;

function log(...parts: unknown[]) {
  // eslint-disable-next-line no-console
  if (__DEV__) console.log('[save-video]', ...parts);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or a failure saying `message` if it hasn't settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// ── The capture host (components/CaptionCaptureHost) registers here ───────────
let frameRenderer: ((job: FrameJob) => Promise<string>) | null = null;
export function registerFrameRenderer(render: (job: FrameJob) => Promise<string>): () => void {
  frameRenderer = render;
  return () => { if (frameRenderer === render) frameRenderer = null; };
}

// ── Status, for the toast ─────────────────────────────────────────────────────
const listeners = new Set<(status: SaveStatus) => void>();
export function subscribeVideoSaves(listener: (status: SaveStatus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function emit(status: SaveStatus): SaveStatus {
  for (const l of [...listeners]) { try { l(status); } catch { /* one listener is not the others' problem */ } }
  return status;
}

/** Whether this build can write a finished video at all (the native exporter is in it). */
export function canSaveFinishedVideo(): boolean {
  return videoExportAvailable();
}

/**
 * Asks for "Add to Photos" at the moment it makes sense — when the post with the
 * switch on is shared.
 */
export async function requestSavePermission(): Promise<boolean> {
  try {
    const current = await MediaLibrary.getPermissionsAsync(true);
    if (current.granted) { log('permission: already granted'); return true; }
    if (!current.canAskAgain) { log('permission: denied earlier, cannot ask again'); return false; }
    const asked = await MediaLibrary.requestPermissionsAsync(true);
    log(`permission: asked, ${asked.granted ? 'granted' : 'denied'}`);
    return asked.granted;
  } catch (e: any) {
    log(`permission: check failed: ${e?.message ?? e}`);
    return false;
  }
}

/** The switch was on but the copy can't be made — say so, rather than nothing. */
export function reportSaveSkipped(reason: 'permission'): void {
  log(`skipped: ${reason}`);
  emit({ phase: 'failed', reason });
}

// One at a time: each is a full re-encode.
let chain: Promise<unknown> = Promise.resolve();
export function queueFinishedVideoSave(video: FinishedVideo): Promise<SaveStatus> {
  log('queued', {
    window: [video.windowStart, video.windowEnd],
    vertical: video.vertical,
    captions: Array.isArray(video.captions) ? video.captions.length : 0,
    timedCaptions: Array.isArray(video.timedCaptions) ? video.timedCaptions.length : 0,
    song: !!video.songId && video.songPlays,
  });
  const run = chain.then(() => saveFinishedVideo(video), () => saveFinishedVideo(video));
  chain = run.catch(() => {});
  return run;
}

function untilActive(): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') { sub.remove(); resolve(); }
    });
  });
}

async function saveFinishedVideo(video: FinishedVideo): Promise<SaveStatus> {
  if (!VideoExport) {
    log('this build has no native exporter');
    return emit({ phase: 'failed', reason: 'error' });
  }
  emit({ phase: 'saving' });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let leftApp = AppState.currentState !== 'active';
    const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') leftApp = true; });
    try {
      const outcome = await attemptSave(video, attempt);
      log(outcome.phase === 'saved' ? 'saved to the camera roll' : `not saved: ${outcome.phase === 'failed' ? outcome.reason : outcome.phase}`);
      return emit(outcome);
    } catch (e: any) {
      log(`attempt ${attempt} failed${leftApp ? ' (the app left the foreground)' : ''}: ${e?.message ?? e}`);
      const again = attempt < MAX_ATTEMPTS && (leftApp || attempt === 1);
      if (!again) return emit({ phase: 'failed', reason: leftApp ? 'interrupted' : 'error' });
    } finally {
      sub.remove();
    }
    if (leftApp) {
      await untilActive();
      log(`back in the app — trying again (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      emit({ phase: 'saving' });
    } else {
      await delay(RETRY_PAUSE_MS);
      log(`trying again (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
    }
  }
  return emit({ phase: 'failed', reason: 'error' });
}

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'caf', 'mp4']);
function audioExtension(url: string): string {
  const tail = url.split(/[?#]/)[0].split('/').pop() ?? '';
  const ext = tail.includes('.') ? tail.split('.').pop()!.toLowerCase() : '';
  return AUDIO_EXTS.has(ext) ? ext : 'm4a';
}

/** One try. Resolves with the outcome it can name; throws on anything that went wrong. */
async function attemptSave(video: FinishedVideo, attempt: number): Promise<SaveStatus> {
  const exporter = VideoExport!;
  const scratch: string[] = [];
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = FileSystem.cacheDirectory ?? '';
  const began = Date.now();
  try {
    const permission = await MediaLibrary.getPermissionsAsync(true);
    if (!permission.granted) return { phase: 'failed', reason: 'permission' };

    log(`attempt ${attempt}: reading the clip`);
    const source = await ensureLocalFile(video.localUri);
    const info = await exporter.getVideoInfo(source);
    log(`attempt ${attempt}: clip ${info.width}x${info.height}, ${info.durationSec.toFixed(2)} s`);
    const end = Math.min(video.windowEnd > video.windowStart ? video.windowEnd : info.durationSec, info.durationSec);
    const start = Math.max(0, Math.min(video.windowStart, end));
    if (!(end > start)) throw new Error(`empty window ${start}–${end}`);

    // The captions. A vertical clip's where they were placed on this screen, which sits
    // inside its frame. A horizontal clip's band captions live in the bands around its
    // picture, so a horizontal clip that has them is saved UPRIGHT (the owner's call):
    // the clip across the middle of a 9:16 frame and the captions in its bands, as the
    // app shows it upright. That takes an exporter that can fit a clip inside its
    // frame; on a build without one such a clip gets no copy — not a stretched
    // picture, nor one without its captions.
    const captions = postStickers<Sticker>(video.captions, video.timedCaptions)
      .filter((s) => typeof s?.text === 'string' && s.text.trim().length > 0)
      .filter((s) => isBandSticker(s) !== video.vertical);
    const upright = !video.vertical && captions.length > 0;
    if (upright && !videoFitAvailable()) {
      log(`attempt ${attempt}: this build's exporter can't save a clip upright — no copy (a newer dev build can)`);
      return { phase: 'failed', reason: 'error' };
    }
    const frame = upright ? UPRIGHT_FRAME : outputSize(info);

    // One image per stretch where the same captions show.
    const overlays: ExportOverlay[] = [];
    const segments = captionSegments(captions, start, end);
    if (segments.length) {
      if (!frameRenderer) throw new Error('the caption capture host is not mounted');
      const { width, height } = Dimensions.get('window');
      // A vertical clip's captions were placed on this screen, which sits inside its
      // frame. A horizontal clip's are laid out on the upright frame itself, at this
      // screen's width, so they keep their size against it.
      const screen = upright ? { width, height: width * (frame.height / frame.width) } : { width, height };
      const rect = upright ? { x: 0, y: 0, width: frame.width, height: frame.height } : screenRectInFrame(frame, screen);
      const bands = upright ? { ratio: info.width / info.height } : undefined;
      for (let i = 0; i < segments.length; i++) {
        const uri = await withTimeout(frameRenderer({
          width: frame.width,
          height: frame.height,
          screen,
          rect,
          stickers: segments[i].stickers,
          outputUri: `${dir}laybell-caption-${stamp}-${i}.png`,
          bands,
        }), CAPTION_TIMEOUT_MS, `caption image ${i + 1} of ${segments.length} was never drawn`);
        scratch.push(uri);
        overlays.push({ uri, startSec: segments[i].start, endSec: segments[i].end });
      }
    }
    log(`attempt ${attempt}: ${captions.length} caption(s) → ${overlays.length} image(s)${upright ? ', saved upright' : ''}`);

    // The song, at its part and level — the same defaults the app plays a song post
    // with when no mix was set (lib/songMix: from the top, full, video silent).
    let song: ExportSong | null = null;
    if (video.songId && video.songPlays) {
      const { data } = await supabase.from('posts').select('media_url').eq('id', video.songId).maybeSingle();
      const url = (data as { media_url?: string | null } | null)?.media_url;
      if (url) {
        const download = await FileSystem.downloadAsync(url, `${dir}laybell-song-${stamp}.${audioExtension(url)}`);
        scratch.push(download.uri);
        if (download.status === 200) {
          song = {
            uri: download.uri,
            startSec: Math.max(0, video.songMix?.song_start_sec ?? 0),
            volume: video.songMix?.song_volume ?? 1,
          };
        }
      }
      log(`attempt ${attempt}: song ${song ? `ready, from ${song.startSec}s at ${Math.round(song.volume * 100)}%` : 'unavailable — saving without it'}`);
    }
    const videoVolume = song ? (video.songMix?.video_volume ?? 0) : 1;

    const output = `${dir}laybell-video-${stamp}.mp4`;
    scratch.push(output);
    log(`attempt ${attempt}: exporting ${frame.width}x${frame.height}, ${start.toFixed(2)}–${end.toFixed(2)} s`);
    const written = await exporter.exportVideo({
      videoUri: source,
      outputUri: output,
      startSec: start,
      endSec: end,
      width: frame.width,
      height: frame.height,
      videoVolume,
      song,
      overlays,
      videoFit: upright ? 'contain' : 'stretch',
    });
    if (written !== output) scratch.push(written);
    log(`attempt ${attempt}: exported in ${Date.now() - began} ms`);
    await MediaLibrary.saveToLibraryAsync(written);
    return { phase: 'saved' };
  } finally {
    // The camera roll keeps its own copy; nothing here is needed afterwards.
    for (const uri of scratch) {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }
}
