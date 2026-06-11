import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Switch, Alert, Image,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useRef } from 'react';
import PagerView from 'react-native-pager-view';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import BadgeEmblem from '../components/BadgeEmblem';
import { displayedTier } from '../lib/badges';
import {
  loadNotifPrefs, saveNotifPrefs, type NotifPrefs,
} from '../lib/notificationPrefs';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

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
          color={item.destructive ? COLORS.error : COLORS.text}
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
          trackColor={{ false: COLORS.border, true: COLORS.primary + '88' }}
          thumbColor={item.value ? COLORS.primary : COLORS.textTertiary}
        />
      ) : item.chevron !== false ? (
        <Ionicons name="chevron-forward" size={16} color={COLORS.textTertiary} />
      ) : null}
    </TouchableOpacity>
  );
}

function Section({ title, items }: { title: string; items: SectionItem[] }) {
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
  // Swipe-right-to-go-back via a native pager dismiss page — same mechanism the
  // profile screens use. The native pager arbitrates with the inner vertical
  // ScrollView (like the home/explore tabs), so vertical scrolling never triggers
  // an accidental horizontal exit, while swiping right anywhere still goes back.
  const pagerRef = useRef<PagerView>(null);

  // Per-category notification toggles (persisted locally). The "All" row is
  // derived — on when every category is on, and flips all of them at once.
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({
    likes: true, comments: true, follows: true, messages: true,
  });
  useEffect(() => { loadNotifPrefs().then(setNotifPrefs); }, []);

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

  async function handleDeleteAccount() {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account and all your posts. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => {
          Alert.alert('Contact Support', 'Please email support@laybell.app to delete your account.');
        }},
      ]
    );
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
      icon: 'ribbon-outline',
      label: 'Badges',
      subtitle: 'Your emblem, rewards & progress',
      onPress: () => router.push('/badges'),
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

  const aboutItems: SectionItem[] = [
    {
      icon: 'information-circle-outline',
      label: 'Version',
      subtitle: APP_VERSION,
      chevron: false,
      onPress: undefined,
    },
    {
      icon: 'document-text-outline',
      label: 'Privacy Policy',
      onPress: () => Alert.alert('Privacy Policy', 'Coming soon at laybell.app/privacy'),
    },
    {
      icon: 'shield-outline',
      label: 'Terms of Service',
      onPress: () => Alert.alert('Terms of Service', 'Coming soon at laybell.app/terms'),
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
    <View style={styles.container}>
      {/* The pager owns the back-swipe, so turn off the stack's own gesture
          (otherwise the two horizontal gestures fight — exactly the profile pattern). */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Pager: page 0 is the dismiss page (swipe right off the content → go back);
          page 1 is the settings ScrollView. One pager, no nesting → can't glitch. */}
      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={1}
        onPageSelected={(e) => {
          if (e.nativeEvent.position === 0) {
            if (router.canGoBack()) router.back();
            else pagerRef.current?.setPageWithoutAnimation(1);
          }
        }}
      >
        <View key="dismiss" style={styles.dismissPage} />
        <View key="content" style={styles.page}>
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
            <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
          </TouchableOpacity>
        )}

        <Section title="Account" items={accountItems} />
        <Section title="Notifications" items={notifItems} />
        <Section title="About" items={aboutItems} />
        <Section title="" items={dangerItems} />

        <Text style={styles.madeWith}>Made with 🧡 for artists everywhere</Text>
      </ScrollView>
        </View>
      </PagerView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(255,255,255,0.07)',
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },

  pager: { flex: 1 },
  page: { flex: 1 },
  dismissPage: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, gap: SPACING.lg, paddingBottom: SPACING.xxl },

  profileCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.xl, padding: SPACING.md,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', gap: SPACING.md,
    marginBottom: SPACING.xs,
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  profileAvatar: {
    width: 60, height: 60, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.10)',
  },
  profileAvatarText: { color: COLORS.text, fontSize: 22, fontWeight: '800' },
  profileInfo: { flex: 1, gap: 1 },
  profileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: { color: COLORS.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3, flexShrink: 1 },
  profileUsername: { color: COLORS.textSecondary, fontSize: 13 },
  profileEdit: { color: COLORS.primaryLight, fontSize: 12, fontWeight: '600', marginTop: 3 },

  section: { gap: SPACING.sm },
  sectionTitle: {
    color: COLORS.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: SPACING.xs,
  },
  sectionCard: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
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
  rowLabel: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  rowLabelDestructive: { color: COLORS.error },
  rowSubtitle: { color: COLORS.textSecondary, fontSize: 12, marginTop: 1 },

  separator: { height: 0.5, backgroundColor: 'rgba(255,255,255,0.06)', marginLeft: SPACING.md + 28 + SPACING.md },

  madeWith: {
    color: COLORS.textTertiary, fontSize: 13,
    textAlign: 'center', paddingVertical: SPACING.lg,
  },
});
