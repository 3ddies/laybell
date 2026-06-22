import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Switch, Alert, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { LANGUAGES } from '../lib/i18n';
import BadgeEmblem from '../components/BadgeEmblem';
import SwipeBackPager from '../components/SwipeBackPager';
import { displayedTier } from '../lib/badges';
import {
  loadNotifPrefs, saveNotifPrefs, type NotifPrefs,
} from '../lib/notificationPrefs';
import { isAdPersonalizationEnabled, setAdPersonalization } from '../lib/adPrefs';
import { SPACING, RADIUS, GRADIENTS, type ThemeMode, type ThemePalette } from '../constants/theme';

// The three display modes shown in the Settings → Display section.
const DISPLAY_MODES: { key: ThemeMode; label: string; sub: string; swatch: string; ring: string }[] = [
  { key: 'dark',  label: 'Dark',  sub: 'Black background',  swatch: '#090909', ring: '#2A2A2A' },
  { key: 'grey',  label: 'Grey',  sub: 'Lighter graphite',  swatch: '#2B2B2F', ring: '#54545C' },
  { key: 'light', label: 'Light', sub: 'Soft white',        swatch: '#F2F2F6', ring: '#DCDCE2' },
];

const APP_VERSION = '1.0.0';

type SectionItem = {
  icon: any;
  label: string;
  onPress?: () => void;
  value?: boolean;
  onValueChange?: (v: boolean) => void;
  destructive?: boolean;
  chevron?: boolean;
  subtitle?: string;
};

function SettingsRow({ item }: { item: SectionItem }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={item.onPress}
      disabled={!item.onPress && item.value === undefined}
      activeOpacity={item.onPress ? 0.7 : 1}
    >
      <View style={styles.rowIcon}>
        <Ionicons
          name={item.icon}
          size={22}
          color={item.destructive ? colors.error : colors.text}
        />
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.rowLabel, item.destructive && styles.rowLabelDestructive]}>
          {item.label}
        </Text>
        {item.subtitle && <Text style={styles.rowSubtitle}>{item.subtitle}</Text>}
      </View>
      {item.value !== undefined ? (
        <Switch
          value={item.value}
          onValueChange={item.onValueChange}
          trackColor={{ false: colors.border, true: colors.primary + '88' }}
          thumbColor={item.value ? colors.primary : colors.textTertiary}
        />
      ) : item.chevron !== false ? (
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      ) : null}
    </TouchableOpacity>
  );
}

