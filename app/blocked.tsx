import {
  View, Text, StyleSheet, TouchableOpacity,
  FlatList, Image, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useCallback } from 'react';
import { fetchBlockedUsers, unblockUser, type BlockedUser } from '../lib/blocks';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

export default function BlockedScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await fetchBlockedUsers();
    setBlocked(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function confirmUnblock(u: BlockedUser) {
    const handle = u.profile?.username ? `@${u.profile.username}` : 'this user';
    Alert.alert(
      `Unblock ${handle}?`,
      `${handle}'s posts can appear in your feed and explore again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            setBusy(u.blocked_id);
            const ok = await unblockUser(u.blocked_id);
            if (ok) setBlocked(prev => prev.filter(b => b.blocked_id !== u.blocked_id));
            else Alert.alert('Error', 'Could not unblock. Please try again.');
            setBusy(null);
          },
        },
      ],
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Blocked</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={blocked}
          keyExtractor={(item) => item.blocked_id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="ban-outline" size={44} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No blocked users</Text>
              <Text style={styles.emptySub}>
                People you block won't show up in your feed or explore. You can block
                someone from their profile or from any of their posts.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const p = item.profile;
            return (
              <View style={styles.row}>
                <TouchableOpacity
                  style={styles.userInfo}
                  onPress={() => p && router.push(`/profile/${p.id}`)}
                  disabled={!p}
                  activeOpacity={0.8}
                >
                  {p?.avatar_url ? (
                    <Image source={{ uri: p.avatar_url }} style={styles.avatar} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                      <Text style={styles.avatarText}>
                        {(p?.display_name || p?.username || '?').charAt(0).toUpperCase()}
                      </Text>
                    </LinearGradient>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {p?.display_name || p?.username || 'Unknown user'}
                    </Text>
                    {!!p?.username && <Text style={styles.handle} numberOfLines={1}>@{p.username}</Text>}
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.unblockBtn}
                  onPress={() => confirmUnblock(item)}
                  disabled={busy === item.blocked_id}
                >
                  {busy === item.blocked_id
                    ? <ActivityIndicator size="small" color={colors.text} />
                    : <Text style={styles.unblockText}>Unblock</Text>}
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  list: { padding: SPACING.md, gap: SPACING.sm, flexGrow: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.sm + 2,
  },
  userInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  avatar: {
    width: 46, height: 46, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: 18, fontWeight: '700' },
  name: { color: colors.text, fontSize: 15, fontWeight: '700' },
  handle: { color: colors.textSecondary, fontSize: 13, marginTop: 1 },
  unblockBtn: {
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    minWidth: 84, alignItems: 'center',
  },
  unblockText: { color: colors.text, fontSize: 13, fontWeight: '700' },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl + SPACING.lg, gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  emptySub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
