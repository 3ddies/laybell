import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Switch, Alert, Image, Linking,
  Animated, Easing, AccessibilityInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { passwordResetRedirectUrl } from '../lib/authLink';
import { useProfile } from '../contexts/ProfileContext';
import { useOffline } from '../contexts/OfflineContext';
import { usePremium } from '../contexts/PremiumContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { formatBytes } from '../lib/format';
import { fetchWalletBalance } from '../lib/wallet';
import { fmtCents } from '../lib/donations';
import { LANGUAGES } from '../lib/i18n';
import BadgeEmblem from '../components/BadgeEmblem';
import PremiumBubbles from '../components/PremiumBubbles';
import SwipeBackPager from '../components/SwipeBackPager';
import LanguagePicker from '../components/LanguagePicker';
import ConfirmDialog from '../components/ConfirmDialog';
import Toast from '../components/Toast';
import { displayedTier } from '../lib/badges';
import {
  loadNotifPrefs, saveNotifPrefs, type NotifPrefs,
} from '../lib/notificationPrefs';
import { isAdPersonalizationEnabled, setAdPersonalization } from '../lib/adPrefs';
import { SPACING, RADIUS, GRADIENTS, PLUS_RED, type ThemeMode, type ThemePalette } from '../constants/theme';

// The three display modes shown in the Settings → Display section.
const DISPLAY_MODES: { key: ThemeMode; label: string; sub: string; swatch: string; ring: string }[] = [
  { key: 'dark',  label: 'Dark',  sub: 'Black background',  swatch: '#090909', ring: '#2A2A2A' },
  { key: 'grey',  label: 'Grey',  sub: 'Lighter graphite',  swatch: '#2B2B2F', ring: '#54545C' },
  { key: 'light', label: 'Light', sub: 'Soft white',        swatch: '#F2F2F6', ring: '#DCDCE2' },
];

const APP_VERSION = '1.0.0';
const SUPPORT_EMAIL = 'support@laybell.app';

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

// Tiny scattered "stars" for the Spotlight card's galaxy look — static layout
// (top in px inside the card, left as a %), varied size/brightness so the
// field reads as depth rather than a pattern. Confined to the TEXT-FREE
// columns — around the icon bubble on the left and the chevron on the right —
// so no dot can ever sit under the label/subtitle (which flex-fill the middle
// and may wrap in longer languages).
const GALAXY_STARS = [
  { top: 8, left: '15%', size: 2, opacity: 0.9 },
  { top: 30, left: '8%', size: 1.5, opacity: 0.55 },
  { top: 48, left: '13%', size: 2, opacity: 0.7 },
  { top: 10, left: '90%', size: 1.5, opacity: 0.8 },
  { top: 46, left: '88%', size: 2, opacity: 0.65 },
  // Densified (owner) — still only in the text-free columns. A couple of
  // 2.5px "near" stars among the 1-1.5px "far" ones is what gives the field
  // its depth; opacities stagger so no two neighbours read as a pair.
  { top: 20, left: '4%', size: 1, opacity: 0.45 },
  { top: 56, left: '7%', size: 1.5, opacity: 0.5 },
  { top: 4, left: '10%', size: 1.5, opacity: 0.6 },
  { top: 38, left: '17%', size: 2.5, opacity: 0.85 },
  { top: 26, left: '93%', size: 2.5, opacity: 0.75 },
  { top: 58, left: '91%', size: 1, opacity: 0.5 },
  { top: 6, left: '84%', size: 1, opacity: 0.45 },
  { top: 36, left: '82%', size: 1.5, opacity: 0.6 },
  // Lower band, added when the card grew to match Premium's height. Without
  // these the field stopped ~58px down and the bottom third read as empty sky.
  { top: 68, left: '11%', size: 1.5, opacity: 0.55 },
  { top: 80, left: '5%', size: 2, opacity: 0.7 },
  { top: 72, left: '16%', size: 1, opacity: 0.45 },
  { top: 70, left: '86%', size: 2, opacity: 0.7 },
  { top: 82, left: '92%', size: 1.5, opacity: 0.5 },
] as const;

