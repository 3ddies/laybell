import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { View, Text, StyleSheet, Pressable, TouchableOpacity, Animated, ActivityIndicator, Dimensions, Easing, PanResponder } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { fetchStorybookFull, getCachedStorybookFull, type StorybookFull, type StorybookItem } from '../../lib/storybooks';
import type { SourceRect } from '../../lib/stories';
import AppVideo from '../../components/AppVideo';

// Full-screen storybook viewer — story-style playback through the book's chapters
// in order, items within a chapter in order. Images get a fixed on-screen time;
// videos play (AppVideo) and drive the bar from their own progress. Tap right/left
// to step, hold to pause, X or the end to close. A chapter's title shows as a pill
// when its first item comes up.

const IMAGE_MS = 5000;
const HOLD_MS = 850;      // how long a chapter's title holds center-screen before it starts leaving
const FADE_OUT_MS = 360;  // the title's fade-out
const PLAY_LEAD_MS = 230; // start the story this far INTO the fade-out, so media is well underway before the title is gone
const LOAD_TIMEOUT_MS = 8000; // first media must become paintable within this, else "Couldn't load story"
const VEIL_GRACE_MS = 220;    // only show the grey loader if the first media isn't ready within this (otherwise never)
const BG = '#1C1C20';         // the viewer's base — a dark GREY, never pure black (incl. letterbox bars)
const LOADING_BG = '#2A2A30'; // the grey loading surface (a touch lighter, so it reads as a distinct loading layer)
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const DISMISS_DY = 140; // pull down past this → dismiss (matches the story viewer)

type Segment = { item: StorybookItem; chapterIndex: number; chapterTitle: string | null; firstOfChapter: boolean };