function Section({ title, items }: { title: string; items: SectionItem[] }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>
        {items.map((item, i) => (
          <View key={item.label}>
            <SettingsRow item={item} />
            {i < items.length - 1 && <View style={styles.separator} />}
          </View>
        ))}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { profile } = useProfile();
  // Mirrors profiles.hidden (the switch needs local state for instant feedback).
  const [hiddenOn, setHiddenOn] = useState(false);
  useEffect(() => { setHiddenOn(!!(profile as any)?.hidden); }, [profile]);
  const { colors, mode, setMode } = useTheme();
  const { t, lang, setLang, autoTranslate, setAutoTranslate } = useTranslation();
  const styles = useThemedStyles(makeStyles);

  // Per-category notification toggles (persisted locally). The "All" row is
  // derived — on when every category is on, and flips all of them at once.
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({
    likes: true, comments: true, follows: true, messages: true,
  });
  useEffect(() => { loadNotifPrefs().then(setNotifPrefs); }, []);

  // Ad personalization opt-out ("Limit ad targeting"). The switch shows the
  // INVERSE of the stored pref (on = limit = personalization off).
  const [limitAds, setLimitAds] = useState(false);
  useEffect(() => { isAdPersonalizationEnabled().then((on) => setLimitAds(!on)); }, []);
  function toggleLimitAds(v: boolean) { setLimitAds(v); setAdPersonalization(!v); }

  const allNotifsOn = notifPrefs.likes && notifPrefs.comments && notifPrefs.follows && notifPrefs.messages;

  function setNotifPref(key: keyof NotifPrefs, value: boolean) {
    const next = { ...notifPrefs, [key]: value };
    setNotifPrefs(next);
    saveNotifPrefs(next);
  }
  function setAllNotifs(value: boolean) {
    const next: NotifPrefs = { likes: value, comments: value, follows: value, messages: value };
    setNotifPrefs(next);
    saveNotifPrefs(next);
  }

  async function handleLogout() {
    Alert.alert(t('logout.title'), t('logout.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('danger.logout'), style: 'destructive', onPress: () => supabase.auth.signOut() },
    ]);
  }

  // ── Hide profile / soft deletion ─────────────────────────────────────────
  // hidden=true makes the account invisible to others (server-side restrictive
  // policies hide posts/stories/playlists; the profile page blocks). The owner
  // can still browse + listen — but not DM or comment — and unhide anytime.
  async function setHidden(on: boolean, extra: Record<string, any> = {}) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const patch = on
      ? { hidden: true, ...extra }
      // Unhiding also CANCELS any pending deletion (the 3-month grace path).
      : { hidden: false, delete_requested_at: null, delete_immediately: false };
    const { error } = await supabase.from('profiles').update(patch).eq('id', user.id);
    if (error) { Alert.alert(t('hide.couldNotUpdate'), error.message); return false; }
    setHiddenOn(on);
    return true;
  }

  function toggleHidden(next: boolean) {
    if (next) {
      Alert.alert(
        t('hide.confirmTitle'),
        t('hide.confirmBody'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('account.hideProfile'), onPress: () => setHidden(true) },
        ],
      );
    } else {
      setHidden(false).then((ok) => {
        if (ok) Alert.alert(t('hide.welcomeBackTitle'), t('hide.welcomeBackBody'));
      });
    }
  }

  async function handleDeleteAccount() {
    Alert.alert(
      t('danger.deleteAccount'),
      t('delete.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('delete.hide3mo'),
          onPress: async () => {
            const ok = await setHidden(true, { delete_requested_at: new Date().toISOString(), delete_immediately: false });
            if (ok) {
              Alert.alert(t('delete.hiddenTitle'), t('delete.hiddenBody'));
            }
          },
        },
        {
          text: t('delete.deleteNow'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              t('delete.permTitle'),
              t('delete.permBody'),
              [
                { text: t('common.cancel'), style: 'cancel' },
                {
                  text: t('common.delete'), style: 'destructive',
                  onPress: async () => {
                    const ok = await setHidden(true, { delete_requested_at: new Date().toISOString(), delete_immediately: true });
                    if (ok) {
                      // Flag now — access stops immediately via sign-out + the _layout
                      // login guard — and the account is HARD-DELETED 48h later by the
                      // sweep, which frees the email for reuse. Reported accounts are
                      // excluded (handled manually), so DON'T promise them the 48h email
                      // reuse — it would be misleading. Check before signOut (RPC needs auth).
                      let reported = false;
                      try { const { data } = await supabase.rpc('current_account_has_reports'); reported = data === true; } catch {}
                      await supabase.auth.signOut();
                      Alert.alert(t('delete.doneTitle'), reported
                        ? t('delete.doneReported')
                        : t('delete.doneClean'));
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }

  // Paid advertising features (Spotlight, Ad Manager) are 18+ per the Terms of
  // Service. Block users we KNOW to be under 18 (age is set during onboarding);
  // if age is unknown we allow it, since we can't determine it.
  function requireAdult(action: () => void) {
    const age = (profile as any)?.age;
    if (typeof age === 'number' && age < 18) {
      Alert.alert(t('adult.title'), t('adult.body'));
      return;
    }
    action();
  }

  const accountItems: SectionItem[] = [
    {
      icon: 'person-outline',
      label: t('account.editProfile'),
      subtitle: profile ? `@${profile.username}` : undefined,
      onPress: () => router.push('/edit-profile'),
    },
    {
      icon: 'people-outline',
      label: t('account.friends'),
      subtitle: t('account.friendsSub'),
      onPress: () => router.push('/friends'),
    },
    {
      icon: 'stats-chart-outline',
      label: t('account.analytics'),
      subtitle: t('account.analyticsSub'),
      onPress: () => router.push('/analytics'),
    },
    {
      icon: 'sparkles-outline',
      label: 'Spotlight',
      subtitle: t('account.spotlightSub'),
      onPress: () => requireAdult(() => router.push('/spotlight')),
    },
    {
      icon: 'megaphone-outline',
      label: t('account.adManager'),
      subtitle: t('account.adManagerSub'),
      onPress: () => requireAdult(() => router.push('/ad-manager')),
    },
    {
      icon: 'ribbon-outline',
      label: t('account.badges'),
      subtitle: t('account.badgesSub'),
      onPress: () => router.push('/badges'),
    },
    {
      icon: 'albums-outline',
      label: t('account.playlists'),
      subtitle: t('account.playlistsSub'),
      onPress: () => router.push('/playlists'),
    },
    {
      icon: 'at-outline',
      label: t('account.tagged'),
      subtitle: t('account.taggedSub'),
      onPress: () => router.push('/tagged'),
    },
    {
      icon: 'repeat-outline',
      label: t('account.reposts'),
      subtitle: t('account.repostsSub'),
      onPress: () => router.push('/reposts'),
    },
    {
      icon: 'lock-closed-outline',
      label: t('account.privatePosts'),
      subtitle: t('account.privatePostsSub'),
      onPress: () => router.push('/private-posts'),
    },
    {
      icon: 'eye-off-outline',
      label: t('account.hideProfile'),
      subtitle: t('account.hideProfileSub'),
      value: hiddenOn,
      onValueChange: toggleHidden,
    },
    {
      icon: 'archive-outline',
      label: t('account.archive'),
      subtitle: t('account.archiveSub'),
      onPress: () => router.push('/archive'),
    },
    {
      icon: 'ban-outline',
      label: t('account.blocked'),
      subtitle: t('account.blockedSub'),
      onPress: () => router.push('/blocked'),
    },
    {
      icon: 'options-outline',
      label: t('account.permissions'),
      subtitle: t('account.permissionsSub'),
      onPress: () => router.push('/permissions'),
    },
    {
      icon: 'shield-checkmark-outline',
      label: t('account.privacy'),
      subtitle: t('account.privacySub'),
      onPress: () => router.push('/privacy-center'),
    },
    {
      icon: 'lock-closed-outline',
      label: t('account.changePassword'),
      onPress: () => Alert.alert(t('account.changePassword'), t('cpw.body'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('cpw.send'), onPress: async () => {
          const { data: { user } } = await supabase.auth.getUser();
          if (user?.email) await supabase.auth.resetPasswordForEmail(user.email);
          Alert.alert(t('cpw.sentTitle'), t('cpw.sentBody'));
        }},
      ]),
    },
  ];

  const notifItems: SectionItem[] = [
    {
      icon: 'notifications-outline',
      label: t('notif.all'),
      subtitle: t('notif.allSub'),
      value: allNotifsOn,
      onValueChange: setAllNotifs,
      chevron: false,
    },
    {
      icon: 'heart-outline',
      label: t('notif.likes'),
      value: notifPrefs.likes,
      onValueChange: (v) => setNotifPref('likes', v),
      chevron: false,
    },
    {
      icon: 'chatbubble-outline',
      label: t('notif.comments'),
      value: notifPrefs.comments,
      onValueChange: (v) => setNotifPref('comments', v),
      chevron: false,
    },
    {
      icon: 'person-add-outline',
      label: t('notif.newFollowers'),
      value: notifPrefs.follows,
      onValueChange: (v) => setNotifPref('follows', v),
      chevron: false,
    },
    {
      icon: 'mail-outline',
      label: t('notif.messages'),
      value: notifPrefs.messages,
      onValueChange: (v) => setNotifPref('messages', v),
      chevron: false,
    },
  ];

  const adItems: SectionItem[] = [
    {
      icon: 'shield-checkmark-outline',
      label: t('ads.limit'),
      subtitle: t('ads.limitSub'),
      value: limitAds,
      onValueChange: toggleLimitAds,
      chevron: false,
    },
  ];

  const aboutItems: SectionItem[] = [
    {
      icon: 'information-circle-outline',
      label: t('about.version'),
      subtitle: APP_VERSION,
      chevron: false,
      onPress: undefined,
    },
    {
      icon: 'help-circle-outline',
      label: t('about.help'),
      subtitle: t('about.helpSub'),
      onPress: () => Alert.alert(t('about.help'), t('help.body')),
    },
    {
      icon: 'document-text-outline',
      label: t('about.privacyPolicy'),
      onPress: () => router.push('/privacy-policy'),
    },
    {
      icon: 'shield-outline',
      label: t('about.terms'),
      onPress: () => router.push('/terms-of-service'),
    },
    {
      icon: 'people-outline',
      label: t('about.community'),
      onPress: () => router.push('/community-guidelines'),
    },
    {
      icon: 'megaphone-outline',
      label: t('about.advertiserTerms'),
      onPress: () => router.push('/advertiser-terms'),
    },
  ];

  const dangerItems: SectionItem[] = [
    {
      icon: 'log-out-outline',
      label: t('danger.logout'),
      onPress: handleLogout,
      destructive: true,
      chevron: false,
    },
    {
      icon: 'trash-outline',
      label: t('danger.deleteAccount'),
      onPress: handleDeleteAccount,
      destructive: true,
      chevron: false,
    },
  ];

  return (
    // Swipe right anywhere to slide the whole page (header included) off and
    // reveal the screen underneath — one motion, same feel as the tab pager.
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('settings.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Profile card */}
        {profile && (
          <TouchableOpacity style={styles.profileCard} onPress={() => router.push('/edit-profile')}>
            {profile.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={styles.profileAvatar} />
            ) : (
              <LinearGradient colors={GRADIENTS.primary} style={styles.profileAvatar}>
                <Text style={styles.profileAvatarText}>
                  {profile.display_name?.charAt(0).toUpperCase()}
                </Text>
              </LinearGradient>
            )}
            <View style={styles.profileInfo}>
              <View style={styles.profileNameRow}>
                <Text style={styles.profileName} numberOfLines={1}>{profile.display_name}</Text>
                <BadgeEmblem tier={displayedTier(profile)} size={16} />
              </View>
              <Text style={styles.profileUsername} numberOfLines={1}>@{profile.username}</Text>
              <Text style={styles.profileEdit}>{t('settings.viewEditProfile')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        )}

        {/* Display — choose the app's color scheme (applies live). */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.section.display')}</Text>
          <View style={styles.sectionCard}>
            {DISPLAY_MODES.map((m, i) => (
              <View key={m.key}>
                <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => setMode(m.key)}>
                  <View style={[styles.swatch, { backgroundColor: m.swatch, borderColor: m.ring }]} />
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>{t(`display.${m.key}`)}</Text>
                    <Text style={styles.rowSubtitle}>{t(`display.${m.key}Sub`)}</Text>
                  </View>
                  {mode === m.key
                    ? <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                    : <View style={styles.radioOff} />}
                </TouchableOpacity>
                {i < DISPLAY_MODES.length - 1 && <View style={styles.separator} />}
              </View>
            ))}
          </View>
        </View>

        {/* Language — choose the app's language (applies live, persisted). Each row
            shows the language's own name with its English name underneath. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.section.language')}</Text>
          <View style={styles.sectionCard}>
            {LANGUAGES.map((l, i) => (
              <View key={l.code}>
                <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => setLang(l.code)}>
                  <View style={styles.rowIcon}>
                    <Ionicons name="language-outline" size={22} color={colors.text} />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>{l.native}</Text>
                    <Text style={styles.rowSubtitle}>{l.label}</Text>
                  </View>
                  {lang === l.code
                    ? <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                    : <View style={styles.radioOff} />}
                </TouchableOpacity>
                {i < LANGUAGES.length - 1 && <View style={styles.separator} />}
              </View>
            ))}
            {/* Auto-translate user content (comments/messages/captions/bios) into
                the chosen language. Separate from the static-UI language above. */}
            <View style={styles.separator} />
            <View style={styles.row}>
              <View style={styles.rowIcon}>
                <Ionicons name="globe-outline" size={22} color={colors.text} />
              </View>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>{t('settings.autoTranslate')}</Text>
                <Text style={styles.rowSubtitle}>{t('settings.autoTranslateSub')}</Text>
              </View>
              <Switch
                value={autoTranslate}
                onValueChange={setAutoTranslate}
                trackColor={{ false: colors.border, true: colors.primary + '88' }}
                thumbColor={autoTranslate ? colors.primary : colors.textTertiary}
              />
            </View>
          </View>
        </View>

        <Section title={t('settings.section.account')} items={accountItems} />
        <Section title={t('settings.section.notifications')} items={notifItems} />
        <Section title={t('settings.section.ads')} items={adItems} />
        <Section title={t('settings.section.about')} items={aboutItems} />
        <Section title="" items={dangerItems} />

        <Text style={styles.madeWith}>{t('settings.madeWith')}</Text>
      </ScrollView>
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: c.borderSubtle,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },

  content: { padding: SPACING.md, gap: SPACING.lg, paddingBottom: SPACING.xxl },

  profileCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surfaceLight,
    borderRadius: RADIUS.xl, padding: SPACING.md,
    borderWidth: 1, borderColor: c.border, gap: SPACING.md,
    marginBottom: SPACING.xs,
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  profileAvatar: {
    width: 60, height: 60, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: c.border,
  },
  profileAvatarText: { color: '#FFFFFF', fontSize: 22, fontWeight: '800' },
  profileInfo: { flex: 1, gap: 1 },
  profileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: { color: c.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3, flexShrink: 1 },
  profileUsername: { color: c.textSecondary, fontSize: 13 },
  profileEdit: { color: c.primaryLight, fontSize: 12, fontWeight: '600', marginTop: 3 },

  section: { gap: SPACING.sm },
  sectionTitle: {
    color: c.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: SPACING.xs,
  },
  sectionCard: {
    backgroundColor: c.surfaceLight,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: c.border,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SPACING.sm + 4, paddingHorizontal: SPACING.md, gap: SPACING.md,
  },
  rowIcon: {
    width: 28, alignItems: 'center', justifyContent: 'center',
  },
  rowContent: { flex: 1 },
  rowLabel: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowLabelDestructive: { color: c.error },
  rowSubtitle: { color: c.textSecondary, fontSize: 12, marginTop: 1 },

  // Display-mode color chip + unselected radio.
  swatch: { width: 28, height: 28, borderRadius: RADIUS.sm, borderWidth: 1 },
  radioOff: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: c.border },

  separator: { height: 0.5, backgroundColor: c.border, marginLeft: SPACING.md + 28 + SPACING.md },

  madeWith: {
    color: c.textTertiary, fontSize: 13,
    textAlign: 'center', paddingVertical: SPACING.lg,
  },
});
