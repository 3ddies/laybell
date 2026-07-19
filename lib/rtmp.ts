// Phone RTMP broadcasting — @api.video/react-native-livestream (StreamPack on
// Android / HaishinKit on iOS; ships a Fabric-codegen native component, so it
// matches this app's new-architecture builds).
//
// WHY: Chromecast can only play HLS, and Cloudflare's WebRTC beta cannot turn
// WHIP ingest into HLS (lib/cast.liveHlsUrl). So HORIZONTAL phone go-lives —
// the TV-bound kind — publish RTMPS through this engine instead: Cloudflare
// then serves live HLS, which makes the broadcast castable to real TVs,
// playable by feed viewers through the existing AppVideo path, and recorded
// as a VOD. Vertical phone lives keep WHIP (sub-second, feed-only) — the
// engine also force-fits output to landscape, so it's only used where that's
// the intent.
//
// Guarded like lib/whip.ts: on a binary built before this native lib existed
// the availability probe fails and go-live falls back to the WHIP path for
// horizontal too (phone-only viewing — the pre-rebuild behavior).

import { UIManager } from 'react-native';
import type { ComponentType } from 'react';

/** Imperative handle exposed by ApiVideoLiveStreamView (mirrors the lib's types). */
export type RtmpPublisherHandle = {
  startStreaming: (streamKey: string, url?: string) => Promise<boolean>;
  stopStreaming: () => void;
  setZoomRatio: (zoomRatio: number) => void;
};

// KILL SWITCH — the api.video native view hard-crashes the app on iOS when a
// horizontal phone go-live starts (reproduced on Eddie's device; NOT the
// rotation race — delaying the view mount changed nothing, so it's a native
// incompatibility inside the lib on this new-arch build). While the crash is
// diagnosed from a real crash log, force this OFF so horizontal phone lives fall
// back to WHIP (stable, sub-second, phone-only — the pre-RTMP behavior). Flip to
// true once the native issue is fixed to re-enable TV-castable phone lives.
const RTMP_LIVE_ENABLED = false;

export function rtmpAvailable(): boolean {
  if (!RTMP_LIVE_ENABLED) return false;
  try {
    // The view manager is registered by the native lib on both architectures;
    // a binary without it answers false and callers fall back to WHIP.
    return UIManager.hasViewManagerConfig?.('ApiVideoLiveStreamView') === true;
  } catch {
    return false;
  }
}

/** The camera-preview + publisher component, or null in a binary without the lib. */
export function getRtmpView(): ComponentType<any> | null {
  try {
    if (!rtmpAvailable()) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@api.video/react-native-livestream').ApiVideoLiveStreamView ?? null;
  } catch {
    return null;
  }
}
