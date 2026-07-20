import AppVideo, { type AppVideoHandle } from '../../components/AppVideo';
import VideoScrubBar, { type VideoScrubBarHandle } from '../../components/VideoScrubBar';
import ZoomableView from '../../components/ZoomableView';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, Image, Animated,
  useWindowDimensions,
} from 'react-native';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import ReelVideo from '../../components/ReelVideo';
import { reelPool } from '../../lib/feedVideoPool';
import * as ScreenOrientation from 'expo-screen-orientation';
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
import { attachEngagementCounts, attachEngagementCountsAll } from '../../lib/postCounts';
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
import { usePostMusicActions, usePostMusicMuted } from '../../contexts/PostMusicContext';
import { useIsFocused } from '@react-navigation/native';
import { useExpandTransition } from '../../hooks/useExpandTransition';
import {
  buildAffinityProfile, loadSeenPostIds, recordSeenPostIds, scorePost, EMPTY_PROFILE,
} from '../../lib/feedScorer';
import {
  fetchReelAds, weaveReelAds, fetchTvAds, tvItemFor, recordAdImpression, recordAdClick, recordAdSkip, recordAdComplete, AD_SKIP_MS, TV_AD_EVERY_VIDEOS, type AdViewer,
} from '../../lib/ads';
import { openAdOptions } from '../../contexts/AdOptionsContext';
import ReelAd from '../../components/ReelAd';
import TVAdOverlay from '../../components/TVAdOverlay';
import RotateHint from '../../components/RotateHint';
import { useProfile } from '../../contexts/ProfileContext';
import { fetchSpotlightedPostIds } from '../../lib/spotlight';
import { ReelSkeleton } from '../../components/Skeleton';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Minimum breathing room between ANY two sponsors across the vertical and
// horizontal surfaces. A slot that comes due inside this window is simply
// skipped (not queued), so rotating right after an ad can't chain a second one.
const AD_MIN_GAP_MS = 45_000;

// A clip "wrapped" (played through) when its playhead jumps BACK by at least
// this much. onProgress reports MILLISECONDS — an undersized threshold here
// treats ordinary sub-second jitter as a finished video and auto-skips wildly.
const WRAP_BACKJUMP_MS = 1_000;

// Stable API handed to the memo'd page components: the object identity never
// changes (see pageApi in ReelScreen), each call delegating to the freshest
// screen closure through a ref.
type ReelPageApi = {
  toggleLike: (item: any) => void;
  toggleSave: (item: any) => void;
  share: (item: any) => void;
  openComments: (item: any) => void;
  showOptionsFor: (item: any) => void;
  openProfile: (userId: string) => void;
  dismiss: () => void;
  toggleCapExpanded: () => void;
  onZoomChange: (z: boolean) => void;
  markGesture: () => void;
  pressIn: () => void;
  tapToggle: () => void;
  setVideoRef: (id: string, r: any) => void;
  setScrubRef: (id: string, r: any) => void;
  setScrubbing: (s: boolean) => void;
  seek: (id: string, sec: number) => void;
  onProgress: (id: string, pos: number, dur: number) => void;
};

// Engagement overlay (bottom gradient + like/comment/save/share/options rail +
// author/caption/song meta), shared by the vertical pages and the landscape
// overlay. Module-scope + memo: a swipe re-renders at most the pages whose
// props actually changed — never the whole mounted window. (Same treatment the
// home feed got; reels had the identical re-render-burst failure mode.)
const ReelControls = memo(function ReelControls({
  item, isLiked, isSaved, spotlight, railBottom, metaBottom, railRight = SPACING.sm, compact = false, expandable = false, capExpanded = false, api,
}: {
  item: any; isLiked: boolean; isSaved: boolean; spotlight: boolean;
  railBottom: number; metaBottom: number; railRight?: number; compact?: boolean; expandable?: boolean; capExpanded?: boolean; api: ReelPageApi;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const likeCount = item.likes?.[0]?.count || 0;
  const commentCount = item.comments?.[0]?.count || 0;
  const saveCount = item.save_count || 0;
  const shareCount = item.share_count || 0;
  // Landscape: generous hit area on each button so a near-miss still fires it,
  // and the rail/meta absorb stray taps in their region so tapping AROUND the
  // buttons doesn't fall through and close the controls. Vertical is unchanged.
  const railHit = compact ? { top: 10, bottom: 10, left: 20, right: 16 } : undefined;
  const absorb = compact ? () => true : undefined;
  return (
    <>
      {/* bottom gradient for legibility */}
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.bottomFade} pointerEvents="none" />

      {/* Right action rail (bottom-anchored: options sits just above the bar) */}
      <View
        style={[styles.rail, compact && styles.railCompact, { bottom: railBottom, right: railRight }]}
        onStartShouldSetResponder={absorb}
        hitSlop={compact ? { left: 24, right: 8, top: 14, bottom: 14 } : undefined}
      >
        <TouchableOpacity style={styles.railBtn} hitSlop={railHit} onPress={() => api.toggleLike(item)}>
          <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={32} color={isLiked ? colors.like : '#fff'} />
          {likeCount > 0 && <Text style={styles.railText}>{formatCount(likeCount)}</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.railBtn} hitSlop={railHit} onPress={() => api.openComments(item)}>
          <Ionicons name="chatbubble-outline" size={30} color="#fff" />
          {commentCount > 0 && <Text style={styles.railText}>{formatCount(commentCount)}</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.railBtn} hitSlop={railHit} onPress={() => api.toggleSave(item)}>
          <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={28} color="#fff" />
          {saveCount > 0 && <Text style={styles.railText}>{formatCount(saveCount)}</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.railBtn} hitSlop={railHit} onPress={() => api.share(item)}>
          <Ionicons name="share-social-outline" size={28} color="#fff" />
          {shareCount > 0 && <Text style={styles.railText}>{formatCount(shareCount)}</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.railBtn} hitSlop={railHit} onPress={() => api.showOptionsFor(item)}>
          <Ionicons name="ellipsis-horizontal" size={28} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Author + caption */}
      <View style={[styles.meta, { bottom: metaBottom }]} onStartShouldSetResponder={absorb}>
        <View style={styles.authorRow}>
          <TouchableOpacity style={styles.author} onPress={() => api.openProfile(item.user_id)}>
            <StoryAvatar
              userId={item.user_id}
              avatarUrl={item.profiles?.avatar_url}
              name={item.profiles?.display_name}
              size={32}
              onPressProfile={() => api.openProfile(item.user_id)}
            />
            <Text style={styles.authorName} numberOfLines={1}>@{item.profiles?.username}</Text>
            <BadgeEmblem profile={item.profiles} ownerId={item.user_id} size={12} />
            {spotlight && <Ionicons name="sparkles" size={12} color={colors.primaryLight} style={styles.spotSparkle} />}
            <Text style={styles.dot}>·</Text>
            <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
          </TouchableOpacity>
          <FollowButton userId={item.user_id} />
        </View>
        {/* Caption + community hashtag on the same line (wraps below only when
            the caption wraps). Taps through to that community. In expandable
            (landscape) mode it collapses to one line with a Show more/less toggle. */}
        {(!!item.caption || (item.community_tags?.length ?? 0) > 0) && (
          <TranslatableText
            text={item.caption ?? ''}
            render={(s) => (
              <View>
                <View style={styles.captionRow}>
                  {!!s && (
                    <MentionText
                      style={styles.caption}
                      numberOfLines={expandable ? (capExpanded ? undefined : 1) : 2}
                      text={s}
                    />
                  )}
                  {(item.community_tags ?? []).map((ct: { id: string; hashtag: string }, i: number) => (
                    <CommunityTag key={ct.id} communityId={ct.id} hashtag={ct.hashtag} leading={i === 0 && !!s} />
                  ))}
                </View>
                {expandable && (s.length > 38 || s.includes('\n')) && (
                  <TouchableOpacity
                    onPress={() => api.toggleCapExpanded()}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.moreBtn}>{capExpanded ? 'Show less' : 'Show more'}</Text>
                  </TouchableOpacity>
                )}
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
            onNavigate={api.dismiss}
          />
        )}
      </View>
    </>
  );
});

