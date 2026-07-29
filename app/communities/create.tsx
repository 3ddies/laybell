import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Modal, Image, Alert, Keyboard, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import SwipeBackPager from '../../components/SwipeBackPager';
import BadgeEmblem from '../../components/BadgeEmblem';
import ConfirmDialog from '../../components/ConfirmDialog';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { supabase } from '../../lib/supabase';
import { GENRES, genreLabel } from '../../lib/genres';
import { rawTier, tierRank } from '../../lib/badges';
import { createCommunity, canCreateCommunity, type CommunityInvite } from '../../lib/communities';

type Invitee = {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  badge_tier?: string | null;
  badge_show?: boolean | null;
  role: 'member' | 'manager';
};

export default function CreateCommunityScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { profile } = useProfile();
  const canCreate = canCreateCommunity(profile);

  const [name, setName] = useState('');
  const [nameState, setNameState] = useState<'idle' | 'checking' | 'ok' | 'taken'>('idle');
  const [genre, setGenre] = useState('');
  const [showGenre, setShowGenre] = useState(false);
  const [guidelines, setGuidelines] = useState('');
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null); // success card after create

  // Field refs so tapping a field's label/element focuses or opens it. Keyboard
  // visibility gates the genre picker so it can't pop a modal over a live
  // keyboard mid-typing (which feels buggy).
  const nameRef = useRef<TextInput>(null);
  const guidelinesRef = useRef<TextInput>(null);
  const searchRef = useRef<TextInput>(null);
  // Scroll-into-view: record each scrollable field's y, and when the keyboard
  // shows, scroll the focused field so its WHOLE box sits above the keyboard.
  const scrollRef = useRef<ScrollView>(null);
  const fieldY = useRef<Record<string, number>>({});
  const pendingField = useRef<string | null>(null);
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const s = Keyboard.addListener('keyboardDidShow', () => {
      setKbVisible(true);
      const key = pendingField.current;
      if (key && fieldY.current[key] != null) {
        const to = () => scrollRef.current?.scrollTo({ y: Math.max(0, (fieldY.current[key] ?? 0) - 12), animated: true });
        to();
        setTimeout(to, 60); // re-assert after iOS's own keyboard-inset auto-scroll
      }
    });
    const h = Keyboard.addListener('keyboardDidHide', () => setKbVisible(false));
    return () => { s.remove(); h.remove(); };
  }, []);
  // Remember which field to reveal (null = a top field that needs no scroll). If
  // the keyboard is already up (switching fields), scroll right away.
  function focusField(key: string | null) {
    pendingField.current = key;
    if (key && kbVisible && fieldY.current[key] != null) {
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, (fieldY.current[key] ?? 0) - 12), animated: true }));
    }
  }
  // While typing, the first tap on the genre field just dismisses the keyboard;
  // tap again (keyboard down) to open the picker — no modal-over-keyboard jank.
  function openGenre() {
    if (kbVisible) { Keyboard.dismiss(); return; }
    setShowGenre(true);
  }

  // Live name-availability check (unique, case-insensitive).
  useEffect(() => {
    const n = name.trim();
    if (n.length < 2) { setNameState('idle'); return; }
    setNameState('checking');
    const h = setTimeout(async () => {
      try {
        const { data } = await supabase.from('communities').select('id').ilike('name', n).maybeSingle();
        setNameState(data ? 'taken' : 'ok');
      } catch { setNameState('ok'); } // table not migrated → don't block
    }, 400);
    return () => clearTimeout(h);
  }, [name]);

  // Debounced people search for the invite picker.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) { setResults([]); return; }
    const h = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, badge_tier, badge_show, hidden')
          .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
          .limit(15);
        const taken = new Set(invitees.map((i) => i.id));
        setResults(((data as any[]) ?? []).filter((p) => !p.hidden && p.id !== profile?.id && !taken.has(p.id)));
      } catch { setResults([]); }
      setSearching(false);
    }, 400);
    return () => clearTimeout(h);
  }, [query, invitees, profile?.id]);

  function addInvitee(p: any) {
    setInvitees((prev) => [...prev, { ...p, role: 'member' }]);
    setQuery('');
    setResults([]);
  }
  function removeInvitee(id: string) {
    setInvitees((prev) => prev.filter((i) => i.id !== id));
  }
  // Toggle manager — only allowed if the person currently holds Gold+.
  function toggleManager(id: string) {
    setInvitees((prev) => prev.map((i) => {
      if (i.id !== id) return i;
      const goldPlus = tierRank(rawTier(i)) >= tierRank('gold');
      if (!goldPlus) return i;
      return { ...i, role: i.role === 'manager' ? 'member' : 'manager' };
    }));
  }

  const canSubmit = name.trim().length >= 2 && nameState !== 'taken' && !!genre && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const invites: CommunityInvite[] = invitees.map((i) => ({ user_id: i.id, role: i.role }));
    const res = await createCommunity({ name: name.trim(), genre, guidelines, invites });
    setSubmitting(false);
    if (res.error) {
      Alert.alert(t('communities.createTitle'), t(res.error));
      return;
    }
    // Polished in-app success card (replaces the default OS alert).
    if (res.id) setCreatedId(res.id);
    else router.back();
  }

  if (!canCreate) {
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <Ionicons name="chevron-back" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('communities.createTitle')}</Text>
            <View style={styles.headerBtn} />
          </View>
          <View style={styles.gate}>
            <Ionicons name="diamond" size={48} color={colors.diamond} />
            <Text style={styles.gateTitle}>{t('communities.needDiamondTitle')}</Text>
            <Text style={styles.gateSub}>{t('communities.needDiamondBody')}</Text>
          </View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('communities.createTitle')}</Text>
          <TouchableOpacity style={styles.headerAction} onPress={submit} disabled={!canSubmit}>
            {submitting ? <ActivityIndicator color={colors.primary} size="small" />
              : <Text style={[styles.headerActionText, !canSubmit && { color: colors.textTertiary }]}>{t('communities.createBtn')}</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          showsVerticalScrollIndicator={false}
        >
          {/* Name */}
          <View style={styles.field}>
            <Text style={styles.label}>{t('communities.name')}</Text>
            <View style={styles.inputRow}>
              <TextInput
                ref={nameRef}
                onFocus={() => focusField(null)}
                style={styles.input}
                placeholder={t('communities.namePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={name}
                onChangeText={setName}
                maxLength={40}
                autoCapitalize="words"
              />
              {nameState === 'checking' && <ActivityIndicator size="small" color={colors.textTertiary} />}
              {nameState === 'ok' && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
              {nameState === 'taken' && <Ionicons name="close-circle" size={20} color={colors.error} />}
            </View>
            {nameState === 'taken' && <Text style={styles.errText}>{t('communities.nameTaken')}</Text>}
            {nameState === 'ok' && <Text style={styles.okText}>{t('communities.nameAvailable')}</Text>}
          </View>

          {/* Genre — only the dropdown control opens the picker (gated so it
              won't open over a live keyboard); the label/row aren't tappable. */}
          <View style={styles.field}>
            <Text style={styles.label}>{t('communities.genre')}</Text>
            <TouchableOpacity style={styles.dropdown} onPress={openGenre} activeOpacity={0.8}>
              <Text style={[styles.dropdownText, !genre && styles.dropdownPlaceholder]}>
                {genre ? genreLabel(genre) : t('communities.selectGenre')}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {/* Guidelines */}
          <View style={styles.field} onLayout={(e) => { fieldY.current.guidelines = e.nativeEvent.layout.y; }}>
            <Text style={styles.label}>{t('communities.guidelines')}</Text>
            <TextInput
              ref={guidelinesRef}
              style={styles.textarea}
              placeholder={t('communities.guidelinesPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={guidelines}
              onChangeText={setGuidelines}
              onFocus={() => focusField('guidelines')}
              multiline
              maxLength={1000}
              textAlignVertical="top"
            />
          </View>

          {/* Invite members */}
          <View style={styles.field} onLayout={(e) => { fieldY.current.invite = e.nativeEvent.layout.y; }}>
            <Text style={styles.label}>{t('communities.inviteMembers')}</Text>
            <Text style={styles.hint}>{t('communities.inviteHint')}</Text>

            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
              <TextInput
                ref={searchRef}
                style={styles.searchInput}
                onFocus={() => focusField('invite')}
                placeholder={t('communities.inviteSearchPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searching && <ActivityIndicator size="small" color={colors.textTertiary} />}
            </View>

            {/* Search results */}
            {results.map((p) => (
              <TouchableOpacity key={p.id} style={styles.resultRow} onPress={() => addInvitee(p)} activeOpacity={0.8}>
                {p.avatar_url ? (
                  <Image source={{ uri: p.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                    <Text style={styles.avatarInitial}>{p.display_name?.charAt(0)?.toUpperCase() ?? '?'}</Text>
                  </LinearGradient>
                )}
                <View style={styles.resultInfo}>
                  <View style={styles.nameLine}>
                    <Text style={styles.resultName} numberOfLines={1}>{p.display_name ?? p.username}</Text>
                    <BadgeEmblem profile={p} size={12} />
                  </View>
                  <Text style={styles.resultUser} numberOfLines={1}>@{p.username}</Text>
                </View>
                <Ionicons name="add-circle" size={24} color={colors.primary} />
              </TouchableOpacity>
            ))}

            {/* Selected invitees */}
            {invitees.length > 0 && (
              <View style={styles.inviteeList}>
                {invitees.map((i) => {
                  const goldPlus = tierRank(rawTier(i)) >= tierRank('gold');
                  const available = goldPlus && i.role !== 'manager'; // the actionable "Make manager" state
                  return (
                    <View key={i.id} style={styles.inviteeRow}>
                      {i.avatar_url ? (
                        <Image source={{ uri: i.avatar_url }} style={styles.avatarSm} />
                      ) : (
                        <LinearGradient colors={GRADIENTS.primary} style={styles.avatarSm}>
                          <Text style={styles.avatarInitialSm}>{i.display_name?.charAt(0)?.toUpperCase() ?? '?'}</Text>
                        </LinearGradient>
                      )}
                      <View style={styles.resultInfo}>
                        <Text style={styles.resultName} numberOfLines={1}>{i.display_name ?? i.username}</Text>
                        <Text style={styles.resultUser} numberOfLines={1}>@{i.username}</Text>
                        {/* Disclaimer stays on the row whenever the Manager button is
                            locked (not Gold+) — explains why it can't be toggled. */}
                        {!goldPlus && (
                          <View style={styles.needsGoldNote}>
                            <Ionicons name="lock-closed" size={10} color={colors.textTertiary} />
                            <Text style={styles.needsGoldText} numberOfLines={1}>{t('communities.managerNeedsGold')}</Text>
                          </View>
                        )}
                      </View>
                      <TouchableOpacity
                        style={[styles.mgrToggle, i.role === 'manager' && styles.mgrToggleOn, available && styles.mgrToggleAvailable, !goldPlus && styles.mgrToggleDisabled]}
                        onPress={() => toggleManager(i.id)}
                        disabled={!goldPlus}
                      >
                        <Ionicons
                          name="shield-checkmark"
                          size={13}
                          color={i.role === 'manager' ? colors.gold : available ? '#fff' : colors.textTertiary}
                        />
                        {/* Always labelled "Manager" so the locked/greyed button is
                            still clearly the Manager toggle. */}
                        <Text style={[
                          styles.mgrToggleText,
                          { color: i.role === 'manager' ? colors.gold : available ? '#fff' : colors.textTertiary },
                        ]}>
                          {t('communities.makeManager')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} onPress={() => removeInvitee(i.id)} hitSlop={8}>
                        <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={{ height: SPACING.xxl }} />
        </ScrollView>

        {/* Genre picker */}
        <Modal visible={showGenre} transparent animationType="fade" onRequestClose={() => setShowGenre(false)}>
          <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setShowGenre(false)}>
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>{t('communities.selectGenre')}</Text>
              <ScrollView contentContainerStyle={styles.chipWrap} keyboardShouldPersistTaps="handled">
                {GENRES.map((g) => {
                  const value = g.toLowerCase();
                  const active = genre === value;
                  return (
                    <TouchableOpacity
                      key={g}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => { setGenre(value); setShowGenre(false); }}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{genreLabel(g)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Polished success card — confirm opens the new community, Done returns. */}
        <ConfirmDialog
          visible={!!createdId}
          icon="sparkles"
          title={t('communities.createdTitle')}
          message={t('communities.createdBody', { name: name.trim() })}
          confirmLabel={t('communities.viewCommunity')}
          cancelLabel={t('communities.done')}
          onConfirm={() => { const goId = createdId; setCreatedId(null); if (goId) router.replace(`/communities/${goId}`); }}
          onCancel={() => { setCreatedId(null); router.back(); }}
        />
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
  headerBtn: { width: 56, height: 36, justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  headerAction: { width: 56, alignItems: 'flex-end', paddingRight: SPACING.xs },
  headerActionText: { color: colors.primary, fontSize: 16, fontWeight: '700' },

  content: { padding: SPACING.md, gap: SPACING.lg, flexGrow: 1 },
  field: { gap: 8 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  hint: { color: colors.textTertiary, fontSize: 12, marginTop: -2 },

  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
  },
  input: { flex: 1, paddingVertical: SPACING.md, color: colors.text, fontSize: 15 },
  errText: { color: colors.error, fontSize: 12 },
  okText: { color: colors.success, fontSize: 12 },

  dropdown: {
    flexDirection: 'row', alignItems: 'center', minHeight: 50,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
  },
  dropdownText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  dropdownPlaceholder: { color: colors.textTertiary, fontWeight: '500' },

  textarea: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.md, minHeight: 88,
    color: colors.text, fontSize: 15,
  },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },

  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.xs,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarInitial: { color: '#fff', fontSize: 16, fontWeight: '700' },
  resultInfo: { flex: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  resultName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  resultUser: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  inviteeList: { gap: SPACING.xs, marginTop: SPACING.xs },
  inviteeRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  avatarSm: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarInitialSm: { color: '#fff', fontSize: 14, fontWeight: '700' },
  mgrToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 5,
  },
  mgrToggleOn: { borderColor: colors.gold, backgroundColor: colors.gold + '1A' },
  // Available (Gold+, not yet a manager) → light-blue fill with white text.
  mgrToggleAvailable: { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  mgrToggleDisabled: { opacity: 0.6 },
  mgrToggleText: { fontSize: 11, fontWeight: '700' },
  needsGoldNote: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 },
  needsGoldText: { color: colors.textTertiary, fontSize: 11, fontWeight: '600' },

  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  gateTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  gateSub: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  // genre sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl, maxHeight: '70%',
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: SPACING.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, paddingBottom: SPACING.sm },
  chip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary + '22', borderColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.primary },
});
