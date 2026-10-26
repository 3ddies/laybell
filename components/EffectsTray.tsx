import { useEffect, useState } from 'react';
import { ScrollView, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { STORY_FILTERS, type FilterKey } from '../lib/filters';
import { EFFECT_SAMPLE } from '../lib/sampleImages';
import { bakeFilter } from '../lib/filterSkia';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// The Instagram-style filter chooser: a bottom strip of chips, each the media rendered
// through that filter. RN's `filter` style doesn't apply color effects on iOS, so each chip
// is BAKED with Skia (lib/filterSkia) — the real look. In the editor the source is the user's own
// media; on the live camera (no capture yet) it's a label-matched sample per effect, baked
// so the chip still shows what the filter does. Purely presentational.
export default function EffectsTray({
  mediaUri, activeKey, onSelect, onClose, bottomInset = 0,
}: {
  mediaUri: string | null;
  activeKey: FilterKey;
  onSelect: (key: FilterKey) => void;
  onClose: () => void;
  bottomInset?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  // Bake a small filtered thumbnail per effect (sequential, so the JS thread stays free).
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    setThumbs({});
    (async () => {
      for (const f of STORY_FILTERS) {
        if (f.key === 'original') continue;
        const src = mediaUri ?? EFFECT_SAMPLE[f.key];
        const baked = await bakeFilter(src, f.key, 180).catch(() => null);
        if (!alive) return;
        if (baked && baked !== src) setThumbs((prev) => ({ ...prev, [f.key]: baked }));
      }
    })();
    return () => { alive = false; };
  }, [mediaUri]);

  return (
    <View style={[styles.wrap, { paddingBottom: bottomInset + SPACING.sm }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('storyCamera.effects')}</Text>
        <TouchableOpacity style={styles.done} onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.done')}>
          <Ionicons name="checkmark" size={20} color="#111" />
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {STORY_FILTERS.map((f) => {
          const active = f.key === activeKey;
          // Baked thumbnail once ready; the unfiltered source meanwhile (no blank flash).
          const src = f.key === 'original'
            ? (mediaUri ?? EFFECT_SAMPLE.original)
            : (thumbs[f.key] ?? mediaUri ?? EFFECT_SAMPLE[f.key]);
          return (
            <TouchableOpacity key={f.key} style={styles.chip} onPress={() => onSelect(f.key)} activeOpacity={0.85} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={f.name}>
              <View style={[styles.thumb, active && styles.thumbActive]}>
                <ExpoImage source={{ uri: src }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={120} />
              </View>
              <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>{f.name}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const CHIP = 62;

const makeStyles = (_colors: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', paddingTop: SPACING.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg, marginBottom: SPACING.sm },
  title: { color: '#fff', fontSize: 15, fontWeight: '800' },
  done: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  row: { paddingHorizontal: SPACING.md, gap: SPACING.sm + 2 },
  chip: { width: CHIP + 8, alignItems: 'center', gap: 5 },
  thumb: { width: CHIP, height: CHIP, borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: '#000', borderWidth: 2, borderColor: 'transparent' },
  thumbActive: { borderColor: '#fff' },
  name: { color: 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' },
  nameActive: { color: '#fff', fontWeight: '800' },
});
