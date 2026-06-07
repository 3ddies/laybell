import {
  View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, PanResponder, Easing,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAudio } from '../contexts/AudioContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { formatCount } from '../lib/format';
import { createNotification } from '../lib/createNotification';
import Scrubber from './Scrubber';
import Comments from './Comments';

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const ART = Math.min(SCREEN_W - SPACING.xl * 2, 300);

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function Progress() {
  const { positionMs, durationMs, seekTo } = useAudio();
  const progress = durationMs > 0 ? positionMs / durationMs : 0;
  return (
    <View style={styles.progressBlock}>
      <Scrubber
        progress={progress}
        onSeek={r => durationMs > 0 && seekTo(Math.floor(r * durationMs))}
        height={24} trackHeight={5} thumbSize={16}
      />
      <View style={styles.times}>
        <Text style={styles.timeText}>{formatMs(positionMs)}</Text>
        <Text style={styles.timeText}>{durationMs > 0 ? formatMs(durationMs) : '--:--'}</Text>
      </View>
    </View>
  );
}

function Controls() {
  const { isPlaying, isBuffering, pause, resume, next, previous, queueIndex, queueLength } = useAudio();
  const hasQueue = queueLength > 1;
  const canPrev = queueIndex > 0;
  const canNext = queueIndex < queueLength - 1;
  return (
    <View style={styles.controls}>
      {hasQueue && (
        <TouchableOpacity style={styles.navBtn} onPress={previous} disabled={!canPrev}>
          <Ionicons name="play-skip-back" size={26} color={canPrev ? COLORS.text : COLORS.textTertiary} />
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.playBtn} onPress={() => (isPlaying ? pause() : resume())}>
        <Ionicons name={isBuffering ? 'hourglass' : isPlaying ? 'pause' : 'play'} size={32} color={COLORS.text} />
      </TouchableOpacity>
      {hasQueue && (
        <TouchableOpacity style={styles.navBtn} onPress={next} disabled={!canNext}>
          <Ionicons name="play-skip-forward" size={26} color={canNext ? COLORS.text : COLORS.textTertiary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function NowPlaying() {
  const { currentTrack, expanded, collapse } = useAudio();
  const { show: showOptions } = usePostOptions();
  const router = useRouter();
  const [render, setRender] = useState(false);
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const closeVel = useRef(0);

  // Post like/save/stats state for the current track. (Comments handled by <Comments/>.)
  const [userId, setUserId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | undefined>();
  const [streams, setStreams] = useState(0);
  const [saves, setSaves] = useState(0);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    if (expanded) {
      setRender(true);
      Animated.timing(translateY, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else if (render) {
      Animated.spring(translateY, { toValue: SCREEN_H, velocity: closeVel.current, bounciness: 0, speed: 12, useNativeDriver: true })
        .start(() => setRender(false));
      closeVel.current = 0;
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded && render) {
      const t = setTimeout(() => setRender(false), 600);
      return () => clearTimeout(t);
    }
  }, [expanded, render]);

  // Load post stats + like state + comments for the current track (when open).
  useEffect(() => {
    const pid = currentTrack?.id;
    if (!pid || !expanded) return;
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      setUserId(user?.id ?? null);
      const [postRes, likesRes, saveRes] = await Promise.all([
        supabase.from('posts').select('stream_count, save_count, user_id, profiles!posts_user_id_fkey(username, display_name)').eq('id', pid).single(),
        supabase.from('likes').select('user_id').eq('post_id', pid),
        user ? supabase.from('saves').select('id').eq('user_id', user.id).eq('post_id', pid).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      if (cancelled) return;
      if (postRes.data) {
        const d: any = postRes.data;
        setStreams(d.stream_count || 0);
        setSaves(d.save_count || 0);
        setOwnerId(d.user_id);
        setOwnerName(d.profiles?.username);
      }
      if (likesRes.data) {
        setLikeCount(likesRes.data.length);
        setIsLiked(!!user && likesRes.data.some((l: any) => l.user_id === user.id));
      }
      setIsSaved(!!saveRes.data);
    })();
    return () => { cancelled = true; };
  }, [currentTrack?.id, expanded]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.vy > 0.4 && g.dy > 70) { closeVel.current = g.vy * 1000; collapse(); }
        else Animated.spring(translateY, { toValue: 0, speed: 14, bounciness: 4, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(translateY, { toValue: 0, speed: 14, bounciness: 4, useNativeDriver: true }).start(),
    })
  ).current;

  if (!render || !currentTrack) return null;
  const pid = currentTrack.id;

  const goProfile = () => { if (ownerId) { collapse(); router.push(`/profile/${ownerId}`); } };

  async function handleLike() {
    if (!userId) return;
    const liked = isLiked;
    setIsLiked(!liked);
    setLikeCount(c => (liked ? c - 1 : c + 1));
    if (liked) {
      await supabase.from('likes').delete().eq('user_id', userId).eq('post_id', pid);
    } else {
      await supabase.from('likes').insert({ user_id: userId, post_id: pid });
      if (ownerId && ownerId !== userId) createNotification({ userId: ownerId, actorId: userId, type: 'like', postId: pid });
    }
  }

  async function handleSave() {
    if (!userId) return;
    const saved = isSaved;
    setIsSaved(!saved);
    setSaves(c => (saved ? Math.max(c - 1, 0) : c + 1));
    if (saved) {
      await supabase.from('saves').delete().eq('user_id', userId).eq('post_id', pid);
    } else {
      await supabase.from('saves').insert({ user_id: userId, post_id: pid });
    }
  }

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.layer, { transform: [{ translateY }] }]}>
      <LinearGradient colors={['#2A1206', '#150A04', COLORS.background]} style={styles.container}>
        {/* Top drag zone — swipe down to close */}
        <View {...pan.panHandlers}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBtn} onPress={collapse}>
              <Ionicons name="chevron-down" size={26} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Now Playing</Text>
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={() => showOptions({
                postId: pid,
                isOwn: ownerId === userId,
                onEdit: () => { collapse(); router.push(`/edit-post/${pid}`); },
                onDeleted: () => collapse(),
              })}
            >
              <Ionicons name="ellipsis-horizontal" size={22} color={COLORS.text} />
            </TouchableOpacity>
          </View>
        </View>

        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
          <Comments
            postId={pid}
            ownerId={ownerId}
            contentPadding={SPACING.xl}
            onNavigate={collapse}
            ListHeaderComponent={
              <>
                <View style={styles.artWrap}>
                  {currentTrack.cover ? (
                    <Image source={{ uri: currentTrack.cover }} style={styles.art} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primary} style={styles.art}>
                      <Ionicons name="musical-notes" size={64} color={COLORS.text} />
                    </LinearGradient>
                  )}
                </View>

                <View style={styles.meta}>
                  <Text style={styles.title} numberOfLines={1}>{currentTrack.caption || 'Audio Track'}</Text>
                  <TouchableOpacity disabled={!ownerId} onPress={goProfile}>
                    <Text style={styles.artist} numberOfLines={1}>
                      {currentTrack.artist || (ownerName ? `@${ownerName}` : '')}
                    </Text>
                  </TouchableOpacity>
                </View>

                <Progress />
                <Controls />

                {/* Like (tap) · Streams (display) · Saves (tap) */}
                <View style={styles.statBar}>
                  <TouchableOpacity style={[styles.tapStat, isLiked && styles.tapStatActiveLike]} onPress={handleLike} activeOpacity={0.8}>
                    <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={26} color={isLiked ? COLORS.like : COLORS.text} />
                    <Text style={styles.tapStatNum}>{formatCount(likeCount)}</Text>
                  </TouchableOpacity>
                  <View style={styles.centerStat}>
                    <Text style={styles.centerStatNum}>{formatCount(streams)}</Text>
                    <Text style={styles.centerStatLbl}>streams</Text>
                  </View>
                  <TouchableOpacity style={[styles.tapStat, isSaved && styles.tapStatActiveSave]} onPress={handleSave} activeOpacity={0.8}>
                    <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={26} color={isSaved ? COLORS.primary : COLORS.text} />
                    <Text style={styles.tapStatNum}>{formatCount(saves)}</Text>
                  </TouchableOpacity>
                </View>
              </>
            }
          />
        </KeyboardAvoidingView>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  layer: { zIndex: 200 },
  container: { flex: 1 },
  handle: {
    width: 40, height: 5, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.3)', alignSelf: 'center', marginTop: SPACING.lg + SPACING.sm,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: SPACING.md, marginBottom: SPACING.sm, paddingHorizontal: SPACING.xl,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },

  scroll: { paddingBottom: SPACING.lg },
  artWrap: { alignItems: 'center', marginTop: SPACING.md },
  art: { width: ART, height: ART, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight },

  meta: { marginTop: SPACING.lg, alignItems: 'center', gap: SPACING.xs },
  title: { color: COLORS.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  artist: { color: COLORS.textSecondary, fontSize: 15 },

  progressBlock: { marginTop: SPACING.lg },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACING.xs },
  timeText: { color: COLORS.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'] },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xl, marginTop: SPACING.md },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  playBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },

  statBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACING.lg },
  tapStat: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm + 2,
    borderRadius: RADIUS.full, backgroundColor: COLORS.surfaceElevated,
    borderWidth: 1, borderColor: COLORS.border,
  },
  tapStatActiveLike: { borderColor: COLORS.like, backgroundColor: COLORS.like + '1A' },
  tapStatActiveSave: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '1A' },
  tapStatNum: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  centerStat: { flex: 1, alignItems: 'center' },
  centerStatNum: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  centerStatLbl: { color: COLORS.textSecondary, fontSize: 11, marginTop: 1 },

  divider: { height: 0.5, backgroundColor: COLORS.border, marginTop: SPACING.lg },
  commentsLabel: { color: COLORS.text, fontSize: 14, fontWeight: '700', marginTop: SPACING.md, marginBottom: SPACING.xs },
  emptyComments: { color: COLORS.textTertiary, fontSize: 13, paddingVertical: SPACING.md },

  commentRow: { flexDirection: 'row', gap: SPACING.sm, paddingVertical: SPACING.sm },
  commentAvatar: { width: 34, height: 34, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  commentAvatarText: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  commentContent: { flex: 1 },
  commentHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  commentName: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  commentTime: { color: COLORS.textTertiary, fontSize: 11 },
  commentBody: { color: COLORS.textSecondary, fontSize: 14, marginTop: 2, lineHeight: 19 },

  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm,
    paddingVertical: SPACING.sm, paddingBottom: SPACING.md,
    borderTopWidth: 0.5, borderTopColor: COLORS.border,
  },
  input: {
    flex: 1, backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    color: COLORS.text, fontSize: 14, maxHeight: 90,
  },
  sendBtn: { width: 38, height: 38, borderRadius: RADIUS.full, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
});
