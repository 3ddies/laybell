import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert, useWindowDimensions } from 'react-native';
import { useState } from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { uploadToStorageWithProgress } from '../lib/upload';
import { makeGifFromVideo, type GifResult } from '../lib/makeGif';
import VideoTrimmer from './VideoTrimmer';

// GIF from a video clip: pick a video → drag to choose a short window → render
// the GIF on-device → use it (uploads, then hands back a {url,w,h} attachment).
type Vid = { uri: string; dur: number; w: number; h: number };
const DURATIONS = [1.5, 2.5, 4]; // selectable GIF lengths (seconds)

export default function GifMakerModal({
  visible, userId, onClose, onCreated,
}: {
  visible: boolean;
  userId: string | null;
  onClose: () => void;
  onCreated: (gif: { url: string; w: number; h: number }) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width: SCREEN_W } = useWindowDimensions();

  const [vid, setVid] = useState<Vid | null>(null);
  const [start, setStart] = useState(0);
  const [gifDur, setGifDur] = useState(2.5);
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<GifResult | null>(null);
  const [uploading, setUploading] = useState(false);

  function reset() { setVid(null); setStart(0); setResult(null); setProgress(0); setRendering(false); setUploading(false); }
  function close() { reset(); onClose(); }

  async function pickVideo() {
    const ImagePicker = await import('expo-image-picker');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos, quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    // expo-image-picker reports duration in ms; guard in case a source gives sec.
    const raw = a.duration ?? 0;
    const dur = raw > 300 ? raw / 1000 : raw;
    setResult(null);
    setStart(0);
    setVid({ uri: a.uri, dur: dur || 3, w: a.width || 1, h: a.height || 1 });
  }

  async function render() {
    if (!vid || rendering) return;
    setRendering(true);
    setProgress(0);
    try {
      const gif = await makeGifFromVideo(
        vid.uri,
        { startMs: Math.round(start * 1000), durationMs: Math.round(Math.min(gifDur, vid.dur) * 1000), fps: 8, width: 240 },
        setProgress,
      );
      setResult(gif);
    } catch {
      Alert.alert(t('gif.make.failedTitle'), t('gif.make.failedBody'));
    }
    setRendering(false);
  }

  async function useGif() {
    if (!result || !userId || uploading) return;
    setUploading(true);
    try {
      const url = await uploadToStorageWithProgress('posts', userId, result.uri, 'gif', 'image/gif');
      onCreated({ url, w: result.width, h: result.height });
      close();
    } catch {
      Alert.alert(t('attach.uploadFailed'));
      setUploading(false);
    }
  }

  const maxW = SCREEN_W - SPACING.md * 2;
  const aspect = vid ? vid.w / vid.h : 1;
  let frameW = maxW, frameH = maxW / (aspect || 1);
  if (frameH > 260) { frameH = 260; frameW = 260 * aspect; }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={[styles.container, { paddingTop: insets.top + SPACING.sm }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={26} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('gif.make.title')}</Text>
          <View style={{ width: 26 }} />
        </View>

        {!vid ? (
          <View style={styles.center}>
            <Ionicons name="film-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.hint}>{t('gif.make.hint')}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={pickVideo} activeOpacity={0.85}>
              <Ionicons name="videocam-outline" size={18} color={colors.background} />
              <Text style={styles.primaryBtnText}>{t('gif.make.pick')}</Text>
            </TouchableOpacity>
          </View>
        ) : result ? (
          <View style={styles.center}>
            <Image source={{ uri: result.uri }} style={{ width: Math.min(maxW, 280), height: Math.min(maxW, 280) / ((result.width / result.height) || 1), borderRadius: RADIUS.lg, backgroundColor: colors.surfaceLight }} contentFit="cover" />
            <View style={styles.resultRow}>
              <TouchableOpacity style={styles.secondaryBtn} onPress={() => setResult(null)} activeOpacity={0.85} disabled={uploading}>
                <Text style={styles.secondaryBtnText}>{t('gif.make.redo')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryBtn, styles.flex1]} onPress={useGif} activeOpacity={0.85} disabled={uploading}>
                {uploading ? <ActivityIndicator color={colors.background} size="small" /> : <Text style={styles.primaryBtnText}>{t('gif.make.use')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.trimWrap}>
            <VideoTrimmer
              uri={vid.uri}
              duration={vid.dur}
              windowSec={Math.min(gifDur, vid.dur)}
              frameW={frameW}
              frameH={frameH}
              onChange={setStart}
              initialStart={start}
            />
            <View style={styles.durRow}>
              {DURATIONS.map((d) => {
                const active = gifDur === d;
                const disabled = d > vid.dur + 0.05;
                return (
                  <TouchableOpacity
                    key={d}
                    style={[styles.durChip, active && styles.durChipActive, disabled && styles.durChipDisabled]}
                    onPress={() => !disabled && setGifDur(d)}
                    activeOpacity={0.85}
                    disabled={disabled}
                  >
                    <Text style={[styles.durChipText, active && styles.durChipTextActive]}>{d}s</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={[styles.primaryBtn, styles.createBtn]} onPress={render} activeOpacity={0.85} disabled={rendering}>
              {rendering
                ? <><ActivityIndicator color={colors.background} size="small" /><Text style={styles.primaryBtnText}>{t('gif.make.rendering', { pct: Math.round(progress * 100) })}</Text></>
                : <><Ionicons name="sparkles-outline" size={18} color={colors.background} /><Text style={styles.primaryBtnText}>{t('gif.make.create')}</Text></>}
            </TouchableOpacity>
            <TouchableOpacity onPress={pickVideo} disabled={rendering}>
              <Text style={styles.changeVideo}>{t('gif.make.changeVideo')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md, padding: SPACING.xl },
  hint: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },
  trimWrap: { flex: 1, paddingTop: SPACING.lg, gap: SPACING.lg },
  durRow: { flexDirection: 'row', justifyContent: 'center', gap: SPACING.sm },
  durChip: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  durChipActive: { backgroundColor: colors.text, borderColor: colors.text },
  durChipDisabled: { opacity: 0.35 },
  durChipText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  durChipTextActive: { color: colors.background },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: colors.text, borderRadius: RADIUS.full, paddingVertical: SPACING.md, paddingHorizontal: SPACING.lg,
  },
  primaryBtnText: { color: colors.background, fontSize: 15, fontWeight: '800' },
  createBtn: { marginHorizontal: SPACING.md },
  changeVideo: { color: colors.primary, fontSize: 14, fontWeight: '700', textAlign: 'center', paddingVertical: SPACING.sm },
  resultRow: { flexDirection: 'row', gap: SPACING.sm, alignSelf: 'stretch', paddingHorizontal: SPACING.xl },
  flex1: { flex: 1 },
  secondaryBtn: { borderRadius: RADIUS.full, paddingVertical: SPACING.md, paddingHorizontal: SPACING.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryBtnText: { color: colors.text, fontSize: 15, fontWeight: '700' },
});
