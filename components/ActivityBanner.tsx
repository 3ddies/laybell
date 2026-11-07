import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../constants/theme';
import { tileImageUri, feedImageUri } from '../lib/mediaPreview';
import { useTranslation } from '../contexts/LanguageContext';
import { isNotifTypeEnabled } from '../lib/notificationPrefs';
import { destForPushData } from '../lib/notificationRoute';
import { notifySuccess } from '../lib/haptics';
import { parseAttachment } from '../lib/attachments';
import { sharedPostId, parseStoryReply } from '../lib/postLinks';
import { isOfferBody } from '../lib/offerMessage';
import { isStudioInviteBody } from '../lib/studioInvite';
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

// Long enough to read a name and a few words and glance at the thumbnail.
const SHOW_MS = 8400;
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
  // The post this is about — a small cover on the right, TikTok-style. Only
  // post-centric events (a like, a comment, a new post, a mention, a tag) carry
  // one; follows, messages and profile views have none and the card simply
  // closes up around its absence.
  thumbUrl?: string | null;
  // Messages buzz as they drop in; nothing else does.
  buzz?: boolean;
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
  // Who follows ME — with `following`, this gives "friend" = mutual follow, the
  // gate for the profile-view banner (Source 3).
  const followers = useRef<Set<string>>(new Set());
  // Reading pathname from a ref keeps the realtime subscription from tearing
  // down and rebuilding on every navigation.
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  const show = useCallback((b: Banner) => {
    const now = Date.now();
    const seen = lastShownAt.current[b.key] ?? 0;
    if (now - seen < COOLDOWN_MS) return;
    lastShownAt.current[b.key] = now;

    // The buzz. Only banners that ask for it (messages) fire a haptic, so a
    // burst of likes or follows stays silent. No-ops where haptics aren't
    // available — see lib/haptics.
    if (b.buzz) notifySuccess();

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

      const { data: fr } = await supabase
        .from('follows').select('follower_id').eq('following_id', user.id);
      if (!alive) return;
      followers.current = new Set((fr ?? []).map((f: any) => f.follower_id));

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
              // The realtime row carries every post column, so its cover is in
              // hand — no extra fetch for a new-post banner.
              thumbUrl: feedImageUri(tileImageUri(p), 160) ?? null,
            });
          })
        // ── Source 3: a FRIEND viewed my profile (profile_views.sql) ────────
        // Transient only — the durable record is /profile-viewers. RLS scopes
        // delivery to me (owner_id); the DB already gates recording on both of
        // us being opted in, so anything that arrives here is legitimate.
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'profile_views', filter: `owner_id=eq.${user.id}` },
          async (payload: any) => {
            const row = payload.new;
            if (!row || !row.viewer_id || row.viewer_id === user.id) return; // skip DELETE / self
            const v = row.viewer_id as string;
            // "Friend" = mutual follow (owner's ask).
            if (!(following.current.has(v) && followers.current.has(v))) return;
            if (pathRef.current.startsWith('/profile-viewers')) return; // already looking
            const who = await actorOf(v);
            if (!who || !alive) return;
            show({
              key: `profileview:${v}`,
              actorId: v,
              avatarUrl: who.avatar_url,
              name: who.display_name || who.username || t('notifications.someone'),
              text: t('banner.viewedProfile'),
              icon: 'eye',
              tint: COLORS.primaryLight,
              dest: { href: '/profile-viewers', tab: false },
            });
          })
        // ── Source 4: a DM / group message TO ME — the message banner ───────
        // A direct `messages` subscription, not a notifications row, so it
        // carries the sender and the body: a real preview, the exact thread to
        // open, and a buzz. RLS scopes realtime delivery to messages I'm allowed
        // to read, so no server filter is needed — a 1:1 only arrives if I'm a
        // party to it, a group message only if I'm a member.
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          async (payload: any) => {
            const m = payload.new;
            if (!m || m.sender_id === user.id) return;          // never my own send
            // 1:1 DM to me → the sender's thread; otherwise a group I'm in.
            const href = m.receiver_id === user.id
              ? `/messages/${m.sender_id}`
              : m.conversation_id
                ? `/messages/group/${m.conversation_id}`
                : null;
            if (!href) return;
            if (pathRef.current === href) return;               // already reading this thread
            const who = await actorOf(m.sender_id);
            if (!who || !alive) return;                          // hidden / deleted sender
            show({
              key: `msg:${href}`,
              actorId: m.sender_id,
              avatarUrl: who.avatar_url,
              name: who.display_name || who.username || t('notifications.someone'),
              text: previewForBody(m.body ?? '', t),
              icon: 'chatbubbles',
              tint: '#60A5FA',
              dest: { href, tab: false },
              buzz: true,
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
        {
          // Fade in with the drop (and out with the retreat) — a soft arrival
          // reads far more polished than a bare slide.
          opacity: slide.interpolate({ inputRange: [-1, 0], outputRange: [0, 1], extrapolate: 'clamp' }),
          transform: [{ translateY: slide.interpolate({ inputRange: [-1, 0], outputRange: [-160, 0] }) }],
        },
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
                       name={banner.name} size={40} />
          <View style={[styles.iconBadge, { backgroundColor: banner.tint }]}>
            <Ionicons name={banner.icon} size={10} color="#FFFFFF" />
          </View>
        </View>
        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>{banner.name}</Text>
          <Text style={styles.text} numberOfLines={1}>{banner.text}</Text>
        </View>
        {banner.thumbUrl ? (
          <Image source={{ uri: banner.thumbUrl }} style={styles.thumb} contentFit="cover" transition={120} />
        ) : null}
        <TouchableOpacity onPress={dismiss} hitSlop={10} style={styles.close}>
          <Ionicons name="close" size={16} color="#9A9AA0" />
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

/** One-line preview of an incoming message, matching the inbox's wording so the
 *  banner and the conversation list say the same thing. Attachments / shared
 *  posts / offers / story replies / studio invites get a label; text shows as-is. */
function previewForBody(body: string, t: TFunc): string {
  const att = parseAttachment(body);
  if (att) return att.type === 'gif' ? t('messages.preview.gif') : t('messages.preview.photo');
  if (sharedPostId(body)) return t('messages.preview.sharedPost');
  if (parseStoryReply(body)) return t('messages.preview.storyReply');
  if (isOfferBody(body)) return t('messages.preview.offer');
  if (isStudioInviteBody(body)) return t('messages.preview.studio');
  return body;
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
    // 'message' is intentionally NOT here — message banners come from the direct
    // messages subscription (Source 4), which has the body for a real preview and
    // opens the thread. A notifications-row 'message' banner would double it up.
    mention:      { text: t('banner.mentioned'), icon: 'at',          tint: COLORS.primaryLight },
    tag:          { text: t('banner.tagged'),    icon: 'pricetag',    tint: COLORS.primary },
    offer:        { text: t('banner.offered'),   icon: 'pricetags',   tint: COLORS.success },
    studio_invite:{ text: t('banner.invited'),   icon: 'mic',         tint: COLORS.primaryLight },
    song_used:    { text: t('banner.songUsed'),  icon: 'musical-notes', tint: COLORS.primaryLight },
    song_story:   { text: t('banner.songStory'), icon: 'musical-notes', tint: COLORS.primaryLight },
    repost:       { text: t('banner.reposted'),  icon: 'repeat',        tint: COLORS.primary },
    react:        { text: t('banner.reacted'),   icon: 'git-merge',     tint: COLORS.primaryLight },
    sale:         { text: t('banner.sold'),      icon: 'bag-check',     tint: COLORS.success },
  };
  const c = copy[n.type];
  if (!c) return null;   // an unknown type is not worth interrupting anyone for

  // The post's cover for the right-hand thumbnail, when this is about a post.
  // A small copy (thumb_url) when the post has one, else the cover/poster bounded
  // to ~160px so a 44pt tile never pulls a full-size upload. Best-effort: a post
  // that's gone or archived just means a card without a thumbnail, never a
  // dropped banner.
  let thumbUrl: string | null = null;
  if (n.post_id) {
    const { data: post } = await supabase
      .from('posts')
      .select('type, media_url, thumbnail_url, cover_url, thumb_url, slides, archived_at')
      .eq('id', n.post_id).maybeSingle();
    if (post && !(post as any).archived_at) thumbUrl = feedImageUri(tileImageUri(post as any), 160) ?? null;
  }

  return {
    key: `${n.type}:${n.actor_id}`,
    actorId: n.actor_id,
    avatarUrl: who?.avatar_url ?? null,
    name: who?.display_name || who?.username || t('notifications.someone'),
    text: c.text, icon: c.icon, tint: c.tint,
    dest: destForPushData({ type: n.type, postId: n.post_id }, null),
    thumbUrl,
  };
}

// Always a white card, in BOTH light and dark mode — a clean notification pill
// that reads identically regardless of the app theme. Colors are therefore
// hardcoded (not theme tokens): near-black text on white, a white badge ring.
const styles = StyleSheet.create({
  // Near edge-to-edge: only a small gutter each side, so the card reads WIDE.
  wrap: { position: 'absolute', left: SPACING.sm, right: SPACING.sm, zIndex: 9999 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 4,
    backgroundColor: '#FFFFFF', borderRadius: RADIUS.lg,
    paddingVertical: 13, paddingHorizontal: 15,
    // No hard outline — just a whisper-thin edge to stay crisp on a white
    // background, and a soft, lifted shadow so the card POPS off the feed on
    // both themes without ever looking heavy.
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.08)',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 24, shadowOffset: { width: 0, height: 12 } },
      android: { elevation: 14 },
    }),
  },
  avatarWrap: { position: 'relative', width: 40, height: 40 },
  iconBadge: {
    position: 'absolute', bottom: -2, right: -2,
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#FFFFFF',
    // Lifts the emblem off the avatar like a crisp sticker.
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 2.5, shadowOffset: { width: 0, height: 1 } },
      android: { elevation: 3 },
    }),
  },
  body: { flex: 1 },
  name: { color: '#0B0B0F', fontWeight: '800', fontSize: 15, letterSpacing: -0.2, lineHeight: 18 },
  text: { color: '#6B6B70', fontSize: 13, fontWeight: '500', letterSpacing: -0.1, marginTop: 1, lineHeight: 16 },
  // The post cover on the right (TikTok-style). A neutral base while it loads and
  // a hairline edge so the cover reads crisp against the white card.
  thumb: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: '#ECECEE',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.08)',
  },
  close: { padding: SPACING.xs },
});
