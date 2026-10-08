import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, Dimensions,
  Pressable, Animated, PanResponder, ActivityIndicator, Alert, Easing, FlatList, ScrollView,
  TextInput, KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import AppVideo from '../../components/AppVideo';
import { Image as ExpoImage } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { timeAgo } from '../../lib/timeAgo';
import {
  fetchStoriesForUsers, recordStoryView, deleteStory, fetchStoryViewerCount, fetchStoryViewers,
  setStoryLike, fetchStoryLikeEffect, fetchMyStoryLike, setStoryLikeComment, setStoryPinnedComment, fetchStoryAnalytics, REPOST_MAX_SEC, STORY_MUSIC_MAX_SEC,
  type Story, type StoryProfile, type StoryGroup, type SourceRect, type StoryViewer, type StoryAnalytics, type StoryLikeEffect,
} from '../../lib/stories';
import { saveRemoteToLibrary } from '../../lib/saveToLibrary';
import { reportUser } from '../../lib/postActions';
import { showPermissionDenied } from '../../lib/permissions';
import { storyReplyBody } from '../../lib/postLinks';
import { createNotification } from '../../lib/createNotification';
import SongAttribution from '../../components/SongAttribution';
import BadgeEmblem from '../../components/BadgeEmblem';
import StoryThumb from '../../components/StoryThumb';
import RepostStoryFrame from '../../components/RepostStoryFrame';
import RepostPostMedia, { repostCardSize } from '../../components/RepostPostMedia';
import RepostAuthorChip from '../../components/RepostAuthorChip';
import { StoryBackground, type StoryBg } from '../../components/StoryBackgroundLayer';
import { StoryDrawRenderer, type DrawStroke } from '../../components/StoryDrawLayer';
import { aspectToNumber } from '../../lib/aspectRatio';
import { captionStickerTextStyle, resolveSticker, StickerContent } from '../../components/StickerLayer';
import { useStories } from '../../contexts/StoriesContext';
import { useProfile } from '../../contexts/ProfileContext';
import { usePostMusicActions, usePostMusicMuted } from '../../contexts/PostMusicContext';
import { useAudioControls } from '../../contexts/AudioContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { StorySkeleton, Skeleton } from '../../components/Skeleton';
import Spinner from '../../components/Spinner';
import StoryLikeBurst from '../../components/StoryLikeBurst';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// Insights sheet: the swipeable Viewers/Analytics pager. One page spans the sheet's
// inner width; the sliding tab indicator maps the scroll offset to a tab position.
const INSIGHTS_PAGE_W = SCREEN_W - SPACING.md * 2;
const INSIGHTS_TAB_W = INSIGHTS_PAGE_W / 2;
const INSIGHTS_IND_W = 54;
// IG-style insights: a tall sheet whose top is a swipeable strip of the author's
// own stories (one card per page); swiping it reloads the insights below.
const INSIGHTS_SHEET_H = Math.round(SCREEN_H * 0.86);
const INS_CARD_H = Math.round(SCREEN_H * 0.24);
const INS_CARD_W = Math.round(INS_CARD_H * 9 / 16);
const CARD_GAP = SPACING.sm;              // space between story cards in the strip
const INS_SNAP = INS_CARD_W + CARD_GAP;   // carousel snap interval (one card)
const IMAGE_DURATION_MS = 10000;
// A reshared VIDEO plays for at most this long in the story, then advances (ms).
const REPOST_MAX_MS = REPOST_MAX_SEC * 1000;
// Video position updates fire on this cadence; the bar glides to each new position
// over the same interval so it moves continuously instead of stepping.
const VIDEO_PROGRESS_INTERVAL_MS = 250;
// Horizontal swipe past this (or a flick) jumps to the next/previous person.
const SWIPE_DIST = SCREEN_W * 0.25;
// Insights story strip/panel: a short, low threshold — one card is small, so a brief
// swipe or flick should move exactly one story.
const INS_SWIPE = 38;

// Where a thread should OPEN: the first story the viewer has not seen (skipping
// any already watched this session too), or 0 when they're all seen. So tapping a
// ring resumes at the first NEW story instead of replaying ones already watched;
// a fully-seen ring (a deliberate re-watch) still starts at the top.
function firstUnseenIndex(g: StoryGroup | null | undefined, watched?: Set<string>): number {
  if (!g) return 0;
  const i = g.stories.findIndex((s) => !s.seen && !watched?.has(s.id));
  return i >= 0 ? i : 0;
}

