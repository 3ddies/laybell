import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { coverFade } from '../../lib/coverFade';
import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAudio } from '../../contexts/AudioContext';
import { usePostOptions } from '../../contexts/PostOptionsContext';
import SwipeBackPager from '../../components/SwipeBackPager';
import TrackRow from '../../components/TrackRow';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { countLabel } from '../../lib/i18n';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { Skeleton, SkeletonLine, TrackListSkeleton } from '../../components/Skeleton';

// Universal playlist viewer — opened from any square playlist cover (profile
// showcases, etc.). Mirrors the music tab's playlist detail: header card with
// cover/title/meta, then the tracklist as a playable queue. Non-owners
// playing a public playlist count a listen (once per visit; the RPC re-checks
// owner/public server-side). RLS limits fetches to public or own playlists.
export default function PlaylistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { playQueue, expand, currentTrack, isPlaying } = useAudio();
  const { show: showOptions } = usePostOptions();

  const [playlist, setPlaylist] = useState<any | null>(null);
  const [creator, setCreator] = useState<any | null>(null);
  const [tracks, setTracks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const bumpedRef = useRef(false);

  useEffect(() => {
    (async () => {
      const [{ data: { user } }, plRes] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from('playlists').select('*').eq('id', id).maybeSingle(),
      ]);
      setCurrentUserId(user?.id ?? null);
      const pl = plRes.data;
      if (!pl) { setLoading(false); return; } // deleted, or private and not ours
      const [profRes, tracksRes] = await Promise.all([
        supabase.from('profiles')
          .select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme')
          .eq('id', pl.user_id).maybeSingle(),
        supabase.from('playlist_tracks')
          .select('post_id, position, posts(id, type, archived_at, media_url, caption, stream_count, cover_url, user_id, profiles!posts_user_id_fkey(id, username, display_name, avatar_url))')
          .eq('playlist_id', pl.id)
          .order('position', { ascending: true }),
      ]);
      setPlaylist(pl);
      setCreator(profRes.data ?? null);
      // Drop tracks whose song is gone (deleted/hidden → null embed) or archived
      // by its owner, so they never render or play. Restoring the song brings it
      // back (the playlist_tracks row is untouched — only the display filters).
      setTracks((tracksRes.data ?? []).filter((t: any) => t.posts && !t.posts.archived_at));
      setLoading(false);
    })();
  }, [id]);

  const isOwn = !!playlist && playlist.user_id === currentUserId;
  const cover = tracks[0]?.posts?.cover_url ?? null;

  const queue = () => tracks.map((t: any) => ({
    id: t.posts?.id, uri: t.posts?.media_url, caption: t.posts?.caption,
    artist: t.posts?.profiles?.display_name ?? '', cover: t.posts?.cover_url,
  })).filter(q => q.id && q.uri);

  function playFrom(index: number) {
    playQueue(queue(), index);
    if (playlist && !isOwn && playlist.is_public && !bumpedRef.current) {
      bumpedRef.current = true;
      supabase.rpc('bump_playlist_play', { p_playlist_id: playlist.id }).then(undefined, () => {});
    }
  }

  async function removeTrack(postId: string) {
    await supabase.from('playlist_tracks').delete().eq('playlist_id', id).eq('post_id', postId);
    setTracks(prev => prev.filter((t: any) => t.post_id !== postId));
  }

  return (
    // One-motion swipe-back, same as the rest of the app's pushed screens.
    <SwipeBackPager>
    <View style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={22} color={colors.primaryLight} />
        <Text style={styles.backText}>{t('playlist.back')}</Text>
      </TouchableOpacity>
      <View style={styles.divider} />

      {loading ? (
        // Skeleton mirrors the loaded layout: horizontal header card (76x76
        // cover + title/meta bars), a divider, then a single-column track list.
        <View style={styles.skeletonBody}>
          <View style={styles.detailHeader}>
            <Skeleton width={76} height={76} radius={RADIUS.md} />
            <View style={styles.detailInfo}>
              <SkeletonLine w="80%" h={22} />
              <SkeletonLine w="55%" h={12} style={{ marginTop: 9 }} />
            </View>
          </View>
          <View style={styles.dividerBottom} />
          <TrackListSkeleton rows={7} />
        </View>
      ) : !playlist ? (
        <View style={styles.center}>
          <Ionicons name="albums-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.unavailable}>{t('playlist.unavailable')}</Text>
        </View>
      ) : (
        <>
          {/* Header card — cover art, prominent title, meta line */}
          <View style={styles.detailHeader}>
            {cover ? (
              <ExpoImage source={{ uri: cover }} style={styles.detailCover} contentFit="cover" cachePolicy="memory-disk" transition={coverFade(cover)} />
            ) : (
              <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.detailCover}>
                <Ionicons name="musical-notes" size={26} color={colors.primary} />
              </LinearGradient>
            )}
            <View style={styles.detailInfo}>
              <Text style={styles.title} numberOfLines={2}>{playlist.name}</Text>
              {isOwn ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {playlist.is_public ? t('post.public') : t('playlist.private')}
                  {` · ${countLabel('track', tracks.length)}`}
                  {playlist.is_public ? ` · ${countLabel('listen', playlist.play_count ?? 0)}` : ''}
                </Text>
              ) : (
                <TouchableOpacity onPress={() => router.push(`/profile/${playlist.user_id}`)} hitSlop={6}>
                  <Text style={styles.meta} numberOfLines={1}>
                    {t('playlist.by')} <Text style={styles.metaAccent}>@{creator?.username ?? t('playlist.unknownCreator')}</Text>
                    {` · ${countLabel('listen', playlist.play_count ?? 0)}`}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          <View style={styles.dividerBottom} />

          <FlatList
            data={tracks}
            keyExtractor={(item: any) => item.post_id}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={styles.unavailable}>{t('playlist.empty')}</Text>
              </View>
            }
            renderItem={({ item, index }: any) => (
              <TrackRow
                caption={item.posts?.caption}
                artist={item.posts?.profiles?.display_name}
                username={item.posts?.profiles?.username}
                streams={item.posts?.stream_count}
                cover={item.posts?.cover_url}
                avatarUrl={item.posts?.profiles?.avatar_url}
                isPlaying={currentTrack?.id === item.posts?.id && isPlaying}
                onPlay={() => playFrom(index)}
                onCoverPress={() => { playFrom(index); expand(); }}
                onAvatarPress={() => router.push(`/profile/${item.posts?.user_id}`)}
                onOptions={() => showOptions({
                  postId: item.posts?.id,
                  isOwn: item.posts?.user_id === currentUserId,
                  authorId: item.posts?.user_id,
                  authorName: item.posts?.profiles?.username,
                  mediaType: 'audio',
                  mediaUrl: item.posts?.media_url,
                  cover: item.posts?.cover_url,
                  onEdit: () => router.push(`/edit-post/${item.posts?.id}`),
                  onDeleted: () => setTracks(prev => prev.filter((t: any) => t.post_id !== item.post_id)),
                  onArchived: () => setTracks(prev => prev.filter((t: any) => t.post_id !== item.post_id)),
                  onBlocked: () => setTracks(prev => prev.filter((t: any) => t.posts?.user_id !== item.posts?.user_id)),
                  onRemoveFromPlaylist: isOwn ? () => removeTrack(item.post_id) : undefined,
                })}
              />
            )}
          />
        </>
      )}
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  skeletonBody: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: SPACING.xxl },
  unavailable: { color: colors.textTertiary, fontSize: 14 },

  backBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
  },
  backText: { color: colors.primaryLight, fontSize: 18, fontWeight: '700' },
  divider: { height: 0.5, backgroundColor: colors.border },
  dividerBottom: { height: 0.5, backgroundColor: colors.border, marginBottom: SPACING.sm },

  detailHeader: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, marginTop: SPACING.lg, marginBottom: SPACING.lg,
  },
  detailCover: {
    width: 76, height: 76, borderRadius: RADIUS.md,
    backgroundColor: colors.surfaceLight, alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  detailInfo: { flex: 1 },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, lineHeight: 31 },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: 5 },
  metaAccent: { color: colors.primary, fontWeight: '700' },

  listContent: { paddingHorizontal: SPACING.sm, paddingBottom: SPACING.xxl, gap: SPACING.xs },
});
