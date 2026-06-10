import { View, Text, StyleSheet, FlatList, TouchableOpacity, Image } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchSuggestedAccounts, loadContactHashesIfEnabled, REASON_LABEL, type SuggestedAccount } from '../lib/suggestions';
import { useFollow } from '../contexts/FollowContext';
import FollowButton from './FollowButton';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

// Horizontal "Suggested for you" rail shown atop Explore. Blends contacts, nearby,
// and mutual-follow signals (lib/suggestions). Renders nothing when there's nothing
// to suggest (e.g. no signals enabled, or pre-migration), so it's invisible until
// it has value.
export default function SuggestedAccounts({ currentUserId }: { currentUserId: string | null }) {
  const router = useRouter();
  const { following } = useFollow();
  const [items, setItems] = useState<SuggestedAccount[]>([]);

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

  // Drop anyone the user has since followed (so the rail stays fresh as they tap).
  const visible = items.filter((a) => !following.has(a.id));
  if (visible.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Suggested for you</Text>
      <FlatList
        horizontal
        data={visible}
        keyExtractor={(a) => a.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <TouchableOpacity style={styles.cardTop} activeOpacity={0.85} onPress={() => router.push(`/profile/${item.id}`)}>
              {item.avatar_url ? (
                <Image source={{ uri: item.avatar_url }} style={styles.avatar} />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                  <Text style={styles.avatarText}>{item.display_name?.charAt(0).toUpperCase()}</Text>
                </LinearGradient>
              )}
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
  title: { color: COLORS.text, fontSize: 15, fontWeight: '800', paddingHorizontal: SPACING.xs, marginBottom: SPACING.sm },
  row: { gap: SPACING.sm, paddingHorizontal: SPACING.xs },
  card: {
    width: 132, padding: SPACING.md, alignItems: 'center', gap: 6,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border,
  },
  cardTop: { alignItems: 'center', gap: 6 },
  avatar: { width: 56, height: 56, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 22, fontWeight: '700' },
  name: { color: COLORS.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  reason: { color: COLORS.textSecondary, fontSize: 11, textAlign: 'center', minHeight: 28 },
  followBtn: { marginTop: 2 },
});
