import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

// Plays a burst of frames forward-then-backward on a loop — the classic Instagram
// boomerang. All frames are kept mounted (only the current one visible) so there's no
// reload flash as it cycles. Shared by the builder preview, the story editor background,
// the viewer and the thumbnail. active=false holds on the first frame (e.g. thumbnails).
export default function StoryBoomerang({
  frames, frameW, frameH, active = true, fps = 14, radius = 0,
}: {
  frames: string[];
  frameW: number;
  frameH: number;
  active?: boolean;
  fps?: number;
  radius?: number;
}) {
  const [idx, setIdx] = useState(0);
  const dir = useRef(1);

  useEffect(() => {
    if (!active || frames.length < 2) { setIdx(0); dir.current = 1; return; }
    // A cut-short boomerang has only a few frames; played at the full frame rate its tiny
    // forward-back loop whips past frantically. Ease the frame rate down as the clip gets
    // shorter so a trimmed capture reads as a gentle sway rather than a flicker. A full
    // burst (FULL_BURST frames) plays at the requested fps; the rate floors at 4fps so even
    // a 2–3 frame clip still clearly animates.
    const FULL_BURST = 16; // BoomerangCamera FRAME_COUNT — the longest a burst can be
    const effFps = Math.max(4, fps * Math.min(1, frames.length / FULL_BURST));
    const id = setInterval(() => {
      setIdx((i) => {
        let d = dir.current;
        let next = i + d;
        if (next > frames.length - 1) { d = -1; next = frames.length - 2; }
        else if (next < 0) { d = 1; next = 1; }
        dir.current = d;
        return next < 0 ? 0 : next;
      });
    }, Math.max(33, Math.round(1000 / effFps)));
    return () => clearInterval(id);
  }, [active, frames.length, fps]);

  if (!frames.length) return <View style={{ width: frameW, height: frameH, backgroundColor: '#000', borderRadius: radius }} />;

  return (
    <View style={{ width: frameW, height: frameH, backgroundColor: '#000', borderRadius: radius, overflow: 'hidden' }}>
      {frames.map((uri, i) => (
        <ExpoImage
          key={i}
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { opacity: i === idx ? 1 : 0 }]}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ))}
    </View>
  );
}
