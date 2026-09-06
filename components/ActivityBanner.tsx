import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { isNotifTypeEnabled } from '../lib/notificationPrefs';
import { destForPushData } from '../lib/notificationRoute';
import StoryAvatar from '../components/StoryAvatar';

/**
 * The banner that drops in when something happens while you are looking at the
 * app — someone you follow went live or posted, someone liked your track,
 * a message arrived.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THESE COME FROM
 *
 * Two sources, and the split matters:
 *
 *   1. YOUR OWN notifications rows. Every notification the app already creates
 *      — like, comment, follow, mention, offer, studio invite, the new
 *      live_started, and Laybell's own messages — arrives here for free, because
 *      it is one subscription to one table rather than one per kind. RLS scopes
 *      it: realtime only delivers rows this account could SELECT.
 *
 *   2. POSTS by people you follow. Deliberately NOT notification rows. A row per
 *      follower per post would bury the things that are actually about you —
 *      follow a hundred people who post ten times a day and your notifications
 *      list is a thousand entries deep in other people's posting. So a post
 *      banner is transient: seen if you are here, gone if you are not, never
 *      stored.
 *
 * PURCHASES ARE NOT HERE ON PURPOSE. Telling someone's followers what they
 * bought exposes their spending, and doing it by default is how an app ends up
 * in a privacy story. If it is ever wanted it needs its own opt-in and its own
 * consent language, not a line in this file.
 */

// Long enough to read a name and a few words; short enough not to sit on the UI.
const SHOW_MS = 4200;
// Nothing arrives twice within this window — a burst of likes should be ONE
// banner, not a stack of them fighting for the same strip of screen.
const COOLDOWN_MS = 6000;

type Banner = {
  key: string;
  actorId: string | null;
  avatarUrl: string | null;
  name: string;
  text: string;
  icon: any;
  tint: string;
  dest: { href: string; tab: boolean } | null;
};

/** Screens where a banner would be telling you what you are already looking at. */
function suppressedOn(pathname: string, type: string): boolean {
  // Already reading the list this would duplicate.
  if (pathname.startsWith('/notifications')) return true;
  // Already in a conversation — the message appears in the thread itself.
  if (type === 'message' && pathname.startsWith('/messages')) return true;
  // Already on the live rail.
  if (type === 'live_started' && pathname.startsWith('/live')) return true;
  return false;
}

export default function ActivityBanner() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const [banner, setBanner] = useState<Banner | null>(null);
  const slide = useRef(new Animated.Value(-1)).current; // -1 above, 0 resting
  const insets = useSafeAreaInsets();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShownAt = useRef<Record<string, number>>({});
  const selfId = useRef<string | null>(null);
  // Who this account follows, for source 2. Read once — a follow made during
  // the session simply means that person's next post is the first one bannered.
  const following = useRef<Set<string>>(new Set());
  // Reading pathname from a ref keeps the realtime subscription from tearing
  // down and rebuilding on every navigation.
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  const show = useCallback((b: Banner) => {
    const now = Date.now();
    const seen = lastShownAt.current[b.key] ?? 0;
    if (now - seen < COOLDOWN_MS) return;
    lastShownAt.current[b.key] = now;

    setBanner(b);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 180 }).start();
    hideTimer.current = setTimeout(() => {
      Animated.timing(slide, { toValue: -1, duration: 220, useNativeDriver: true })
        .start(({ finished }) => { if (finished) setBanner(null); });
    }, SHOW_MS);
  }, [slide]);

  const dismiss = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    Animated.timing(slide, { toValue: -1, duration: 180, useNativeDriver: true })
      .start(({ finished }) => { if (finished) setBanner(null); });
  }, [slide]);

  useEffect(() => {
    let channel: any;
    let alive = true;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !alive) return;
      selfId.current = user.id;

      const { data: follows } = await supabase
        .from('follows').select('following_id').eq('follower_id', user.id);
      if (!alive) return;
      following.current = new Set((follows ?? []).map((f: any) => f.following_id));

      // Per-mount suffix: re-using a channel name returns the ALREADY SUBSCRIBED
      // instance and .on() then throws — the same trap app/messages guards.
      channel = supabase
        .channel(`activity-${user.id}-${Date.now().toString(36)}`)
        // ── Source 1: anything written to my own notifications ──────────────
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
          async (payload: any) => {
            const n = payload.new;
            if (!n || n.actor_id === user.id) return;               // never my own doing
            if (!isNotifTypeEnabled(n.type)) return;                // Settings toggles
            if (suppressedOn(pathRef.current, n.type)) return;
            const b = await bannerForNotification(n, t);
            if (b && alive) show(b);
          })
        // ── Source 2: a post by someone I follow ────────────────────────────
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'posts' },
          async (payload: any) => {
            const p = payload.new;
            if (!p || p.user_id === user.id) return;
            if (!following.current.has(p.user_id)) return;
            // Public and not archived. RLS already stops a friends-only post
            // reaching someone who is not a friend, but this is checked here
            // too: `is_public` is the column the composer actually writes (an
            // earlier draft of this file guessed `visibility`, which does not
            // exist — the check silently passed everything), and archived_at is
            // documented as NOT covered by RLS, so app code has to enforce it.
            if (p.is_public === false || p.archived_at) return;
            if (pathRef.current.startsWith('/notifications')) return;
            const who = await actorOf(p.user_id);
            if (!who || !alive) return;
            show({
              key: `post:${p.user_id}`,
              actorId: p.user_id,
              avatarUrl: who.avatar_url,
              name: who.display_name || who.username || t('notifications.someone'),
              text: t('banner.posted'),
              icon: 'add-circle',
              tint: COLORS.primary,
              dest: { href: `/post/${p.id}`, tab: false },
            });
          })
        .subscribe();
    })();

    return () => {
      alive = false;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (channel) supabase.removeChannel(channel);
    };
    // Mounted once for the session — `show` and `t` are stable enough that
    // re-subscribing on them would churn the channel for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!banner) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { top: insets.top + SPACING.xs },
        { transform: [{ translateY: slide.interpolate({ inputRange: [-1, 0], outputRange: [-160, 0] }) }] },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.9}
        style={styles.card}
        onPress={() => {
          dismiss();
          if (!banner.dest) return;
          // navigate, not push: it reuses an already-mounted route instead of
          // stacking a second copy of a tab (see app/notifications.tsx).
          router.navigate(banner.dest.href as any);
        }}
      >
        <View style={styles.avatarWrap}>
          <StoryAvatar userId={banner.actorId ?? undefined} avatarUrl={banner.avatarUrl}
                       name={banner.name} size={36} />
          <View style={[styles.iconBadge, { backgroundColor: banner.tint }]}>
            <Ionicons name={banner.icon} size={10} color="#FFFFFF" />
          </View>
        </View>
        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>{banner.name}</Text>
          <Text style={styles.text} numberOfLines={1}>{banner.text}</Text>
        </View>
        <TouchableOpacity onPress={dismiss} hitSlop={10} style={styles.close}>
          <Ionicons name="close" size={16} color={COLORS.textTertiary} />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