// One vertical reel page. Memo'd with primitive props so scroll-state changes
// (visibleId at the viewability crossing, pause taps, scrub flags) re-render
// only the affected page — the burst of re-running every mounted page's
// gradient/caption-parse/translate work used to land exactly as the pager
// snapped, which was the per-swipe hitch.
const ReelPage = memo(function ReelPage({
  item, active, playing, showPaused, zoomed, isLiked, isSaved, spotlight, insetsBottom, mountPlayer, api,
}: {
  item: any; active: boolean; playing: boolean; showPaused: boolean; zoomed: boolean;
  isLiked: boolean; isSaved: boolean; spotlight: boolean; insetsBottom: number; mountPlayer: boolean; api: ReelPageApi;
}) {
  const styles = useThemedStyles(makeStyles);
  // Landscape/square videos show in full (letterboxed) so nothing is cut;
  // portrait videos fill the screen edge-to-edge.
  const landscape = aspectToNumber(item.aspect_ratio, 16 / 9) >= 1;
  // Cached thumbnail shown while the video buffers — keeps the expand from
  // revealing a black screen before the first frame is ready.
  const poster = item.thumbnail_url ?? item.cover_url ?? null;
  // Letterbox geometry for the rotate hint: a `contain` landscape video is
  // SCREEN_W wide, so the black band above it is half the leftover height. Park
  // the hint just above the video's top edge, and only when the band is tall
  // enough to hold it clear of the back button.
  const videoH = SCREEN_W / aspectToNumber(item.aspect_ratio, 16 / 9);
  const band = (SCREEN_H - videoH) / 2;
  const showRotateHint = landscape && active && !zoomed && band >= 130;
  return (
    <ElasticSwipeView style={{ width: SCREEN_W, height: SCREEN_H }} disabled={zoomed}>
      <TouchableOpacity
        activeOpacity={1}
        style={StyleSheet.absoluteFill}
        onPressIn={api.pressIn}
        onPress={api.tapToggle}
      >
        <ZoomableView
          width={SCREEN_W}
          height={SCREEN_H}
          style={StyleSheet.absoluteFill}
          active={active}
          onZoomChange={api.onZoomChange}
          onGesture={api.markGesture}
        >
        {/* Poster ALWAYS rendered underneath. Non-settled pages carry NO
            native player (creating an AVPlayer during a page mount was the
            reels mid-swipe freeze); when the player mounts at snap-settle,
            AppVideo keeps its surface transparent until readyToPlay — so the
            still becomes motion with no black flash at the handoff. */}
        {poster ? (
          <ExpoImage source={{ uri: poster }} style={StyleSheet.absoluteFill} contentFit={landscape ? 'contain' : 'cover'} />
        ) : null}
        {mountPlayer ? (
          // POOLED player (lib/feedVideoPool reelPool): assignment is an async
          // source swap — no creation, no freeze — which is what lets the NEXT
          // reel pre-buffer while this one plays (warmNextId in ReelScreen).
          // Landing on a pre-buffered reel plays the moment the swipe commits.
          <ReelVideo
            ref={(r) => api.setVideoRef(item.id, r)}
            id={item.id}
            uri={item.media_url}
            contentFit={landscape ? 'contain' : 'cover'}
            loop={item.trim_end == null}
            play={playing}
            muted={!!item.song_id}
            trimStartSec={item.trim_start}
            trimEndSec={item.trim_end}
            onProgress={(pos, dur) => api.onProgress(item.id, pos, dur)}
          />
        ) : null}
        </ZoomableView>
      </TouchableOpacity>

      {/* "Turn your phone" nudge, in the empty letterbox band above the video. */}
      <RotateHint visible={showRotateHint} top={band - 52} />

      {/* paused indicator */}
      {showPaused && (
        <View style={styles.pausedWrap} pointerEvents="none">
          <Ionicons name="play" size={64} color="rgba(255,255,255,0.85)" />
        </View>
      )}

      <ReelControls
        item={item}
        isLiked={isLiked}
        isSaved={isSaved}
        spotlight={spotlight}
        railBottom={insetsBottom + 90}
        metaBottom={insetsBottom + 24}
        api={api}
      />

      {/* This reel's own progress bar — lives inside the page so it scrolls
          away with the video rather than one shared bar floating across pages. */}
      <VideoScrubBar
        ref={(r) => api.setScrubRef(item.id, r)}
        bottomInset={insetsBottom + 6}
        onScrubbingChange={api.setScrubbing}
        onSeek={(sec) => api.seek(item.id, sec)}
      />
    </ElasticSwipeView>
  );
});

