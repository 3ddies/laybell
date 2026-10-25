import { NativeModule, requireOptionalNativeModule } from 'expo';

// Laybell's own native video exporter — the one piece of native code in the app
// (owner's decision, 2026-09-11). It writes a FINISHED video for the camera roll:
// the posted window of the clip, the song mixed in at its part and levels, and the
// captions laid over it as full-frame images (lib/exportPlan decides which image
// shows when; components/CaptionCaptureHost draws them from the real caption
// renderer). iOS uses AVFoundation, Android Media3 Transformer — no FFmpeg.
//
// OPTIONAL on purpose: every build made before this module existed lacks it, and a
// hard require would crash any screen that imports this file. Callers check
// videoExportAvailable() and simply offer nothing without it.

export type VideoInfo = {
  /** Display size, rotation applied. */
  width: number;
  height: number;
  durationSec: number;
};

export type AudioProbe = {
  /** Whether the clip has an audio track at all. */
  hasAudioTrack: boolean;
  /**
   * Average linear RMS loudness (0..1) over up to ~20s of the audio, or -1 when it
   * could not be measured (decode failure). 0 when there is no audio track.
   */
  rms: number;
};

export type ExportOverlay = {
  /** A PNG exactly the output size, laid over the whole frame. */
  uri: string;
  /** Seconds from the exported clip's first frame. */
  startSec: number;
  endSec: number;
};

export type ExportSong = {
  /** A local audio file. */
  uri: string;
  /** Where in the song it starts; the part repeats if the clip is longer. */
  startSec: number;
  /** 0..1 */
  volume: number;
};

export type ExportOptions = {
  /** A local file the app can read (never a camera-roll URI). */
  videoUri: string;
  /** Where to write the MP4 (in the cache directory). */
  outputUri: string;
  /** The window of the source that is kept, in seconds. */
  startSec: number;
  endSec: number;
  /** The output frame — even pixels, the same size as every overlay. */
  width: number;
  height: number;
  /** The clip's own sound, 0..1; 0 leaves it out. */
  videoVolume: number;
  song: ExportSong | null;
  overlays: ExportOverlay[];
  /**
   * How the picture fills the frame: 'stretch' (the default) to the frame, whose
   * shape is the clip's own give or take a pixel of rounding; 'contain' fitted inside
   * it and centred, black around it — a horizontal clip saved upright. Only builds
   * where canFitVideo() is true know it; an older one stretches.
   */
  videoFit?: 'stretch' | 'contain';
  /**
   * A colour filter baked into every frame: the 20-number row-major 4×5 matrix that
   * lib/filters `skiaColorMatrix` produces (RGBA rows + a 0..1 bias column) — the SAME
   * matrix the photo filters bake with Skia, so a filtered video matches a filtered
   * photo. Omitted/empty = no filter. Only builds where canFilterVideo() is true read
   * it; an older one ignores it.
   */
  colorMatrix?: number[];
};

export type CaptureOptions = {
  /** findNodeHandle() of a mounted view. */
  viewTag: number;
  /** The PNG's size in pixels; the view is scaled to fill it. */
  width: number;
  height: number;
  outputUri: string;
};

declare class LaybellVideoExportModule extends NativeModule {
  getVideoInfo(uri: string): Promise<VideoInfo>;
  /** Draws a mounted view into a transparent PNG of exactly width × height pixels. */
  captureView(options: CaptureOptions): Promise<string>;
  /** Resolves with the written file's URI. */
  exportVideo(options: ExportOptions): Promise<string>;
  /** Present, and true, from the build that knows ExportOptions.videoFit. */
  canFitVideo?: () => boolean;
  /** Present, and true, from the build that can bake a colour filter (ExportOptions.colorMatrix). */
  canFilterVideo?: () => boolean;
  /**
   * Joins recorded clips head to tail into one file (the multi-clip recorder's
   * segments), resolving with its URI. Present only from the build that added it; the
   * segments must share a size and orientation (the recorder keeps them on one camera).
   */
  concatClips?: (uris: string[], outputUri: string) => Promise<string>;
  /**
   * Measures a local clip's audio loudness, for deciding whether a silent/quiet
   * video should get background music added automatically. Present only from the
   * build that added it.
   */
  probeAudio?: (uri: string) => Promise<AudioProbe>;
}

// null on every binary built before the module existed (no OTA on this project).
const native = requireOptionalNativeModule<LaybellVideoExportModule>('LaybellVideoExport');

export function videoExportAvailable(): boolean {
  return native != null;
}

/** Whether this build can fit a clip inside its frame (ExportOptions.videoFit). */
export function videoFitAvailable(): boolean {
  try {
    return typeof native?.canFitVideo === 'function' && native.canFitVideo() === true;
  } catch {
    return false;
  }
}

/** Whether this build can join recorded clips into one (the multi-clip recorder). */
export function videoConcatAvailable(): boolean {
  return typeof native?.concatClips === 'function';
}

/** Whether this build can bake a colour filter into a video (ExportOptions.colorMatrix). */
export function videoFilterAvailable(): boolean {
  try {
    return typeof native?.canFilterVideo === 'function' && native.canFilterVideo() === true;
  } catch {
    return false;
  }
}

/** Whether this build can measure a clip's audio loudness (auto-music). */
export function audioProbeAvailable(): boolean {
  return typeof native?.probeAudio === 'function';
}

/**
 * The loudness of a local video's audio. Returns null when it can't be measured —
 * an older build without the probe, or a decode failure — so callers add nothing
 * rather than guess. The clip must be a readable local file (never a camera-roll
 * ph:// / content:// URI; the composer resolves picks to file:// before this runs).
 */
export async function probeClipAudio(uri: string): Promise<AudioProbe | null> {
  if (typeof native?.probeAudio !== 'function') return null;
  try {
    const r = await native.probeAudio(uri);
    return r ?? null;
  } catch {
    return null;
  }
}

// Below this average RMS a clip reads as quiet enough to lay music over: room tone
// and ambience sit well under it, ordinary talking sits above it. ~-34 dBFS. A
// starting point tuned to err QUIET (music is never forced onto a clip that might be
// speech); adjust after hearing it on real clips.
export const SILENT_RMS = 0.02;

/**
 * Whether a clip reads as SILENT/quiet enough to auto-add music over: no audio track
 * at all, or measured loudness below SILENT_RMS. An unmeasurable clip (null, or
 * rms < 0) is treated as NOT silent, so music is never forced onto a clip we could
 * not actually check.
 */
export function clipIsSilent(probe: AudioProbe | null): boolean {
  if (!probe) return false;
  if (!probe.hasAudioTrack) return true;
  return probe.rms >= 0 && probe.rms < SILENT_RMS;
}

export default native;
