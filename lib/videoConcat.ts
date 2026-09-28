import * as FileSystem from 'expo-file-system/legacy';
import VideoExport, { videoConcatAvailable } from '../modules/laybell-video-export';

// Joining the multi-clip recorder's segments into the one video the composer works
// with. The native module (modules/laybell-video-export) does the stitching; this is
// the thin JS door to it, so the camera stays UI-only. Builds made before the module
// gained concatClips (no OTA on this project) simply don't offer multi-clip capture —
// canConcatClips() gates the whole mode.

/** Whether this build can stitch recorded segments (the multi-clip recorder needs it). */
export function canConcatClips(): boolean {
  return videoConcatAvailable();
}

/**
 * Joins recorded clips head to tail into a single MP4 in the cache directory and
 * resolves with its URI. One clip is returned as-is (nothing to join, no re-encode).
 * The segments must share a size and orientation — the recorder keeps them on one
 * camera — which the native side relies on.
 */
export async function concatClips(uris: string[]): Promise<string> {
  if (uris.length === 0) throw new Error('There are no clips to join');
  if (uris.length === 1) return uris[0];
  if (!VideoExport?.concatClips) throw new Error('This build cannot join clips');
  const dir = FileSystem.cacheDirectory ?? '';
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const output = `${dir}laybell-clip-${stamp}.mp4`;
  return VideoExport.concatClips(uris, output);
}
