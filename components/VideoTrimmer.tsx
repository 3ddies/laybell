import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, Dimensions, Image } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

const SCREEN_W = Dimensions.get('window').width;
// Frames sampled across the whole clip to build the scrubber's filmstrip. Eight
// is the sweet spot at phone widths (~45px each): enough to recognise scenes,
// few enough that generating them doesn't stall the composer.
const STRIP_COUNT = 8;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Drag a fixed-length window across a longer video to choose which segment to
// post. The poster (ph:// via expo-image) shows instantly so the box is never
// black; a single low-quality frame at the window start is generated on top when
// possible (expo-av <Video> renders black for local files, so we avoid it).
export default function VideoTrimmer({ uri, posterUri, duration, windowSec, frameW, frameH, onChange, initialStart = 0 }: {
  uri: string;
  posterUri?: string;
  duration: number;
  windowSec: number;
  frameW: number;
  frameH: number;
  onChange: (start: number) => void;
  // Seconds to open the window at — used when re-entering trim for a resumed
  // draft so the saved 3-min selection is shown (and kept) instead of 0.
  initialStart?: number;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const win = Math.min(windowSec, duration);
  const trackW = SCREEN_W - SPACING.md * 2;
  const winW = Math.max(40, (win / duration) * trackW);
  const maxX = trackW - winW;

  const initX = Math.min(Math.max((initialStart / duration) * trackW, 0), maxX);
  const [frameUri, setFrameUri] = useState<string | null>(null);
  // Filmstrip behind the track. Without it the scrubber is a featureless grey
  // bar, so there is no way to tell WHERE in the clip the window sits — you can
  // read the timestamps but not see the content you're selecting.
  const [strip, setStrip] = useState<(string | null)[]>(() => new Array(STRIP_COUNT).fill(null));
  const [startX, setStartX] = useState(initX);
  const startXRef = useRef(initX);
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

  useEffect(() => { genFrame((startXRef.current / trackW) * duration); }, [uri]);

  // Build the filmstrip. SEQUENTIAL on purpose: eight concurrent native decodes
  // spike memory on a long 4K clip and can stutter the composer as it opens.
  // Each frame is committed as it lands, so the strip fills in left-to-right
  // instead of appearing all at once after a pause.
  useEffect(() => {
    if (!uri || !(duration > 0)) return;
    let cancelled = false;
    setStrip(new Array(STRIP_COUNT).fill(null));
    (async () => {
      for (let i = 0; i < STRIP_COUNT; i++) {
        if (cancelled) return;
        // Sample the CENTRE of each slot, so the strip represents the whole clip
        // rather than being offset by half a slot toward the start.
        const sec = ((i + 0.5) / STRIP_COUNT) * duration;
        try {
          const r = await VideoThumbnails.getThumbnailAsync(uri, {
            time: Math.max(0, Math.floor(sec * 1000)),
            quality: 0.2, // thumbnails are ~45px wide on screen
          });
          if (cancelled) return;
          setStrip((prev) => { const next = [...prev]; next[i] = r.uri; return next; });
        } catch {
          // Leave that slot grey — a missing frame must never break the strip.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [uri, duration]);

  const setStartFromX = (x: number) => {
    const nx = Math.min(Math.max(x, 0), maxX);
    startXRef.current = nx;
    setStartX(nx);
    // Deliberately NO onChange here: it re-rendered the ENTIRE ~1800-line
    // composer screen on every drag frame (trimStart is top-level post.tsx
    // state that nothing renders live) — a literal "slider lags" reproducer.
    // The trim window itself still tracks the finger 1:1 via local state.
  };
  const commitTrim = () => onChange((startXRef.current / trackW) * duration);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { grabX.current = startXRef.current; },
    onPanResponderMove: (_e, g) => setStartFromX(grabX.current + g.dx),
    // Commit the trim once per gesture (release AND terminate — a responder
    // steal mid-drag must still land the window where the finger left it).
    onPanResponderRelease: () => { commitTrim(); genFrame((startXRef.current / trackW) * duration); },
    onPanResponderTerminate: () => { commitTrim(); genFrame((startXRef.current / trackW) * duration); },
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
        {/* Filmstrip first so the dim overlays and the window draw on top of it. */}
        <View style={styles.strip} pointerEvents="none">
          {strip.map((u, i) => (
            <View key={i} style={styles.stripCell}>
              {u ? <Image source={{ uri: u }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
            </View>
          ))}
        </View>
        <View style={[styles.dim, { left: 0, width: startX }]} pointerEvents="none" />
        <View style={[styles.dim, { left: startX + winW, right: 0 }]} pointerEvents="none" />
        <View style={[styles.window, { width: winW, left: startX }]} {...pan.panHandlers}>
          <View style={styles.handle}><Ionicons name="chevron-back" size={14} color={colors.text} /></View>
          <View style={styles.handle}><Ionicons name="chevron-forward" size={14} color={colors.text} /></View>
        </View>
      </View>

      <Text style={styles.label}>{fmt(startSec)} – {fmt(startSec + win)} · {Math.round(win)}s</Text>
      <Text style={styles.hint}>{t('videoTrimmer.dragHint', { sec: Math.round(windowSec) })}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { alignItems: 'center', gap: SPACING.sm },
  previewBox: { backgroundColor: colors.background, borderRadius: RADIUS.md, overflow: 'hidden', alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  track: {
    height: 52, borderRadius: RADIUS.sm, overflow: 'hidden', justifyContent: 'center',
    marginTop: SPACING.sm, backgroundColor: colors.surfaceElevated, width: '100%',
  },
  strip: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  stripCell: { flex: 1, overflow: 'hidden' },
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
