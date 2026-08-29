import AppVideo, { type AppVideoHandle } from '../../components/AppVideo';
import SlideshowCarousel from '../../components/SlideshowCarousel';
import { isSlideshow, parseSlides } from '../../lib/slideshow';
import { songPlaysFor } from '../../lib/postSong';
import VideoScrubBar, { type VideoScrubBarHandle } from '../../components/VideoScrubBar';
import ZoomableView from '../../components/ZoomableView';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Dimensions, Image, Animated, Easing,
  useWindowDimensions,
} from 'react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import ReelVideo from '../../components/ReelVideo';
import { reelPool } from '../../lib/feedVideoPool';
import { cfStreamThumbnail } from '../../lib/cast';
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
import { useDoubleTapLike } from '../../components/DoubleTapLike';
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
  fetchReelAds, reelItemFor, randInt, fetchTvAds, tvItemFor, recordAdImpression, recordAdSkip, recordAdComplete,
  AD_SKIP_MS, adSkipAfterMs, TV_AD_EVERY_VIDEOS, TV_AD_FIRST_VIDEOS, TV_AD_FIRST_TIME_MS,
  REEL_AD_FIRST, REEL_AD_EVERY_MIN, REEL_AD_EVERY_MAX, filmAdThresholds, type AdViewer, type AdSource,
} from '../../lib/ads';
import { adSpacingMultiplier, FILM_MIN_SEC } from '../../lib/entitlements';
import { openAdOptions } from '../../contexts/AdOptionsContext';
import ReelAd from '../../components/ReelAd';
import TVAdOverlay from '../../components/TVAdOverlay';
import RotateHint from '../../components/RotateHint';
import Spinner from '../../components/Spinner';
import { PositionedTopCaption, asTopCaption } from '../../components/TopCaption';
import { PlacedStickers } from '../../components/StickerLayer';
import { openAdCta } from '../../contexts/AdCtaContext';
import { useProfile } from '../../contexts/ProfileContext';
import { fetchSpotlightedPostIds } from '../../lib/spotlight';
import { ReelSkeleton } from '../../components/Skeleton';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Minimum breathing room between ANY two sponsors across the vertical and
// horizontal surfaces — the TIME half of the two-metric ad scheduler (the
// other half is posts scrolled). An ad only becomes DUE once BOTH have passed;
// a due ad then shows at the next opportunity, so rotating right after an ad
// still can't chain a second one inside this window.
const AD_MIN_GAP_MS = 45_000;

// Softer time gate for the FIRST sponsor of a session (vertical reels): the
// session opens ad-free for at least this long no matter how fast the user
// swipes. After any sponsor has shown, AD_MIN_GAP_MS is the time gate.
const REEL_AD_FIRST_TIME_MS = 15_000;

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
// FILM MID-ROLLS: accumulated WATCH time per film + breaks already fired.
// Module scope on purpose — leaving the viewer and coming back must not
// restart the ad clock (re-earning ads a viewer already sat through is the
// exact frustration the watch-time spec exists to prevent). Session-scoped.
const filmAdState = new Map<string, { watchMs: number; lastPosMs: number; fired: number; thresholds: number[] }>();

