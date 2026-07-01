import {
  View, Text, StyleSheet, TextInput, FlatList, Image,
  TouchableOpacity, ActivityIndicator, Alert, Keyboard, Modal, Pressable, useWindowDimensions,
} from 'react-native';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useFollow } from '../../contexts/FollowContext';
import { createGroup, findExistingGroup, MAX_GROUP_MEMBERS, type GroupProfile } from '../../lib/groups';
import BadgeEmblem from '../../components/BadgeEmblem';
import { ListRowsSkeleton } from '../../components/Skeleton';

// Light-to-deep blue (matching the sent-message bubbles) for the filled Create
// buttons — a gradient fade rather than the brand orange.
const BLUE_GRADIENT = ['#1FA0FF', '#0A7CFF'] as const;

export default function NewGroupScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const { following, followers } = useFollow();

  const [candidates, setCandidates] = useState<GroupProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);  // looking for an existing chat
  const [nameOpen, setNameOpen] = useState(false);  // name-the-group popup
  const [creating, setCreating] = useState(false);

  // Candidate pool: everyone you follow or who follows you (people you can
  // plausibly want in a group), resolved to profiles once.
  useEffect(() => {
    let active = true;
    (async () => {
      const ids = Array.from(new Set([...following, ...followers]));
      if (ids.length === 0) { setCandidates([]); setLoading(false); return; }
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, badge_tier, badge_show')
        .in('id', ids);
      if (!active) return;
      const list = (data ?? []) as GroupProfile[];
      list.sort((a, b) => (a.display_name || a.username || '').localeCompare(b.display_name || b.username || ''));
      setCandidates(list);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [following, followers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(c =>
      (c.display_name || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q));
  }, [candidates, query]);

  const maxOthers = MAX_GROUP_MEMBERS - 1; // the creator takes one slot

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); return next; }
      if (next.size >= maxOthers) {
        Alert.alert(t('groups.limitTitle'), t('groups.limitBody', { count: MAX_GROUP_MEMBERS }));
        return prev;
      }
      next.add(id);
      return next;
    });
  }

  // Tapping the header Create:
  //  • one person  → open the plain 1:1 DM with them (DMs live outside the
  //    conversations model, so there's nothing to create — just navigate).
  //  • two or more → if a group with exactly these people already exists, jump
  //    to it; otherwise open the name-the-group popup.
  async function onCreatePress() {
    if (selected.size < 1 || checking || creating) return;
    Keyboard.dismiss();
    const ids = Array.from(selected);
    if (ids.length === 1) { router.replace(`/messages/${ids[0]}`); return; }
    setChecking(true);
    const existing = await findExistingGroup(ids);
    setChecking(false);
    if (existing) { router.replace(`/messages/group/${existing}`); return; }
    setNameOpen(true);
  }

  // Confirm from the popup — actually create the group with the entered name.
  async function confirmCreate() {
    if (creating) return;
    setCreating(true);
    const id = await createGroup(name, Array.from(selected));
    setCreating(false);
    if (!id) { Alert.alert(t('groups.createFailTitle'), t('groups.createFailBody')); return; }
    setNameOpen(false);
    router.replace(`/messages/group/${id}`);
  }

  const canCreate = selected.size >= 1 && !checking && !creating;

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, SPACING.md) }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={26} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('groups.newTitle')}</Text>
        <TouchableOpacity onPress={onCreatePress} disabled={!canCreate} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} activeOpacity={0.85}>
          {checking ? (
            <LinearGradient colors={BLUE_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.createPill}>
              <ActivityIndicator color="#fff" size="small" />
            </LinearGradient>
          ) : canCreate ? (
            <LinearGradient colors={BLUE_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.createPill}>
              <Text style={styles.createPillText}>{t('groups.create')}</Text>
            </LinearGradient>
          ) : (
            <View style={[styles.createPill, styles.createPillDisabled]}>
              <Text style={[styles.createPillText, styles.createPillTextDisabled]}>{t('groups.create')}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            placeholder={t('groups.searchPeople')}
            placeholderTextColor={colors.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      {selected.size > 0 && (
        <Text style={styles.selectedCount}>{t('groups.selectedCount', { count: selected.size })}</Text>
      )}

      {loading ? (
        <ListRowsSkeleton rows={8} trailing={false} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + SPACING.xl }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t('groups.noPeople')}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => toggle(item.id)}>
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                    <Text style={styles.avatarText}>{(item.display_name || item.username || '?').charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <View style={styles.rowInfo}>
                  <View style={styles.rowNameLine}>
                    <Text style={styles.rowName} numberOfLines={1}>{item.display_name || item.username}</Text>
                    <BadgeEmblem profile={item} size={13} />
                  </View>
                  {!!item.username && <Text style={styles.rowUsername} numberOfLines={1}>@{item.username}</Text>}
                </View>
                <View style={[styles.checkbox, on && styles.checkboxOn]}>
                  {on && <Ionicons name="checkmark" size={16} color="#000" />}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Name-the-group popup — shown after Create when no matching chat exists. */}
      <Modal visible={nameOpen} transparent animationType="fade" onRequestClose={() => !creating && setNameOpen(false)}>
        <Pressable style={[styles.modalBackdrop, { paddingTop: winH * 0.22 }]} onPress={() => !creating && setNameOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>{t('groups.nameModalTitle')}</Text>
            <Text style={styles.modalSub}>{t('groups.nameModalSub', { count: selected.size + 1 })}</Text>
            <TextInput
              style={styles.modalInput}
              placeholder={t('groups.namePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={name}
              onChangeText={setName}
              maxLength={40}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={confirmCreate}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setNameOpen(false)} disabled={creating} activeOpacity={0.85}>
                <Text style={styles.modalCancelText}>{t('groups.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmWrap} onPress={confirmCreate} disabled={creating} activeOpacity={0.85}>
                <LinearGradient colors={BLUE_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.modalConfirm}>
                  {creating
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Text style={styles.modalConfirmText}>{t('groups.create')}</Text>}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingBottom: SPACING.sm + 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  backBtn: { width: 46, alignItems: 'flex-start', paddingVertical: SPACING.xs },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  // Create is a compact gradient pill (light→deep blue) when enabled, a flat grey
  // pill when not — reads clearly as a button, not the brand-orange text link.
  createPill: { minWidth: 74, paddingHorizontal: 16, paddingVertical: 7, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  createPillText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  createPillDisabled: { backgroundColor: colors.surface },
  createPillTextDisabled: { color: colors.textTertiary },

  // Name-the-group popup — sits in the upper area (see inline paddingTop) so the
  // keyboard has room below it.
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: SPACING.xl },
  modalCard: {
    width: '100%', maxWidth: 360, backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.xl, padding: SPACING.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  modalSub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: SPACING.md },
  modalInput: {
    backgroundColor: colors.surface, borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 3,
    color: colors.text, fontSize: 16,
  },
  modalActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  modalCancel: { flex: 1, paddingVertical: SPACING.sm + 4, borderRadius: RADIUS.full, alignItems: 'center', backgroundColor: colors.surface },
  modalCancelText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  modalConfirmWrap: { flex: 1, borderRadius: RADIUS.full, overflow: 'hidden' },
  modalConfirm: { paddingVertical: SPACING.sm + 4, alignItems: 'center', justifyContent: 'center' },
  modalConfirmText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  searchRow: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm + 2, paddingBottom: SPACING.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surface, borderRadius: RADIUS.full, paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },

  selectedCount: { color: colors.textSecondary, fontSize: 13, paddingHorizontal: SPACING.md, paddingBottom: SPACING.xs, fontWeight: '600' },

  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, paddingHorizontal: SPACING.md, paddingVertical: 9 },
  avatar: { width: 48, height: 48, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  rowInfo: { flex: 1 },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  rowUsername: { color: colors.textSecondary, fontSize: 13 },
  checkbox: {
    width: 24, height: 24, borderRadius: RADIUS.full,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: '#fff', borderColor: '#fff' },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', paddingHorizontal: SPACING.xl },
});
