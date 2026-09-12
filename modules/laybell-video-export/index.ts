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

export default native;
