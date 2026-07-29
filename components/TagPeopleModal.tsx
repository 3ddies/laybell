import { useEffect, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, FlatList, Image, StyleSheet,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { ListRowsSkeleton } from './Skeleton';

export type TaggedPerson = { id: string; username: string; display_name: string; avatar_url: string | null };

export const MAX_TAGS = 10;

// Pick up to MAX_TAGS accounts to tag on a post (distinct from @mentions in text).
export default function TagPeopleModal({
  visible, initial, onClose, onDone,
}: {
  visible: boolean;
  initial: TaggedPerson[];
  onClose: () => void;
  onDone: (people: TaggedPerson[]) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaggedPerson[]>([]);
  const [selected, setSelected] = useState<TaggedPerson[]>(initial);
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
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .or(`username.ilike.${q}%,display_name.ilike.%${q}%`)
        .limit(20);
      if (!cancelled) {
        setResults(((data ?? []) as TaggedPerson[]).filter((p) => p.id !== meId));
        setLoading(false);
      }
    }, 160);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, visible, meId]);

  function toggle(p: TaggedPerson) {
    setSelected((prev) => {
      if (prev.some((x) => x.id === p.id)) return prev.filter((x) => x.id !== p.id);
      if (prev.length >= MAX_TAGS) return prev;
      return [...prev, p];
    });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose}><Text style={styles.cancel}>{t('common.cancel')}</Text></TouchableOpacity>
            <Text style={styles.title}>{t('post.tagPeople')}</Text>
            <TouchableOpacity onPress={() => { onDone(selected); onClose(); }}><Text style={styles.done}>{t('music.done')}</Text></TouchableOpacity>
          </View>
          <Text style={styles.count}>{t('tagPeopleModal.tagged', { count: selected.length, max: MAX_TAGS })}</Text>

          {selected.length > 0 && (
            <View style={styles.chips}>
              {selected.map((p) => (
                <TouchableOpacity key={p.id} style={styles.chip} onPress={() => toggle(p)}>
                  <Text style={styles.chipText}>@{p.username}</Text>
                  <Ionicons name="close" size={13} color={colors.text} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.searchBar}>
            <Ionicons name="search" size={16} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('tagPeopleModal.searchPlaceholder')}
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
                : (query.trim() ? <Text style={styles.empty}>{t('tagPeopleModal.empty')}</Text> : null)
            }
            renderItem={({ item }) => {
              const on = selected.some((x) => x.id === item.id);
              const full = !on && selected.length >= MAX_TAGS;
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
  count: { color: colors.textTertiary, fontSize: 12, textAlign: 'center', marginBottom: SPACING.sm },
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
