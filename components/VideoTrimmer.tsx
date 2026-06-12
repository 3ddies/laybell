import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, Dimensions, Image } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

const SCREEN_W = Dimensions.get('window').width;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Drag a fixed-length window across a longer video to choose which segment to
// post. The poster (ph:// via expo-image) shows instantly so the box is never
// black; a single low-quality frame at the window start is generated on top when
// possible (expo-av <Video> renders black for local files, so we avoid it).
export default function VideoTrimmer({ uri, posterUri, duration, windowSec, frameW, frameH, onChange }: {
  uri: string;
  posterUri?: string;
  duration: number;
  windowSec: number;
  frameW: number;
  frameH: number;
  onChange: (start: number) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const win = Math.min(windowSec, duration);
  const trackW = SCREEN_W - SPACING.md * 2;
  const winW = Math.max(40, (win / duration) * trackW);
  const maxX = trackW - winW;

  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [startX, setStartX] = useState(0);
  const startXRef = useRef(0);
  const grabX = useRef(0);
  const genId = useRef(0);

  const startSec = (startX / trackW) * duration;

  async function genFrame(sec: number) {
    const id = ++genId.current;
    try {
      const r = await VideoThumbnails.getThumbnailAsync(uri, { time: Math.max(0, Math.floor(sec * 1000)), quality: 0.3 });
      if (id === genId.current) setFrameUri(r.uri);
    } catch {
      // keep the poster underneath
    }
  }

  useEffect(() => { genFrame(0); }, [uri]);

  const setStartFromX = (x: number) => {
    const nx = Math.min(Math.max(x, 0), maxX);
    startXRef.current = nx;
    setStartX(nx);
    onChange((nx / trackW) * duration);
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabX.current = startXRef.current; },
    onPanResponderMove: (_e, g) => setStartFromX(grabX.current + g.dx),
    onPanResponderRelease: () => { genFrame((startXRef.current / trackW) * duration); },
  })).current;

  return (
    <View style={styles.wrap}>
      <View style={[styles.previewBox, { width: frameW, height: frameH }]}>
        {posterUri ? (
          <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : null}
        {frameUri ? (
          <Image source={{ uri: frameUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : null}
      </View>

      <View style={[styles.track, { width: trackW }]}>
        <View style={[styles.dim, { left: 0, width: startX }]} pointerEvents="none" />
        <View style={[styles.dim, { left: startX + winW, right: 0 }]} pointerEvents="none" />
        <View style={[styles.window, { width: winW, left: startX }]} {...pan.panHandlers}>
          <View style={styles.handle}><Ionicons name="chevron-back" size={14} color={colors.text} /></View>
          <View style={styles.handle}><Ionicons name="chevron-forward" size={14} color={colors.text} /></View>
        </View>
      </View>

      <Text style={styles.label}>{fmt(startSec)} – {fmt(startSec + win)} · {Math.round(win)}s</Text>
      <Text style={styles.hint}>Drag to choose your {Math.round(windowSec)}s window</Text>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { alignItems: 'center', gap: SPACING.sm },
  previewBox: { backgroundColor: '#000', borderRadius: RADIUS.md, overflow: 'hidden', alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  track: {
    height: 52, borderRadius: RADIUS.sm, overflow: 'hidden', justifyContent: 'center',
    marginTop: SPACING.sm, backgroundColor: colors.surfaceElevated, width: '100%',
  },
  dim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  window: {
    position: 'absolute', top: 0, bottom: 0,
    borderRadius: RADIUS.sm, borderWidth: 2, borderColor: colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  handle: { width: 18, height: '100%', backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.text, fontSize: 13, fontWeight: '700' },
  hint: { color: colors.textTertiary, fontSize: 12 },
});
