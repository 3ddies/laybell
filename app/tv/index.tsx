import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Image, RefreshControl, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import TVVideoList from '../../components/TVVideoList';
import { Skeleton, SkeletonLine, ListRowsSkeleton } from '../../components/Skeleton';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useSearchSwipeLock } from '../../contexts/PagerContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { fetchFilms, fetchHorizontalVideos, matchesQuery, rankVideosForUser } from '../../lib/tv';
import { fetchLiveStreams, liveThumbnailUrl, type LiveStream } from '../../lib/live';
import { selection } from '../../lib/haptics';
import { useCast } from '../../contexts/CastContext';
import { useListenMode } from '../../contexts/ListenModeContext';
import TVConnectModal from '../../components/TVConnectModal';
import { postToCastItem, liveToCastItem, adToCastItem, type CastItem } from '../../lib/cast';
import { fetchTvAds, tvItemFor, TV_AD_EVERY_VIDEOS, TV_AD_FIRST_VIDEOS, type AdViewer } from '../../lib/ads';
import { EMPTY_PROFILE, buildAffinityProfile } from '../../lib/feedScorer';

// Laybell TV — a horizontal-only video hub. It adds NO new media types: the
// Videos tab is the existing reel-explore grid filtered to landscape videos,
// and the Lives tab lists live broadcasts flagged horizontal. Both hand off to
// the already-built viewers (/reel/[id], /live).

type Tab = 'videos' | 'lives';

// Weave sponsored Laybell TV cards into the ranked grid AFTER the Recommended
// row (indices 0-3 stay organic). First ad a couple of grid videos in, then
// spaced out; a small ad pool rotates and is capped so it never floods the grid.
function weaveTvAds(videos: any[], adItems: any[]): any[] {
  if (!adItems.length || !videos.length) return videos;
  const FEATURED = 4;     // Recommended row — kept ad-free
  const FIRST_GRID = 2;   // first ad after 2 grid videos
  const EVERY = 6;        // then one every 6 grid videos
  const MAX = adItems.length * 3;
  const out: any[] = [];
  let placed = 0;
  let gridIdx = 0;
  for (let i = 0; i < videos.length; i++) {
    out.push(videos[i]);
    if (i < FEATURED) continue;
    gridIdx++;
    if (placed < MAX && gridIdx >= FIRST_GRID && (gridIdx - FIRST_GRID) % EVERY === 0) {
      out.push(adItems[placed % adItems.length]);
      placed++;
    }
  }
  return out;
}

// Loading-skeleton geometry — mirrors TVVideoList (a portrait Recommended row +
// a 2-up landscape grid).
const TV_SW = Dimensions.get('window').width;
const TV_GAP = SPACING.sm;
const TV_COL_W = (TV_SW - SPACING.md * 2 - TV_GAP) / 2;
const TV_COL_THUMB_H = TV_COL_W * (9 / 16);
const TV_FEAT_W = Math.round((TV_SW - SPACING.md * 2) * 0.42);
const TV_FEAT_H = Math.round(TV_FEAT_W * 1.3);