export default function StoryViewerScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { refresh: refreshStories, markSeen, openCamera, groups: trayGroups } = useStories();
  const { profile: myProfile } = useProfile();
  const { playSong, stop: stopSong, toggleMuted: toggleSongMuted, prefetchSong, warmSongPlayer, restartSong } = usePostMusicActions();
  const songMuted = usePostMusicMuted();
  // Pre-create the ambient players the moment the viewer opens, so the first
  // story's song never waits on native player construction. The feed usually
  // warmed them already; this also covers a deep link straight into a story.
  useEffect(() => { try { warmSongPlayer(); } catch {} }, [warmSongPlayer]);
  // Watching stories pauses the user's music: a story is sound and motion for
  // fifteen seconds at a time, and it either owns the channel or it is
  // pointless. (A story with an attached song then plays it through the ambient
  // player, same as everywhere else.)
  //
  // PAUSE, never stop. This effect fires on FOCUS, which can land after the
  // story's video is already playing — and a stop() there deactivates the
  // shared audio session and mutes it (see useAudioControls).
  const { pause: pauseMainSong } = useAudioControls();
  useEffect(() => { if (isFocused) pauseMainSong(); }, [isFocused, pauseMainSong]);
  const { userId, users, src, story: storyParam, archived: archivedParam, seed: seedParam } = useLocalSearchParams<{ userId: string; users?: string; src?: string; story?: string; archived?: string; seed?: string }>();
  // The tapped user's group, handed over by openStory when the tray hadn't loaded it yet —
  // lets this screen paint the first story instantly instead of its own grey skeleton.
  const seedGroup = useMemo<StoryGroup | null>(() => {
    try { return seedParam ? (JSON.parse(seedParam) as StoryGroup) : null; } catch { return null; }
  }, [seedParam]);

  // Archived replay (from Settings → Archive): play ONE expired story back like
  // the original, but read-only — the viewer COUNT shows, the per-viewer list
  // does not, and replaying doesn't record a fresh view. The story is seeded in
  // via param because fetchStoriesForUsers only ever returns LIVE stories.
  const archived = archivedParam === '1';
  const seedStory = useMemo<Story | null>(() => {
    try { return storyParam ? (JSON.parse(storyParam) as Story) : null; } catch { return null; }
  }, [storyParam]);

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

  // Seed from the tray the context already loaded, so the viewer PAINTS the story on the
  // first frame instead of showing the grey skeleton while it (re)fetches. The fetch below
  // still runs to refresh; if the context had nothing (e.g. a deep link) we fall back to it.
  const [groups, setGroups] = useState<StoryGroup[]>(() => {
    if (archived) return [];
    const byId = new Map(trayGroups.map((g) => [g.user.id, g]));
    if (seedGroup) byId.set(seedGroup.user.id, seedGroup); // handed over when the tray wasn't ready yet
    return orderedIds.map((id) => byId.get(id)).filter((g): g is StoryGroup => !!g && g.stories.length > 0);
  });
  const [loading, setLoading] = useState(() => groups.length === 0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userIndex, setUserIndex] = useState(() => {
    const i = groups.findIndex((g) => g.user.id === userId);
    return i >= 0 ? i : 0;
  });
  const [storyIndex, setStoryIndex] = useState(() => {
    // Open on the first UNSEEN story of the tapped user (from the seeded tray),
    // not story 0 — so you resume at new content instead of re-watching old ones.
    const i = groups.findIndex((g) => g.user.id === userId);
    return firstUnseenIndex(groups[i >= 0 ? i : 0]);
  });
  // Did we open from seeded tray data? If so the background fetch must not re-position us.
  const didSeedRef = useRef(groups.length > 0);
  const [paused, setPaused] = useState(false);
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  // The CURRENT story's like effect — total count (scales the hearts) + a few likers
  // (avatar + optional public comment, the pics/bubbles that flash by). Drives the fun
  // effect EVERY viewer sees. Privacy-safe (no names/ids): who liked stays owner-only.
  const [likeEffect, setLikeEffect] = useState<StoryLikeEffect>({ count: 0, likers: [] });
  // The current (non-owner) viewer's OWN public like comment on this story, if any —
  // drives the "Add a comment" vs "Edit comment" chip + prefills the composer.
  const [myComment, setMyComment] = useState<string | null>(null);
  // Optional public "like comment" composer (shown after you like; saves to your like).
  const [commenting, setCommenting] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [sendingComment, setSendingComment] = useState(false);
  const [commentFlash, setCommentFlash] = useState(false);
  const commentAnim = useRef(new Animated.Value(0)).current;
  // Own-story viewers sheet (who watched this story; likers ride on top).
  const [showViewers, setShowViewers] = useState(false);
  // Bottom-right "⋯" options menu — a Laybell-styled slide-up (not a system sheet).
  const [showStoryMenu, setShowStoryMenu] = useState(false);
  const storyMenuAnim = useRef(new Animated.Value(0)).current; // 0 = hidden, 1 = up
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  // Insights sheet is two tabs IG-style: the people list ('viewers') and the
  // analytics panel ('analytics'). Analytics is fetched alongside the list.
  const [insightsTab, setInsightsTab] = useState<'viewers' | 'analytics'>('viewers');
  // Which of the author's own stories the insights are currently showing (the card
  // strip swipes this; the viewers/analytics below reload for it).
  const [insightsIdx, setInsightsIdx] = useState(0);
  const [analytics, setAnalytics] = useState<StoryAnalytics | null>(null);
  // Analytics/Viewers switch by TAPPING the header; a horizontal swipe on the panel
  // (or the card strip) moves between the author's own stories instead. These refs let
  // the once-created pan responders reach the latest nav fn + list scroll position.
  const insightsNavRef = useRef<(delta: number) => void>(() => {});
  const listAtTopRef = useRef(true); // viewers list at scroll-top → a pull-down dismisses
  // Per-story insights cache so swiping between your own stories is INSTANT instead of
  // re-spinning each time; the current story also refreshes quietly in the background.
  const insightsCache = useRef<Map<string, { count: number | null; viewers: StoryViewer[]; analytics: StoryAnalytics | null }>>(new Map());
  const insightsReqRef = useRef<string | null>(null); // which story the visible panel is for (race guard)
  // The card strip is a DISPLAY ONLY (scrollEnabled=false), driven programmatically; every
  // navigation goes through goToInsightsStory in ±1 steps from this live index ref, so a swipe
  // can never fling/snap past a story. The ref avoids stale closures in the once-made handlers.
  const insightsIdxRef = useRef(0);
  // The story-card strip at the top of the insights sheet (one card per own story).
  // The strip is a plain translated row (NOT a ScrollView) — this value is its offset
  // (= insightsIdx * INS_SNAP), driving both the row's translateX and each card's depth.
  const insightsStripX = useRef(new Animated.Value(0)).current;
  const addPulse = useRef(new Animated.Value(0)).current;       // gentle breathing for the "Add Story" prompt
  // ONE value drives the entire viewers sheet: its px offset from the open position
  // (0 = fully open, INSIGHTS_SHEET_H = closed/off-screen). The open/close animations AND
  // the finger-drag all write to it, so the sheet, the backdrop, and the story behind it
  // move TOGETHER — dragging down smoothly reverses the whole thing (no choppy handoff).
  const sheetY = useRef(new Animated.Value(INSIGHTS_SHEET_H)).current;
  // Story behind: fully open (sheetY 0) it's slid up + shrunk + faded to nothing; as the
  // sheet eases/drags down (→ INSIGHTS_SHEET_H) it returns to full-screen, in lock-step.
  const viewersRecedeScale = useRef(sheetY.interpolate({ inputRange: [0, INSIGHTS_SHEET_H], outputRange: [0.9, 1], extrapolate: 'clamp' })).current;
  const viewersSlideUp = useRef(sheetY.interpolate({ inputRange: [0, INSIGHTS_SHEET_H], outputRange: [-Math.round(SCREEN_H * 0.09), 0], extrapolate: 'clamp' })).current;
  const viewersFade = useRef(sheetY.interpolate({ inputRange: [0, INSIGHTS_SHEET_H], outputRange: [0, 1], extrapolate: 'clamp' })).current;
  const viewersBackdropOpacity = useRef(sheetY.interpolate({ inputRange: [0, INSIGHTS_SHEET_H], outputRange: [1, 0], extrapolate: 'clamp' })).current;
  const closeViewersRef = useRef<() => void>(() => {});
  // Viewer's like on someone else's story (heart button, bottom-right).
  const [liked, setLiked] = useState(false);
  // Reply composer (sends a DM with this story's stillshot attached).
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  // Drives the composer's entrance/exit (dim fade + bar rise), synced to the
  // keyboard so the whole thing slides up as one piece instead of snapping in.
  const replyAnim = useRef(new Animated.Value(0)).current;
  const [sentFlash, setSentFlash] = useState(false);
  // Camera-roll save: `saving` gates re-taps during the download, `savedFlash`
  // reuses the reply confirmation so a save says so in the same voice.
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  // The story id whose IMAGE has finished decoding and is actually on screen.
  // The story id whose media has actually painted its first frame (image onLoad
  // or video onReady, see AppVideo). A full-screen grey cover stays up until this
  // matches the CURRENT story, so a story change / open shows a clean grey until
  // the image AND all overlays/chrome are ready, then reveals them ATOMICALLY —
  // never text or chrome over a blank/half-loaded frame, and never a stale frame
  // from the previous story bleeding through (the old overlap bug).
  const [readyId, setReadyId] = useState<string | null>(null);
  // Every story whose frame has painted at least once this session. Going BACK to one of
  // these is instant — it's already loaded — so it must never flash the grey placeholder.
  const loadedIdsRef = useRef<Set<string>>(new Set());
  // Per-remount tick to retry a transiently-failing image URL (a just-uploaded
  // public URL can 404 for a beat) instead of revealing a broken frame.
  const [reloadTick, setReloadTick] = useState(0);
  const imgErrorsRef = useRef<Record<string, number>>({});

  const pausedRef = useRef(false);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  // Drives the CURRENT segment's fill (0→1, scaleX from the left).
  const progressAnim = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  // A brief black veil for the "Add Story" hand-off to the camera. The camera is a
  // tab with animationEnabled:false (an instant cut) and the feed behind it is light,
  // so without this the exit flashes white between two black screens. Fading the
  // whole viewer to black first — camera bg is #000 too — bridges it smoothly.
  const exitFade = useRef(new Animated.Value(0)).current;
  // Open/close progress: 0 = at the source rect (or fully off-screen right when
  // there's no rect), 1 = fullscreen. Starts at 0 in BOTH modes — without a
  // rect the entrance is a quick Instagram-style slide-in from the right
  // (notification taps and deep links used to hard-cut in).
  const expand = useRef(new Animated.Value(0)).current;
  const contentFadeIn = useRef(new Animated.Value(srcRect ? 0 : 1)).current; // open fade (media + chrome together)
  // Free-floating text (stickers + a positioned caption) is hidden until the layout
  // has settled (and, when opening from a ring, until the zoom is essentially done),
  // then faded in at its composed positions. Without this the screen-sized translate
  // offsets are briefly applied before/while the container is at the wrong scale, so
  // the text piles up in the middle — the "glitchy jumble" on first view. This runs
  // for EVERY open path (including no-zoom opens, e.g. from a notification) so it's
  // fixed globally, not just when expanding out of a tapped circle.
  const textReveal = useRef(new Animated.Value(0)).current;
  // Own-story viewers count: a small fade + rise that rides in WITH the story (no
  // delay), so it never pops in after the media has already settled.
  const pillIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(pillIn, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [pillIn]);
  // Gentle "throb" for like-comments in the viewers/analytics sheet — they grow and
  // shrink a touch for a fun feel. One shared value drives every comment row in sync.
  const commentThrob = useRef(new Animated.Value(0)).current;
  const commentThrobScale = useRef(commentThrob.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] })).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(commentThrob, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(commentThrob, { toValue: 0, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [commentThrob]);
  // Grey loading cover's opacity: 1 = opaque (still loading), fades to 0 when this
  // story's first frame is ready. Raised only AFTER a short beat (coverTimerRef) so a
  // loaded/cached story shows instantly instead of flashing the placeholder.
  const coverAnim = useRef(new Animated.Value(1)).current;
  const coverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);
  const panningRef = useRef(false);
  const gestureAxisRef = useRef<'h' | 'v' | null>(null);
  const pressInfo = useRef({ t: 0, x: 0, y: 0 });

  const group = groups[userIndex] ?? null;
  const story = group?.stories[storyIndex] ?? null;
  const isOwn = !!currentUserId && group?.user.id === currentUserId;
  // The insights card strip is showing the trailing "+" (add-a-story) card — there
  // are no viewers for it, so the panel shows an "Add Story" prompt instead.
  const onAddStory = !!group && insightsIdx >= group.stories.length;

  // A reshared post the author EDITED (Post-to-story editor) carries its layout in
  // the stickers jsonb: a kind:'post' frame (its transform), an optional kind:'bg'
  // background and kind:'draw' strokes. When present, the viewer composes it live
  // (background + placed post + drawing) instead of the default centred card; a plain
  // reshare (no post layer) still renders through RepostStoryFrame.
  const composed = useMemo(() => {
    const layers = (story?.stickers ?? []) as any[];
    const postLayer = layers.find((l) => l?.kind === 'post');
    if (!story?.shared_post_id || !postLayer) return null;
    const bgLayer = layers.find((l) => l?.kind === 'bg');
    const drawLayer = layers.find((l) => l?.kind === 'draw');
    const aspect = aspectToNumber(story.aspect_ratio, 9 / 16);
    const { cardW, cardH } = repostCardSize(SCREEN_W, SCREEN_H, insets.top, insets.bottom, aspect);
    return {
      post: postLayer as { x: number; y: number; scale: number; rotation: number },
      bg: (bgLayer?.background ?? null) as StoryBg | null,
      strokes: (drawLayer?.strokes ?? null) as DrawStroke[] | null,
      cardW, cardH,
    };
  }, [story?.id, story?.stickers, story?.shared_post_id, story?.aspect_ratio, insets.top, insets.bottom]);

  // A PLAIN story (not a reshared post) can now carry its own background + pen doodle
  // too (authored in the regular story editor). Reshares handle these inside `composed`
  // above, so this only resolves them for non-reshares.
  const plainExtras = useMemo(() => {
    if (story?.shared_post_id) return { bg: null as StoryBg | null, strokes: null as DrawStroke[] | null };
    const layers = (story?.stickers ?? []) as any[];
    return {
      bg: (layers.find((l) => l?.kind === 'bg')?.background ?? null) as StoryBg | null,
      strokes: (layers.find((l) => l?.kind === 'draw')?.strokes ?? null) as DrawStroke[] | null,
    };
  }, [story?.id, story?.stickers, story?.shared_post_id]);

  // Render-derived so a story flip re-raises the grey cover in the SAME commit:
  // "ready" once THIS story's media has painted — OR once it painted earlier this session
  // (going back to it is instant, so it shows with no placeholder).
  if (readyId) loadedIdsRef.current.add(readyId);
  const ready = !!story && (readyId === story.id || loadedIdsRef.current.has(story.id));
  const readyRef = useRef(ready);
  readyRef.current = ready;
  // Loading circle on the grey cover — shown only if the story stays un-ready for
  // a beat, so a fast/cached load doesn't flash a spinner but a real load does.
  const [showLoader, setShowLoader] = useState(false);

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

      if (archived && seedStory) {
        // The owner is always the current user here (own archive), so build the
        // header profile from myProfile; fall back to a minimal one if it hasn't
        // loaded. One group, one story — the full original playback, read-only.
        const mp: any = myProfile;
        const owner: StoryProfile = {
          id: viewerId,
          username: mp?.username ?? '',
          display_name: mp?.display_name ?? '',
          avatar_url: mp?.avatar_url ?? null,
          badge_tier: mp?.badge_tier ?? null,
          badge_show: mp?.badge_show ?? null,
        };
        setGroups([{ user: owner, stories: [seedStory], hasUnseen: false }]);
        setUserIndex(0);
        setStoryIndex(0);
        setLoading(false);
        return;
      }

      const fetched = await fetchStoriesForUsers(orderedIds, viewerId);
      setGroups(fetched);
      // Only (re)position when we did NOT seed — a seeded open is already on the right
      // story, and resetting here would yank the viewer back if they'd started swiping.
      if (!didSeedRef.current) {
        const startIdx = Math.max(0, fetched.findIndex((g) => g.user.id === userId));
        setUserIndex(startIdx);
        setStoryIndex(firstUnseenIndex(fetched[startIdx], viewedRef.current));
      }
      setLoading(false);
    })();
    // On close, refresh global story state so newly-seen rings update everywhere.
    return () => { stopProgressAnim(); refreshStories(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expand out of the tapped rect on open (Instagram shared-element style) —
  // or, with no rect to grow from, slide in from the right like a native push.
  useEffect(() => {
    if (srcRect) {
      Animated.timing(expand, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      // Snappy opacity (shorter than the zoom) so the chrome — reply bar, header actions,
      // viewers count — reaches full strength WITH the media instead of lagging behind the
      // bright image while it's still at half opacity.
      Animated.timing(contentFadeIn, { toValue: 1, duration: 230, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    } else {
      Animated.timing(expand, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
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

  // Reveal the next story INSTANTLY when it's already loaded; only drop the grey
  // placeholder over it if it's still not painted after a short beat (so a cached/fast
  // story never flashes grey, and a slow one shows grey until it loads).
  useLayoutEffect(() => {
    if (coverTimerRef.current) { clearTimeout(coverTimerRef.current); coverTimerRef.current = null; }
    if (ready) {
      // Painted → quick crossfade from the placeholder (a no-op/instant if it never showed).
      Animated.timing(coverAnim, {
        toValue: 0,
        duration: 150,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    } else {
      // Not painted yet. Clear the cover so the story can appear immediately, and only
      // raise the grey placeholder if it's STILL not ready a beat later.
      coverAnim.stopAnimation();
      coverAnim.setValue(0);
      coverTimerRef.current = setTimeout(() => { coverAnim.setValue(1); }, 130);
    }
    return () => { if (coverTimerRef.current) { clearTimeout(coverTimerRef.current); coverTimerRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, story?.id]);

  // ─── drive the active story (timer + view record) ────────────────────────────
  useEffect(() => {
    if (!story) return;
    pausedRef.current = false;
    setPaused(false);
    stopProgressAnim();
    progressAnim.setValue(0);
    // The view-record + "whole thread seen → flip the ring to seen" live in a
    // dedicated effect below that ALSO keys on currentUserId — recording here,
    // where the auth id is still null on a fresh open, skipped the FIRST story's
    // view every time, so a story you'd already watched kept ringing as unseen
    // ("brand new") on the grid.

    setViewerCount(null);
    setShowViewers(false);
    sheetY.setValue(INSIGHTS_SHEET_H);
    setLiked(false);
    setLikeEffect({ count: 0, likers: [] });
    setMyComment(null);
    setCommenting(false);
    setCommentText('');
    // The viewer count, your like state, and the likers are fetched in the
    // dedicated effect below — which ALSO keys on currentUserId, so a reopened
    // (already-liked) story gets its heart/likes back even though the auth id
    // resolves a beat AFTER this story-change effect first runs. (Fetching here,
    // where currentUserId can still be null on a fresh open, was why the heart
    // vanished on leave-and-return.)

    // Warm the neighbor images (next story of this user + first story of the next
    // user) so a flip usually lands on an already-decoded frame. The grey cover
    // still guarantees a clean reveal on the rare uncached advance.
    {
      const { userIndex: ui, storyIndex: si } = posRef.current;
      const g2 = groupsRef.current[ui];
      const warm: (string | undefined)[] = [
        g2?.stories[si + 1]?.media_type === 'image' ? g2?.stories[si + 1]?.media_url : undefined,
        groupsRef.current[ui + 1]?.stories[0]?.media_type === 'image' ? groupsRef.current[ui + 1]?.stories[0]?.media_url : undefined,
      ];
      warm.forEach((u) => { if (u) ExpoImage.prefetch(u).catch(() => {}); });
      // Stage the NEXT songs' bytes too (at their chosen start offset), so flipping
      // onto a story with music plays it immediately instead of after a cold fetch.
      [g2?.stories[si + 1], groupsRef.current[ui + 1]?.stories[0]].forEach((ns) => {
        if (ns?.song_id) { try { prefetchSong(ns.song_id, null, storySongMix(ns)); } catch {} }
      });
    }

    // Safety: never sit on the grey cover forever. If the media hasn't painted
    // after a while (a genuinely dead/deleted URL), reveal anyway so the viewer
    // isn't stuck on grey.
    const revealTimer = setTimeout(() => setReadyId(story.id), 12000);

    // Image countdown starts from the READY effect below (once the image is
    // actually on screen), not here — so a story never counts down / auto-advances
    // while it's still the grey loader. Videos advance from playback status.
    return () => { stopProgressAnim(); clearTimeout(revealTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // Record that the viewer watched THIS story, and flip the author's ring to seen
  // once their whole thread is watched. Keyed on currentUserId on purpose: on a
  // fresh open the auth id resolves AFTER the first story shows, so recording this
  // in the id-only drive effect above skipped the FIRST story's view every time —
  // which is why a story you'd already watched still rang as unseen ("brand new")
  // on the grid. Re-running when the id lands records it; the write is idempotent
  // (composite PK) so a re-run never double-counts. Skipped for an archived replay.
  useEffect(() => {
    if (!story || !currentUserId || archived) return;
    recordStoryView(story.id, currentUserId).catch(() => {});
    viewedRef.current.add(story.id);
    const g = groupsRef.current[posRef.current.userIndex];
    const own = g?.user.id === currentUserId;
    if (g && !own && g.stories.every((s) => s.seen || viewedRef.current.has(s.id))) {
      markSeen(g.user.id, g.stories.map((s) => s.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, currentUserId]);

  // Per-viewer state for THIS story. Split out of the drive effect above and keyed
  // on currentUserId on purpose: on a fresh open (deep link / reopen) the auth id
  // resolves AFTER the first story is shown, so fetching in the id-only effect left
  // an already-liked story reading as unliked (its heart "vanished" on return). Own
  // story → viewer count; otherwise → your own like state (the heart button). The
  // fun hearts effect is shown to EVERYONE, so the like effect is fetched for all
  // viewers (privacy-safe RPC — count + avatar URLs only, never names/ids/a list).
  useEffect(() => {
    if (!story || !currentUserId) return;
    let alive = true;
    const sid = story.id;
    const own = group?.user.id === currentUserId;
    if (own) {
      fetchStoryViewerCount(sid).then((c) => { if (alive) setViewerCount(c); }).catch(() => {});
    } else {
      fetchMyStoryLike(sid, currentUserId).then((r) => {
        if (!alive) return;
        setLiked(r.liked);
        setMyComment(r.comment);
      }).catch(() => {});
    }
    fetchStoryLikeEffect(sid).then((e) => { if (alive) setLikeEffect(e); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, currentUserId, group?.user.id, archived]);

  // Start the image countdown the moment the image is actually shown (ready), so
  // the visible duration is the full IMAGE_DURATION regardless of load time.
  useEffect(() => {
    if (ready && story?.media_type === 'image' && isFocused && !pausedRef.current) {
      startImageProgress(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, story?.id]);

  // Delay the grey-cover loading circle so a quick/cached load doesn't flash it.
  useEffect(() => {
    setShowLoader(false);
    if (ready) return;
    const t = setTimeout(() => setShowLoader(true), 280);
    return () => clearTimeout(t);
  }, [ready, story?.id]);

  // Warm the NEXT story's frame while this one plays, so swiping forward is ready too
  // (the tap-to-open prefetch only covers the first story). Image URL, or a video poster.
  useEffect(() => {
    const next = group?.stories?.[storyIndex + 1];
    if (!next) return;
    const url = next.media_type === 'image' ? next.media_url : next.thumbnail_url;
    if (url) ExpoImage.prefetch(url, 'memory-disk').catch(() => {});
  }, [group, storyIndex]);

  // Freeze progress while the viewer is covered (e.g. you tapped through to a
  // profile) and resume from where it left off on return.
  useEffect(() => {
    if (!isFocused) {
      stopProgressAnim();
    } else if (!loading && story && !pausedRef.current && story.media_type === 'image' && readyRef.current) {
      progressAnim.stopAnimation((v: number) => startImageProgress(typeof v === 'number' ? v : 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  // An image story shows for IMAGE_DURATION_MS, UNLESS its poster chose a music
  // clip length — then it stays up exactly that long (5–25s) so the chosen part of
  // the song plays out before the story advances. A video keeps its own timing.
  const imageDurationMs = useMemo(() => {
    const clip = Number(story?.song_clip_sec);
    if (story?.song_id && Number.isFinite(clip) && clip > 0) {
      return Math.round(Math.min(STORY_MUSIC_MAX_SEC, Math.max(5, clip)) * 1000);
    }
    return IMAGE_DURATION_MS;
  }, [story?.song_id, story?.song_clip_sec]);
  const imageDurationMsRef = useRef(imageDurationMs);
  imageDurationMsRef.current = imageDurationMs;

  // The song starts at the poster's chosen offset every time the story plays or
  // replays (reusing the ambient-mix path: a story has no video clock, so the player
  // lines the song up to exactly startSec via getPlaybackPosition → 0). Each story
  // change stops the old song and plays the new one with startOver, so a replay
  // always restarts at the chosen start.
  //
  // NOTE: no `clipSec` here on purpose. In the viewer the chosen length is enforced
  // by the IMAGE duration (the story advances at clipSec), not by looping the audio.
  // That means a HELD story — pause() freezes the progress bar but keeps the song
  // playing — lets the song run naturally PAST start+clip while the viewer listens,
  // instead of snapping back to the start mid-listen. The window-loop still runs in
  // the editor preview, which DOES pass clipSec.
  function storySongMix(s: Story | null | undefined) {
    const start = Math.max(0, Number(s?.song_start_sec) || 0);
    return start > 0 ? { startSec: start, volume: 1, videoStartSec: 0 } : null;
  }

  // Auto-play the song attached to the current story; stop on change/blur/close.
  useEffect(() => {
    const sid = story?.song_id;
    const hostId = story?.id;
    if (isFocused && hostId && sid) playSong(hostId, sid, null, storySongMix(story));
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
      duration: Math.max(0, imageDurationMsRef.current * (1 - from)),
      easing: Easing.linear,
      // progressAnim drives a scaleX transform — native-driven, so the bar
      // keeps gliding even while the story media is decoding on the JS thread.
      useNativeDriver: true,
    });
    animRef.current = anim;
    anim.start(({ finished }) => { if (finished) { animRef.current = null; goNext(); } });
  }
  // Glide the fill to `toValue` over `duration` — used by video (continuous bar).
  function animateProgressTo(toValue: number, duration: number) {
    stopProgressAnim();
    const anim = Animated.timing(progressAnim, {
      toValue, duration, easing: Easing.linear, useNativeDriver: true,
    });
    animRef.current = anim;
    anim.start();
  }

  // Stop the run and zero the value, so the segment the next story mounts into
  // starts empty rather than inheriting the last one's fill. Safe to do before
  // the index moves now that only the CURRENT segment is animated — a passed bar
  // is a plain View and no longer listens to this at all.
  function resetProgress() {
    stopProgressAnim();
    progressAnim.setValue(0);
  }

  // Belt and braces for the paths that change the story WITHOUT going through
  // resetProgress — a group reshaping under a delete, or the initial mount.
  useLayoutEffect(() => {
    progressAnim.setValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  // ─── advance / back (tap + auto-advance, story-by-story) ─────────────────────
  function goNext() {
    const { userIndex: ui, storyIndex: si } = posRef.current;
    const g = groupsRef.current[ui];
    if (!g) return;
    if (si < g.stories.length - 1) { resetProgress(); setStoryIndex(si + 1); return; }
    if (ui < groupsRef.current.length - 1) { resetProgress(); setUserIndex(ui + 1); setStoryIndex(firstUnseenIndex(groupsRef.current[ui + 1], viewedRef.current)); return; }
    dismiss();
  }

  function goPrev() {
    const { userIndex: ui, storyIndex: si } = posRef.current;
    if (si > 0) { resetProgress(); setStoryIndex(si - 1); return; }
    if (ui > 0) {
      const prevG = groupsRef.current[ui - 1];
      resetProgress();
      setUserIndex(ui - 1);
      setStoryIndex(Math.max(0, (prevG?.stories.length ?? 1) - 1));
      return;
    }
    // already at the very first story — restart it from the top (and unpause).
    pausedRef.current = false;
    setPaused(false);
    resetProgress();
    if (story?.media_type === 'image' && readyRef.current) startImageProgress(0);
    // Same story id, so the autoplay effect won't re-fire — snap its song back to
    // the chosen start explicitly (a left-tap replay, not a pause).
    if (story?.song_id) restartSong(story.id);
  }

  // ─── horizontal swipe = jump to the next / previous PERSON ───────────────────
  function goNextUser() {
    const { userIndex: ui } = posRef.current;
    if (ui < groupsRef.current.length - 1) { resetProgress(); setUserIndex(ui + 1); setStoryIndex(firstUnseenIndex(groupsRef.current[ui + 1], viewedRef.current)); }
    else dismiss();
  }
  function goPrevUser() {
    const { userIndex: ui } = posRef.current;
    if (ui > 0) { resetProgress(); setUserIndex(ui - 1); setStoryIndex(0); }
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
      // Mirror of the slide-in entrance: slide back out to the right, then pop.
      Animated.timing(expand, { toValue: 0, duration: 240, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(() => router.back());
    }
  }, [srcRect, router, expand, panY]);

  // Swipe-down dismiss: carry the card the rest of the way DOWN and fade it (and the
  // backdrop) out together, then pop — one continuous motion, instead of snapping panY
  // back to 0 while shrinking into the ring (which looked jittery).
  // Swipe-down release → one smooth, deliberate close: the story eases back into the ring
  // it opened from. `expand` and `panY` run with the SAME duration + easing so the card
  // travels a single continuous arc from wherever the drag left it into the ring — no snap,
  // no two-speed jitter. (No ring to return to → it simply glides the rest of the way down.)
  const dismissDown = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    stopProgressAnim();
    if (srcRect) {
      Animated.parallel([
        Animated.timing(expand, { toValue: 0, duration: 360, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
        Animated.timing(panY, { toValue: 0, duration: 360, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      ]).start(() => router.back());
    } else {
      Animated.timing(panY, { toValue: SCREEN_H, duration: 320, easing: Easing.inOut(Easing.cubic), useNativeDriver: true })
        .start(() => router.back());
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
    if (story?.media_type === 'image' && readyRef.current) {
      progressAnim.stopAnimation((v: number) => startImageProgress(typeof v === 'number' ? v : 0));
    }
  }

  function onPressIn(e: any) {
    pressInfo.current = { t: Date.now(), x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
    pause();
  }
  function onPressOut(e: any) {
    if (panningRef.current) return; // a drag the pan responder already handled
    const { t, x, y } = pressInfo.current;
    const nx = e?.nativeEvent?.locationX ?? x;
    const ny = e?.nativeEvent?.locationY ?? y;
    // A finger that traveled — especially downward — is a SWIPE (e.g. a quick swipe-down to
    // dismiss that didn't cross the pan threshold), never a tap. So don't advance the story.
    if (Math.abs(ny - y) > 14 || Math.abs(nx - x) > 14) { resume(); return; }
    const dt = Date.now() - t;
    if (dt < 250) {
      if (x < SCREEN_W * 0.33) goPrev();
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
      // Only a deliberate pull-down closes (no flick/velocity shortcut) so it never feels
      // twitchy; then it eases smoothly into the ring.
      if (g.dy > 140) { dismissDown(); return; }
      // Didn't cross the threshold → ease the card gently back into place.
      Animated.spring(panY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 12 }).start();
      resume();
    } else {
      resume();
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        (Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy)) ||
        (g.dy > 8 && g.dy > Math.abs(g.dx) * 1.2),
      onPanResponderGrant: () => gh.grant(),
      onPanResponderMove: (_, g) => gh.move(g),
      onPanResponderRelease: (_, g) => gh.release(g),
      onPanResponderTerminate: (_, g) => gh.release(g),
    }),
  ).current;

  async function onDelete() {
    if (!story) return;
    Alert.alert(t('story.deleteTitle'), t('story.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel', onPress: resume },
      {
        text: t('common.delete'), style: 'destructive',
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

  // Fetch (count, viewers, analytics) for one story and cache the result.
  function fetchInsights(s: Story) {
    return Promise.all([
      fetchStoryViewerCount(s.id).catch(() => null),
      fetchStoryViewers(s.id).catch(() => [] as StoryViewer[]),
      fetchStoryAnalytics(s.id, s.user_id).catch(() => null),
    ]).then(([count, viewers, analytics]) => {
      const data = { count, viewers, analytics };
      insightsCache.current.set(s.id, data);
      return data;
    });
  }

  // Show the viewers list, analytics and count for ONE story — used on open and whenever
  // the strip/panel swipes to another of the author's stories. A cached story shows
  // INSTANTLY (no spinner) and refreshes quietly; only a never-seen story spins.
  function loadInsightsFor(s: Story) {
    insightsReqRef.current = s.id;
    const cached = insightsCache.current.get(s.id);
    if (cached) {
      setViewerCount(cached.count); setViewers(cached.viewers); setAnalytics(cached.analytics); setViewersLoading(false);
    } else {
      setViewerCount(null); setViewers([]); setAnalytics(null); setViewersLoading(true);
    }
    fetchInsights(s).then((data) => {
      if (insightsReqRef.current !== s.id) return; // a newer story was selected mid-flight
      setViewerCount(data.count); setViewers(data.viewers); setAnalytics(data.analytics); setViewersLoading(false);
    });
  }

  // Warm the cache for the author's OTHER stories so swiping the strip never spins.
  function prefetchInsights(stories: Story[]) {
    stories.forEach((s) => { if (!insightsCache.current.has(s.id)) fetchInsights(s).catch(() => {}); });
  }

  // Own-story insights sheet: pause the story AND its music while it's open, slide
  // the sheet up IG-style, resume both on close. The top is a swipeable strip of
  // the author's own stories; the panel below reloads for whichever is shown.
  function openViewers() {
    if (!story) return;
    pause();
    if (story.song_id) stopSong(story.id);
    setInsightsTab('viewers');
    listAtTopRef.current = true;              // list opens scrolled to the top (pull-down dismisses)
    insightsStripX.setValue(storyIndex * INS_SNAP); // current card starts centered + full-size
    insightsIdxRef.current = storyIndex;
    setInsightsIdx(storyIndex);
    setShowViewers(true);
    sheetY.setValue(INSIGHTS_SHEET_H);
    Animated.timing(sheetY, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    loadInsightsFor(story);
    if (group) prefetchInsights(group.stories.filter((s) => s.id !== story.id));
  }

  // Add a story from the insights sheet. Drop the whole viewer back to the tabs FIRST so
  // the camera doesn't pile on top of it (that was the "two extra layers"), then open the
  // story camera — same idiom the notifications/saved deep-links use.
  function addStoryFromInsights() {
    if (closingRef.current) return;
    closingRef.current = true;
    stopProgressAnim();
    // Fade the whole viewer to black, THEN drop back to the tabs and open the camera.
    // The hand-off (modal dismiss → instant camera-tab cut) happens under full black,
    // so the light feed never flashes between the two black screens.
    Animated.timing(exitFade, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true })
      .start(() => {
        setShowViewers(false);
        try { router.dismissAll?.(); } catch {}
        openCamera();
      });
  }

  // Tap the header to switch panels (Analytics icon = 0, Viewers title = 1). Swiping
  // left/right is reserved for moving between stories (see goToInsightsStory).
  function goInsightsTab(i: number) {
    listAtTopRef.current = true; // the freshly shown panel starts scrolled to the top
    setInsightsTab(i === 0 ? 'analytics' : 'viewers');
  }
  // Move the insights to another of the author's own stories, keeping the card strip
  // and the panel below in lock-step: driving the strip animates the card depth, and
  // the panel reloads for the landed story. index === stories.length ⇒ the "+" add card.
  function goToInsightsStory(i: number) {
    if (!group) return;
    const clamped = Math.max(0, Math.min(i, group.stories.length));
    if (clamped === insightsIdxRef.current) return;
    listAtTopRef.current = true;                    // new story → its viewers list starts at the top
    insightsIdxRef.current = clamped;               // update the live ref FIRST so rapid swipes compound correctly
    setInsightsIdx(clamped);
    // Slide the strip + its card-depth to the landed card. Pure Animated value (no
    // ScrollView), so this can ONLY ever move one card per swipe — no momentum, no skip.
    Animated.timing(insightsStripX, { toValue: clamped * INS_SNAP, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const s = group.stories[clamped];
    if (s) loadInsightsFor(s);
  }
  // delta is +1 (next) / −1 (previous); always one step from wherever we actually are.
  insightsNavRef.current = (delta: number) => goToInsightsStory(insightsIdxRef.current + Math.sign(delta));
  // Depth for the card at index `i`: full size/opacity when centred, smaller + faded
  // (pushed into the background) as it moves off-centre. Native-driven by the scroll.
  function cardDepth(i: number) {
    const inputRange = [(i - 1) * INS_SNAP, i * INS_SNAP, (i + 1) * INS_SNAP];
    return {
      opacity: insightsStripX.interpolate({ inputRange, outputRange: [0.4, 1, 0.4], extrapolate: 'clamp' }),
      transform: [{ scale: insightsStripX.interpolate({ inputRange, outputRange: [0.82, 1, 0.82], extrapolate: 'clamp' }) }],
    };
  }
  // Gentle breathing for the "Add Story" prompt — runs continuously (cheap, native).
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(addPulse, { toValue: 1, duration: 850, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(addPulse, { toValue: 0, duration: 850, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function closeViewers(navigatingAway = false) {
    // Spring (critically damped) from wherever the drag left it, so a swipe-down flows
    // straight into the close instead of snapping, and the story eases back in with it.
    Animated.spring(sheetY, { toValue: INSIGHTS_SHEET_H, useNativeDriver: true, bounciness: 0, speed: 15 })
      .start(() => { setShowViewers(false); sheetY.setValue(INSIGHTS_SHEET_H); });
    if (!navigatingAway) {
      resume();
      if (story?.song_id && isFocused) playSong(story.id, story.song_id, null, storySongMix(story));
    }
  }

  closeViewersRef.current = () => closeViewers();

  // The black "stage" (handle + story strip) owns its gestures, since the strip no longer
  // scrolls itself: swipe left/right to move ONE story, or pull DOWN to dismiss.
  const stagePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        const horiz = Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2;
        const down = g.dy > 8 && g.dy > Math.abs(g.dx) * 1.3;
        return horiz || down;
      },
      onPanResponderMove: (_e, g) => { if (Math.abs(g.dy) > Math.abs(g.dx) && g.dy > 0) sheetY.setValue(Math.min(g.dy, INSIGHTS_SHEET_H)); },
      onPanResponderRelease: (_e, g) => {
        if (Math.abs(g.dx) >= Math.abs(g.dy)) {
          if (g.dx <= -INS_SWIPE || g.vx < -0.25) insightsNavRef.current(1);
          else if (g.dx >= INS_SWIPE || g.vx > 0.25) insightsNavRef.current(-1);
        } else if (g.dy > 90 || g.vy > 0.5) {
          closeViewersRef.current();
        } else {
          Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 16 }).start();
        }
      },
      onPanResponderTerminate: () =>
        Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 16 }).start(),
    }),
  ).current;

  // The insights PANEL: swipe left/right to move between stories (lock-step with the
  // strip), or pull DOWN from the top of the list to dismiss. Capture so a decisive
  // horizontal / vertical-down gesture beats the viewers list's own vertical scroll;
  // anything else falls through so the list scrolls normally.
  const panePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        const horiz = Math.abs(g.dx) > 16 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4;
        const pullDown = g.dy > 14 && g.dy > Math.abs(g.dx) * 1.4 && listAtTopRef.current;
        return horiz || pullDown;
      },
      onPanResponderMove: (_e, g) => {
        if (Math.abs(g.dy) > Math.abs(g.dx) && g.dy > 0) sheetY.setValue(Math.min(g.dy, INSIGHTS_SHEET_H));
      },
      onPanResponderRelease: (_e, g) => {
        if (Math.abs(g.dx) >= Math.abs(g.dy)) {
          if (g.dx <= -INS_SWIPE || g.vx < -0.25) insightsNavRef.current(1);
          else if (g.dx >= INS_SWIPE || g.vx > 0.25) insightsNavRef.current(-1);
        } else if (g.dy > 90 || g.vy > 0.5) {
          closeViewersRef.current();
        } else {
          Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 16 }).start();
        }
      },
      onPanResponderTerminate: () =>
        Animated.spring(sheetY, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 16 }).start(),
    }),
  ).current;

  // Like someone else's story (optimistic; heart bottom-right).
  function toggleStoryLike() {
    if (!story || !currentUserId || isOwn) return;
    const next = !liked;
    setLiked(next);
    const myAvatar = (myProfile as any)?.avatar_url ?? null;
    const myUsername = (myProfile as any)?.username ?? null;
    if (next) {
      // Optimistic: your like strengthens the effect + drops your pic (with your
      // username and existing comment, if any) into the mix right away.
      setLikeEffect((prev) => ({
        count: prev.count + 1,
        likers: [{ id: currentUserId, avatar: myAvatar, username: myUsername, comment: myComment }, ...prev.likers].slice(0, 6),
      }));
    } else {
      setMyComment(null); // unliking removes your like row entirely (comment included)
    }
    setStoryLike(story.id, currentUserId, next);
    // Reconcile with the server (true count + ordering, others' likes, your removal).
    fetchStoryLikeEffect(story.id).then(setLikeEffect).catch(() => {});
  }

  // Open a liker's profile from the effect (tapping their frozen pic). Mirrors the
  // header-author tap: stop the fill + push. The viewer's blur/focus effect freezes
  // the story while you're away and resumes it when you come back.
  function openLikerProfile(id: string) {
    if (!id) return;
    stopProgressAnim();
    router.push(`/profile/${id}`);
  }

  // Owner pins / unpins ONE liker's comment on the story whose viewers are shown (the
  // insights strip's current story). The pinned comment then leads the effect with a
  // gold pin. Optimistic in the sheet + the per-story cache; if it's the story playing
  // behind, refresh its live effect so the pin shows immediately.
  function togglePinComment(v: StoryViewer) {
    const s = group?.stories[insightsIdx];
    if (!s || !v.id) return;
    const nextPinnedId = v.pinned ? null : v.id;
    setStoryPinnedComment(s.id, nextPinnedId);
    const mark = (list: StoryViewer[]) => list.map((x) => ({ ...x, pinned: nextPinnedId != null && x.id === nextPinnedId }));
    setViewers(mark);
    const cached = insightsCache.current.get(s.id);
    if (cached) insightsCache.current.set(s.id, { ...cached, viewers: mark(cached.viewers) });
    if (s.id === story?.id) fetchStoryLikeEffect(s.id).then(setLikeEffect).catch(() => {});
  }

  // ─── Optional public "like comment" (offered after you like a story) ─────────
  function openComment() {
    if (!story || isOwn) return;
    pause();
    setCommentText(myComment ?? '');
    setCommenting(true);
    commentAnim.setValue(0);
    Animated.timing(commentAnim, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }
  function closeComment() {
    Keyboard.dismiss();
    Animated.timing(commentAnim, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => { setCommenting(false); resume(); });
  }
  async function sendComment() {
    if (!story || !currentUserId || isOwn || sendingComment) return;
    const text = commentText.trim();
    setSendingComment(true);
    try {
      await setStoryLikeComment(story.id, currentUserId, text);
      setMyComment(text || null);
      Keyboard.dismiss();
      Animated.timing(commentAnim, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(() => { setCommenting(false); resume(); });
      if (text) { setCommentFlash(true); setTimeout(() => setCommentFlash(false), 1500); }
      // Reflect it in the public effect right away (its bubble will cycle in).
      fetchStoryLikeEffect(story.id).then(setLikeEffect).catch(() => {});
    } catch (e: any) {
      Alert.alert(t('story.sendFailedTitle'), e?.message ?? t('story.tryAgain'));
    } finally {
      setSendingComment(false);
    }
  }

  // ─── Story replies (DM with the story's stillshot attached) ────────────────
  function openReply() {
    if (!story || isOwn) return;
    pause();
    setReplying(true);
    replyAnim.setValue(0);
    Animated.timing(replyAnim, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }
  function closeReply() {
    Keyboard.dismiss();
    Animated.timing(replyAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => { setReplying(false); resume(); });
  }
  async function sendReply() {
    if (!story || !group || !currentUserId || !replyText.trim() || sendingReply) return;
    // Hidden accounts browse/listen only — story replies are DMs.
    if ((myProfile as any)?.hidden) {
      Alert.alert(t('messages.hiddenTitle'), t('messages.hiddenBody'));
      return;
    }
    setSendingReply(true);
    try {
      // The stillshot: the image itself, or the video's thumbnail. Embedded in
      // the message so the chat keeps the snapshot after the story expires.
      const thumb = story.media_type === 'video' ? story.thumbnail_url ?? null : story.media_url;
      const body = storyReplyBody({ storyId: story.id, ownerId: group.user.id, thumb }, replyText.trim());
      const { error } = await supabase.from('messages')
        .insert({ sender_id: currentUserId, receiver_id: group.user.id, body });
      if (error) throw error;
      createNotification({ userId: group.user.id, actorId: currentUserId, type: 'message' });
      setReplyText('');
      Keyboard.dismiss();
      Animated.timing(replyAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true })
        .start(() => setReplying(false));
      setSentFlash(true);
      setTimeout(() => setSentFlash(false), 1500);
      resume();
    } catch (e: any) {
      Alert.alert(t('story.sendFailedTitle'), e?.message ?? t('story.tryAgain'));
    } finally {
      setSendingReply(false);
    }
  }

  // Report another user's story — pause while the dialog is up, resume after.
  function onReport() {
    if (!group || isOwn) return;
    pause();
    reportUser(group.user.id, resume);
  }

  // Save the story you are looking at to the camera roll.
  //
  // Paused for the duration: a story is on a timer, and a download that outlasts
  // it would otherwise advance to the next one and leave you unsure which story
  // you actually saved. A video story is the whole file, so this is not instant
  // on a phone network.
  async function onSaveStory() {
    // isOwn is checked HERE as well as on the button. Hiding a control is a UI
    // decision; refusing the action is the policy, and the policy should not
    // depend on someone remembering why the button was conditional.
    if (!story || !isOwn || saving) return;
    setSaving(true);
    pause();
    const res = await saveRemoteToLibrary(story.media_url, story.media_type);
    setSaving(false);
    resume();
    if (res.ok) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      return;
    }
    if (res.reason === 'permission') { showPermissionDenied('photos', t); return; }
    Alert.alert(t('storyCamera.saveFailTitle'), t('storyCamera.saveFailBody'));
  }

  // Bottom-right "⋯" menu — all of the story's secondary actions, moved off the top bar
  // (now just the X). Own story → save / delete; someone else's → report; plus a song
  // mute toggle when there's an attached track. Pause while it's open so the story
  // doesn't advance behind the sheet.
  //
  // Save stays OWN-ONLY on purpose: the media is in a public bucket so this adds no new
  // capability, but a one-tap save of someone else's disappearing story — often an
  // unreleased snippet, sometimes a minor's — is a different norm, and exactly the kind of
  // download-others'-media feature both app stores scrutinise. Archived own stories keep
  // save (that's when saving your own work matters most) but drop delete (managed from
  // the Archive screen).
  function onStoryMenu() {
    if (!story) return;
    pause();
    setShowStoryMenu(true);
    storyMenuAnim.setValue(0);
    Animated.timing(storyMenuAnim, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }
  // resumeStory=false when the picked action manages its own pause/resume (save/delete/
  // report); true for a tap that just closes (mute/cancel/backdrop).
  function closeStoryMenu(resumeStory: boolean) {
    Animated.timing(storyMenuAnim, { toValue: 0, duration: 170, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => setShowStoryMenu(false));
    if (resumeStory) resume();
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
    // Swipe-down feedback: a gentle, understated shrink as the card is pulled (not a
    // reactive one) — the real shrink-into-the-ring happens on release. Native-driven off panY.
    const dragScale = panY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [1, 0.93], extrapolate: 'clamp' });
    if (!srcRect) {
      // No source rect → the push-style slide: content rides `expand` in from
      // the right edge (and back out on dismiss); the backdrop dims with it so
      // the screen underneath darkens like a native push. Content stays fully
      // opaque — the slide is the whole story, no fade.
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
        style={[
          styles.container,
          showViewers && styles.containerReceded,
          // Only tie the story's opacity/transform to the sheet WHILE it's open. Once the
          // sheet is closed the story is always fully itself again — so a stuck sheet value
          // can never leave the screen blacked out (the regression this fixes).
          showViewers
            ? {
                opacity: Animated.multiply(contentOpacity as any, viewersFade),
                transform: [...(contentTransform as any[]), { translateY: viewersSlideUp }, { scale: viewersRecedeScale }],
              }
            : { opacity: contentOpacity as any, transform: contentTransform as any },
        ]}
        {...panResponder.panHandlers}
      >
        {loading ? (
          <View style={StyleSheet.absoluteFill}>
            <StorySkeleton />
            {/* Bottom reply/eye-count pill placeholder, mirroring the post-load controls. */}
            <View style={{ position: 'absolute', left: SPACING.lg, right: SPACING.lg, bottom: insets.bottom + SPACING.lg }}>
              <Skeleton width="100%" height={44} radius={22} />
            </View>
          </View>
        ) : !group || !story ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <Text style={styles.empty}>{t('story.empty')}</Text>
            <TouchableOpacity onPress={dismiss} style={styles.emptyBtn}><Text style={styles.emptyBtnText}>{t('story.close')}</Text></TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Media — full-bleed cover-fit to match the composer (which authors at
                cover), so a clip never plays back letterboxed/"smaller" than it was
                framed. The grey cover below hides it until its first frame paints. */}
            {/* Default media (NOT a reshared post) — full-bleed. */}
            {!story.shared_post_id && (story.media_type === 'image' ? (
              (() => {
                const onImgLoad = () => setReadyId(story.id);
                // A freshly-posted URL can 404 for a beat — retry a few times
                // (remount refetches) before giving up and revealing anyway.
                const onImgErr = () => {
                  const n = (imgErrorsRef.current[story.id] ?? 0) + 1;
                  imgErrorsRef.current[story.id] = n;
                  if (n <= 3) setTimeout(() => setReloadTick((t) => t + 1), 500 * n);
                  else setReadyId(story.id);
                };
                // A 'frame' layer means the author repositioned/zoomed the photo:
                // redraw it with that transform over a blurred backdrop, so a
                // zoomed-OUT photo shows the backdrop around it. x/y are fractions of
                // the frame; scale is relative to a cover fit; w/h are source px —
                // cover is recomputed for THIS screen, so framing is portable.
                const fr = (story.stickers ?? []).find((l: any) => l?.kind === 'frame') as any;
                if (fr && fr.w > 0 && fr.h > 0) {
                  const cs = Math.max(SCREEN_W / fr.w, SCREEN_H / fr.h);
                  const bw = fr.w * cs, bh = fr.h * cs;
                  return (
                    <View style={StyleSheet.absoluteFill}>
                      {plainExtras.bg && plainExtras.bg.type !== 'blur' ? (
                        <StoryBackground bg={plainExtras.bg} />
                      ) : (
                        <ExpoImage source={{ uri: story.media_url }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" />
                      )}
                      <ExpoImage
                        key={`${story.id}:${reloadTick}`}
                        source={{ uri: story.media_url }}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        style={{
                          position: 'absolute', width: bw, height: bh,
                          left: (SCREEN_W - bw) / 2, top: (SCREEN_H - bh) / 2,
                          transform: [
                            { translateX: (fr.x ?? 0) * SCREEN_W },
                            { translateY: (fr.y ?? 0) * SCREEN_H },
                            { scale: fr.scale ?? 1 },
                            { rotate: `${fr.rotation ?? 0}deg` },
                          ],
                        }}
                        onLoad={onImgLoad}
                        onError={onImgErr}
                      />
                    </View>
                  );
                }
                return (
                  <ExpoImage
                    key={`${story.id}:${reloadTick}`}
                    source={{ uri: story.media_url }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    onLoad={onImgLoad}
                    onError={onImgErr}
                  />
                );
              })()
            ) : (
              <AppVideo
                key={story.id}
                source={{ uri: story.media_url }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                active={!paused}
                showStallIndicator
                // Its own sound, or its attached song — never silenced by the
                // music player, which this screen stops on the way in.
                ownsAudio
                muted={!!story.song_id}
                poster={story.thumbnail_url}
                posterContentFit="cover"
                progressIntervalMs={VIDEO_PROGRESS_INTERVAL_MS}
                onReady={() => setReadyId(story.id)}
                onProgress={(pos, dur) => {
                  if (dur && !pausedRef.current) {
                    animateProgressTo(Math.min(1, pos / dur), VIDEO_PROGRESS_INTERVAL_MS);
                  }
                }}
                onEnd={goNext}
              />
            ))}

            {/* Tap surface (advance / pause) */}
            <Pressable style={StyleSheet.absoluteFill} onPressIn={onPressIn} onPressOut={onPressOut} />

            {/* Reshared post (Instagram-style): the post in a card at its OWN aspect
                over a blurred backdrop — a video PLAYS (≤20s, with audio), an image
                shows — plus an author chip that opens the original. Layered above the
                tap surface but pointer-transparent except the chip, so taps on the
                media still advance/pause. */}
            {story.shared_post_id ? (
              composed ? (
                // EDITED repost — background + the post placed/resized on it, drawn
                // above the tap surface but pointer-transparent (except the chip) so
                // taps still advance/pause; drawing + text render further up.
                <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                  <StoryBackground bg={composed.bg} backdropUri={story.thumbnail_url ?? (story.media_type === 'image' ? story.media_url : null)} />
                  <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="box-none">
                    <View
                      pointerEvents="box-none"
                      style={{
                        width: composed.cardW, height: composed.cardH,
                        borderRadius: RADIUS.xl, overflow: 'hidden', backgroundColor: '#000',
                        borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
                        transform: [
                          { translateX: (composed.post.x - 0.5) * SCREEN_W },
                          { translateY: (composed.post.y - 0.5) * SCREEN_H },
                          { scale: composed.post.scale ?? 1 },
                          { rotate: `${composed.post.rotation ?? 0}deg` },
                        ],
                      }}
                    >
                      <View style={StyleSheet.absoluteFill} pointerEvents="none">
                        <RepostPostMedia
                          post={{ type: story.media_type, media_url: story.media_url, thumbnail_url: story.thumbnail_url }}
                          active={!paused}
                          reloadKey={`${story.id}:${reloadTick}`}
                          progressIntervalMs={VIDEO_PROGRESS_INTERVAL_MS}
                          onReady={() => setReadyId(story.id)}
                          onProgressFrac={(frac) => { if (!pausedRef.current) animateProgressTo(frac, VIDEO_PROGRESS_INTERVAL_MS); }}
                          onReachedCap={() => { if (!pausedRef.current) goNext(); }}
                          onEnd={goNext}
                          onImageError={() => {
                            const n = (imgErrorsRef.current[story.id] ?? 0) + 1;
                            imgErrorsRef.current[story.id] = n;
                            if (n <= 3) setTimeout(() => setReloadTick((t) => t + 1), 500 * n);
                            else setReadyId(story.id);
                          }}
                        />
                      </View>
                      <RepostAuthorChip postId={story.shared_post_id} onPress={() => router.push(`/post/${story.shared_post_id}` as any)} />
                    </View>
                  </View>
                </View>
              ) : (
                <RepostStoryFrame
                  postId={story.shared_post_id}
                  aspectRatio={story.aspect_ratio}
                  onOpenPost={() => router.push(`/post/${story.shared_post_id}` as any)}
                >
                  {story.media_type === 'video' ? (
                    <AppVideo
                      key={story.id}
                      source={{ uri: story.media_url }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      active={!paused}
                      ownsAudio
                      showStallIndicator
                      poster={story.thumbnail_url}
                      posterContentFit="cover"
                      progressIntervalMs={VIDEO_PROGRESS_INTERVAL_MS}
                      onReady={() => setReadyId(story.id)}
                      onProgress={(pos, dur) => {
                        if (pausedRef.current) return;
                        const cap = Math.min(dur || REPOST_MAX_MS, REPOST_MAX_MS); // cap the bar at 20s
                        animateProgressTo(Math.min(1, pos / (cap || 1)), VIDEO_PROGRESS_INTERVAL_MS);
                        if (pos >= REPOST_MAX_MS) goNext(); // advance at the 20s cap
                      }}
                      onEnd={goNext}
                    />
                  ) : (
                    <ExpoImage
                      key={`${story.id}:${reloadTick}`}
                      source={{ uri: story.media_url }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      onLoad={() => setReadyId(story.id)}
                      onError={() => {
                        const n = (imgErrorsRef.current[story.id] ?? 0) + 1;
                        imgErrorsRef.current[story.id] = n;
                        if (n <= 3) setTimeout(() => setReloadTick((t) => t + 1), 500 * n);
                        else setReadyId(story.id);
                      }}
                    />
                  )}
                </RepostStoryFrame>
              )
            ) : null}

            {/* Top scrim for legibility */}
            <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={styles.topScrim} pointerEvents="none" />

            {/* Progress segments */}
            <View style={[styles.progressRow, { top: insets.top + 6 }]} pointerEvents="none">
              {group.stories.map((s, i) => (
                <View key={s.id} style={styles.progressTrack}>
                  {/* Only the CURRENT segment is an Animated.View.

                      Every segment used to be one, switching between progressAnim
                      and a literal 1 as the index moved — and that cannot work
                      with useNativeDriver. Attaching a value to a view's
                      transform hands ownership to the NATIVE side, and
                      re-rendering the same view with a literal does not detach
                      it: the native node keeps driving it. So a passed segment
                      stayed bound to progressAnim and displayed whatever the
                      current story's fill happened to be — stuck part-full, or
                      empty once that value was reset. Reordering the reset could
                      not fix it because the binding, not the timing, was wrong.

                      A plain View has no such binding, so a watched bar is
                      simply a solid white bar. Switching element types also
                      forces React to unmount the Animated.View, which is what
                      actually releases the native node. */}
                  {i < storyIndex ? (
                    <View style={styles.progressFill} />
                  ) : i === storyIndex ? (
                    <Animated.View
                      style={[styles.progressFill, { transform: [{ scaleX: progressAnim }] }]}
                    />
                  ) : null}
                </View>
              ))}
            </View>

            {/* Header — the progress bar (above) and the close X stay visible even
                while the story is a grey loader, so it still reads as a story;
                the author + song-mute + trash/report reveal WITH the media. The
                spacer keeps the X pinned right when the author is hidden. */}
            <View style={[styles.header, { top: insets.top + 18 }]}>
              {/* Author stays mounted across story swipes — the avatar/name come from the
                  group, not the media — so the profile picture never flickers in and out
                  while the next story loads. */}
              <TouchableOpacity
                style={styles.author}
                onPress={() => { stopProgressAnim(); router.push(`/profile/${group.user.id}`); }}
              >
                {group.user.avatar_url ? (
                  <Image source={{ uri: group.user.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.avatar} style={styles.avatar}>
                    <Text style={styles.avatarText}>{group.user.display_name?.charAt(0).toUpperCase()}</Text>
                  </LinearGradient>
                )}
                <Text style={styles.authorName} numberOfLines={1}>{group.user.username || group.user.display_name}</Text>
                <BadgeEmblem profile={group.user} size={13} />
                <Text style={styles.time}>{timeAgo(story.created_at)}</Text>
              </TouchableOpacity>

              {/* Top-right is just the close X now — every other action lives in the
                  "⋯" menu at the bottom-right (see onStoryMenu). */}
              <View style={styles.headerRight}>
                <TouchableOpacity style={styles.headerBtn} onPress={dismiss} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
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
              ) : null // bottom captions render in the bottom stack below
            )}

            {/* Draggable text/emoji stickers, placed anywhere on the media by the
                author — rendered through the SAME style resolver as the editor
                (font / color / background / emoji metadata in stickers jsonb),
                so the story looks exactly as it did when composed. */}
            {(story.stickers ?? []).some((st: any) => (!st.kind || st.kind === 'text') && st.text) && (
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: textReveal }]} pointerEvents="none">
                {(story.stickers ?? []).filter((st: any) => (!st.kind || st.kind === 'text') && st.text).map((st: any, i: number) => (
                  <View key={i} style={StyleSheet.absoluteFill}>
                    <View style={styles.captionStickerCenter}>
                      <View
                        style={{
                          transform: [
                            { translateX: (st.x - 0.5) * SCREEN_W },
                            { translateY: (st.y - 0.5) * SCREEN_H },
                            { scale: st.scale ?? 1 },
                            { rotate: `${st.rotation ?? 0}deg` },
                          ],
                        }}
                      >
                        {/* Shared renderer → 'boxy' shows per-line pills. */}
                        <StickerContent sticker={st} />
                      </View>
                    </View>
                  </View>
                ))}
              </Animated.View>
            )}

            {/* Reshared-post pen strokes — the top layer of the composition (above
                the post + text), revealed with the media. */}
            {composed?.strokes && composed.strokes.length > 0 && (
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: textReveal }]} pointerEvents="none">
                <StoryDrawRenderer strokes={composed.strokes} frameW={SCREEN_W} frameH={SCREEN_H} />
              </Animated.View>
            )}

            {/* Pen doodle on a PLAIN story (authored in the regular story editor). */}
            {plainExtras.strokes && plainExtras.strokes.length > 0 && (
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: textReveal }]} pointerEvents="none">
                <StoryDrawRenderer strokes={plainExtras.strokes} frameW={SCREEN_W} frameH={SCREEN_H} />
              </Animated.View>
            )}

            {/* Own-story footer: viewer count. Live → tap to see WHO watched.
                Archived replay → count only, read-only (no per-viewer list). */}
            {isOwn && (
              <Animated.View
                style={[
                  styles.viewersCountWrap,
                  { bottom: insets.bottom + 14, opacity: pillIn, transform: [{ translateY: pillIn.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] },
                ]}
                pointerEvents="box-none"
              >
                {archived ? (
                  <Text style={styles.viewersCountNum}>{viewerCount ?? 0}</Text>
                ) : (
                  <TouchableOpacity onPress={openViewers} activeOpacity={0.7} hitSlop={{ top: 16, bottom: 16, left: 16, right: 24 }}>
                    <Text style={styles.viewersCountNum}>{viewerCount ?? 0}</Text>
                  </TouchableOpacity>
                )}
              </Animated.View>
            )}

            {/* A liked story gets a fun floating-hearts effect in the corner that
                EVERYONE sees — it grows with the like count and flashes likers'
                pics by, but carries no names/list and isn't tappable. WHO liked
                stays private to the owner (via the view-count pill → viewers sheet). */}
            {likeEffect.count > 0 && (
              <Animated.View
                style={[styles.likeBurstWrap, { bottom: insets.bottom + 58, opacity: pillIn }]}
                pointerEvents="box-none"
              >
                <StoryLikeBurst
                  count={likeEffect.count}
                  likers={likeEffect.likers}
                  paused={paused || !isFocused}
                  storyDurationMs={story.media_type === 'image' ? imageDurationMs : Math.max(5000, (story.duration_seconds ?? 15) * 1000)}
                  onOpenProfile={openLikerProfile}
                />
              </Animated.View>
            )}

            {/* Own story: "⋯" menu (save / delete) at the bottom-right, opposite the
                viewer count on the left. */}
            {isOwn && (
              <TouchableOpacity
                style={[styles.moreBtn, { bottom: insets.bottom + 16 }]}
                onPress={onStoryMenu}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel={t('a11y.moreOptions')}
              >
                <Ionicons name="ellipsis-horizontal" size={24} color="#fff" />
              </TouchableOpacity>
            )}

            {/* Someone else's story: reply pill + heart + "⋯" (report) */}
            {!isOwn && !!currentUserId && (
              <View style={[styles.replyRow, { bottom: insets.bottom }]}>
                <TouchableOpacity style={styles.replyPill} activeOpacity={0.8} onPress={openReply}>
                  <Text style={styles.replyPillText}>{t('story.replyTo', { name: group?.user.display_name || group?.user.username || t('story.fallbackName') })}</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={liked ? t('a11y.unlike') : t('a11y.like')}
                  onPress={toggleStoryLike}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
                >
                  <Ionicons name={liked ? 'heart' : 'heart-outline'} size={30} color={liked ? '#F43F5E' : '#fff'} />
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}
                  onPress={onStoryMenu}
                  activeOpacity={0.7}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                >
                  <Ionicons name="ellipsis-horizontal" size={26} color="#fff" />
                </TouchableOpacity>
              </View>
            )}

            {/* After you like, offer an optional PUBLIC like comment (edit if you
                already left one). Centred above the controls, clear of the hearts. */}
            {!isOwn && !!currentUserId && liked && !commenting && !replying && (
              <TouchableOpacity
                style={[styles.commentChip, { bottom: insets.bottom + 54 }]}
                onPress={openComment}
                activeOpacity={0.85}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
              >
                <Ionicons name="chatbubble-ellipses-outline" size={14} color="#141416" />
                <Text style={styles.commentChipText}>{myComment ? t('story.editLikeComment') : t('story.addLikeComment')}</Text>
              </TouchableOpacity>
            )}

            {/* Brief confirmation after a reply sends */}
            {sentFlash && (
              <View style={[styles.sentFlash, { bottom: insets.bottom + 60 }]} pointerEvents="none">
                <Ionicons name="checkmark-circle" size={16} color="#fff" />
                <Text style={styles.sentFlashText}>{t('story.sent')}</Text>
              </View>
            )}

            {/* ...and after a save lands, in the same place and voice. */}
            {savedFlash && (
              <View style={[styles.sentFlash, { bottom: insets.bottom + 60 }]} pointerEvents="none">
                <Ionicons name="checkmark-circle" size={16} color="#fff" />
                <Text style={styles.sentFlashText}>{t('story.savedToPhotos')}</Text>
              </View>
            )}

            {/* ...and after a public like comment is saved. */}
            {commentFlash && (
              <View style={[styles.sentFlash, { bottom: insets.bottom + 60 }]} pointerEvents="none">
                <Ionicons name="chatbubble-ellipses" size={15} color="#fff" />
                <Text style={styles.sentFlashText}>{t('story.likeCommentAdded')}</Text>
              </View>
            )}

            {/* Song chip — top-right, tucked under the header controls */}
            {!!story.song_id && (
              <View style={[styles.songTopRight, { top: insets.top + 58 }]} pointerEvents="box-none">
                <SongAttribution
                  inline
                  songId={story.song_id}
                  title={story.song_title}
                  artist={story.song_artist}
                  artistId={story.song_artist_id}
                  onNavigate={dismiss}
                  onPauseHost={pause}
                  onResumeHost={resume}
                />
              </View>
            )}

            {/* Bottom caption — bare bold text (no bar), inset clear of the
                heart/eye controls so nothing collides. */}
            {!!story.caption && !story.caption_style && (
              <View style={[styles.bottomStack, { bottom: insets.bottom + 50 }]} pointerEvents="none">
                <Text style={styles.caption}>{story.caption}</Text>
              </View>
            )}

            {/* Grey cover — the LAST child, so it sits above the media AND every
                overlay/chrome layer. Opaque until THIS story's first frame paints
                (`ready`), then it lifts and the whole story (image + caption +
                stickers + header + progress) appears in one clean frame. This is
                what makes a not-yet-ready story show plain grey instead of text
                or chrome over a blank/half-loaded frame. pointerEvents none so
                swipe-down-to-dismiss still works while grey. */}
            {/* Kept MOUNTED (not `{!ready && …}`) so it can fade rather than pop —
                opacity is driven by coverAnim: opaque while loading, crossfading to
                the media when the first frame is ready. pointerEvents none so it never
                blocks a swipe-down-to-dismiss, even mid-fade. */}
            {/* A video with a poster shows that first frame while it buffers, so the grey
                loader is only for images (and posterless video) — never greys over a poster. */}
            {!(story.media_type === 'video' && !!story.thumbnail_url && !story.shared_post_id) && (
              <Animated.View style={[StyleSheet.absoluteFill, styles.greyCover, { opacity: coverAnim }]} pointerEvents="none">
                {showLoader && <Spinner size={34} color="rgba(255,255,255,0.55)" thickness={3} />}
              </Animated.View>
            )}
          </>
        )}
      </Animated.View>

      {/* Reply composer — keyboard-attached input; the story stays paused
          behind the dim until it's sent or dismissed. */}
      {replying && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.replyOverlay, { opacity: replyAnim }]} />
          <KeyboardAvoidingView
            style={StyleSheet.absoluteFill}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={{ flex: 1 }} onPress={closeReply} />
            <Animated.View
              style={[
                styles.replyComposer,
                {
                  paddingBottom: SPACING.sm,
                  opacity: replyAnim,
                  transform: [{ translateY: replyAnim.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }],
                },
              ]}
            >
              <TextInput
                style={styles.replyInput}
                value={replyText}
                onChangeText={setReplyText}
                placeholder={t('story.replyTo', { name: group?.user.display_name || group?.user.username || t('story.fallbackName') })}
                placeholderTextColor="rgba(255,255,255,0.55)"
                selectionColor="#FAB525"
                cursorColor="#FAB525"
                autoFocus
                multiline
                maxLength={500}
              />
              <TouchableOpacity
                style={[styles.replySend, (!replyText.trim() || sendingReply) && { opacity: 0.4 }]}
                onPress={sendReply}
                disabled={!replyText.trim() || sendingReply}
              >
                {sendingReply
                  ? <ActivityIndicator color="#0a0a0c" size="small" />
                  : <Ionicons name="arrow-up" size={20} color="#0a0a0c" />}
              </TouchableOpacity>
            </Animated.View>
          </KeyboardAvoidingView>
        </View>
      )}

      {/* Public like-comment composer — keyboard-attached, mirrors the reply one; the
          story stays paused behind the dim until it's sent or dismissed. */}
      {commenting && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.replyOverlay, { opacity: commentAnim }]} />
          <KeyboardAvoidingView
            style={StyleSheet.absoluteFill}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={{ flex: 1 }} onPress={closeComment} />
            <Animated.View
              style={[
                styles.replyComposer,
                {
                  paddingBottom: SPACING.sm,
                  opacity: commentAnim,
                  transform: [{ translateY: commentAnim.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }],
                },
              ]}
            >
              <TextInput
                style={styles.replyInput}
                value={commentText}
                onChangeText={setCommentText}
                placeholder={t('story.likeCommentPlaceholder')}
                placeholderTextColor="rgba(255,255,255,0.55)"
                selectionColor="#FAB525"
                cursorColor="#FAB525"
                autoFocus
                multiline
                maxLength={140}
              />
              <TouchableOpacity
                style={[styles.replySend, sendingComment && { opacity: 0.4 }]}
                onPress={sendComment}
                disabled={sendingComment}
              >
                {sendingComment
                  ? <ActivityIndicator color="#0a0a0c" size="small" />
                  : <Ionicons name="arrow-up" size={20} color="#0a0a0c" />}
              </TouchableOpacity>
            </Animated.View>
          </KeyboardAvoidingView>
        </View>
      )}

      {/* Story options — a Laybell-styled slide-up menu opened by the bottom-right "⋯".
          A plain animated overlay (not a system sheet / RN Modal), so the delete
          confirmation Alert can present cleanly on top of it. */}
      {showStoryMenu && !!story && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.storyMenuBackdrop, { opacity: storyMenuAnim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => closeStoryMenu(true)} />
          </Animated.View>
          <Animated.View
            style={[
              styles.storyMenuSheet,
              {
                paddingBottom: insets.bottom + SPACING.md,
                transform: [{ translateY: storyMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [320, 0] }) }],
              },
            ]}
          >
            <View style={styles.storyMenuHandle} />
            {isOwn ? (
              <>
                <TouchableOpacity style={styles.storyMenuRow} activeOpacity={0.7} onPress={() => { closeStoryMenu(false); onSaveStory(); }}>
                  <Ionicons name="download-outline" size={22} color="#fff" />
                  <Text style={styles.storyMenuLabel}>{t('story.saveToPhotos')}</Text>
                </TouchableOpacity>
                {!archived && (
                  <TouchableOpacity style={styles.storyMenuRow} activeOpacity={0.7} onPress={() => { closeStoryMenu(false); onDelete(); }}>
                    <Ionicons name="trash-outline" size={22} color="#FF4D4F" />
                    <Text style={[styles.storyMenuLabel, styles.storyMenuDestructive]}>{t('common.delete')}</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <TouchableOpacity style={styles.storyMenuRow} activeOpacity={0.7} onPress={() => { closeStoryMenu(false); onReport(); }}>
                <Ionicons name="flag-outline" size={22} color="#FF4D4F" />
                <Text style={[styles.storyMenuLabel, styles.storyMenuDestructive]}>{t('story.report')}</Text>
              </TouchableOpacity>
            )}
            {!!story.song_id && (
              <TouchableOpacity style={styles.storyMenuRow} activeOpacity={0.7} onPress={() => { toggleSongMuted(); closeStoryMenu(true); }}>
                <Ionicons name={songMuted ? 'volume-mute-outline' : 'volume-high-outline'} size={22} color="#fff" />
                <Text style={styles.storyMenuLabel}>{songMuted ? t('a11y.unmute') : t('a11y.mute')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.storyMenuCancel} activeOpacity={0.7} onPress={() => closeStoryMenu(true)}>
              <Text style={styles.storyMenuCancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      )}

      {/* Viewers sheet — who watched (and who LIKED — hearts ride on top).
          Fixed-height IG-style sheet that slides well up the screen even when
          the list is short; story + music pause while it's open. */}
      {showViewers && (
        <View style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.viewersBackdrop, { opacity: viewersBackdropOpacity }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => closeViewers()} />
          </Animated.View>
          <Animated.View
            style={[
              styles.viewersSheet,
              {
                height: INSIGHTS_SHEET_H,
                paddingBottom: insets.bottom + SPACING.md,
                transform: [{ translateY: sheetY }],
              },
            ]}
          >
            {/* Black "stage" above the separator — the cards sit on pure black. Pull
                down anywhere on it to dismiss; swipe sideways to change story. */}
            <View style={styles.insTopStage} {...stagePan.panHandlers}>
              <View style={styles.viewersHandle} />
              {/* Story-card strip: a PEEKING carousel of every story you've posted. The
                  off-centre cards sit smaller + faded (depth); swipe to centre one and the
                  panel below reloads for it. The last card is a "+" to add another story. */}
              {group && (
                <>
                  <View style={[styles.insStrip, { overflow: 'hidden' }]}>
                    <Animated.View
                      style={{
                        flexDirection: 'row',
                        paddingHorizontal: (INSIGHTS_PAGE_W - INS_CARD_W - CARD_GAP) / 2,
                        transform: [{ translateX: Animated.multiply(insightsStripX, -1) }],
                      }}
                    >
                      {group.stories.map((s, i) => (
                          <Animated.View key={s.id} style={[styles.insCardPage, cardDepth(i)]}>
                            {/* Same renderer as the archive grid — media (or a repositioned
                                photo over its backdrop) + text + drawing, scaled into the card.
                                Tapping a card rotates the strip to it, so tapping a peeking side
                                card goes to the previous / next story. A swipe still moves one
                                story: stagePan captures only on move, so a tap falls through here. */}
                            <TouchableOpacity activeOpacity={0.85} onPress={() => goToInsightsStory(i)} accessibilityRole="button">
                              <StoryThumb story={s} width={INS_CARD_W} radius={RADIUS.lg} />
                            </TouchableOpacity>
                          </Animated.View>
                      ))}
                      {/* "+" card at the end of the cycle. Like any card, tapping it when
                          it is NOT the landed card just rotates the strip to it; only a tap
                          while it IS the landed (centred) card opens the new-story composer. */}
                      <Animated.View style={[styles.insCardPage, cardDepth(group.stories.length)]}>
                        <TouchableOpacity
                          style={[styles.insCard, styles.insAddCard]}
                          activeOpacity={0.8}
                          onPress={() => (insightsIdxRef.current === group.stories.length ? addStoryFromInsights() : goToInsightsStory(group.stories.length))}
                          accessibilityRole="button"
                          accessibilityLabel={t('storyCamera.addToStory')}
                        >
                          <Ionicons name="add" size={40} color="rgba(255,255,255,0.85)" />
                        </TouchableOpacity>
                      </Animated.View>
                    </Animated.View>
                  </View>
                  {group.stories.length > 1 && (
                    <View style={styles.insSegments}>
                      {group.stories.map((s, i) => (
                        <View key={s.id} style={[styles.insSegment, i === insightsIdx && styles.insSegmentOn]} />
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>
            {/* Separator between the mini story strip and the insights controls. */}
            <View style={styles.viewersDivider} />
            {onAddStory ? (
              /* The "+" card has no viewers — a breathing "Add Story" prompt that taps
                 through to the camera. Wrapped in the nav pan so a horizontal SWIPE goes
                 back to the previous story (and a pull-down dismisses) instead of firing
                 the press by accident. */
              <View style={{ flex: 1 }} {...panePan.panHandlers}>
                <Pressable style={styles.addMsgWrap} onPress={addStoryFromInsights}>
                  <Animated.View style={{ alignItems: 'center', transform: [{ scale: addPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }] }}>
                    <Ionicons name="add-circle" size={54} color="#fff" />
                    <Text style={styles.addMsgText}>{t('story.addStory')}</Text>
                  </Animated.View>
                </Pressable>
              </View>
            ) : (
              <View style={{ flex: 1 }} {...panePan.panHandlers}>
                {/* Analytics is a left-corner icon; Viewers the centered title. TAP to
                    switch panels — a horizontal swipe moves between stories instead. */}
                <View style={styles.insightsHeaderRow}>
                  <TouchableOpacity
                    style={styles.insightsIconBtn}
                    activeOpacity={0.8}
                    onPress={() => goInsightsTab(0)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('story.analytics')}
                  >
                    <Ionicons name="stats-chart" size={22} color={insightsTab === 'analytics' ? '#fff' : 'rgba(255,255,255,0.45)'} />
                  </TouchableOpacity>
                  <Text
                    style={[styles.insightsCenterTitle, insightsTab !== 'viewers' && styles.insightsCenterTitleDim]}
                    onPress={() => goInsightsTab(1)}
                    suppressHighlighting
                  >
                    {t('story.viewers')}{(viewerCount ?? viewers.length) ? `  ${viewerCount ?? viewers.length}` : ''}
                  </Text>
                  {/* Right spacer mirrors the icon so the title stays centred. */}
                  <View style={styles.insightsIconBtn} />
                </View>
                {/* Line under the buttons — matching top gap so they sit centred between
                    this line and the one above the header. */}
                <View style={[styles.viewersDivider, { marginTop: SPACING.xs }]} />
                {insightsTab === 'analytics' ? (
                  <View style={{ flex: 1 }}>
                {analytics === null ? (
                  <ActivityIndicator color="#fff" style={{ marginVertical: SPACING.xl }} />
                ) : analytics.viewers === 0 ? (
                  <View style={styles.viewersEmptyWrap}>
                    <Ionicons name="stats-chart-outline" size={34} color="rgba(255,255,255,0.35)" />
                    <Text style={styles.viewersEmpty}>{t('story.noViewsYet')}</Text>
                    <Text style={styles.viewersEmptySub}>{t('story.checkBackSoon')}</Text>
                  </View>
                ) : (
                  <View style={styles.analyticsWrap}>
                    <Text style={styles.analyticsSection}>{t('story.overview')}</Text>
                    <View style={styles.statRow}>
                      <View style={styles.statCard}>
                        <Text style={styles.statNum}>{analytics.viewers}</Text>
                        <Text style={styles.statLabel}>{t('story.viewers')}</Text>
                      </View>
                      <View style={styles.statCard}>
                        <Text style={styles.statNum}>{analytics.likes}</Text>
                        <Text style={styles.statLabel}>{t('story.likes')}</Text>
                      </View>
                    </View>
                    <Text style={styles.analyticsSection}>{t('story.audience')}</Text>
                    {/* Split bar: pink = followers, purple = non-followers (IG palette). */}
                    <View style={styles.splitBar}>
                      <View style={{ flex: Math.max(analytics.followers, 0.0001), backgroundColor: '#EC4899' }} />
                      <View style={{ flex: Math.max(analytics.nonFollowers, 0.0001), backgroundColor: '#8B5CF6' }} />
                    </View>
                    <View style={styles.audienceRow}>
                      <View style={styles.audienceDotRow}><View style={[styles.audienceDot, { backgroundColor: '#EC4899' }]} /><Text style={styles.audienceLabel}>{t('story.followers')}</Text></View>
                      <Text style={styles.audiencePct}>{analytics.viewers ? Math.round((analytics.followers / analytics.viewers) * 100) : 0}%</Text>
                    </View>
                    <View style={styles.audienceRow}>
                      <View style={styles.audienceDotRow}><View style={[styles.audienceDot, { backgroundColor: '#8B5CF6' }]} /><Text style={styles.audienceLabel}>{t('story.nonFollowers')}</Text></View>
                      <Text style={styles.audiencePct}>{analytics.viewers ? Math.round((analytics.nonFollowers / analytics.viewers) * 100) : 0}%</Text>
                    </View>
                    <Text style={styles.analyticsFootnote}>{t('story.repliesInDms')}</Text>
                  </View>
                )}
                  </View>
                ) : (
                  <View style={{ flex: 1 }}>
                {viewersLoading ? (
                  <ActivityIndicator color="#fff" style={{ marginVertical: SPACING.xl }} />
                ) : viewers.length === 0 ? (
                  <View style={styles.viewersEmptyWrap}>
                    <Ionicons name="eye-outline" size={34} color="rgba(255,255,255,0.35)" />
                    <Text style={styles.viewersEmpty}>{t('story.noViewsYet')}</Text>
                    <Text style={styles.viewersEmptySub}>{t('story.checkBackSoon')}</Text>
                  </View>
                ) : (
                  <FlatList
                    data={viewers}
                    style={{ flex: 1 }}
                    keyExtractor={(v) => v.id}
                    showsVerticalScrollIndicator={false}
                    scrollEventThrottle={16}
                    onScroll={(e) => { listAtTopRef.current = e.nativeEvent.contentOffset.y <= 0; }}
                    contentContainerStyle={{ paddingTop: SPACING.sm }}
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
                            <LinearGradient colors={GRADIENTS.avatar} style={styles.viewerAvatar}>
                              <Text style={styles.viewerAvatarText}>
                                {(v.display_name || v.username || '?').charAt(0).toUpperCase()}
                              </Text>
                            </LinearGradient>
                          )}
                          {/* Liked this story — red heart emblem on the avatar */}
                          {v.liked && (
                            <View style={styles.viewerLikeBadge}>
                              <Ionicons name="heart" size={11} color="#fff" />
                            </View>
                          )}
                        </View>
                        <View style={styles.viewerNameCol}>
                          <View style={styles.viewerNameRow}>
                            <Text style={styles.viewerName} numberOfLines={1}>{v.display_name || v.username}</Text>
                            <BadgeEmblem profile={v} size={14} />
                          </View>
                          <Text style={styles.viewerHandle} numberOfLines={1}>@{v.username}</Text>
                        </View>
                        {/* Their public like comment — in the open space to the RIGHT of
                            the name/username, as a fun throbbing "bubble" line. */}
                        {!!v.comment && (
                          <Animated.View style={[styles.viewerComment, { transform: [{ scale: commentThrobScale }] }]}>
                            <Ionicons name="heart" size={12} color="#F43F5E" />
                            <Text style={styles.viewerCommentText} numberOfLines={3}>{v.comment}</Text>
                          </Animated.View>
                        )}
                        {/* Pin control — only for commenters; pins this one comment to
                            lead the story's like effect (gold when pinned). */}
                        {!!v.comment && (
                          <TouchableOpacity
                            style={[styles.pinBtn, v.pinned && styles.pinBtnOn]}
                            onPress={() => togglePinComment(v)}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            accessibilityRole="button"
                            accessibilityLabel={v.pinned ? t('story.unpinComment') : t('story.pinComment')}
                          >
                            <Ionicons name={v.pinned ? 'pin' : 'pin-outline'} size={18} color={v.pinned ? '#1A1206' : 'rgba(255,255,255,0.6)'} />
                          </TouchableOpacity>
                        )}
                      </TouchableOpacity>
                    )}
                  />
                )}
                  </View>
                )}
              </View>
            )}
          </Animated.View>
        </View>
      )}

      {/* Exit veil for the "Add Story" hand-off (see exitFade). Last child = on top of
          everything; inert until it fades in. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: exitFade }]} />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  root: { flex: 1 },
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  // Rounded "card" look while the story recedes behind the viewers sheet (iOS-sheet style).
  containerReceded: { borderRadius: 18, overflow: 'hidden' },
  // Solid mid-grey shown until a story is fully ready — matches the loading
  // skeleton's tone so fetch → decode → reveal reads as one clean sequence.
  // Centers the loading circle. zIndex 5 covers the media + content overlays but
  // sits BELOW the always-on progress bar + close X (zIndex 10) so a loading
  // story still looks like a story.
  // Loading placeholder for a story whose frame hasn't painted yet: a plain dark grey
  // (the app's loading tone). It only appears if the story is slow — a loaded story
  // shows instantly — so there's no flash on a normal swipe.
  greyCover: { backgroundColor: '#1C1C1E', alignItems: 'center', justifyContent: 'center', zIndex: 5 },
  center: { alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  empty: { color: colors.textSecondary, fontSize: 15 },
  emptyBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  topScrim: { position: 'absolute', top: 0, left: 0, right: 0, height: 160 },

  // zIndex 10 so the top story bar stays visible ABOVE the grey loading cover.
  progressRow: { position: 'absolute', left: SPACING.sm, right: SPACING.sm, flexDirection: 'row', gap: 4, zIndex: 10 },
  progressTrack: { flex: 1, height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  // Full-width fill scaled from the left via scaleX (0→1) so the bar can be driven
  // by Animated without re-rendering or re-measuring each frame.
  progressFill: { width: '100%', height: '100%', backgroundColor: '#fff', borderRadius: 2, transformOrigin: 'left' },

  header: {
    position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 10,
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
  // Song credit, top-right under the header buttons.
  songTopRight: { position: 'absolute', right: SPACING.md, maxWidth: '72%', alignItems: 'flex-end' },
  // Bottom-left caption — right inset clears the heart/eye controls.
  bottomStack: {
    position: 'absolute', left: SPACING.md, right: 84,
    alignItems: 'flex-start', gap: SPACING.sm,
  },
  // Bare bold caption over the media (no bar) — modern iOS look; the shadow
  // does the legibility work on bright footage.
  caption: {
    color: '#fff', fontSize: 17, fontWeight: '800', lineHeight: 22, letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 8, textShadowOffset: { width: 0, height: 1 },
  },

  // Own-story viewers indicator: just the count, big/bold, bottom-left (no chip, no icon).
  // A soft shadow keeps it legible over bright media now that there's no backing fill.
  viewersCountWrap: { position: 'absolute', left: SPACING.md },
  // Fun floating-hearts effect (any liked story, every viewer). Right-aligned above
  // the bottom controls; non-interactive, so it never intercepts a tap/swipe. No
  // zIndex — like the viewer count it sits under the grey cover during load and
  // reveals with the story.
  likeBurstWrap: { position: 'absolute', right: SPACING.md },
  viewersCountNum: {
    color: '#fff', fontSize: 34, fontWeight: '900', letterSpacing: -0.6,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 8, textShadowOffset: { width: 0, height: 1 },
  },
  // Own story's "⋯" menu button, bottom-right (mirrors the viewer count on the left).
  // zIndex keeps it tappable above the grey loading cover.
  moreBtn: { position: 'absolute', right: SPACING.md, alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  // Laybell-styled "⋯" options menu (slide-up, dark — matches the immersive story context).
  storyMenuBackdrop: { backgroundColor: 'rgba(0,0,0,0.6)' },
  storyMenuSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#161618',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)',
    paddingTop: SPACING.sm, paddingHorizontal: SPACING.lg,
  },
  storyMenuHandle: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center', backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: SPACING.xs },
  storyMenuRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.md + 2 },
  storyMenuLabel: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
  storyMenuDestructive: { color: '#FF4D4F' },
  storyMenuCancel: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs },
  storyMenuCancelText: { color: 'rgba(255,255,255,0.6)', fontSize: 15.5, fontWeight: '700' },

  // Reply pill + heart row on someone else's story.
  replyRow: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
  },
  replyPill: {
    flex: 1, height: 42, borderRadius: 21, justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  replyPillText: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600' },
  // "Add a comment" chip offered after you like — centred above the controls. White
  // with black text/icon in every theme (it floats on the story, not on the app bg);
  // a soft shadow keeps it readable over bright media.
  commentChip: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: 999,
    paddingHorizontal: 13, paddingVertical: 7,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  commentChipText: { color: '#141416', fontSize: 13, fontWeight: '700' },
  sentFlash: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  sentFlashText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Reply composer overlay.
  replyOverlay: { backgroundColor: 'rgba(0,0,0,0.45)' },
  replyComposer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm,
  },
  replyInput: {
    flex: 1, minHeight: 44, maxHeight: 120,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: 22, paddingHorizontal: SPACING.md + 2, paddingVertical: 11,
    color: '#fff', fontSize: 16, lineHeight: 21,
  },
  replySend: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#fff',
  },

  // Viewers sheet (own stories): tall IG-style sheet — fixed height (set in
  // JSX) so it rises well up the screen even with only a couple of viewers.
  // Moderate (not opaque) so the story's slide-up + fade READS during the open transition;
  // by the time the sheet is settled the story has faded to nothing, so none of it lingers.
  viewersBackdrop: { backgroundColor: 'rgba(0,0,0,0.6)' },
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
  viewerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 4, paddingVertical: SPACING.sm + 3 },
  viewerAvatarWrap: { width: 52, height: 52 },
  viewerAvatar: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  viewerAvatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  // Red heart emblem on likers' avatars (likers sort to the top of the list).
  viewerLikeBadge: {
    position: 'absolute', bottom: -2, right: -3,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#F43F5E',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#0E0E0E',
  },
  // Name + @handle column. Shrinks (name ellipsises) so the comment keeps its room.
  viewerNameCol: { flexShrink: 1 },
  viewerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  viewerName: { color: '#fff', fontSize: 16.5, fontWeight: '700', flexShrink: 1 },
  viewerHandle: { color: 'rgba(255,255,255,0.55)', fontSize: 13.5, marginTop: 2 },
  // Their public like comment — fills the open space to the RIGHT of the name, a fun
  // chunky "bubble" line in white (the viewers sheet is a fixed dark panel). Throbs
  // via commentThrobScale on the Animated.View. minWidth keeps it readable.
  viewerComment: { flex: 1, minWidth: 90, flexDirection: 'row', alignItems: 'center', gap: 5 },
  viewerCommentText: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '900', lineHeight: 19, letterSpacing: 0.2 },
  // Pin control at the right of a commenter's row; gold disc when it's the pinned one.
  pinBtn: {
    width: 38, height: 38, borderRadius: 19, marginLeft: SPACING.sm,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pinBtnOn: { backgroundColor: '#FFC53D' },
  // Insights header: Analytics as a left-corner icon, Viewers as the centered title.
  insightsHeaderRow: { flexDirection: 'row', alignItems: 'center', height: 38 },
  insightsIconBtn: { width: 44, alignItems: 'flex-start', justifyContent: 'center' },
  insightsCenterTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16.5, fontWeight: '800', letterSpacing: -0.2 },
  insightsCenterTitleDim: { color: 'rgba(255,255,255,0.5)' },
  // Swipeable strip of the author's own stories at the top of the insights sheet.
  // Pure-black stage above the separator — extends edge-to-edge over the sheet's
  // padding and shares its rounded top, so the cards sit on solid black.
  insTopStage: {
    backgroundColor: '#000',
    marginHorizontal: -SPACING.md, marginTop: -SPACING.sm,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: 2,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
  },
  insStrip: { flexGrow: 0, height: INS_CARD_H, marginBottom: SPACING.sm },
  insCardPage: { width: INS_SNAP, height: INS_CARD_H, alignItems: 'center', justifyContent: 'center' },
  insCard: {
    width: INS_CARD_W, height: INS_CARD_H, borderRadius: RADIUS.lg, overflow: 'hidden',
    backgroundColor: '#1C1C1E', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)',
  },
  insAddCard: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1.5 },
  insSegments: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginBottom: SPACING.sm },
  insSegment: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  insSegmentOn: { width: 18, backgroundColor: '#fff' },
  // "Add Story" prompt shown (instead of viewers/analytics) on the "+" card.
  addMsgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: SPACING.xxl },
  addMsgText: { color: '#fff', fontSize: 26, fontWeight: '900', letterSpacing: -0.4, marginTop: SPACING.sm },
  // "Who viewed this story" label above the viewers list.
  viewersSectionLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 11.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: SPACING.sm, marginTop: 2 },
  // Analytics panel.
  analyticsWrap: { paddingTop: SPACING.xs },
  analyticsSection: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: SPACING.lg, marginBottom: SPACING.md },
  statRow: { flexDirection: 'row', gap: SPACING.md },
  statCard: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: RADIUS.lg, paddingVertical: SPACING.lg, paddingHorizontal: SPACING.md, gap: 5 },
  statNum: { color: '#fff', fontSize: 30, fontWeight: '900', letterSpacing: -0.6 },
  statLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 13.5, fontWeight: '600' },
  splitBar: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)', marginBottom: SPACING.sm },
  audienceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11 },
  audienceDotRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  audienceDot: { width: 10, height: 10, borderRadius: 5 },
  audienceLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  audiencePct: { color: '#fff', fontSize: 15, fontWeight: '800' },
  analyticsFootnote: { color: 'rgba(255,255,255,0.4)', fontSize: 12.5, marginTop: SPACING.lg },
});
