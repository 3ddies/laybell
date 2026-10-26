// Headless video trimming USED to be performed by react-native-video-trim, used
// to physically cut a long clip down to the window the user chose BEFORE upload.
//
// That package was REMOVED (2026-10-26): it bundled its own copy of FFmpeg
// (via the `ffmpeg-mobile-min` pod) which clashed at `pod install` with
// react-native-audio-api's FFmpeg — and the DJ engine genuinely needs FFmpeg to
// decode AAC/M4A songs (miniaudio, its only FFmpeg-free fallback, can't). Two
// FFmpegs can't coexist in one iOS build, so one had to go.
//
// Nothing of value was lost: native trim was ALREADY kill-switched off
// (NATIVE_TRIM_ENABLED = false in lib/upload.ts) because the native transcoder
// was crash-suspect on device. Every call therefore already downgraded to
// VIRTUAL trim — we store trim_start/trim_end and upload the source, which
// always produces a correct post. This file keeps the same public contract so
// callers are unchanged; it now simply always reports trimmed:false.
//
// If real byte-cutting is ever wanted again, choose a trimmer that does NOT
// vendor its own FFmpeg (e.g. an AVFoundation-only module), or route the cut
// through react-native-audio-api's FFmpeg so the binary carries only one.

export type TrimOutcome = {
  /** The file to upload: the trimmed cut, or the original when trimming wasn't possible. */
  uri: string;
  /** True only when the bytes were REALLY cut. Callers must not also write
   *  trim_start/trim_end when this is true, or playback would trim twice.
   *  Always false now — see the note above. */
  trimmed: boolean;
};

// Cut [startSec, endSec] out of `uri` and return the new file.
//
// NEVER throws and never returns an unusable path. With native trim removed this
// always returns the ORIGINAL uri with trimmed:false, so the caller keeps the
// proven virtual-trim behaviour (trim_start/trim_end), which produces a correct
// post. Signature preserved so callers are unchanged.
export async function trimVideoIfPossible(
  uri: string,
  startSec: number,
  endSec: number,
): Promise<TrimOutcome> {
  void startSec;
  void endSec;
  return { uri, trimmed: false };
}
