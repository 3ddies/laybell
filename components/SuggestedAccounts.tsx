import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchSuggestedAccounts, loadContactHashesIfEnabled, REASON_LABEL, type SuggestedAccount } from '../lib/suggestions';
import { useFollow } from '../contexts/FollowContext';
import FollowButton from './FollowButton';
import StoryAvatar from './StoryAvatar';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

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
        <Text style={styles.title}>Suggested for you</Text>
        <TouchableOpacity onPress={handleDismiss} style={styles.dismissBtn} hitSlop={10} activeOpacity={0.6}>
          <Ionicons name="close" size={18} color={COLORS.textSecondary} />
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
              <Text style={styles.reason} numberOfLines={2}>{REASON_LABEL[item.reason]}</Text>
            </TouchableOpacity>
            <FollowButton userId={item.id} style={styles.followBtn} />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: SPACING.md, borderBottomWidth: 0.5, borderBottomColor: COLORS.border, marginBottom: SPACING.md },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.xs, marginBottom: SPACING.sm,
  },
  title: { color: COLORS.text, fontSize: 15, fontWeight: '800' },
  dismissBtn: {
    width: 24, height: 24, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight,
  },
  row: { gap: SPACING.sm, paddingHorizontal: SPACING.xs },
  card: {
    width: 132, padding: SPACING.md, alignItems: 'center', gap: 6,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
  },
  cardText: { alignItems: 'center', gap: 6 },
  name: { color: COLORS.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  reason: { color: COLORS.textSecondary, fontSize: 11, textAlign: 'center', minHeight: 28 },
  // Full-width within the card with tighter side padding so "Follow back" fits on
  // one line (the inline default is content-sized and wraps in the narrow card).
  followBtn: { marginTop: 2, alignSelf: 'stretch', paddingHorizontal: SPACING.sm },
});
