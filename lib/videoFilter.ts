import * as FileSystem from 'expo-file-system/legacy';
import VideoExport, { videoFilterAvailable } from '../modules/laybell-video-export';
import { ensureLocalFile } from './upload';
import { skiaColorMatrix, type FilterKey } from './filters';

// Bakes a colour filter into a VIDEO the way lib/filterSkia bakes one into a photo: the
// posted/story video uploads with the look already in its pixels, so it travels to every
// viewer (a video can't be colour-filtered live at playback the way a photo view can). It
// re-encodes the WHOLE clip at its own size with the filter and the original sound kept —
// the posted window, captions and music stay runtime data applied over the filtered pixels,
// exactly as before.
//
// Safe by design: an 'original' filter, a build without the native filter (no OTA — older
// builds lack it), or any failure returns the source uri UNCHANGED, so posting a video
// never fails because a filter couldn't be baked.

function log(...parts: unknown[]) {
  // eslint-disable-next-line no-console
  if (__DEV__) console.log('[video-filter]', ...parts);
}

/**
 * The source video with `filterKey` baked into every frame, or the source uri unchanged
 * when there's nothing to do / nothing can do it. Writes an mp4 into the cache directory;
 * the caller uploads/enqueues the returned uri and may delete it afterwards.
 */
export async function bakeVideoFilter(srcUri: string, filterKey: FilterKey | null | undefined): Promise<string> {
  const matrix = skiaColorMatrix(filterKey);
  if (!matrix) return srcUri;                 // 'original' / unknown — no colour change
  if (!VideoExport || !videoFilterAvailable()) {
    log('this build cannot bake a video filter — leaving the clip unfiltered');
    return srcUri;
  }
  try {
    const source = await ensureLocalFile(srcUri);
    const info = await VideoExport.getVideoInfo(source);
    if (!(info.width > 0 && info.height > 0 && info.durationSec > 0)) return srcUri;
    const dir = FileSystem.cacheDirectory ?? '';
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const output = `${dir}laybell-filtered-${stamp}.mp4`;
    log(`baking ${filterKey} into ${info.width}x${info.height}, ${info.durationSec.toFixed(2)}s`);
    const written = await VideoExport.exportVideo({
      videoUri: source,
      outputUri: output,
      startSec: 0,
      endSec: info.durationSec,       // the whole clip; the posted window stays runtime
      width: info.width,
      height: info.height,
      videoVolume: 1,                 // keep the clip's own sound; music is added at view time
      song: null,
      overlays: [],                   // captions are drawn at view time, not baked here
      videoFit: 'stretch',
      colorMatrix: matrix,
    });
    log('baked →', written);
    return written || srcUri;
  } catch (e: any) {
    log(`bake failed (${e?.message ?? e}) — leaving the clip unfiltered`);
    return srcUri;
  }
}