export default function StorybookViewer() {
  const { id, src } = useLocalSearchParams<{ id: string; src?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // The tapped ring's screen rect — the viewer expands out of it / shrinks into it, exactly
  // like the regular story viewer (app/story/[userId]).
  const srcRect = useMemo<SourceRect | null>(() => {
    try { const p = src ? JSON.parse(src) : null; if (p && typeof p.x === 'number' && typeof p.width === 'number') return p; } catch {}
    return null;
  }, [src]);

  // The shelf pre-loads the book, so it's usually already cached here — open straight
  // into it (no in-viewer data spinner, no black flash).
  const cached = getCachedStorybookFull(String(id));
  const [book, setBook] = useState<StorybookFull | null>(cached);
  const [owner, setOwner] = useState<{ username: string; display_name: string; avatar_url: string | null } | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [intro, setIntro] = useState(false); // chapter-title card is on screen (through its fade-out)
  const [hold, setHold] = useState(false);   // playback gated for the title hold (released a touch into the fade-out)
  const [firstReady, setFirstReady] = useState(false); // the first story's media can actually paint — until then we wait (never black)
  const [showVeil, setShowVeil] = useState(false);     // show the GREY loader only if readiness is slow (grace period), never for a split-second flash
  const [mediaFailed, setMediaFailed] = useState(false); // first media absolutely won't load → "Couldn't load story"
  const [reloadKey, setReloadKey] = useState(0);         // bump to remount the media on Retry

  const anim = useRef(new Animated.Value(0)).current;
  const introAnim = useRef(new Animated.Value(0)).current;
  const progressRef = useRef(0);

  // Swipe-down-to-dismiss + a fade/scale entrance (the route presents with animation:'none',
  // so the viewer owns its own motion — just like the real story viewer).
  const panY = useRef(new Animated.Value(0)).current;
  const expand = useRef(new Animated.Value(0)).current; // 0 = at the ring, 1 = fullscreen (shared-element)
  const closingRef = useRef(false);
  const axisRef = useRef<null | 'v' | 'h'>(null);

  useEffect(() => {
    const sub = anim.addListener(({ value }) => { progressRef.current = value; });
    return () => anim.removeListener(sub);
  }, [anim]);

  // Expand out of the tapped ring on open (Instagram shared-element), or — with no rect to
  // grow from (a deep link) — slide in from the right. Same timings as the story viewer.
  useEffect(() => {
    Animated.timing(expand, {
      toValue: 1,
      duration: srcRect ? 360 : 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [expand, srcRect]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: { user } }, full] = await Promise.all([
        supabase.auth.getUser(),
        fetchStorybookFull(String(id)),
      ]);
      if (!alive) return;
      setMe(user?.id ?? null);
      if (full) setBook(full); // a refetch that returns null (blip) keeps the cached book
      const b2 = full ?? getCachedStorybookFull(String(id));
      if (b2) {
        const { data: prof } = await supabase
          .from('profiles').select('username, display_name, avatar_url').eq('id', b2.user_id).maybeSingle();
        if (alive) setOwner(prof as any);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id]);

  // Flatten chapters → a single ordered list of segments, tagging chapter boundaries.
  const segments = useMemo<Segment[]>(() => {
    if (!book) return [];
    const out: Segment[] = [];
    book.chapters.forEach((ch, ci) => {
      ch.items.forEach((item, ii) => {
        out.push({ item, chapterIndex: ci, chapterTitle: ch.title, firstOfChapter: ii === 0 });
      });
    });
    return out;
  }, [book]);

  const current = segments[index] ?? null;
  const isOwn = !!book && book.user_id === me;

  // Fire the chapter title once per chapter-entry, only once the media is ready. Keyed on a
  // PRIMITIVE so a background refetch (same content, new array identity) can't restart the
  // animation mid-flight — that restart was the stutter.
  const chapterIntroKey = firstReady && current?.firstOfChapter && current?.chapterTitle
    ? `${current.chapterIndex}:${current.chapterTitle}`
    : '';

  // The first visible pixel: an image's own frame, or a video's poster. We prefetch it so
  // the viewer can open already-painted (no grey flash).
  const firstVisibleUrl = useMemo(() => {
    const seg = segments[0];
    if (!seg) return null;
    return seg.item.media_type === 'video' ? (seg.item.thumbnail_url ?? null) : seg.item.media_url;
  }, [segments]);

  // Dismiss motions: X / end-of-book fades out; a pull-down rides the finger out.
  // Dismiss (X / tap / end) — shrink back into the ring it opened from, mirroring the story
  // viewer exactly. No ring (deep link) → slide back out to the right.
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (srcRect) {
      Animated.parallel([
        Animated.timing(expand, { toValue: 0, duration: 300, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(panY, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => router.back());
    } else {
      Animated.timing(expand, { toValue: 0, duration: 240, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => router.back());
    }
  }, [srcRect, router, expand, panY]);

  // Swipe-down release — one continuous arc from wherever the drag left it back INTO the ring
  // (expand and panY share the same duration + easing). No ring → glide the rest of the way down.
  const dismissDown = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (srcRect) {
      Animated.parallel([
        Animated.timing(expand, { toValue: 0, duration: 360, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
        Animated.timing(panY, { toValue: 0, duration: 360, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      ]).start(() => router.back());
    } else {
      Animated.timing(panY, { toValue: SCREEN_H, duration: 320, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start(() => router.back());
    }
  }, [srcRect, router, expand, panY]);

  const goNext = useCallback(() => {
    if (index >= segments.length - 1) { close(); return; }  // past the last → close
    setIndex(index + 1);
  }, [index, segments.length, close]);

  const goPrev = useCallback(() => {
    anim.setValue(0);
    setIndex((i) => Math.max(0, i - 1));
  }, [anim]);

  // Pull-DOWN to dismiss, like a regular story. Horizontal / upward drags are IGNORED — a
  // story doesn't exit on a side swipe (the native back-gesture is off for this route too).
  // `gh` is refreshed each render so the handlers read current state.
  const gh = useRef<{ grant: () => void; move: (g: any) => void; release: (g: any) => void }>({ grant: () => {}, move: () => {}, release: () => {} }).current;
  gh.grant = () => { axisRef.current = null; setPaused(true); };
  gh.move = (g) => {
    if (!axisRef.current) {
      if (g.dy > 6 && g.dy >= Math.abs(g.dx)) axisRef.current = 'v';
      else if (Math.abs(g.dx) > 6) axisRef.current = 'h';
      else return;
    }
    if (axisRef.current === 'v' && g.dy > 0) panY.setValue(g.dy);
  };
  gh.release = (g) => {
    const axis = axisRef.current;
    axisRef.current = null;
    if (axis === 'v' && g.dy > DISMISS_DY) { dismissDown(); return; }
    Animated.spring(panY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 12 }).start();
    setPaused(false);
  };
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 8 && g.dy > Math.abs(g.dx) * 1.1, // only claim a downward drag
      onPanResponderGrant: () => gh.grant(),
      onPanResponderMove: (_, g) => gh.move(g),
      onPanResponderRelease: (_, g) => gh.release(g),
      onPanResponderTerminate: (_, g) => gh.release(g),
    }),
  ).current;

  // Reset the bar whenever the segment changes.
  useEffect(() => { anim.setValue(0); progressRef.current = 0; }, [index, anim]);

  // Chapter interstitial: when the first item of a titled chapter comes up (including
  // the very first chapter on open), show the chapter title big in the center and hold
  // playback. After HOLD_MS the title fades out — and the story is released a touch into
  // that fade (PLAY_LEAD_MS), so the media is already moving before the title is gone,
  // which reads as one fluent motion rather than a stop-start. Media timing is gated on
  // `hold`; the card stays mounted (fading) via `intro`.
  useEffect(() => {
    if (!chapterIntroKey) { setIntro(false); setHold(false); introAnim.setValue(0); return; }
    setIntro(true);
    setHold(true);
    introAnim.setValue(0);
    let cancelled = false;
    Animated.timing(introAnim, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // Begin the fade-out after the hold…
    const fadeT = setTimeout(() => {
      if (cancelled) return;
      Animated.timing(introAnim, { toValue: 0, duration: FADE_OUT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(({ finished }) => { if (finished && !cancelled) setIntro(false); });
    }, HOLD_MS);
    // …and start the story partway into that fade.
    const playT = setTimeout(() => { if (!cancelled) setHold(false); }, HOLD_MS + PLAY_LEAD_MS);
    return () => { cancelled = true; clearTimeout(fadeT); clearTimeout(playT); };
  }, [chapterIntroKey, introAnim]);

  // Image timing: run a timer from the current progress to full, advancing at the end.
  // Videos drive the bar from onProgress instead, so they're skipped here.
  useEffect(() => {
    if (!current || current.item.media_type !== 'image' || paused || hold || !firstReady) return;
    const remaining = IMAGE_MS * (1 - progressRef.current);
    const a = Animated.timing(anim, { toValue: 1, duration: Math.max(0, remaining), useNativeDriver: false });
    a.start(({ finished }) => { if (finished) goNext(); });
    return () => a.stop();
  }, [index, paused, hold, firstReady, current, anim, goNext]);

  // If the first media can't become paintable within LOAD_TIMEOUT_MS (broken URL, dead
  // connection), stop waiting on the grey spinner and show "Couldn't load story" — never
  // a black screen, never an endless spinner.
  useEffect(() => {
    if (loading || firstReady || mediaFailed || segments.length === 0) return;
    const t = setTimeout(() => setMediaFailed(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [loading, firstReady, mediaFailed, segments.length]);

  // Prefetch the first visible pixel (image frame / video poster). Usually already warmed by
  // the shelf before it navigated, so this resolves at once and we mark ready before any grey
  // can show — the load effectively happened during the ring spinner, not in here.
  useEffect(() => {
    if (!firstVisibleUrl || firstReady) return;
    let alive = true;
    Image.prefetch(firstVisibleUrl).then((ok) => { if (alive && ok) setFirstReady(true); }).catch(() => {});
    return () => { alive = false; };
  }, [firstVisibleUrl, firstReady]);

  // The grey loader only appears if readiness is genuinely slow — a short grace keeps a
  // split-second load from ever flashing grey (prefer a touch more stall over a grey blink).
  useEffect(() => {
    if (loading || firstReady || mediaFailed) { setShowVeil(false); return; }
    const t = setTimeout(() => setShowVeil(true), VEIL_GRACE_MS);
    return () => clearTimeout(t);
  }, [loading, firstReady, mediaFailed]);

  // Entrance + pull-down transforms (all native-driven).
  // Expand (ring → fullscreen) + swipe-down, identical to app/story/[userId]: the card grows
  // out of the tapped ring and, on dismiss, shrinks back into it; the pull-down adds a gentle
  // extra translate/scale over a solid backdrop.
  const { contentTransform, backdropOpacity, contentOpacity } = useMemo(() => {
    const dragScale = panY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [1, 0.93], extrapolate: 'clamp' });
    if (!srcRect) {
      return {
        contentTransform: [
          { translateX: expand.interpolate({ inputRange: [0, 1], outputRange: [SCREEN_W, 0] }) },
          { translateY: panY },
          { scale: dragScale },
        ] as any[],
        backdropOpacity: expand as Animated.Value | number,
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
        { scale: dragScale },
      ] as any[],
      backdropOpacity: expand as any,
      contentOpacity: expand.interpolate({ inputRange: [0, 0.12], outputRange: [0, 1], extrapolate: 'clamp' }) as any,
    };
  }, [srcRect, expand, panY]);

  let inner: ReactNode;
  if (loading) {
    inner = <View style={[StyleSheet.absoluteFill as any, styles.center, styles.veil]}><ActivityIndicator color="#fff" /></View>;
  } else if (!book || segments.length === 0 || !current) {
    inner = (
      <View style={[StyleSheet.absoluteFill as any, styles.center, styles.veil]}>
        <Text style={styles.emptyText}>This storybook is empty.</Text>
        <TouchableOpacity onPress={close} style={styles.emptyBtn}><Text style={styles.emptyBtnText}>Close</Text></TouchableOpacity>
      </View>
    );
  } else if (mediaFailed) {
    inner = (
      <View style={[StyleSheet.absoluteFill as any, styles.center, styles.veil]}>
        <Ionicons name="cloud-offline-outline" size={40} color="rgba(255,255,255,0.65)" />
        <Text style={styles.emptyText}>Couldn't load story</Text>
        <View style={styles.failBtns}>
          <TouchableOpacity onPress={() => { setMediaFailed(false); setFirstReady(false); setReloadKey((k) => k + 1); }} style={styles.emptyBtn}>
            <Text style={styles.emptyBtnText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={close} style={styles.emptyBtn}><Text style={styles.emptyBtnText}>Close</Text></TouchableOpacity>
        </View>
      </View>
    );
  } else {
    const it = current.item;
    inner = (
      <>
      {/* Media */}
      {it.media_type === 'video' ? (
        <AppVideo
          key={`v-${it.id}-${reloadKey}`}
          source={{ uri: it.media_url }}
          style={StyleSheet.absoluteFill as any}
          contentFit="contain"
          active={!paused && firstReady}
          poster={it.thumbnail_url ?? undefined}
          onReady={() => setFirstReady(true)}
          onProgress={(cur, dur) => { if (dur > 0) anim.setValue(Math.min(1, cur / dur)); }}
          onEnd={goNext}
        />
      ) : (
        <Image
          key={`i-${it.id}-${reloadKey}`}
          source={{ uri: it.media_url }}
          style={StyleSheet.absoluteFill as any}
          contentFit="contain"
          transition={120}
          onLoad={() => setFirstReady(true)}
          onError={() => { if (!firstReady) setMediaFailed(true); }}  // only the FIRST paint failing is fatal; a later broken frame just skips
        />
      )}

      {/* Tap zones: left third = back, right = forward; long-press either = pause */}
      <View style={StyleSheet.absoluteFill as any} pointerEvents="box-none">
        <View style={styles.zones}>
          <Pressable style={styles.zoneLeft} onPress={goPrev} onLongPress={() => setPaused(true)} onPressOut={() => setPaused(false)} delayLongPress={180} />
          <Pressable style={styles.zoneRight} onPress={goNext} onLongPress={() => setPaused(true)} onPressOut={() => setPaused(false)} delayLongPress={180} />
        </View>
      </View>

      {/* Loading veil — until the first story can actually paint, hold on a spinner instead
          of flashing black (and don't show the chapter title over nothing). It sits below
          the header, so the close button stays tappable and a story that never loads isn't
          a dead end. */}
      {showVeil ? (
        <View style={[StyleSheet.absoluteFill as any, styles.center, styles.veil]}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}

      {/* Chapter interstitial — the title held big in the center over the (dimmed) story,
          with the bars/header still crisp above it; then it fades and the chapter's first
          story starts (playback is gated on `intro`). */}
      {intro && current.firstOfChapter && current.chapterTitle ? (
        <Animated.View style={[StyleSheet.absoluteFill as any, styles.introWrap, { opacity: introAnim }]} pointerEvents="none">
          <Animated.Text
            style={[styles.introTitle, {
              transform: [
                { translateY: introAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
                { scale: introAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
              ],
            }]}
            numberOfLines={3}
          >
            {current.chapterTitle}
          </Animated.Text>
        </Animated.View>
      ) : null}

      {/* Progress segments, grouped by chapter */}
      <View style={[styles.bars, { top: insets.top + 8 }]} pointerEvents="none">
        {segments.map((seg, i) => (
          <View key={seg.item.id} style={[styles.barTrack, seg.firstOfChapter && i > 0 ? styles.barGap : null]}>
            {i < index ? (
              <View style={styles.barFull} />
            ) : i === index ? (
              <Animated.View style={[styles.barFill, { width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
            ) : null}
          </View>
        ))}
      </View>

      {/* Header: owner + book title, chapter pill, close (+ edit for the owner) */}
      <View style={[styles.header, { top: insets.top + 20 }]} pointerEvents="box-none">
        <View style={styles.headerLeft}>
          {owner?.avatar_url ? <Image source={{ uri: owner.avatar_url }} style={styles.avatar} /> : <View style={[styles.avatar, styles.avatarEmpty]} />}
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.bookTitle} numberOfLines={1}>{book.title}</Text>
            <Text style={styles.ownerName} numberOfLines={1}>{owner?.display_name || owner?.username || ''}</Text>
          </View>
        </View>
        <View style={styles.headerBtns}>
          {isOwn && (
            <TouchableOpacity hitSlop={10} onPress={() => router.push(`/storybook/edit/${book.id}` as any)}>
              <Ionicons name="create-outline" size={24} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity hitSlop={10} onPress={close}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

        {/* Caption */}
        {it.caption ? (
          <View style={[styles.captionWrap, { bottom: insets.bottom + 28 }]} pointerEvents="none">
            <Text style={styles.caption}>{it.caption}</Text>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.root}>
      {/* Darkening backdrop — dims the profile behind; fades out as you pull the card down. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOpacity }]} />
      {/* The story card — fades/scales in on open, rides the finger DOWN to dismiss. */}
      <Animated.View
        style={[styles.card, { opacity: contentOpacity, transform: contentTransform }]}
        {...panResponder.panHandlers}
      >
        {inner}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  backdrop: { backgroundColor: '#000' },
  card: { flex: 1, backgroundColor: BG, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  veil: { backgroundColor: LOADING_BG },
  emptyText: { color: '#fff', fontSize: 16 },
  emptyBtn: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)' },
  emptyBtnText: { color: '#fff', fontWeight: '600' },
  failBtns: { flexDirection: 'row', gap: 12 },
  zones: { flex: 1, flexDirection: 'row' },
  zoneLeft: { width: SCREEN_W * 0.32, height: '100%' },
  zoneRight: { flex: 1, height: '100%' },
  bars: { position: 'absolute', left: 8, right: 8, flexDirection: 'row', gap: 3 },
  barTrack: { flex: 1, height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  barGap: { marginLeft: 8 },
  barFull: { flex: 1, height: '100%', backgroundColor: '#fff' },
  barFill: { height: '100%', backgroundColor: '#fff' },
  header: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#333' },
  avatarEmpty: { backgroundColor: 'rgba(255,255,255,0.2)' },
  bookTitle: { color: '#fff', fontWeight: '700', fontSize: 15 },
  ownerName: { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  introWrap: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 40 },
  introTitle: { color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: -0.4, lineHeight: 36, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 14 },
  captionWrap: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  caption: { color: '#fff', fontSize: 15, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
});
