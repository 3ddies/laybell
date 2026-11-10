import { NativeModule, requireOptionalNativeModule } from 'expo';

// Laybell's on-device "subject lift" — the Threads-style trick that cuts the main subject
// out of a photo into a transparent PNG you can keep as a sticker. All on-device, so it
// costs nothing per use: iOS 17+ via Vision (VNGenerateForegroundInstanceMaskRequest),
// Android via ML Kit Subject Segmentation.
//
// OPTIONAL on purpose (like laybell-video-export): any binary built before this module
// existed returns null for `native`, and a hard require would crash every screen that
// imports this. Callers check subjectLiftAvailable() and simply don't offer it otherwise.
// No OTA on this project — it only appears after a rebuild.

/** A normalized touch point (0..1, top-left origin) marking which subject to lift. */
export type LiftPoint = { x: number; y: number };

declare class LaybellSubjectLiftModule extends NativeModule {
  /** True when this device/OS can actually lift subjects (iOS 17+; Android via ML Kit). */
  isSupported(): boolean;
  /**
   * Cut a subject out of the image at `uri` into a transparent PNG written to `outputUri`.
   * `pointX`/`pointY` are a normalized (0..1, top-left) touch point: the subject under it
   * is lifted, so different areas give different stickers. Pass -1/-1 to lift the whole
   * foreground. Resolves with the PNG's file:// uri, or null when nothing could be cut out.
   */
  liftSubject(uri: string, outputUri: string, pointX: number, pointY: number): Promise<string | null>;
}

// null on every binary built before the module existed.
const native = requireOptionalNativeModule<LaybellSubjectLiftModule>('LaybellSubjectLift');

/** Whether this build AND device can lift subjects. False → never offer "make a sticker". */
export function subjectLiftAvailable(): boolean {
  if (!native) return false;
  try {
    return typeof native.isSupported === 'function' && native.isSupported() === true;
  } catch {
    return false;
  }
}

/**
 * Lift the subject out of a local image into a transparent PNG at `outputUri`. Returns the
 * written file's uri, or null when there's no subject to cut out, the source can't be read,
 * or the build/device doesn't support it. Never throws — callers fall back gracefully.
 */
export async function liftSubject(uri: string, outputUri: string, point?: LiftPoint): Promise<string | null> {
  if (!native) return null;
  const px = point && point.x >= 0 && point.x <= 1 ? point.x : -1;
  const py = point && point.y >= 0 && point.y <= 1 ? point.y : -1;
  try {
    const out = await native.liftSubject(uri, outputUri, px, py);
    return out ?? null;
  } catch {
    return null;
  }
}

export default native;
