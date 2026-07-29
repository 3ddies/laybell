import { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList, Image, StyleSheet,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { MAX_FEATURES, type Feature } from '../lib/features';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { ListRowsSkeleton } from './Skeleton';

type SearchProfile = { id: string; username: string; display_name: string | null; avatar_url: string | null };

// Credit up to MAX_FEATURES Laybell users as "features" on a song (collaborators).
// Formal features require an account; the composer hints that non-Laybell names
// go in the title instead.
export default function FeaturesModal({
  visible, initial, onClose, onDone,
}: {
  visible: boolean;
  initial: Feature[];
  onClose: () => void;
  onDone: (features: Feature[]) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchProfile[]>([]);
  const [selected, setSelected] = useState<Feature[]>(initial);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (visible) { setSelected(initial); setQuery(''); setResults([]); } }, [visible]);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null)); }, []);

  useEffect(() => {
    if (!visible) return;
    const q = query.trim();
    if (!q) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .or(`username.ilike.${q}%,display_name.ilike.%${q}%`)
        .limit(20);
      if (!cancelled) {
        setResults(((data ?? []) as SearchProfile[]).filter((p) => p.id !== meId));
        setLoading(false);
      }
    }, 160);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, visible, meId]);

  function toggle(p: SearchProfile) {
    setSelected((prev) => {
      if (prev.some((x) => x.id === p.id)) return prev.filter((x) => x.id !== p.id);
      if (prev.length >= MAX_FEATURES) return prev;
      return [...prev, { id: p.id, name: p.display_name || p.username }];
    });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose}><Text style={styles.cancel}>{t('common.cancel')}</Text></TouchableOpacity>
            <Text style={styles.title}>{t('features.title')}</Text>
            <TouchableOpacity onPress={() => { onDone(selected); onClose(); }}><Text style={styles.done}>{t('music.done')}</Text></TouchableOpacity>
          </View>
          <Text style={styles.count}>{t('features.count', { count: selected.length, max: MAX_FEATURES })}</Text>
          <Text style={styles.hint}>{t('features.hint')}</Text>

          {selected.length > 0 && (
            <View style={styles.chips}>
              {selected.map((p) => (
                <TouchableOpacity key={p.id} style={styles.chip} onPress={() => setSelected((prev) => prev.filter((x) => x.id !== p.id))}>
                  <Text style={styles.chipText}>{p.name}</Text>
                  <Ionicons name="close" size={13} color={colors.text} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.searchBar}>
            <Ionicons name="search" size={16} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('features.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <FlatList
            data={results}
            keyExtractor={(p) => p.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: SPACING.xl }}
            ListEmptyComponent={
              loading
                ? <ListRowsSkeleton rows={8} trailing={false} />
                : (query.trim() ? <Text style={styles.empty}>{t('features.empty')}</Text> : null)
            }
            renderItem={({ item }) => {
              const on = selected.some((x) => x.id === item.id);
              const full = !on && selected.length >= MAX_FEATURES;
              return (
                <TouchableOpacity style={[styles.row, full && { opacity: 0.4 }]} disabled={full} onPress={() => toggle(item)}>
                  {item.avatar_url ? (
                    <Image source={{ uri: item.avatar_url }} style={styles.avatar} />
                  ) : (
                    <LinearGradient colors={['#3A1C0C', '#1C0E06']} style={styles.avatar}>
                      <Text style={styles.avatarText}>{(item.display_name || item.username || '?').charAt(0).toUpperCase()}</Text>
                    </LinearGradient>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.username}>@{item.username}</Text>
                    {!!item.display_name && <Text style={styles.name}>{item.display_name}</Text>}
                  </View>
                  <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={on ? colors.primary : colors.textTertiary} />
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { height: '80%', backgroundColor: colors.background, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, paddingTop: SPACING.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  cancel: { color: colors.textSecondary, fontSize: 15 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  done: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  count: { color: colors.textTertiary, fontSize: 12, textAlign: 'center', marginBottom: 2 },
  hint: { color: colors.textTertiary, fontSize: 11.5, textAlign: 'center', marginBottom: SPACING.sm, paddingHorizontal: SPACING.lg, lineHeight: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs, paddingHorizontal: SPACING.md, marginBottom: SPACING.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primary + '22', borderColor: colors.primary, borderWidth: 1,
    borderRadius: RADIUS.full, paddingVertical: 4, paddingHorizontal: SPACING.sm,
  },
  chipText: { color: colors.primaryLight, fontSize: 13, fontWeight: '600' },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md },
  avatar: { width: 40, height: 40, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  username: { color: colors.text, fontSize: 14, fontWeight: '600' },
  name: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  empty: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', marginTop: SPACING.lg },
});