// The Premium card's floating bubbles now live in components/PremiumBubbles —
// extracted verbatim (owner-tuned field: champagne-not-confetti, icon circle
// kept clear, ≤0.40 peaks under the label column) so the Premium+ paywall card
// carries the same signature.

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
  const { usageBytes, prefs: offlinePrefs, setPref: setOfflinePref } = useOffline();
  const { isPremium, isPremiumPlus } = usePremium();
  const { t, lang } = useTranslation();
  const [langPickerVisible, setLangPickerVisible] = useState(false);
  // Polished confirmations (replace the OS Alerts for logout / change password /
  // delete account) + a toast for the in-place success messages.
  const [dialog, setDialog] = useState<null | 'logout' | 'password' | 'delete' | 'deleteConfirm'>(null);
  const [toast, setToast] = useState<{ title: string; message?: string } | null>(null);
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

  function handleLogout() { setDialog('logout'); }

  // ── Polished-dialog actions ──────────────────────────────────────────────
  function doLogout() { setDialog(null); supabase.auth.signOut(); }

  async function doSendPasswordReset() {
    setDialog(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) { setToast({ title: t('cpw.failTitle'), message: t('cpw.failBody') }); return; }
    // redirectTo is what makes the emailed link come BACK to the app, where
    // (auth)/reset-password can actually set the password. Without it Supabase
    // sends the user to the project's Site URL — a web page with no way to
    // finish, which is why "change password" appeared to do nothing.
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: passwordResetRedirectUrl(),
    });
    // Report the real outcome. This used to claim "Email Sent" unconditionally,
    // so a rate-limited or failed send looked identical to a successful one.
    if (error) {
      setToast({
        title: t('cpw.failTitle'),
        message: /rate|security purposes/i.test(error.message) ? t('auth.rateLimited') : error.message,
      });
      return;
    }
    setToast({ title: t('cpw.sentTitle'), message: t('cpw.sentBody') });
  }

  async function doHide3mo() {
    setDialog(null);
    const ok = await setHidden(true, { delete_requested_at: new Date().toISOString(), delete_immediately: false });
    if (ok) setToast({ title: t('delete.hiddenTitle'), message: t('delete.hiddenBody') });
  }

  // Deleting strands any withdrawable balance. The ledger is append-only and
  // deliberately refuses to erase the entries (fix_ledger_blocks_deletion.sql), so
  // the money survives in an anonymised account that nobody can reach — correct
  // accounting, and a horrible surprise if the app never mentioned it.
  //
  // WARN, never block: it is their account and their decision. And a failed
  // balance lookup must not stand between someone and deleting their account, so
  // every error path here falls through to the delete.
  async function confirmDeleteWithBalance() {
    let availableCents = 0;
    try { availableCents = (await fetchWalletBalance()).totalCents ?? 0; } catch { /* fall through */ }
    if (availableCents > 0) {
      setDialog(null);
      Alert.alert(
        t('delete.balanceTitle'),
        t('delete.balanceBody', { amount: fmtCents(availableCents) }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('delete.balanceDeleteAnyway'), style: 'destructive', onPress: () => { void doDeletePermanent(); } },
        ],
      );
      return;
    }
    void doDeletePermanent();
  }

  async function doDeletePermanent() {
    setDialog(null);
    const ok = await setHidden(true, { delete_requested_at: new Date().toISOString(), delete_immediately: true });
    if (!ok) return;
    // Reported accounts aren't auto-deleted after 48h, so don't promise the email
    // reuse timeline to them. Check before sign-out (the RPC needs auth.uid()).
    let reported = false;
    try { const { data } = await supabase.rpc('current_account_has_reports'); reported = data === true; } catch {}
    await supabase.auth.signOut();
    Alert.alert(t('delete.doneTitle'), reported ? t('delete.doneReported') : t('delete.doneClean'));
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

  function handleDeleteAccount() { setDialog('delete'); }

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
      icon: 'language-outline',
      label: t('settings.section.language'),
      subtitle: LANGUAGES.find((l) => l.code === lang)?.native,
      onPress: () => setLangPickerVisible(true),
    },
    {
      icon: 'people-outline',
      label: t('account.friends'),
      subtitle: t('account.friendsSub'),
      onPress: () => router.push('/friends'),
    },
    {
      icon: 'wallet-outline',
      label: t('account.wallet'),
      subtitle: t('account.walletSub'),
      onPress: () => router.push('/wallet'),
    },
    // Credits sit next to the Wallet deliberately: they're the two halves of the
    // same idea. The Wallet is money coming IN (earnings); Credits is money going
    // OUT (what you spend on tips and the Shop). Putting them apart makes people
    // look for one in the other.
    {
      icon: 'diamond-outline',
      label: t('account.credits'),
      subtitle: t('account.creditsSub'),
      onPress: () => router.push('/credits'),
    },
    {
      icon: 'person-remove-outline',
      label: t('account.followerInsights'),
      subtitle: t('account.followerInsightsSub'),
      onPress: () => router.push('/follower-insights'),
    },
    {
      icon: 'stats-chart-outline',
      label: t('account.analytics'),
      subtitle: t('account.analyticsSub'),
      onPress: () => router.push('/analytics'),
    },
    {
      icon: 'ribbon-outline',
      label: t('account.badges'),
      subtitle: t('account.badgesSub'),
      onPress: () => router.push('/badges'),
    },
    // Sits with Badges rather than the paid Promotion Tools: inviting people is
    // how the Advocate badge is earned, and it costs nothing.
    {
      icon: 'person-add-outline',
      label: t('account.invite'),
      subtitle: t('account.inviteSub'),
      onPress: () => router.push('/invite'),
    },
    {
      icon: 'albums-outline',
      label: t('account.playlists'),
      subtitle: t('account.playlistsSub'),
      onPress: () => router.push('/playlists'),
    },
    {
      icon: 'bookmark-outline',
      label: t('account.saved'),
      subtitle: t('account.savedSub'),
      onPress: () => router.push('/saved'),
    },
    {
      icon: 'happy-outline',
      label: t('account.gifs'),
      subtitle: t('account.gifsSub'),
      onPress: () => router.push('/gifs'),
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
      onPress: () => setDialog('password'),
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

  const offlineItems: SectionItem[] = [
    {
      icon: 'cloud-download-outline',
      label: t('offline.manage'),
      subtitle: t('offline.storageUsed', { size: formatBytes(usageBytes) }),
      onPress: () => router.push('/downloads'),
    },
    {
      icon: 'sync-outline',
      label: t('offline.autoCache'),
      subtitle: t('offline.autoCacheSub'),
      value: offlinePrefs.autoCache,
      onValueChange: (v) => setOfflinePref({ autoCache: v }),
    },
    {
      icon: 'wifi-outline',
      label: t('offline.wifiOnly'),
      value: offlinePrefs.wifiOnly,
      onValueChange: (v) => setOfflinePref({ wifiOnly: v }),
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
      // Opens the mail app pre-addressed to support, with the app version in the
      // subject so replies don't start with "which build are you on?". Falls back
      // to showing the address, so this is never a dead end on a device with no
      // mail client set up.
      onPress: () => {
        const subject = encodeURIComponent(`Laybell support (v${APP_VERSION})`);
        Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}`)
          .catch(() => Alert.alert(t('about.help'), t('help.body')));
      },
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
    {
      icon: 'storefront-outline',
      label: t('about.marketplace'),
      onPress: () => router.push('/marketplace-terms'),
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
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
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
              <LinearGradient colors={GRADIENTS.avatar} style={styles.profileAvatar}>
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

        {/* Promotion tools — three STANDALONE cards (they were one connected
            flush menu until the owner asked for Premium detached and bigger),
            still ordered by weight: Laybell Premium (flagship brand-orange,
            biggest, drifting sparkle) → Spotlight (galaxy-purple) → Ad Manager
            (inverted mono block: white-on-dark themes / black-on-light). */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings.section.promo')}</Text>
          <View style={styles.promoStack}>
            <TouchableOpacity activeOpacity={0.85} onPress={() => router.push('/premium')}>
              {/* A Premium+ member's row wears the plus brand — the same red as
                  the paywall card — so the upgrade they paid for is visible
                  right here, not only inside the paywall. */}
              <LinearGradient
                colors={(isPremiumPlus ? PLUS_RED : [colors.primary, colors.primaryDark]) as any}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.promoPremium}
              >
                {/* Behind the content; the card's overflow:hidden clips it. */}
                <PremiumBubbles />
                <View style={[styles.promoIconBubble, styles.promoIconBubbleLg]}>
                  <Ionicons name={isPremium ? 'star' : 'star-outline'} size={26} color="#FFFFFF" />
                </View>
                <View style={styles.rowContent}>
                  <Text style={styles.promoPremiumLabel}>{t('premium.settingsRow')}</Text>
                  {/* The caption names the member's ACTUAL tier and what it buys —
                      "thanks for your support" described nothing, and a Premium+
                      member reading "Premium" looked like a billing error. */}
                  <Text style={styles.promoPremiumSub}>
                    {isPremiumPlus ? t('premium.settingsActivePlus')
                      : isPremium ? t('premium.settingsActive')
                      : t('premium.settingsUpgrade')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.9)" />
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.85} onPress={() => requireAdult(() => router.push('/spotlight'))}>
              <LinearGradient
                colors={['#241147', '#3B1D8F', '#6D28D9']}
                start={{ x: 0, y: 1 }}
                end={{ x: 1, y: 0 }}
                style={styles.promoSpotlight}
              >
                {/* Scattered pin-prick stars sell the galaxy without any assets. */}
                {GALAXY_STARS.map((s, i) => (
                  <View
                    key={i}
                    style={[styles.galaxyStar, {
                      top: s.top, left: s.left,
                      width: s.size, height: s.size, borderRadius: s.size / 2,
                      opacity: s.opacity,
                    }]}
                  />
                ))}
                <View style={[styles.promoIconBubble, styles.promoIconBubbleLg]}>
                  <Ionicons name="sparkles" size={24} color="#FFFFFF" />
                </View>
                <View style={styles.rowContent}>
                  <Text style={styles.promoSpotlightLabel}>Spotlight</Text>
                  <Text style={styles.promoSpotlightSub}>{t('account.spotlightSub')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.85)" />
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity
              activeOpacity={0.85}
              style={styles.promoAd}
              onPress={() => requireAdult(() => router.push('/ad-manager'))}
            >
              <View style={[styles.promoIconBubble, styles.promoIconBubbleLg, styles.promoAdBubble]}>
                <Ionicons name="megaphone-outline" size={24} color={colors.background} />
              </View>
              <View style={styles.rowContent}>
                {/* Its own string, not account.adManager — that one also titles
                    the Ad Manager screen, which lists, pauses and ends running
                    campaigns. Calling that screen "Create Ads" would misname it. */}
                <Text style={styles.promoAdLabel}>{t('account.createAds')}</Text>
                <Text style={styles.promoAdSub}>{t('account.adManagerSub')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.background + 'B3'} />
            </TouchableOpacity>
          </View>
        </View>

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
        <Section title={t('offline.sectionTitle')} items={offlineItems} />
        <Section title={t('settings.section.account')} items={accountItems} />
        <Section title={t('settings.section.notifications')} items={notifItems} />
        <Section title={t('settings.section.ads')} items={adItems} />
        <Section title={t('settings.section.about')} items={aboutItems} />
        <Section title="" items={dangerItems} />

        <Text style={styles.madeWith}>{t('settings.madeWith')}</Text>
      </ScrollView>

      <LanguagePicker
        visible={langPickerVisible}
        onClose={() => setLangPickerVisible(false)}
      />

      {/* Polished confirmations (replace the default OS alerts) */}
      <ConfirmDialog
        visible={dialog === 'logout'}
        icon="log-out-outline"
        destructive
        title={t('logout.title')}
        message={t('logout.body')}
        confirmLabel={t('danger.logout')}
        onConfirm={doLogout}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'password'}
        icon="lock-closed-outline"
        title={t('account.changePassword')}
        message={t('cpw.body')}
        confirmLabel={t('cpw.send')}
        onConfirm={doSendPasswordReset}
        onCancel={() => setDialog(null)}
      />
      {/* Delete: a soft "hide for 3 months" alternative sits between the
          destructive delete and cancel. */}
      <ConfirmDialog
        visible={dialog === 'delete'}
        icon="warning"
        destructive
        title={t('danger.deleteAccount')}
        message={t('delete.body')}
        confirmLabel={t('delete.deleteNow')}
        secondaryLabel={t('delete.hide3mo')}
        onSecondary={doHide3mo}
        onConfirm={() => setDialog('deleteConfirm')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        visible={dialog === 'deleteConfirm'}
        icon="trash"
        destructive
        title={t('delete.permTitle')}
        message={t('delete.permBody')}
        confirmLabel={t('common.delete')}
        onConfirm={confirmDeleteWithBalance}
        onCancel={() => setDialog(null)}
      />
      <Toast
        visible={!!toast}
        icon="checkmark-circle"
        title={toast?.title ?? ''}
        message={toast?.message}
        onHide={() => setToast(null)}
      />
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

  // Promotion tools — three STANDALONE cards (each owns its rounding; the
  // stack only spaces them), by visual weight: Premium is the flagship —
  // biggest, brand orange, drifting sparkle — then Spotlight (galaxy purple),
  // then Ad Manager as an inverted mono block — white with black text on the
  // dark themes, black with white text on light (bg = c.text, content =
  // c.background).
  promoStack: { gap: SPACING.sm + 2 },
  promoPremium: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md + 4, paddingVertical: SPACING.lg + 6,
    borderRadius: RADIUS.lg,
    overflow: 'hidden', // clips the particle field to the card
  },
  promoPremiumLabel: { color: '#FFFFFF', fontSize: 21, fontWeight: '800', letterSpacing: -0.3 },
  promoPremiumSub: { color: 'rgba(255,255,255,0.88)', fontSize: 14.5, marginTop: 3 },
  // Shared by all three cards now — Premium keeps its lead through padding and
  // type instead of a bigger bubble, so the icons line up down the stack.
  promoIconBubbleLg: { width: 48, height: 48, borderRadius: 24 },
  // Spotlight and Ad Manager now match what Premium used to be — same padding,
  // same 48pt bubble. The stack still reads in order because Premium grew past
  // them rather than because they stayed small.
  promoSpotlight: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md + 2, paddingVertical: SPACING.lg,
    borderRadius: RADIUS.lg,
    overflow: 'hidden', // keeps the star field inside the block
  },
  promoSpotlightLabel: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  promoSpotlightSub: { color: 'rgba(255,255,255,0.75)', fontSize: 13.5, marginTop: 2 },
  promoAd: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md + 2, paddingVertical: SPACING.lg,
    backgroundColor: c.text,
    borderRadius: RADIUS.lg,
  },
  promoAdBubble: { backgroundColor: c.background + '26' },
  promoAdLabel: { color: c.background, fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  promoAdSub: { color: c.background + 'B3', fontSize: 13.5, marginTop: 2 },
  promoIconBubble: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  galaxyStar: { position: 'absolute', backgroundColor: '#FFFFFF' },

  // Display-mode color chip + unselected radio.
  swatch: { width: 28, height: 28, borderRadius: RADIUS.sm, borderWidth: 1 },
  radioOff: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: c.border },

  separator: { height: 0.5, backgroundColor: c.border, marginLeft: SPACING.md + 28 + SPACING.md },

  madeWith: {
    color: c.textTertiary, fontSize: 13,
    textAlign: 'center', paddingVertical: SPACING.lg,
  },
});
