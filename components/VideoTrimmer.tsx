import { useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, Dimensions } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const SCREEN_W = Dimensions.get('window').width;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Lets the user drag a fixed-length window across a longer video to choose which
// segment to post. Reports the window start (seconds) via onChange; the preview
// loops the selected window.
export default function VideoTrimmer({ uri, duration, windowSec, frameW, frameH, onChange }: {
  uri: string;
  duration: number;
  windowSec: number;
  frameW: number;
  frameH: number;
  onChange: (start: number) => void;
}) {
  const win = Math.min(windowSec, duration);
  const trackW = SCREEN_W - SPACING.md * 2;
  const winW = Math.max(36, (win / duration) * trackW);
  const maxX = trackW - winW;

  const videoRef = useRef<Video>(null);
  const [startX, setStartX] = useState(0);
  const startXRef = useRef(0);
  const startSecRef = useRef(0);
  const grabX = useRef(0);

  const seek = (sec: number) => { videoRef.current?.setPositionAsync(Math.max(0, sec) * 1000); };

  const setStartFromX = (x: number) => {
    const nx = Math.min(Math.max(x, 0), maxX);
    startXRef.current = nx;
    const s = (nx / trackW) * duration;
    startSecRef.current = s;
    setStartX(nx);
    onChange(s);
    seek(s);
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabX.current = startXRef.current; },
    onPanResponderMove: (_e, g) => setStartFromX(grabX.current + g.dx),
  })).current;

  const startSec = (startX / trackW) * duration;

  return (
    <View style={styles.wrap}>
      <View style={[styles.videoBox, { width: frameW, height: frameH }]}>
        <Video
          ref={videoRef}
          source={{ uri }}
          style={{ width: frameW, height: frameH }}
          resizeMode={ResizeMode.COVER}
          shouldPlay
          isMuted
          onLoad={() => seek(startSecRef.current)}
          onPlaybackStatusUpdate={(st: any) => {
            if (st.isLoaded && st.positionMillis >= (startSecRef.current + win) * 1000) seek(startSecRef.current);
          }}
        />
      </View>

      <View style={[styles.track, { width: trackW }]}>
        <View style={[styles.window, { width: winW, left: startX }]} {...pan.panHandlers}>
          <View style={styles.handle} />
          <View style={styles.handle} />
        </View>
      </View>
      <Text style={styles.label}>{fmt(startSec)} – {fmt(startSec + win)} · {Math.round(win)}s clip</Text>
      <Text style={styles.hint}>Drag to choose your {Math.round(windowSec)}s window</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: SPACING.sm },
  videoBox: { backgroundColor: '#000', borderRadius: RADIUS.md, overflow: 'hidden', alignSelf: 'center' },
  track: {
    height: 48, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceElevated,
    justifyContent: 'center', marginTop: SPACING.sm,
  },
  window: {
    position: 'absolute', top: -2, bottom: -2,
    borderRadius: RADIUS.sm, borderWidth: 2, borderColor: COLORS.primary,
    backgroundColor: COLORS.primary + '22',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  handle: { width: 4, height: 22, borderRadius: 2, backgroundColor: COLORS.primary },
  label: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  hint: { color: COLORS.textTertiary, fontSize: 12 },
});
