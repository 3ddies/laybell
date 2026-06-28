import AppVideo from '../../components/AppVideo';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, Image, ActivityIndicator, Animated,
} from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge } from '../../lib/badges';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { createNotification } from '../../lib/createNotification';
import { usePostActionSheets } from '../../hooks/usePostActionSheets';
import { formatCount } from '../../lib/format';
import { aspectToNumber } from '../../lib/aspectRatio';
import CommentsSheet from '../../components/CommentsSheet';
import ElasticSwipeView from '../../components/ElasticSwipeView';
import FollowButton from '../../components/FollowButton';
import MentionText from '../../components/MentionText';
import TranslatableText from '../../components/TranslatableText';
import CommunityTag from '../../components/CommunityTag';
import StoryAvatar from '../../components/StoryAvatar';
import BadgeEmblem from '../../components/BadgeEmblem';
import { trackVideoProgress } from '../../lib/viewTracker';
import { timeAgo } from '../../lib/timeAgo';
import SongAttribution from '../../components/SongAttribution';
import { useAudio } from '../../contexts/AudioContext';
import { usePostMusic } from '../../contexts/PostMusicContext';
import { useIsFocused } from '@react-navigation/native';
import { useExpandTransition } from '../../hooks/useExpandTransition';
import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost, EMPTY_PROFILE,
} from '../../lib/feedScorer';
import {
  fetchReelAds, weaveReelAds, recordAdImpression, recordAdClick, recordAdSkip, type AdViewer,
} from '../../lib/ads';
import { openAdOptions } from '../../contexts/AdOptionsContext';
import ReelAd from '../../components/ReelAd';
import { useProfile } from '../../contexts/ProfileContext';
import { fetchSpotlightedPostIds } from '../../lib/spotlight';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export default function ReelScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const linkGuard = useLinkGuard();
  // Hosted locally (not via the root context) so the sheets present over this
  // transparentModal route on iOS — see usePostActionSheets.
  const { share: openShare, showOptions, sheets } = usePostActionSheets();
  const { id, post: postParam } = useLocalSearchParams<{ id: string; post?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { stop } = useAudio();
  const { playSong, stop: stopSong, muted: songMuted, toggleMuted: toggleSongMuted } = usePostMusic();
  const isFocused = useIsFocused();
  const { dismiss, backdropOpacity, contentStyle } = useExpandTransition();

  // Seed from the tapped video so it plays instantly (no loading spinner).
  const seed = useMemo(() => {
    try { return postParam ? JSON.parse(postParam) : null; } catch { return null; }
  }, [postParam]);

  const [posts, setPosts] = useState<any[]>(seed ? [seed] : []);
  const [loading, setLoading] = useState(!seed);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [liked, setLiked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [visibleId, setVisibleId] = useState<string | null>(seed?.id ?? null);
  // Post ids with a LIVE spotlight → the subtle sparkle by the username, no matter
  // how the reel was opened (the served __spotlight meta only rides the feed tap).
  const [spotlightIds, setSpotlightIds] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [commentsFor, setCommentsFor] = useState<{ id: string; ownerId: string } | null>(null);
  const listRef = useRef<FlatList>(null);
  // Read by the frozen onViewableItemsChanged callback (which can't see state).
  const currentUserIdRef = useRef<string | null>(null);
  const { profile: myProfile } = useProfile();
  const myProfileRef = useRef(myProfile);
  myProfileRef.current = myProfile;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    const it = viewableItems[0]?.item;
    if (it) {
      setVisibleId(it.id);
      setPaused(false);
      if (it.__ad) recordAdImpression(it, 'reels', currentUserIdRef.current);
    }
  }).current;

  useEffect(() => { stop(); setup(); }, [id]);

  // Auto-play the focused reel's attached song (the video itself is muted when a
  // song is set); stop on swipe-away / blur / unmount.
  const visibleItem = posts.find((p) => p.id === visibleId);
  useEffect(() => {
    if (isFocused && visibleId && visibleItem?.song_id) playSong(visibleId, visibleItem.song_id);
    else if (visibleId) stopSong(visibleId);
    return () => { if (visibleId) stopSong(visibleId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleId, visibleItem?.song_id, isFocused]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;
    setCurrentUserId(uid);
    currentUserIdRef.current = uid;

    const [seen, profile, followingRes] = await Promise.all([
      loadSeenPostIds(),
      uid ? buildAffinityProfile(uid) : Promise.resolve(EMPTY_PROFILE),
      uid ? supabase.from('follows').select('following_id').eq('follower_id', uid) : Promise.resolve({ data: [] as any }),
    ]);
    const followingSet = new Set<string>((followingRes.data ?? []).map((f: any) => f.following_id));

    const SELECT = '*, profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme), likes(count), comments(count)';
    const { data } = await supabase
      .from('posts').select(SELECT)
      .eq('is_public', true).eq('type', 'video')
      .order('created_at', { ascending: false }).limit(40);

    const now = Date.now();
    let list = [...(data ?? [])]
      .map((p) => ({ p, s: scorePost(p, profile, followingSet, seen, now) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p);

    // Put the tapped video first; fetch it if it wasn't in the recommended set.
    const idx = list.findIndex((p) => p.id === id);
    let start: any = null;
    if (idx >= 0) { start = list[idx]; list.splice(idx, 1); }
    else {
      const { data: one } = await supabase.from('posts').select(SELECT).eq('id', id).single();
      start = one;
    }
    const ordered = start ? [start, ...list] : list;
    // Preserve the served spotlight flag on the tapped reel — the refetched DB
    // rows don't carry the __spotlight meta the feed attached, so re-tag it so
    // the subtle sparkle emblem stays by the username.
    setPosts(
      seed?.__spotlight
        ? ordered.map((p) => (p.id === seed.id ? { ...p, __spotlight: seed.__spotlight } : p))
        : ordered,
    );
    setVisibleId(ordered[0]?.id ?? null);
    // Flag which loaded reels are spotlighted right now (one batched query), so
    // the sparkle shows globally — not just on a feed-tapped reel.
    fetchSpotlightedPostIds(ordered.map((p) => p.id)).then(setSpotlightIds);

    if (uid) {
      const [{ data: l }, { data: s }] = await Promise.all([
        supabase.from('likes').select('post_id').eq('user_id', uid),
        supabase.from('saves').select('post_id').eq('user_id', uid),
      ]);
      setLiked(new Set((l ?? []).map((r: any) => r.post_id)));
      setSaved(new Set((s ?? []).map((r: any) => r.post_id)));
    }
    recordSeenPostIds(ordered.map((p) => p.id));
    setLoading(false);

    // Weave reel ads in WITHOUT blocking the first render: ads land at output
    // indices 2, 7, 12 … (the 3rd reel, then every 5th). The tapped video is
    // index 0, so weaving never disturbs what's currently on screen.
    const adViewer: AdViewer = {
      id: uid,
      profile: myProfileRef.current ? {
        age: (myProfileRef.current as any).age,
        gender: (myProfileRef.current as any).gender,
        latitude: (myProfileRef.current as any).latitude,
        longitude: (myProfileRef.current as any).longitude,
      } : null,
      affinity: profile,
    };
    fetchReelAds(adViewer)
      .then((pool) => { if (pool.length) setPosts(weaveReelAds(ordered, pool)); })
      .catch(() => {});
  }

  async function toggleLike(item: any) {
    if (!currentUserId) return;
    const isLiked = liked.has(item.id);
    setLiked((prev) => { const n = new Set(prev); isLiked ? n.delete(item.id) : n.add(item.id); return n; });
    setPosts((prev) => prev.map((p) => p.id !== item.id ? p
      : { ...p, likes: [{ count: (p.likes?.[0]?.count || 0) + (isLiked ? -1 : 1) }] }));
    if (isLiked) {
      await supabase.from('likes').delete().eq('user_id', currentUserId).eq('post_id', item.id);
    } else {
      await supabase.from('likes').insert({ user_id: currentUserId, post_id: item.id });
      bumpBadge('likes');
      if (item.user_id !== currentUserId) createNotification({ userId: item.user_id, actorId: currentUserId, type: 'like', postId: item.id });
    }
  }

  async function toggleSave(item: any) {
    if (!currentUserId) return;
    const isSaved = saved.has(item.id);
    setSaved((prev) => { const n = new Set(prev); isSaved ? n.delete(item.id) : n.add(item.id); return n; });
    if (isSaved) await supabase.from('saves').delete().eq('user_id', currentUserId).eq('post_id', item.id);
    else await supabase.from('saves').insert({ user_id: currentUserId, post_id: item.id });
  }

  function share(item: any) {
    openShare({
      postId: item.id,
      caption: item.caption,
      username: item.profiles?.username,
      type: item.type ?? 'video',
      mediaUrl: item.media_url,
      cover: item.thumbnail_url ?? item.cover_url ?? null,
    });
  }

  function renderItem({ item, index }: { item: any; index: number }) {
    if (item.__ad) {
      return (
        <ReelAd
          item={item}
          visible={visibleId === item.id}
          paused={paused}
          insets={insets}
          onSkip={() => {
            recordAdSkip(item, 'reels', currentUserId);
            listRef.current?.scrollToIndex({ index: index + 1, animated: true });
          }}
          onCta={() => {
            const url = item.__ad?.ctaUrl;
            if (!url) return;
            linkGuard.open(url, {
              context: 'ad',
              sourceName: item.__ad?.advertiserName,
              onProceed: () => recordAdClick(item, 'reels', currentUserId),
            });
          }}
          onOptions={() => {
            const ad = item.__ad;
            openAdOptions({ campaignId: ad.campaignId, creativeId: ad.creativeId, advertiserName: ad.advertiserName });
          }}
        />
      );
    }
    const isLiked = liked.has(item.id);
    const isSaved = saved.has(item.id);
    const likeCount = item.likes?.[0]?.count || 0;
    const commentCount = item.comments?.[0]?.count || 0;
    const saveCount = item.save_count || 0;
    const shareCount = item.share_count || 0;
    // Landscape/square videos show in full (letterboxed) so nothing is cut;
    // portrait videos fill the screen edge-to-edge.
    const landscape = aspectToNumber(item.aspect_ratio, 16 / 9) >= 1;
    // Cached thumbnail shown while the video buffers — keeps the expand from
    // revealing a black screen before the first frame is ready.
    const poster = item.thumbnail_url ?? item.cover_url ?? null;

    return (
      <ElasticSwipeView style={{ width: SCREEN_W, height: SCREEN_H }}>
        <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={() => setPaused((p) => !p)}>
          <AppVideo
            source={{ uri: item.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit={landscape ? 'contain' : 'cover'}
            loop={item.trim_end == null}
            active={visibleId === item.id && !paused}
            muted={!!item.song_id}
            poster={poster}
            posterContentFit={landscape ? 'contain' : 'cover'}
            trimStartSec={item.trim_start}
            trimEndSec={item.trim_end}
            onProgress={(pos, dur) => trackVideoProgress(item.id, pos, dur)}
          />
        </TouchableOpacity>

        {/* paused indicator */}
        {visibleId === item.id && paused && (
          <View style={styles.pausedWrap} pointerEvents="none">
            <Ionicons name="play" size={64} color="rgba(255,255,255,0.85)" />
          </View>
        )}

        {/* bottom gradient for legibility */}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.bottomFade} pointerEvents="none" />

        {/* Right action rail */}
        <View style={[styles.rail, { bottom: insets.bottom + 90 }]}>
          <TouchableOpacity style={styles.railBtn} onPress={() => toggleLike(item)}>
            <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={32} color={isLiked ? colors.like : '#fff'} />
            {likeCount > 0 && <Text style={styles.railText}>{formatCount(likeCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => setCommentsFor({ id: item.id, ownerId: item.user_id })}>
            <Ionicons name="chatbubble-outline" size={30} color="#fff" />
            {commentCount > 0 && <Text style={styles.railText}>{formatCount(commentCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => toggleSave(item)}>
            <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={28} color="#fff" />
            {saveCount > 0 && <Text style={styles.railText}>{formatCount(saveCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => share(item)}>
            <Ionicons name="share-social-outline" size={28} color="#fff" />
            {shareCount > 0 && <Text style={styles.railText}>{formatCount(shareCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={() => showOptions({
              postId: item.id,
              isOwn: item.user_id === currentUserId,
              authorId: item.user_id,
              authorName: item.profiles?.username,
              mediaType: item.type ?? 'video',
              onEdit: () => router.push(`/edit-post/${item.id}`),
              onDeleted: () => setPosts((prev) => prev.filter((p) => p.id !== item.id)),
              onArchived: () => setPosts((prev) => prev.filter((p) => p.id !== item.id)),
              onBlocked: () => setPosts((prev) => prev.filter((p) => p.user_id !== item.user_id)),
            })}
          >
            <Ionicons name="ellipsis-horizontal" size={28} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Author + caption */}
        <View style={[styles.meta, { bottom: insets.bottom + 24 }]}>
          <View style={styles.authorRow}>
            <TouchableOpacity style={styles.author} onPress={() => router.push(`/profile/${item.user_id}`)}>
              <StoryAvatar
                userId={item.user_id}
                avatarUrl={item.profiles?.avatar_url}
                name={item.profiles?.display_name}
                size={32}
                onPressProfile={() => router.push(`/profile/${item.user_id}`)}
              />
              <Text style={styles.authorName} numberOfLines={1}>@{item.profiles?.username}</Text>
              <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={12} />
              {(!!item.__spotlight || spotlightIds.has(item.id)) && <Ionicons name="sparkles" size={12} color={colors.primaryLight} style={styles.spotSparkle} />}
              <Text style={styles.dot}>·</Text>
              <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
            </TouchableOpacity>
            <FollowButton userId={item.user_id} />
          </View>
          {/* Caption + community hashtag on the same line (wraps below only when
              the caption wraps). Taps through to that community. */}
          {!!item.caption && (
            <TranslatableText
              text={item.caption}
              render={(s) => (
                <View style={styles.captionRow}>
                  <MentionText style={styles.caption} numberOfLines={2} text={s} />
                  {(item.community_tags ?? []).map((ct: { id: string; hashtag: string }) => (
                    <CommunityTag key={ct.id} communityId={ct.id} hashtag={ct.hashtag} />
                  ))}
                </View>
              )}
            />
          )}
          {!!item.song_id && (
            <SongAttribution
              inline
              style={{ marginTop: SPACING.xs }}
              songId={item.song_id}
              title={item.song_title}
              artist={item.song_artist}
              artistId={item.song_artist_id}
              onNavigate={dismiss}
            />
          )}
        </View>
      </ElasticSwipeView>
    );
  }

  return (
    <View style={styles.root}>
      {/* Darkening backdrop — fades as the reel grows out of / shrinks into the thumb. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdropOpacity }]} />
      <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>
        <View style={styles.container}>
          {posts.length > 0 ? (
            <FlatList
              ref={listRef}
              data={posts}
              keyExtractor={(p) => p.id}
              pagingEnabled
              showsVerticalScrollIndicator={false}
              snapToInterval={SCREEN_H}
              snapToAlignment="start"
              decelerationRate="fast"
              getItemLayout={(_, i) => ({ length: SCREEN_H, offset: SCREEN_H * i, index: i })}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={viewabilityConfig}
              renderItem={renderItem}
              windowSize={3}
              maxToRenderPerBatch={2}
              initialNumToRender={1}
            />
          ) : loading ? (
            <View style={styles.center} />
          ) : (
            <View style={styles.center}><Text style={styles.empty}>{t('reel.noVideos')}</Text></View>
          )}

          {/* Back button */}
          <TouchableOpacity style={[styles.back, { top: insets.top + 8 }]} onPress={dismiss}>
            <Ionicons name="chevron-back" size={28} color="#fff" />
          </TouchableOpacity>

          {/* Sound toggle for the attached song (when the focused reel has one) */}
          {!!visibleItem?.song_id && (
            <TouchableOpacity style={[styles.muteBtn, { top: insets.top + 8 }]} onPress={toggleSongMuted}>
              <Ionicons name={songMuted ? 'volume-mute' : 'volume-high'} size={22} color="#fff" />
            </TouchableOpacity>
          )}

          <CommentsSheet
            visible={!!commentsFor}
            postId={commentsFor?.id ?? ''}
            ownerId={commentsFor?.ownerId}
            onClose={() => setCommentsFor(null)}
          />

          {/* Share + 3-dot sheets, hosted here so they appear over this modal route */}
          {sheets}
        </View>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  root: { flex: 1 },
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: colors.textSecondary, fontSize: 15 },

  back: { position: 'absolute', left: SPACING.sm, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  muteBtn: {
    position: 'absolute', right: SPACING.sm, width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)',
  },

  pausedWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 220 },

  rail: { position: 'absolute', right: SPACING.sm, alignItems: 'center', gap: SPACING.lg },
  railBtn: { alignItems: 'center', gap: 3 },
  railText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  meta: { position: 'absolute', left: SPACING.md, right: 80, gap: SPACING.xs },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  author: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  authorName: { flexShrink: 1, color: '#fff', fontSize: 15, fontWeight: '700' },
  spotSparkle: { opacity: 0.9, flexShrink: 0 },
  dot: { color: 'rgba(255,255,255,0.7)', fontSize: 14 },
  time: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  captionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  caption: { color: '#fff', fontSize: 14, lineHeight: 19, flexShrink: 1 },
});
