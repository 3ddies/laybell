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

export function rtmpAvailable(): boolean {
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
