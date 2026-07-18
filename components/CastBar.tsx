import { ActivityIndicator, Animated, View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCast } from '../contexts/CastContext';
import { feedChrome } from '../lib/feedChrome';
import { useOptimisticSeek } from '../hooks/useOptimisticSeek';
import { selection } from '../lib/haptics';
import Scrubber from './Scrubber';
import TVRemote from './TVRemote';
import CommentsSheet from './CommentsSheet';
import { ShareSheet } from '../contexts/ShareContext';

// The phone-as-remote controller for Laybell TV casting. Visible for the WHOLE
// life of a Cast session — not just while media plays — so the phone always
// tells you what the TV is doing:
//
//   • connected, nothing loaded → "Connected to <TV> — pick a video"
//   • loading/buffering         → spinner in the transport slot
//   • playing/paused            → poster, title, transport + scrubber
//   • receiver media error      → warning + Retry (reloads the same item)
//
// Tapping the poster/title opens the Cast SDK's full-screen remote (expanded
// controls). The TV's own remote drives the same session independently.

export default function CastBar({ bottomDock = false, variant = 'bar' }: { bottomDock?: boolean; variant?: 'bar' | 'chip' }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Match the MiniPlayer's now-playing slot: above the tab bar on tab/chat
  // screens (bottomDock false), at the true bottom on tab-less pushed screens
  // (bottomDock true, e.g. /tv — its perfect placement is unchanged).
  const barBottom = bottomDock ? insets.bottom + 8 : 68 + insets.bottom + 6;
  // Ride the home feed's reactive chrome (native-driven, shared with the
  // MiniPlayer): when the tab bar condenses into chips and drops toward the
  // edge, the cast bar slides down with it so it always hugs the bottom
  // elements. Zero off the home feed (feedChrome resets on tab change).
  const chromeSlide = feedChrome.interpolate({
    inputRange: [0, 1],
    outputRange: [0, (insets.bottom > 0 ? insets.bottom - 2 : 12) + (bottomDock ? -8 : 6)],
  });
  const {
    connected, current, deviceName, isPlaying, playerState, mediaError, ended,
    positionSec, durationSec,
    play, pause, next, prev, hasNext, hasPrev, seekTo, retry, disconnect,
    // Remote visibility lives in CastContext so casting a video auto-expands it.
    // Comments + share state live there too — an open sheet holds queue
    // auto-advance (the finished video loops), so the context must know.
    remoteOpen, openRemote, closeRemote, commentsFor, closeComments, shareFor, closeShare,
  } = useCast();
  // Show seeks where the finger dropped them immediately (receiver positions
  // lag by up to a tick and would snap the fill back).
  const [shownPos, noteSeek] = useOptimisticSeek(positionSec);

  if (!connected) return null;

  const device = deviceName || t('tv.cast.yourTv');
  const isLive = !!current?.isLive || (durationSec <= 0 && isPlaying);
  const busy = playerState === 'loading' || playerState === 'buffering';
  // Ended: hold the bar full instead of dropping to 0 when position vanishes.
  const progress = ended ? 1 : durationSec > 0 ? Math.min(1, shownPos / durationSec) : 0;

  return (
    <>
      {/* Full-screen remote (an overlay view, not a Modal — see TVRemote). The
          bar hides underneath it while it's up. */}
      <TVRemote visible={remoteOpen} onClose={closeRemote} />
      {/* Comments for the on-TV video — hosted HERE (inOverlay) so it stacks
          above the remote in the same window. A real Modal can neither present
          from this overlay window (deadlock) nor from the main window over the
          native-modal /tv route (never appears). */}
      <CommentsSheet
        inOverlay
        visible={!!commentsFor}
        postId={commentsFor?.postId ?? ''}
        ownerId={commentsFor?.ownerId ?? null}
        onClose={closeComments}
      />
      {/* Share for the on-TV post — same inOverlay hosting as the comments. */}
      <ShareSheet inOverlay visible={!!shareFor} payload={shareFor} onClose={closeShare} />
      {remoteOpen || commentsFor || shareFor ? null : variant === 'chip' ? (
        // Compact side chip for screens whose own controls own the bottom slot
        // (story camera, Live) — mirrors the music side chip: poster (tap opens
        // the remote) + play/pause + disconnect, a vertical pill on the edge.
        <View style={styles.chip}>
          <TouchableOpacity onPress={openRemote} style={styles.chipPosterWrap} activeOpacity={0.85}>
            {current?.poster ? (
              <Image source={{ uri: current.poster }} style={styles.chipPoster} />
            ) : (
              <LinearGradient colors={GRADIENTS.primarySoft} style={styles.chipPoster}>
                <Ionicons name="tv" size={14} color={colors.primary} />
              </LinearGradient>
            )}
            <View style={styles.chipBadge}><Ionicons name="tv" size={8} color="#fff" /></View>
          </TouchableOpacity>
          {current && (
            <TouchableOpacity onPress={() => { selection(); if (ended) retry(); else if (isPlaying) pause(); else play(); }} hitSlop={8}>
              <Ionicons
                name={busy ? 'hourglass' : ended ? 'refresh-circle' : isPlaying ? 'pause-circle' : 'play-circle'}
                size={28} color={colors.primary}
              />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.chipClose} onPress={disconnect} hitSlop={8}>
            <Ionicons name="close" size={12} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ) : (
    <Animated.View style={[styles.wrap, { bottom: barBottom, transform: [{ translateY: chromeSlide }] }]} pointerEvents="box-none">
      <View style={styles.card}>
        {!current ? (
          /* Session up, nothing loaded yet — say so instead of hiding. */
          <View style={styles.row}>
            <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
              <Ionicons name="tv" size={16} color={colors.primary} />
            </LinearGradient>
            <View style={styles.info}>
              <Text style={styles.title} numberOfLines={1}>{t('tv.cast.connectedTo', { device })}</Text>
              <Text style={styles.sub} numberOfLines={1}>{t('tv.cast.pickVideo')}</Text>
            </View>
            <TouchableOpacity onPress={disconnect} hitSlop={8} style={styles.ctrl}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.row}>
              {/* Poster + title: tap opens the full-screen remote. */}
              <TouchableOpacity style={styles.infoTap} activeOpacity={0.8} onPress={openRemote}>
                <View style={styles.coverWrap}>
                  {current.poster ? (
                    <Image source={{ uri: current.poster }} style={styles.cover} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                      <Ionicons name="tv" size={16} color={colors.primary} />
                    </LinearGradient>
                  )}
                  <View style={styles.castGlyph}><Ionicons name="tv" size={9} color="#fff" /></View>
                </View>
                <View style={styles.info}>
                  <Text style={styles.title} numberOfLines={1}>{current.title}</Text>
                  <Text style={mediaError ? styles.subError : styles.sub} numberOfLines={1}>
                    {mediaError
                      ? t('tv.cast.error')
                      : busy
                        ? t('tv.cast.loading')
                        : ended
                          ? t('tv.cast.replay')
                          : t('tv.cast.castingTo', { device })}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Transport (or Retry when the receiver rejected the stream) */}
              {mediaError ? (
                <TouchableOpacity onPress={retry} hitSlop={8} style={styles.retryBtn}>
                  <Ionicons name="refresh" size={14} color="#fff" />
                  <Text style={styles.retryText}>{t('tv.cast.retry')}</Text>
                </TouchableOpacity>
              ) : (
                <>
                  {hasPrev && (
                    <TouchableOpacity onPress={() => { selection(); prev(); }} hitSlop={8} style={styles.ctrl}>
                      <Ionicons name="play-skip-back" size={20} color={colors.text} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={() => { selection(); if (ended) retry(); else if (isPlaying) pause(); else play(); }}
                    hitSlop={8}
                    style={styles.ctrl}
                    disabled={busy}
                    accessibilityLabel={ended ? t('tv.cast.replay') : undefined}
                  >
                    {busy ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Ionicons name={ended ? 'refresh' : isPlaying ? 'pause' : 'play'} size={24} color={colors.text} />
                    )}
                  </TouchableOpacity>
                  {hasNext && (
                    <TouchableOpacity onPress={() => { selection(); next(); }} hitSlop={8} style={styles.ctrl}>
                      <Ionicons name="play-skip-forward" size={20} color={colors.text} />
                    </TouchableOpacity>
                  )}
                </>
              )}
              <TouchableOpacity onPress={disconnect} hitSlop={8} style={styles.ctrl}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Scrubber (VOD only — a live stream has no seekable duration) */}
            {mediaError ? null : isLive ? (
              <View style={styles.liveRow}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>{t('live.live')}</Text>
              </View>
            ) : (
              <View style={styles.scrubWrap}>
                <Scrubber
                  progress={progress}
                  onSeek={(r) => { const sec = r * durationSec; noteSeek(sec); seekTo(sec); }}
                  height={16} trackHeight={4} thumbSize={12}
                />
              </View>
            )}
          </>
        )}
      </View>
    </Animated.View>
      )}
    </>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 60 },
  // Compact side chip (story camera / Live) — a vertical pill on the right edge,
  // sat ABOVE the music side chip (top 42%) so the two stack without overlap.
  chip: {
    position: 'absolute', right: 8, top: '28%',
    alignItems: 'center', gap: 8,
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.full,
    borderWidth: 0.5, borderColor: c.primary + '77',
    paddingVertical: 8, paddingHorizontal: 6,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 8,
    zIndex: 100,
  },
  chipPosterWrap: { width: 30, height: 30, borderRadius: 15, overflow: 'hidden' },
  chipPoster: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  chipBadge: {
    position: 'absolute', bottom: -1, right: -1, width: 14, height: 14, borderRadius: 7,
    backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: c.surfaceElevated,
  },
  chipClose: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center',
  },
  card: {
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: c.primary + '55',
    paddingHorizontal: SPACING.sm + 2, paddingTop: SPACING.sm, paddingBottom: 6,
    // Lift it off the content a touch.
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  infoTap: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  coverWrap: { width: 40, height: 40, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 40, height: 40, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  castGlyph: {
    position: 'absolute', bottom: 2, right: 2, width: 15, height: 15, borderRadius: 7.5,
    backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: c.text, fontSize: 14, fontWeight: '700' },
  sub: { color: c.textSecondary, fontSize: 11, marginTop: 1 },
  subError: { color: '#F43F5E', fontSize: 11, marginTop: 1, fontWeight: '600' },
  ctrl: { padding: 4, alignItems: 'center', justifyContent: 'center' },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: c.primary, borderRadius: RADIUS.full,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  retryText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  scrubWrap: { marginTop: 2 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, marginLeft: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#F43F5E' },
  liveText: { color: '#F43F5E', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
});