export default function LaybellTVScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const cast = useCast();
  const { confirmLeaveListen } = useListenMode();

  const [tab, setTab] = useState<Tab>('videos');
  const [searchOpen, setSearchOpen] = useState(false);
  // No swipe-back while the search bar is open — see explore.tsx.
  useSearchSwipeLock(searchOpen);
  const [query, setQuery] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);

  const [videos, setVideos] = useState<any[]>([]);
  // `ranked` = videos in personalized relevance order (drives the Recommended row
  // + the grid order); `videos` stays newest-first for search.
  const [ranked, setRanked] = useState<any[]>([]);
  // The RAW eligible TV sponsors, kept independent of the grid weave. The cast
  // queue MUST use this — not `ranked.filter(v => v.__ad)`. weaveTvAds is a
  // LAYOUT concern (skips the 4 Recommended tiles, first ad only at the 6th
  // video, capped), so deriving the cast pool from it meant the TV inherited the
  // grid's layout rules and could get zero sponsors even while plenty were
  // eligible. Every other surface holds its own pool straight from fetchTvAds —
  // this makes casting consistent with them.
  const [tvAdItems, setTvAdItems] = useState<any[]>([]);
  // The Films shelf (Premium+ long-form). Hidden until any films exist.
  const [films, setFilms] = useState<any[]>([]);
  const [lives, setLives] = useState<LiveStream[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(true);
  const [loadingLives, setLoadingLives] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadVideos = useCallback(async () => {
    try {
      // The Films shelf loads alongside the grid — best-effort, never blocking.
      const [vids, filmRows] = await Promise.all([
        fetchHorizontalVideos(),
        fetchFilms(profile?.id ?? null).catch(() => []),
      ]);
      setVideos(vids);
      setFilms(filmRows);
      const rankedVids = await rankVideosForUser(vids, profile?.id ?? null);
      // Fetch the eligible TV sponsors ONCE, then use them two independent ways:
      //   • tvAdItems  — the raw pool the CAST queue weaves from (see castVideo)
      //   • weaveTvAds — a LAYOUT-only pass for the on-phone grid
      // The affinity profile is REQUIRED, not an optimization: targetingMatch
      // hard-fails any campaign with `target_genres` when the viewer's top genres
      // are empty, so EMPTY_PROFILE here silently dropped genre-targeted ads and
      // made this surface behave differently from every other one.
      let withAds = rankedVids;
      try {
        const uid = profile?.id ?? null;
        const affinity = uid ? await buildAffinityProfile(uid) : EMPTY_PROFILE;
        const viewer: AdViewer = {
          id: uid,
          profile: profile ? {
            age: (profile as any).age, gender: (profile as any).gender,
            latitude: (profile as any).latitude, longitude: (profile as any).longitude,
          } : null,
          affinity,
        };
        const ads = await fetchTvAds(viewer);
        const items = ads.map((s, i) => tvItemFor(s, i));
        setTvAdItems(items);
        if (items.length) withAds = weaveTvAds(rankedVids, items);
      } catch { /* ads are best-effort — never block the grid */ }
      setRanked(withAds);
    } catch { /* pre-migration / offline */ }
    setLoadingVideos(false);
  }, [profile]);
  const loadLives = useCallback(async () => {
    try { setLives(await fetchLiveStreams(true)); } catch { /* offline */ }
    setLoadingLives(false);
  }, []);

  useEffect(() => { loadVideos(); loadLives(); }, [loadVideos, loadLives]);

  // NOTE: the cast session deliberately OUTLIVES this screen. Leaving Laybell TV
  // keeps the TV playing and the CastBar rides along app-wide (cast-and-browse);
  // the session only ends on a manual disconnect or a receiver/network drop. Do
  // NOT re-add a disconnect-on-unmount here.

  // Searching flattens to a single 2-up grid of matches. Otherwise the top 4
  // personalized picks become the Recommended row and the rest fill the grid.
  const searching = query.trim().length > 0;
  // Films on the shelf stay off the Recommended row and out of the grid — one
  // home each. While searching, films join the flat results like any video.
  const filmIds = new Set(films.map((f) => f.id));
  const featured = searching ? [] : ranked.filter((v) => !filmIds.has(v.id)).slice(0, 4);
  const featuredIds = new Set(featured.map((v) => v.id));
  const gridVideos = searching
    ? videos.filter((v) => matchesQuery(v, query))
    : ranked.filter((v) => !featuredIds.has(v.id) && !filmIds.has(v.id));

  // ── Cast handoff (only when a session is live) ─────────────────────────────
  // Tapping a TV item while connected throws it to the TV with the visible list
  // as the queue (so next/prev + autoplay-next roll through Laybell TV), instead
  // of opening the on-phone viewer. Scoped to TV content — nothing else casts.
  const castVideo = (post: any) => {
    const item = postToCastItem(post);
    if (!item) return;
    const source = searching ? gridVideos : ranked;
    const realVideos = source.filter((v) => !v.__ad);
    // Use the RAW sponsor pool, NOT `source.filter(v => v.__ad)`. The grid's
    // woven ads are a layout artifact (skips the 4 Recommended tiles, first ad
    // only at the 6th video, capped) — inheriting that meant the TV could get
    // zero sponsors while plenty were eligible. tvAdItems is the same pool every
    // other surface uses. CASTABLE sponsors only: simple shop ads have no
    // media_url (cover + phone-played audio), and a null adToCastItem at the
    // rotation position would otherwise wedge the weave on it forever.
    const adPool = tvAdItems.filter((a) => !!a.media_url);
    // Order from the TAPPED video so the ad cadence counts from here, then BAKE a
    // sponsor into the queue after every TV_AD_EVERY_VIDEOS videos. Pre-weaving
    // (vs injecting on video-finish) is what makes ads show whether the user lets
    // videos auto-advance OR taps "next" on the remote — the finish-only path
    // never fired for next-taps, so ads never got queued.
    const startIdx = Math.max(0, realVideos.findIndex((v) => v.id === post.id));
    const ordered = [...realVideos.slice(startIdx), ...realVideos.slice(0, startIdx)];
    const queue: CastItem[] = [];
    let adRot = 0;
    // FIRST sponsor after TV_AD_FIRST_VIDEOS, every later one after
    // TV_AD_EVERY_VIDEOS — counted since the last sponsor rather than by a
    // modulo on the index, which is what lets the opening gap differ.
    let sinceAd = 0;
    let need = TV_AD_FIRST_VIDEOS;
    for (let i = 0; i < ordered.length; i++) {
      const ci = postToCastItem(ordered[i]);
      if (ci) { queue.push(ci); sinceAd++; }
      if (adPool.length && sinceAd >= need) {
        const ad = adToCastItem(adPool[adRot % adPool.length]);
        if (ad) { queue.push(ad); adRot++; sinceAd = 0; need = TV_AD_EVERY_VIDEOS; }
      }
    }
    selection(); // a tick as the video leaves the phone for the TV
    cast.cast(item, queue);
  };
  // Returns true if it cast. Encoder (RTMP) lives cast via their live HLS
  // manifest; phone (WHIP) lives have no HLS during Cloudflare's WebRTC beta
  // (see lib/cast.liveHlsUrl), so those return false and the caller falls
  // back to the on-phone live viewer.
  const castLive = (live: LiveStream): boolean => {
    const item = liveToCastItem(live);
    if (!item) return false;
    const queue = lives.map(liveToCastItem).filter(Boolean) as CastItem[];
    selection();
    cast.cast(item, queue);
    return true;
  };

  return (
    <SwipeBackPager>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          {/* Wordmark only. The orange TV glyph competed with a title that is
              now large enough to carry the screen by itself — and the icon was
              also doing duty in the cast button and the empty state, so it read
              as decoration here rather than meaning. */}
          <View style={styles.titleWrap}>
            <Text style={styles.headerTitle}>{t('tv.title')}</Text>
          </View>
          <View style={styles.headerRight}>
            {/* Search lives here, in the header, rather than beside the tabs —
                it acts on the whole screen, not on one tab. The live button
                that used to sit here is redundant: the Home header carries the
                same one, and this screen is already reached from it. */}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('tv.searchPlaceholder')}
              style={[styles.searchCircle, searchOpen && styles.searchCircleActive]}
              onPress={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(''); }}
            >
              <Ionicons name={searchOpen ? 'close' : 'search'} size={18} color={searchOpen ? colors.primary : colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        {/* "Watch on TV" — the ALWAYS-VISIBLE way in. The old affordances (the
            AirPlay/Cast header icons) only appear once a device is discovered,
            which reads as "the feature doesn't exist" — this banner opens the
            guided connect wizard no matter what, and flips to a live "casting
            to" state once a session is up. */}
        <TouchableOpacity onPress={() => setConnectOpen(true)} activeOpacity={0.9} style={styles.tvBannerWrap}>
          {cast.connected ? (
            /* Connected reads as GO: solid green bubble, white text — the same
               visual weight as the gradient "Watch on TV" pill it replaces. */
            <View style={[styles.tvBanner, styles.tvBannerConnected]}>
              <Ionicons name="checkmark-circle" size={18} color="#fff" />
              <Text style={styles.tvBannerConnectedText} numberOfLines={1}>
                {t('tv.cast.castingTo', { device: cast.deviceName || t('tv.cast.yourTv') })}
              </Text>
              <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.85)" />
            </View>
          ) : (
            /* One pill for both themes — the accent gradient reads on either
               page, and the earlier inverted-for-dark variant was solving a
               contrast problem the orange never actually had.
               No glyphs: a tv icon and a chevron flanking three words made the
               label look like a row of things rather than one button. Centred
               bold text is the whole control. */
            <LinearGradient
              colors={GRADIENTS.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.tvBanner}
            >
              <Text style={styles.tvBannerText}>{t('tv.setup.watchOnTv')}</Text>
            </LinearGradient>
          )}
        </TouchableOpacity>

        {/* Segmented tabs. Search moved up into the header. */}
        <View style={styles.tabRow}>
          <View style={styles.segment}>
            {(['videos', 'lives'] as Tab[]).map((k) => (
              <TouchableOpacity
                key={k}
                style={[styles.segmentBtn, tab === k && styles.segmentBtnActive]}
                onPress={() => setTab(k)}
              >
                <Text style={[styles.segmentText, tab === k && styles.segmentTextActive]}>{t(`tv.tab.${k}`)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {searchOpen && (
          <View style={styles.searchBar}>
            <Ionicons name="search" size={16} color={colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder={t('tv.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoFocus
              returnKeyType="search"
            />
          </View>
        )}

        {tab === 'videos' ? (
          loadingVideos ? (
            <View style={styles.videoSkeleton}>
              <SkeletonLine w="55%" h={15} />
              <View style={styles.videoSkeletonFeat}>
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} width={TV_FEAT_W} height={TV_FEAT_H} radius={RADIUS.md} />
                ))}
              </View>
              <SkeletonLine w="40%" h={15} style={{ marginTop: SPACING.sm }} />
              <View style={styles.videoSkeletonGrid}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <View key={i} style={styles.videoSkeletonCard}>
                    <Skeleton width={TV_COL_W} height={TV_COL_THUMB_H} radius={RADIUS.md} />
                    <SkeletonLine w="80%" h={11} />
                    <SkeletonLine w="45%" h={10} />
                  </View>
                ))}
              </View>
            </View>
          ) : (
            <TVVideoList
              posts={gridVideos}
              featured={featured}
              films={searching ? [] : films}
              currentUserId={profile?.id ?? null}
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await loadVideos(); setRefreshing(false); }}
              bottomPad={insets.bottom + 24}
              emptyText={query.trim() ? t('tv.noResults') : t('tv.noVideos')}
              castActive={cast.connected}
              onCast={castVideo}
              castingId={cast.current?.id ?? null}
              onPostDeleted={(id) => {
                setVideos((prev) => prev.filter((p) => p.id !== id));
                setRanked((prev) => prev.filter((p) => p.id !== id));
                setFilms((prev) => prev.filter((p) => p.id !== id));
              }}
            />
          )
        ) : loadingLives ? (
          <ListRowsSkeleton rows={5} />
        ) : (
          <FlatList
            data={lives}
            keyExtractor={(l) => l.id}
            contentContainerStyle={styles.livesContent}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.textSecondary}
                onRefresh={async () => { setRefreshing(true); await loadLives(); setRefreshing(false); }}
              />
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.liveCard}
                onPress={() => {
                  // With a TV connected, encoder lives cast like regular videos
                  // (live HLS fills the screen); phone lives — no HLS during
                  // Cloudflare's beta — open the on-phone viewer instead.
                  if (cast.connected && castLive(item)) return;
                  confirmLeaveListen(() => router.push({ pathname: '/live', params: { streamId: item.id } }));
                }}
                activeOpacity={0.85}
              >
                {/* Landscape frame: a captured Cloudflare live thumbnail (encoder
                    lives) layered over an avatar/gradient fallback, so phone lives
                    — which have no thumbnail during Cloudflare's beta — still show
                    the host. LIVE pill sits on the frame. */}
                <View style={styles.liveThumb}>
                  {item.profile?.avatar_url ? (
                    <Image source={{ uri: item.profile.avatar_url }} style={StyleSheet.absoluteFill} blurRadius={8} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.avatar} style={StyleSheet.absoluteFill} />
                  )}
                  {!item.profile?.avatar_url && (
                    <Text style={styles.liveInitial}>
                      {(item.profile?.display_name || item.profile?.username || '?').charAt(0).toUpperCase()}
                    </Text>
                  )}
                  {liveThumbnailUrl(item) && (
                    <ExpoImage
                      source={{ uri: liveThumbnailUrl(item)! }}
                      style={StyleSheet.absoluteFill}
                      contentFit="cover"
                      transition={150}
                    />
                  )}
                  <View style={styles.liveThumbPill}><Text style={styles.livePillText}>{t('live.live')}</Text></View>
                </View>
                <View style={styles.liveInfo}>
                  <Text style={styles.liveTitle} numberOfLines={1}>
                    {item.title || item.profile?.display_name || item.profile?.username || t('tv.liveUntitled')}
                  </Text>
                  <Text style={styles.liveHost} numberOfLines={1}>
                    {item.profile?.display_name || item.profile?.username || ''}
                  </Text>
                </View>
                {cast.connected && item.mode === 'rtmp' && (
                  <Ionicons name="tv" size={18} color={colors.primary} style={{ marginRight: 4 }} />
                )}
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="tv-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{t('tv.noLives')}</Text>
              </View>
            }
          />
        )}

        <TVConnectModal visible={connectOpen} onClose={() => setConnectOpen(false)} />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 6 },
  titleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  // Deliberately a step BELOW the Films shelf title (30/900) on this same
  // screen. Laybell TV is the container and Films is the flagship inside it, so
  // TV reading slightly quieter is the hierarchy working — matching weights
  // would flatten it. Owner-tuned 2026-08-07; don't "unify" these sizes.
  headerTitle: { color: c.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  tvBannerWrap: { marginHorizontal: SPACING.md, marginTop: 6 },
  tvBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: RADIUS.full, paddingVertical: 11, paddingHorizontal: 16,
  },
  tvBannerText: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: -0.1, textAlign: 'center' },
  tvBannerConnected: { backgroundColor: c.success },
  tvBannerConnectedText: { flex: 1, color: '#fff', fontSize: 13.5, fontWeight: '700' },
  tabRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: SPACING.md, marginTop: 4, marginBottom: 10 },
  segment: { flex: 1, flexDirection: 'row', backgroundColor: c.surfaceLight, borderRadius: RADIUS.full, padding: 3 },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: RADIUS.full },
  segmentBtnActive: { backgroundColor: c.surfaceElevated },
  segmentText: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: c.text },
  searchCircle: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceLight,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border,
  },
  searchCircleActive: { borderColor: c.primary },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: SPACING.md, marginBottom: 10,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, paddingHorizontal: 12,
    borderWidth: 1, borderColor: c.borderStrong,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 14, paddingVertical: 10 },
  videoSkeleton: { paddingHorizontal: SPACING.md, paddingTop: 2, gap: SPACING.sm },
  videoSkeletonFeat: { flexDirection: 'row', gap: TV_GAP },
  videoSkeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: TV_GAP },
  videoSkeletonCard: { width: TV_COL_W, gap: 6 },
  livesContent: { paddingHorizontal: SPACING.md, gap: 10, paddingBottom: 40 },
  liveCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 10,
  },
  // Landscape live frame (16:9-ish tile leading the card).
  liveThumb: {
    width: 96, height: 54, borderRadius: RADIUS.sm, overflow: 'hidden',
    backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center',
  },
  liveInitial: { color: '#fff', fontSize: 20, fontWeight: '700' },
  liveThumbPill: {
    position: 'absolute', bottom: 4, left: 4,
    backgroundColor: '#F43F5E', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2,
  },
  liveInfo: { flex: 1, gap: 2 },
  liveTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  liveHost: { color: c.textTertiary, fontSize: 12 },
  livePillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  empty: { alignItems: 'center', gap: 10, marginTop: 40 },
  emptyText: { color: c.textTertiary, fontSize: 13, textAlign: 'center', paddingHorizontal: 30 },
});
