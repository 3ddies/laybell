import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, Dimensions, Image, ActivityIndicator } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const SCREEN_W = Dimensions.get('window').width;
const STRIP_COUNT = 6;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Drag a fixed-length window across a longer video to choose which segment to
// post. Frames are shown via expo-video-thumbnails (a filmstrip + a preview of
// the window start) — expo-av's <Video> renders black for media-library files,
// so we use still images instead.
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
  const winW = Math.max(40, (win / duration) * trackW);
  const maxX = trackW - winW;

  const [strip, setStrip] = useState<(string | null)[]>(Array(STRIP_COUNT).fill(null));
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [startX, setStartX] = useState(0);
  const startXRef = useRef(0);
  const grabX = useRef(0);
  const lastGen = useRef(0);

  const startSec = (startX / trackW) * duration;

  async function genThumb(sec: number, quality = 0.5): Promise<string | null> {
    try {
      const r = await VideoThumbnails.getThumbnailAsync(uri, { time: Math.max(0, Math.floor(sec * 1000)), quality });
      return r.uri;
    } catch {
      return null;
    }
  }

  // Build the filmstrip + initial preview.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const first = await genThumb(0, 0.6);
      if (!cancelled && first) setPreviewUri(first);
      for (let i = 0; i < STRIP_COUNT; i++) {
        const t = (i / (STRIP_COUNT - 1)) * Math.max(0, duration - 0.1);
        const u = await genThumb(t, 0.4);
        if (cancelled) return;
        setStrip((prev) => { const n = [...prev]; n[i] = u ?? prev[i]; return n; });
      }
    })();
    return () => { cancelled = true; };
  }, [uri, duration]);

  const setStartFromX = (x: number) => {
    const nx = Math.min(Math.max(x, 0), maxX);
    startXRef.current = nx;
    setStartX(nx);
    onChange((nx / trackW) * duration);
  };

  const refreshPreview = async () => {
    const s = (startXRef.current / trackW) * duration;
    const id = ++lastGen.current;
    const u = await genThumb(s, 0.6);
    if (u && id === lastGen.current) setPreviewUri(u);
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabX.current = startXRef.current; },
    onPanResponderMove: (_e, g) => setStartFromX(grabX.current + g.dx),
    onPanResponderRelease: () => { refreshPreview(); },
  })).current;

  return (
    <View style={styles.wrap}>
      <View style={[styles.previewBox, { width: frameW, height: frameH }]}>
        {previewUri
          ? <Image source={{ uri: previewUri }} style={{ width: frameW, height: frameH }} resizeMode="cover" />
          : <ActivityIndicator color={COLORS.primary} />}
      </View>

      <View style={[styles.track, { width: trackW }]}>
        <View style={styles.strip}>
          {strip.map((u, i) => (
            u
              ? <Image key={i} source={{ uri: u }} style={{ width: trackW / STRIP_COUNT, height: '100%' }} resizeMode="cover" />
              : <View key={i} style={{ width: trackW / STRIP_COUNT, height: '100%', backgroundColor: COLORS.surfaceElevated }} />
          ))}
        </View>
        {/* dim the parts outside the window */}
        <View style={[styles.dim, { left: 0, width: startX }]} pointerEvents="none" />
        <View style={[styles.dim, { left: startX + winW, right: 0 }]} pointerEvents="none" />
        {/* draggable window */}
        <View style={[styles.window, { width: winW, left: startX }]} {...pan.panHandlers}>
          <View style={styles.handle}><Ionicons name="chevron-back" size={14} color={COLORS.text} /></View>
          <View style={styles.handle}><Ionicons name="chevron-forward" size={14} color={COLORS.text} /></View>
        </View>
      </View>

      <Text style={styles.label}>{fmt(startSec)} – {fmt(startSec + win)} · {Math.round(win)}s</Text>
      <Text style={styles.hint}>Drag to choose your {Math.round(windowSec)}s window</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: SPACING.sm },
  previewBox: { backgroundColor: '#000', borderRadius: RADIUS.md, overflow: 'hidden', alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  track: { height: 56, borderRadius: RADIUS.sm, overflow: 'hidden', justifyContent: 'center', marginTop: SPACING.sm },
  strip: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  dim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  window: {
    position: 'absolute', top: 0, bottom: 0,
    borderRadius: RADIUS.sm, borderWidth: 2, borderColor: COLORS.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  handle: {
    width: 18, height: '100%', backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  label: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  hint: { color: COLORS.textTertiary, fontSize: 12 },
});
