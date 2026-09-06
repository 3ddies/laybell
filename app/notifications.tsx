import {
  View, Text, StyleSheet, SectionList,
  TouchableOpacity, Image, RefreshControl,
} from 'react-native';
import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { timeAgo } from '../lib/timeAgo';
import { displayedTier } from '../lib/badges';
import { maskHiddenProfile } from '../lib/hiddenProfile';
import StoryAvatar from '../components/StoryAvatar';
import BadgeEmblem from '../components/BadgeEmblem';
import FollowButton from '../components/FollowButton';
import SwipeBackPager from '../components/SwipeBackPager';
import { NotificationsSkeleton } from '../components/Skeleton';
import { destForSystemKey } from '../lib/notificationRoute';

// The app icon, standing in for the avatar on a message from Laybell itself.
// Bundled, so it draws with the row instead of arriving a moment later the way
// a remote avatar does.
const LAYBELL_MARK = require('../assets/icon.png');


type Notification = {
  id: string; type: 'like' | 'comment' | 'follow' | 'friend' | 'message' | 'mention' | 'song_used' | 'song_story' | 'tag' | 'offer' | 'system' | 'live_started';
  post_id: string | null; actor_id: string | null; read: boolean; created_at: string;
  // 'system' only: a message from Laybell itself, so there is no actor. The key
  // names which message and the app translates it (server-side copy would be
  // English-only); system_n is the one number a message may carry, e.g. how many
  // people followed you. See supabase/sql/reengagement.sql.
  system_key?: string | null; system_n?: number | null;
  actor: { id: string; username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null } | null;
};

// A row to render: a single notification, or several consecutive same-type actions
// from the same actor collapsed into one. `children` holds every notification in the
// run (newest-first) so a grouped row can expand to show each individual post.
type DisplayNotif = Notification & { groupCount?: number; children?: Notification[] };

// The translator from useTranslation(), passed down to module-level helpers.
type TFunc = (key: string, vars?: Record<string, string | number>) => string;

