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

declare class LaybellSubjectLiftModule extends NativeModule {
  /** True when this device/OS can actually lift subjects (iOS 17+; Android via ML Kit). */
  isSupported(): boolean;
  /**
   * Cut the main subject(s) out of the image at `uri` into a transparent PNG written to
   * `outputUri`. Resolves with the PNG's file:// uri, or null when nothing could be cut
   * out (no clear subject) or the OS is too old.
   */
  liftSubject(uri: string, outputUri: string): Promise<string | null>;
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
export async function liftSubject(uri: string, outputUri: string): Promise<string | null> {
  if (!native) return null;
  try {
    const out = await native.liftSubject(uri, outputUri);
    return out ?? null;
  } catch {
    return null;
  }
}

export default native;
