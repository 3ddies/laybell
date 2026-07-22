import {
  View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, Easing,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { PanGestureHandler, State } from 'react-native-gesture-handler';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAudio, useAudioPosition } from '../contexts/AudioContext';
import { useCast } from '../contexts/CastContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { useTranslation } from '../contexts/LanguageContext';
import { supabase } from '../lib/supabase';
import { bumpBadge } from '../lib/badges';
import BadgeEmblem from './BadgeEmblem';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { formatCount } from '../lib/format';
import { createNotification } from '../lib/createNotification';
import Scrubber from './Scrubber';
import Comments from './Comments';
import { adDestination, AUDIO_AD_SKIP_MS } from '../lib/ads';
import { openAdCta } from '../contexts/AdCtaContext';
import { isPostSpotlighted } from '../lib/spotlight';
import { fetchFeatures, type Feature } from '../lib/features';
import SongCardTitle from './SongCardTitle';

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

// The cycling title lives in its OWN position subscription (like Progress), so
// only this small block re-renders 4×/sec — not the whole player. Flips the
// large centered title between the song name and its collaborator credits.
function SongTitleBlock({ title, features, titleStyle, onOpenProfile }: {
  title: string;
  features: Feature[];
  titleStyle: any;
  onOpenProfile: (id: string) => void;
}) {
  const { positionMs, durationMs } = useAudioPosition();
  return (
    <SongCardTitle
      title={title}
      features={features}
      positionMs={positionMs}
      durationMs={durationMs}
      titleStyle={titleStyle}
      centered
      onOpenProfile={onOpenProfile}
    />
  );
}

function Progress() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { seekTo } = useAudio();
  // Position ticks live in their own subscription — only THIS small component
  // re-renders 4×/sec, so dragging the sheet stays smooth.
  const { positionMs, durationMs } = useAudioPosition();
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

// Ad elapsed/duration ride the same position channel (the ad player's ticks
// route through it while the music is paused) — scoped to these two small
// blocks so the full player doesn't re-render 4×/sec during an ad (that
// app-wide 4Hz re-render was a global "split-second lag" source).
function AdProgress() {
  const styles = useThemedStyles(makeStyles);
  const { positionMs, durationMs } = useAudioPosition();
  return (
    <View style={[styles.progressBlock, { width: '100%' }]}>
      <View style={styles.adProgressTrack}>
        <View style={[styles.adProgressFill, { width: `${Math.round((durationMs > 0 ? positionMs / durationMs : 0) * 100)}%` }]} />
      </View>
      <View style={styles.times}>
        <Text style={styles.timeText}>{formatMs(positionMs)}</Text>
        <Text style={styles.timeText}>{durationMs > 0 ? formatMs(durationMs) : '--:--'}</Text>
      </View>
    </View>
  );
}

