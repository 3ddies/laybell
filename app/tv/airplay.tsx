import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Image, Platform, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { useAudio } from '../../contexts/AudioContext';
import { useMediaSuspend } from '../../contexts/MediaSuspendContext';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { fetchHorizontalVideos, rankVideosForUser } from '../../lib/tv';
import {
  fetchTvAds, tvItemFor, TV_AD_EVERY_VIDEOS, recordAdImpression, recordAdClick, adSkipAfterMs,
  type AdViewer,
} from '../../lib/ads';
import { EMPTY_PROFILE, buildAffinityProfile } from '../../lib/feedScorer';
import { postToCastItem, adToCastItem, type CastItem } from '../../lib/cast';
import { selection } from '../../lib/haptics';
import Scrubber from '../../components/Scrubber';

// ─── Laybell TV over AirPlay (iOS) — a DEDICATED, fully isolated screen ───────
//
// This is intentionally NOT part of CastContext / the Chromecast phone-remote.
// AirPlay makes the PHONE the source, so the model is: the phone plays the
// ranked horizontal feed with autoplay, and iOS routes that one player's video
// to the TV — the TV simply FOLLOWS the phone's algorithm + autoplay. One
// screen, one player, nothing shared.
//
// Why a separate screen fixes the whole class of bugs the unified attempt hit:
//   • Audio isolation — an AirPlay session routes the app's WHOLE shared audio
//     session to the TV, so EVERYTHING else that makes sound must be silenced.
//     On mount we suspend() (pauses feed videos + the ambient song player) AND
//     pause the main music engine. Only THIS player reaches the TV.
//   • No now-playing collision — we never set showNowPlayingNotification (the
//     app's expo-video patch assumes it stays off; TrackPlayer owns that card).
//   • No volume fighting — no in-app volume control (software volume doesn't
//     ride the AirPlay route); the TV's own remote governs loudness.
//   • Clean lifecycle — leaving this screen stops the player and restores all
//     phone audio. Nothing lingers.

const VIDEOS_PER_FETCH = 40;

let VideoAirPlayButton: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  VideoAirPlayButton = require('expo-video').VideoAirPlayButton;
} catch { /* expo-video without the AirPlay view — the pill shows the update note */ }

const fmtTime = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

