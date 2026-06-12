import {
  View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, PanResponder, Easing,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAudio } from '../contexts/AudioContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { supabase } from '../lib/supabase';
import { bumpBadge } from '../lib/badges';
import BadgeEmblem from './BadgeEmblem';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { formatCount } from '../lib/format';
import { createNotification } from '../lib/createNotification';
import Scrubber from './Scrubber';
import Comments from './Comments';

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
// Full-width art (capped at 300): at rest the header fills the screen down to
// the "Comments" label — the label peeks above the input bar as a teaser, and
// the comments themselves intentionally live below the fold (scroll to read).
const ART = Math.min(SCREEN_W - SPACING.xl * 2, 300);

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function Progress() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
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
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { isPlaying, isBuffering, pause, resume, next, previous, queueIndex, queueLength } = useAudio();
  const hasQueue = queueLength > 1;
  const canPrev = queueIndex > 0;
  const canNext = queueIndex < queueLength - 1;
  return (
    <View style={styles.controls}>
      {hasQueue && (
        <TouchableOpacity style={styles.navBtn} onPress={previous} disabled={!canPrev}>
          <Ionicons name="play-skip-back" size={28} color={canPrev ? colors.text : colors.textTertiary} />
        </TouchableOpacity>
      )}
      {/* Hero control: solid primary circle with a flex-centered glyph (a bare
          play-circle glyph at this size sits visibly low/off-axis because of
          the icon font's metrics — drawing the circle ourselves centers it
          exactly, Spotify-style). */}
      <TouchableOpacity style={styles.playBtn} onPress={() => (isPlaying ? pause() : resume())} activeOpacity={0.85}>
        {isBuffering ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Ionicons name={isPlaying ? 'pause' : 'play'} size={38} color="#fff" style={!isPlaying && styles.playGlyphNudge} />
        )}
      </TouchableOpacity>
      {hasQueue && (
        <TouchableOpacity style={styles.navBtn} onPress={next} disabled={!canNext}>
          <Ionicons name="play-skip-forward" size={28} color={canNext ? colors.text : colors.textTertiary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function NowPlaying() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { currentTrack, expanded, collapse, setCommentComposing, noteCommentEngagement, clearCommentEngagement } = useAudio();
  const { show: showOptions } = usePostOptions();
  const router = useRouter();
  const [render, setRender] = useState(false);
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const closeVel = useRef(0);
  // Height of the comments area (list + input). Captured once via onLayout
  // (Math.max so the keyboard shrinking the KeyboardAvoidingView can't lower
  // it) and used to stretch the list header to exactly one screenful — the
  // "Comments" label peeks above the input bar at rest, and the comments
  // themselves are guaranteed to start below the fold on every device.
  const [commentsAreaH, setCommentsAreaH] = useState(0);

  // Post like/save/stats state for the current track. (Comments handled by <Comments/>.)
  const [userId, setUserId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string | undefined>();
  const [ownerBadge, setOwnerBadge] = useState<{ badge_tier?: string | null; badge_show?: boolean | null } | null>(null);
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
        supabase.from('posts').select('stream_count, save_count, user_id, profiles!posts_user_id_fkey(username, display_name, badge_tier, badge_show, profile_theme)').eq('id', pid).single(),
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
        setOwnerBadge(d.profiles ?? null);
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
      bumpBadge('likes');
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
      <LinearGradient colors={['#2A1206', '#150A04', colors.background]} style={styles.container}>
        {/* Top drag zone — swipe down to close */}
        <View {...pan.panHandlers}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBtn} onPress={collapse}>
              <Ionicons name="chevron-down" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Now Playing</Text>
            <TouchableOpacity
              style={styles.headerBtn}
              onPress={() => showOptions({
                postId: pid,
                isOwn: ownerId === userId,
                authorId: ownerId ?? undefined,
                authorName: ownerName,
                mediaType: 'audio',
                onEdit: () => { collapse(); router.push(`/edit-post/${pid}`); },
                onDeleted: () => collapse(),
                onArchived: () => collapse(),
                onBlocked: () => collapse(),
                onNavigate: collapse,
                onLikeChanged: (l) => { setIsLiked(l); setLikeCount(c => Math.max(0, c + (l ? 1 : -1))); },
                onSaveChanged: (s) => { setIsSaved(s); setSaves(c => Math.max(0, c + (s ? 1 : -1))); },
              })}
            >
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={8}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setCommentsAreaH(prev => Math.max(prev, h));
          }}
        >
          <Comments
            postId={pid}
            ownerId={ownerId}
            contentPadding={SPACING.md}
            // Area height minus the input bar (~81, calibrated) and the
            // divider+label block (~51): the label lands a few points above
            // the input bar and the first comment a few points below the fold
            // — the tight, clean at-rest look.
            minHeaderHeight={commentsAreaH > 0 ? Math.max(0, commentsAreaH - 146) : undefined}
            onNavigate={collapse}
            onComposingChange={setCommentComposing}
            onEngage={noteCommentEngagement}
            onScrollTop={clearCommentEngagement}
            ListHeaderComponent={
              <>
                <View style={styles.artWrap}>
                  {currentTrack.cover ? (
                    <Image source={{ uri: currentTrack.cover }} style={styles.art} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primary} style={styles.art}>
                      <Ionicons name="musical-notes" size={64} color={colors.text} />
                    </LinearGradient>
                  )}
                </View>

                <View style={styles.meta}>
                  <Text style={styles.title} numberOfLines={1}>{currentTrack.caption || 'Audio Track'}</Text>
                  <TouchableOpacity disabled={!ownerId} onPress={goProfile}>
                    <View style={styles.artistRow}>
                      <Text style={styles.artist} numberOfLines={1}>
                        {currentTrack.artist || (ownerName ? `@${ownerName}` : '')}
                      </Text>
                      <BadgeEmblem profile={ownerBadge} ownerId={ownerId} size={13} />
                    </View>
                  </TouchableOpacity>
                </View>

                <Progress />
                <Controls />

                {/* Like (tap) · Streams (display) · Saves (tap) */}
                <View style={styles.statBar}>
                  <TouchableOpacity style={[styles.tapStat, isLiked && styles.tapStatActiveLike]} onPress={handleLike} activeOpacity={0.8}>
                    <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={26} color={isLiked ? colors.like : colors.text} />
                    <Text style={styles.tapStatNum}>{formatCount(likeCount)}</Text>
                  </TouchableOpacity>
                  <View style={styles.centerStat}>
                    <Text style={styles.centerStatNum}>{formatCount(streams)}</Text>
                    <Text style={styles.centerStatLbl}>streams</Text>
                  </View>
                  <TouchableOpacity style={[styles.tapStat, isSaved && styles.tapStatActiveSave]} onPress={handleSave} activeOpacity={0.8}>
                    <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={26} color={colors.text} />
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

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
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
  headerTitle: { color: colors.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },

  // Vertical rhythm intentionally tight so the Comments header clears the
  // bottom fold at rest instead of sitting half-cut against the input bar.
  artWrap: { alignItems: 'center', marginTop: SPACING.xs },
  art: { width: ART, height: ART, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },

  meta: { marginTop: SPACING.md, alignItems: 'center', gap: SPACING.xs },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  artistRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  artist: { color: colors.textSecondary, fontSize: 15 },

  progressBlock: { marginTop: SPACING.md },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACING.xs },
  timeText: { color: colors.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'] },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xl, marginTop: SPACING.sm },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  // The play triangle's visual weight leans left — nudge it for optical center.
  playGlyphNudge: { marginLeft: 4 },

  statBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACING.md },
  tapStat: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm + 2,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated,
    borderWidth: 1, borderColor: colors.border,
  },
  tapStatActiveLike: { borderColor: colors.like, backgroundColor: colors.like + '1A' },
  tapStatActiveSave: { borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(255,255,255,0.10)' },
  tapStatNum: { color: colors.text, fontSize: 16, fontWeight: '700' },
  centerStat: { flex: 1, alignItems: 'center' },
  centerStatNum: { color: colors.text, fontSize: 18, fontWeight: '800' },
  centerStatLbl: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },

});
