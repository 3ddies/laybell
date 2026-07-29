import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  FlatList, ActivityIndicator, RefreshControl, Keyboard, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import SwipeBackPager from '../../components/SwipeBackPager';
import CommunityCard from '../../components/CommunityCard';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { CommunitiesSkeleton } from '../../components/Skeleton';
import { genreLabel } from '../../lib/genres';
import { formatCount } from '../../lib/format';
import {
  fetchCommunityRails, fetchOfficialCommunities, searchCommunities, respondInvite, canCreateCommunity,
  type CommunityRails, type Community,
} from '../../lib/communities';

const EMPTY: CommunityRails = { mine: [], invites: [], recommended: [], trending: [], explore: [] };

export default function CommunitiesScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { profile } = useProfile();
  const userId = profile?.id ?? null;
  const canCreate = canCreateCommunity(profile);

  const [rails, setRails] = useState<CommunityRails>(EMPTY);
  // Laybell-owned official topic tabs (surfaced only here, in the Communities tab).
  const [official, setOfficial] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Community[]>([]);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    const [r, off] = await Promise.all([fetchCommunityRails(userId), fetchOfficialCommunities()]);
    setRails(r);
    setOfficial(off);
    setLoading(false);
  }, [userId]);

  // Girl space: hide the feminine official tabs from men in this directory (they
  // stay reachable via search / direct link); the feed does the soft down-ranking.
  const g = (profile?.gender ?? '').toLowerCase();
  const shownOfficial = (g === 'man' || g === 'male') ? official.filter((c) => c.space !== 'girl') : official;

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (query.trim().length === 0) { setResults([]); return; }
    const h = setTimeout(async () => {
      setSearching(true);
      setResults(await searchCommunities(query));
      setSearching(false);
    }, 400);
    return () => clearTimeout(h);
  }, [query]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function openCreate() {
    if (!canCreate) {
      Alert.alert(t('communities.needDiamondTitle'), t('communities.needDiamondBody'));
      return;
    }
    router.push('/communities/create');
  }

  function open(c: Community) {
    router.push(`/communities/${c.id}`);
  }

  async function onInviteResponse(c: Community, accept: boolean) {
    // Optimistically drop the invite; a refresh resolves the rest.
    setRails((prev) => ({ ...prev, invites: prev.invites.filter((x) => x.id !== c.id) }));
    await respondInvite(c.id, accept);
    load();
  }

  const isSearching = query.trim().length > 0;

  const Rail = ({ title, data }: { title: string; data: Community[] }) =>
    data.length === 0 ? null : (
      <View style={styles.railWrap}>
        <Text style={styles.railTitle}>{title}</Text>
        <FlatList
          horizontal
          data={data}
          keyExtractor={(c) => c.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.railList}
          renderItem={({ item }) => <CommunityCard community={item} onPress={() => open(item)} />}
        />
      </View>
    );

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('communities.title')}</Text>
          <TouchableOpacity style={styles.headerBtn} onPress={openCreate} hitSlop={8} accessibilityLabel={t('communities.create')}>
            <Ionicons name="add" size={28} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={styles.searchRow}>
          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('communities.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} onPress={() => { setQuery(''); Keyboard.dismiss(); }} hitSlop={10}>
                <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {loading ? (
          <CommunitiesSkeleton sections={4} />
        ) : isSearching ? (
          <FlatList
            data={results}
            keyExtractor={(c) => c.id}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              searching ? <ActivityIndicator color={colors.primary} style={{ marginTop: SPACING.xl }} />
                : <Text style={styles.emptyText}>{t('communities.noResults')}</Text>
            }
            renderItem={({ item }) => <CommunityCard community={item} variant="row" onPress={() => open(item)} />}
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          >
            {/* Pending invites — accept/decline inline */}
            {rails.invites.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.railTitle}>{t('communities.invites')}</Text>
                {rails.invites.map((c) => (
                  <View key={c.id} style={styles.inviteRow}>
                    <TouchableOpacity style={styles.inviteInfo} onPress={() => open(c)} activeOpacity={0.8}>
                      <Text style={styles.inviteName} numberOfLines={1}>{c.name}</Text>
                      <Text style={styles.inviteMeta} numberOfLines={1}>
                        #{c.hashtag} · {genreLabel(c.genre)} · {t('communities.members', { count: formatCount(c.member_count) })}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.inviteBtn, styles.declineBtn]} onPress={() => onInviteResponse(c, false)}>
                      <Text style={styles.declineText}>{t('communities.decline')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.inviteBtn, styles.acceptBtn]} onPress={() => onInviteResponse(c, true)}>
                      <Text style={styles.acceptText}>{t('communities.accept')}</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            <Rail title={t('communities.laybell')} data={shownOfficial} />
            <Rail title={t('communities.yours')} data={rails.mine} />
            <Rail title={t('communities.recommended')} data={rails.recommended} />
            <Rail title={t('communities.trending')} data={rails.trending} />
            <Rail title={t('communities.explore')} data={rails.explore} />

            {/* Cold-start empty state */}
            {rails.mine.length === 0 && rails.recommended.length === 0 &&
             rails.trending.length === 0 && rails.explore.length === 0 && rails.invites.length === 0 &&
             shownOfficial.length === 0 && (
              <View style={styles.emptyState}>
                <Ionicons name="people-outline" size={48} color={colors.textTertiary} />
                <Text style={styles.emptyTitle}>{t('communities.empty')}</Text>
                <Text style={styles.emptySub}>{t('communities.emptySub')}</Text>
                {canCreate && (
                  <TouchableOpacity style={styles.emptyCreate} onPress={openCreate}>
                    <Ionicons name="add" size={18} color="#fff" />
                    <Text style={styles.emptyCreateText}>{t('communities.create')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            <View style={{ height: SPACING.xxl }} />
          </ScrollView>
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerBtn: { width: 44, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },

  searchRow: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { paddingTop: SPACING.sm },
  listContent: { padding: SPACING.md, gap: SPACING.sm },

  section: { paddingHorizontal: SPACING.md, marginBottom: SPACING.lg, gap: SPACING.sm },
  railWrap: { marginBottom: SPACING.lg },
  railTitle: { color: colors.text, fontSize: 20, lineHeight: 28, fontWeight: '900', paddingHorizontal: SPACING.md, marginBottom: SPACING.sm },
  railList: { paddingHorizontal: SPACING.md, gap: SPACING.sm },

  inviteRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.primary + '55', padding: SPACING.sm,
  },
  inviteInfo: { flex: 1 },
  inviteName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  inviteMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  inviteBtn: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADIUS.full },
  declineBtn: { borderWidth: 1, borderColor: colors.border },
  declineText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  acceptBtn: { backgroundColor: colors.primary },
  acceptText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', marginTop: SPACING.xxl },
  emptyState: { alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.xl, paddingTop: SPACING.xxl },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  emptySub: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  emptyCreate: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.md,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.lg,
  },
  emptyCreateText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
