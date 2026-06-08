import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Dimensions,
  Pressable, Animated, PanResponder, ActivityIndicator, Alert, Easing,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';
import { timeAgo } from '../../lib/timeAgo';
import {
  fetchStoriesForUsers, recordStoryView, deleteStory, fetchStoryViewerCount,
  type StoryGroup, type SourceRect,
} from '../../lib/stories';
import { useStories } from '../../contexts/StoriesContext';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const IMAGE_DURATION_MS = 5000;
const TICK_MS = 50;

export default function StoryViewerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { refresh: refreshStories } = useStories();
  const { userId, users, src } = useLocalSearchParams<{ userId: string; users?: string; src?: string }>();

  const orderedIds = useMemo<string[]>(() => {
    try {
      const parsed = users ? JSON.parse(users) : null;
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
    return userId ? [userId] : [];
  }, [users, userId]);

  // The tapped circle's screen rect — the viewer expands out of it / shrinks into it.
  const srcRect = useMemo<SourceRect | null>(() => {
    try {
      const p = src ? JSON.parse(src) : null;
      if (p && typeof p.x === 'number' && typeof p.width === 'number') return p;
    } catch {}
    return null;
  }, [src]);

  const [groups, setGroups] = useState<StoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userIndex, setUserIndex] = useState(0);
  const [storyIndex, setStoryIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewerCount, setViewerCount] = useState<number | null>(null);

  const progressRef = useRef(0);
  const pausedRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panY = useRef(new Animated.Value(0)).current;
  // Open/close "expand from rect" progress: 0 = at the source rect, 1 = fullscreen.
  const expand = useRef(new Animated.Value(srcRect ? 0 : 1)).current;
  const contentFadeIn = useRef(new Animated.Value(srcRect ? 0 : 1)).current; // slower open fade
  const closingRef = useRef(false);
  const panningRef = useRef(false);
  const pressInfo = useRef({ t: 0, x: 0 });

  const group = groups[userIndex] ?? null;
  const story = group?.stories[storyIndex] ?? null;
  const isOwn = !!currentUserId && group?.user.id === currentUserId;

  // ─── load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const viewerId = user?.id ?? null;
      setCurrentUserId(viewerId);
      if (!viewerId) { setLoading(false); return; }

      const fetched = await fetchStoriesForUsers(orderedIds, viewerId);
      setGroups(fetched);
      const startIdx = Math.max(0, fetched.findIndex((g) => g.user.id === userId));
      setUserIndex(startIdx === -1 ? 0 : startIdx);
      setStoryIndex(0);
      setLoading(false);
    })();
    // On close, refresh global story state so newly-seen rings update everywhere.
    return () => { clearTick(); refreshStories(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expand out of the tapped rect on open (Instagram shared-element style).
  useEffect(() => {
    if (srcRect) {
      Animated.timing(expand, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      Animated.timing(contentFadeIn, { toValue: 1, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── drive the active story (timer + view record) ────────────────────────────
  useEffect(() => {
    if (!story) return;
    resetProgress();
    if (currentUserId) recordStoryView(story.id, currentUserId).catch(() => {});

    setViewerCount(null);
    if (isOwn) fetchStoryViewerCount(story.id).then(setViewerCount).catch(() => {});

    // Images advance on a timer; videos advance from playback status instead.
    if (story.media_type === 'image') startImageTimer();
    return clearTick;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  function clearTick() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }
  function resetProgress() {
    clearTick();
    progressRef.current = 0;
    setProgress(0);
  }
  function startImageTimer() {
    clearTick();
    tickRef.current = setInterval(() => {
      if (pausedRef.current) return;
      progressRef.current += TICK_MS / IMAGE_DURATION_MS;
      if (progressRef.current >= 1) {
        progressRef.current = 1;
        setProgress(1);
        clearTick();
        goNext();
      } else {
        setProgress(progressRef.current);
      }
    }, TICK_MS);
  }

  // ─── dismiss (shrink back into the source rect, then pop) ─────────────────────
  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTick();
    if (srcRect) {
      Animated.parallel([
        Animated.timing(expand, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(panY, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => router.back());
    } else {
      router.back();
    }
  }, [srcRect, router, expand, panY]);

  // A ref snapshot of the current position so the advance/back callbacks read
  // fresh indices without being recreated on every story change.
  const posRef = useRef({ userIndex: 0, storyIndex: 0 });
  posRef.current = { userIndex, storyIndex };

  const goNext = useCallback(() => {
    const { userIndex: ui, storyIndex: si } = posRef.current;
    const g = groups[ui];
    if (!g) return;
    if (si < g.stories.length - 1) { setStoryIndex(si + 1); return; }
    if (ui < groups.length - 1) { setUserIndex(ui + 1); setStoryIndex(0); return; }
    dismiss();
  }, [groups, dismiss]);

  const goPrev = useCallback(() => {
    const { userIndex: ui, storyIndex: si } = posRef.current;
    if (si > 0) { setStoryIndex(si - 1); return; }
    if (ui > 0) {
      const prevG = groups[ui - 1];
      setUserIndex(ui - 1);
      setStoryIndex(Math.max(0, (prevG?.stories.length ?? 1) - 1));
      return;
    }
    // already at the very first story — restart it
    resetProgress();
    if (story?.media_type === 'image') startImageTimer();
  }, [groups, story?.media_type]);

  // ─── pause / resume + tap handling ───────────────────────────────────────────
  function pause() { pausedRef.current = true; setPaused(true); }
  function resume() { pausedRef.current = false; setPaused(false); }

  function onPressIn(e: any) {
    pressInfo.current = { t: Date.now(), x: e.nativeEvent.locationX };
    pause();
  }
  function onPressOut(e: any) {
    if (panningRef.current) return; // a drag, not a tap
    const dt = Date.now() - pressInfo.current.t;
    if (dt < 250) {
      if (pressInfo.current.x < SCREEN_W * 0.33) goPrev();
      else goNext();
    } else {
      resume();
    }
  }

  // ─── swipe-down to dismiss ───────────────────────────────────────────────────
  const live = useRef({ pause, resume, dismiss });
  live.current = { pause, resume, dismiss };
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 12 && g.dy > Math.abs(g.dx) * 1.5,
      onPanResponderGrant: () => { panningRef.current = true; live.current.pause(); },
      onPanResponderMove: (_, g) => { if (g.dy > 0) panY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 130) {
          live.current.dismiss();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
          panningRef.current = false;
          live.current.resume();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(panY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        panningRef.current = false;
        live.current.resume();
      },
    }),
  ).current;

  async function onDelete() {
    if (!story) return;
    Alert.alert('Delete story?', 'This will remove it for everyone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          const deletedId = story.id;
          await deleteStory(deletedId);
          // Drop it locally, then advance sensibly.
          setGroups((prev) => {
            const copy = prev.map((g) => ({ ...g, stories: [...g.stories] }));
            const g = copy[posRef.current.userIndex];
            if (g) g.stories = g.stories.filter((s) => s.id !== deletedId);
            return copy.filter((gr) => gr.stories.length > 0);
          });
        },
      },
    ]);
  }

  // After a delete reshapes groups, keep indices in range.
  useEffect(() => {
    if (loading) return;
    if (groups.length === 0) { dismiss(); return; }
    if (userIndex > groups.length - 1) { setUserIndex(groups.length - 1); setStoryIndex(0); return; }
    const g = groups[userIndex];
    if (g && storyIndex > g.stories.length - 1) setStoryIndex(Math.max(0, g.stories.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // ─── expand transform (rect → fullscreen) ────────────────────────────────────
  // Memoized so the 50ms progress-timer re-renders don't rebuild these mid-animation
  // (which makes the native transform stutter). `contentOpacity` fades the post out
  // as it reaches the ring so the tiny shrunk rectangle is never visible.
  const { contentTransform, backdropOpacity, contentOpacity } = useMemo(() => {
    if (!srcRect) {
      return {
        contentTransform: [{ translateY: panY }] as any[],
        backdropOpacity: 1 as Animated.Value | number,
        contentOpacity: 1 as Animated.Value | number,
      };
    }
    const s0 = srcRect.width / SCREEN_W;
    const tx0 = srcRect.x + srcRect.width / 2 - SCREEN_W / 2;
    const ty0 = srcRect.y + srcRect.height / 2 - SCREEN_H / 2;
    return {
      contentTransform: [
        { translateX: expand.interpolate({ inputRange: [0, 1], outputRange: [tx0, 0] }) },
        { translateY: expand.interpolate({ inputRange: [0, 1], outputRange: [ty0, 0] }) },
        { scale: expand.interpolate({ inputRange: [0, 1], outputRange: [s0, 1] }) },
        { translateY: panY },
      ] as any[],
      backdropOpacity: expand as any,
      contentOpacity: Animated.multiply(
        contentFadeIn,
        expand.interpolate({ inputRange: [0, 0.12], outputRange: [0, 1], extrapolate: 'clamp' }),
      ) as any,
    };
  }, [srcRect, expand, panY, contentFadeIn]);

  return (
    <View style={styles.root}>
      {/* Darkening backdrop — fades in as the post grows, fades out as it shrinks. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: backdropOpacity }]}
      />

      {/* The post itself — expands out of / shrinks into the tapped rect. */}
      <Animated.View
        style={[styles.container, { opacity: contentOpacity, transform: contentTransform as any }]}
        {...(group && story ? panResponder.panHandlers : {})}
      >
        {loading ? (
          <ActivityIndicator style={StyleSheet.absoluteFill} color="#fff" />
        ) : !group || !story ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <Text style={styles.empty}>No stories to show</Text>
            <TouchableOpacity onPress={dismiss} style={styles.emptyBtn}><Text style={styles.emptyBtnText}>Close</Text></TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Media */}
            {story.media_type === 'image' ? (
              <Image source={{ uri: story.media_url }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            ) : (
              <Video
                key={story.id}
                source={{ uri: story.media_url }}
                style={StyleSheet.absoluteFill}
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay={!paused}
                isLooping={false}
                onPlaybackStatusUpdate={(st: any) => {
                  if (!st.isLoaded) return;
                  if (st.durationMillis) setProgress(Math.min(1, (st.positionMillis ?? 0) / st.durationMillis));
                  if (st.didJustFinish) goNext();
                }}
              />
            )}

            {/* Tap surface (advance / pause) */}
            <Pressable style={StyleSheet.absoluteFill} onPressIn={onPressIn} onPressOut={onPressOut} />

            {/* Top scrim for legibility */}
            <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={styles.topScrim} pointerEvents="none" />

            {/* Progress segments */}
            <View style={[styles.progressRow, { top: insets.top + 6 }]} pointerEvents="none">
              {group.stories.map((s, i) => (
                <View key={s.id} style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${(i < storyIndex ? 1 : i === storyIndex ? progress : 0) * 100}%` },
                    ]}
                  />
                </View>
              ))}
            </View>

            {/* Header */}
            <View style={[styles.header, { top: insets.top + 18 }]}>
              <TouchableOpacity
                style={styles.author}
                onPress={() => { clearTick(); router.push(`/profile/${group.user.id}`); }}
              >
                {group.user.avatar_url ? (
                  <Image source={{ uri: group.user.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={['#E8401C', '#F26522']} style={styles.avatar}>
                    <Text style={styles.avatarText}>{group.user.display_name?.charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <Text style={styles.authorName} numberOfLines={1}>{group.user.username || group.user.display_name}</Text>
                <Text style={styles.time}>{timeAgo(story.created_at)}</Text>
              </TouchableOpacity>

              <View style={styles.headerRight}>
                {isOwn && (
                  <TouchableOpacity style={styles.headerBtn} onPress={onDelete} hitSlop={8}>
                    <Ionicons name="trash-outline" size={22} color="#fff" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.headerBtn} onPress={dismiss} hitSlop={8}>
                  <Ionicons name="close" size={28} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Caption */}
            {!!story.caption && (
              <View style={[styles.captionWrap, { bottom: insets.bottom + (isOwn ? 64 : 28) }]} pointerEvents="none">
                <Text style={styles.caption}>{story.caption}</Text>
              </View>
            )}

            {/* Own-story footer: viewer count */}
            {isOwn && (
              <View style={[styles.seenRow, { bottom: insets.bottom + 18 }]} pointerEvents="none">
                <Ionicons name="eye-outline" size={18} color="#fff" />
                <Text style={styles.seenText}>{viewerCount ?? 0}</Text>
              </View>
            )}
          </>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  empty: { color: COLORS.textSecondary, fontSize: 15 },
  emptyBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, borderRadius: RADIUS.full, borderWidth: 1, borderColor: COLORS.border },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, height: 160 },

  progressRow: { position: 'absolute', left: SPACING.sm, right: SPACING.sm, flexDirection: 'row', gap: 4 },
  progressTrack: { flex: 1, height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff', borderRadius: 2 },

  header: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  author: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexShrink: 1 },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  authorName: { color: '#fff', fontSize: 14, fontWeight: '700', flexShrink: 1 },
  time: { color: 'rgba(255,255,255,0.75)', fontSize: 12 },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  headerBtn: { padding: 2 },

  captionWrap: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  caption: { color: '#fff', fontSize: 15, lineHeight: 20 },

  seenRow: { position: 'absolute', left: SPACING.md, flexDirection: 'row', alignItems: 'center', gap: 5 },
  seenText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