const ReelPage = memo(function ReelPage({
  item, active, playing, showPaused, zoomed, isLiked, isSaved, spotlight, insetsBottom, mountPlayer, api,
}: {
  item: any; active: boolean; playing: boolean; showPaused: boolean; zoomed: boolean;
  isLiked: boolean; isSaved: boolean; spotlight: boolean; insetsBottom: number; mountPlayer: boolean; api: ReelPageApi;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // Stable per page. Both used to be inline arrows, which handed ReelVideo a new
  // prop identity on every render of this page — defeating its memo() entirely,
  // so it re-rendered and pushed a fresh style down to the native VideoView each
  // time. The ref one was worse: a new callback identity makes React detach
  // (call with null) and re-attach the ref every render, churning the id->ref
  // map. `api` is a permanently stable ref object and item.id doesn't change for
  // a given page, so these can be created once.
  const onVideoProgress = useCallback(
    (pos: number, dur: number) => api.onProgress(item.id, pos, dur),
    [api, item.id],
  );
  const setVideoRef = useCallback((r: any) => api.setVideoRef(item.id, r), [api, item.id]);
  const setScrubRef = useCallback((r: any) => api.setScrubRef(item.id, r), [api, item.id]);
  const ratio = aspectToNumber(item.aspect_ratio, 16 / 9);
  // Landscape/square videos show in full (letterboxed) so nothing is cut;
  // portrait videos fill the screen edge-to-edge.
  const landscape = ratio >= 1;
  // Cached thumbnail shown while the video buffers — keeps the expand from
  // revealing a black screen before the first frame is ready.
  // Falling back to a DERIVED Cloudflare Stream poster is what stops a swipe
  // landing on an empty rectangle. A post with no thumbnail_url and no
  // cover_url previously rendered nothing under the player, so the page arrived
  // in two stages — chrome and caption instantly, then a blank video area until
  // the first frame decoded. Every Stream VOD already serves a poster frame at
  // a URL derivable from its manifest (lib/cast.cfStreamThumbnail, which the
  // TV cast path has always used); the viewer just never asked for it.
  const poster = item.thumbnail_url ?? item.cover_url ?? cfStreamThumbnail(item.media_url);
  // Letterbox geometry for the rotate hint: a `contain` landscape video is
  // SCREEN_W wide, so the black band above it is half the leftover height. Park
  // the hint just above the video's top edge, and only when the band is tall
  // enough to hold it clear of the back button. Strictly > 1 (not the >= 1
  // letterbox rule): square clips letterbox too but do NOT unlock the sideways
  // fullscreen (visibleLandscape uses > 1) — nudging them to rotate would
  // point at a door that doesn't open.
  const videoH = SCREEN_W / ratio;
  const band = (SCREEN_H - videoH) / 2;
  const showRotateHint = ratio > 1 && active && !zoomed && band >= 130;
  // Double-tap the video → like (never un-like) + heart burst; a double-tap NEVER
  // pauses (the deferred single is cancelled). A lone tap pauses via api.tapToggle
  // after the window — guarded by activeRef so a fast tap-then-swipe can't land a
  // stale pause on the NEXT reel (api.tapToggle delegates to the current page).
  const { onTap: onMediaTap, heart } = useDoubleTapLike({ isLiked, onLike: () => api.toggleLike(item) });
  const activeRef = useRef(active);
  activeRef.current = active;
  return (
    <ElasticSwipeView
      style={{ width: SCREEN_W, height: SCREEN_H }}
      // OFF for a slideshow. The rubber-band claims any clearly horizontal drag,
      // which on a video reel means nothing and is free to be decorative — but
      // on a carousel it IS the swipe between slides, and the two cannot both
      // have it. A photo set gets to page; the elastic gives way.
      disabled={zoomed || isSlideshow(item.type)}
    >
      {/* ── A SLIDESHOW reel is the carousel and nothing else ─────────────────
          Rendered OUTSIDE the tap layer and the zoom, not inside them, and that
          placement is the whole thing. Nested in the ZoomableView its horizontal
          scroll was competing with RNGH handlers for the same one-finger drag,
          so a swipe between slides landed only when it happened to win — the
          same arbitration that has failed everywhere else it was tried here.
          Standing alone, the only thing above it is the vertical pager, and
          crossed axes are the one nesting React Native settles cleanly.

          No player, no poster handoff, no scrub bar, no tap-to-pause: none of it
          applies to a set of photos. */}
      {isSlideshow(item.type) ? (
        <View style={styles.slideshowReel}>
          <SlideshowCarousel
            key={item.id}
            slides={parseSlides(item)}
            width={SCREEN_W}
            aspectRatio={aspectToNumber(item.aspect_ratio, 1)}
            active={active}
            postId={item.id}
          />
        </View>
      ) : (
      <TouchableOpacity
        activeOpacity={1}
        style={StyleSheet.absoluteFill}
        onPressIn={api.pressIn}
        onPress={() => onMediaTap(() => { if (activeRef.current) api.tapToggle(); })}
      >
        <ZoomableView
          width={SCREEN_W}
          height={SCREEN_H}
          style={StyleSheet.absoluteFill}
          active={active}
          onZoomChange={api.onZoomChange}
          onGesture={api.markGesture}
        >
        <>
        {/* Poster ALWAYS rendered underneath. Non-settled pages carry NO
            native player (creating an AVPlayer during a page mount was the
            reels mid-swipe freeze); when the player mounts at snap-settle,
            AppVideo keeps its surface transparent until readyToPlay — so the
            still becomes motion with no black flash at the handoff. */}
        {poster ? (
          // memory-disk: the feed/grid thumbnail is the SAME url, so opening a
          // reel paints the poster straight from the memory cache (no disk read
          // during the expand animation).
          <ExpoImage source={{ uri: poster }} style={StyleSheet.absoluteFill} contentFit={landscape ? 'contain' : 'cover'} cachePolicy="memory-disk" recyclingKey={item.id} />
        ) : null}
        {mountPlayer && item.video_status !== 'processing' ? (
          // POOLED player (lib/feedVideoPool reelPool): assignment is an async
          // source swap — no creation, no freeze — which is what lets the NEXT
          // reel pre-buffer while this one plays (warmNextId in ReelScreen).
          // Landing on a pre-buffered reel plays the moment the swipe commits.
          <ReelVideo
            ref={setVideoRef}
            id={item.id}
            uri={item.media_url}
            contentFit={landscape ? 'contain' : 'cover'}
            loop={item.trim_end == null}
            play={playing}
            muted={songPlaysFor(item)}
            trimStartSec={item.trim_start}
            trimEndSec={item.trim_end}
            onProgress={onVideoProgress}
          />
        ) : null}
        {/* Still encoding (its upload session died mid-wait; boot recovery is
            flipping it ready) — mounting the player would 404 into black, so
            show the poster + the truth instead. */}
        {item.video_status === 'processing' && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', alignSelf: 'center', top: '48%',
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 14,
              paddingHorizontal: 12, paddingVertical: 6,
            }}
          >
            <Spinner size={12} thickness={2} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '600' }}>{t('upload.almostDone')}</Text>
          </View>
        )}
        </>
        </ZoomableView>
      </TouchableOpacity>
      )}

      {/* "Turn your phone" nudge, in the empty letterbox band above the video. */}
      <RotateHint visible={showRotateHint} top={band - 52} />

      {/* Creator's captions. LANDSCAPE: bubbles in the top letterbox band
          (capped above the rotate hint) and the bottom band (capped above the
          meta/rail/scrub reserve). VERTICAL: story-style free-placed captions
          over the video. All only exist in this portrait page — the sideways
          fullscreen overlay covers it, so rotating hides them. */}
      {ratio > 1 ? (
        <>
          {!zoomed && asTopCaption(item.top_caption) ? (
            <PositionedTopCaption data={asTopCaption(item.top_caption)!} zone="top" ratio={ratio} screenW={SCREEN_W} screenH={SCREEN_H} />
          ) : null}
          {!zoomed && asTopCaption(item.bottom_caption) ? (
            <PositionedTopCaption data={asTopCaption(item.bottom_caption)!} zone="bottom" ratio={ratio} screenW={SCREEN_W} screenH={SCREEN_H} />
          ) : null}
        </>
      ) : !zoomed && Array.isArray(item.captions) && item.captions.length ? (
        <PlacedStickers stickers={item.captions} frameW={SCREEN_W} frameH={SCREEN_H} />
      ) : !zoomed && asTopCaption(item.top_caption) ? (
        // Legacy: a vertical clip saved before multi-captions had a single one.
        <PositionedTopCaption data={asTopCaption(item.top_caption)!} zone="screen" ratio={ratio} screenW={SCREEN_W} screenH={SCREEN_H} />
      ) : null}

      {/* paused indicator */}
      {showPaused && (
        <View style={styles.pausedWrap} pointerEvents="none">
          <Ionicons name="play" size={64} color="rgba(255,255,255,0.85)" />
        </View>
      )}

      {/* double-tap-to-like heart burst, centered over the video */}
      {heart}

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
        ref={setScrubRef}
        bottomInset={insetsBottom + 6}
        onScrubbingChange={api.setScrubbing}
        onSeek={(sec) => api.seek(item.id, sec)}
      />
    </ElasticSwipeView>
  );
});