// Plural phrasing for a grouped run of `count` actions by a single actor.
function groupedText(t: TFunc, type: string, count: number): string {
  switch (type) {
    case 'like': return t('notifications.groupLiked', { count });
    case 'comment': return t('notifications.groupCommented', { count });
    case 'message': return t('notifications.groupMessaged', { count });
    case 'mention': return t('notifications.groupMentioned', { count });
    case 'tag': return t('notifications.groupTagged', { count });
    case 'song_used': return t('notifications.groupSongUsed', { count });
    case 'song_story': return t('notifications.groupSongStory', { count });
    case 'offer': return t('notifications.groupOffers', { count });
    default: return notificationText(t, type);
  }
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// Collapse same-type actions from the SAME actor into one row (e.g. "<name> liked 5
// posts"), even when OTHER people's notifications are interleaved between them. An
// action joins an open group as long as it's within 5h of that group's MOST RECENT
// action (the representative); a larger gap starts a fresh group. follow/friend never
// group — they carry a Follow button and only happen once. Input is newest-first, so
// the representative is the most recent and `children` keeps the whole group so the
// row can expand into the individual posts.
function groupByProximity(items: Notification[]): DisplayNotif[] {
  const out: DisplayNotif[] = [];
  const open = new Map<string, DisplayNotif>(); // `${type}:${actor}` → the open group
  for (const n of items) {
    // follow/friend carry a Follow button and only happen once. A Laybell
    // message never groups either: they arrive a month apart and each says a
    // different thing, so "Laybell did 2 things" would be nonsense — and with
    // actor_id null they would all share one grouping key and collapse together.
    if (n.type === 'follow' || n.type === 'friend' || n.type === 'system') {
      out.push({ ...n, groupCount: 1, children: [n] });
      continue;
    }
    const key = `${n.type}:${n.actor_id}`;
    const g = open.get(key);
    // Within 5h of the group's newest (representative) → join; else open a new group.
    if (g && new Date(g.created_at).getTime() - new Date(n.created_at).getTime() <= FIVE_HOURS_MS) {
      g.groupCount = (g.groupCount ?? 1) + 1;
      g.children!.push(n);
    } else {
      const disp: DisplayNotif = { ...n, groupCount: 1, children: [n] };
      out.push(disp);
      open.set(key, disp);
    }
  }
  return out;
}

/**
 * The body of a message from Laybell itself, translated.
 *
 * The push that carried it was English — every push this app sends is (see
 * supabase/functions/send-push/index.ts) — but the row it lands on is read
 * inside the app, where the language is known, so it is rendered properly here.
 *
 * An unknown key falls back to the generic message rather than rendering blank:
 * the server can start sending a new key the moment someone edits the SQL, and
 * an older build must still show that person SOMETHING true.
 */
function systemText(t: TFunc, key?: string | null, n?: number | null): string {
  switch (key) {
    case 'earnings':    return t('sysNotif.earnings');
    case 'followers':   return n === 1 ? t('sysNotif.follower') : t('sysNotif.followers', { count: n ?? 0 });
    case 'unread':      return n === 1 ? t('sysNotif.unreadOne') : t('sysNotif.unread', { count: n ?? 0 });
    case 'first_post':  return t('sysNotif.firstPost');
    case 'badge_first': return t('sysNotif.badgeFirst');
    default:            return t('sysNotif.back');
  }
}

function notificationText(t: TFunc, type: string) {
  switch (type) {
    case 'like': return t('notifications.liked');
    case 'comment': return t('notifications.commented');
    case 'follow': return t('notifications.followed');
    case 'friend': return t('notifications.friend');
    case 'message': return t('notifications.messaged');
    case 'mention': return t('notifications.mentioned');
    case 'tag': return t('notifications.tagged');
    case 'song_used': return t('notifications.songUsed');
    case 'song_story': return t('notifications.songStory');
    case 'live_started': return t('notifications.wentLive');
    // Names the sender and stops there, exactly as the push does — the amount
    // is on the offer card in the thread this row opens.
    case 'offer': return t('notifications.offered');
    default: return t('notifications.interacted');
  }
}

/**
 * The little type emblem on the corner of the actor's avatar, or NULL for the
 * kinds that do not earn one.
 *
 * `ink` is the glyph colour, given explicitly where it matters. The default is
 * the theme's text colour, which means those glyphs flip black↔white with the
 * app theme — fine on a coloured disc, which is why most keep it.
 *
 * Not every notification needs a badge. The three that return null say what they
 * are in the sentence beside them ("used your audio in a post"), and a generic
 * bell on top of that is decoration standing in for information.
 */
function notificationIcon(type: string): { name: any; color: string; ink?: string } | null {
  switch (type) {
    case 'like': return { name: 'heart', color: COLORS.like };
    // Monochrome: white disc, black glyph, in both themes.
    case 'comment': return { name: 'chatbubble', color: '#FFFFFF', ink: '#000000' };
    case 'follow': return { name: 'person-add', color: COLORS.primaryLight };
    case 'friend': return { name: 'people', color: COLORS.primaryLight };
    case 'message': return { name: 'chatbubbles', color: '#60A5FA' };
    // "mentioned you" — the sentence carries it.
    case 'mention': return null;
    // Orange disc, black glyph, in both themes — not the theme's text colour,
    // which would turn this one white in dark mode.
    case 'tag': return { name: 'pricetag', color: COLORS.primary, ink: '#000000' };
    // "used your audio in a post" — the row already says so.
    case 'song_used': return null;
    case 'song_story': return { name: 'musical-notes', color: COLORS.primaryLight };
    // The one notification that is time-limited: it is only true while the
    // stream is up, so it earns an emblem rather than blending into the list.
    case 'live_started': return { name: 'radio', color: COLORS.like, ink: '#FFFFFF' };
    case 'offer': return { name: 'pricetags', color: COLORS.success };
    // "interacted with you" — a bell emblem beside the word "interacted" adds
    // nothing; it is the catch-all type, so its badge was the least specific
    // thing on the row.
    default: return null;
  }
}

// Pick an image to preview a post-related notification on the right of the row.
function postPreviewUrl(p: any): string | null {
  if (!p) return null;
  if (p.type === 'image') return p.media_url ?? null;
  if (p.type === 'video') return p.thumbnail_url ?? p.cover_url ?? null;
  if (p.type === 'audio') return p.cover_url ?? null;
  return p.media_url ?? p.thumbnail_url ?? p.cover_url ?? null; // slideshow / other
}

const DAY = 86400000;
function bucketFor(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  if (diff < DAY) return 'Today';
  if (diff < 7 * DAY) return 'This Week';
  if (diff < 30 * DAY) return 'This Month';
  return 'Earlier';
}
const BUCKET_ORDER = ['Today', 'This Week', 'This Month', 'Earlier'];
// Stable bucket key → translation key for the section header label.
const SECTION_KEYS: Record<string, string> = {
  'Today': 'notifications.today',
  'This Week': 'notifications.thisWeek',
  'This Month': 'notifications.thisMonth',
  'Earlier': 'notifications.earlier',
};

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  // The signed-in account, captured on load. Only the "N people followed you"
  // row needs it, to open /followers/<id> — their OWN list, not a stranger's.
  const [selfId, setSelfId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Grouped rows the user has expanded to reveal the individual posts.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => setExpandedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  useEffect(() => { fetchNotifications().catch(() => { setLoading(false); setRefreshing(false); }); }, []);

  async function fetchNotifications() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setSelfId(user.id);

    const { data: notifData, error } = await supabase
      .from('notifications')
      .select('id, type, post_id, read, created_at, actor_id, system_key, system_n')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) console.error('notifications fetch error:', error.message);

    if (notifData && notifData.length > 0) {
      // filter(Boolean) is load-bearing now that a row can have no actor: a
      // Laybell message carries actor_id null, and passing that straight into
      // .in('id', [...]) asks Postgres for a profile whose id IS null.
      const actorIds = [...new Set(notifData.map(n => n.actor_id).filter(Boolean))] as string[];
      const postIds = [...new Set(notifData.map(n => n.post_id).filter(Boolean))] as string[];
      const [{ data: profileData }, postsRes] = await Promise.all([
        actorIds.length
          ? supabase.from('profiles').select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden').in('id', actorIds)
          : Promise.resolve({ data: [] as any[] }),
        postIds.length
          ? supabase.from('posts').select('id, type, media_url, cover_url, thumbnail_url').in('id', postIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      // Actors who have since hidden their account read as "Hidden account".
      const profileMap = Object.fromEntries((profileData ?? []).map(p => [p.id, maskHiddenProfile(p as any)]));
      const previewMap: Record<string, string> = {};
      for (const p of postsRes.data ?? []) {
        const url = postPreviewUrl(p);
        if (url) previewMap[p.id] = url;
      }
      setPreviews(previewMap);
      setNotifications(notifData.map(n => ({ ...n, actor: (n.actor_id ? profileMap[n.actor_id] : null) ?? null })) as any);
    } else {
      setNotifications([]);
      setPreviews({});
    }

    await supabase.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
    setLoading(false);
    setRefreshing(false);
  }

  // Group across the whole list FIRST (so a 5h cluster isn't split by interleaved
  // notifications or a bucket edge), then file each group under a time section by its
  // most-recent action. Input is already newest-first from the query.
  const sections = useMemo(() => {
    const now = Date.now();
    const grouped = groupByProximity(notifications);
    const map: Record<string, DisplayNotif[]> = {};
    for (const d of grouped) {
      const k = bucketFor(d.created_at, now);
      (map[k] ||= []).push(d);
    }
    return BUCKET_ORDER.filter(k => map[k]?.length).map(k => ({ title: k, data: map[k] }));
  }, [notifications]);

  // Clear the unread highlight for specific notifications the moment they're
  // tapped — purely local (the DB is already marked read on load, so leaving
  // the page or pull-refreshing resets EVERY row to the regular look).
  function markReadLocally(ids: string[]) {
    const set = new Set(ids);
    setNotifications(prev => prev.map(n => (set.has(n.id) ? { ...n, read: true } : n)));
  }

  /**
   * Go to a TAB from this screen.
   *
   * This screen is presented as a sheet over the tabs, so `router.push` to a
   * tab href stacks a whole second copy of the app on top of the sheet — which
   * reads as the home page sliding DOWN over the notifications, and is as
   * strange as it sounds. dismissTo pops back to the pager already mounted
   * underneath, in one dispatch, which is what tapping these rows should feel
   * like.
   *
   * Not only cosmetic. app/spotlight.tsx carries the long version: a tab href
   * pushed from a modal can be re-resolved by the root Stack into a SECOND
   * (tabs) group, which starts on Home and double-mounts HomeScreen — the
   * realtime-channel crash. The group-qualified href plus dismissTo avoids
   * both. Same shape as app/saved.tsx, fallback for an older router included.
   */
  function goToTab(href: string) {
    const r = router as any;
    if (typeof r.dismissTo === 'function') r.dismissTo(href);
    else { try { r.dismissAll?.(); } catch {} r.navigate(href); }
  }

  function handlePress(notif: Notification) {
    markReadLocally([notif.id]);
    // A Laybell message goes wherever it just said to go. Every one of these is
    // a nudge to DO something, so landing on a screen that is not the thing it
    // named would waste the one moment the person came back for.
    if (notif.type === 'system') {
      // The destination comes from lib/notificationRoute, shared with the push
      // handler so a tapped notification and a tapped row cannot disagree.
      const dest = destForSystemKey(notif.system_key, selfId);
      // 'unread' resolves to this very screen — already answered by being here.
      if (!dest || dest.href === '/notifications') return;
      // A tab has to be popped down to, not stacked on top. Anything else is an
      // ordinary screen in this stack, where sliding in over the list is right.
      if (dest.tab) goToTab(dest.href);
      else router.push(dest.href as any);
      return;
    }
    // The live rail, not a specific stream: this row records WHO went live,
    // not which broadcast, and by the time it is read the stream may be over.
    if (notif.type === 'live_started') { router.push('/live'); return; }
    // An offer lives in the DM thread, where it can actually be answered.
    if (notif.type === 'message' || notif.type === 'offer') router.push(`/messages/${notif.actor_id}`);
    // A song-in-story notification opens the poster's story (only up for 24h).
    else if (notif.type === 'song_story') router.push(`/story/${notif.actor_id}`);
    else if (notif.post_id) router.push(`/post/${notif.post_id}`);
    else if (notif.actor_id) router.push(`/profile/${notif.actor_id}`);
  }

  if (loading) {
    // Same SwipeBackPager root as the loaded tree so the pager instance (and
    // its slide-in entrance) carries over when the content swaps in. Render the
    // real header above a grey pulsating skeleton of the notification rows so
    // the layout doesn't jump when the content swaps in.
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
              <Ionicons name="chevron-back" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('settings.section.notifications')}</Text>
            <View style={{ width: 42 }} />
          </View>
          <View style={styles.skeletonBody}>
            <NotificationsSkeleton rows={8} />
          </View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    // Swipe right anywhere to slide the whole page (header included) off and
    // reveal the screen underneath — one motion, same feel as the tab pager.
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('settings.section.notifications')}</Text>
        <View style={{ width: 42 }} />
      </View>

          <SectionList
            sections={sections}
            keyExtractor={item => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            stickySectionHeadersEnabled={false}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchNotifications().catch(() => { setLoading(false); setRefreshing(false); }); }} tintColor={colors.primary} />
            }
            renderSectionHeader={({ section }) => (
              <Text style={styles.sectionHeader}>{t(SECTION_KEYS[section.title] ?? 'notifications.earlier')}</Text>
            )}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                {/* Bare muted glyph, no container — the same empty state
                    Messages and the Music tab already use. This screen was the
                    last one still drawing a tinted box around its icon, which
                    gave the emptiest view in the app its most decorated object,
                    and in brand orange, on a screen with nothing to act on. */}
                <Ionicons name="notifications-outline" size={64} color={colors.textTertiary} />
                <Text style={styles.emptyTitle}>{t('notifications.emptyTitle')}</Text>
                <Text style={styles.emptySubtitle}>{t('notifications.emptySub')}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const icon = notificationIcon(item.type);
              const isSystem = item.type === 'system';
              const isDiamond = !isSystem && displayedTier(item.actor) === 'diamond';
              const preview = item.post_id ? previews[item.post_id] : undefined;
              const count = item.groupCount ?? 1;
              const grouped = count > 1;
              const isConnection = item.type === 'follow' || item.type === 'friend';
              const children = item.children ?? [item];
              // A grouped run of post-bearing actions can expand to show each post.
              const expandable = grouped && children.some((c) => !!c.post_id);
              const expanded = expandedIds.has(item.id);
              return (
                <View>
                  <TouchableOpacity
                    style={[styles.row, !item.read && styles.rowUnread]}
                    onPress={() => {
                      // Tapping a row reads it (grouped rows read the whole run).
                      markReadLocally([item.id, ...children.map((c) => c.id)]);
                      expandable ? toggleExpand(item.id) : handlePress(item);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={styles.avatarWrap}>
                      {isSystem ? (
                        // The Laybell mark, not an avatar and not a StoryAvatar
                        // — that one opens a story ring and there is no story
                        // and no person behind it to open.
                        <Image source={LAYBELL_MARK} style={styles.systemMark} />
                      ) : (
                        <StoryAvatar
                          userId={item.actor?.id}
                          avatarUrl={item.actor?.avatar_url}
                          name={item.actor?.display_name}
                          size={52}
                        />
                      )}
                      {/* One emblem per avatar, never two. A diamond account
                          already carries the badge below, and that badge says
                          more about them than a type icon does — stacking both
                          on one 52pt circle is two things competing to be the
                          thing you notice. Diamond wins; the type is still in
                          the sentence. */}
                      {!!icon && !isDiamond && (
                        <View style={[styles.iconBadge, { backgroundColor: icon.color }]}>
                          <Ionicons name={icon.name} size={11} color={icon.ink ?? colors.text} />
                        </View>
                      )}
                      {/* Keep the notifications list clean — only diamond status earns
                          an emblem here (respects the user's hide-badge toggle). */}
                      {isDiamond && (
                        <BadgeEmblem profile={item.actor} size={17} style={styles.notifEmblem} />
                      )}
                    </View>

                    <View style={styles.body}>
                      {/* A Laybell message stacks — sender on its own line, then
                          the message. Every other row is one sentence with the
                          name as its subject ("<name> liked your post"), and
                          these are not: "Laybell You have earnings waiting" run
                          together is not a sentence in any of the ten languages.
                          Three lines, because these are whole sentences and
                          clipping one mid-word makes a message meant to bring
                          someone back read as broken instead. */}
                      {isSystem ? (
                        <>
                          <Text style={styles.name}>Laybell</Text>
                          <Text style={styles.text} numberOfLines={3}>
                            {systemText(t, item.system_key, item.system_n)}
                          </Text>
                        </>
                      ) : (
                        <Text style={styles.text} numberOfLines={2}>
                          <Text style={styles.name}>{item.actor?.display_name ?? t('notifications.someone')}</Text>
                          {' '}{grouped ? groupedText(t, item.type, count) : notificationText(t, item.type)}
                        </Text>
                      )}
                      <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                    </View>

                    {isConnection ? (
                      <FollowButton userId={item.actor_id} style={styles.followBtn} />
                    ) : expandable ? (
                      <View style={styles.chevronWrap}>
                        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textSecondary} />
                      </View>
                    ) : preview ? (
                      <Image source={{ uri: preview }} style={styles.thumb} />
                    ) : !item.read ? (
                      <View style={styles.unreadDot} />
                    ) : null}
                  </TouchableOpacity>

                  {/* Expanded: each individual post in the run, tappable to open it. */}
                  {expandable && expanded && (
                    <View style={styles.expandStrip}>
                      {children.map((c) => {
                        const p = c.post_id ? previews[c.post_id] : undefined;
                        return (
                          <TouchableOpacity key={c.id} onPress={() => handlePress(c)} activeOpacity={0.8}>
                            {p ? (
                              <Image source={{ uri: p }} style={styles.expandThumb} />
                            ) : (
                              <View style={[styles.expandThumb, styles.expandThumbEmpty]}>
                                <Ionicons name="image-outline" size={18} color={colors.textTertiary} />
                              </View>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            }}
          />
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  skeletonBody: { flex: 1, paddingHorizontal: SPACING.sm, paddingTop: SPACING.sm },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: 0.2 },
  list: { flex: 1 },
  // flexGrow so the scrollable content fills the screen even with few/no items —
  // makes pull-to-refresh work when dragging anywhere, not just over a row.
  listContent: { flexGrow: 1, paddingHorizontal: SPACING.sm, paddingBottom: SPACING.xl },

  sectionHeader: {
    color: colors.textTertiary, fontSize: 12, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.9,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: SPACING.xs,
  },

  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.md, gap: SPACING.md,
  },
  rowUnread: { backgroundColor: colors.primary + '12' },
  avatarWrap: { position: 'relative', width: 52, height: 52 },
  // Square-with-soft-corners rather than a circle, so a Laybell message is
  // distinguishable from a person's row at a glance and from across the list.
  // The hairline keeps the mark from bleeding into a light background.
  systemMark: {
    width: 52, height: 52, borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  iconBadge: {
    position: 'absolute', bottom: -2, right: -2, width: 21, height: 21, borderRadius: 10.5,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.background,
  },
  notifEmblem: { position: 'absolute', top: -2, right: -2, borderWidth: 1.5, borderColor: colors.background },
  body: { flex: 1 },
  text: { color: colors.textSecondary, fontSize: 14.5, lineHeight: 20 },
  name: { color: colors.text, fontWeight: '700' },
  time: { color: colors.textTertiary, fontSize: 12, marginTop: 3 },

  thumb: { width: 46, height: 46, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceLight },
  unreadDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: colors.primary, marginRight: SPACING.xs },
  // Taller pill with a consistent min width so Follow / Follow back / Following all
  // line up cleanly, and a little right inset so it isn't flush to the edge.
  // minWidth is fine on the shell (the gradient inside stretches to it), but
  // paddingVertical is NOT: FollowButton keeps its padding on an inner fill
  // layer, so an outer value pads AROUND the pill instead of making it taller —
  // the button ends up shorter than intended with dead space either side.
  // Dropped, which also makes this pill match every other one in the app.
  followBtn: { minWidth: 100, marginRight: SPACING.xs },
  chevronWrap: { width: 46, alignItems: 'center', justifyContent: 'center' },

  // Expanded grouped row: each liked/commented post as a tappable thumbnail,
  // indented to line up under the notification text.
  expandStrip: {
    flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm,
    paddingLeft: 52 + SPACING.md + SPACING.sm, paddingRight: SPACING.sm,
    paddingBottom: SPACING.sm, marginTop: -SPACING.xs,
  },
  expandThumb: { width: 56, height: 56, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceLight },
  expandThumbEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },

  // Apple's empty-state shape, matched to Messages and the Music tab so the
  // three read as one pattern rather than three takes on it: a large muted
  // glyph, a title carrying the weight, a deliberately quieter line under it,
  // and nothing drawn around any of it.
  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 1.5, gap: SPACING.sm, paddingHorizontal: SPACING.xl },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4, marginTop: SPACING.sm },
  emptySubtitle: { color: colors.textTertiary, fontSize: 13.5, lineHeight: 19, textAlign: 'center', maxWidth: 260 },
});
