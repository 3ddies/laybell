import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import { usePremium } from '../contexts/PremiumContext';
import { applyMusicOrder, parseMusicOrder, saveMusicOrder } from '../lib/musicOrder';
import SwipeBackPager from '../components/SwipeBackPager';
import { Skeleton, SkeletonLine } from '../components/Skeleton';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

type Track = { id: string; caption: string | null; cover_url: string | null; stream_count: number | null };

// Premium: arrange the profile Music tab. A simple, dependency-free up/down
// reorder (no native drag lib) that persists to profiles.music_order — the exact
// order the Music tab then shows to everyone. See lib/musicOrder.
export default function MusicOrderScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { t } = useTranslation();
  const { isPremium } = usePremium();
  const { update } = useProfile();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const [postsRes, profRes] = await Promise.all([
        supabase.from('posts')
          .select('id, caption, cover_url, stream_count, created_at, archived_at')
          .eq('user_id', user.id).eq('type', 'audio').eq('is_public', true)
          .order('created_at', { ascending: false }),
        supabase.from('profiles').select('music_order').eq('id', user.id).maybeSingle(),
      ]);
      const rows = ((postsRes.data ?? []) as any[]).filter(p => !p.archived_at);
      // Seed the editor with the user's CURRENT order (their saved arrangement,
      // new songs appended newest-first), so it opens exactly as their tab looks.
      setTracks(applyMusicOrder(rows, parseMusicOrder((profRes.data as any)?.music_order)));
      setLoading(false);
    })();
  }, []);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= tracks.length) return;
    setTracks(prev => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    const ids = tracks.map(t => t.id);
    const ok = await saveMusicOrder(ids);
    // Reflect it on the live profile so the Music tab re-renders in the new order.
    if (ok) update({ music_order: ids } as any);
    setSaving(false);
    router.back();
  }

  // Non-premium fallback (shouldn't normally reach here — the entry is gated).
  if (!isPremium) {
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          <Header title={t('musicOrder.title')} onBack={() => router.back()} colors={colors} styles={styles} />
          <View style={styles.locked}>
            <Ionicons name="star" size={40} color={colors.primary} />
            <Text style={styles.lockedTitle}>{t('musicOrder.premiumLocked')}</Text>
            <TouchableOpacity style={styles.getBtn} onPress={() => router.replace('/premium')}>
              <LinearGradient colors={GRADIENTS.primary as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.getBtnInner}>
                <Text style={styles.getBtnText}>{t('musicOrder.getPremium')}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.cancel}>{t('common.cancel')}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('musicOrder.title')}</Text>
          <TouchableOpacity onPress={save} disabled={saving || loading}>
            {saving ? <ActivityIndicator color={colors.primary} size="small" /> : <Text style={[styles.save, (loading) && styles.saveOff]}>{t('editProfile.save')}</Text>}
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.body}>
            {Array.from({ length: 6 }).map((_, i) => (
              <View key={i} style={styles.row}>
                <Skeleton width={46} height={46} radius={RADIUS.sm} />
                <View style={{ flex: 1, gap: 8 }}><SkeletonLine w="70%" h={14} /><SkeletonLine w="40%" h={11} /></View>
              </View>
            ))}
          </View>
        ) : tracks.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="musical-notes-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyText}>{t('musicOrder.empty')}</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            <Text style={styles.hint}>{t('musicOrder.hint')}</Text>
            {tracks.map((track, i) => (
              <View key={track.id} style={styles.row}>
                <Text style={styles.num}>{i + 1}</Text>
                {track.cover_url ? (
                  <Image source={{ uri: track.cover_url }} style={styles.cover} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                    <Ionicons name="musical-notes" size={18} color={colors.primary} />
                  </LinearGradient>
                )}
                <View style={styles.info}>
                  <Text style={styles.title} numberOfLines={1}>{track.caption || t('musicOrder.untitled')}</Text>
                  <View style={styles.metaRow}>
                    <Ionicons name="play" size={9} color={colors.textTertiary} />
                    <Text style={styles.meta}>{track.stream_count ?? 0}</Text>
                  </View>
                </View>
                <View style={styles.moves}>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.moveUp')} style={[styles.moveBtn, i === 0 && styles.moveOff]} disabled={i === 0} onPress={() => move(i, -1)} hitSlop={6}>
                    <Ionicons name="chevron-up" size={20} color={i === 0 ? colors.textTertiary : colors.text} />
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.moveDown')} style={[styles.moveBtn, i === tracks.length - 1 && styles.moveOff]} disabled={i === tracks.length - 1} onPress={() => move(i, 1)} hitSlop={6}>
                    <Ionicons name="chevron-down" size={20} color={i === tracks.length - 1 ? colors.textTertiary : colors.text} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

function Header({ title, onBack, colors, styles }: { title: string; onBack: () => void; colors: ThemePalette; styles: any }) {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={{ width: 40 }} />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { minWidth: 52 },
  cancel: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  save: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  saveOff: { color: colors.textTertiary },

  body: { padding: SPACING.md, paddingBottom: SPACING.xxl + 40, gap: SPACING.sm },
  hint: { color: colors.textTertiary, fontSize: 12.5, lineHeight: 18, marginBottom: SPACING.xs },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.sm,
  },
  num: { color: colors.textTertiary, fontSize: 13, fontWeight: '800', width: 20, textAlign: 'center' },
  cover: { width: 46, height: 46, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  meta: { color: colors.textTertiary, fontSize: 11 },
  moves: { flexDirection: 'row', gap: 2 },
  moveBtn: {
    width: 34, height: 34, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
  },
  moveOff: { opacity: 0.4 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },

  locked: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md, padding: SPACING.xl },
  lockedTitle: { color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center', lineHeight: 22 },
  getBtn: { borderRadius: RADIUS.full, overflow: 'hidden', marginTop: SPACING.sm },
  getBtnInner: { paddingVertical: SPACING.md, paddingHorizontal: SPACING.xl },
  getBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
