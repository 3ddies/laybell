import { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, Image, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// Subtle person-avatar button (bottom-left of a post's media) shown when the post
// has people tagged. Tapping opens a menu listing the tagged accounts; each opens
// that profile. Profiles are fetched lazily on first open.

type Person = { id: string; username: string; display_name: string; avatar_url: string | null };

export default function TaggedPeopleButton({ userIds, style }: { userIds?: string[] | null; style?: any }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);

  const ids = userIds ?? [];
  if (!ids.length) return null;

  async function openMenu() {
    setOpen(true);
    if (people.length) return;
    setLoading(true);
    const { data } = await supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', ids);
    // Keep the author's chosen order.
    const byId = Object.fromEntries((data ?? []).map((p: any) => [p.id, p]));
    setPeople(ids.map((id) => byId[id]).filter(Boolean) as Person[]);
    setLoading(false);
  }

  return (
    <>
      <TouchableOpacity style={[styles.btn, style]} onPress={openMenu} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="person" size={13} color="#fff" />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.title}>Tagged in this post</Text>
            {loading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: SPACING.lg }} />
            ) : (
              <FlatList
                data={people}
                keyExtractor={(p) => p.id}
                style={{ maxHeight: 320 }}
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.row} onPress={() => { setOpen(false); router.push(`/profile/${item.id}`); }}>
                    {item.avatar_url ? (
                      <Image source={{ uri: item.avatar_url }} style={styles.avatar} />
                    ) : (
                      <LinearGradient colors={['#3A1C0C', '#1C0E06']} style={styles.avatar}>
                        <Text style={styles.avatarText}>{(item.display_name || item.username || '?').charAt(0).toUpperCase()}</Text>
                      </LinearGradient>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name} numberOfLines={1}>{item.display_name}</Text>
                      <Text style={styles.username} numberOfLines={1}>@{item.username}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  btn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.lg, padding: SPACING.md, borderWidth: 1, borderColor: colors.border },
  title: { color: colors.text, fontSize: 15, fontWeight: '800', marginBottom: SPACING.sm, paddingHorizontal: SPACING.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.xs },
  avatar: { width: 40, height: 40, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  name: { color: colors.text, fontSize: 14, fontWeight: '600' },
  username: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
});
