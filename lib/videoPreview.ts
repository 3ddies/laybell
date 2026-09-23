import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { ensureLocalFile } from './upload';
import VideoExport, { videoExportAvailable } from '../modules/laybell-video-export';

// Explore's looping video previews, without a bill that grows with users
// (1.0.4; supabase/sql/post_video_previews.sql).
//
// THE PROBLEM. The owner liked 1.0.2's real video previews better than the
// moving stills that replaced them, but not at Cloudflare's price: Stream bills
// every second it DELIVERS, buffering included, rounded up to 4-second segments,
// and expo-video cannot cache an HLS source on iOS — so a looping preview
// re-bills on every pass. Time-boxing it to 5–10 seconds still came to roughly
// $1,500/month at 10k users (docs/POST_LAUNCH_BACKLOG.md §11).
//
// THE ANSWER. The poster's phone already holds the video and already knows how
// to cut one (modules/laybell-video-export, the camera-roll exporter), so it
// writes a few seconds of it — small, muted, no captions — and uploads that next
// to the poster. Cloudflare Stream is never involved in a preview again. The
// file is immutable and cached hard, and expo-video keeps its own copy on the
// phone (`useCaching`), so a preview costs ONE small download per phone: every
// replay, scroll-back and return visit after that is free.
//
// The cost that remains is Supabase egress, and only for a preview somebody has
// never seen. For scale: today's four still frames already pull ~240 KB per
// preview — the same order as one of these clips — they just land on
// Cloudflare's unbilled thumbnail meter instead.
//
// A post without one (an older app, a failed export, a film too big to touch in
// time) simply keeps the moving stills. That is the whole fallback.

// MEASURED, not estimated (2026-09-20): a real post at 400px × 5s came out at
// 741 KB — three times the guess, and heavier than the four still frames
// (~240 KB) this replaces. The native exporter always uses
// AVAssetExportPresetHighestQuality (it exists to write camera-roll copies), and
// exposes no bitrate, so the only levers here are the frame and the duration.
// Both were cut: ~380 KB expected, and worth re-measuring from the log below.
//
// The better fix is a bitrate cap in the exporter — 400px at ~500 kbps would be
// sharper per byte than shrinking the frame — but that is native code and so a
// new dev build.

/** How much of the video a preview shows. Longer costs linearly more bytes. */
const PREVIEW_SEC = 4;
/**
 * The clip's width in pixels. An Explore tile is ~187pt wide — 561px on a 3x
 * screen — so this is deliberately softer than the tile: it is motion seen at a
 * glance, and every pixel here is paid for on every first view.
 */
const PREVIEW_W = 320;
/** Uploaded as immutable (a unique name, never rewritten), so it can be cached hard. */
const CACHE_FOREVER = '31536000';

/** Even pixels only — the exporter wants an even frame. */
function even(n: number): number {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v + 1;
}

/**
 * Cut a preview from a LOCAL video and upload it. Returns its public URL, or
 * null — a preview is a nicety, so every failure here is silent and simply
 * leaves the post with moving stills.
 *
 * `startSec` is where the POSTED window begins: a physically trimmed file starts
 * at its trim (0), a virtually trimmed one keeps the source's clock.
 */
export async function makeVideoPreview(
  localUri: string | null | undefined,
  userId: string,
  startSec = 0,
): Promise<string | null> {
  // Older binaries have no exporter at all (it ships with the app, not over the
  // air), and they must not crash reaching for one.
  if (!localUri || !userId || !videoExportAvailable()) return null;
  const exporter = VideoExport!;
  const dir = FileSystem.cacheDirectory ?? '';
  if (!dir) return null;
  const output = `${dir}laybell-preview-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.mp4`;
  try {
    // A camera-roll file:// URL is not readable as a track without this.
    const source = await ensureLocalFile(localUri);
    const info = await exporter.getVideoInfo(source);
    if (!(info.durationSec > 0) || !(info.width > 0) || !(info.height > 0)) return null;

    const start = Math.max(0, Math.min(startSec, Math.max(0, info.durationSec - 0.5)));
    const end = Math.min(start + PREVIEW_SEC, info.durationSec);
    if (!(end > start)) return null;

    await exporter.exportVideo({
      videoUri: source,
      outputUri: output,
      startSec: start,
      endSec: end,
      width: even(PREVIEW_W),
      height: even((PREVIEW_W * info.height) / info.width),
      // Silent, and no captions: a preview is motion in a grid, and one that
      // could make noise in a scroll would be a bug.
      videoVolume: 0,
      song: null,
      overlays: [],
    });

    const stat = await FileSystem.getInfoAsync(output);
    if (!stat.exists) return null;
    // The one number that decides whether this scales — read it from a real post
    // rather than estimating (see the header). It rides the normal logs.
    console.log(`[preview] ${(end - start).toFixed(1)}s clip, ${even(PREVIEW_W)}px wide → ${Math.round(stat.size / 1024)} KB`);

    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-p.mp4`;
    const path = `${userId}/${name}`;
    const form = new FormData();
    form.append('file', { uri: output, name, type: 'video/mp4' } as any);
    const { error } = await supabase.storage.from('posts').upload(path, form, {
      contentType: 'video/mp4',
      upsert: false,
      cacheControl: CACHE_FOREVER,
    });
    if (error) return null;
    return supabase.storage.from('posts').getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  } finally {
    // The cut is scratch either way.
    FileSystem.deleteAsync(output, { idempotent: true }).catch(() => {});
  }
}
