import {
  View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, PanResponder, Easing,
  FlatList, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAudio } from '../contexts/AudioContext';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { formatCount } from '../lib/format';
import { timeAgo } from '../lib/timeAgo';
import { createNotification } from '../lib/createNotification';
import Scrubber from './Scrubber';

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const ART = Math.min(SCREEN_W - SPACING.xl * 2, 300);

type Comment = { id: string; body: string; created_at: string; user_id: string; profiles: any };

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
  const { isPlaying, isBuffering, pause, resume } = useAudio();
  return (
    <View style={styles.controls}>
      <TouchableOpacity style={styles.playBtn} onPress={() => (isPlaying ? pause() : resume())}>
        <Ionicons name={isBuffering ? 'hourglass' : isPlaying ? 'pause' : 'play'} size={32} color={COLORS.text} />
      </TouchableOpacity>
    </View>
  );
}

export default function NowPlaying() {
  const { currentTrack, expanded, collapse } = useAudio();
  const router = useRouter();
  const [render, setRender] = useState(false);
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const closeVel = useRef(0);
  const listRef = useRef<FlatList>(null);

  // Social state for the current track.
  const [userId, setUserId] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | undefined>();
  const [streams, setStreams] = useState(0);
  const [saves, setSaves] = useState(0);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [sending, setSending] = useState(false);

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
      if (user) {
        supabase.from('profiles').select('username, display_name').eq('id', user.id).single()
          .then(({ data }) => { if (!cancelled) setUserProfile(data); });
      }
      const [postRes, likesRes, commentsRes] = await Promise.all([
        supabase.from('posts').select('stream_count, save_count, user_id, profiles!posts_user_id_fkey(username, display_name)').eq('id', pid).single(),
        supabase.from('likes').select('user_id').eq('post_id', pid),
        supabase.from('comments').select('*, profiles!comments_user_id_fkey(username, display_name)').eq('post_id', pid).order('created_at', { ascending: true }),
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
      if (commentsRes.data) setComments(commentsRes.data as any);
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

  async function handleComment() {
    if (!newComment.trim() || !userId || sending) return;
    setSending(true);
    const body = newComment.trim();
    setNewComment('');
    const { data, error } = await supabase.from('comments').insert({ user_id: userId, post_id: pid, body }).select().single();
    if (!error && data) {
      setComments(prev => [...prev, { ...(data as any), profiles: userProfile }]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
      if (ownerId && ownerId !== userId) createNotification({ userId: ownerId, actorId: userId, type: 'comment', postId: pid });
    }
    setSending(false);
  }

  async function handleDeleteComment(commentId: string, commentUserId: string) {
    if (commentUserId !== userId) return;
    await supabase.from('comments').delete().eq('id', commentId);
    setComments(prev => prev.filter(c => c.id !== commentId));
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
            <View style={{ width: 40 }} />
          </View>
        </View>

        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8}>
          <FlatList
            ref={listRef}
            data={comments}
            keyExtractor={c => c.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scroll}
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

                {/* Actions: like + comment count + stats */}
                <View style={styles.actions}>
                  <TouchableOpacity style={styles.actionBtn} onPress={handleLike}>
                    <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={24} color={isLiked ? COLORS.like : COLORS.textSecondary} />
                    {likeCount > 0 && <Text style={[styles.actionCount, isLiked && { color: COLORS.like }]}>{likeCount}</Text>}
                  </TouchableOpacity>
                  <View style={styles.actionBtn}>
                    <Ionicons name="chatbubble-outline" size={22} color={COLORS.textSecondary} />
                    {comments.length > 0 && <Text style={styles.actionCount}>{comments.length}</Text>}
                  </View>
                  <View style={[styles.actionBtn, { marginLeft: 'auto' }]}>
                    <Ionicons name="play" size={16} color={COLORS.primary} />
                    <Text style={styles.statText}>{formatCount(streams)}</Text>
                  </View>
                  <View style={styles.actionBtn}>
                    <Ionicons name="bookmark" size={16} color={COLORS.primary} />
                    <Text style={styles.statText}>{formatCount(saves)}</Text>
                  </View>
                </View>

                <View style={styles.divider} />
                <Text style={styles.commentsLabel}>Comments · {comments.length}</Text>
              </>
            }
            ListEmptyComponent={<Text style={styles.emptyComments}>No comments yet — be the first!</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.commentRow} onLongPress={() => handleDeleteComment(item.id, item.user_id)}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.commentAvatar}>
                  <Text style={styles.commentAvatarText}>{item.profiles?.display_name?.charAt(0).toUpperCase()}</Text>
                </LinearGradient>
                <View style={styles.commentContent}>
                  <View style={styles.commentHead}>
                    <Text style={styles.commentName}>{item.profiles?.display_name}</Text>
                    <Text style={styles.commentTime}>{timeAgo(item.created_at)}</Text>
                  </View>
                  <Text style={styles.commentBody}>{item.body}</Text>
                </View>
              </TouchableOpacity>
            )}
          />

          <View style={styles.inputBar}>
            <TextInput
              style={styles.input}
              placeholder="Add a comment..."
              placeholderTextColor={COLORS.textTertiary}
              value={newComment}
              onChangeText={setNewComment}
              multiline
              maxLength={300}
            />
            <TouchableOpacity
              style={[styles.sendBtn, !newComment.trim() && styles.sendBtnDisabled]}
              onPress={handleComment}
              disabled={!newComment.trim() || sending}
            >
              {sending ? <ActivityIndicator color={COLORS.text} size="small" /> : <Ionicons name="arrow-up" size={18} color={COLORS.text} />}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  layer: { zIndex: 200 },
  container: { flex: 1, paddingHorizontal: SPACING.xl },
  handle: {
    width: 40, height: 5, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.3)', alignSelf: 'center', marginTop: SPACING.lg + SPACING.sm,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: SPACING.md, marginBottom: SPACING.sm,
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

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: SPACING.md },
  playBtn: { width: 72, height: 72, borderRadius: 36, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },

  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.lg, marginTop: SPACING.lg },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionCount: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  statText: { color: COLORS.textSecondary, fontSize: 13 },

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
