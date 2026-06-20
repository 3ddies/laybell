import { Video, ResizeMode } from 'expo-av';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Image, TextInput, KeyboardAvoidingView,
  Platform, ActivityIndicator, FlatList, Dimensions, Animated,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = SCREEN_W * 1.25; // match the feed's 4:5 cap
import { useEffect, useState, useRef, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge } from '../../lib/badges';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import { useAudio } from '../../contexts/AudioContext';
import { usePostMusic } from '../../contexts/PostMusicContext';
import { useIsFocused } from '@react-navigation/native';
import Comments from '../../components/Comments';
import MentionText from '../../components/MentionText';
import { timeAgo } from '../../lib/timeAgo';
import { createNotification } from '../../lib/createNotification';
import { usePostActionSheets } from '../../hooks/usePostActionSheets';
import FollowButton from '../../components/FollowButton';
import { trackVideoProgress } from '../../lib/viewTracker';
import { isAudioPost } from '../../lib/genres';
import { aspectToNumber } from '../../lib/aspectRatio';
import { useExpandTransition } from '../../hooks/useExpandTransition';
import { TabSwipeContext } from '../../contexts/PagerContext';
import SwipeBackPager from '../../components/SwipeBackPager';
import SongAttribution from '../../components/SongAttribution';
import SlideshowCarousel from '../../components/SlideshowCarousel';
import TaggedPeopleButton from '../../components/TaggedPeopleButton';
import { parseSlides, isSlideshow } from '../../lib/slideshow';
import { processMentions } from '../../lib/mentions';
import { isPostSpotlighted } from '../../lib/spotlight';

type Post = {
  id: string; type: string; media_url: string; caption: string;
  created_at: string; user_id: string;
  aspect_ratio?: string | null;
  stream_count?: number;
  cover_url?: string | null;
  thumbnail_url?: string | null;
  share_count?: number;
  trim_start?: number | null;
  trim_end?: number | null;
  song_id?: string | null;
  song_title?: string | null;
  song_artist?: string | null;
  song_artist_id?: string | null;
  tagged_user_ids?: string[] | null;
  slides?: any;
  profiles: { username: string; display_name: string; avatar_url: string | null; badge_tier?: string | null; badge_show?: boolean | null };
};
type Comment = {
  id: string; body: string; created_at: string; user_id: string;
  profiles: { username: string; display_name: string };
};

