import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import { usePremium } from '../contexts/PremiumContext';
import { MAX_FEATURED, type FeaturedRef, refKey, parseFeatured, saveFeatured } from '../lib/musicFeatured';
import { type Album, albumCover, fetchAlbums } from '../lib/albums';
import SwipeBackPager from '../components/SwipeBackPager';
import { Skeleton, SkeletonLine } from '../components/Skeleton';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

type Track = { id: string; caption: string | null; cover_url: string | null; stream_count: number | null };

// Premium: choose up to four things — ALBUMS or SONGS — for the Featured card
// at the top of the profile Music tab.
//
// Albums are listed first and their own section, because a record is the bigger
// statement and burying it under thirty singles would make it the harder thing
// to pick. Tap to add, tap again to remove.
//
// NUMBERED in pick order, because the card rotates in that order and a plain
// checkmark would leave the artist unable to see — let alone choose — which one
// leads. A fifth pick is refused rather than silently dropping the oldest:
// quietly undoing an earlier choice to honour the latest is the kind of
// helpfulness nobody asked for.
export default function MusicFeaturedScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { isPremium } = usePremium();
  const { update } = useProfile();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [picked, setPicked] = useState<FeaturedRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const [postsRes, profRes, albumList] = await Promise.all([
        supabase.from('posts')
          .select('id, caption, cover_url, stream_count, created_at, archived_at')
          .eq('user_id', user.id).eq('type', 'audio').eq('is_public', true)
          .order('created_at', { ascending: false }),
        supabase.from('profiles').select('music_featured').eq('id', user.id).maybeSingle(),
        fetchAlbums(user.id).catch(() => [] as Album[]),
      ]);
      const live = (postsRes.data ?? []).filter((p: any) => !p.archived_at);
      setTracks(live);
      setAlbums(albumList);
      // Filtered against what still EXISTS, so a song deleted or an album
      // removed since it was picked does not occupy one of the four invisibly —
      // the artist would see three chosen and be unable to find the fourth.
      const liveSongs = new Set(live.map((p: any) => p.id));
      const liveAlbums = new Set(albumList.map((a) => a.id));
      setPicked(parseFeatured((profRes.data as any)?.music_featured)
        .filter((r) => (r.kind === 'album' ? liveAlbums.has(r.id) : liveSongs.has(r.id))));
      setLoading(false);
    })();
  }, []);

  const posOf = (r: FeaturedRef) => picked.findIndex((p) => p.kind === r.kind && p.id === r.id);

  function toggle(r: FeaturedRef) {
    setPicked((prev) => {
      const at = prev.findIndex((p) => p.kind === r.kind && p.id === r.id);
      if (at >= 0) return prev.filter((_, i) => i !== at);
      if (prev.length >= MAX_FEATURED) return prev; // full — the count above says so
      return [...prev, r];
    });
  }

  async function save() {
    setSaving(true);
    const ok = await saveFeatured(picked);
    setSaving(false);
    if (ok) {
      // Push it into the shared profile so the Music tab is already right when
      // the back animation lands, rather than correcting itself a moment later.
      update?.({ music_featured: picked.map(refKey) } as any);
      router.back();
    }
  }

  // One row shape for both kinds — the difference is the fallback glyph and the
  // line under the name, not the layout.
  function pickRow(r: FeaturedRef, title: string, cover: string | null, sub: string) {
    const at = posOf(r);
    const on = at >= 0;
    const full = !on && picked.length >= MAX_FEATURED;
    return (
      <TouchableOpacity
        key={refKey(r)}
        style={[styles.row, on && styles.rowOn, full && styles.rowFull]}
        onPress={() => toggle(r)}
        activeOpacity={0.8}
        disabled={full}
        accessibilityRole="button"
        accessibilityState={{ selected: on, disabled: full }}
      >
        {cover ? (
          <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" />
        ) : (
          <View style={[styles.cover, styles.coverEmpty]}>
            <Ionicons name={r.kind === 'album' ? 'disc' : 'musical-note'} size={18} color={colors.textTertiary} />
          </View>
        )}
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>{title || t('album.untitled')}</Text>
          <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text>
        </View>
        {/* The NUMBER, not a tick: the card rotates in this order, and the
            artist has to be able to see which pick leads it. */}
        <View style={[styles.pos, on && styles.posOn]}>
          {on ? <Text style={styles.posText}>{at + 1}</Text> : null}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={[styles.topBar, { paddingTop: Math.max(insets.top, SPACING.md) + SPACING.xs }]}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={22} color={colors.primaryLight} />
            <Text style={styles.backText}>{t('common.back')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={save} disabled={saving || loading} hitSlop={8}>
            <Text style={[styles.saveBtn, (saving || loading) && styles.saveBtnOff]}>{t('common.save')}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.divider} />

        <View style={styles.intro}>
          <Text style={styles.title}>{t('featured.title')}</Text>
          <Text style={styles.sub}>{t('featured.subAny', { max: MAX_FEATURED })}</Text>
          <Text style={styles.count}>{t('featured.count', { n: picked.length, max: MAX_FEATURED })}</Text>
        </View>

        {loading ? (
          <View style={styles.list}>
            {[0, 1, 2, 3, 4].map((i) => (
              <View key={i} style={styles.row}>
                <Skeleton width={48} height={48} radius={RADIUS.sm} />
                <SkeletonLine w="60%" h={14} />
              </View>
            ))}
          </View>
        ) : !isPremium ? (
          <View style={styles.center}>
            <Ionicons name="star-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.empty}>{t('featured.premiumOnly')}</Text>
          </View>
        ) : tracks.length === 0 && albums.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="musical-notes-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.empty}>{t('profile.noMusic')}</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={[styles.list, { paddingBottom: SPACING.xxl + insets.bottom }]}>
            {/* Albums first: a record is the bigger statement, and putting it
                under thirty singles would make it the harder thing to reach. */}
            {albums.length > 0 && <Text style={styles.groupLabel}>{t('album.shelf')}</Text>}
            {albums.map((a) => pickRow(
              { kind: 'album', id: a.id }, a.title, albumCover(a),
              `${a.track_count ?? (a.tracks?.length ?? 0)}`.concat(' · ', t('album.shelf')),
            ))}
            {tracks.length > 0 && <Text style={styles.groupLabel}>{t('music.singles')}</Text>}
            {tracks.map((tr) => pickRow(
              { kind: 'song', id: tr.id }, tr.caption ?? '', tr.cover_url, t('featured.song'),
            ))}
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center' },
  backText: { color: colors.primaryLight, fontSize: 16, marginLeft: 2 },
  saveBtn: { color: colors.primaryLight, fontSize: 16, fontWeight: '700' },
  saveBtnOff: { opacity: 0.4 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },

  intro: { paddingHorizontal: SPACING.md, paddingTop: SPACING.lg, paddingBottom: SPACING.md, gap: 4 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 19 },
  count: { color: colors.textTertiary, fontSize: 12.5, fontWeight: '700', marginTop: 2 },

  center: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xl, gap: SPACING.sm },
  empty: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', maxWidth: 300 },

  list: { paddingHorizontal: SPACING.md, gap: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.sm, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: 'transparent',
  },
  rowOn: { borderColor: colors.text },
  // Dimmed rather than hidden: the song still exists and will be pickable again
  // the moment something is removed, and taking it off the list would make the
  // page look like it had lost track of the catalogue.
  rowFull: { opacity: 0.45 },
  cover: { width: 48, height: 48, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  coverEmpty: { alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  rowSub: { color: colors.textTertiary, fontSize: 12, marginTop: 1 },
  groupLabel: {
    color: colors.textTertiary, fontSize: 12, fontWeight: '800',
    letterSpacing: 0.6, textTransform: 'uppercase', marginTop: SPACING.sm,
  },
  pos: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.border,
  },
  posOn: { backgroundColor: colors.text, borderColor: colors.text },
  posText: { color: colors.background, fontSize: 13, fontWeight: '800' },
});
