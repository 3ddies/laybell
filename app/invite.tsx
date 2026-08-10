import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList,
  ActivityIndicator, Alert, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../components/SwipeBackPager';
import { Skeleton } from '../components/Skeleton';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { loadInviteContacts, openInviteComposer, recordInvites, type InviteContact } from '../lib/appShare';
import { STATIC_WEB_ORIGIN } from '../lib/appLinks';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';

// Invite friends → the App-sharing (Advocate) badge.
//
// The badge counts DISTINCT PEOPLE, so this screen is built around that: anyone
// already invited is ticked off permanently and cannot be selected again. That
// is a feature, not a restriction — it is what stops the badge being farmed by
// sharing to the same person over and over, and it tells the user exactly who is
// left to reach.
//
// Names never leave the device; only salted hashes are recorded (lib/appShare).

const BRONZE_AT = 1, SILVER_AT = 8, GOLD_AT = 15;

export default function InviteScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  const [contacts, setContacts] = useState<InviteContact[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await loadInviteContacts();
      setContacts(list);
      setDenied(list.length === 0);
    } catch {
      // A failed read of "who did I already invite" must not show everyone as
      // un-invited — that would push duplicate sends. Show the retry state.
      setContacts([]);
      setDenied(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const invitedCount = useMemo(
    () => (contacts ?? []).filter((c) => c.invited).length, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts ?? [];
    return (contacts ?? []).filter((c) => c.name.toLowerCase().includes(q) || c.label.includes(q));
  }, [contacts, query]);

  const toggle = (c: InviteContact) => {
    if (c.invited) return; // already counted — permanently ticked off
    setPicked((prev) => {
      const n = new Set(prev);
      n.has(c.hash) ? n.delete(c.hash) : n.add(c.hash);
      return n;
    });
  };

  async function send() {
    const chosen = (contacts ?? []).filter((c) => picked.has(c.hash));
    if (!chosen.length || sending) return;
    setSending(true);
    try {
      const opened = await openInviteComposer(chosen, t('invite.message', { url: `${STATIC_WEB_ORIGIN}/open.html` }));
      if (!opened) { Alert.alert(t('invite.noComposerTitle'), t('invite.noComposerBody')); return; }
      // Recorded once the composer opened. We cannot see whether they hit send
      // inside the system composer — and the alternative (never counting) would
      // make the badge unreachable. Duplicate protection lives in the hash key,
      // so the worst case is a contact ticked off slightly early, not inflation.
      const total = await recordInvites(chosen);
      setPicked(new Set());
      setContacts((prev) => (prev ?? []).map((c) =>
        picked.has(c.hash) ? { ...c, invited: true } : c));
      if (total != null) {
        const hit = total >= GOLD_AT ? t('invite.badgeGold')
          : total >= SILVER_AT ? t('invite.badgeSilver')
          : total >= BRONZE_AT ? t('invite.badgeBronze') : '';
        if (hit) Alert.alert(t('invite.sentTitle'), hit);
      }
    } finally {
      setSending(false);
    }
  }

  const next = invitedCount >= GOLD_AT ? null : invitedCount >= SILVER_AT ? GOLD_AT : invitedCount >= BRONZE_AT ? SILVER_AT : BRONZE_AT;
  const pickedCount = picked.size;

  return (
    <SwipeBackPager>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12}
            accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('invite.title')}</Text>
          <View style={{ width: 26 }} />
        </View>

        {/* Progress toward the Advocate badge — the reason to be here. */}
        <LinearGradient colors={GRADIENTS.primary as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
          <Text style={styles.heroCount}>{invitedCount}</Text>
          <Text style={styles.heroLabel}>
            {next ? t('invite.progress', { next: String(next) }) : t('invite.progressDone')}
          </Text>
        </LinearGradient>

        {contacts === null ? (
          <View style={styles.list}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} width="100%" height={56} radius={RADIUS.md} />
            ))}
          </View>
        ) : denied ? (
          <View style={styles.center}>
            <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyText}>{t('invite.permissionBody')}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={() => Linking.openSettings()}>
              <Text style={styles.retryText}>{t('invite.openSettings')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={16} color={colors.textTertiary} />
              <TextInput
                style={styles.search}
                placeholder={t('invite.search')}
                placeholderTextColor={colors.textTertiary}
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
              />
            </View>
            <FlatList
              data={filtered}
              keyExtractor={(c) => c.hash}
              contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const on = picked.has(item.hash);
                return (
                  <TouchableOpacity
                    style={styles.row}
                    activeOpacity={item.invited ? 1 : 0.7}
                    onPress={() => toggle(item)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: item.invited || on, disabled: item.invited }}
                    accessibilityLabel={item.name}
                  >
                    <View style={[styles.check, (on || item.invited) && styles.checkOn,
                      item.invited && styles.checkDone]}>
                      {(on || item.invited) && <Ionicons name="checkmark" size={15} color="#fff" />}
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={[styles.rowName, item.invited && styles.rowDim]} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.rowLabel} numberOfLines={1}>
                        {item.invited ? t('invite.alreadyInvited') : item.label}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
            {pickedCount > 0 && (
              <View style={[styles.sendBar, { paddingBottom: insets.bottom + SPACING.sm }]}>
                <TouchableOpacity onPress={send} disabled={sending} activeOpacity={0.9} style={styles.sendBtn}>
                  <LinearGradient colors={GRADIENTS.primary as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.sendInner}>
                    {sending
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={styles.sendText}>{t('invite.send', { count: String(pickedCount) })}</Text>}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  title: { color: c.text, fontSize: 22, fontWeight: '900', letterSpacing: -0.4 },

  hero: {
    margin: SPACING.md, borderRadius: RADIUS.xl,
    paddingVertical: SPACING.lg, alignItems: 'center', gap: 2,
  },
  heroCount: { color: '#fff', fontSize: 40, fontWeight: '900' },
  heroLabel: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '600', textAlign: 'center', paddingHorizontal: SPACING.md },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: 9,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.full,
  },
  search: { flex: 1, color: c.text, fontSize: 15, padding: 0 },

  list: { paddingHorizontal: SPACING.md, gap: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, paddingVertical: 11,
  },
  check: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 1.5, borderColor: c.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { backgroundColor: c.primary, borderColor: c.primary },
  // Already invited reads as DONE, not as selected — a settled grey, so the
  // orange only ever means "about to send".
  checkDone: { backgroundColor: c.textTertiary, borderColor: c.textTertiary },
  rowBody: { flex: 1, gap: 1 },
  rowName: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowDim: { color: c.textSecondary },
  rowLabel: { color: c.textTertiary, fontSize: 12 },

  sendBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm,
    backgroundColor: c.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
  },
  sendBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  sendInner: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md },
  sendText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { color: c.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retryBtn: {
    marginTop: SPACING.xs, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full, backgroundColor: c.surfaceLight,
  },
  retryText: { color: c.text, fontSize: 14, fontWeight: '700' },
});
