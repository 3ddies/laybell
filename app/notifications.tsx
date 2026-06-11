import {
  View, Text, StyleSheet, SectionList,
  TouchableOpacity, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useRouter, Stack } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../constants/theme';
import { timeAgo } from '../lib/timeAgo';
import { displayedTier } from '../lib/badges';
import StoryAvatar from '../components/StoryAvatar';
import BadgeEmblem from '../components/BadgeEmblem';
import FollowButton from '../components/FollowButton';

type Notification = {
  id: string; type: 'like' | 'comment' | 'follow' | 'friend' | 'message' | 'mention' | 'song_used' | 'song_story' | 'tag';
  post_id: string | null; actor_id: string; read: boolean; created_at: string;
  actor: { id: string; username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null } | null;
};

// A row to render: a single notification, or several consecutive same-type actions
// from the same actor collapsed into one. `children` holds every notification in the
// run (newest-first) so a grouped row can expand to show each individual post.
type DisplayNotif = Notification & { groupCount?: number; children?: Notification[] };

// Plural phrasing for a grouped run of `count` actions by a single actor.
function groupedText(type: string, count: number): string {
  switch (type) {
    case 'like': return `liked ${count} posts`;
    case 'comment': return `commented on ${count} posts`;
    case 'message': return `sent you ${count} messages`;
    case 'mention': return `mentioned you in ${count} posts`;
    case 'tag': return `tagged you in ${count} posts`;
    case 'song_used': return `used your audio in ${count} posts`;
    case 'song_story': return `used your audio in ${count} stories`;
    default: return notificationText(type);
  }
}

// Collapse a consecutive run of the SAME type from the SAME actor into one row
// (e.g. five likes in a row → "<name> liked 5 posts"). follow/friend never group —
// they carry a Follow button and only happen once. Input is newest-first, so the
// kept representative is the most recent; `children` keeps the whole run so the row
// can expand into the individual posts.
function groupConsecutive(items: Notification[]): DisplayNotif[] {
  const out: DisplayNotif[] = [];
  for (const n of items) {
    const groupable = n.type !== 'follow' && n.type !== 'friend';
    const last = out[out.length - 1];
    if (groupable && last && last.type === n.type && last.actor_id === n.actor_id) {
      last.groupCount = (last.groupCount ?? 1) + 1;
      last.children!.push(n);
      continue;
    }
    out.push({ ...n, groupCount: 1, children: [n] });
  }
  return out;
}

