import {
  View, Text, StyleSheet, SectionList,
  TouchableOpacity, Image, RefreshControl,
} from 'react-native';
import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
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

type Notification = {
  id: string; type: 'like' | 'comment' | 'follow' | 'friend' | 'message' | 'mention' | 'song_used' | 'song_story' | 'tag';
  post_id: string | null; actor_id: string; read: boolean; created_at: string;
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
    if (n.type === 'follow' || n.type === 'friend') {
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
    default: return t('notifications.interacted');
  }
}

function notificationIcon(type: string): { name: any; color: string } {
  switch (type) {
    case 'like': return { name: 'heart', color: COLORS.like };
    case 'comment': return { name: 'chatbubble', color: COLORS.primary };
    case 'follow': return { name: 'person-add', color: COLORS.primaryLight };
    case 'friend': return { name: 'people', color: COLORS.primaryLight };
    case 'message': return { name: 'chatbubbles', color: '#60A5FA' };
    case 'mention': return { name: 'at', color: COLORS.primary };
    case 'tag': return { name: 'pricetag', color: COLORS.primary };
    case 'song_used': return { name: 'musical-notes', color: COLORS.primaryLight };
    case 'song_story': return { name: 'musical-notes', color: COLORS.primaryLight };
    default: return { name: 'notifications', color: COLORS.primary };
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
  useEffect(() => { fetchNotifications(); }, []);

  async function fetchNotifications() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: notifData, error } = await supabase
      .from('notifications')
      .select('id, type, post_id, read, created_at, actor_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) console.error('notifications fetch error:', error.message);

    if (notifData && notifData.length > 0) {
      const actorIds = [...new Set(notifData.map(n => n.actor_id))];
      const postIds = [...new Set(notifData.map(n => n.post_id).filter(Boolean))] as string[];
      const [{ data: profileData }, postsRes] = await Promise.all([
        supabase.from('profiles').select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden').in('id', actorIds),
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
      setNotifications(notifData.map(n => ({ ...n, actor: profileMap[n.actor_id] ?? null })) as any);
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

  function handlePress(notif: Notification) {
    markReadLocally([notif.id]);
    if (notif.type === 'message') router.push(`/messages/${notif.actor_id}`);
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
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
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
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
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
              <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchNotifications(); }} tintColor={colors.primary} />
            }
            renderSectionHeader={({ section }) => (
              <Text style={styles.sectionHeader}>{t(SECTION_KEYS[section.title] ?? 'notifications.earlier')}</Text>
            )}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <LinearGradient colors={[colors.primary + '24', colors.background]} style={styles.emptyIconWrap}>
                  <Ionicons name="notifications-outline" size={40} color={colors.primary} />
                </LinearGradient>
                <Text style={styles.emptyTitle}>{t('notifications.emptyTitle')}</Text>
                <Text style={styles.emptySubtitle}>{t('notifications.emptySub')}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const icon = notificationIcon(item.type);
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
                      <StoryAvatar
                        userId={item.actor?.id}
                        avatarUrl={item.actor?.avatar_url}
                        name={item.actor?.display_name}
                        size={52}
                      />
                      <View style={[styles.iconBadge, { backgroundColor: icon.color }]}>
                        <Ionicons name={icon.name} size={11} color={colors.text} />
                      </View>
                      {/* Keep the notifications list clean — only diamond status earns
                          an emblem here (respects the user's hide-badge toggle). */}
                      {displayedTier(item.actor) === 'diamond' && (
                        <BadgeEmblem profile={item.actor} size={17} style={styles.notifEmblem} />
                      )}
                    </View>

                    <View style={styles.body}>
                      <Text style={styles.text} numberOfLines={2}>
                        <Text style={styles.name}>{item.actor?.display_name ?? t('notifications.someone')}</Text>
                        {' '}{grouped ? groupedText(t, item.type, count) : notificationText(t, item.type)}
                      </Text>
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
  followBtn: { paddingVertical: 8, minWidth: 100, marginRight: SPACING.xs },
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

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 2, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptyIconWrap: { width: 90, height: 90, borderRadius: RADIUS.xl + 8, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  emptySubtitle: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