export default function ReelScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const linkGuard = useLinkGuard();
  // Hosted locally (not via the root context) so the sheets present over this
  // transparentModal route on iOS — see usePostActionSheets.
  const { share: openShare, showOptions, sheets, sheetsOpen } = usePostActionSheets();
  const { id, post: postParam } = useLocalSearchParams<{ id: string; post?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { stop } = useAudio();
  const { playSong, stop: stopSong, toggleMuted: toggleSongMuted, prefetchSong } = usePostMusicActions();
  const songMuted = usePostMusicMuted();
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
  // Reel-ad swipe lock, in refs so the frozen onViewableItemsChanged can touch
  // them: lockedAdIdRef = the ad currently trapping the pager (set the INSTANT it
  // becomes visible — before the momentum settle — so a fast double-swipe can't
  // outrun it; cleared when Skip unlocks). adUnlockedRef mirrors the adUnlocked
  // state set for that same frozen callback.
  const lockedAdIdRef = useRef<string | null>(null);
  const adUnlockedRef = useRef<Set<string>>(new Set());
  // Last playhead of the visible PORTRAIT reel — a backward jump means it wrapped
  // (played through), which drives autoplay-next. Declared up here so the frozen
  // onViewableItemsChanged below can reset it on every page change.
  const portraitLastPosRef = useRef(0);
  // Only ONE auto-advance may be in flight. The outgoing clip keeps emitting
  // progress for the whole animated scroll, so without this it wraps again mid-
  // scroll and chain-skips several posts. Cleared when the next page actually
  // commits (viewability), with a timeout so a failed scroll can't wedge it.
  const portraitAdvancingRef = useRef(false);
  const portraitAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while the USER is dragging. Auto-advance must never fire into a manual
  // swipe — mixing the two is exactly what feels glitchy.
  const portraitDraggingRef = useRef(false);
  // Rotating between portrait and the landscape overlay SEEKS the incoming player
  // to the outgoing one's playhead. A backward seek is indistinguishable from a
  // loop-wrap, so without a settle window the rotation itself fires autoplay-next
  // — that's the violent multi-skip when turning the phone. Both pagers ignore
  // wrap signals until this passes.
  const rotationSettleUntilRef = useRef(0);
  // Scrolling BACK to a reel reads as "I want to watch this again", so autoplay-
  // next is switched off for it — a re-watch shouldn't get yanked away. Only
  // sticks if they actually stay on it ~2s, so a quick back-swipe THROUGH a reel
  // doesn't permanently opt it out. (Clips under ~2s wrap before that and still
  // auto-advance, which is the intended "plays for more than 2 seconds" line.)
  const portraitPrevIndexRef = useRef(-1);
  const overlayPrevIndexRef = useRef(-1);
  // The clip we're leaving, so it can be rewound off-screen (see the viewability
  // handlers) instead of paying a seek on arrival.
  const portraitPrevVisibleIdRef = useRef<string | null>(null);
  const overlayPrevVisibleIdRef = useRef<string | null>(null);
  const manualOnlyRef = useRef<Set<string>>(new Set());
  const manualMarkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markManualIfWentBack = (id: string, newIdx: number, prevRef: { current: number }) => {
    const wentBack = prevRef.current >= 0 && newIdx >= 0 && newIdx < prevRef.current;
    prevRef.current = newIdx;
    if (manualMarkTimerRef.current) { clearTimeout(manualMarkTimerRef.current); manualMarkTimerRef.current = null; }
    if (!wentBack) return;
    manualMarkTimerRef.current = setTimeout(() => {
      // Still here 2s later → they're re-watching it on purpose.
      if (visibleIdRef.current === id || overlayIdRef.current === id) manualOnlyRef.current.add(id);
    }, 2000);
  };
  // When ANY sponsor last played, vertical or horizontal. The two cadences are
  // independent (reel ads are woven positionally, TV covers are counted), so
  // without a shared marker they can land back-to-back — finish a vertical ad,
  // rotate, and immediately eat a horizontal one. Nothing frustrates viewers
  // faster than two ads in a row.
  const lastAdAtRef = useRef(0);
  const { profile: myProfile } = useProfile();
  const myProfileRef = useRef(myProfile);
  myProfileRef.current = myProfile;

  // 55 (not 80): at 80% the incoming reel only became "visible" near the very
  // end of the gesture, so playback started AFTER the snap — a frozen-poster
  // beat on every landing. At ~55% (Instagram-like) the player kicks off while
  // the swipe is still settling.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 55 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    const it = viewableItems[0]?.item;
    if (!it) return;
    // Hard freeze on a locked ad: if ANY other page starts to come into view while
    // the ad is still locked (a fast double-swipe that outran the scrollEnabled
    // lock), snap straight back to the ad INSTANTLY (animated:false) and here at
    // the viewability commit — early enough that the next reel barely appears and
    // with no scroll-back animation, so it reads as "you can't leave the ad".
    const locked = lockedAdIdRef.current;
    if (locked && it.id !== locked && !adUnlockedRef.current.has(locked)) {
      const adIndex = postsRef.current.findIndex((p) => p.id === locked);
      if (adIndex >= 0) { try { listRef.current?.scrollToIndex({ index: adIndex, animated: false }); } catch {} }
      return; // ignore the bypass page — the ad is still the visible reel
    }
    setVisibleId(it.id);
    setPaused(false);
    // New page → forget the previous clip's playhead, otherwise landing at ~0
    // reads as a backward jump and would instantly autoplay-next.
    portraitLastPosRef.current = 0;
    // A page committed, so any auto-advance is done — release the lock. This also
    // covers MANUAL swipes: they land here too, which resets the state cleanly so
    // hand-driven and automatic paging can't desync.
    portraitAdvancingRef.current = false;
    if (portraitAdvanceTimer.current) { clearTimeout(portraitAdvanceTimer.current); portraitAdvanceTimer.current = null; }
    // Scrolled BACKWARD onto this reel? Then it's a re-watch — opt it out of
    // autoplay-next (see markManualIfWentBack).
    markManualIfWentBack(it.id, postsRef.current.findIndex((p) => p.id === it.id), portraitPrevIndexRef);
    // Reels always restart from the top — but rewind the clip we're LEAVING, not
    // the one we're arriving at. Seeking on arrival forced a seek + re-buffer at
    // the exact moment the frame was needed, which is the lag when flicking back
    // and forth. Rewinding on exit pays that cost off-screen, so returning finds
    // the clip already at 0 with nothing to do. Rotation is exempt — it
    // deliberately carries the playhead between orientations.
    const prevId = portraitPrevVisibleIdRef.current;
    portraitPrevVisibleIdRef.current = it.id;
    if (prevId && prevId !== it.id && Date.now() >= rotationSettleUntilRef.current) {
      try { videoRefs.current.get(prevId)?.seek(0); } catch {}
    }
    if (it.__ad) {
      lastAdAtRef.current = Date.now(); // feeds the cross-surface ad spacing
      recordAdImpression(it, 'reels', currentUserIdRef.current);
      // Arm the swipe lock the moment the ad is the visible page — well before the
      // momentum settle. Only SET here (never clear): unlockAd clears it when Skip
      // unlocks.
      if (!adUnlockedRef.current.has(it.id)) lockedAdIdRef.current = it.id;
    }
  }).current;

  useEffect(() => { stop(); setup(); }, [id]);

  // Auto-play the focused reel's attached song (the video itself is muted when a
  // song is set); stop on swipe-away / blur / unmount. The start is DEFERRED
  // ~160ms past the viewability commit: playSong tears down + creates a native
  // audio player (plus a possible fetch), which used to land synchronously on
  // the exact frame the pager snapped — and a fast swipe-through now never
  // starts a song at all.
  const visibleItem = posts.find((p) => p.id === visibleId);
  useEffect(() => {
    if (!visibleId) return;
    if (!isFocused) { stopSong(); return; } // blur isn't gesture-time — stop now
    const songId = visibleItem?.song_id;
    if (songId) prefetchSong(songId); // URL resolves in the background NOW
    // ALL player mutation lives in this ONE deferred timer (past the snap
    // settle): start when the landed reel has a song, stop when it doesn't.
    // The old cleanup-stop ran native audio work at the 55% viewability commit
    // MID-SWIPE — and by destroying the player right before the deferred
    // start, it also made the same-song handoff fast-path dead code. Now a
    // swipe between posts sharing one song is a pure ref handoff (zero native
    // churn), and different songs do a single internal replacement at +320ms.
    const timer = setTimeout(() => {
      if (songId) playSong(visibleId, songId);
      else stopSong();
    }, 320);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleId, visibleItem?.song_id, isFocused]);
  // Unmount backstop — the timer-owned flow above never stops on unmount.
  useEffect(() => () => stopSong(), []);

  // Players mount ONLY at snap-completion — never mid-swipe, never while the
  // landed video is already playing. (The previous "pre-warm the next reel"
  // design released the old player at the mid-swipe commit and created the
  // following one right as the snap finished — the owner-reported "freezes
  // every time at the perfect-fit snap".) settledId flips at
  // onMomentumScrollEnd: the landed player is created behind its POSTER,
  // before playback starts, so the creation cost is invisible; the previous
  // reel's player lingers ~500ms so its release also stays off the landing.
  const [settledId, setSettledId] = useState<string | null>(seed?.id ?? null);
  const [lingerId, setLingerId] = useState<string | null>(null);
  const settledIdRef = useRef(settledId);
  settledIdRef.current = settledId;
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onReelSettled = () => {
    const landed = visibleIdRef.current;
    if (!landed || landed === settledIdRef.current) return;
    reelPool.setProtected(landed); // the watched reel's player must never be stolen
    setLingerId(settledIdRef.current);
    setSettledId(landed);
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    lingerTimer.current = setTimeout(() => { lingerTimer.current = null; setLingerId(null); }, 500);
  };
  useEffect(() => {
    // Seed protection for the reel we opened on; clear it when the viewer closes.
    if (settledIdRef.current) reelPool.setProtected(settledIdRef.current);
    return () => {
      if (lingerTimer.current) clearTimeout(lingerTimer.current);
      reelPool.setProtected(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Pre-buffer the NEXT reel ~600ms after the current one settles (well after
  // its own playback is established, so the load — and any disposal of the
  // reused entry's old item — never competes with the fresh first seconds):
  // pooled assignment is replaceAsync — no creation, no freeze — so releasing
  // your finger on the next swipe lands on an already-loaded player that
  // simply plays. This is the Instagram "plays as soon as you let go" mechanic.
  const [warmNextId, setWarmNextId] = useState<string | null>(null);
  useEffect(() => {
    if (!settledId) return;
    const t = setTimeout(() => {
      const list = postsRef.current;
      const idx = list.findIndex((p) => p.id === settledId);
      const next = idx >= 0 ? list[idx + 1] : null;
      // Ads warm too (ReelAd is pooled now) — an unwarmed ad page used to
      // cold-start at the swipe, which reads as "reel N+1 is broken".
      setWarmNextId(next && next.media_url ? next.id : null);
    }, 900); // was 600 — give the settled reel's stream a longer solo head start
    return () => clearTimeout(t);
  }, [settledId, posts]);

  // ── Horizontal (cinematic) reels: rotate the phone for true fullscreen ──────
  // The app is otherwise portrait-locked. While a horizontal video is the active
  // reel we UNLOCK orientation so physically turning the phone sideways surfaces a
  // fullscreen landscape overlay; any other state re-locks portrait.
  const { width: winW, height: winH } = useWindowDimensions();
  const deviceLandscape = winW > winH;
  const visibleLandscape = !!visibleItem && !visibleItem.__ad
    && aspectToNumber(visibleItem.aspect_ratio, 16 / 9) > 1;
  const landscapeFullscreen = isFocused && visibleLandscape && deviceLandscape;
  // Which landscape rotation we're in — needed to place the action rail relative
  // to the notch. Safe-area insets can't tell the two landscape directions apart
  // (they report the notch inset on BOTH sides), so we read the real device
  // orientation from expo-screen-orientation instead. `notchOnRailSide` = the
  // notch/Dynamic Island is on the rail's (right) edge → shift the rail in;
  // otherwise the rail sits on the notch-free "bottom" edge → keep it tight.
  const [notchOnRailSide, setNotchOnRailSide] = useState(false);
  // Latest playback position (ms) of the active reel, so the fullscreen overlay
  // resumes roughly where the vertical player left off.
  const positionRef = useRef(0);
  // True while the active video is pinch-zoomed — taps then do NOT pause or toggle
  // controls, and the elastic swipe is suppressed (zoom is a separate interaction).
  const zoomedRef = useRef(false);
  const [zoomed, setZoomed] = useState(false);
  // Set the instant a pinch/pan activates (see ZoomableView onGesture), cleared at
  // the start of each fresh press (onPressIn). Lets a tap know if it was part of a
  // zoom movement → then it doesn't pause; a clean tap always does (even zoomed).
  const gestureSincePressRef = useRef(false);
  const onZoomChange = (z: boolean) => { zoomedRef.current = z; setZoomed(z); };

  // ── Scrub bar wiring (vertical feed) ────────────────────────────────────────
  // Per-item seek handles + a ref-driven progress bar (see VideoScrubBar): the
  // 250ms time-updates push into the bar imperatively so they never re-render the
  // reel list. onSeek routes to whichever reel is currently visible.
  const videoRefs = useRef<Map<string, AppVideoHandle>>(new Map());
  // One scrub bar per reel (keyed by post id) so each video carries its own bar
  // and it scrolls away with the video instead of one bar morphing across pages.
  const scrubRefs = useRef<Map<string, VideoScrubBarHandle>>(new Map());
  const visibleIdRef = useRef<string | null>(seed?.id ?? null);
  visibleIdRef.current = visibleId;
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const [scrubbing, setScrubbing] = useState(false);

  // ── Reel-ad swipe lock ───────────────────────────────────────────────────────
  // While an ad is the current page and its Skip button hasn't unlocked yet,
  // freeze paging so the user can't just swipe past the ad (which made Skip
  // pointless). Two layers: scrollEnabled (below) blocks the common case at the
  // settle, and lockedAdIdRef + the onReelSettled bounce-back catch a fast
  // double-swipe that outruns the scrollEnabled re-render. Unlocks the instant
  // the ad reports skippable (ReelAd's playback-driven countdown — same signal as
  // the Skip button), plus a wall-clock safety so a stalled/broken creative can
  // never trap the user.
  const [adUnlocked, setAdUnlocked] = useState<Set<string>>(new Set());
  adUnlockedRef.current = adUnlocked;
  const unlockAd = (adId: string) => {
    if (lockedAdIdRef.current === adId) lockedAdIdRef.current = null;
    setAdUnlocked((prev) => (prev.has(adId) ? prev : new Set(prev).add(adId)));
  };
  const settledIsLockedAd =
    !!settledId && !!postsRef.current.find((p) => p.id === settledId)?.__ad && !adUnlocked.has(settledId);
  useEffect(() => {
    if (!settledIsLockedAd || !settledId) return;
    const trapped = settledId;
    const timer = setTimeout(() => unlockAd(trapped), AD_SKIP_MS + 7000);
    return () => clearTimeout(timer);
  }, [settledIsLockedAd, settledId]);

  // ── Landscape fullscreen: horizontal pager over landscape-only reels ─────────
  const overlayRefs = useRef<Map<string, AppVideoHandle>>(new Map());
  // Single bar layered ON TOP of the horizontal pager (not inside its items) so
  // bottom touches never reach the FlatList — no swipe leak, and no scrollEnabled
  // toggling that would make the page shift/flash mid-scrub.
  const overlayScrubRef = useRef<VideoScrubBarHandle>(null);
  const overlayIdRef = useRef<string | null>(null);
  const overlayListRef = useRef<FlatList>(null);
  const enteredFromIdRef = useRef<string | null>(null); // reel we rotated from (resume its position)
  const [overlayId, setOverlayId] = useState<string | null>(null);
  // ── Laybell TV ads in the landscape ("horizontal scrolling") mode ─────────────
  // Shown as a full-screen INTERSTITIAL COVER over the pager — NOT a swipeable
  // page. Weaving the ad into the pager and enforcing an unskippable lock meant
  // toggling scrollEnabled / calling scrollToIndex on the horizontal overlay,
  // which froze it mid-scroll between two posts (the reported glitch). The cover
  // never touches the pager: it blocks swipes while up, then dismisses when the
  // ad finishes (or the skip15 Skip button), and the pager continues untouched.
  const [tvAds, setTvAds] = useState<any[]>([]);
  const tvAdsRef = useRef<any[]>([]);
  tvAdsRef.current = tvAds;
  const [overlayAd, setOverlayAd] = useState<any | null>(null);
  const overlayAdRef = useRef<any | null>(null);
  overlayAdRef.current = overlayAd;
  const overlayViewCountRef = useRef(0);      // NEW reels seen in landscape (ad cadence)
  const overlayAdRotationRef = useRef(0);     // which ad to show next
  // Reels already counted toward the cadence. Back-scrolling over them must not
  // advance the count, so a spent ad slot never fires again.
  const countedReelsRef = useRef<Set<string>>(new Set());
  // Dismissing is ALL that's needed: the cover sits over a reel the viewer hasn't
  // watched yet, so clearing overlayAd un-gates that reel's AppVideo `active` and
  // it starts playing. Deliberately no auto-advance — that would skip it.
  const dismissOverlayAd = () => { overlayAdRef.current = null; setOverlayAd(null); };

  // ── Autoplay-next for the landscape pager (mirrors the Cast/TV behaviour) ────
  // On the TV a finished clip rolls to the next queued item, EXCEPT while the
  // viewer is mid-interaction (sheet open / paused), where it loops instead —
  // and the last item loops rather than dead-ending. Same rules here, with the
  // pager itself as the queue. The videos keep `loop` on, so "don't advance"
  // costs nothing: it simply replays, exactly like the receiver does.
  const overlayLastPosRef = useRef(0);
  // Same runaway/manual-swipe guards as the portrait pager (see those refs).
  const overlayAdvancingRef = useRef(false);
  const overlayAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayDraggingRef = useRef(false);
  const maybeAdvanceOverlay = () => {
    if (!landscapeFullscreen) return;                          // overlay isn't the active surface
    if (Date.now() < rotationSettleUntilRef.current) return;    // mid-rotation
    if (manualOnlyRef.current.has(overlayIdRef.current ?? '')) return; // re-watch → manual only
    if (overlayAdvancingRef.current || overlayDraggingRef.current) return; // already moving
    if (paused || scrubbing || overlayAdRef.current) return;   // viewer is driving
    if (commentsFor != null || sheetsOpen) return;             // mid-read → loop
    const idx = landscapeReels.findIndex((p) => p.id === overlayIdRef.current);
    if (idx < 0 || idx + 1 >= landscapeReels.length) return;   // last one → loop
    overlayAdvancingRef.current = true;
    overlayLastPosRef.current = 0; // outgoing clip can't re-trigger on its next wrap
    if (overlayAdvanceTimer.current) clearTimeout(overlayAdvanceTimer.current);
    overlayAdvanceTimer.current = setTimeout(() => { overlayAdvancingRef.current = false; }, 1500);
    try { overlayListRef.current?.scrollToIndex({ index: idx + 1, animated: true }); }
    catch { overlayAdvancingRef.current = false; }
  };

  // Same autoplay-next rules for the VERTICAL pager. Extra gates it needs that
  // the landscape one doesn't: the landscape overlay owns playback while it's up,
  // and a reel AD must never be auto-advanced past — it has its own skip lock, so
  // rolling on would defeat the whole unskippable window.
  const maybeAdvancePortrait = () => {
    if (Date.now() < rotationSettleUntilRef.current) return;    // mid-rotation
    if (manualOnlyRef.current.has(visibleIdRef.current ?? '')) return; // re-watch → manual only
    if (portraitAdvancingRef.current || portraitDraggingRef.current) return; // already moving
    if (!isFocused || landscapeFullscreen) return;             // not the active surface
    if (paused || scrubbing || zoomed) return;                 // viewer is driving
    if (commentsFor != null || sheetsOpen) return;             // mid-read → loop
    const list = postsRef.current;
    const idx = list.findIndex((p) => p.id === visibleIdRef.current);
    if (idx < 0 || idx + 1 >= list.length) return;             // last one → loop
    if (list[idx]?.__ad) return;                               // ads own their exit
    portraitAdvancingRef.current = true;
    // Neutralise the outgoing clip's playhead so its next wrap can't re-trigger.
    portraitLastPosRef.current = 0;
    if (portraitAdvanceTimer.current) clearTimeout(portraitAdvanceTimer.current);
    portraitAdvanceTimer.current = setTimeout(() => { portraitAdvancingRef.current = false; }, 1500);
    try { listRef.current?.scrollToIndex({ index: idx + 1, animated: true }); }
    catch { portraitAdvancingRef.current = false; }
  };
  // Engagement controls (rail + author/caption) for the landscape overlay: shown
  // when a horizontal reel is landed on, then auto-faded after ~1s so the
  // cinematic view is unobstructed. Kept visible while paused for easy tapping.
  const controlsOpacity = useRef(new Animated.Value(0)).current;
  const [controlsVisible, setControlsVisible] = useState(false);
  const controlsVisibleRef = useRef(false);
  controlsVisibleRef.current = controlsVisible;
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while the controls should stay pinned (video paused, or a rail sheet
  // open). Read at reveal-time so controls shown in that state skip the auto-fade.
  const holdControlsRef = useRef(false);
  const [capExpanded, setCapExpanded] = useState(false); // landscape caption toggle

  const clearFadeTimer = () => { if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; } };
  // Reveal the rail + profile; auto-hide after 2s UNLESS the controls are held
  // (paused / sheet open), in which case they stay until that clears.
  const revealControls = () => {
    clearFadeTimer();
    setControlsVisible(true);
    Animated.timing(controlsOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    if (!holdControlsRef.current) {
      fadeTimerRef.current = setTimeout(() => {
        Animated.timing(controlsOpacity, { toValue: 0, duration: 450, useNativeDriver: true })
          .start(({ finished }) => { if (finished) setControlsVisible(false); });
      }, 2000);
    }
  };
  const hideControls = () => {
    clearFadeTimer();
    Animated.timing(controlsOpacity, { toValue: 0, duration: 220, useNativeDriver: true })
      .start(({ finished }) => { if (finished) setControlsVisible(false); });
  };
  // Landscape tap zones: the center pauses/plays; anywhere else toggles the
  // controls (show for 2s if hidden, or close them to enter clean view mode).
  const handleOverlayTap = (e: any) => {
    // A clean tap works (even while zoomed); a tap that was part of a pinch/drag
    // this press does not.
    if (gestureSincePressRef.current) return;
    const lx = e.nativeEvent?.locationX ?? 0;
    const ly = e.nativeEvent?.locationY ?? 0;
    const inCenter = lx > winW * 0.3 && lx < winW * 0.7 && ly > winH * 0.2 && ly < winH * 0.8;
    if (inCenter) { setPaused((p) => !p); return; }
    if (controlsVisibleRef.current) hideControls();
    else revealControls();
  };
  // The landscape pager holds ORGANIC landscape reels only — the TV ad is a cover
  // (see overlayAd), never a page — so the pager is never scroll-manipulated.
  const landscapeReels = useMemo(
    () => posts.filter((p) => !p.__ad && aspectToNumber(p.aspect_ratio, 16 / 9) > 1),
    [posts],
  );
  // Live mirror for the frozen onOverlayViewable below (it can't read render values).
  const landscapeReelsRef = useRef<any[]>([]);
  landscapeReelsRef.current = landscapeReels;
  const onOverlayViewable = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    const it = viewableItems[0]?.item;
    if (!it) return;
    overlayIdRef.current = it.id;
    setOverlayId(it.id);
    setPaused(false);
    // New page → forget the previous clip's playhead, otherwise landing on a reel
    // at position ~0 reads as a backward jump and instantly autoplay-nexts.
    overlayLastPosRef.current = 0;
    // A page committed (auto OR manual) → release the advance lock.
    overlayAdvancingRef.current = false;
    if (overlayAdvanceTimer.current) { clearTimeout(overlayAdvanceTimer.current); overlayAdvanceTimer.current = null; }
    // Same two rules as the vertical pager: a backward swipe means "re-watch"
    // (opt out of autoplay-next), and a freshly-landed clip always restarts.
    markManualIfWentBack(it.id, landscapeReelsRef.current.findIndex((p: any) => p.id === it.id), overlayPrevIndexRef);
    // The rotation resume is for the ROTATED-INTO clip only. Once they scroll off
    // it, drop the marker so coming back later starts from 0 like anything else.
    if (it.id !== enteredFromIdRef.current) enteredFromIdRef.current = null;
    // Rewind the clip we're LEAVING (off-screen) rather than the one we're
    // arriving at — same snappiness reason as the vertical pager.
    const prevOverlayId = overlayPrevVisibleIdRef.current;
    overlayPrevVisibleIdRef.current = it.id;
    if (prevOverlayId && prevOverlayId !== it.id && Date.now() >= rotationSettleUntilRef.current) {
      try { overlayRefs.current.get(prevOverlayId)?.seek(0); } catch {}
    }
    visibleIdRef.current = it.id;
    setVisibleId(it.id);
    // Landing on a page IS a settle: the portrait scrollToIndex below is
    // non-animated (no momentum-end), so without this the pooled portrait
    // player never mounted for the new reel — rotating back landed on a
    // frozen poster until the user manually swiped.
    onReelSettled();
    // Keep the vertical feed positioned on this reel so rotating back lands here.
    const idx = postsRef.current.findIndex((p) => p.id === it.id);
    if (idx >= 0) { try { listRef.current?.scrollToIndex({ index: idx, animated: false }); } catch {} }
    // Interstitial cadence: after every few landscape reels, drop a TV ad COVER
    // over the pager (blocks swipes, dismisses when done). No pager scroll ops.
    //
    // Each reel counts exactly ONCE (countedReelsRef). Scrolling BACK over reels
    // you've already passed must not advance the cadence — otherwise an ad you
    // already sat through pops up again. An ad belongs to its slot; once that
    // slot is spent, the next one only comes after N genuinely-new reels.
    if (!overlayAdRef.current && !countedReelsRef.current.has(it.id)) {
      countedReelsRef.current.add(it.id);
      overlayViewCountRef.current += 1;
      const ads = tvAdsRef.current;
      // NEVER stack two sponsors. A reel ad may already be the current item in the
      // vertical feed underneath (its own cadence is independent), and a TV cover
      // on top of that is two ads at once. The counted slot is still consumed, so
      // this one is simply skipped rather than queued up behind the reel ad.
      const portraitAdActive = !!postsRef.current.find((p) => p.id === visibleIdRef.current)?.__ad;
      // …and even once it's gone, keep a minimum gap after ANY recent sponsor.
      const tooSoon = Date.now() - lastAdAtRef.current < AD_MIN_GAP_MS;
      if (!portraitAdActive && !tooSoon && ads.length && overlayViewCountRef.current % TV_AD_EVERY_VIDEOS === 0) {
        const ad = ads[overlayAdRotationRef.current % ads.length];
        overlayAdRotationRef.current += 1;
        overlayAdRef.current = ad;
        setOverlayAd(ad);
        lastAdAtRef.current = Date.now(); // feeds the cross-surface ad spacing
        recordAdImpression(ad, 'tv', currentUserIdRef.current);
      }
    }
  }).current;

  // Seed the overlay's current reel + remember which one to resume when entering.
  useEffect(() => {
    // Crossing between the two pagers re-seeks players and re-mounts pages, which
    // produces backward playhead jumps that look exactly like a finished clip.
    // Mute autoplay-next until it settles, and clear both pagers' tracking so
    // neither carries a stale playhead across the rotation.
    rotationSettleUntilRef.current = Date.now() + 1200;
    portraitLastPosRef.current = 0;
    overlayLastPosRef.current = 0;
    portraitAdvancingRef.current = false;
    overlayAdvancingRef.current = false;
    portraitDraggingRef.current = false;
    overlayDraggingRef.current = false;
    // The horizontal ad cadence is per UNBROKEN landscape session: leaving to
    // vertical (or coming back) starts the count over. Otherwise a count left
    // sitting at the threshold fires the instant you rotate in — which is how a
    // vertical ad could be followed immediately by a horizontal one. Earning an
    // ad requires N horizontal reels in ONE continuous sideways run.
    overlayViewCountRef.current = 0;
    countedReelsRef.current.clear();
    if (landscapeFullscreen) {
      enteredFromIdRef.current = visibleId;
      overlayIdRef.current = visibleId;
      setOverlayId(visibleId);
    } else {
      setOverlayId(null);
      // Rotating back to portrait dismisses any TV ad cover (it's a landscape-only
      // interstitial) so it doesn't reappear on the next rotate.
      overlayAdRef.current = null;
      setOverlayAd(null);
      // Rotating back to portrait: carry the overlay's playhead into the
      // pooled portrait player — without this the reel visibly jumped back
      // to wherever it was when the phone was first rotated in.
      const vid = visibleIdRef.current;
      if (vid && positionRef.current > 0) {
        try { videoRefs.current.get(vid)?.seek(positionRef.current / 1000); } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landscapeFullscreen]);

  // Controls stay pinned while the video is paused or a rail sheet is open.
  const railSheetOpen = commentsFor != null || sheetsOpen;
  const holdControls = paused || railSheetOpen;
  holdControlsRef.current = holdControls;

  // Reveal the controls for their initial 2s when a horizontal reel is landed on
  // (or re-entering landscape). Whether they then fade is governed by holdControls.
  useEffect(() => {
    // The TV ad cover has its own overlay — keep the reel's engagement rail hidden while it's up.
    if (!landscapeFullscreen || overlayAd) { clearFadeTimer(); controlsOpacity.setValue(0); setControlsVisible(false); return; }
    revealControls();
    return clearFadeTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landscapeFullscreen, overlayId, overlayAd]);

  // When hold changes, only adjust ALREADY-VISIBLE controls: pin them (pause /
  // sheet open) or resume the 2s fade (unpaused & closed). Never reveal from
  // hidden — so pressing pause in clean view mode doesn't pop the buttons up.
  useEffect(() => {
    if (!landscapeFullscreen || !controlsVisibleRef.current) return;
    if (holdControls) clearFadeTimer();
    else revealControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landscapeFullscreen, holdControls]);

  // Collapse the caption again whenever a new horizontal reel is landed on.
  useEffect(() => { setCapExpanded(false); }, [overlayId]);

  useEffect(() => {
    if (isFocused && overlayAd) {
      // A horizontal TV ad is playing → LOCK to landscape so the user can't
      // rotate back to portrait to exit (and thereby skip) the ad. LANDSCAPE
      // still allows flipping left↔right, just never portrait. The lock is
      // released the moment the ad dismisses (overlayAd → null re-runs this).
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else if (isFocused && visibleLandscape) {
      ScreenOrientation.unlockAsync().catch(() => {});
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
  }, [isFocused, visibleLandscape, overlayAd]);
  // Always restore the portrait lock when leaving the reel viewer.
  useEffect(() => () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); }, []);

  // Track the notch side while in the landscape overlay. On this device
  // LANDSCAPE_LEFT is the rotation that puts the notch on the rail's right edge.
  useEffect(() => {
    if (!landscapeFullscreen) return;
    const apply = (o: ScreenOrientation.Orientation) => {
      setNotchOnRailSide(o === ScreenOrientation.Orientation.LANDSCAPE_LEFT);
    };
    ScreenOrientation.getOrientationAsync().then(apply).catch(() => {});
    const sub = ScreenOrientation.addOrientationChangeListener((e) => apply(e.orientationInfo.orientation));
    return () => ScreenOrientation.removeOrientationChangeListener(sub);
  }, [landscapeFullscreen]);

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

    const SELECT = '*, profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme)';
    const { data } = await supabase
      .from('posts').select(SELECT)
      .eq('is_public', true).eq('type', 'video')
      .order('created_at', { ascending: false }).limit(40);

    const now = Date.now();
    let list = attachEngagementCountsAll(data)
      .map((p) => ({ p, s: scorePost(p, profile, followingSet, seen, now) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p);

    // Put the tapped video first; fetch it if it wasn't in the recommended set.
    const idx = list.findIndex((p) => p.id === id);
    let start: any = null;
    if (idx >= 0) { start = list[idx]; list.splice(idx, 1); }
    else {
      const { data: one } = await supabase.from('posts').select(SELECT).eq('id', id).single();
      start = attachEngagementCounts(one);
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
      .then((pool) => {
        if (!pool.length) return;
        // Weave only while the user is still ABOVE the first ad slot (index
        // 2): inserting once they're deeper shifts every index under them and
        // swaps the reel they're WATCHING mid-play. Slow ad inventory just
        // sits this session out.
        const idx = postsRef.current.findIndex((p) => p.id === visibleIdRef.current);
        if (idx > 1) return;
        setPosts(weaveReelAds(ordered, pool));
      })
      .catch(() => {});

    // Laybell TV (horizontal) ads — shaped as landscape video items and woven
    // into the landscape pager only (see landscapeReels). Best-effort.
    fetchTvAds(adViewer)
      .then((pool) => { if (pool.length) setTvAds(pool.map((s, i) => tvItemFor(s, i))); })
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

  // Stable API for the memo'd ReelPage/ReelControls (module scope, above): the
  // outer object NEVER changes identity, so it can't defeat their memo; each
  // call delegates to the freshest screen closure through pageImplRef.
  const pageImpl = {
    toggleLike, toggleSave, share,
    openComments: (item: any) => setCommentsFor({ id: item.id, ownerId: item.user_id }),
    showOptionsFor: (item: any) => showOptions({
      postId: item.id,
      isOwn: item.user_id === currentUserId,
      authorId: item.user_id,
      authorName: item.profiles?.username,
      mediaType: item.type ?? 'video',
      onEdit: () => router.push(`/edit-post/${item.id}`),
      onDeleted: () => setPosts((prev) => prev.filter((p) => p.id !== item.id)),
      onArchived: () => setPosts((prev) => prev.filter((p) => p.id !== item.id)),
      onBlocked: () => setPosts((prev) => prev.filter((p) => p.user_id !== item.user_id)),
    }),
    openProfile: (userId: string) => router.push(`/profile/${userId}`),
    dismiss,
    toggleCapExpanded: () => setCapExpanded((v) => !v),
    onZoomChange,
    markGesture: () => { gestureSincePressRef.current = true; },
    pressIn: () => { gestureSincePressRef.current = false; },
    tapToggle: () => { if (gestureSincePressRef.current) return; setPaused((p) => !p); },
    // No seek-on-mount here: clips are rewound as they're LEFT (see the
    // viewability handlers), so an arriving one is already at 0 and needs nothing.
    setVideoRef: (pid: string, r: any) => { if (r) videoRefs.current.set(pid, r); else videoRefs.current.delete(pid); },
    setScrubRef: (pid: string, r: any) => { if (r) scrubRefs.current.set(pid, r); else scrubRefs.current.delete(pid); },
    setScrubbing,
    seek: (pid: string, sec: number) => videoRefs.current.get(pid)?.seek(sec),
    onProgress: (pid: string, pos: number, dur: number) => {
      if (visibleIdRef.current === pid) {
        // Backward jump = the clip wrapped (played through) → autoplay-next, the
        // same signal + rules the landscape pager and the TV receiver use.
        if (pos < portraitLastPosRef.current - WRAP_BACKJUMP_MS) maybeAdvancePortrait();
        portraitLastPosRef.current = pos;
        positionRef.current = pos;
      }
      scrubRefs.current.get(pid)?.setProgress(pos, dur);
      trackVideoProgress(pid, pos, dur);
    },
  };
  const pageImplRef = useRef(pageImpl);
  pageImplRef.current = pageImpl;
  const pageApi = useRef<ReelPageApi>({
    toggleLike: (i) => pageImplRef.current.toggleLike(i),
    toggleSave: (i) => pageImplRef.current.toggleSave(i),
    share: (i) => pageImplRef.current.share(i),
    openComments: (i) => pageImplRef.current.openComments(i),
    showOptionsFor: (i) => pageImplRef.current.showOptionsFor(i),
    openProfile: (u) => pageImplRef.current.openProfile(u),
    dismiss: () => pageImplRef.current.dismiss(),
    toggleCapExpanded: () => pageImplRef.current.toggleCapExpanded(),
    onZoomChange: (z) => pageImplRef.current.onZoomChange(z),
    markGesture: () => pageImplRef.current.markGesture(),
    pressIn: () => pageImplRef.current.pressIn(),
    tapToggle: () => pageImplRef.current.tapToggle(),
    setVideoRef: (id, r) => pageImplRef.current.setVideoRef(id, r),
    setScrubRef: (id, r) => pageImplRef.current.setScrubRef(id, r),
    setScrubbing: (s) => pageImplRef.current.setScrubbing(s),
    seek: (id, sec) => pageImplRef.current.seek(id, sec),
    onProgress: (id, pos, dur) => pageImplRef.current.onProgress(id, pos, dur),
  }).current;
  function renderItem({ item, index }: { item: any; index: number }) {
    if (item.__ad) {
      return (
        <ReelAd
          item={item}
          visible={visibleId === item.id}
          paused={paused}
          mountPlayer={settledId === item.id || lingerId === item.id || warmNextId === item.id}
          insets={insets}
          // Already seen this ad (scrolled past once) → Skip is immediately
          // available; don't restart the countdown when scrolling back to it.
          startSkippable={adUnlocked.has(item.id)}
          onSkip={() => {
            recordAdSkip(item, 'reels', currentUserId);
            listRef.current?.scrollToIndex({ index: index + 1, animated: true });
          }}
          // Played all the way through and never skipped → bill a COMPLETE (not a
          // skip), release the lock, and roll on, so nobody sits on a looping ad.
          onComplete={() => {
            recordAdComplete(item, 'reels', currentUserId);
            unlockAd(item.id);
            listRef.current?.scrollToIndex({ index: index + 1, animated: true });
          }}
          // The ad's Skip countdown reached zero — release the swipe lock so the
          // user can page past (the same moment the Skip button becomes tappable).
          onSkippableChange={(can) => { if (can) unlockAd(item.id); }}
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
    return (
      <ReelPage
        item={item}
        active={visibleId === item.id}
        // Gate on isFocused too: a reel is a transparentModal, so pushing
        // another reel on top (e.g. a GIF's "go to original video") leaves this
        // one mounted — without the focus check its audio would keep playing
        // UNDER the new video. Blur pauses it; returning resumes.
        playing={isFocused && visibleId === item.id && !paused && !landscapeFullscreen && !scrubbing}
        showPaused={visibleId === item.id && paused}
        zoomed={zoomed}
        isLiked={liked.has(item.id)}
        isSaved={saved.has(item.id)}
        spotlight={!!item.__spotlight || spotlightIds.has(item.id)}
        insetsBottom={insets.bottom}
        mountPlayer={settledId === item.id || lingerId === item.id || warmNextId === item.id}
        api={pageApi}
      />
    );
  }

  const onOverlayAdCta = (item: any) => {
    const url = item.__ad?.ctaUrl;
    if (!url) return;
    linkGuard.open(url, {
      context: 'ad',
      sourceName: item.__ad?.advertiserName,
      onProceed: () => recordAdClick(item, 'tv', currentUserId),
    });
  };
  const onOverlayAdReport = (item: any) => {
    const ad = item.__ad;
    if (ad) openAdOptions({ campaignId: ad.campaignId, creativeId: ad.creativeId, advertiserName: ad.advertiserName });
  };

  // A single page of the landscape fullscreen pager: the video filling the
  // sideways screen (letterboxed via contain) with tap-to-pause. Only the reel
  // we rotated from resumes its position; freshly-swiped ones start at 0.
  function renderOverlayItem({ item }: { item: any }) {
    const poster = item.thumbnail_url ?? item.cover_url ?? null;
    const resume = item.id === enteredFromIdRef.current ? positionRef.current / 1000 : null;
    return (
      <View style={{ width: winW, height: winH }}>
        <TouchableOpacity
          activeOpacity={1}
          style={StyleSheet.absoluteFill}
          onPressIn={() => { gestureSincePressRef.current = false; }}
          onPress={handleOverlayTap}
        >
          <ZoomableView
            width={winW}
            height={winH}
            style={StyleSheet.absoluteFill}
            active={overlayId === item.id}
            onZoomChange={onZoomChange}
            onGesture={() => { gestureSincePressRef.current = true; }}
          >
          <AppVideo
            ref={(r) => { if (r) overlayRefs.current.set(item.id, r); else overlayRefs.current.delete(item.id); }}
            source={{ uri: item.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            loop={item.trim_end == null}
            active={overlayId === item.id && !paused && !scrubbing && !overlayAd}
            muted={!!item.song_id}
            poster={poster}
            posterContentFit="contain"
            trimStartSec={item.trim_start}
            trimEndSec={item.trim_end}
            startPositionSec={resume}
            onProgress={(pos, dur) => {
              if (overlayIdRef.current === item.id) {
                // A BACKWARD jump means the clip just played through and wrapped
                // (either `loop`, or trimEnd seeking back to trimStart). That's
                // the reliable "finished" signal — a single near-end sample is
                // easy to miss at ~4 ticks/sec. Treat it as the TV does: roll to
                // the next video, or keep looping if the viewer is mid-action.
                if (pos < overlayLastPosRef.current - WRAP_BACKJUMP_MS) maybeAdvanceOverlay();
                overlayLastPosRef.current = pos;
                positionRef.current = pos;
                overlayScrubRef.current?.setProgress(pos, dur);
              }
              trackVideoProgress(item.id, pos, dur);
            }}
          />
          </ZoomableView>
        </TouchableOpacity>
      </View>
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
              // Freeze paging while the progress bar is being dragged (scrub), the
              // video is pinch-zoomed, or an unskippable ad is the settled page
              // (can't swipe past the ad until Skip unlocks — see settledIsLockedAd).
              scrollEnabled={!scrubbing && !zoomed && !settledIsLockedAd}
              showsVerticalScrollIndicator={false}
              snapToInterval={SCREEN_H}
              snapToAlignment="start"
              // One page per fling, Instagram-style: without this a hard fling
              // sails past multiple reels and late-snaps to the nearest one.
              disableIntervalMomentum
              decelerationRate="fast"
              getItemLayout={(_, i) => ({ length: SCREEN_H, offset: SCREEN_H * i, index: i })}
              // Hand-driven paging suppresses auto-advance for the duration of the
              // gesture, so a manual swipe and an autoplay-next can never stack.
              onScrollBeginDrag={() => { portraitDraggingRef.current = true; }}
              onScrollEndDrag={() => { portraitDraggingRef.current = false; }}
              onMomentumScrollEnd={() => { portraitDraggingRef.current = false; onReelSettled(); }}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={viewabilityConfig}
              renderItem={renderItem}
              windowSize={3}
              maxToRenderPerBatch={2}
              initialNumToRender={1}
            />
          ) : loading ? (
            <ReelSkeleton />
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

          {/* Fullscreen landscape takeover: a HORIZONTAL pager over landscape-only
              reels, shown when the phone is turned sideways. The vertical pager
              underneath is paused (see the `!landscapeFullscreen` gate on its
              `active`). Swiping sideways moves to the next relevant horizontal reel;
              with only one it does nothing and the user rotates back to exit. */}
          {landscapeFullscreen && landscapeReels.length > 0 && (
            <View style={styles.fsOverlay}>
              <FlatList
                ref={overlayListRef}
                data={landscapeReels}
                keyExtractor={(p) => p.id}
                horizontal
                pagingEnabled
                // No paging while pinch-zoomed. (The TV ad is a COVER, not a page,
                // so there's no ad-lock scrollEnabled toggle here — that's exactly
                // what froze the pager mid-scroll between two posts.)
                scrollEnabled={!zoomed}
                // Hand-driven paging suppresses auto-advance for the gesture, so a
                // manual sideways swipe and an autoplay-next can never stack.
                onScrollBeginDrag={() => { overlayDraggingRef.current = true; }}
                onScrollEndDrag={() => { overlayDraggingRef.current = false; }}
                onMomentumScrollEnd={() => { overlayDraggingRef.current = false; }}
                showsHorizontalScrollIndicator={false}
                snapToInterval={winW}
                snapToAlignment="start"
                // One page per fling (same as the portrait pager): without this a
                // hard sideways fling sails PAST a reel and late-snaps two away.
                disableIntervalMomentum
                decelerationRate="fast"
                getItemLayout={(_, i) => ({ length: winW, offset: winW * i, index: i })}
                initialScrollIndex={Math.max(0, landscapeReels.findIndex((p) => p.id === visibleId))}
                onViewableItemsChanged={onOverlayViewable}
                viewabilityConfig={viewabilityConfig}
                renderItem={renderOverlayItem}
                windowSize={3}
                maxToRenderPerBatch={2}
                initialNumToRender={1}
              />
              {paused && (
                <View style={styles.pausedWrap} pointerEvents="none">
                  <Ionicons name="play" size={64} color="rgba(255,255,255,0.85)" />
                </View>
              )}
              {/* Engagement controls that flash in on land and fade after ~1s.
                  box-none lets taps fall through to the video/scrub bar except on
                  the buttons themselves; non-interactive once faded. Lifted above
                  the scrub zone via the compact/lower anchors. */}
              {visibleItem && (
                <Animated.View
                  style={[StyleSheet.absoluteFill, { opacity: controlsOpacity }]}
                  pointerEvents={controlsVisible ? 'box-none' : 'none'}
                >
                  <ReelControls
                    item={visibleItem}
                    isLiked={liked.has(visibleItem.id)}
                    isSaved={saved.has(visibleItem.id)}
                    spotlight={!!visibleItem.__spotlight || spotlightIds.has(visibleItem.id)}
                    railBottom={insets.bottom + 40}
                    metaBottom={insets.bottom + 34}
                    // Notch side → shift the rail in to clear the Dynamic Island
                    // with a comfortable margin (SPACING.xl on top of the inset);
                    // notch-free "bottom" side → original tight placement. Driven
                    // by the real orientation (see notchOnRailSide) because insets
                    // report the notch on both sides in landscape.
                    railRight={notchOnRailSide ? insets.right + SPACING.xl : SPACING.sm}
                    compact
                    expandable
                    capExpanded={capExpanded}
                    api={pageApi}
                  />
                </Animated.View>
              )}
              {/* One bar layered on top of the pager. Because it sits above the
                  FlatList (not inside it), the whole bottom band is scrub-only —
                  taps there never page, and no scrollEnabled toggle is needed so
                  the video never shifts/flashes while scrubbing. Hidden while the
                  TV ad cover is up. */}
              {!overlayAd && (
                <VideoScrubBar
                  ref={overlayScrubRef}
                  bottomInset={insets.bottom + 6}
                  reachAbove={16}
                  onScrubbingChange={setScrubbing}
                  onSeek={(sec) => overlayRefs.current.get(overlayIdRef.current ?? '')?.seek(sec)}
                />
              )}
              <TouchableOpacity
                style={[styles.back, { top: insets.top + 8 }]}
                onPress={() => ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {})}
              >
                <Ionicons name="chevron-back" size={28} color="#fff" />
              </TouchableOpacity>

              {/* TV ad INTERSTITIAL COVER — full-screen over the pager. It captures
                  all touches (blocks swipes), so the ad is unskippable-until-done
                  WITHOUT any pager scroll manipulation. Dismisses when the ad
                  finishes (onDone), or on the skip15 Skip button (onSkip). */}
              {overlayAd && (
                <TVAdOverlay
                  item={overlayAd}
                  active={isFocused && !!overlayAd}
                  insets={insets}
                  // Played through → just close. The reel UNDERNEATH hasn't been
                  // watched yet (the cover dropped onto it), so advancing would
                  // make the viewer miss it entirely. Dismissing un-gates its
                  // AppVideo `active` and it starts playing. The slot is spent, so
                  // back-scrolling won't bring the ad back (countedReelsRef).
                  onDone={() => dismissOverlayAd()}
                  // skip15 Skip → same: reveal and play the video underneath.
                  onSkip={() => dismissOverlayAd()}
                  onReport={() => onOverlayAdReport(overlayAd)}
                  onCta={() => onOverlayAdCta(overlayAd)}
                />
              )}
            </View>
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

  // No zIndex: the sheets (options/comments) are later siblings and must layer
  // ABOVE this overlay in landscape — the iOS options sheet renders as a plain
  // in-tree View (not a Modal), so a zIndex here would bury it behind the overlay.
  fsOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  pausedWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 220 },

  rail: { position: 'absolute', right: SPACING.sm, alignItems: 'center', gap: SPACING.lg },
  // Tighter stack for the shorter landscape viewport so the rail fits bottom-right.
  railCompact: { gap: 14 },
  railBtn: { alignItems: 'center', gap: 3 },
  railText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  moreBtn: {
    color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '700', marginTop: 3,
    textShadowColor: 'rgba(0,0,0,0.85)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },

  meta: { position: 'absolute', left: SPACING.md, right: 80, gap: SPACING.xs },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  author: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  // A dark text-shadow "halo" keeps the white overlay text legible even over
  // bright/light video frames where the bottom gradient alone isn't enough.
  authorName: { flexShrink: 1, color: '#fff', fontSize: 15, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.85)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  spotSparkle: { opacity: 0.9, flexShrink: 0 },
  dot: { color: 'rgba(255,255,255,0.7)', fontSize: 14, textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 3 },
  time: { color: 'rgba(255,255,255,0.7)', fontSize: 12, textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 3 },
  captionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  caption: { color: '#fff', fontSize: 14, lineHeight: 19, flexShrink: 1, textShadowColor: 'rgba(0,0,0,0.85)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
});
