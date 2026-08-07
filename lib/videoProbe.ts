import { createVideoPlayer } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';

// Metadata probe for videos that arrive WITHOUT picker metadata (Files-app
// imports; camera-roll picks get duration/dims from MediaLibrary and never
// need this).
//
// Two independent reads, each chosen deliberately:
//   • Dimensions come from a THUMBNAIL, not the player's video track — the
//     decoded frame has display rotation applied, while track size is the
//     coded size, which reports a phone-shot landscape file as portrait and
//     would route it into the wrong pipeline (vertical 3-min vs film).
//     Decoding a frame is also the honest "can this device read this file?"
//     test, so unsupported containers fail HERE, not at Share.
//   • Duration comes from a headless expo-video player — the container's own
//     clock, which beats picker metadata anyway (VFR sources under-report).

export type ProbedVideo = {
  durationSec: number;
  width: number;
  height: number;
  /** Decoded first frame — usable as an instant poster. */
  posterUri: string;
};

export async function probeVideo(uri: string, timeoutMs = 20_000): Promise<ProbedVideo> {
  const thumb = await VideoThumbnails.getThumbnailAsync(uri, { time: 0, quality: 0.5 });
  if (!thumb?.width || !thumb?.height) throw new Error('probe_no_frame');

  const player = createVideoPlayer(uri);
  try {
    const durationSec = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.remove();
        fn();
      };
      const timer = setTimeout(() => settle(() => reject(new Error('probe_timeout'))), timeoutMs);
      const ready = () => settle(() => {
        const d = player.duration;
        resolve(Number.isFinite(d) && d > 0 ? d : 0);
      });
      const sub = player.addListener('statusChange', ({ status, error }) => {
        if (status === 'readyToPlay') ready();
        else if (status === 'error') settle(() => reject(error ?? new Error('probe_error')));
      });
      // The player may have finished loading before the listener attached.
      if (player.status === 'readyToPlay') ready();
      else if (player.status === 'error') settle(() => reject(new Error('probe_error')));
    });
    return { durationSec, width: thumb.width, height: thumb.height, posterUri: thumb.uri };
  } finally {
    // Created with createVideoPlayer, so releasing is on us.
    player.release();
  }
}
