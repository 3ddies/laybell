import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import SlideUpSheet from './SlideUpSheet';
import { supabase } from '../lib/supabase';
import {
  listStoredAccounts, switchToAccount, beginAddAccount, removeStoredAccount,
  type StoredAccount,
} from '../lib/accounts';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

type Props = {
  visible: boolean;
  onClose: () => void;
  // The signed-in account, so its row shows even before the store's first write
  // and is marked active.
  currentUserId: string;
  currentUsername?: string | null;
  currentDisplayName?: string | null;
  currentAvatar?: string | null;
};

export default function AccountSwitcher({
  visible, onClose, currentUserId, currentUsername, currentDisplayName, currentAvatar,
}: Props) {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const accent = mode === 'light' ? colors.primary : '#FFFFFF';

  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // userId being switched, or 'add' / 'logout'

  useEffect(() => {
    if (!visible) return;
    // Clear any stale busy state from a previous open. The sheet stays mounted
    // after "Add account" navigates to login, so backing out of that flow would
    // otherwise leave the Add button spinning and disabled on the next open.
    setBusy(null);
    let active = true;
    (async () => {
      const list = await listStoredAccounts();
      if (!active) return;
      // Guarantee the current account appears (and sorts first), even if the
      // store's first write hasn't landed yet on a brand-new sign-in.
      let merged = list;
      if (currentUserId && !list.some((a) => a.userId === currentUserId)) {
        merged = [{
          userId: currentUserId,
          username: currentUsername ?? '',
          displayName: currentDisplayName ?? null,
          avatarUrl: currentAvatar ?? null,
          accessToken: '', refreshToken: '', savedAt: Date.now(),
        }, ...list];
      }
      merged = [...merged].sort((a, b) =>
        a.userId === currentUserId ? -1 : b.userId === currentUserId ? 1 : b.savedAt - a.savedAt);
      setAccounts(merged);
    })();
    return () => { active = false; };
  }, [visible, currentUserId, currentUsername, currentDisplayName, currentAvatar]);

  async function onSwitch(acc: StoredAccount) {
    if (busy || acc.userId === currentUserId) return;
    setBusy(acc.userId);
    const res = await switchToAccount(acc);
    if (!res.ok) {
      setBusy(null);
      setAccounts((prev) => prev.filter((a) => a.userId !== acc.userId));
      Alert.alert(t('accounts.switchFailedTitle'), t('accounts.switchFailedBody'));
      return;
    }
    // Success: the keyed per-user tree in _layout remounts for the new account,
    // which unmounts this sheet. Nothing else to do.
    onClose();
  }

  async function onAdd() {
    if (busy) return;
    setBusy('add');
    // Keeps the current account signed in (so the login screen can be cancelled
    // back to it) and flags "add account" mode for the auth gate.
    await beginAddAccount();
    onClose();
    router.push('/(auth)/login');
    // This sheet stays mounted under the login screen, so release the spinner —
    // otherwise backing out of login would leave the button stuck disabled.
    setBusy(null);
  }

  function onLogout() {
    if (busy) return;
    const others = accounts.filter((a) => a.userId !== currentUserId && a.refreshToken);
    Alert.alert(
      t('accounts.logoutTitle'),
      others.length ? t('accounts.logoutSwitchBody') : t('accounts.logoutBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('danger.logout'),
          style: 'destructive',
          onPress: async () => {
            setBusy('logout');
            await removeStoredAccount(currentUserId);
            if (others.length) {
              // Hop straight to another signed-in account instead of bouncing to
              // the login screen.
              const res = await switchToAccount(others[0]);
              if (!res.ok) await supabase.auth.signOut();
            } else {
              await supabase.auth.signOut(); // last account → full sign-out → login
            }
            onClose();
          },
        },
      ],
    );
  }

  const avatar = (uri: string | null, label: string) => (
    uri
      ? <Image source={{ uri }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" transition={0} />
      : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.avatarInitial}>{(label || '?').trim().charAt(0).toUpperCase()}</Text>
        </View>
      )
  );

  return (
    <SlideUpSheet visible={visible} onClose={onClose} sheetStyle={styles.sheet} dim={0.6}>
      <View style={styles.handle} />
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>{t('accounts.title')}</Text>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
          <Ionicons name="close" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.list}>
        <Text style={styles.sectionLabel}>{t('accounts.onThisDevice')}</Text>
        {accounts.map((acc) => {
          const isCurrent = acc.userId === currentUserId;
          const name = acc.displayName || acc.username || t('accounts.account');
          return (
            <TouchableOpacity
              key={acc.userId}
              style={[styles.row, isCurrent && { borderColor: accent + '55', backgroundColor: accent + '0E' }]}
              onPress={() => onSwitch(acc)}
              disabled={isCurrent || !!busy}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              {avatar(acc.avatarUrl, acc.username || name)}
              <View style={styles.info}>
                <Text style={styles.name} numberOfLines={1}>{name}</Text>
                {!!acc.username && <Text style={styles.handleText} numberOfLines={1}>@{acc.username}</Text>}
              </View>
              {busy === acc.userId
                ? <ActivityIndicator size="small" color={accent} />
                : isCurrent
                  ? <Ionicons name="checkmark-circle" size={24} color={accent} />
                  : <Ionicons name="swap-horizontal" size={22} color={colors.textTertiary} />}
            </TouchableOpacity>
          );
        })}

        {/* Separates your signed-in accounts from the actions below */}
        <View style={styles.divider} />

        {/* Add / log into another account — a CENTERED action pill, visually
            distinct from the left-aligned account cards above. */}
        <TouchableOpacity
          style={[styles.addRow, { borderColor: accent + '40', backgroundColor: accent + '12' }]}
          onPress={onAdd}
          disabled={!!busy}
          activeOpacity={0.7}
          accessibilityRole="button"
        >
          {busy === 'add'
            ? <ActivityIndicator size="small" color={accent} />
            : <Ionicons name="add-circle-outline" size={22} color={accent} />}
          <Text style={[styles.addText, { color: accent }]}>{t('accounts.add')}</Text>
        </TouchableOpacity>

        {/* Log out of the current account — plain text, no icon. */}
        <TouchableOpacity style={styles.logoutRow} onPress={onLogout} disabled={!!busy} activeOpacity={0.7} accessibilityRole="button">
          {busy === 'logout' && <ActivityIndicator size="small" color={colors.error} style={{ marginRight: 8 }} />}
          <Text style={styles.logoutText}>{t('danger.logout')}</Text>
        </TouchableOpacity>
      </View>
    </SlideUpSheet>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '80%', paddingBottom: SPACING.xxl,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.border, alignSelf: 'center', marginTop: SPACING.sm,
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  list: { padding: SPACING.md, gap: SPACING.sm },
  sectionLabel: {
    color: colors.textTertiary, fontSize: 11.5, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginLeft: SPACING.xs, marginBottom: 2,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border,
  },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.avatarBg },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { color: colors.avatarFg, fontSize: 20, fontWeight: '800' },
  info: { flex: 1 },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  handleText: { color: colors.textTertiary, fontSize: 13, marginTop: 1 },
  addRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, borderWidth: 1,
  },
  addText: { fontSize: 15, fontWeight: '800' },
  logoutRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: SPACING.md, marginTop: SPACING.xs,
  },
  logoutText: { color: colors.error, fontSize: 15, fontWeight: '700' },
});