/** The actor's name and face, for a banner that has only an id. */
async function actorOf(id: string) {
  const { data } = await supabase
    .from('profiles').select('username, display_name, avatar_url, hidden').eq('id', id).maybeSingle();
  // A hidden account should not be announced to anyone.
  if (!data || (data as any).hidden) return null;
  return data as any;
}

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

async function bannerForNotification(n: any, t: TFunc): Promise<Banner | null> {
  // Laybell's own messages have no actor and their own copy.
  if (n.type === 'system') {
    return {
      key: `system:${n.system_key}`,
      actorId: null, avatarUrl: null, name: 'Laybell',
      text: t('banner.fromLaybell'),
      icon: 'notifications', tint: COLORS.primary,
      dest: destForPushData({ type: 'system', key: n.system_key }, null),
    };
  }

  const who = n.actor_id ? await actorOf(n.actor_id) : null;
  if (n.actor_id && !who) return null;   // hidden or deleted actor: say nothing

  const copy: Record<string, { text: string; icon: any; tint: string }> = {
    live_started: { text: t('banner.wentLive'),  icon: 'radio',       tint: COLORS.like },
    like:         { text: t('banner.liked'),     icon: 'heart',       tint: COLORS.like },
    comment:      { text: t('banner.commented'), icon: 'chatbubble',  tint: COLORS.primaryLight },
    follow:       { text: t('banner.followed'),  icon: 'person-add',  tint: COLORS.primaryLight },
    friend:       { text: t('banner.followed'),  icon: 'people',      tint: COLORS.primaryLight },
    message:      { text: t('banner.messaged'),  icon: 'chatbubbles', tint: '#60A5FA' },
    mention:      { text: t('banner.mentioned'), icon: 'at',          tint: COLORS.primaryLight },
    tag:          { text: t('banner.tagged'),    icon: 'pricetag',    tint: COLORS.primary },
    offer:        { text: t('banner.offered'),   icon: 'pricetags',   tint: COLORS.success },
    studio_invite:{ text: t('banner.invited'),   icon: 'mic',         tint: COLORS.primaryLight },
    song_used:    { text: t('banner.songUsed'),  icon: 'musical-notes', tint: COLORS.primaryLight },
    song_story:   { text: t('banner.songStory'), icon: 'musical-notes', tint: COLORS.primaryLight },
  };
  const c = copy[n.type];
  if (!c) return null;   // an unknown type is not worth interrupting anyone for

  return {
    key: `${n.type}:${n.actor_id}`,
    actorId: n.actor_id,
    avatarUrl: who?.avatar_url ?? null,
    name: who?.display_name || who?.username || t('notifications.someone'),
    text: c.text, icon: c.icon, tint: c.tint,
    dest: destForPushData({ type: n.type, postId: n.post_id }, null),
  };
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 9999 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surface, borderRadius: RADIUS.lg,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    // Lifted off the screen so it reads as arriving over the app rather than
    // as part of whatever is underneath it.
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 8 },
    }),
  },
  avatarWrap: { position: 'relative', width: 36, height: 36 },
  iconBadge: {
    position: 'absolute', bottom: -2, right: -2,
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.surface,
  },
  body: { flex: 1 },
  name: { color: colors.text, fontWeight: '700', fontSize: 13 },
  text: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  close: { padding: SPACING.xs },
});
