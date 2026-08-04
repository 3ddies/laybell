import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// Account suggestions shown while typing "@…" in a caption or comment, so users
// tag the right person. Render it directly above/below the input; it returns null
// when there's no active @query or no matches. onPick gives the chosen username.

type Profile = { id: string; username: string; display_name: string; avatar_url: string | null };

export default function MentionSuggestions({
  query, onPick, style, maxHeight = 220,
}: { query: string | null; onPick: (username: string) => void; style?: any; maxHeight?: number }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [results, setResults] = useState<Profile[]>([]);

  useEffect(() => {
    if (!query) { setResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('hidden', false) // hidden accounts can't be @mentioned
        .ilike('username', `${query}%`)
        .order('username')
        .limit(8);
      if (!cancelled) setResults((data ?? []) as Profile[]);
    }, 140);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  if (!query || results.length === 0) return null;

  return (
    <View style={[styles.box, { maxHeight }, style]}>
      <ScrollView keyboardShouldPersistTaps="handled">
        {results.map((u) => (
          <TouchableOpacity key={u.id} style={styles.row} onPress={() => onPick(u.username)} activeOpacity={0.7}>
            {u.avatar_url ? (
              <Image source={{ uri: u.avatar_url }} style={styles.avatar} />
            ) : (
              <LinearGradient colors={GRADIENTS.avatar} style={styles.avatar}>
                <Text style={styles.avatarText}>{(u.display_name || u.username || '?').charAt(0).toUpperCase()}</Text>
              </LinearGradient>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.username} numberOfLines={1}>@{u.username}</Text>
              {!!u.display_name && <Text style={styles.name} numberOfLines={1}>{u.display_name}</Text>}
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  box: {
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  avatar: { width: 32, height: 32, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.avatarFg, fontSize: 13, fontWeight: '700' },
  username: { color: colors.text, fontSize: 14, fontWeight: '600' },
  name: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
});
