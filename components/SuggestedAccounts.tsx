import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchSuggestedAccounts, loadContactHashesIfEnabled, reasonLabel, type SuggestedAccount } from '../lib/suggestions';
import { useFollow } from '../contexts/FollowContext';
import FollowButton from './FollowButton';
import StoryAvatar from './StoryAvatar';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// When the user dismisses the rail we stamp the time here; it stays hidden until
// 24h have elapsed, then resurfaces on the next Explore visit.
const DISMISS_KEY = 'suggested_accounts_dismissed_at';
const DISMISS_MS = 24 * 60 * 60 * 1000;

// Horizontal "Suggested for you" rail shown atop Explore. Blends contacts, nearby,
// and mutual-follow signals (lib/suggestions). Renders nothing when there's nothing
// to suggest (e.g. no signals enabled, or pre-migration), so it's invisible until
// it has value.
export default function SuggestedAccounts({ currentUserId }: { currentUserId: string | null }) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { following } = useFollow();
  const [items, setItems] = useState<SuggestedAccount[]>([]);
  // `null` while we read storage (avoids a flash), then true/false once known.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DISMISS_KEY);
        const at = raw ? Number(raw) : 0;
        if (!cancelled) setDismissed(!!at && Date.now() - at < DISMISS_MS);
      } catch { if (!cancelled) setDismissed(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!currentUserId) { setItems([]); return; }
    (async () => {
      const contactHashes = await loadContactHashesIfEnabled(currentUserId);
      try {
        const res = await fetchSuggestedAccounts(currentUserId, { contactHashes, max: 15 });
        if (!cancelled) setItems(res);
      } catch { if (!cancelled) setItems([]); }
    })();
    return () => { cancelled = true; };
  }, [currentUserId]);

  const handleDismiss = async () => {
    setDismissed(true);
    try { await AsyncStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
  };

  // Drop anyone the user has since followed (so the rail stays fresh as they tap).
  const visible = items.filter((a) => !following.has(a.id));
  if (dismissed !== false || visible.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t('friends.suggested')}</Text>
        <TouchableOpacity onPress={handleDismiss} style={styles.dismissBtn} hitSlop={10} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
          <Ionicons name="close" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <FlatList
        horizontal
        data={visible}
        keyExtractor={(a) => a.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <StoryAvatar
              userId={item.id}
              avatarUrl={item.avatar_url}
              name={item.display_name}
              size={56}
              onPressProfile={() => router.push(`/profile/${item.id}`)}
            />
            <TouchableOpacity style={styles.cardText} activeOpacity={0.85} onPress={() => router.push(`/profile/${item.id}`)}>
              <Text style={styles.name} numberOfLines={1}>{item.display_name}</Text>
              <Text style={styles.reason} numberOfLines={2}>{reasonLabel(item.reason)}</Text>
            </TouchableOpacity>
            <FollowButton userId={item.id} style={styles.followBtn} />
          </View>
        )}
      />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { paddingBottom: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: colors.border, marginBottom: SPACING.md },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.xs, marginBottom: SPACING.sm,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: '800' },
  dismissBtn: {
    width: 24, height: 24, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight,
  },
  row: { gap: SPACING.sm, paddingHorizontal: SPACING.xs },
  // 148, not 132: the pill below is content-sized now, and "Follow back" needs
  // room to sit on one line without the card squeezing it.
  card: {
    width: 148, padding: SPACING.md, alignItems: 'center', gap: 6,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, borderWidth: 1, borderColor: colors.border,
  },
  cardText: { alignItems: 'center', gap: 6 },
  name: { color: colors.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  reason: { color: colors.textSecondary, fontSize: 11, textAlign: 'center', minHeight: 28 },
  // LAYOUT ONLY — no padding, no stretch.
  //
  // This used to be `alignSelf: 'stretch'` plus a padding override, which made
  // the pill a full-width slab: at 132px with a pill radius it read as a square
  // white box, and the brand-gradient "Follow back" state looked sliced where
  // the carousel clipped the last card. It also stopped working correctly once
  // FollowButton moved its padding onto an inner gradient layer — an outer
  // padding override then padded the SHELL, around the fill, instead of the
  // button itself.
  //
  // Content-sized and centred is both the fix and the better look: it matches
  // every other Follow pill in the app.
  followBtn: { marginTop: 2 },
});
