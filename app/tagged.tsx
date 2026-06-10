import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Image, RefreshControl,
} from 'react-native';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { timeAgo } from '../lib/timeAgo';
import { isSlideshow } from '../lib/slideshow';
import VideoThumb from '../components/VideoThumb';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

type TabKey = 'posts' | 'audio' | 'comments' | 'stories';
const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'posts', label: 'Posts', icon: 'at-outline' },
  { key: 'audio', label: 'Audio', icon: 'musical-notes-outline' },
  { key: 'comments', label: 'Comments', icon: 'chatbubble-outline' },
  { key: 'stories', label: 'Stories', icon: 'ellipse-outline' },
];

const EMPTY: Record<TabKey, { icon: any; text: string }> = {
  posts: { icon: 'at-outline', text: 'No posts have mentioned you yet' },
  audio: { icon: 'musical-notes-outline', text: 'No one has used your audio in a post yet' },
  comments: { icon: 'chatbubble-outline', text: 'No comments have mentioned you yet' },
  stories: { icon: 'ellipse-outline', text: 'No active stories are using your audio' },
};

export default function TaggedScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('posts');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [posts, setPosts] = useState<any[]>([]);     // posts that @mentioned me
  const [audio, setAudio] = useState<any[]>([]);      // posts that used my song
  const [comments, setComments] = useState<any[]>([]); // comments that @mentioned me
  const [stories, setStories] = useState<any[]>([]);   // active stories using my song

  useEffect(() => { fetchAll(); }, []);

  async function fetchAll() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const uid = user.id;

    const [mPostsRes, audioRes, mCommentsRes, storiesRes, taggedPostsRes] = await Promise.all([
      supabase.from('mentions').select('post_id, created_at').eq('mentioned_user_id', uid).not('post_id', 'is', null).order('created_at', { ascending: false }).limit(100),
      supabase.from('posts').select('*, profiles!posts_user_id_fkey(username, display_name, avatar_url)').eq('song_artist_id', uid).neq('user_id', uid).order('created_at', { ascending: false }).limit(100),
      supabase.from('mentions').select('comment_id, created_at').eq('mentioned_user_id', uid).not('comment_id', 'is', null).order('created_at', { ascending: false }).limit(100),
      supabase.from('stories').select('id, user_id, media_url, thumbnail_url, media_type, song_title, created_at, expires_at').eq('song_artist_id', uid).neq('user_id', uid).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(100),
      supabase.from('posts').select('*, profiles!posts_user_id_fkey(username, display_name, avatar_url)').contains('tagged_user_ids', [uid]).order('created_at', { ascending: false }).limit(100),
    ]);

    // Posts where I'm @mentioned OR explicitly tagged — merge + dedupe, newest first.
    const postIds = [...new Set((mPostsRes.data ?? []).map((m: any) => m.post_id))];
    let mentioned: any[] = [];
    if (postIds.length) {
      const { data } = await supabase.from('posts').select('*, profiles!posts_user_id_fkey(username, display_name, avatar_url)').in('id', postIds);
      mentioned = data ?? [];
    }
    const seenP = new Set<string>();
    const mergedPosts = [...mentioned, ...(taggedPostsRes.data ?? [])]
      .filter((p: any) => (seenP.has(p.id) ? false : (seenP.add(p.id), true)))
      .sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1));
    setPosts(mergedPosts);

    setAudio(audioRes.data ?? []);

    // Comments that mentioned me — fetch + restore mention order.
    const commentIds = [...new Set((mCommentsRes.data ?? []).map((m: any) => m.comment_id))];
    if (commentIds.length) {
      const { data } = await supabase.from('comments').select('id, body, post_id, created_at, user_id, profiles!comments_user_id_fkey(username, display_name, avatar_url)').in('id', commentIds);
      const byId = Object.fromEntries((data ?? []).map((c: any) => [c.id, c]));
      setComments(commentIds.map((id) => byId[id]).filter(Boolean));
    } else setComments([]);

    // Active stories using my song — enrich with poster profiles (stories FK is to auth.users).
    const st = storiesRes.data ?? [];
    if (st.length) {
      const userIds = [...new Set(st.map((s: any) => s.user_id))];
      const { data: profs } = await supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds);
      const pmap = Object.fromEntries((profs ?? []).map((p: any) => [p.id, p]));
      setStories(st.map((s: any) => ({ ...s, profile: pmap[s.user_id] ?? null })));
    } else setStories([]);

    setLoading(false);
    setRefreshing(false);
  }

  const openPost = useCallback((post: any) => {
    const pathname = post.type === 'video' ? '/reel/[id]' : '/post/[id]';
    router.push({ pathname, params: { id: post.id, post: JSON.stringify(post) } } as any);
  }, [router]);

  function gridThumb(post: any) {
    if (isSlideshow(post.type)) return (
      <><Image source={{ uri: post.thumbnail_url || post.media_url }} style={styles.gridImage} resizeMode="cover" />
        <View style={styles.gridBadge}><Ionicons name="copy" size={12} color={COLORS.text} /></View></>
    );
    if (post.type === 'video') return (
      <><VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.gridImage} />
        <View style={styles.gridBadge}><Ionicons name="play" size={13} color={COLORS.text} /></View></>
    );
    if (post.type === 'image') return <Image source={{ uri: post.media_url }} style={styles.gridImage} resizeMode="cover" />;
    if (post.cover_url) return (
      <><Image source={{ uri: post.cover_url }} style={styles.gridImage} resizeMode="cover" />
        <View style={styles.gridBadge}><Ionicons name="musical-notes" size={12} color={COLORS.text} /></View></>
    );
    return (
      <LinearGradient colors={['#1C0E06', '#120A04']} style={[styles.gridImage, styles.gridPlaceholder]}>
        <Ionicons name="musical-notes" size={24} color={COLORS.primary} />
      </LinearGradient>
    );
  }

  function renderEmpty() {
    const e = EMPTY[tab];
    return (
      <View style={styles.empty}>
        <LinearGradient colors={['#1C0A04', COLORS.background]} style={styles.emptyIcon}>
          <Ionicons name={e.icon} size={36} color={COLORS.primary} />
        </LinearGradient>
        <Text style={styles.emptyText}>{e.text}</Text>
      </View>
    );
  }

  function renderContent() {
    if (tab === 'posts' || tab === 'audio') {
      const data = tab === 'posts' ? posts : audio;
      return (
        <FlatList
          key={tab}
          data={data}
          numColumns={3}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.gridContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAll(); }} tintColor={COLORS.primary} />}
          ListEmptyComponent={renderEmpty}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.gridItem} onPress={() => openPost(item)} activeOpacity={0.85}>
              {gridThumb(item)}
            </TouchableOpacity>
          )}
        />
      );
    }

    if (tab === 'comments') {
      return (
        <FlatList
          key="comments"
          data={comments}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAll(); }} tintColor={COLORS.primary} />}
          ListEmptyComponent={renderEmpty}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => router.push(`/post/${item.post_id}`)} activeOpacity={0.8}>
              <Avatar profile={item.profiles} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText} numberOfLines={3}>
                  <Text style={styles.rowName}>{item.profiles?.display_name ?? 'Someone'}</Text>
                  {' '}{item.body}
                </Text>
                <Text style={styles.rowTime}>{timeAgo(item.created_at)} · tap to view</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={COLORS.textTertiary} />
            </TouchableOpacity>
          )}
        />
      );
    }

    // stories
    return (
      <FlatList
        key="stories"
        data={stories}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAll(); }} tintColor={COLORS.primary} />}
        ListEmptyComponent={renderEmpty}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => router.push(`/story/${item.user_id}`)} activeOpacity={0.8}>
            {item.thumbnail_url || item.media_url ? (
              <Image source={{ uri: item.thumbnail_url || item.media_url }} style={styles.storyThumb} resizeMode="cover" />
            ) : (
              <View style={[styles.storyThumb, styles.gridPlaceholder]}><Ionicons name="musical-notes" size={18} color={COLORS.primary} /></View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.rowText} numberOfLines={2}>
                <Text style={styles.rowName}>{item.profile?.display_name ?? 'Someone'}</Text>
                {' '}used your audio in their story
              </Text>
              <Text style={styles.rowTime}>{timeAgo(item.created_at)} · up for 24h</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={COLORS.textTertiary} />
          </TouchableOpacity>
        )}
      />
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Tagged</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.tabsRow}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <TouchableOpacity key={t.key} style={[styles.tab, on && styles.tabActive]} onPress={() => setTab(t.key)}>
              <Ionicons name={t.icon} size={16} color={on ? COLORS.primary : COLORS.textTertiary} />
              <Text style={[styles.tabText, on && styles.tabTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading
        ? <View style={styles.loading}><ActivityIndicator color={COLORS.primary} size="large" /></View>
        : renderContent()}
    </View>
  );
}