function notificationText(type: string) {
  switch (type) {
    case 'like': return 'liked your post';
    case 'comment': return 'commented on your post';
    case 'follow': return 'started following you';
    case 'friend': return 'followed you back — you’re now friends';
    case 'message': return 'sent you a message';
    case 'mention': return 'mentioned you';
    case 'tag': return 'tagged you in a post';
    case 'song_used': return 'used your audio in a post';
    case 'song_story': return 'used your audio in their story';
    default: return 'interacted with you';
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

export default function NotificationsScreen() {
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
  // Native-pager dismiss (page 0 = back) so swiping right goes back without the
  // stack gesture fighting vertical scroll — same as settings / the profile pager.
  const pagerRef = useRef<PagerView>(null);

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
        supabase.from('profiles').select('id, username, display_name, avatar_url, badge_tier, badge_show').in('id', actorIds),
        postIds.length
          ? supabase.from('posts').select('id, type, media_url, cover_url, thumbnail_url').in('id', postIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const profileMap = Object.fromEntries((profileData ?? []).map(p => [p.id, p]));
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

  // Group into time buckets (already sorted newest-first from the query).
  const sections = useMemo(() => {
    const now = Date.now();
    const map: Record<string, Notification[]> = {};
    for (const n of notifications) {
      const k = bucketFor(n.created_at, now);
      (map[k] ||= []).push(n);
    }
    return BUCKET_ORDER.filter(k => map[k]?.length).map(k => ({ title: k, data: groupConsecutive(map[k]) }));
  }, [notifications]);

  function handlePress(notif: Notification) {
    if (notif.type === 'message') router.push(`/messages/${notif.actor_id}`);
    // A song-in-story notification opens the poster's story (only up for 24h).
    else if (notif.type === 'song_story') router.push(`/story/${notif.actor_id}`);
    else if (notif.post_id) router.push(`/post/${notif.post_id}`);
    else if (notif.actor_id) router.push(`/profile/${notif.actor_id}`);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 42 }} />
      </View>

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
          <SectionList
            sections={sections}
            keyExtractor={item => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            stickySectionHeadersEnabled={false}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchNotifications(); }} tintColor={COLORS.primary} />
            }
            renderSectionHeader={({ section }) => (
              <Text style={styles.sectionHeader}>{section.title}</Text>
            )}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <LinearGradient colors={['#1C0A04', COLORS.background]} style={styles.emptyIconWrap}>
                  <Ionicons name="notifications-outline" size={40} color={COLORS.primary} />
                </LinearGradient>
                <Text style={styles.emptyTitle}>No notifications yet</Text>
                <Text style={styles.emptySubtitle}>When someone likes, comments, or follows you — it'll show here</Text>
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
                    onPress={() => (expandable ? toggleExpand(item.id) : handlePress(item))}
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
                        <Ionicons name={icon.name} size={11} color={COLORS.text} />
                      </View>
                      {/* Keep the notifications list clean — only diamond status earns
                          an emblem here (respects the user's hide-badge toggle). */}
                      {displayedTier(item.actor) === 'diamond' && (
                        <BadgeEmblem profile={item.actor} size={17} style={styles.notifEmblem} />
                      )}
                    </View>

                    <View style={styles.body}>
                      <Text style={styles.text} numberOfLines={2}>
                        <Text style={styles.name}>{item.actor?.display_name ?? 'Someone'}</Text>
                        {' '}{grouped ? groupedText(item.type, count) : notificationText(item.type)}
                      </Text>
                      <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                    </View>

                    {isConnection ? (
                      <FollowButton userId={item.actor_id} style={styles.followBtn} />
                    ) : expandable ? (
                      <View style={styles.chevronWrap}>
                        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={COLORS.textSecondary} />
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
                                <Ionicons name="image-outline" size={18} color={COLORS.textTertiary} />
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
      </PagerView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  pager: { flex: 1 },
  page: { flex: 1 },
  dismissPage: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 22, fontWeight: '800', letterSpacing: 0.2 },
  list: { flex: 1 },
  // flexGrow so the scrollable content fills the screen even with few/no items —
  // makes pull-to-refresh work when dragging anywhere, not just over a row.
  listContent: { flexGrow: 1, paddingHorizontal: SPACING.sm, paddingBottom: SPACING.xl },

  sectionHeader: {
    color: COLORS.textTertiary, fontSize: 12, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.9,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: SPACING.xs,
  },

  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.md, gap: SPACING.md,
  },
  rowUnread: { backgroundColor: COLORS.primary + '12' },
  avatarWrap: { position: 'relative', width: 52, height: 52 },
  iconBadge: {
    position: 'absolute', bottom: -2, right: -2, width: 21, height: 21, borderRadius: 10.5,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: COLORS.background,
  },
  notifEmblem: { position: 'absolute', top: -2, right: -2, borderWidth: 1.5, borderColor: COLORS.background },
  body: { flex: 1 },
  text: { color: COLORS.textSecondary, fontSize: 14.5, lineHeight: 20 },
  name: { color: COLORS.text, fontWeight: '700' },
  time: { color: COLORS.textTertiary, fontSize: 12, marginTop: 3 },

  thumb: { width: 46, height: 46, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceLight },
  unreadDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: COLORS.primary, marginRight: SPACING.xs },
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
  expandThumb: { width: 56, height: 56, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceLight },
  expandThumbEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl * 2, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptyIconWrap: { width: 90, height: 90, borderRadius: RADIUS.xl + 8, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: '800' },
  emptySubtitle: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
