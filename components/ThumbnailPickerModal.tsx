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

const FRAME_COUNT = 8;

export default function ThumbnailPickerModal({ visible, videoUri, durationSec, currentUri, onPick, onClose }: {
  visible: boolean;
  videoUri: string | null;
  /** Video length in seconds; 0/unknown falls back to 1s-spaced frames. */
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

  const [frames, setFrames] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Frames are generated once per video; reopening the picker reuses them.
  const framesForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSelected(currentUri);
    if (!videoUri || framesForRef.current === videoUri) return;
    framesForRef.current = videoUri;
    setFrames(Array.from({ length: FRAME_COUNT }, () => null));
    // Frame times spread across the clip (centered per slot); unknown duration
    // falls back to one frame per second from the start.
    const durMs = durationSec > 0 ? durationSec * 1000 : 0;
    const times = Array.from({ length: FRAME_COUNT }, (_, i) =>
      durMs > 0 ? Math.round(((i + 0.5) / FRAME_COUNT) * durMs) : i * 1000,
    );
    times.forEach((time, i) => {
      VideoThumbnails.getThumbnailAsync(videoUri, { time, quality: 0.8 })
        .then(({ uri }) => setFrames((prev) => {
          if (framesForRef.current !== videoUri) return prev; // a newer video took over
          const next = [...prev];
          next[i] = uri;
          return next;
        }))
        .catch(() => { /* frame beyond the end / decode miss — slot stays empty */ });
    });
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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }]}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('thumb.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Big preview of the current pick */}
          <View style={styles.previewWrap}>
            {selected ? (
              <ExpoImage source={{ uri: selected }} style={styles.preview} contentFit="cover" />
            ) : (
              <View style={[styles.preview, styles.previewEmpty]}>
                <ActivityIndicator color={colors.textTertiary} />
              </View>
            )}
          </View>

          {/* Frame strip from the video */}
          <Text style={styles.sectionLabel}>{t('thumb.chooseFrame')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripRow}>
            {frames.map((f, i) => (
              <TouchableOpacity
                key={i}
                style={[styles.frame, !!f && f === selected && styles.frameSelected]}
                onPress={() => { if (f) setSelected(f); }}
                activeOpacity={0.8}
              >
                {f ? (
                  <ExpoImage source={{ uri: f }} style={styles.frameImg} contentFit="cover" />
                ) : (
                  <View style={[styles.frameImg, styles.frameLoading]}>
                    <ActivityIndicator size="small" color={colors.textTertiary} />
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>

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
