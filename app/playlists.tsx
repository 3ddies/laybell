import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Image, Alert, RefreshControl,
} from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import SwipeBackPager from '../components/SwipeBackPager';
import { rawTier, publicPlaylistLimit, tierLabel } from '../lib/badges';
import { activePublicIds, fetchFirstTrackCovers } from '../lib/playlists';
import { formatCount } from '../lib/format';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';

type Pl = {
  id: string; name: string; is_public: boolean; created_at: string;
  play_count?: number | null; cover?: string | null;
};

// Settings → Playlists: every playlist the user owns in one place — active
// public ones, locked ones (public slots lost to a badge demotion; kept and
// owner-playable but hidden from discovery), and private ones. Visibility can
// be flipped here, within the tier's public-slot limit.
export default function PlaylistsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { profile } = useProfile();
  const [playlists, setPlaylists] = useState<Pl[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setRefreshing(false); return; }
    const { data } = await supabase
      .from('playlists').select('*').eq('user_id', user.id)
      .order('created_at', { ascending: false });
    const rows: Pl[] = (data ?? []) as any;
    const covers = await fetchFirstTrackCovers(rows.map(p => p.id));
    setPlaylists(rows.map(p => ({ ...p, cover: covers[p.id] ?? null })));
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const tier = rawTier(profile);
  const limit = publicPlaylistLimit(tier);
  const activeIds = activePublicIds(playlists, tier);
  const publicCount = playlists.filter(p => p.is_public).length;
  const active = playlists.filter(p => p.is_public && activeIds.has(p.id));
  const locked = playlists.filter(p => p.is_public && !activeIds.has(p.id));
  const priv = playlists.filter(p => !p.is_public);

  async function setVisibility(pl: Pl, makePublic: boolean) {
    if (makePublic && publicCount >= limit) {
      Alert.alert(
        'No free public slots',
        limit === 0
          ? 'Public playlists need a badge. Earn Bronze for 1 slot, Silver for 2, Gold for 3, Diamond for 6.'
          : `Your ${tierLabel(tier)} badge allows ${limit} public ${limit === 1 ? 'playlist' : 'playlists'}. Make one private first to free a slot.`,
      );
      return;
    }
    const { error } = await supabase.from('playlists').update({ is_public: makePublic }).eq('id', pl.id);
    if (error) { Alert.alert('Error', error.message); return; }
    load();
  }

  function confirmDelete(pl: Pl) {
    Alert.alert('Delete Playlist', `Delete “${pl.name}”? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await supabase.from('playlists').delete().eq('id', pl.id);
          load();
        },
      },
    ]);
  }

  function renderRow(pl: Pl, state: 'public' | 'locked' | 'private') {
    return (
      <View key={pl.id} style={[styles.row, state === 'locked' && styles.rowLocked]}>
        <View style={styles.coverWrap}>
          {pl.cover ? (
            <Image source={{ uri: pl.cover }} style={styles.cover} />
          ) : (
            <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.cover}>
              <Ionicons name="musical-notes" size={18} color={colors.primary} />
            </LinearGradient>
          )}
          {state === 'locked' && (
            <View style={styles.lockOverlay}>
              <Ionicons name="lock-closed" size={14} color="#fff" />
            </View>
          )}
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowName} numberOfLines={1}>{pl.name}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {state === 'private'
              ? 'Private — just for you'
              : `${formatCount(pl.play_count ?? 0)} ${pl.play_count === 1 ? 'listen' : 'listens'}${state === 'locked' ? ' · hidden from discovery' : ''}`}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.visBtn}
          onPress={() => setVisibility(pl, !pl.is_public)}
          hitSlop={6}
        >
          <Text style={styles.visBtnText}>{pl.is_public ? 'Make Private' : 'Make Public'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteBtn} onPress={() => confirmDelete(pl)} hitSlop={6}>
          <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    // Swipe right anywhere to slide the whole page off — one motion, same feel
    // as the rest of the app (route registered as a transparent modal).
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Playlists</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
          }
        >
          {/* Slot summary */}
          <View style={styles.summaryCard}>
            <Ionicons name="globe-outline" size={18} color={colors.primary} />
            <Text style={styles.summaryText}>
              {limit === 0
                ? 'Public playlists need a badge — earn Bronze to unlock your first slot.'
                : `${publicCount} of ${limit} public ${limit === 1 ? 'slot' : 'slots'} used · ${tierLabel(tier)} badge`}
            </Text>
          </View>

          {playlists.length === 0 && (
            <Text style={styles.emptyText}>No playlists yet — create one from the Music tab.</Text>
          )}

          {active.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Public</Text>
              {active.map(p => renderRow(p, 'public'))}
            </>
          )}

          {locked.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Locked</Text>
              <Text style={styles.sectionHint}>
                These were public, but your current badge has fewer slots. They're hidden from
                discovery (you can still listen) until you earn the badge back — or free a slot
                by making an active public playlist private.
              </Text>
              {locked.map(p => renderRow(p, 'locked'))}
            </>
          )}

          {priv.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Private</Text>
              {priv.map(p => renderRow(p, 'private'))}
            </>
          )}
        </ScrollView>
      )}
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl },

  summaryCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.lg, padding: SPACING.md,
  },
  summaryText: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  emptyText: { color: colors.textTertiary, fontSize: 13, textAlign: 'center', paddingVertical: SPACING.xl },

  sectionLabel: {
    color: colors.textTertiary, fontSize: 12, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.9,
    paddingTop: SPACING.lg, paddingBottom: SPACING.xs,
  },
  sectionHint: { color: colors.textTertiary, fontSize: 12, lineHeight: 17, paddingBottom: SPACING.sm },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  rowLocked: { opacity: 0.55 },
  coverWrap: { width: 48, height: 48, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  lockOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)',
  },
  rowInfo: { flex: 1 },
  rowName: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  rowMeta: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },
  visBtn: {
    paddingHorizontal: SPACING.sm + 2, paddingVertical: 7,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceLight,
  },
  visBtnText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  deleteBtn: { padding: SPACING.xs },
});