// Reel kinds the dropdown can lead with. Order here is the menu order.
const REEL_FILTERS = ['all', 'vertical', 'horizontal', 'films'] as const;
// The chevron sits to the RIGHT of the label, so centring the pair puts the
// LABEL half a chevron left of the screen's centre line — which is the "not
// quite centred" wrongness. Padding the opposite side by the chevron's whole
// footprint re-centres the label itself: the pair is then symmetric about the
// text. Constants so the padding cannot drift from the icon it compensates for.
const FILTER_CHEVRON = 15;
const FILTER_GAP = 5;
// Deliberately dimmer than the label. The chevron is a hint that this opens,
// not a second thing to read — at full white next to 25pt/900 text it was
// competing with the word it belongs to.
const FILTER_CHEVRON_COLOR = 'rgba(255,255,255,0.6)';
type ReelFilter = (typeof REEL_FILTERS)[number];
// Longer than this is a film. The same 540s boundary the query and the TV shelf
// use — it lives in several places, so it is a constant here rather than a
// literal buried in a comparison.
const FILM_SECONDS = 540;

// Lead with the chosen kind, then everything else. NOT a hard filter: the owner's
// ask was that running out of one kind falls through to regular content rather
// than showing an empty feed, so nothing is ever removed — only reordered.
function orderByReelKind(list: any[], filter: ReelFilter): any[] {
  if (filter === 'all' || filter === 'films') return list;
  const wantHorizontal = filter === 'horizontal';
  const hit: any[] = [];
  const rest: any[] = [];
  for (const p of list) {
    (aspectToNumber(p.aspect_ratio, 16 / 9) > 1) === wantHorizontal ? hit.push(p) : rest.push(p);
  }
  return [...hit, ...rest];
}

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
  // ── Reel kind filter ────────────────────────────────────────────────────────
  // A dropdown rather than a hard switch, because these are not exclusive
  // universes: picking Vertical does not mean "never show me anything else", it
  // means "lead with vertical". Matching reels are ordered to the FRONT and the
  // rest follow, so running out of one kind quietly continues into normal
  // content instead of dead-ending on an empty feed.
  //
  // FILMS ARE THE EXCEPTION, and deliberately so. They are excluded from the
  // reel query by an explicit earlier decision — reels stay snackable, films
  // live on the TV shelf and the profile grid (see the query below). Making them
  // a menu option does not undo that: 'all' still excludes them, and the only
  // way to see one here is to ask for it by name.
  const [reelFilter, setReelFilter] = useState<ReelFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  // One value drives the menu's fade, its little drop, and the chevron's flip,
  // so the three cannot drift apart.
  //
  // The menu is ALWAYS MOUNTED and gated with pointerEvents rather than being
  // conditionally rendered. Unmounting it is what makes a fade-out impossible —
  // the view is gone on the frame the animation starts — and hiding it behind a
  // setState at the end of the animation would land a re-render exactly on the
  // last frame, which on a screen with video playing is a dropped one.
  const menuAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(menuAnim, {
      toValue: filterOpen ? 1 : 0,
      // Out faster than in: an opening menu is worth watching, a closing one is
      // just in the way of whatever you picked.
      duration: filterOpen ? 170 : 130,
      easing: filterOpen ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [filterOpen, menuAnim]);
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
  // WHICH post that playhead belongs to. Without this the baseline is global,
  // and it could be re-poisoned by the OUTGOING clip after a page change:
  //
  //   visibleIdRef mirrors state during RENDER (see below), while the reset on
  //   page change runs synchronously inside the viewability callback. Between
  //   those two moments visibleIdRef still names the previous post, so a tick
  //   from the outgoing clip (they arrive every 250ms, all through the scroll)
  //   passed the id check and wrote ITS playhead back over the fresh zero. The
  //   incoming reel's first tick then looked like a huge backward jump — a
  //   false "wrapped" signal — and auto-advance skipped a post the viewer had
  //   not watched. Intermittent, because it needed a tick to land inside that
  //   window.
  //
  //   The landscape pager never had this: overlayIdRef is assigned
  //   synchronously in its viewability handler, so its id and its reset move
  //   together.
  //
  // Scoping the baseline to a post makes the comparison meaningless across a
  // page change instead of wrong: a playhead from post A is simply never
  // compared against a position from post B.
  const portraitLastPosIdRef = useRef<string | null>(null);
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
  // Same story for the SCRUB BAR: dragging backward seeks the playhead back,
  // which the wrap detector would read as "clip finished" → yanked to the next
  // reel mid-scrub. The last-pos refs are corrected at the seek call sites, but
  // a straggler progress tick carrying the PRE-seek position can land after
  // that correction — so manual seeks also open this short settle window that
  // both advance paths respect.
  const seekSettleUntilRef = useRef(0);
  const markManualSeek = (sec: number) => {
    seekSettleUntilRef.current = Date.now() + 800;
    portraitLastPosRef.current = sec * 1000;
    portraitLastPosIdRef.current = visibleIdRef.current; // baseline belongs to the reel being seeked
    overlayLastPosRef.current = sec * 1000;
    positionRef.current = sec * 1000;
  };
  // The scrub bar's fraction maps over the FULL timeline, so on trimmed clips a
  // raw seek could land outside the trim window and play pre/post-trim footage
  // until the loop-back caught up. Clamp into the window (just shy of trim end,
  // which would instantly loop back).
  const clampToTrim = (post: any, sec: number) => {
    const lo = post?.trim_start ?? 0;
    const hi = post?.trim_end != null ? post.trim_end - 0.05 : Infinity;
    return Math.min(Math.max(sec, lo), Math.max(lo, hi));
  };
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
  // When ANY sponsor last played, vertical or horizontal. Both surfaces share
  // this marker so their cadences can't land back-to-back — finish a vertical
  // ad, rotate, and immediately eat a horizontal one. Nothing frustrates
  // viewers faster than two ads in a row. Initialized to MOUNT time: "time
  // since the last sponsor" reads as "time since the session opened" until the
  // first one shows, which is what gives the first-ad time gate its meaning.
  const lastAdAtRef = useRef(Date.now());
  // ── Dynamic ad scheduler (vertical pager) ──────────────────────────────────
  // Ads are no longer woven into fixed list positions at load. Instead an ad
  // becomes DUE when BOTH metrics pass — organic reels landed since the last
  // sponsor (count gate) AND wall-clock since it (time gate) — and a due ad is
  // inserted just-in-time as the NEXT post after the reel being watched. Fast
  // swipers are paced by the time gate, long-watchers by the count gate, so
  // neither extreme ever feels spammy. All refs (not state): the frozen
  // viewability handler is the only writer/reader.
  const reelAdPoolRef = useRef<AdSource[]>([]);   // fetched inventory (rotates)
  const reelAdSlotRef = useRef(0);                // rotation index + unique item ids
  const organicSinceAdRef = useRef(0);            // count metric: organic lands since last sponsor
  const reelAdBaseGateRef = useRef(REEL_AD_FIRST); // lands required (pre-Premium-spacing); re-rolled 4-7 after each ad
  const hadAnySponsorRef = useRef(false);         // first ad uses the softer time gate
  const lastCountedIdRef = useRef<string | null>(null); // consecutive-land dedupe (ad-lock bounce-backs)
  const pendingAdIdRef = useRef<string | null>(null);   // inserted but not yet seen — never insert a second
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
    portraitLastPosIdRef.current = null; // no baseline until the new reel ticks
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
      // "The top" of a trimmed clip is its trim start, not 0 — rewinding to 0
      // put the playhead OUTSIDE the trim window, so returning to a trimmed
      // reel played pre-trim footage.
      const prevStart = postsRef.current.find((p) => p.id === prevId)?.trim_start ?? 0;
      try { videoRefs.current.get(prevId)?.seek(prevStart); } catch {}
    }
    if (it.__ad) {
      lastAdAtRef.current = Date.now(); // feeds the cross-surface ad spacing
      // A sponsor is being SEEN — both due-metrics restart from here, and the
      // next interval rolls a fresh randomized count gate so the cadence never
      // feels metronomic. (Re-viewing an old ad on a back-scroll resets too:
      // seeing a sponsor is seeing a sponsor — spacing stays conservative.)
      organicSinceAdRef.current = 0;
      hadAnySponsorRef.current = true;
      reelAdBaseGateRef.current = randInt(REEL_AD_EVERY_MIN, REEL_AD_EVERY_MAX);
      if (pendingAdIdRef.current === it.id) pendingAdIdRef.current = null;
      recordAdImpression(it, 'reels', currentUserIdRef.current);
      // Arm the swipe lock the moment the ad is the visible page — well before the
      // momentum settle. Only SET here (never clear): unlockAd clears it when Skip
      // unlocks.
      if (!adUnlockedRef.current.has(it.id)) lockedAdIdRef.current = it.id;
    } else if (!landscapeFullscreenRef.current && lastCountedIdRef.current !== it.id) {
      // ── Dynamic ad scheduling: count this organic land, insert when due ────
      // Only while portrait is the ACTIVE surface (the overlay syncs this list
      // positionally — those fires belong to the TV cover cadence, not this
      // one) and deduped against the immediately-previous land (ad-lock
      // bounce-backs re-fire viewability for the same page).
      lastCountedIdRef.current = it.id;
      organicSinceAdRef.current += 1;
      const list = postsRef.current;
      const idx = list.findIndex((p) => p.id === it.id);
      // An inserted-but-unseen ad we've JUMPED past (overlay-driven position
      // sync) will never be reached going forward — forget it so scheduling
      // resumes; it stays in the list behind us like any already-passed ad.
      // Same if it's not in the list at all (insertion bailed / was removed):
      // a dangling pending id must never wedge the scheduler.
      if (pendingAdIdRef.current) {
        const pIdx = list.findIndex((p) => p.id === pendingAdIdRef.current);
        if (pIdx < 0 || idx > pIdx) pendingAdIdRef.current = null;
      }
      // Due = BOTH metrics passed. Premium widens both by the same spacing
      // multiplier (~50% fewer reel ads, the existing perk).
      const spacing = adSpacingMultiplier();
      const countDue = organicSinceAdRef.current >= Math.round(reelAdBaseGateRef.current * spacing);
      const timeGate = (hadAnySponsorRef.current ? AD_MIN_GAP_MS : REEL_AD_FIRST_TIME_MS) * spacing;
      const timeDue = Date.now() - lastAdAtRef.current >= timeGate;
      if (
        countDue && timeDue && reelAdPoolRef.current.length > 0 && !pendingAdIdRef.current
        // Insert only BETWEEN posts (never as the new last item — the ad's own
        // skip/complete handlers advance to index+1, which must exist) and
        // never directly before another sponsor.
        && idx >= 0 && idx + 1 < list.length && !list[idx + 1]?.__ad
      ) {
        const pool = reelAdPoolRef.current;
        const adItem = reelItemFor(pool[reelAdSlotRef.current % pool.length], reelAdSlotRef.current);
        reelAdSlotRef.current += 1;
        pendingAdIdRef.current = adItem.id;
        // Insertion is strictly BELOW the current page, so the visible reel's
        // offset/index never move — no jump, even mid-gesture. The next swipe
        // simply lands on the sponsor: "the ad is the next post".
        setPosts((prev) => {
          const at = prev.findIndex((p) => p.id === it.id);
          if (at < 0 || at + 1 >= prev.length || prev[at + 1]?.__ad) return prev;
          const next = prev.slice();
          next.splice(at + 1, 0, adItem);
          return next;
        });
      }
    }
  }).current;

  // Re-runs on a filter change as well as a new id: 'films' needs a different
  // query, and the other kinds need re-ordering from the top rather than
  // shuffling the list under the reel someone is already watching.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { stop(); setup().catch(() => setLoading(false)); }, [id, reelFilter]);

  // The focused reel (used by the attached-song autoplay effect below — it
  // lives AFTER the overlayAd declarations it must react to).
  const visibleItem = posts.find((p) => p.id === visibleId);

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
    }, 450); // 600 → 900 in the raw-MP4 era (neighbor fetches starved the settled
             // reel's first seconds); halved back post-HLS-migration — adaptive
             // segments + the 8s buffer cap bound the warm stream, and 450ms still
             // clears the landed reel's first-segment window. Faster swipers now
             // land on a ready player instead of outrunning the warm timer.
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
  // Mirror for the frozen portrait viewability handler (it can't see render
  // values): overlay-driven position syncs must not count toward the vertical
  // ad scheduler while landscape owns the screen.
  const landscapeFullscreenRef = useRef(false);
  landscapeFullscreenRef.current = landscapeFullscreen;
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
    // Safety slack rides on the ad's OWN gate (5s regular, 10s simple-shop
    // 'skip10') — a fixed 12s was only 2s of slack over a 10s gate, which a
    // slow-loading preview could overrun and get force-unlocked mid-countdown.
    const skipMode = postsRef.current.find((p) => p.id === trapped)?.__ad?.skipMode ?? null;
    const gate = adSkipAfterMs('reels', skipMode);
    const timer = setTimeout(() => unlockAd(trapped), (Number.isFinite(gate) ? gate : AD_SKIP_MS) + 7000);
    return () => clearTimeout(timer);
  }, [settledIsLockedAd, settledId]);

  // Both of these tear the kind dropdown off screen entirely. Closing it first
  // means it is not still open — and mid-fade — when it comes back.
  useEffect(() => {
    if (landscapeFullscreen || settledIsLockedAd) setFilterOpen(false);
  }, [landscapeFullscreen, settledIsLockedAd]);

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
  // Whether a TV sponsor has already shown this session. TV-specific on purpose:
  // hadAnySponsorRef below is cross-surface (a vertical reel ad spends it too),
  // but TV's opening gates should only be spent by a TV sponsor.
  const tvHadAdRef = useRef(false);
  // Reels already counted toward the cadence. Back-scrolling over them must not
  // advance the count, so a spent ad slot never fires again.
  const countedReelsRef = useRef<Set<string>>(new Set());
  // Dismissing is ALL that's needed: the cover sits over a reel the viewer hasn't
  // watched yet, so clearing overlayAd un-gates that reel's AppVideo `active` and
  // it starts playing. Deliberately no auto-advance — that would skip it.
  const dismissOverlayAd = () => { overlayAdRef.current = null; setOverlayAd(null); };

  // FILM mid-roll: a watch-time clock that drives the SAME interstitial cover
  // the TV cadence uses (TVAdOverlay pauses the film via the `active` gate,
  // blocks touches, bills skip/complete, offers report + CTA). Fires only in
  // the landscape overlay — where films are actually watched.
  const maybeFilmAdBreak = (item: any, posMs: number, durMs: number) => {
    if (!item || item.__ad) return;
    const durSec = Number(item.duration_seconds) || Math.round(durMs / 1000);
    if (durSec <= FILM_MIN_SEC) return;                                    // films only
    if (overlayAdRef.current) return;                                      // never stack sponsors
    if (item.user_id && item.user_id === currentUserIdRef.current) return; // creators previewing their own film
    let st = filmAdState.get(item.id);
    if (!st) {
      st = { watchMs: 0, lastPosMs: posMs, fired: 0, thresholds: filmAdThresholds(durSec, adSpacingMultiplier()) };
      filmAdState.set(item.id, st);
    }
    // Only real playback accrues: forward, tick-sized deltas. A seek in either
    // direction just moves the baseline — skipping around never earns ads.
    const delta = posMs - st.lastPosMs;
    st.lastPosMs = posMs;
    if (delta > 0 && delta < 2000) st.watchMs += delta;
    const next = st.thresholds[st.fired];
    if (next == null || st.watchMs < next * 1000) return;
    st.fired += 1; // the slot is spent even when no creative is available
    const ads = tvAdsRef.current;
    if (!ads.length) return;
    const ad = ads[overlayAdRotationRef.current % ads.length];
    overlayAdRotationRef.current += 1;
    overlayAdRef.current = ad;
    setOverlayAd(ad);
    lastAdAtRef.current = Date.now(); // feeds the cross-surface ad spacing
    hadAnySponsorRef.current = true;
    tvHadAdRef.current = true;
    recordAdImpression(ad, 'tv', currentUserIdRef.current);
  };

  // Auto-play the focused reel's attached song (the video itself is muted when a
  // song is set); stop on swipe-away / blur / unmount. The start is DEFERRED
  // past the viewability commit: playSong can do native audio work (plus a
  // possible fetch), which used to land synchronously on the exact frame the
  // pager snapped — and a fast swipe-through never starts a song at all.
  // (Declared HERE, below the overlayAd state, because it must react to it.)
  const visibleIsSponsor = !!visibleItem?.__ad;
  useEffect(() => {
    if (!visibleId) return;
    if (!isFocused) { stopSong(); return; } // blur isn't gesture-time — stop now
    // A sponsor owns the audio channel — the vertical ad page, or the TV cover
    // over the landscape pager. Stop any attached song IMMEDIATELY, not on the
    // deferred timer: the ad's own sound starts the moment it shows, so the
    // timer's ~320ms window was two audios fighting. Worse, the TV cover never
    // changes visibleId, so the timer path alone NEVER stopped the song — it
    // played under the whole horizontal ad. stop() is pause-only on the
    // persistent player, so doing it at the commit costs nothing — and it also
    // clears any deferred mini-player claim, so a song can't resurrect
    // mid-sponsor through that handoff either. On dismiss/swipe-away this
    // effect re-runs and the landed reel's song starts normally.
    if (visibleIsSponsor || overlayAd) { stopSong(); return; }
    // songPlaysFor, not song_id: a music video credits its OWN song, so
    // starting the ambient track would play it over itself.
    const songId = songPlaysFor(visibleItem) ? visibleItem?.song_id : null;
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
  }, [visibleId, visibleItem?.song_id, isFocused, visibleIsSponsor, overlayAd]);
  // Unmount backstop — the timer-owned flow above never stops on unmount.
  useEffect(() => () => stopSong(), []);

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
    if (Date.now() < seekSettleUntilRef.current) return;        // mid-manual-seek
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
    if (Date.now() < seekSettleUntilRef.current) return;        // mid-manual-seek
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
    portraitLastPosIdRef.current = null; // no baseline until the new reel ticks
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
  // Landscape double-tap-to-like: ONE hook for the single active landscape reel.
  const { onTap: onOverlayTap, heart: overlayHeart } = useDoubleTapLike({
    isLiked: !!overlayId && liked.has(overlayId),
    onLike: () => { const it = posts.find((p) => p.id === overlayIdRef.current); if (it) toggleLike(it); },
  });
  // Landscape tap zones: the center pauses/plays; anywhere else toggles the
  // controls (show for 2s if hidden, or close them to enter clean view mode).
  // Routed through the deferred double-tap so a double-tap LIKES without pausing
  // or toggling controls; a lone tap still runs its zone action after the window.
  const handleOverlayTap = (e: any) => {
    // A clean tap works (even while zoomed); a tap that was part of a pinch/drag
    // this press does not.
    if (gestureSincePressRef.current) return;
    const lx = e.nativeEvent?.locationX ?? 0;
    const ly = e.nativeEvent?.locationY ?? 0;
    const tappedId = overlayIdRef.current; // the landscape reel that was tapped
    onOverlayTap(() => {
      if (overlayIdRef.current !== tappedId) return; // swiped to another reel → skip the stale action
      const inCenter = lx > winW * 0.3 && lx < winW * 0.7 && ly > winH * 0.2 && ly < winH * 0.8;
      if (inCenter) { setPaused((p) => !p); return; }
      if (controlsVisibleRef.current) hideControls();
      else revealControls();
    });
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
      // Same trim-aware rewind as the portrait pager: 0 sits outside a trimmed
      // clip's window.
      const prevStart = landscapeReelsRef.current.find((p: any) => p.id === prevOverlayId)?.trim_start ?? 0;
      try { overlayRefs.current.get(prevOverlayId)?.seek(prevStart); } catch {}
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
    // Interstitial cadence — same two-metric model as the vertical scheduler:
    // a cover becomes DUE once enough genuinely-NEW landscape reels have been
    // seen (count gate) AND the cross-surface time gap has passed (time gate),
    // and a due cover then fires on the NEXT new-reel land where both hold.
    // (It used to fire only at exact multiples of the count, burning the slot
    // if the time gap blocked it.) Still a COVER over the pager — blocks
    // swipes, dismisses when done, no pager scroll ops.
    //
    // Each reel counts exactly ONCE (countedReelsRef). Scrolling BACK over reels
    // you've already passed must not advance the cadence — otherwise an ad you
    // already sat through pops up again.
    if (!overlayAdRef.current && !countedReelsRef.current.has(it.id)) {
      countedReelsRef.current.add(it.id);
      overlayViewCountRef.current += 1;
      const ads = tvAdsRef.current;
      // NEVER stack two sponsors. A reel ad may already be the current item in
      // the vertical feed underneath, and a TV cover on top of that is two ads
      // at once. Due-ness PERSISTS past the block: the cover fires on the next
      // new reel once clear.
      const portraitAdActive = !!postsRef.current.find((p) => p.id === visibleIdRef.current)?.__ad;
      // …and even once it's gone, keep a minimum gap after ANY recent sponsor.
      // The session OPENS on softer gates (2 videos / 20s, like vertical reels)
      // and settles into the normal cadence once a TV sponsor has shown.
      // lastAdAtRef starts at mount, so the same subtraction measures "time into
      // the session" before the first ad and "time since the last ad" after it.
      const needVideos = tvHadAdRef.current ? TV_AD_EVERY_VIDEOS : TV_AD_FIRST_VIDEOS;
      const needMs = tvHadAdRef.current ? AD_MIN_GAP_MS : TV_AD_FIRST_TIME_MS;
      const tooSoon = Date.now() - lastAdAtRef.current < needMs;
      if (!portraitAdActive && !tooSoon && ads.length && overlayViewCountRef.current >= needVideos) {
        overlayViewCountRef.current = 0; // count metric restarts once shown
        const ad = ads[overlayAdRotationRef.current % ads.length];
        overlayAdRotationRef.current += 1;
        overlayAdRef.current = ad;
        setOverlayAd(ad);
        lastAdAtRef.current = Date.now(); // feeds the cross-surface ad spacing
        hadAnySponsorRef.current = true;  // vertical's softer first-ad gate is spent too
        tvHadAdRef.current = true;        // …and TV's own opening gates
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
    portraitLastPosIdRef.current = null; // no baseline until the new reel ticks
    overlayLastPosRef.current = 0;
    portraitAdvancingRef.current = false;
    overlayAdvancingRef.current = false;
    portraitDraggingRef.current = false;
    overlayDraggingRef.current = false;
    // Fresh back-swipe baselines: comparing the landing index against one left
    // over from a PREVIOUS session of this pager mis-read plain rotation as
    // "scrolled backward" and opted the landed reel out of autoplay-next.
    portraitPrevIndexRef.current = -1;
    overlayPrevIndexRef.current = -1;
    // The horizontal ad cadence is per UNBROKEN landscape session: leaving to
    // vertical (or coming back) starts the count over. Otherwise a count left
    // sitting at the threshold fires the instant you rotate in — which is how a
    // vertical ad could be followed immediately by a horizontal one. Earning an
    // ad requires N horizontal reels in ONE continuous sideways run.
    overlayViewCountRef.current = 0;
    countedReelsRef.current.clear();
    if (landscapeFullscreen) {
      // An inserted-but-unseen vertical ad must not survive the surface
      // switch: landscape has its own sponsor cadence, and coming back later
      // could land the stale ad right after a TV cover (two sponsors nearly
      // back-to-back). It sits BELOW the current page, so removing it never
      // shifts what's on screen; the scheduler simply re-inserts when due.
      if (pendingAdIdRef.current) {
        const pid = pendingAdIdRef.current;
        pendingAdIdRef.current = null;
        setPosts((prev) => prev.filter((p) => p.id !== pid));
      }
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

  // The desired orientation state, as a plain string, so a redundant native
  // call can be skipped. `visibleLandscape` is derived from the landed reel's
  // aspect ratio, so this effect re-ran on EVERY swipe — and swiping between
  // two portrait reels re-issued the same PORTRAIT_UP lock each time. These are
  // native round trips landing right on the swipe commit; only the transitions
  // that actually change something are worth paying for.
  const orientModeRef = useRef<string | null>(null);
  useEffect(() => {
    // Focus is part of the key, not just an input: blurring and returning must
    // ALWAYS re-apply, since another screen may have changed the orientation
    // while this one was away. Only same-focus, same-intent repeats are skipped
    // — which is exactly the swipe-to-swipe case this is here for.
    const mode = !isFocused ? 'blurred'
      : overlayAd ? 'landscape'
      : visibleLandscape ? 'unlocked'
      : 'portrait';
    if (orientModeRef.current === mode) return;
    orientModeRef.current = mode;
    if (mode === 'blurred') {
      // Unchanged from before: leaving the viewer restores the portrait lock.
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    } else if (mode === 'landscape') {
      // A horizontal TV ad is playing → LOCK to landscape so the user can't
      // rotate back to portrait to exit (and thereby skip) the ad. LANDSCAPE
      // still allows flipping left↔right, just never portrait. The lock is
      // released the moment the ad dismisses (overlayAd → null re-runs this).
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    } else if (mode === 'unlocked') {
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

    // ALL independent fetches go out together — the posts query used to wait
    // for seen/affinity/follows, and likes/saves serialized after it, so the
    // swipeable list took two-plus round-trips longer than it needed to.
    const SELECT = '*, profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme)';
    const [seen, profile, followingRes, postsRes, likesRes, savesRes] = await Promise.all([
      loadSeenPostIds(),
      uid ? buildAffinityProfile(uid) : Promise.resolve(EMPTY_PROFILE),
      uid ? supabase.from('follows').select('following_id').eq('follower_id', uid) : Promise.resolve({ data: [] as any }),
      // No FILMS in the swipe-through feed (owner decision): reels stay
      // snackable; films live on the Laybell TV shelf, Home (earned) and the
      // profile grid. A film the user TAPPED still plays — it arrives via the
      // tapped-id fetch below, with regular reels flowing after it. NULL
      // durations (old posts) must stay in, hence the or() over lte().
      //
      // The one way past that is asking for films BY NAME in the dropdown, which
      // flips the comparison rather than dropping it. The default is unchanged.
      (reelFilter === 'films'
        ? supabase
          .from('posts').select(SELECT)
          // Films are video by definition — a slideshow has no duration to be
          // long. Stated rather than left to the duration filter to imply it.
          .eq('is_public', true).eq('type', 'video')
          .gt('duration_seconds', FILM_SECONDS)
        : supabase
          .from('posts').select(SELECT)
          .eq('is_public', true).in('type', ['video', 'slideshow'])
          .or(`duration_seconds.is.null,duration_seconds.lte.${FILM_SECONDS}`)
      ).order('created_at', { ascending: false }).limit(40),
      uid ? supabase.from('likes').select('post_id').eq('user_id', uid) : Promise.resolve({ data: [] as any }),
      uid ? supabase.from('saves').select('post_id').eq('user_id', uid) : Promise.resolve({ data: [] as any }),
    ]);
    const followingSet = new Set<string>((followingRes.data ?? []).map((f: any) => f.following_id));
    const data = postsRes.data;

    const now = Date.now();
    let list = attachEngagementCountsAll(data)
      // dampSlideshows: reels stays a video surface. A carousel enters heavily
      // damped and climbs back on engagement, so slideshows are rare here
      // without being shut out — see SLIDESHOW_REELS_BASE_MUL.
      .map((p) => ({ p, s: scorePost(p, profile, followingSet, seen, now, { dampSlideshows: true }) }))
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
    const ordered0 = start ? [start, ...list] : list;
    // Preserve the served spotlight flag on the tapped reel — the refetched DB
    // rows don't carry the __spotlight meta the feed attached, so re-tag it so
    // the subtle sparkle emblem stays by the username. The TAGGED array is what
    // both setPosts and the later ad-weave use — weaving from the untagged one
    // silently dropped the sparkle again.
    const ordered1 = seed?.__spotlight
      ? ordered0.map((p) => (p.id === seed.id ? { ...p, __spotlight: seed.__spotlight } : p))
      : ordered0;
    // Applied LAST, over the relevance-scored order, so within each kind the
    // ranking the scorer produced is preserved intact.
    const ordered = orderByReelKind(ordered1, reelFilter);
    setPosts(ordered);
    setVisibleId(ordered[0]?.id ?? null);
    // Flag which loaded reels are spotlighted right now (one batched query), so
    // the sparkle shows globally — not just on a feed-tapped reel.
    fetchSpotlightedPostIds(ordered.map((p) => p.id)).then(setSpotlightIds);

    if (uid) {
      setLiked(new Set((likesRes.data ?? []).map((r: any) => r.post_id)));
      setSaved(new Set((savesRes.data ?? []).map((r: any) => r.post_id)));
    }
    recordSeenPostIds(ordered.map((p) => p.id));
    setLoading(false);

    // Ad inventory for the dynamic scheduler (see the viewability handler): no
    // load-time weave — ads insert just-in-time when both the posts-scrolled
    // and time-elapsed gates pass. A slow inventory fetch costs nothing: the
    // counters accrue regardless, and the first due-check after the pool lands
    // can insert immediately (the old weave gave up entirely if the user had
    // already scrolled past index 2 by the time ads arrived).
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
      .then((pool) => { reelAdPoolRef.current = pool; })
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
    // Optimistic count beside the bookmark, mirroring the like button — the
    // icon used to flip while its number sat frozen until a full reload.
    setPosts((prev) => prev.map((p) => p.id !== item.id ? p
      : { ...p, save_count: Math.max(0, (p.save_count || 0) + (isSaved ? -1 : 1)) }));
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
      // Seed so the "Laybell TV" row shows instantly on landscape videos.
      aspect: item.aspect_ratio,
      caption: item.caption,
      thumbnail: item.thumbnail_url,
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
    seek: (pid: string, sec: number) => {
      const s = clampToTrim(postsRef.current.find((p) => p.id === pid), sec);
      markManualSeek(s);
      videoRefs.current.get(pid)?.seek(s);
    },
    onProgress: (pid: string, pos: number, dur: number) => {
      if (visibleIdRef.current === pid) {
        // Backward jump = the clip wrapped (played through) → autoplay-next, the
        // same signal + rules the landscape pager and the TV receiver use.
        // Only compare against a baseline from THIS post (see
        // portraitLastPosIdRef). A mismatch means we have no baseline yet for
        // the reel now on screen, so this tick just establishes one.
        if (
          portraitLastPosIdRef.current === pid &&
          pos < portraitLastPosRef.current - WRAP_BACKJUMP_MS
        ) maybeAdvancePortrait();
        portraitLastPosIdRef.current = pid;
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
            // Guard the advance: a block/delete can retroactively strand an ad
            // as the LAST item, where index+1 would throw out-of-range.
            if (index + 1 < posts.length) listRef.current?.scrollToIndex({ index: index + 1, animated: true });
          }}
          // Played all the way through and never skipped → bill a COMPLETE (not a
          // skip), release the lock, and roll on, so nobody sits on a looping ad.
          onComplete={() => {
            recordAdComplete(item, 'reels', currentUserId);
            unlockAd(item.id);
            if (index + 1 < posts.length) listRef.current?.scrollToIndex({ index: index + 1, animated: true });
          }}
          // The ad's Skip countdown reached zero — release the swipe lock so the
          // user can page past (the same moment the Skip button becomes tappable).
          onSkippableChange={(can) => { if (can) unlockAd(item.id); }}
          onCta={() => openAdCta(item, 'reels', currentUserId)}
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

  const onOverlayAdCta = (item: any) => openAdCta(item, 'tv', currentUserId);
  const onOverlayAdReport = (item: any) => {
    const ad = item.__ad;
    if (ad) openAdOptions({ campaignId: ad.campaignId, creativeId: ad.creativeId, advertiserName: ad.advertiserName });
  };

  // A single page of the landscape fullscreen pager: the video filling the
  // sideways screen (letterboxed via contain) with tap-to-pause. Only the reel
  // we rotated from resumes its position; freshly-swiped ones start at 0.
  function renderOverlayItem({ item }: { item: any }) {
    // Falling back to a DERIVED Cloudflare Stream poster is what stops a swipe
  // landing on an empty rectangle. A post with no thumbnail_url and no
  // cover_url previously rendered nothing under the player, so the page arrived
  // in two stages — chrome and caption instantly, then a blank video area until
  // the first frame decoded. Every Stream VOD already serves a poster frame at
  // a URL derivable from its manifest (lib/cast.cfStreamThumbnail, which the
  // TV cast path has always used); the viewer just never asked for it.
  const poster = item.thumbnail_url ?? item.cover_url ?? cfStreamThumbnail(item.media_url);
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
            showStallIndicator
            muted={songPlaysFor(item)}
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
                // Films: the watch-time ad clock (fires the TV cover at its marks).
                maybeFilmAdBreak(item, pos, dur);
              }
              trackVideoProgress(item.id, pos, dur);
            }}
          />
          </ZoomableView>
        </TouchableOpacity>
        {/* double-tap-to-like heart burst, centered over the active landscape reel */}
        {overlayId === item.id && overlayHeart}
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

          {/* Kind dropdown. Portrait only — the landscape overlay is its own
              fullscreen surface with no room (or need) for it, and it is hidden
              while an unskippable ad holds the page so the feed cannot be
              swapped out from under one. */}
          {/* Tap-anywhere-to-dismiss. Without it the menu sits open while the tap
              that was meant to close it pauses the video underneath instead. */}
          {filterOpen && (
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={() => setFilterOpen(false)}
            />
          )}
          {!landscapeFullscreen && !settledIsLockedAd && (
            <View style={[styles.filterWrap, { top: insets.top + 8 }]} pointerEvents="box-none">
              <TouchableOpacity
                style={styles.filterPill}
                onPress={() => setFilterOpen((o) => !o)}
                activeOpacity={0.85}
                accessibilityRole="button"
              >
                <Text style={styles.filterPillText}>{t(`reel.filter.${reelFilter}`)}</Text>
                {/* One glyph that turns over, rather than two that swap. The
                    swap was an instant state change next to an animated menu,
                    which is the half that read as unfinished. */}
                <Animated.View
                  style={{ transform: [{ rotate: menuAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] }}
                >
                  <Ionicons name="chevron-down" size={FILTER_CHEVRON} color={FILTER_CHEVRON_COLOR} />
                </Animated.View>
              </TouchableOpacity>
              <Animated.View
                pointerEvents={filterOpen ? 'auto' : 'none'}
                style={[styles.filterMenu, {
                  opacity: menuAnim,
                  transform: [
                    { translateY: menuAnim.interpolate({ inputRange: [0, 1], outputRange: [-7, 0] }) },
                  ],
                }]}
              >
                {REEL_FILTERS.map((f) => (
                  <TouchableOpacity
                    key={f}
                    style={styles.filterItem}
                    onPress={() => { setFilterOpen(false); if (f !== reelFilter) setReelFilter(f); }}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.filterItemText, f === reelFilter && styles.filterItemTextOn]}>
                      {t(`reel.filter.${f}`)}
                    </Text>
                    {f === reelFilter && <Ionicons name="checkmark" size={15} color="#fff" />}
                  </TouchableOpacity>
                ))}
              </Animated.View>
            </View>
          )}

          {/* Back button */}
          <TouchableOpacity style={[styles.back, { top: insets.top + 8 }]} onPress={dismiss} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
            <Ionicons name="chevron-back" size={28} color="#fff" />
          </TouchableOpacity>

          {/* Sound toggle for the attached song (when the focused reel has one) */}
          {songPlaysFor(visibleItem) && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={songMuted ? t('a11y.unmute') : t('a11y.mute')} style={[styles.muteBtn, { top: insets.top + 8 }]} onPress={toggleSongMuted}>
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
                  onSeek={(sec) => {
                    const oid = overlayIdRef.current ?? '';
                    const s = clampToTrim(landscapeReelsRef.current.find((p: any) => p.id === oid), sec);
                    markManualSeek(s);
                    overlayRefs.current.get(oid)?.seek(s);
                  }}
                />
              )}
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')}
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
                  // Bill a COMPLETE — the cover used to record impressions only,
                  // so TV analytics never saw a completed play.
                  onDone={() => {
                    recordAdComplete(overlayAd, 'tv', currentUserId);
                    dismissOverlayAd();
                  }}
                  // Skip (skip15 / simple-shop skip10) → same: reveal and play
                  // the video underneath, billing the skip.
                  onSkip={() => {
                    recordAdSkip(overlayAd, 'tv', currentUserId);
                    dismissOverlayAd();
                  }}
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
  // Centred in the full-screen page: a carousel is as tall as its own aspect,
  // not the screen, so the bands above and below are simply the page showing.
  slideshowReel: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  root: { flex: 1 },
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: colors.textSecondary, fontSize: 15 },

  back: { position: 'absolute', left: SPACING.sm, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  // Centred on the screen rather than laid out beside the back button, so the
  // pill stays optically centred no matter how long the translated label is.
  // Height matches `back` so the two read as one row.
  filterWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // Bare text, no pill. A chip would read as a control sitting on the video;
  // this is a title that happens to open, which is how the big apps carry it.
  filterPill: {
    flexDirection: 'row', alignItems: 'center', gap: FILTER_GAP,
    height: 44,
    // Not paddingHorizontal — the asymmetry is the point. See FILTER_CHEVRON.
    paddingLeft: FILTER_CHEVRON + FILTER_GAP,
    paddingRight: 0,
  },
  // Fixed white, never the theme text colour: this floats over video, which is
  // dark whatever theme the app is in. The shadow is doing the work the removed
  // pill used to — it is the only thing keeping the label legible over a bright
  // frame now that there is no scrim behind it.
  filterPillText: {
    color: '#fff', fontSize: 25, fontWeight: '900', letterSpacing: -0.5,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6,
  },
  filterMenu: {
    marginTop: 6, minWidth: 150, overflow: 'hidden',
    borderRadius: RADIUS.md, backgroundColor: 'rgba(20,20,20,0.96)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.16)',
  },
  filterItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: SPACING.md, paddingVertical: 11, paddingHorizontal: SPACING.md,
  },
  filterItemText: { color: 'rgba(255,255,255,0.72)', fontSize: 14, fontWeight: '600' },
  filterItemTextOn: { color: '#fff', fontWeight: '800' },
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
