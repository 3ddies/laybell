import Constants from 'expo-constants';

const IS_EXPO_GO = Constants.executionEnvironment === 'storeClient';

// Headless video trimming (react-native-video-trim), used to physically cut a
// long clip down to the window the user actually chose BEFORE it is uploaded.
//
// Why this exists: trimming used to be VIRTUAL — we stored trim_start/trim_end
// and uploaded the whole source, so Cloudflare stored (and the phone uploaded)
// footage the post never shows. A 10-minute source kept for a 3-minute window
// meant ~3x the upload time and permanent storage for the discarded part. The
// upload time is the bigger problem of the two: on cellular it is the difference
// between a post landing and a post timing out.
//
// react-native-video-trim is a NATIVE module, so it only works once the binary
// is rebuilt with it. It is loaded DYNAMICALLY with a graceful fallback —
// exactly like react-native-compressor in lib/upload.ts and NetInfo in
// lib/network.ts — so this ships safely ahead of that rebuild. Until then every
// call reports trimmed:false and the caller keeps the old virtual-trim
// behaviour, which still produces a correct post.

export type TrimOutcome = {
  /** The file to upload: the trimmed cut, or the original when trimming wasn't possible. */
  uri: string;
  /** True only when the bytes were REALLY cut. Callers must not also write
   *  trim_start/trim_end when this is true, or playback would trim twice. */
  trimmed: boolean;
};

let modPromise: Promise<any | null> | null = null;
function loadTrimmer(): Promise<any | null> {
  if (IS_EXPO_GO) return Promise.resolve(null);
  if (!modPromise) {
    modPromise = import('react-native-video-trim')
      .then((m: any) => (typeof m?.trim === 'function' ? m : typeof m?.default?.trim === 'function' ? m.default : null))
      .catch(() => null); // module not in this build yet → graceful fallback
  }
  return modPromise;
}

// Cut [startSec, endSec] out of `uri` and return the new file.
//
// NEVER throws and never returns an unusable path: any failure (module absent,
// degenerate range, native error, missing output) falls back to the ORIGINAL
// uri with trimmed:false. A failed trim must downgrade the post to the old
// behaviour, never lose it.
export async function trimVideoIfPossible(
  uri: string,
  startSec: number,
  endSec: number,
): Promise<TrimOutcome> {
  const fallback: TrimOutcome = { uri, trimmed: false };
  if (!uri || !(endSec > startSec)) return fallback;

  const mod = await loadTrimmer();
  if (!mod) return fallback;

  try {
    const res = await mod.trim(uri, {
      startTime: Math.max(0, Math.round(startSec * 1000)), // the API takes ms
      endTime: Math.round(endSec * 1000),
    });
    const out: string | undefined = res?.outputPath;
    if (!res?.success || !out) return fallback;
    // Outputs land in the cache directory; the uploader needs a scheme.
    return { uri: /^[a-z]+:\/\//i.test(out) ? out : `file://${out}`, trimmed: true };
  } catch {
    return fallback;
  }
}