export default function PostDetailScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Hosted locally (not via the root context) so the sheets present over this
  // transparentModal route on iOS — see usePostActionSheets.
  const { share: openShare, showOptions, sheets } = usePostActionSheets();
  const { id, post: postParam, index: indexParam } = useLocalSearchParams<{ id: string; post?: string; index?: string }>();
  const initialSlide = indexParam ? (parseInt(indexParam, 10) || 0) : 0;
  const router = useRouter();
  const { currentTrack, isPlaying, play, stop } = useAudio();
  const { playSong, stop: stopSong, muted: songMuted, toggleMuted: toggleSongMuted } = usePostMusic();
  const isFocused = useIsFocused();
  const flatListRef = useRef<any>(null);
  const videoRef = useRef<any>(null);
  const { dismiss, popInstant, backdropOpacity, contentStyle } = useExpandTransition();
  // The swipe-back pager's gesture, paused while a slideshow carousel inside is
  // being touched (it provides TabSwipeContext below) so swiping between slides
  // never drags the whole post off-screen.
  const [pageSwipeOn, setPageSwipeOn] = useState(true);

  // Seed from the post passed in on tap so the screen renders instantly (no
  // loading spinner) — the fetch below just refreshes counts/details.
  const seeded = useMemo(() => {
    try { return postParam ? (JSON.parse(postParam) as any) : null; } catch { return null; }
  }, [postParam]);
  const [post, setPost] = useState<Post | null>(seeded);
  // Drives the subtle sparkle emblem by the username. A post tapped from the feed
  // carries its served __spotlight meta in the seed (instant), but the same post
  // opened from a profile/anywhere else doesn't — so setup() also asks the server
  // whether it's spotlighted right now and promotes this to true. Only ever turns
  // ON (the server check degrades to false on error, so it never hides a known one).
  const [isSpotlight, setIsSpotlight] = useState(!!seeded?.__spotlight);
  const [notFound, setNotFound] = useState(false);
  const [likeCount, setLikeCount] = useState<number>(seeded?.likes?.[0]?.count ?? 0);
  const [commentCount, setCommentCount] = useState<number>(seeded?.comments?.[0]?.count ?? 0);
  const [isLiked, setIsLiked] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveCount, setSaveCount] = useState<number>(seeded?.save_count ?? 0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null);
  // A slideshow video slide has its audio on → pause the post's attached song.
  const [slideAudioActive, setSlideAudioActive] = useState(false);

  const audioPlaying = currentTrack?.id === id && isPlaying;

  useEffect(() => { setup(); }, [id]);

  // Auto-play the song attached to this image/video post (ambient); stop on
  // blur/close. The media's own audio (video) is muted while a song is set.
  useEffect(() => {
    if (isFocused && post?.id && post?.song_id && !slideAudioActive) playSong(post.id, post.song_id);
    else if (post?.id) stopSong(post.id);
    return () => { if (post?.id) stopSong(post.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.id, post?.song_id, isFocused, slideAudioActive]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) setCurrentUserId(user.id);

    // Global spotlight check — shows the sparkle no matter how this post was opened.
    isPostSpotlighted(id).then((s) => { if (s) setIsSpotlight(true); });

    const [postRes, likesRes] = await Promise.all([
      supabase.from('posts').select('*, profiles!posts_user_id_fkey(username, display_name, avatar_url, badge_tier, badge_show, profile_theme)').eq('id', id).single(),
      supabase.from('likes').select('user_id').eq('post_id', id),
    ]);

    if (postRes.data) { setPost(postRes.data as any); setSaveCount((postRes.data as any).save_count || 0); }
    else if (!postParam) { setNotFound(true); }
    if (likesRes.data) {
      setLikeCount(likesRes.data.length);
      if (user) setIsLiked(likesRes.data.some(l => l.user_id === user.id));
    }

    if (user) {
      const { data: saveData } = await supabase.from('saves').select('id').eq('user_id', user.id).eq('post_id', id).single();
      setIsSaved(!!saveData);
    }
    setLoading(false);
  }

  async function handleLike() {
    if (!currentUserId || !post) return;
    setIsLiked(prev => !prev);
    setLikeCount(prev => isLiked ? prev - 1 : prev + 1);
    if (isLiked) {
      await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', id);
    } else {
      await supabase.from('likes').insert({ user_id: currentUserId, post_id: id });
      bumpBadge('likes');
      if (post.user_id !== currentUserId) {
        createNotification({ userId: post.user_id, actorId: currentUserId, type: 'like', postId: id });
      }
    }
  }

  async function handleSave() {
    if (!currentUserId) return;
    setIsSaved(prev => !prev);
    setSaveCount(prev => isSaved ? Math.max(prev - 1, 0) : prev + 1);
    if (isSaved) {
      await supabase.from('saves').delete().eq('user_id', currentUserId).eq('post_id', id);
    } else {
      await supabase.from('saves').insert({ user_id: currentUserId, post_id: id });
    }
  }

  async function handleComment() {
    if (!newComment.trim() || !currentUserId || sending || !post) return;
    setSending(true);
    const body = newComment.trim();
    setNewComment('');
    const { data, error } = await supabase.from('comments').insert({ user_id: currentUserId, post_id: id, body }).select().single();
    if (!error && data) {
      setComments(prev => [...prev, { ...data, profiles: currentUserProfile }]);
      setCommentCount(prev => prev + 1);
      bumpBadge('comments');
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      if (post.user_id !== currentUserId) {
        createNotification({ userId: post.user_id, actorId: currentUserId, type: 'comment', postId: id });
      }
      processMentions({ text: body, actorId: currentUserId, postId: id as string, commentId: (data as any).id });
    }
    setSending(false);
  }

  async function handleDeleteComment(commentId: string, commentUserId: string) {
    if (commentUserId !== currentUserId) return;
    await supabase.from('comments').delete().eq('id', commentId);
    setComments(prev => prev.filter(c => c.id !== commentId));
    setCommentCount(prev => prev - 1);
  }

  if (notFound && !post) {
    return (
      // onClose (not the default back) so this pager never intercepts
      // beforeRemove — the expand hook already listens for that.
      <SwipeBackPager onClose={popInstant} fastExit>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Ionicons name="chevron-back" size={24} color={colors.primary} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Post</Text>
            <View style={{ width: 40 }} />
          </View>
          <View style={styles.loadingContainer}><Text style={{ color: colors.textSecondary }}>Post not found</Text></View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    <View style={styles.root}>
      {/* Swipe right anywhere to slide the whole post (backdrop included) off and
          reveal the screen underneath — one motion, same feel as the tab pager.
          onClose skips the shrink-to-thumbnail close (the page is already
          off-screen); the back button still uses the shrink via dismiss().
          animateIn off — the grow-from-thumbnail expand IS the entrance. */}
      <SwipeBackPager onClose={popInstant} scrollEnabled={pageSwipeOn} animateIn={false} fastExit>
      <TabSwipeContext.Provider value={setPageSwipeOn}>
      {/* Darkening backdrop — fades as the post grows out of / shrinks into the thumb. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdropOpacity }]} />
      <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={dismiss}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Post</Text>
        <View style={{ width: 40 }} />
      </View>
      {post ? (

      <Comments
        postId={id as string}
        ownerId={post.user_id}
        onRefresh={setup}
        ListHeaderComponent={
          <>
            {/* Author */}
            <TouchableOpacity style={styles.postHeader} onPress={() => router.push(`/profile/${post.user_id}`)}>
              <StoryAvatar
                userId={post.user_id}
                avatarUrl={post.profiles?.avatar_url}
                name={post.profiles?.display_name}
                size={40}
              />
              <View style={styles.postHeaderInfo}>
                <View style={styles.postNameRow}>
                  <Text style={styles.displayName} numberOfLines={1}>{post.profiles?.display_name}</Text>
                  <BadgeEmblem profile={post.profiles} ownerId={post.user_id} size={14} />
                  {isSpotlight && <Ionicons name="sparkles" size={13} color={colors.primaryLight} style={styles.spotSparkle} />}
                </View>
                <Text style={styles.username}>@{post.profiles?.username} · {timeAgo(post.created_at)}</Text>
              </View>
              <FollowButton userId={post.user_id} />
              <TouchableOpacity
                style={styles.typeTag}
                onPress={() => showOptions({
                  postId: id as string,
                  isOwn: currentUserId === post.user_id,
                  authorId: post.user_id,
                  authorName: post.profiles?.username,
                  mediaType: post.type,
                  onEdit: () => router.push(`/edit-post/${id}`),
                  onDeleted: () => router.back(),
                  onArchived: () => router.back(),
                  onBlocked: () => router.back(),
                })}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="ellipsis-horizontal" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            </TouchableOpacity>

            {/* Media */}
            {post.type === 'image' && post.media_url && (
              <View>
                <Image source={{ uri: post.media_url }} style={[styles.media, { aspectRatio: aspectToNumber(post.aspect_ratio, 1), height: undefined, backgroundColor: '#000' }]} resizeMode="cover" />
                {!!post.song_id && (
                  <TouchableOpacity style={styles.songMuteBtn} onPress={toggleSongMuted}>
                    <Ionicons name={songMuted ? 'volume-mute' : 'volume-high'} size={18} color="#fff" />
                  </TouchableOpacity>
                )}
                {!!post.song_id && (
                  <SongAttribution songId={post.song_id} title={post.song_title} artist={post.song_artist} artistId={post.song_artist_id} onNavigate={dismiss} />
                )}
                <TaggedPeopleButton userIds={post.tagged_user_ids} style={styles.tagBtnOverlay} />
              </View>
            )}
            {isSlideshow(post.type) && (
              <View>
                <SlideshowCarousel
                  slides={parseSlides(post)}
                  width={SCREEN_W}
                  aspectRatio={aspectToNumber(post.aspect_ratio, 1)}
                  active={isFocused}
                  postId={id as string}
                  onVideoAudioActiveChange={setSlideAudioActive}
                  initialIndex={initialSlide}
                />
                {!!post.song_id && (
                  <SongAttribution songId={post.song_id} title={post.song_title} artist={post.song_artist} artistId={post.song_artist_id} onNavigate={dismiss} />
                )}
                <TaggedPeopleButton userIds={post.tagged_user_ids} style={styles.tagBtnOverlay} />
              </View>
            )}
            {post.type === 'video' && post.media_url && (
              <View>
              <Video
                ref={videoRef}
                source={{ uri: post.media_url }}
                style={[styles.media, { height: Math.min(SCREEN_W / aspectToNumber(post.aspect_ratio, 16 / 9), MAX_VIDEO_H), backgroundColor: '#000' }]}
                isMuted={!!post.song_id}
                useNativeControls
                usePoster={!!(post.thumbnail_url ?? post.cover_url)}
                posterSource={(post.thumbnail_url ?? post.cover_url) ? { uri: (post.thumbnail_url ?? post.cover_url) as string } : undefined}
                posterStyle={{ resizeMode: 'cover' }}
                resizeMode={ResizeMode.COVER}
                isLooping={post.trim_end == null}
                shouldPlay
                onLoad={() => { if (post.trim_start != null) videoRef.current?.setPositionAsync(post.trim_start * 1000); }}
                onPlaybackStatusUpdate={(st: any) => {
                  if (!st.isLoaded) return;
                  trackVideoProgress(id as string, st.positionMillis ?? 0, st.durationMillis ?? 0);
                  if (post.trim_end != null && st.positionMillis >= post.trim_end * 1000) {
                    videoRef.current?.setPositionAsync((post.trim_start ?? 0) * 1000);
                  }
                }}
              />
              {!!post.song_id && (
                <TouchableOpacity style={styles.songMuteBtn} onPress={toggleSongMuted}>
                  <Ionicons name={songMuted ? 'volume-mute' : 'volume-high'} size={18} color="#fff" />
                </TouchableOpacity>
              )}
              {!!post.song_id && (
                <SongAttribution songId={post.song_id} title={post.song_title} artist={post.song_artist} artistId={post.song_artist_id} onNavigate={dismiss} />
              )}
              <TaggedPeopleButton userIds={post.tagged_user_ids} style={styles.tagBtnOverlay} />
              </View>
            )}
            {isAudioPost(post.type) && (
              <TouchableOpacity
                style={styles.audioWrap}
                onPress={() => audioPlaying ? stop() : play({ id: post.id, uri: post.media_url, caption: post.caption, artist: post.profiles?.display_name, cover: post.cover_url })}
                // Hold the song card for the options sheet — same menu as the ⋯
                onLongPress={() => showOptions({
                  postId: id as string,
                  isOwn: currentUserId === post.user_id,
                  authorId: post.user_id,
                  authorName: post.profiles?.username,
                  mediaType: post.type,
                  onEdit: () => router.push(`/edit-post/${id}`),
                  onDeleted: () => router.back(),
                  onArchived: () => router.back(),
                  onBlocked: () => router.back(),
                })}
              >
                <LinearGradient colors={audioPlaying ? ['#E8401C', '#C03010'] : ['#1C0E06', '#120A04']} style={styles.audioCard}>
                  {post.cover_url ? (
                    <View style={styles.audioCover}>
                      <Image source={{ uri: post.cover_url }} style={styles.audioCoverImg} />
                      <View style={styles.audioCoverOverlay}>
                        {/* Filled-circle glyph, same as Today's Pick — white over artwork */}
                        <Ionicons name={audioPlaying ? 'stop-circle' : 'play-circle'} size={36} color="#fff" />
                      </View>
                    </View>
                  ) : (
                    // No artwork: the bare glyph carries the button on its own
                    // (white when playing — the active card gradient is primary-bright).
                    <Ionicons name={audioPlaying ? 'stop-circle' : 'play-circle'} size={48} color={audioPlaying ? '#fff' : colors.primary} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.audioTitle} numberOfLines={1}>{post.caption || 'Audio Track'}</Text>
                    <Text style={styles.audioArtist}>
                      @{post.profiles?.username} · {(post.stream_count || 0).toLocaleString()} {(post.stream_count === 1) ? 'play' : 'plays'}
                    </Text>
                  </View>
                  <Ionicons name="musical-notes" size={28} color={colors.primary + '44'} />
                </LinearGradient>
              </TouchableOpacity>
            )}

            {/* Caption */}
            {!!post.caption && !isAudioPost(post.type) && (
              <MentionText style={styles.caption} text={post.caption} />
            )}

            {/* Actions */}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.actionBtn} onPress={handleLike} activeOpacity={0.6} hitSlop={8}>
                <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={23} color={isLiked ? colors.like : colors.textSecondary} />
                {likeCount > 0 && <Text style={[styles.actionCount, isLiked && { color: colors.like }]}>{likeCount}</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={handleSave} activeOpacity={0.6} hitSlop={8}>
                <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={22} color={isSaved ? colors.text : colors.textSecondary} />
                {saveCount > 0 && <Text style={[styles.actionCount, isSaved && { color: colors.text }]}>{saveCount}</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionBtn}
                activeOpacity={0.6}
                hitSlop={8}
                onPress={() => openShare({
                  postId: id as string,
                  caption: post.caption,
                  username: post.profiles?.username,
                  type: post.type,
                  mediaUrl: post.media_url,
                  cover: post.cover_url ?? post.thumbnail_url ?? (post.type === 'image' ? post.media_url : null),
                })}
              >
                <Ionicons name="share-social-outline" size={22} color={colors.textSecondary} />
                {(post.share_count || 0) > 0 && <Text style={styles.actionCount}>{post.share_count}</Text>}
              </TouchableOpacity>
            </View>
          </>
        }
      />
      ) : null}
      </KeyboardAvoidingView>
      </Animated.View>
      </TabSwipeContext.Provider>
      </SwipeBackPager>

      {/* Share + 3-dot sheets, hosted here so they appear over this modal route */}
      {sheets}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  listContent: { paddingBottom: SPACING.xxl },
  postHeader: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, gap: SPACING.sm },
  avatar: { width: 40, height: 40, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  // minWidth:0 lets a long name truncate instead of pushing the sparkle/follow button.
  postHeaderInfo: { flex: 1, minWidth: 0 },
  postNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  displayName: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  spotSparkle: { opacity: 0.9, flexShrink: 0 },
  username: { color: colors.textMeta, fontSize: 12, marginTop: 1 },
  typeTag: { width: 28, height: 28, borderRadius: RADIUS.full, backgroundColor: colors.primary + '18', alignItems: 'center', justifyContent: 'center' },
  media: { width: '100%', height: 340, backgroundColor: colors.surfaceLight },
  tagBtnOverlay: { position: 'absolute', left: SPACING.sm, bottom: SPACING.sm },
  songMuteBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  audioWrap: { marginHorizontal: SPACING.md, marginVertical: SPACING.sm, borderRadius: RADIUS.md, overflow: 'hidden' },
  audioCard: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, gap: SPACING.md, borderRadius: RADIUS.md },
  audioCover: { width: 52, height: 52, borderRadius: RADIUS.sm, overflow: 'hidden' },
  audioCoverImg: { width: 52, height: 52 },
  audioCoverOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  audioTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  audioArtist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  caption: { color: colors.text, fontSize: 15, lineHeight: 22, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  actions: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.lg },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionCount: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  divider: { height: 0.5, backgroundColor: colors.border, marginHorizontal: SPACING.md, marginTop: SPACING.sm },
  commentsLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyComments: { color: colors.textTertiary, fontSize: 14, textAlign: 'center', paddingVertical: SPACING.xl },
  commentRow: { flexDirection: 'row', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  commentAvatar: { width: 32, height: 32, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  commentAvatarText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  commentContent: { flex: 1, backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, padding: SPACING.sm, borderWidth: 1, borderColor: colors.border },
  commentHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  commentName: { color: colors.text, fontSize: 13, fontWeight: '700' },
  commentTime: { color: colors.textTertiary, fontSize: 11 },
  commentBody: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: SPACING.md, borderTopWidth: 0.5, borderTopColor: colors.border, gap: SPACING.sm },
  inputAvatar: { width: 30, height: 30, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  inputAvatarText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  input: { flex: 1, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, color: colors.text, fontSize: 15, maxHeight: 100 },
  sendBtn: { width: 36, height: 36, borderRadius: RADIUS.full, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.35 },
});
