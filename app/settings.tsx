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
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => supabase.auth.signOut() },
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
    if (error) { Alert.alert('Could not update', error.message); return false; }
    setHiddenOn(on);
    return true;
  }

  function toggleHidden(next: boolean) {
    if (next) {
      Alert.alert(
        'Hide your profile?',
        'Your account becomes invisible to everyone — profile, posts, stories and playlists disappear from Laybell. You can still browse and listen, and unhide here anytime.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Hide Profile', onPress: () => setHidden(true) },
        ],
      );
    } else {
      setHidden(false).then((ok) => {
        if (ok) Alert.alert('Welcome back', 'Your profile is visible again. Any scheduled deletion has been cancelled.');
      });
    }
  }

  async function handleDeleteAccount() {
    Alert.alert(
      'Delete Account',
      'Before you go — you can hide your account instead. It disappears from Laybell, and if you stay away for 3 months it gets deleted permanently. Coming back and unhiding cancels everything.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Hide for 3 months',
          onPress: async () => {
            const ok = await setHidden(true, { delete_requested_at: new Date().toISOString(), delete_immediately: false });
            if (ok) {
              Alert.alert(
                'Profile hidden',
                'Your account is now invisible. If you stay away for 3 months it will be permanently deleted — unhide in Settings anytime to cancel.',
              );
            }
          },
        },
        {
          text: 'Delete now',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Delete permanently?',
              'This cannot be undone. Your account and everything you posted will be removed.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete', style: 'destructive',
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
                      Alert.alert('Account deleted', reported
                        ? 'Your account has been deleted and you have been signed out.'
                        : 'Your account has been deleted and you have been signed out. It is permanently removed after 48 hours — after that, you can use this email to create a new account.');
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
      Alert.alert('18+ only', 'Spotlight and the Ad Manager are available only to users who are at least 18 years old.');
      return;
    }
    action();
  }

  const accountItems: SectionItem[] = [
    {
      icon: 'person-outline',
      label: 'Edit Profile',
      subtitle: profile ? `@${profile.username}` : undefined,
      onPress: () => router.push('/edit-profile'),
    },
    {
      icon: 'people-outline',
      label: 'Friends',
      subtitle: 'People you both follow + discover more',
      onPress: () => router.push('/friends'),
    },
    {
      icon: 'stats-chart-outline',
      label: 'Creator Analytics',
      subtitle: 'Stats & charts about your content',
      onPress: () => router.push('/analytics'),
    },
    {
      icon: 'sparkles-outline',
      label: 'Spotlight',
      subtitle: 'Launch a post at #3 in the Home feed',
      onPress: () => requireAdult(() => router.push('/spotlight')),
    },
    {
      icon: 'megaphone-outline',
      label: 'Ad Manager',
      subtitle: 'Create and manage ad campaigns',
      onPress: () => requireAdult(() => router.push('/ad-manager')),
    },
    {
      icon: 'ribbon-outline',
      label: 'Badges',
      subtitle: 'Your emblem, rewards & progress',
      onPress: () => router.push('/badges'),
    },
    {
      icon: 'albums-outline',
      label: 'Playlists',
      subtitle: 'Public, private & locked playlists',
      onPress: () => router.push('/playlists'),
    },
    {
      icon: 'at-outline',
      label: 'Tagged',
      subtitle: 'Mentions, your audio used & more',
      onPress: () => router.push('/tagged'),
    },
    {
      icon: 'repeat-outline',
      label: 'Reposts',
      subtitle: 'See who reposted your posts',
      onPress: () => router.push('/reposts'),
    },
    {
      icon: 'lock-closed-outline',
      label: 'Private Posts',
      subtitle: 'Posts only your friends can see',
      onPress: () => router.push('/private-posts'),
    },
    {
      icon: 'eye-off-outline',
      label: 'Hide Profile',
      subtitle: 'Make your account invisible to others',
      value: hiddenOn,
      onValueChange: toggleHidden,
    },
    {
      icon: 'archive-outline',
      label: 'Archive',
      subtitle: 'Posts and stories you archived',
      onPress: () => router.push('/archive'),
    },
    {
      icon: 'ban-outline',
      label: 'Blocked',
      subtitle: 'Accounts you blocked',
      onPress: () => router.push('/blocked'),
    },
    {
      icon: 'options-outline',
      label: 'Permissions',
      subtitle: 'Camera, photos, location, contacts & more',
      onPress: () => router.push('/permissions'),
    },
    {
      icon: 'shield-checkmark-outline',
      label: 'Privacy & data',
      subtitle: 'Download your data, ad settings & your rights',
      onPress: () => router.push('/privacy-center'),
    },
    {
      icon: 'lock-closed-outline',
      label: 'Change Password',
      onPress: () => Alert.alert('Change Password', 'A password reset email will be sent to your registered address.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send Email', onPress: async () => {
          const { data: { user } } = await supabase.auth.getUser();
          if (user?.email) await supabase.auth.resetPasswordForEmail(user.email);
          Alert.alert('Email Sent', 'Check your inbox for a password reset link.');
        }},
      ]),
    },
  ];

  const notifItems: SectionItem[] = [
    {
      icon: 'notifications-outline',
      label: 'All notifications',
      subtitle: 'Turn every alert on or off',
      value: allNotifsOn,
      onValueChange: setAllNotifs,
      chevron: false,
    },
    {
      icon: 'heart-outline',
      label: 'Likes',
      value: notifPrefs.likes,
      onValueChange: (v) => setNotifPref('likes', v),
      chevron: false,
    },
    {
      icon: 'chatbubble-outline',
      label: 'Comments',
      value: notifPrefs.comments,
      onValueChange: (v) => setNotifPref('comments', v),
      chevron: false,
    },
    {
      icon: 'person-add-outline',
      label: 'New Followers',
      value: notifPrefs.follows,
      onValueChange: (v) => setNotifPref('follows', v),
      chevron: false,
    },
    {
      icon: 'mail-outline',
      label: 'Messages',
      value: notifPrefs.messages,
      onValueChange: (v) => setNotifPref('messages', v),
      chevron: false,
    },
  ];

  const adItems: SectionItem[] = [
    {
      icon: 'shield-checkmark-outline',
      label: 'Limit ad targeting',
      subtitle: "Don't use my activity to personalize ads",
      value: limitAds,
      onValueChange: toggleLimitAds,
      chevron: false,
    },
  ];

  const aboutItems: SectionItem[] = [
    {
      icon: 'information-circle-outline',
      label: 'Version',
      subtitle: APP_VERSION,
      chevron: false,
      onPress: undefined,
    },
    {
      icon: 'help-circle-outline',
      label: 'Help',
      subtitle: 'Help center — coming soon',
      onPress: () => Alert.alert('Help', 'The help center is coming soon.'),
    },
    {
      icon: 'document-text-outline',
      label: 'Privacy Policy',
      onPress: () => router.push('/privacy-policy'),
    },
    {
      icon: 'shield-outline',
      label: 'Terms of Service',
      onPress: () => router.push('/terms-of-service'),
    },
    {
      icon: 'people-outline',
      label: 'Community Guidelines',
      onPress: () => router.push('/community-guidelines'),
    },
    {
      icon: 'megaphone-outline',
      label: 'Advertiser Terms',
      onPress: () => router.push('/advertiser-terms'),
    },
  ];

  const dangerItems: SectionItem[] = [
    {
      icon: 'log-out-outline',
      label: 'Log Out',
      onPress: handleLogout,
      destructive: true,
      chevron: false,
    },
    {
      icon: 'trash-outline',
      label: 'Delete Account',
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
        <Text style={styles.headerTitle}>Settings</Text>
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
              <Text style={styles.profileEdit}>View and edit profile</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        )}

        {/* Display — choose the app's color scheme (applies live). */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Display</Text>
          <View style={styles.sectionCard}>
            {DISPLAY_MODES.map((m, i) => (
              <View key={m.key}>
                <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => setMode(m.key)}>
                  <View style={[styles.swatch, { backgroundColor: m.swatch, borderColor: m.ring }]} />
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>{m.label}</Text>
                    <Text style={styles.rowSubtitle}>{m.sub}</Text>
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

        <Section title="Account" items={accountItems} />
        <Section title="Notifications" items={notifItems} />
        <Section title="Ads" items={adItems} />
        <Section title="About" items={aboutItems} />
        <Section title="" items={dangerItems} />

        <Text style={styles.madeWith}>Made with 🧡 for artists everywhere</Text>
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