function Avatar({ profile }: { profile: any }) {
  if (profile?.avatar_url) return <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />;
  return (
    <LinearGradient colors={['#3A1C0C', '#1C0E06']} style={styles.avatar}>
      <Text style={styles.avatarText}>{(profile?.display_name || '?').charAt(0).toUpperCase()}</Text>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },

  tabsRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: COLORS.border },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: SPACING.sm + 2 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: COLORS.primary },
  tabText: { color: COLORS.textTertiary, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: COLORS.text, fontWeight: '700' },

  gridContent: { flexGrow: 1 },
  gridItem: { width: '33.33%', aspectRatio: 1 },
  gridImage: { width: '100%', height: '100%' },
  gridPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: COLORS.border },
  gridBadge: { position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },

  listContent: { flexGrow: 1, padding: SPACING.md, gap: SPACING.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.sm, borderRadius: RADIUS.md },
  avatar: { width: 44, height: 44, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  storyThumb: { width: 44, height: 56, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceLight },
  rowText: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 19 },
  rowName: { color: COLORS.text, fontWeight: '700' },
  rowTime: { color: COLORS.textTertiary, fontSize: 12, marginTop: 3 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.xxl * 2, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptyIcon: { width: 84, height: 84, borderRadius: RADIUS.xl + 8, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 21 },
});
