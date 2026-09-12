import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, findNodeHandle } from 'react-native';
import { PlacedStickers } from './StickerLayer';
import PlacedBandStickers from './BandStickers';
import VideoExport from '../modules/laybell-video-export';
import { exportBandZone } from '../lib/bandCaptions';
import { registerFrameRenderer, type FrameJob } from '../lib/videoExport';

// Draws a finished video's caption images for the native exporter (lib/videoExport),
// from the SAME renderers the reel viewer uses, so a saved video's captions look
// exactly like the app's.
//
// Mounted once at the root, UNDER the navigator: the screens cover it, so nothing
// shows, while the view is laid out and drawable.
//
// A vertical clip's captions: the stage is placed so its screen-sized part sits
// exactly on the real screen — the captions are drawn where the display is, and only
// the empty margins of a frame wider than the screen fall outside it. Captured once
// the stage is laid out.
//
// A horizontal clip's band captions (job.bands): the stage IS the saved upright
// frame, at the screen's width, and the captions are fitted into its bands
// (lib/bandCaptions exportBandZone). Captured once every caption has been measured
// and placed — the stage's own layout comes before that.
//
// One image at a time: mount the job, wait until it's ready and two frames more,
// capture, unmount, resolve. Every image is a fresh mount (the key): the next request
// arrives before the last one's unmount has rendered, so the two share a render — and
// a view kept in place at the same layout never reports a layout again, so it never
// captures.

type Pending = { job: FrameJob; resolve: (uri: string) => void; reject: (e: unknown) => void };

export default function CaptionCaptureHost() {
  const [job, setJob] = useState<FrameJob | null>(null);
  const stage = useRef<View>(null);
  const pending = useRef<Pending | null>(null);
  // The request a capture is already under way for: a second trigger (a caption
  // measured again) never captures it twice.
  const capturing = useRef<Pending | null>(null);

  // eslint-disable-next-line no-console
  useEffect(() => { if (__DEV__) console.log(`[save-video] native exporter in this build: ${VideoExport ? 'yes' : 'NO'}`); }, []);

  useEffect(() => registerFrameRenderer((next) => new Promise<string>((resolve, reject) => {
    // A request still waiting (the exporter awaits each one, but gives up on one that
    // takes too long) is failed rather than left hanging.
    pending.current?.reject(new Error('superseded'));
    pending.current = { job: next, resolve, reject };
    setJob(next);
  })), []);

  const capture = useCallback(() => {
    const p = pending.current;
    if (!p || capturing.current === p) return;
    capturing.current = p;
    // Only the request still waiting is cleared: a late result for one superseded
    // meanwhile must not clear the next.
    const finish = (run: () => void) => {
      if (pending.current === p) { pending.current = null; setJob(null); }
      run();
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pending.current !== p) return;
      const tag = findNodeHandle(stage.current);
      if (tag == null || !VideoExport) { finish(() => p.reject(new Error('caption stage unavailable'))); return; }
      VideoExport.captureView({ viewTag: tag, width: p.job.width, height: p.job.height, outputUri: p.job.outputUri })
        .then((uri) => finish(() => p.resolve(uri)), (e) => finish(() => p.reject(e)));
    }));
  }, []);

  if (!job) return null;

  if (job.bands) {
    const { ratio } = job.bands;
    const { width, height } = job.screen;
    return (
      <View
        key={job.outputUri}
        ref={stage}
        collapsable={false}
        pointerEvents="none"
        style={[styles.stage, { left: 0, top: 0, width, height }]}
      >
        <PlacedBandStickers
          stickers={job.stickers}
          ratio={ratio}
          screenW={width}
          screenH={height}
          zoneOf={(band) => exportBandZone(band, ratio, width, height)}
          onLaidOut={capture}
        />
      </View>
    );
  }

  // Output pixels per point, from where the screen sits in the frame.
  const pxPerPt = job.rect.width / job.screen.width;
  return (
    <View
      key={job.outputUri}
      ref={stage}
      collapsable={false}
      pointerEvents="none"
      onLayout={capture}
      style={[
        styles.stage,
        {
          left: -job.rect.x / pxPerPt,
          top: -job.rect.y / pxPerPt,
          width: job.width / pxPerPt,
          height: job.height / pxPerPt,
        },
      ]}
    >
      <View style={{ position: 'absolute', left: job.rect.x / pxPerPt, top: job.rect.y / pxPerPt, width: job.screen.width, height: job.screen.height }}>
        <PlacedStickers stickers={job.stickers} frameW={job.screen.width} frameH={job.screen.height} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { position: 'absolute' },
});
