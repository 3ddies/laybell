import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, ActivityIndicator,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Cover picker for a video post (post-time only): grab any frame from the
// video via a generated frame strip, or use an image from the camera roll.
// Returns a LOCAL uri — the composer uploads it exactly like the auto-grabbed
// frame it replaces, so publish needs no changes.
//
// Frames are decoded ONE AT A TIME at low quality (8 parallel high-quality
// decodes was what made this "never load" on real clips), appear as each one
// lands, and are cached per-video so reopening is instant.

const FRAME_COUNT = 6;

// Survives modal close/reopen and switching between video posts, so reopening
// the cover picker is instant. Tiny (a handful of low-res frames per clip);
// capped so a long session can't grow it without bound.
const frameCache = new Map<string, string[]>();
const CACHE_MAX = 8;
function cacheFrames(uri: string, frames: string[]) {
  frameCache.set(uri, frames);
  if (frameCache.size > CACHE_MAX) {
    const oldest = frameCache.keys().next().value;
    if (oldest !== undefined) frameCache.delete(oldest);
  }
}

export default function ThumbnailPickerModal({ visible, videoUri, durationSec, currentUri, onPick, onClose }: {
  visible: boolean;
  videoUri: string | null;
  /** Video length in seconds; 0/unknown falls back to safe early frame times. */
  durationSec: number;
  /** The cover currently in effect (auto frame or a previous custom pick). */
  currentUri: string | null;
  onPick: (uri: string) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [frames, setFrames] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!visible || !videoUri) return;
    setSelected(currentUri);

    // Cache hit — reuse instantly, no decoding.
    const cached = frameCache.get(videoUri);
    if (cached) {
      setFrames(cached);
      setGenerating(false);
      if (!currentUri && cached[0]) setSelected(cached[0]);
      return;
    }

    let cancelled = false;
    setFrames([]);
    setGenerating(true);

    (async () => {
      const out: string[] = [];
      const durMs = durationSec > 0 ? durationSec * 1000 : 0;
      // Spread the frame times across the clip, kept safely inside its bounds
      // (a time past the end fails to decode). Unknown duration → early times
      // we know exist, bailing as soon as one runs off the end.
      const times = durMs > 0
        ? Array.from({ length: FRAME_COUNT }, (_, i) =>
            Math.min(durMs - 40, Math.round(((i + 0.5) / FRAME_COUNT) * durMs)))
        : Array.from({ length: FRAME_COUNT }, (_, i) => i * 400);

      for (const time of times) {
        if (cancelled) return;
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
            time: Math.max(0, time), quality: 0.4,
          });
          if (cancelled) return;
          out.push(uri);
          setFrames([...out]);
          // Seed the big preview with the first real frame if we had nothing,
          // so it never sits on a permanent spinner.
          setSelected((s) => s ?? uri);
        } catch {
          // Unknown-duration clip: a miss means we've reached the end, and
          // every later (larger) time only fails worse — stop here.
          if (durMs === 0) break;
        }
      }
      if (!cancelled) {
        setGenerating(false);
        if (out.length) cacheFrames(videoUri, out);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, videoUri]);

  async function pickFromLibrary() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 0.9,
    });
    if (!res.canceled && res.assets[0]) setSelected(res.assets[0].uri);
  }

  const showStrip = generating || frames.length > 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }]}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('thumb.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Big preview of the current pick */}
          <View style={styles.previewWrap}>
            {selected ? (
              <ExpoImage source={{ uri: selected }} style={styles.preview} contentFit="cover" />
            ) : (
              <View style={[styles.preview, styles.previewEmpty]}>
                {generating
                  ? <ActivityIndicator color={colors.textTertiary} />
                  : <Ionicons name="film-outline" size={30} color={colors.textTertiary} />}
              </View>
            )}
          </View>

          {/* Frame strip from the video (each tile appears as it decodes) */}
          {showStrip && (
            <>
              <Text style={styles.sectionLabel}>{t('thumb.chooseFrame')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripRow}>
                {frames.map((f) => (
                  <TouchableOpacity
                    key={f}
                    style={[styles.frame, f === selected && styles.frameSelected]}
                    onPress={() => setSelected(f)}
                    activeOpacity={0.8}
                  >
                    <ExpoImage source={{ uri: f }} style={styles.frameImg} contentFit="cover" />
                  </TouchableOpacity>
                ))}
                {generating && (
                  <View style={[styles.frame, styles.frameImg, styles.frameLoading]}>
                    <ActivityIndicator size="small" color={colors.textTertiary} />
                  </View>
                )}
              </ScrollView>
            </>
          )}

          {/* Camera roll alternative */}
          <TouchableOpacity style={styles.libraryBtn} onPress={pickFromLibrary} activeOpacity={0.8}>
            <Ionicons name="images-outline" size={17} color={colors.text} />
            <Text style={styles.libraryText}>{t('thumb.fromLibrary')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.useBtn, !selected && { opacity: 0.5 }]}
            disabled={!selected}
            onPress={() => { if (selected) onPick(selected); }}
            activeOpacity={0.85}
          >
            <Text style={styles.useText}>{t('thumb.use')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, gap: SPACING.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: c.text, fontSize: 16, fontWeight: '800' },
  previewWrap: { alignItems: 'center' },
  preview: { width: 168, height: 168, borderRadius: RADIUS.md, backgroundColor: c.surfaceLight },
  previewEmpty: { alignItems: 'center', justifyContent: 'center' },
  sectionLabel: {
    color: c.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 2,
  },
  stripRow: { gap: 8, paddingVertical: 2 },
  frame: { borderRadius: RADIUS.sm, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  frameSelected: { borderColor: c.primary },
  frameImg: { width: 56, height: 56, backgroundColor: c.surfaceLight },
  frameLoading: { alignItems: 'center', justifyContent: 'center' },
  libraryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 3, marginTop: 2,
  },
  libraryText: { color: c.text, fontSize: 14, fontWeight: '600' },
  useBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.md,
  },
  useText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});