function AdSkipButton({ canSkip, onSkip }: { canSkip: boolean; onSkip: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { positionMs } = useAudioPosition();
  return (
    <TouchableOpacity style={[styles.adSkipBtn, !canSkip && styles.adSkipDisabled]} disabled={!canSkip} onPress={onSkip}>
      <Text style={styles.adSkipText}>
        {canSkip ? t('nowPlaying.skipAd') : t('nowPlaying.skipIn', { secs: Math.max(1, Math.ceil((AUDIO_AD_SKIP_MS - positionMs) / 1000)) })}
      </Text>
    </TouchableOpacity>
  );
}

function Controls() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { isPlaying, isBuffering, pause, resume, next, previous, queueIndex, queueLength, hasMore } = useAudio();
  const hasQueue = queueLength > 1 || hasMore;
  const canPrev = queueIndex > 0;
  // "Next" stays enabled at the end when more relevant songs can still be pulled in.
  const canNext = queueIndex < queueLength - 1 || hasMore;
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

// Laybell TV card for the music player: when a cast session runs alongside the
// music, show the on-TV video + a play/pause so it can be seen and controlled
// without leaving the Spotify-style view. Its OWN component so the 0.5s cast
// position ticks (which rebuild the cast value) re-render only this small card,
// not the heavy player sheet + comments around it.
function NowPlayingTVCard() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { connected, current, deviceName, isPlaying, play, pause } = useCast();
  if (!connected || !current) return null;
  return (
    <View style={styles.tvCard}>
      {current.poster ? (
        <Image source={{ uri: current.poster }} style={styles.tvCardPoster} />
      ) : (
        <LinearGradient colors={GRADIENTS.primarySoft} style={styles.tvCardPoster}>
          <Ionicons name="tv" size={18} color={colors.primary} />
        </LinearGradient>
      )}
      <View style={styles.tvCardInfo}>
        <View style={styles.tvCardLabelRow}>
          <Ionicons name="tv" size={11} color={colors.primary} />
          <Text style={styles.tvCardLabel} numberOfLines={1}>
            {t('tv.cast.castingTo', { device: deviceName || t('tv.cast.yourTv') })}
          </Text>
        </View>
        <Text style={styles.tvCardTitle} numberOfLines={1}>{current.title}</Text>
      </View>
      <TouchableOpacity onPress={() => (isPlaying ? pause() : play())} hitSlop={10} style={styles.tvCardBtn}>
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={22} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

export default function NowPlaying() {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { currentTrack, expanded, collapse, setCommentComposing, noteCommentEngagement, clearCommentEngagement, adState, skipAudioAd } = useAudio();
  const { show: showOptions } = usePostOptions();
  const router = useRouter();
  const [render, setRender] = useState(false);
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  // When a song ENDS, the sheet fades + gently scales down in place (a manual
  // dismiss still slides) so the auto-exit feels clean rather than abrupt.
  const fade = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;
  // The last non-null track, kept so the sheet can finish its exit animation
  // after the queue empties (currentTrack → null) instead of vanishing instantly.
  const lastTrackRef = useRef(currentTrack);
  const closeVel = useRef(0);
  // True while a flick-down close is animating dragY itself — tells the
  // expanded-effect to skip its own close spring (no double animation).
  const closingViaDragRef = useRef(false);
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
  // Song collaborators for the title↔features flip (mirrors the mini card).
  const [features, setFeatures] = useState<Feature[]>([]);
  const [ownerBadge, setOwnerBadge] = useState<{ badge_tier?: string | null; badge_show?: boolean | null } | null>(null);
  // True when this song has a live spotlight → a subtle sparkle by the artist name.
  const [spotlighted, setSpotlighted] = useState(false);
  const [streams, setStreams] = useState(0);
  const [saves, setSaves] = useState(0);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    if (expanded) {
      setRender(true);
      closingViaDragRef.current = false;
      dragY.setValue(0);             // clear any leftover drag-close offset
      fade.setValue(1);             // clear any leftover song-end fade
      scale.setValue(1);            // and scale
      translateY.setValue(SCREEN_H); // always enter from off-screen
      Animated.timing(translateY, { toValue: 0, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else if (render) {
      // A drag/flick close is already animating dragY (started synchronously in
      // the gesture handler for a pause-free handoff) — don't double-animate.
      if (closingViaDragRef.current) return;
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

  // Remember the playing track so an exit animation can keep rendering it after
  // the queue clears it.
  useEffect(() => { if (currentTrack) lastTrackRef.current = currentTrack; }, [currentTrack]);

  // Fetch this track's features (never for ads) so the title can flip to credits.
  const featTrackId = !adState ? currentTrack?.id ?? null : null;
  useEffect(() => {
    if (!featTrackId) { setFeatures([]); return; }
    let alive = true;
    setFeatures([]);
    fetchFeatures(featTrackId).then((f) => { if (alive) setFeatures(f); }).catch(() => {});
    return () => { alive = false; };
  }, [featTrackId]);

  // Song ended while the full player was open: the queue emptied so currentTrack
  // is now null, but `expanded` is still true. Fade + gently scale the sheet out
  // in place (cleaner than sliding it off), then unmount. collapse() syncs the
  // global expanded flag; closingViaDragRef stops the expanded-effect from also
  // springing translateY (which would re-introduce a slide).
  useEffect(() => {
    if (currentTrack || !render || !expanded || closingViaDragRef.current) return;
    closingViaDragRef.current = true;
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 260, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 0.94, duration: 260, easing: Easing.out(Easing.ease), useNativeDriver: true }),
    ]).start(() => setRender(false));
    collapse();
  }, [currentTrack, render, expanded]);

  // Load post stats + like state + comments for the current track (when open).
  useEffect(() => {
    const pid = currentTrack?.id;
    if (!pid || !expanded) return;
    let cancelled = false;
    // Reset per track, then promote if this song is currently spotlighted.
    setSpotlighted(false);
    isPostSpotlighted(pid).then((s) => { if (!cancelled && s) setSpotlighted(true); });
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

  // Drag-to-dismiss — NATIVE-driven: the gesture writes dragY directly on the
  // UI thread (Animated.event + useNativeDriver), so the sheet tracks the
  // finger at full frame rate no matter what the JS thread is doing — this is
  // what the old JS PanResponder (bridge round-trip per move event) could
  // never guarantee, and why drags/flicks looked choppy. JS only hears about
  // the END of the gesture to decide close vs spring back.
  const dragY = useRef(new Animated.Value(0)).current;
  // Upward drags clamp at 0 (the sheet only dismisses downward).
  const dragClamped = dragY.interpolate({ inputRange: [0, SCREEN_H], outputRange: [0, SCREEN_H], extrapolate: 'clamp' });
  const sheetY = useRef(Animated.add(translateY, dragClamped)).current;
  const onDragEvent = useRef(
    Animated.event([{ nativeEvent: { translationY: dragY } }], { useNativeDriver: true }),
  ).current;
  const onDragStateChange = (e: any) => {
    const { state, translationY, velocityY } = e.nativeEvent;
    if (state !== State.END && state !== State.CANCELLED && state !== State.FAILED) return;
    if (state === State.END && velocityY > 400 && translationY > 70) {
      // Flick down → close. The spring starts in THIS event task, continuing
      // dragY from the exact release position/velocity — routing through
      // collapse() → re-render → effect first left a visible pause at
      // finger-up. collapse() still runs (audio/engagement state), but the
      // expanded-effect skips its own spring via closingViaDragRef.
      closingViaDragRef.current = true;
      Animated.spring(dragY, { toValue: SCREEN_H, velocity: velocityY, bounciness: 0, speed: 12, useNativeDriver: true })
        .start(() => setRender(false));
      collapse();
    } else {
      Animated.spring(dragY, { toValue: 0, speed: 14, bounciness: 4, useNativeDriver: true }).start();
    }
  };

  // Use the retained track so the exit animation can keep painting after the
  // queue clears currentTrack (song ended).
  const track = currentTrack ?? lastTrackRef.current;
  if (!render || !track) return null;
  const pid = track.id;
  // Opaque backdrop — no see-through (the earlier translucent stop looked glitchy
  // in Light mode). Dark themes keep the rich warm gradient; Light mode gets a
  // subtle, OPAQUE lift only at the very top that fades quickly to the solid page
  // background, so it reads clean and matches the theme.
  const sheetGradient = (mode === 'light'
    ? [colors.surfaceLight, colors.background, colors.background]
    : ['#2A1206', '#150A04', colors.background]) as readonly [string, string, string];
  const sheetLocations = (mode === 'light' ? [0, 0.18, 1] : [0, 0.5, 1]) as readonly [number, number, number];
  // Drag handle: light on the dark sheet, dark on the light sheet.
  const handleColor = mode === 'light' ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.3)';

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
    <Animated.View style={[StyleSheet.absoluteFill, styles.layer, { opacity: fade, transform: [{ translateY: sheetY }, { scale }] }]}>
      <LinearGradient colors={sheetGradient} locations={sheetLocations as any} style={styles.container}>
        {/* Top drag zone — swipe down to close (native gesture: activates on a
            6px downward move; clearly horizontal or upward moves fail fast so
            the header buttons stay tappable). */}
        <PanGestureHandler
          onGestureEvent={onDragEvent}
          onHandlerStateChange={onDragStateChange}
          activeOffsetY={6}
          failOffsetY={-12}
          failOffsetX={[-16, 16]}
        >
        <Animated.View>
          <View style={[styles.handle, { backgroundColor: handleColor }]} />
          <View style={styles.header}>
            <View style={styles.headerActions}>
              <TouchableOpacity style={styles.headerBtn} onPress={collapse}>
                <Ionicons name="chevron-down" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.headerTitle}>{t('nowPlaying.title')}</Text>
            {adState ? (
              // Ads aren't posts — no options menu, just keep the header balanced.
              <View style={styles.headerBtn} />
            ) : (
              <View style={styles.headerActions}>
                <TouchableOpacity
                  style={styles.headerBtn}
                  onPress={() => showOptions({
                    postId: pid,
                    isOwn: ownerId === userId,
                    authorId: ownerId ?? undefined,
                    authorName: ownerName,
                    mediaType: 'audio',
                    mediaUrl: track.uri,
                    cover: track.cover,
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
            )}
          </View>
        </Animated.View>
        </PanGestureHandler>

        {adState ? (
          // Audio ad — rendered with the SAME layout as a song (cover art, title,
          // artist line, progress) so it plays "like a regular song" in the full
          // player. The header's collapse still works, so the user can drop to the
          // mini bar and back without ending the ad. Skip is locked until
          // AUDIO_AD_SKIP_MS; there are no comments/likes/streams for an ad.
          <View style={styles.adBody}>
            <View style={styles.artWrap}>
              {adState.cover ? (
                <Image source={{ uri: adState.cover }} style={styles.art} />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.art}>
                  <Ionicons name="megaphone" size={64} color={colors.text} />
                </LinearGradient>
              )}
            </View>

            <View style={styles.meta}>
              <Text style={styles.adSponsoredTag}>{t('nowPlaying.sponsored')}</Text>
              <Text style={styles.title} numberOfLines={1}>{adState.advertiserName}</Text>
              {!!adState.headline && <Text style={styles.artist} numberOfLines={2}>{adState.headline}</Text>}
            </View>

            {/* Ad progress (non-interactive — ads aren't seekable). */}
            {/* Own position subscription (like Progress) — only this block
                re-renders per ad tick. */}
            <AdProgress />

            {!!adDestination(adState) && (
              <TouchableOpacity
                style={styles.adCtaBtn}
                onPress={() => openAdCta(adState, 'audio', adState.viewerId)}
                activeOpacity={0.85}
              >
                <Text style={styles.adCtaText}>{adState.ctaLabel}</Text>
                <Ionicons name="arrow-forward" size={16} color={colors.text} />
              </TouchableOpacity>
            )}

            <AdSkipButton canSkip={adState.canSkip} onSkip={skipAudioAd} />
          </View>
        ) : (
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
                  {track.cover ? (
                    <Image source={{ uri: track.cover }} style={styles.art} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primary} style={styles.art}>
                      <Ionicons name="musical-notes" size={64} color={colors.text} />
                    </LinearGradient>
                  )}
                </View>

                <View style={styles.meta}>
                  <SongTitleBlock
                    title={track.caption || t('player.audioTrack')}
                    features={features}
                    titleStyle={styles.title}
                    onOpenProfile={(id) => { collapse(); router.push(`/profile/${id}`); }}
                  />
                  <TouchableOpacity disabled={!ownerId} onPress={goProfile}>
                    <View style={styles.artistRow}>
                      <Text style={styles.artist} numberOfLines={1}>
                        {track.artist || (ownerName ? `@${ownerName}` : '')}
                      </Text>
                      <BadgeEmblem profile={ownerBadge} ownerId={ownerId} size={13} />
                      {spotlighted && <Ionicons name="sparkles" size={13} color={colors.primaryLight} />}
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
                    <Text style={styles.centerStatLbl}>{t('nowPlaying.streams')}</Text>
                  </View>
                  <TouchableOpacity style={[styles.tapStat, isSaved && styles.tapStatActiveSave]} onPress={handleSave} activeOpacity={0.8}>
                    <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={26} color={colors.text} />
                    <Text style={styles.tapStatNum}>{formatCount(saves)}</Text>
                  </TouchableOpacity>
                </View>

                {/* Laybell TV card — mirror of the music card in the TV remote.
                    Isolated component so its per-tick cast re-renders don't drag
                    the whole player sheet with them. */}
                <NowPlayingTVCard />
              </>
            }
          />
        </KeyboardAvoidingView>
        )}
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
  headerActions: { flexDirection: 'row', alignItems: 'center' },
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
  // Laybell TV cast card (shown in the player while a session is live).
  tvCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.md,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.md, padding: SPACING.sm,
    borderWidth: 1, borderColor: colors.primary + '55',
  },
  tvCardPoster: { width: 44, height: 44, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: colors.surface },
  tvCardInfo: { flex: 1, minWidth: 0 },
  tvCardLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tvCardLabel: { flex: 1, color: colors.primary, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  tvCardTitle: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 1 },
  tvCardBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  tapStat: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm + 2,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated,
    borderWidth: 1, borderColor: colors.border,
  },
  tapStatActiveLike: { borderColor: colors.like, backgroundColor: colors.like + '1A' },
  tapStatActiveSave: { borderColor: colors.text + '66', backgroundColor: colors.text + '14' },
  tapStatNum: { color: colors.text, fontSize: 16, fontWeight: '700' },
  centerStat: { flex: 1, alignItems: 'center' },
  centerStatNum: { color: colors.text, fontSize: 18, fontWeight: '800' },
  centerStatLbl: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },

  // ── Audio ad rendered like a song (cover + meta + progress + CTA + skip) ──
  adBody: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: SPACING.xl, paddingBottom: SPACING.xxl, gap: SPACING.sm,
  },
  adSponsoredTag: { color: colors.primaryLight, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, marginBottom: 2, textAlign: 'center' },
  adProgressTrack: {
    width: '100%', height: 5, borderRadius: 3,
    backgroundColor: colors.border, overflow: 'hidden',
  },
  adProgressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.primary },
  adCtaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.md, paddingHorizontal: SPACING.xl, marginTop: SPACING.md,
    alignSelf: 'stretch',
  },
  adCtaText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  adSkipBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.xl, marginTop: SPACING.xs,
  },
  adSkipDisabled: { opacity: 0.5 },
  adSkipText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },

});