export default function AirPlayTvScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useProfile();
  const audio = useAudio();
  const { suspend, resume } = useMediaSuspend();
  const linkGuard = useLinkGuard();

  const uidRef = useRef<string | null>(profile?.id ?? null);
  uidRef.current = profile?.id ?? null;

  // ── Queue + playback state ────────────────────────────────────────────────
  const queueRef = useRef<CastItem[]>([]);
  const indexRef = useRef(0);
  const advancedRef = useRef(false); // guards playToEnd firing once per clip
  const [current, setCurrent] = useState<CastItem | null>(null);
  const [nextItem, setNextItem] = useState<CastItem | null>(null);
  const [phase, setPhase] = useState<'loading' | 'empty' | 'error' | 'ready'>('loading');
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [routing, setRouting] = useState(false); // isExternalPlaybackActive
  const [pos, setPos] = useState(0);             // seconds
  const [dur, setDur] = useState(0);

  // ── The ONE player. allowsExternalPlayback on so iOS can route it to the TV;
  //    showNowPlayingNotification deliberately LEFT OFF (default). ────────────
  const player = useVideoPlayer(null, (p) => {
    try {
      (p as any).allowsExternalPlayback = true;
      p.loop = false;                 // we drive autoplay-next
      p.muted = false;
      p.timeUpdateEventInterval = 0.5;
      try { (p as any).bufferOptions = { preferredForwardBufferDuration: 8 }; } catch {}
    } catch {}
  });

  // ── Build the ad-woven, algorithm-ranked queue (same cadence as Chromecast) ─
  const buildQueue = useCallback(async (): Promise<CastItem[]> => {
    const vids = await fetchHorizontalVideos(VIDEOS_PER_FETCH);
    const ranked = await rankVideosForUser(vids, uidRef.current);
    const realItems = ranked.map(postToCastItem).filter(Boolean) as CastItem[];
    if (!realItems.length) return [];

    // Ad pool — RAW from fetchTvAds (never the grid weave). Affinity is REQUIRED
    // (EMPTY_PROFILE silently drops genre-targeted campaigns). Best-effort.
    let adItems: CastItem[] = [];
    try {
      const uid = uidRef.current;
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
      adItems = ads.map((s, i) => adToCastItem(tvItemFor(s, i))).filter(Boolean) as CastItem[];
    } catch { /* ads are best-effort — never block playback */ }

    // Weave a sponsor in after every TV_AD_EVERY_VIDEOS videos.
    const queue: CastItem[] = [];
    let adRot = 0;
    for (let i = 0; i < realItems.length; i++) {
      queue.push(realItems[i]);
      if (adItems.length && (i + 1) % TV_AD_EVERY_VIDEOS === 0) {
        queue.push(adItems[adRot % adItems.length]);
        adRot++;
      }
    }
    return queue;
  }, [profile]);

  // Stable handle to the latest buildQueue for the once-wired playToEnd listener
  // (so refreshing the feed on loop never re-subscribes the player listeners).
  const buildQueueRef = useRef(buildQueue);
  buildQueueRef.current = buildQueue;

  const refreshNextItem = useCallback(() => {
    const q = queueRef.current;
    if (!q.length) { setNextItem(null); return; }
    const n = (indexRef.current + 1) % q.length;
    setNextItem(n === indexRef.current ? null : q[n]);
  }, []);

  const loadIndex = useCallback((i: number) => {
    const q = queueRef.current;
    if (!q.length) return;
    const idx = ((i % q.length) + q.length) % q.length; // wrap → endless loop
    const item = q[idx];
    if (!item) return;
    indexRef.current = idx;
    advancedRef.current = false;
    setCurrent(item);
    setPos(0); setDur(0);
    setBuffering(true);
    refreshNextItem();
    try {
      player.replace({ uri: item.url });
      player.play();
    } catch { /* transient — statusChange 'error' handles recovery */ }
    // A sponsor reaching the TV is a TV-placement impression (deduped per campaign).
    if (item.isAd && item.ad) { try { recordAdImpression({ __ad: item.ad }, 'tv'); } catch {} }
  }, [player, refreshNextItem]);

  // ── Mount: silence all other phone audio, then load the feed ──────────────
  const wasMusicPlayingRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return; // AirPlay is iOS-only (Android → Chromecast)
    let alive = true;

    // Suspend feed videos + ambient song player (media-suspend is ref-counted).
    suspend();
    // The main music engine is deliberately outside media-suspend, so pause it
    // explicitly — its audio would otherwise ride the shared session to the TV.
    wasMusicPlayingRef.current = audio.isPlaying;
    if (audio.isPlaying) { audio.pause().catch(() => {}); }

    (async () => {
      try {
        const q = await buildQueue();
        if (!alive) return;
        if (!q.length) { setPhase('empty'); return; }
        queueRef.current = q;
        setPhase('ready');
        loadIndex(0);
      } catch {
        if (alive) setPhase('error');
      }
    })();

    return () => {
      alive = false;
      try { player.pause(); } catch {}
      try { player.replace(null); } catch {} // drop the AirPlay route
      resume(); // release the media-suspend → feed + ambient resume
      // Restore the user's music if we paused it.
      if (wasMusicPlayingRef.current) { audio.resume().catch(() => {}); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Player listeners (wired once) ─────────────────────────────────────────
  useEffect(() => {
    const subs = [
      player.addListener('statusChange', ({ status }: any) => {
        if (status === 'readyToPlay') { setBuffering(false); }
        else if (status === 'loading' || status === 'buffering') { setBuffering(true); }
        else if (status === 'error') {
          // A single dead clip must not strand the whole session — skip forward.
          setBuffering(false);
          setTimeout(() => { if (queueRef.current.length > 1) loadIndex(indexRef.current + 1); }, 400);
        }
      }),
      player.addListener('playingChange', () => { try { setPlaying(!!(player as any).playing); } catch {} }),
      player.addListener('timeUpdate', (e: any) => {
        setPos(e?.currentTime ?? 0);
        setDur((player as any).duration || 0);
        // Keep the routing flag fresh even if the change event is missed.
        try { setRouting(!!(player as any).isExternalPlaybackActive); } catch {}
      }),
      player.addListener('playToEnd', () => {
        if (advancedRef.current) return;
        advancedRef.current = true;
        const next = indexRef.current + 1;
        if (next < queueRef.current.length) {
          loadIndex(next);
        } else {
          // Reached the end → pull a FRESH ranked feed so the TV keeps flowing
          // with new algorithm picks (the seen-post penalty reorders it) instead
          // of replaying the same loop. Falls back to restarting the current
          // queue if the refresh fails. Buffering overlay covers the brief fetch.
          setBuffering(true);
          (async () => {
            try {
              const q = await buildQueueRef.current();
              if (q.length) queueRef.current = q;
            } catch { /* keep the existing queue */ }
            loadIndex(0);
          })();
        }
      }),
      player.addListener('isExternalPlaybackActiveChange', () => {
        // Track routing state only — never reload/nudge off this event (it can
        // flap on a settling route, and reacting to it repeatedly is what caused
        // the muting regressions). muted=false is a harmless no-op safety.
        try {
          setRouting(!!(player as any).isExternalPlaybackActive);
          player.muted = false;
        } catch {}
      }),
    ];
    return () => subs.forEach((s) => { try { s.remove(); } catch {} });
  }, [player, loadIndex]);

  // ── App background → pause (the route can't render video in the background
  //    anyway); resume on return if we were playing. ─────────────────────────
  const bgWasPlayingRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        bgWasPlayingRef.current = !!(player as any).playing;
        try { player.pause(); } catch {}
      } else if (s === 'active' && bgWasPlayingRef.current) {
        bgWasPlayingRef.current = false;
        try { player.play(); } catch {}
      }
    });
    return () => sub.remove();
  }, [player]);

  // ── Controls ──────────────────────────────────────────────────────────────
  // A sponsor can't be skipped past until its threshold (unskippable = never;
  // skip15 = 11s). Rewind/prev is blocked on an ad too.
  const adLockedNow = () => {
    const it = queueRef.current[indexRef.current];
    if (!it?.isAd) return false;
    return (pos * 1000) < adSkipAfterMs('tv', it.ad?.skipMode);
  };
  const togglePlay = () => {
    selection();
    try { if ((player as any).playing) player.pause(); else player.play(); } catch {}
  };
  const goNext = () => { if (adLockedNow()) return; selection(); loadIndex(indexRef.current + 1); };
  const goPrev = () => { if (adLockedNow()) return; selection(); loadIndex(indexRef.current - 1); };
  const doSeek = (ratio: number) => {
    if (queueRef.current[indexRef.current]?.isAd) return; // no scrubbing sponsors
    try { player.currentTime = Math.max(0, ratio * dur); } catch {}
  };
  const openAdCta = () => {
    const ad = current?.ad;
    if (!ad?.ctaUrl) return;
    linkGuard.open(ad.ctaUrl, {
      context: 'ad',
      sourceName: ad.advertiserName,
      onProceed: () => { try { recordAdClick({ __ad: ad }, 'tv', uidRef.current); } catch {} },
    });
  };
  const exit = () => { selection(); router.back(); };

  // ── Non-iOS guard (AirPlay is Apple-only) ─────────────────────────────────
  if (Platform.OS !== 'ios') {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Ionicons name="tv-outline" size={44} color={colors.textTertiary} />
        <Text style={styles.stateText}>{t('tv.airplay.iosOnly')}</Text>
        <TouchableOpacity onPress={exit} style={styles.ghostBtn}><Text style={styles.ghostBtnText}>{t('tv.airplay.close')}</Text></TouchableOpacity>
      </View>
    );
  }

  const isAd = !!current?.isAd;
  const progress = dur > 0 ? Math.min(1, pos / dur) : 0;
  const adLocked = isAd && adLockedNow();

  return (
    <View style={[styles.root, { paddingTop: insets.top + 6, paddingBottom: insets.bottom + SPACING.lg }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={exit} hitSlop={10} style={styles.headerBtn}>
          <Ionicons name="chevron-down" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Ionicons name="tv" size={14} color={colors.primary} />
          <Text style={styles.headerText} numberOfLines={1}>
            {routing ? t('tv.airplay.playingOn') : t('tv.airplay.title')}
          </Text>
        </View>
        <View style={styles.headerBtn} />
      </View>

      {phase === 'loading' ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : phase === 'empty' ? (
        <View style={styles.center}>
          <Ionicons name="tv-outline" size={44} color={colors.textTertiary} />
          <Text style={styles.stateText}>{t('tv.airplay.empty')}</Text>
        </View>
      ) : phase === 'error' ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={40} color={colors.error} />
          <Text style={styles.stateText}>{t('tv.airplay.error')}</Text>
          <TouchableOpacity onPress={() => { setPhase('loading'); (async () => { try { const q = await buildQueue(); if (!q.length) { setPhase('empty'); return; } queueRef.current = q; setPhase('ready'); loadIndex(0); } catch { setPhase('error'); } })(); }} activeOpacity={0.9}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.retryBtn}>
              <Ionicons name="refresh" size={16} color="#fff" />
              <Text style={styles.retryText}>{t('tv.airplay.retry')}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Video card — a REAL composited layer (needed for the route). When
              routing, the phone shows the poster + a "Playing on TV" badge; when
              not yet routing it previews the video on the phone. */}
          <View style={styles.stage}>
            <VideoView
              style={StyleSheet.absoluteFill}
              player={player}
              contentFit="contain"
              nativeControls={false}
              allowsVideoFrameAnalysis={false}
            />
            {(routing || buffering) && (
              <View style={styles.stageOverlay}>
                {current?.poster ? (
                  <Image source={{ uri: current.poster }} style={StyleSheet.absoluteFill} resizeMode="cover" blurRadius={routing ? 12 : 0} />
                ) : (
                  <LinearGradient colors={GRADIENTS.primarySoft} style={StyleSheet.absoluteFill} />
                )}
                <View style={styles.stageBadge}>
                  {buffering && !routing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="tv" size={22} color="#fff" />
                      <Text style={styles.stageBadgeText}>{t('tv.airplay.playingOn')}</Text>
                    </>
                  )}
                </View>
              </View>
            )}
            {isAd && (
              <View style={styles.sponsorTag}>
                <Ionicons name="megaphone" size={11} color="#fff" />
                <Text style={styles.sponsorTagText}>{t('ad.sponsored')}</Text>
              </View>
            )}
          </View>

          {/* Title + author */}
          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={2}>{current?.title ?? ''}</Text>
            {!!current?.subtitle && <Text style={styles.subtitle} numberOfLines={1}>{current.subtitle}</Text>}
          </View>

          {/* Sponsor CTA (replaces the scrubber for ads) or the scrubber */}
          {isAd ? (
            current?.ad?.ctaUrl ? (
              <TouchableOpacity style={styles.adCta} onPress={openAdCta} activeOpacity={0.85}>
                <Text style={styles.adCtaText}>{current.ad.ctaLabel || t('reelAd.learnMore')}</Text>
                <Ionicons name="arrow-forward" size={16} color="#fff" />
              </TouchableOpacity>
            ) : <View style={styles.scrubSpacer} />
          ) : (
            <View style={styles.scrubBlock}>
              <Scrubber progress={progress} onSeek={doSeek} height={22} trackHeight={4} thumbSize={13} />
              <View style={styles.timeRow}>
                <Text style={styles.time}>{fmtTime(pos)}</Text>
                <Text style={styles.time}>{dur > 0 ? fmtTime(dur) : '–:––'}</Text>
              </View>
            </View>
          )}

          {/* Transport */}
          <View style={styles.controls}>
            <TouchableOpacity onPress={goPrev} disabled={adLocked} hitSlop={10} style={styles.sideBtn}>
              <Ionicons name="play-skip-back" size={26} color={adLocked ? colors.textTertiary : colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={togglePlay} disabled={buffering} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.playBtn}>
                {buffering ? (
                  <ActivityIndicator size="large" color="#fff" />
                ) : (
                  <Ionicons name={playing ? 'pause' : 'play'} size={36} color="#fff" style={playing ? undefined : { marginLeft: 4 }} />
                )}
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={goNext} disabled={adLocked} hitSlop={10} style={styles.sideBtn}>
              <Ionicons name="play-skip-forward" size={26} color={adLocked ? colors.textTertiary : colors.text} />
            </TouchableOpacity>
          </View>

          {/* Up next */}
          {nextItem && (
            <View style={styles.upNext}>
              {nextItem.poster ? (
                <Image source={{ uri: nextItem.poster }} style={styles.upNextThumb} />
              ) : (
                <View style={[styles.upNextThumb, styles.upNextThumbEmpty]}><Ionicons name="play" size={12} color={colors.textTertiary} /></View>
              )}
              <View style={styles.upNextInfo}>
                <Text style={[styles.upNextLabel, nextItem.isAd && { color: colors.primary }]}>
                  {nextItem.isAd ? t('ad.sponsored') : t('tv.cast.upNext')}
                </Text>
                <Text style={styles.upNextTitle} numberOfLines={1}>{nextItem.title}</Text>
              </View>
            </View>
          )}

          <View style={styles.flexSpace} />

          {/* AirPlay connect pill (the REAL native picker button stretched
              invisibly across the pretty pill — same trick as TVConnectModal) +
              a volume hint, since the TV's remote governs volume. */}
          <View style={styles.connectWrap}>
            <LinearGradient colors={routing ? GRADIENTS.primarySoft : GRADIENTS.primary} style={styles.connectBtn}>
              <Ionicons name={routing ? 'checkmark-circle' : 'tv-outline'} size={18} color={routing ? colors.primary : '#fff'} />
              <Text style={[styles.connectText, routing && { color: colors.primary }]}>
                {routing ? t('tv.airplay.connected') : t('tv.airplay.connect')}
              </Text>
            </LinearGradient>
            {VideoAirPlayButton && (
              <VideoAirPlayButton
                tint="transparent"
                activeTint="transparent"
                style={[StyleSheet.absoluteFill, { opacity: 0.02 }]}
              />
            )}
          </View>
          <Text style={styles.volumeHint}>
            {routing ? t('tv.airplay.volumeHint') : t('tv.airplay.connectPrompt')}
          </Text>
        </>
      )}
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background, paddingHorizontal: SPACING.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md },
  stateText: { color: c.textSecondary, fontSize: 15, textAlign: 'center' },
  ghostBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: RADIUS.full, backgroundColor: c.surfaceLight },
  ghostBtnText: { color: c.text, fontSize: 14, fontWeight: '700' },

  header: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  headerText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },

  stage: {
    width: '100%', aspectRatio: 16 / 9, borderRadius: RADIUS.lg, overflow: 'hidden',
    backgroundColor: '#000', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  stageOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000000AA' },
  stageBadge: { alignItems: 'center', gap: 8 },
  stageBadgeText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  sponsorTag: {
    position: 'absolute', top: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#000000AA', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 4,
  },
  sponsorTagText: { color: '#fff', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },

  meta: { marginTop: SPACING.md, gap: 4 },
  title: { color: c.text, fontSize: 20, fontWeight: '800', lineHeight: 26 },
  subtitle: { color: c.textSecondary, fontSize: 14.5, fontWeight: '600' },

  scrubBlock: { marginTop: SPACING.md },
  scrubSpacer: { height: SPACING.lg },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  time: { color: c.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'] },

  adCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: SPACING.md, backgroundColor: c.primary, borderRadius: RADIUS.full, paddingVertical: 13,
  },
  adCtaText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xl,
    marginTop: SPACING.lg, marginBottom: SPACING.md,
  },
  sideBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  playBtn: {
    width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center',
    shadowColor: c.primary, shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },

  upNext: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, padding: 8,
  },
  upNextThumb: { width: 52, height: 30, borderRadius: 5, backgroundColor: c.surface },
  upNextThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  upNextInfo: { flex: 1, minWidth: 0 },
  upNextLabel: { color: c.textTertiary, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  upNextTitle: { color: c.text, fontSize: 13, fontWeight: '600', marginTop: 1 },

  flexSpace: { flex: 1, minHeight: SPACING.md },

  connectWrap: { alignSelf: 'stretch' },
  connectBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: RADIUS.full, paddingVertical: 15,
  },
  connectText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  volumeHint: { color: c.textTertiary, fontSize: 12, textAlign: 'center', marginTop: 8 },

  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: RADIUS.full, paddingHorizontal: 22, paddingVertical: 11 },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
