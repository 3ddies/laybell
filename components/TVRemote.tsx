import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, Image, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useProfile } from '../contexts/ProfileContext';
import { useCast } from '../contexts/CastContext';
import { useOptimisticSeek } from '../hooks/useOptimisticSeek';
import { selection } from '../lib/haptics';
import { supabase } from '../lib/supabase';
import { bumpBadge } from '../lib/badges';
import { createNotification } from '../lib/createNotification';
import { formatCount } from '../lib/format';
import Scrubber from './Scrubber';
import { Marquee } from './SongCardTitle';

// The full-screen TV remote — opened by tapping the CastBar. Big, thumb-sized
// controls for driving the TV: wide scrubber with time labels, ±10s skips,
// a large play/pause, queue prev/next, and disconnect.
//
// NOT a native <Modal>: CastBar (and therefore this) lives inside the iOS
// FullWindowOverlay, where presenting a real Modal deadlocks the app (see
// PostOptionsSheet's presentation note). It's an absolute-fill overlay view
// with its own slide-up animation — the same pattern the options sheet uses.

const fmtTime = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

export default function TVRemote({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const {
    connected, current, deviceName, isPlaying, playerState, mediaError, ended, nextItem,
    positionSec, durationSec,
    play, pause, seekTo, skip, next, prev, hasNext, hasPrev, retry, disconnect,
    commentsFor, openComments,
  } = useCast();
  // The scrubber/time show where the user just seeked IMMEDIATELY; the receiver
  // truth takes over once it catches up (raw positions snap back for a beat).
  const [shownPos, noteSeek] = useOptimisticSeek(positionSec);

  // ── Social state for the on-TV post — the remote acts like the post itself
  // (like/comment/save), so watching on the TV doesn't cost the post its
  // engagement. Lives aren't posts and get no row.
  const uid = profile?.id ?? null;
  const postId = !current?.isLive ? current?.id ?? null : null;
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  useEffect(() => {
    if (!postId) return;
    let alive = true;
    setLiked(false); setSaved(false); setLikeCount(0); setCommentCount(0);
    supabase.from('posts').select('likes(count), comments(count)').eq('id', postId).maybeSingle()
      .then(({ data }) => {
        if (!alive || !data) return;
        const d = data as any;
        setLikeCount(d.likes?.[0]?.count ?? 0);
        setCommentCount(d.comments?.[0]?.count ?? 0);
      }, () => {});
    if (uid) {
      supabase.from('likes').select('user_id').eq('post_id', postId).eq('user_id', uid).maybeSingle()
        .then(({ data }) => { if (alive) setLiked(!!data); }, () => {});
      supabase.from('saves').select('id').eq('post_id', postId).eq('user_id', uid).maybeSingle()
        .then(({ data }) => { if (alive) setSaved(!!data); }, () => {});
    }
    return () => { alive = false; };
    // commentsFor: refetch counts when the comments sheet closes (they may have
    // just posted one).
  }, [postId, uid, commentsFor]);

  const toggleLike = async () => {
    if (!postId || !uid) return;
    selection();
    const nextLiked = !liked;
    setLiked(nextLiked); // optimistic
    setLikeCount((c) => Math.max(0, c + (nextLiked ? 1 : -1)));
    if (nextLiked) {
      await supabase.from('likes').insert({ user_id: uid, post_id: postId });
      bumpBadge('likes');
      if (current?.authorId && current.authorId !== uid) {
        createNotification({ userId: current.authorId, actorId: uid, type: 'like', postId });
      }
    } else {
      await supabase.from('likes').delete().eq('user_id', uid).eq('post_id', postId);
    }
  };
  const toggleSave = async () => {
    if (!postId || !uid) return;
    selection();
    const nextSaved = !saved;
    setSaved(nextSaved); // optimistic
    if (nextSaved) await supabase.from('saves').insert({ post_id: postId, user_id: uid });
    else await supabase.from('saves').delete().eq('post_id', postId).eq('user_id', uid);
  };

  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  if (!visible || !connected || !current) return null;

  const device = deviceName || t('tv.cast.yourTv');
  const isLive = !!current.isLive;
  const busy = playerState === 'loading' || playerState === 'buffering';
  // Ended: pin the bar full instead of letting a null position drop it to 0.
  const progress = ended ? 1 : durationSec > 0 ? Math.min(1, shownPos / durationSec) : 0;

  const doSeek = (sec: number) => { selection(); noteSeek(sec); seekTo(sec); };
  const doSkip = (delta: number) => { selection(); noteSeek(shownPos + delta); skip(delta); };

  return (
    <Animated.View
      style={[
        styles.root,
        {
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + SPACING.lg,
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }],
        },
      ]}
    >
      {/* Header: collapse chevron + destination */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.headerBtn}>
          <Ionicons name="chevron-down" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Ionicons name="tv" size={14} color={colors.primary} />
          <Text style={styles.headerText} numberOfLines={1}>
            {t('tv.cast.castingTo', { device })}
          </Text>
        </View>
        <View style={styles.headerBtn} />
      </View>

      {/* Poster */}
      <View style={styles.posterWrap}>
        {current.poster ? (
          <Image source={{ uri: current.poster }} style={styles.poster} resizeMode="cover" />
        ) : (
          <LinearGradient colors={GRADIENTS.primarySoft} style={styles.poster}>
            <Ionicons name="tv" size={56} color={colors.primary} />
          </LinearGradient>
        )}
      </View>

      {/* Title — long titles marquee (scroll through, pause, snap back), same
          behavior as the song card. Keyed so measurement re-runs per video. */}
      <View style={styles.meta}>
        <Marquee key={current.id}>
          <Text style={styles.title}>{current.title}</Text>
        </Marquee>
        {!!current.subtitle && <Text style={styles.subtitle} numberOfLines={1}>{current.subtitle}</Text>}
      </View>

      {/* Social row — the on-TV video is still a Laybell post: like, comment
          (opens the app's comments sheet), save. Lives skip this. */}
      {postId && (
        <View style={styles.socialRow}>
          <TouchableOpacity onPress={toggleLike} hitSlop={8} style={styles.socialBtn}>
            <Ionicons name={liked ? 'heart' : 'heart-outline'} size={24} color={liked ? COLORS.like : colors.text} />
            {likeCount > 0 && <Text style={styles.socialCount}>{formatCount(likeCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { selection(); openComments(); }} hitSlop={8} style={styles.socialBtn}>
            <Ionicons name="chatbubble-outline" size={22} color={colors.text} />
            {commentCount > 0 && <Text style={styles.socialCount}>{formatCount(commentCount)}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleSave} hitSlop={8} style={styles.socialBtn}>
            <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={22} color={saved ? colors.primary : colors.text} />
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.flexSpace} />

      {mediaError ? (
        /* Receiver rejected the stream — say it big, offer retry. */
        <View style={styles.errorWrap}>
          <Ionicons name="alert-circle" size={30} color="#F43F5E" />
          <Text style={styles.errorText}>{t('tv.cast.error')}</Text>
          <TouchableOpacity onPress={retry} activeOpacity={0.9}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.retryBtn}>
              <Ionicons name="refresh" size={16} color="#fff" />
              <Text style={styles.retryText}>{t('tv.cast.retry')}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Scrubber + times (VOD) / LIVE pill */}
          {isLive ? (
            <View style={styles.liveRow}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>{t('live.live')}</Text>
            </View>
          ) : (
            <View style={styles.scrubBlock}>
              <Scrubber
                progress={progress}
                onSeek={(r) => doSeek(r * durationSec)}
                height={26} trackHeight={5} thumbSize={16}
              />
              <View style={styles.timeRow}>
                <Text style={styles.time}>{fmtTime(ended ? durationSec : shownPos)}</Text>
                <Text style={styles.time}>{durationSec > 0 ? fmtTime(durationSec) : '–:––'}</Text>
              </View>
            </View>
          )}

          {/* Transport: prev · −10s · play/pause/replay · +10s · next */}
          <View style={styles.controls}>
            <TouchableOpacity onPress={() => { selection(); prev(); }} disabled={!hasPrev} hitSlop={10} style={styles.sideBtn}>
              <Ionicons name="play-skip-back" size={26} color={hasPrev ? colors.text : colors.textTertiary} />
            </TouchableOpacity>
            {!isLive && (
              <TouchableOpacity onPress={() => doSkip(-10)} hitSlop={10} style={styles.skipBtn}>
                <Ionicons name="play-back" size={22} color={colors.text} />
                <Text style={styles.skipLabel}>10</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => { selection(); if (ended) retry(); else if (isPlaying) pause(); else play(); }}
              disabled={busy}
              activeOpacity={0.85}
              accessibilityLabel={ended ? t('tv.cast.replay') : undefined}
            >
              <LinearGradient colors={GRADIENTS.primary} style={styles.playBtn}>
                {busy ? (
                  <ActivityIndicator size="large" color="#fff" />
                ) : (
                  <Ionicons
                    name={ended ? 'refresh' : isPlaying ? 'pause' : 'play'}
                    size={38}
                    color="#fff"
                    style={ended || isPlaying ? undefined : { marginLeft: 4 }}
                  />
                )}
              </LinearGradient>
            </TouchableOpacity>
            {!isLive && (
              <TouchableOpacity onPress={() => doSkip(10)} hitSlop={10} style={styles.skipBtn}>
                <Ionicons name="play-forward" size={22} color={colors.text} />
                <Text style={styles.skipLabel}>10</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { selection(); next(); }} disabled={!hasNext} hitSlop={10} style={styles.sideBtn}>
              <Ionicons name="play-skip-forward" size={26} color={hasNext ? colors.text : colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {/* Up next — tap to jump straight to it */}
          {nextItem && (
            <TouchableOpacity style={styles.upNext} activeOpacity={0.8} onPress={() => { selection(); next(); }}>
              {nextItem.poster ? (
                <Image source={{ uri: nextItem.poster }} style={styles.upNextThumb} />
              ) : (
                <View style={[styles.upNextThumb, styles.upNextThumbEmpty]}>
                  <Ionicons name="play" size={12} color={colors.textTertiary} />
                </View>
              )}
              <View style={styles.upNextInfo}>
                <Text style={styles.upNextLabel}>{t('tv.cast.upNext')}</Text>
                <Text style={styles.upNextTitle} numberOfLines={1}>{nextItem.title}</Text>
              </View>
              <Ionicons name="play-skip-forward" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </>
      )}

      {/* Disconnect */}
      <TouchableOpacity onPress={() => { selection(); disconnect(); }} style={styles.disconnectBtn} activeOpacity={0.8}>
        <Ionicons name="power" size={15} color={colors.textSecondary} />
        <Text style={styles.disconnectText}>{t('tv.setup.disconnect')}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.background,
    zIndex: 70,
    paddingHorizontal: SPACING.lg,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerCenter: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  headerText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
  posterWrap: {
    borderRadius: RADIUS.lg, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  poster: { width: '100%', aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceLight },
  meta: { marginTop: SPACING.lg, gap: 3 },
  title: { color: c.text, fontSize: 20, fontWeight: '800', lineHeight: 26 },
  subtitle: { color: c.textTertiary, fontSize: 13.5 },
  socialRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.lg, marginTop: SPACING.md },
  socialBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  socialCount: { color: c.textSecondary, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  flexSpace: { flex: 1 },
  scrubBlock: { marginBottom: SPACING.sm },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  time: { color: c.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'] },
  liveRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: SPACING.md },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#F43F5E' },
  liveText: { color: '#F43F5E', fontSize: 13, fontWeight: '800', letterSpacing: 0.8 },
  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: SPACING.sm, marginBottom: SPACING.xl, paddingHorizontal: SPACING.xs,
  },
  sideBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  skipBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  skipLabel: { color: c.textTertiary, fontSize: 9, fontWeight: '800', marginTop: -2 },
  playBtn: {
    width: 78, height: 78, borderRadius: 39, alignItems: 'center', justifyContent: 'center',
    shadowColor: c.primary, shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  upNext: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md,
    padding: 8, marginBottom: SPACING.md,
  },
  upNextThumb: { width: 52, height: 30, borderRadius: 5, backgroundColor: c.surface },
  upNextThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  upNextInfo: { flex: 1, minWidth: 0 },
  upNextLabel: { color: c.textTertiary, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  upNextTitle: { color: c.text, fontSize: 13, fontWeight: '600', marginTop: 1 },
  errorWrap: { alignItems: 'center', gap: 10, marginBottom: SPACING.xl },
  errorText: { color: c.textSecondary, fontSize: 14, textAlign: 'center' },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: RADIUS.full, paddingHorizontal: 22, paddingVertical: 11,
  },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  disconnectBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.full, paddingVertical: 12,
  },
  disconnectText: { color: c.textSecondary, fontSize: 13.5, fontWeight: '700' },
});
