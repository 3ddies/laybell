// Phone RTMP broadcasting — DISABLED, and the native engine has been REMOVED
// from the build. This file is the scaffolding and the record; it deliberately
// still exports the same three things so app/live/go-live.tsx needs no changes,
// and so re-enabling later is a small, well-understood diff.
//
// WHAT THIS WAS FOR. Chromecast can only play HLS, and Cloudflare's WebRTC beta
// cannot turn WHIP ingest into HLS (lib/cast.liveHlsUrl). So HORIZONTAL phone
// go-lives — the TV-bound kind — published RTMPS through
// @api.video/react-native-livestream (StreamPack on Android / HaishinKit on
// iOS). Cloudflare then served live HLS, which made the broadcast castable to
// real TVs, playable by feed viewers through the existing AppVideo path, and
// recorded as a VOD. Vertical phone lives always used WHIP (sub-second,
// feed-only) and still do.
//
// WHY IT IS GONE. Three reasons, and each one alone was probably enough:
//
//  1. It never worked on iOS. The native view hard-crashed the app when a
//     horizontal phone go-live started (reproduced on a real device; NOT the
//     rotation race — delaying the view mount changed nothing). RTMP_LIVE_ENABLED
//     was set to false to fall back to WHIP, and it shipped that way in 1.0.0
//     build 4. So removing the library changes NO shipped behaviour: the path it
//     served has been unreachable the whole time.
//
//  2. It was the only thing failing Google Play's 16 KB page-size requirement.
//     Of the 40 native libraries in the build-4 AAB, 39 were aligned to 16384
//     and exactly one — librtmpdroid.so, from video.api:rtmpdroid:1.2.1-packed —
//     was still at 4096, on both arm64-v8a and x86_64. Play warned at submission
//     and let us proceed; that will not last.
//
//  3. There was no upstream fix to wait for. rtmpdroid's last release was
//     1.2.1 in JANUARY 2024, android-live-stream's was 1.4.3 in October 2024,
//     and @api.video/react-native-livestream was already on its newest version
//     (2.0.2). Nothing was coming.
//
// It also cost an iOS build workaround: plugins/withHaishinKitSwiftFix.js forced
// SWIFT_OPTIMIZATION_LEVEL=-Onone on the HaishinKit pod, because the Swift 6.2
// optimizer ITSELF crashed compiling it (SILFunctionTransform "CopyPropagation"
// on AudioNode.swift:137). That plugin went with the library. If HaishinKit ever
// comes back, that crash probably comes back with it — see the plugin's own
// commit for the full diagnosis.
//
// TO RE-ENABLE: reinstall @api.video/react-native-livestream, restore the
// require in getRtmpView, flip RTMP_LIVE_ENABLED, and expect to re-solve both
// the iOS crash and the 16 KB alignment. Check whether rtmpdroid has shipped
// anything since January 2024 first — if it has not, the alignment problem is
// still there and is still yours.
//
// What still works without it: the 'rtmp' mode in go-live.tsx, where the host
// broadcasts from an EXTERNAL encoder (OBS and friends). That path only hands
// out a stream key and polls for the encoder to connect — it never touched this
// native engine.

import type { ComponentType } from 'react';

/** Imperative handle exposed by ApiVideoLiveStreamView (mirrors the lib's types). */
export type RtmpPublisherHandle = {
  startStreaming: (streamKey: string, url?: string) => Promise<boolean>;
  stopStreaming: () => void;
  setZoomRatio: (zoomRatio: number) => void;
};

// The native engine is not in the build. Callers fall back to WHIP, which is
// exactly what they have done since build 4.
export function rtmpAvailable(): boolean {
  return false;
}

/** The camera-preview + publisher component. Always null: the library is removed. */
export function getRtmpView(): ComponentType<any> | null {
  return null;
}
