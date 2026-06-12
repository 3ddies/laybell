import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Dimensions,
  Pressable, Animated, PanResponder, ActivityIndicator, Alert, Easing, FlatList,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Image as ExpoImage } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { timeAgo } from '../../lib/timeAgo';
import {
  fetchStoriesForUsers, recordStoryView, deleteStory, fetchStoryViewerCount, fetchStoryViewers,
  fetchStoryLiked, setStoryLike,
  type StoryGroup, type SourceRect, type StoryViewer,
} from '../../lib/stories';
import { reportUser } from '../../lib/postActions';
import SongAttribution from '../../components/SongAttribution';
import BadgeEmblem from '../../components/BadgeEmblem';
import { captionStickerTextStyle, resolveSticker } from '../../components/StickerLayer';
import { useStories } from '../../contexts/StoriesContext';
import { usePostMusic } from '../../contexts/PostMusicContext';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const IMAGE_DURATION_MS = 5000;
// Video position updates fire on this cadence; the bar glides to each new position
// over the same interval so it moves continuously instead of stepping.
const VIDEO_PROGRESS_INTERVAL_MS = 250;
// Horizontal swipe past this (or a flick) jumps to the next/previous person.
const SWIPE_DIST = SCREEN_W * 0.25;

export default function StoryViewerScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { refresh: refreshStories, markSeen } = useStories();
  const { playSong, stop: stopSong, muted: songMuted, toggleMuted: toggleSongMuted } = usePostMusic();
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
  const [paused, setPaused] = useState(false);
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  // Measured height of the bottom caption box — the song attribution stacks
  // above it (captions wrap, so the offset can't be a constant).
  const [captionH, setCaptionH] = useState(0);
  // Own-story viewers sheet (who watched this story; likers ride on top).
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  const sheetAnim = useRef(new Animated.Value(0)).current; // 0 = hidden, 1 = up
  // Finger-following drag offset while pulling the sheet's top bar down.
  const sheetDragY = useRef(new Animated.Value(0)).current;
  const closeViewersRef = useRef<() => void>(() => {});
  // Viewer's like on someone else's story (heart button, bottom-right).
  const [liked, setLiked] = useState(false);

  const pausedRef = useRef(false);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  // Drives the CURRENT segment's fill (0→1, scaleX from the left).
  const progressAnim = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  // Open/close "expand from rect" progress: 0 = at the source rect, 1 = fullscreen.
  const expand = useRef(new Animated.Value(srcRect ? 0 : 1)).current;
  const contentFadeIn = useRef(new Animated.Value(srcRect ? 0 : 1)).current; // slower open fade
  // Free-floating text (stickers + a positioned caption) is hidden until the layout
  // has settled (and, when opening from a ring, until the zoom is essentially done),
  // then faded in at its composed positions. Without this the screen-sized translate
  // offsets are briefly applied before/while the container is at the wrong scale, so
  // the text piles up in the middle — the "glitchy jumble" on first view. This runs
  // for EVERY open path (including no-zoom opens, e.g. from a notification) so it's
  // fixed globally, not just when expanding out of a tapped circle.
  const textReveal = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const panningRef = useRef(false);
  const gestureAxisRef = useRef<'h' | 'v' | null>(null);
  const pressInfo = useRef({ t: 0, x: 0 });

  const group = groups[userIndex] ?? null;
  const story = group?.stories[storyIndex] ?? null;
  const isOwn = !!currentUserId && group?.user.id === currentUserId;

  // Fresh snapshots for the gesture/advance callbacks.
  const posRef = useRef({ userIndex: 0, storyIndex: 0 });
  posRef.current = { userIndex, storyIndex };
  const groupsRef = useRef<StoryGroup[]>([]);
  groupsRef.current = groups;
  // Story ids watched this session — once all of a user's stories are seen, their
  // ring is flipped to normal everywhere (optimistic; works even if not followed).
  const viewedRef = useRef<Set<string>>(new Set());

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
    return () => { stopProgressAnim(); refreshStories(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expand out of the tapped rect on open (Instagram shared-element style).
  useEffect(() => {
    if (srcRect) {
      Animated.timing(expand, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      Animated.timing(contentFadeIn, { toValue: 1, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    }
    // Reveal the overlay text once it's settled at full size: after the zoom when
    // expanding from a circle, or after a brief settle when opened without one.
    Animated.timing(textReveal, {
      toValue: 1,
      delay: srcRect ? 330 : 70,
      duration: 160,
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── drive the active story (timer + view record) ────────────────────────────
  useEffect(() => {
    if (!story) return;
    pausedRef.current = false;
    setPaused(false);
    stopProgressAnim();
    progressAnim.setValue(0);
    if (currentUserId) recordStoryView(story.id, currentUserId).catch(() => {});

    // Once every story from this author has been watched (this session or earlier),
    // turn their ring back to normal immediately — no wait on the close-time refetch.
    viewedRef.current.add(story.id);
    const g = groupsRef.current[posRef.current.userIndex];
    if (g && !isOwn && g.stories.every((s) => s.seen || viewedRef.current.has(s.id))) {
      markSeen(g.user.id, g.stories.map((s) => s.id));
    }

    setViewerCount(null);
    setShowViewers(false);
    sheetAnim.setValue(0);
    setCaptionH(0); // remeasured by the next story's caption (if any)
    setLiked(false);
    if (isOwn) fetchStoryViewerCount(story.id).then(setViewerCount).catch(() => {});
    else if (currentUserId) fetchStoryLiked(story.id, currentUserId).then(setLiked).catch(() => {});

    // Images advance on a timed fill; videos advance from playback status instead.
    if (story.media_type === 'image') startImageProgress(0);
    return stopProgressAnim;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // Freeze progress while the viewer is covered (e.g. you tapped through to a
  // profile) and resume from where it left off on return.
  useEffect(() => {
    if (!isFocused) {
      stopProgressAnim();
    } else if (!loading && story && !pausedRef.current && story.media_type === 'image') {
      progressAnim.stopAnimation((v: number) => startImageProgress(typeof v === 'number' ? v : 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  // Auto-play the song attached to the current story; stop on change/blur/close.
  useEffect(() => {
    const sid = story?.song_id;
    const hostId = story?.id;
    if (isFocused && hostId && sid) playSong(hostId, sid);
    else if (hostId) stopSong(hostId);
    return () => { if (hostId) stopSong(hostId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, story?.song_id, isFocused]);

  function stopProgressAnim() {
    if (animRef.current) { animRef.current.stop(); animRef.current = null; }
  }
  // Animate the current image segment from `from`→1 over the remaining duration,
  // advancing to the next story when it completes.
  function startImageProgress(from = 0) {
    stopProgressAnim();
    progressAnim.setValue(from);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: Math.max(0, IMAGE_DURATION_MS * (1 - from)),
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animRef.current = anim;
    anim.start(({ finished }) => { if (finished) { animRef.current = null; goNext(); } });
  }
  // Glide the fill to `toValue` over `duration` — used by video (continuous bar).
  function animateProgressTo(toValue: number, duration: number) {
    stopProgressAnim();
    const anim = Animated.timing(progressAnim, {
      toValue, duration, easing: Easing.linear, useNativeDriver: false,
    });
    animRef.current = anim;
    anim.start();
  }

  // ─── advance / back (tap + auto-advance, story-by-story) ─────────────────────
  function goNext() {
    const { userIndex: ui, storyIndex: si } = posRef.current;
    const g = groupsRef.current[ui];
    if (!g) return;
    if (si < g.stories.length - 1) { setStoryIndex(si + 1); return; }
    if (ui < groupsRef.current.length - 1) { setUserIndex(ui + 1); setStoryIndex(0); return; }
    dismiss();
  }

  function goPrev() {
    const { userIndex: ui, storyIndex: si } = posRef.current;
    if (si > 0) { setStoryIndex(si - 1); return; }
    if (ui > 0) {
      const prevG = groupsRef.current[ui - 1];
      setUserIndex(ui - 1);
      setStoryIndex(Math.max(0, (prevG?.stories.length ?? 1) - 1));
      return;
    }
    // already at the very first story — restart it from the top (and unpause).
    pausedRef.current = false;
    setPaused(false);
    stopProgressAnim();
    progressAnim.setValue(0);
    if (story?.media_type === 'image') startImageProgress(0);
  }

  // ─── horizontal swipe = jump to the next / previous PERSON ───────────────────
  function goNextUser() {
    const { userIndex: ui } = posRef.current;
    if (ui < groupsRef.current.length - 1) { setUserIndex(ui + 1); setStoryIndex(0); }
    else dismiss();
  }
  function goPrevUser() {
    const { userIndex: ui } = posRef.current;
    if (ui > 0) { setUserIndex(ui - 1); setStoryIndex(0); }
    else resume();
  }

  // ─── dismiss (shrink back into the source rect, then pop) ─────────────────────
  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    stopProgressAnim();
    if (srcRect) {
      Animated.parallel([
        Animated.timing(expand, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(panY, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => router.back());
    } else {
      router.back();
    }
  }, [srcRect, router, expand, panY]);

  // ─── pause / resume + tap handling ───────────────────────────────────────────
  function pause() {
    pausedRef.current = true;
    setPaused(true);
    stopProgressAnim();
  }
  function resume() {
    pausedRef.current = false;
    setPaused(false);
    if (story?.media_type === 'image') {
      progressAnim.stopAnimation((v: number) => startImageProgress(typeof v === 'number' ? v : 0));
    }
  }

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

  // ─── gestures: horizontal = jump between people, vertical = swipe-down dismiss ─
  // PanResponder is created once; it calls into `gh` (refreshed each render) so the
  // handlers always see current state. Horizontal is an instant cut (no animation).
  const gh = useRef<{ move: (g: any) => void; release: (g: any) => void; grant: () => void }>({
    move: () => {}, release: () => {}, grant: () => {},
  }).current;

  gh.grant = () => {
    panningRef.current = true;
    gestureAxisRef.current = null;
    pause();
  };
  gh.move = (g) => {
    if (!gestureAxisRef.current) {
      if (Math.abs(g.dx) > 6 && Math.abs(g.dx) >= Math.abs(g.dy)) gestureAxisRef.current = 'h';
      else if (g.dy > 6) gestureAxisRef.current = 'v';
      else return;
    }
    if (gestureAxisRef.current === 'v' && g.dy > 0) panY.setValue(g.dy);
    // horizontal: no drag feedback — committed on release
  };
  gh.release = (g) => {
    const axis = gestureAxisRef.current;
    gestureAxisRef.current = null;
    panningRef.current = false;
    if (axis === 'h') {
      if (g.dx <= -SWIPE_DIST || g.vx < -0.4) goNextUser();
      else if (g.dx >= SWIPE_DIST || g.vx > 0.4) goPrevUser();
      else resume();
    } else if (axis === 'v') {
      if (g.dy > 130) { dismiss(); return; }
      Animated.spring(panY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      resume();
    } else {
      resume();
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        (Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy)) ||
        (g.dy > 12 && g.dy > Math.abs(g.dx) * 1.2),
      onPanResponderGrant: () => gh.grant(),
      onPanResponderMove: (_, g) => gh.move(g),
      onPanResponderRelease: (_, g) => gh.release(g),
      onPanResponderTerminate: (_, g) => gh.release(g),
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

  // Own-story viewers sheet: pause the story AND its music while it's open,
  // slide the sheet up IG-style, resume both on close.
  function openViewers() {
    if (!story) return;
    pause();
    if (story.song_id) stopSong(story.id);
    setShowViewers(true);
    sheetAnim.setValue(0);
    sheetDragY.setValue(0);
    Animated.timing(sheetAnim, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    setViewersLoading(true);
    fetchStoryViewers(story.id)
      .then(setViewers)
      .catch(() => setViewers([]))
      .finally(() => setViewersLoading(false));
  }
  function closeViewers(navigatingAway = false) {
    Animated.timing(sheetAnim, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => setShowViewers(false));
    if (!navigatingAway) {
      resume();
      if (story?.song_id && isFocused) playSong(story.id, story.song_id);
    }
  }

  closeViewersRef.current = () => closeViewers();

  // Drag the sheet down by its top bar (handle + "Viewers" header) to dismiss —
  // follows the finger, springs back on a short pull.
  const sheetPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => { if (g.dy > 0) sheetDragY.setValue(g.dy); },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 90 || g.vy > 0.5) closeViewersRef.current();
        else Animated.spring(sheetDragY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
      onPanResponderTerminate: () =>
        Animated.spring(sheetDragY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
    }),
  ).current;

  // Like someone else's story (optimistic; heart bottom-right).
  function toggleStoryLike() {
    if (!story || !currentUserId || isOwn) return;
    const next = !liked;
    setLiked(next);
    setStoryLike(story.id, currentUserId, next);
  }

  // Report another user's story — pause while the dialog is up, resume after.
  function onReport() {
    if (!group || isOwn) return;
    pause();
    reportUser(group.user.id, resume);
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

  // ─── expand transform (rect → fullscreen) + swipe-down ───────────────────────
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

      {/* The current story — expands out of the tapped rect on open, follows the
          finger down to dismiss; tap / horizontal-swipe change story instantly. */}
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
            {/* Media. expo-image (cached, fast) avoids the flash when tapping between
                stories; the video shows its thumbnail poster while it buffers so
                there's no pitch-black gap on open / person change. */}
            {story.media_type === 'image' ? (
              <ExpoImage source={{ uri: story.media_url }} style={StyleSheet.absoluteFill} contentFit="contain" />
            ) : (
              <Video
                key={story.id}
                source={{ uri: story.media_url }}
                style={StyleSheet.absoluteFill}
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay={!paused}
                isLooping={false}
                isMuted={!!story.song_id}
                usePoster={!!story.thumbnail_url}
                posterSource={story.thumbnail_url ? { uri: story.thumbnail_url } : undefined}
                posterStyle={{ resizeMode: 'contain' }}
                progressUpdateIntervalMillis={VIDEO_PROGRESS_INTERVAL_MS}
                onPlaybackStatusUpdate={(st: any) => {
                  if (!st.isLoaded) return;
                  if (st.durationMillis && !pausedRef.current) {
                    animateProgressTo(Math.min(1, (st.positionMillis ?? 0) / st.durationMillis), VIDEO_PROGRESS_INTERVAL_MS);
                  }
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
                  <Animated.View
                    style={[
                      styles.progressFill,
                      { transform: [{ scaleX: i < storyIndex ? 1 : i === storyIndex ? progressAnim : 0 }] },
                    ]}
                  />
                </View>
              ))}
            </View>

            {/* Header */}
            <View style={[styles.header, { top: insets.top + 18 }]}>
              <TouchableOpacity
                style={styles.author}
                onPress={() => { stopProgressAnim(); router.push(`/profile/${group.user.id}`); }}
              >
                {group.user.avatar_url ? (
                  <Image source={{ uri: group.user.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={['#E8401C', '#F26522']} style={styles.avatar}>
                    <Text style={styles.avatarText}>{group.user.display_name?.charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <Text style={styles.authorName} numberOfLines={1}>{group.user.username || group.user.display_name}</Text>
                <BadgeEmblem profile={group.user} size={13} />
                <Text style={styles.time}>{timeAgo(story.created_at)}</Text>
              </TouchableOpacity>

              <View style={styles.headerRight}>
                {!!story.song_id && (
                  <TouchableOpacity style={styles.headerBtn} onPress={toggleSongMuted} hitSlop={8}>
                    <Ionicons name={songMuted ? 'volume-mute' : 'volume-high'} size={21} color="#fff" />
                  </TouchableOpacity>
                )}
                {isOwn ? (
                  <TouchableOpacity style={styles.headerBtn} onPress={onDelete} hitSlop={8}>
                    <Ionicons name="trash-outline" size={22} color="#fff" />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.headerBtn} onPress={onReport} hitSlop={8}>
                    <Ionicons name="ellipsis-horizontal" size={22} color="#fff" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.headerBtn} onPress={dismiss} hitSlop={8}>
                  <Ionicons name="close" size={28} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Bottom caption (or, for older stories, the single positioned caption). */}
            {!!story.caption && (
              story.caption_style ? (
                <Animated.View style={[StyleSheet.absoluteFill, { opacity: textReveal }]} pointerEvents="none">
                  <View style={styles.captionStickerCenter}>
                    <Text
                      style={[captionStickerTextStyle, {
                        transform: [
                          { translateX: (story.caption_style.x - 0.5) * SCREEN_W },
                          { translateY: (story.caption_style.y - 0.5) * SCREEN_H },
                          { scale: story.caption_style.scale ?? 1 },
                          { rotate: `${story.caption_style.rotation ?? 0}deg` },
                        ],
                      }]}
                    >
                      {story.caption}
                    </Text>
                  </View>
                </Animated.View>
              ) : (
                <View
                  style={[styles.captionWrap, { bottom: insets.bottom + (isOwn ? 64 : 28) }]}
                  pointerEvents="none"
                  // Measured so the song attribution can stack ABOVE the
                  // caption's real height (captions wrap — a fixed offset
                  // collided with multi-line ones).
                  onLayout={(e) => setCaptionH(Math.ceil(e.nativeEvent.layout.height))}
                >
                  <Text style={styles.caption}>{story.caption}</Text>
                </View>
              )
            )}

            {/* Draggable text/emoji stickers, placed anywhere on the media by the
                author — rendered through the SAME style resolver as the editor
                (font / color / background / emoji metadata in stickers jsonb),
                so the story looks exactly as it did when composed. */}
            {(story.stickers ?? []).length > 0 && (
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: textReveal }]} pointerEvents="none">
                {(story.stickers ?? []).map((st: any, i: number) => {
                  const { textStyle, boxStyle } = resolveSticker(st);
                  return (
                    <View key={i} style={StyleSheet.absoluteFill}>
                      <View style={styles.captionStickerCenter}>
                        <View
                          style={[boxStyle, {
                            transform: [
                              { translateX: (st.x - 0.5) * SCREEN_W },
                              { translateY: (st.y - 0.5) * SCREEN_H },
                              { scale: st.scale ?? 1 },
                              { rotate: `${st.rotation ?? 0}deg` },
                            ],
                          }]}
                        >
                          <Text style={textStyle}>{st.text}</Text>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </Animated.View>
            )}

            {/* Own-story footer: viewer count — tap to see WHO watched */}
            {isOwn && (
              <TouchableOpacity
                style={[styles.seenRow, { bottom: insets.bottom + 18 }]}
                onPress={openViewers}
                activeOpacity={0.7}
                hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
              >
                <Ionicons name="eye-outline" size={18} color="#fff" />
                <Text style={styles.seenText}>{viewerCount ?? 0}</Text>
                <Ionicons name="chevron-up" size={14} color="rgba(255,255,255,0.7)" />
              </TouchableOpacity>
            )}

            {/* Someone else's story: heart it (shows on their viewers list) */}
            {!isOwn && !!currentUserId && (
              <TouchableOpacity
                style={[styles.likeBtn, { bottom: insets.bottom + 18 }]}
                onPress={toggleStoryLike}
                activeOpacity={0.7}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Ionicons name={liked ? 'heart' : 'heart-outline'} size={30} color={liked ? '#F43F5E' : '#fff'} />
              </TouchableOpacity>
            )}

            {/* Song used on this story — stacked above the caption's MEASURED
                height so the two can never overlap, however long the caption. */}
            {!!story.song_id && (
              <SongAttribution
                style={{
                  bottom: insets.bottom + (
                    story.caption && !story.caption_style
                      ? (isOwn ? 64 : 28) + captionH + 10
                      : isOwn ? 52 : 28
                  ),
                }}
                songId={story.song_id}
                title={story.song_title}
                artist={story.song_artist}
                artistId={story.song_artist_id}
                onNavigate={dismiss}
                onPauseHost={pause}
              />
            )}
          </>
        )}
      </Animated.View>

      {/* Viewers sheet — who watched (and who LIKED — hearts ride on top).
          Fixed-height IG-style sheet that slides well up the screen even when
          the list is short; story + music pause while it's open. */}
      {showViewers && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.viewersBackdrop, { opacity: sheetAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => closeViewers()} />
          </Animated.View>
          <Animated.View
            style={[
              styles.viewersSheet,
              {
                height: SCREEN_H * 0.62,
                paddingBottom: insets.bottom + SPACING.md,
                transform: [
                  { translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [SCREEN_H * 0.62, 0] }) },
                  { translateY: sheetDragY },
                ],
              },
            ]}
          >
            {/* Top bar is the drag target: pull anywhere on it to dismiss */}
            <View {...sheetPan.panHandlers}>
              <View style={styles.viewersHandle} />
              <View style={styles.viewersHeader}>
                <Text style={styles.viewersTitle}>Viewers</Text>
                <View style={styles.viewersCountChip}>
                  <Ionicons name="eye-outline" size={13} color="rgba(255,255,255,0.8)" />
                  <Text style={styles.viewersCountText}>{viewerCount ?? viewers.length}</Text>
                </View>
              </View>
              <View style={styles.viewersDivider} />
            </View>
            {viewersLoading ? (
              <ActivityIndicator color="#fff" style={{ marginVertical: SPACING.xl }} />
            ) : viewers.length === 0 ? (
              <View style={styles.viewersEmptyWrap}>
                <Ionicons name="eye-outline" size={34} color="rgba(255,255,255,0.35)" />
                <Text style={styles.viewersEmpty}>No views yet</Text>
                <Text style={styles.viewersEmptySub}>Check back soon</Text>
              </View>
            ) : (
              <FlatList
                data={viewers}
                keyExtractor={(v) => v.id}
                showsVerticalScrollIndicator={false}
                renderItem={({ item: v }) => (
                  <TouchableOpacity
                    style={styles.viewerRow}
                    activeOpacity={0.7}
                    onPress={() => { closeViewers(true); router.push(`/profile/${v.id}`); }}
                  >
                    <View style={styles.viewerAvatarWrap}>
                      {v.avatar_url ? (
                        <ExpoImage source={{ uri: v.avatar_url }} style={styles.viewerAvatar} contentFit="cover" />
                      ) : (
                        <LinearGradient colors={['#F26522', '#E8401C']} style={styles.viewerAvatar}>
                          <Text style={styles.viewerAvatarText}>
                            {(v.display_name || v.username || '?').charAt(0).toUpperCase()}
                          </Text>
                        </LinearGradient>
                      )}
                      {/* Liked this story — red heart emblem on the avatar */}
                      {v.liked && (
                        <View style={styles.viewerLikeBadge}>
                          <Ionicons name="heart" size={10} color="#fff" />
                        </View>
                      )}
                    </View>
                    <View style={styles.viewerInfo}>
                      <View style={styles.viewerNameRow}>
                        <Text style={styles.viewerName} numberOfLines={1}>{v.display_name || v.username}</Text>
                        <BadgeEmblem profile={v} size={13} />
                      </View>
                      <Text style={styles.viewerHandle} numberOfLines={1}>@{v.username}</Text>
                    </View>
                  </TouchableOpacity>
                )}
              />
            )}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  root: { flex: 1 },
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  empty: { color: colors.textSecondary, fontSize: 15 },
  emptyBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, height: 160 },

  progressRow: { position: 'absolute', left: SPACING.sm, right: SPACING.sm, flexDirection: 'row', gap: 4 },
  progressTrack: { flex: 1, height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  // Full-width fill scaled from the left via scaleX (0→1) so the bar can be driven
  // by Animated without re-rendering or re-measuring each frame.
  progressFill: { width: '100%', height: '100%', backgroundColor: '#fff', borderRadius: 2, transformOrigin: 'left' },

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

  captionStickerCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  captionWrap: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  caption: { color: '#fff', fontSize: 15, lineHeight: 20 },

  seenRow: { position: 'absolute', left: SPACING.md, flexDirection: 'row', alignItems: 'center', gap: 5 },
  seenText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // Heart on someone else's story (mirrors the owner's eye row, right side).
  likeBtn: { position: 'absolute', right: SPACING.md },

  // Viewers sheet (own stories): tall IG-style sheet — fixed height (set in
  // JSX) so it rises well up the screen even with only a couple of viewers.
  viewersBackdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  viewersSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#0E0E0E',
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingTop: SPACING.sm, paddingHorizontal: SPACING.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)',
  },
  viewersHandle: {
    width: 38, height: 5, borderRadius: 2.5, alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.28)', marginBottom: SPACING.sm,
  },
  viewersHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: SPACING.xs, marginBottom: SPACING.xs,
  },
  viewersTitle: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  viewersCountChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  viewersCountText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '700' },
  viewersDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: SPACING.xs },
  viewersEmptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingBottom: SPACING.xxl },
  viewersEmpty: { color: 'rgba(255,255,255,0.75)', fontSize: 15, fontWeight: '700' },
  viewersEmptySub: { color: 'rgba(255,255,255,0.45)', fontSize: 13 },
  viewerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, paddingVertical: SPACING.sm },
  viewerAvatarWrap: { width: 44, height: 44 },
  viewerAvatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  viewerAvatarText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  // Red heart emblem on likers' avatars (likers sort to the top of the list).
  viewerLikeBadge: {
    position: 'absolute', bottom: -2, right: -4,
    width: 19, height: 19, borderRadius: 9.5,
    backgroundColor: '#F43F5E',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#0E0E0E',
  },
  viewerInfo: { flex: 1 },
  viewerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  viewerName: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  viewerHandle: { color: 'rgba(255,255,255,0.55)', fontSize: 12.5, marginTop: 1 },
});
