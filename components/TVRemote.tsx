import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, Image, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useProfile } from '../contexts/ProfileContext';
import { useAudio } from '../contexts/AudioContext';
import { useCast } from '../contexts/CastContext';
import { usePostOptions } from '../contexts/PostOptionsContext';
import { openAdOptions } from '../contexts/AdOptionsContext';
import { useLinkGuard } from '../contexts/LinkGuardContext';
import { useOptimisticSeek } from '../hooks/useOptimisticSeek';
import { selection } from '../lib/haptics';
import { supabase } from '../lib/supabase';
import { bumpBadge } from '../lib/badges';
import { createNotification } from '../lib/createNotification';
import { recordAdClick } from '../lib/ads';
import { formatCount } from '../lib/format';
import Scrubber from './Scrubber';
import FollowButton from './FollowButton';
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
  const router = useRouter();
  const { profile } = useProfile();
  const postOptions = usePostOptions();
  const linkGuard = useLinkGuard();
  const {
    connected, current, deviceName, isPlaying, playerState, mediaError, ended, nextItem,
    positionSec, durationSec,
    play, pause, seekTo, skip, next, prev, hasNext, hasPrev, retry, disconnect,
    commentsFor, openComments, openShare,
  } = useCast();
  // Phone music playing alongside the TV → a compact now-playing card fills the
  // remote's empty slot (portrait) so the user sees their song + controls it
  // without leaving the TV remote. MUST be above the early return (a hook).
  const { currentTrack, isPlaying: musicPlaying, pause: pauseMusic, resume: resumeMusic } = useAudio();
  // The scrubber/time show where the user just seeked IMMEDIATELY; the receiver
  // truth takes over once it catches up (raw positions snap back for a beat).
  const [shownPos, noteSeek] = useOptimisticSeek(positionSec);

  // ── Social state for the on-TV post — the remote acts like the post itself
  // (like/comment/save), so watching on the TV doesn't cost the post its
  // engagement. Lives aren't posts and get no row.
  const uid = profile?.id ?? null;
  // Ads are NOT real posts — exclude them so the like/comment/save social row and
  // its post/likes fetches never run on the sponsor's synthetic id.
  const postId = (!current?.isLive && !current?.isAd) ? current?.id ?? null : null;
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  // The post's real caption (CastItem.title falls back to the author's name) —
  // the share payload wants the true caption or nothing.
  const [caption, setCaption] = useState<string | null>(null);
  // Reset + fetch ONLY when the on-TV post changes. commentsFor must NOT be a
  // dep here: resetting on every sheet open/close blanked all the icons for a
  // beat (the "flash") — the close-refetch below updates counts in place.
  useEffect(() => {
    if (!postId) return;
    let alive = true;
    setLiked(false); setSaved(false); setLikeCount(0); setCommentCount(0); setCaption(null);
    supabase.from('posts').select('caption, likes(count), comments(count)').eq('id', postId).maybeSingle()
      .then(({ data }) => {
        if (!alive || !data) return;
        const d = data as any;
        setCaption(d.caption ?? null);
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
  }, [postId, uid]);

  // Comments sheet just CLOSED → they may have posted; refresh the comment
  // count in place, without touching the other icons' state.
  const hadComments = useRef(false);
  useEffect(() => {
    const closed = hadComments.current && !commentsFor;
    hadComments.current = !!commentsFor;
    if (!closed || !postId) return;
    let alive = true;
    supabase.from('posts').select('comments(count)').eq('id', postId).maybeSingle()
      .then(({ data }) => {
        if (alive && data) setCommentCount((data as any).comments?.[0]?.count ?? 0);
      }, () => {});
    return () => { alive = false; };
  }, [commentsFor, postId]);

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
  // Opens the share sheet for the on-TV post — hosted by CastBar (inOverlay,
  // like the comments sheet, stacking above the remote). State lives in
  // CastContext so the open sheet holds queue auto-advance (the video loops).
  const doShare = () => {
    if (!postId || !current) return;
    selection();
    openShare({
      postId,
      caption,
      username: current.subtitle?.startsWith('@') ? current.subtitle.slice(1) : current.subtitle ?? null,
      cover: current.poster ?? null,
      type: 'video',
      mediaUrl: current.url,
    });
  };
  // Tap the @username → the author's profile. The remote collapses first so
  // the pushed screen isn't hidden underneath this overlay.
  const goToProfile = () => {
    if (!current?.authorId) return;
    selection();
    onClose();
    router.push(`/profile/${current.authorId}`);
  };
  // The 3-dot hub for the on-TV item — the app-wide PostOptionsSheet presents
  // in its own FullWindowOverlay, which stacks above this one (same way the
  // Now Playing 3-dot works). Lives have no post row, so they get the
  // profile-only menu (report/block the host) when the author is known.
  const openOptions = () => {
    if (!current) return;
    // A sponsor → the ad options/report sheet (not the post/profile menu).
    if (current.isAd && current.ad) {
      openAdOptions({ campaignId: current.ad.campaignId, creativeId: current.ad.creativeId, advertiserName: current.ad.advertiserName });
      return;
    }
    // After a delete/archive the on-TV item is gone — roll to the next queued
    // video, or end the session when nothing is left to play.
    const skipGone = () => { if (hasNext) next(); else disconnect(); };
    postOptions.show({
      postId: postId ?? undefined,
      isOwn: !!uid && !!current.authorId && current.authorId === uid,
      authorId: current.authorId ?? undefined,
      authorName: current.subtitle?.startsWith('@') ? current.subtitle.slice(1) : current.subtitle,
      mediaType: postId ? 'video' : undefined,
      mediaUrl: postId ? current.url : undefined,
      hideLaybellTv: true, // it's already ON the TV
      hideMakeGif: true, // GIF preview needs the on-phone player, suspended while casting
      onNavigate: onClose, // collapse the remote so the pushed screen shows
      onEdit: () => { onClose(); router.push(`/edit-post/${current.id}`); },
      onDeleted: skipGone,
      onArchived: skipGone,
    });
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

  // Orientation for the two-column landscape remote (see the layout below). MUST
  // stay ABOVE the early return — a hook can never run conditionally.
  const { width: winW, height: winH } = useWindowDimensions();
  const landscape = winW > winH;

  if (!visible || !connected || !current) return null;

  const device = deviceName || t('tv.cast.yourTv');
  const isLive = !!current.isLive;
  const busy = playerState === 'loading' || playerState === 'buffering';
  // Ended: pin the bar full instead of letting a null position drop it to 0.
  const progress = ended ? 1 : durationSec > 0 ? Math.min(1, shownPos / durationSec) : 0;

  const doSeek = (sec: number) => { selection(); noteSeek(sec); seekTo(sec); };
  const doSkip = (delta: number) => { selection(); noteSeek(shownPos + delta); skip(delta); };

  // ── Reusable pieces, arranged one-column (portrait) or two-column (landscape).
  const posterEl = (
    <View style={styles.posterWrap}>
      {current.poster ? (
        <Image source={{ uri: current.poster }} style={styles.poster} resizeMode="cover" />
      ) : (
        <LinearGradient colors={GRADIENTS.primarySoft} style={styles.poster}>
          <Ionicons name="tv" size={56} color={colors.primary} />
        </LinearGradient>
      )}
    </View>
  );

  // Title marquee + author row (@username → profile, follow pill beside it).
  const metaEl = (
    <View style={styles.meta}>
      {current.isAd && (
        <View style={styles.sponsoredRow}>
          <Ionicons name="megaphone" size={11} color={colors.primary} />
          <Text style={styles.sponsoredLabel}>{t('ad.sponsored')}</Text>
        </View>
      )}
      <Marquee key={current.id}>
        <Text style={styles.title}>{current.title}</Text>
      </Marquee>
      {(!!current.subtitle || !!current.authorId) && (
        <View style={styles.authorRow}>
          {!!current.subtitle && (
            <TouchableOpacity
              onPress={goToProfile}
              disabled={!current.authorId}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
              style={styles.authorTap}
              activeOpacity={0.7}
            >
              <Text style={styles.subtitle} numberOfLines={1}>{current.subtitle}</Text>
            </TouchableOpacity>
          )}
          <FollowButton userId={current.authorId} />
        </View>
      )}
    </View>
  );

  // Social row — the on-TV video is still a Laybell post. Lives skip this.
  const socialEl = postId ? (
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
      <TouchableOpacity
        onPress={doShare}
        hitSlop={8}
        style={[styles.socialBtn, styles.socialBtnRight]}
        accessibilityLabel={t('share.title')}
      >
        <Ionicons name="share-social-outline" size={22} color={colors.text} />
      </TouchableOpacity>
    </View>
  ) : null;

  // For a sponsor there's no like/comment — instead the remote offers a big
  // "Learn More" CTA the viewer can tap on the phone while the ad plays on the TV.
  const openAdCta = () => {
    const ad = current.ad;
    if (!ad?.ctaUrl) return;
    linkGuard.open(ad.ctaUrl, {
      context: 'ad',
      sourceName: ad.advertiserName,
      onProceed: () => recordAdClick({ __ad: ad }, 'tv', uid),
    });
  };
  const adCtaEl = current.isAd && current.ad?.ctaUrl ? (
    <TouchableOpacity style={styles.adCta} onPress={openAdCta} activeOpacity={0.85}>
      <Text style={styles.adCtaText}>{current.ad.ctaLabel || t('reelAd.learnMore')}</Text>
      <Ionicons name="arrow-forward" size={16} color={colors.text} />
    </TouchableOpacity>
  ) : null;

  // Scrubber/LIVE + transport controls + up-next (or the error/retry state).
  const transportEl = mediaError ? (
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
            disabled={current.isAd}
          />
          <View style={styles.timeRow}>
            <Text style={styles.time}>{fmtTime(ended ? durationSec : shownPos)}</Text>
            <Text style={styles.time}>{durationSec > 0 ? fmtTime(durationSec) : '–:––'}</Text>
          </View>
        </View>
      )}

      {/* Transport: prev · −10s · play/pause/replay · +10s · next */}
      <View style={styles.controls}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.previousTrack')} onPress={() => { selection(); prev(); }} disabled={!hasPrev} hitSlop={10} style={styles.sideBtn}>
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
          <TouchableOpacity onPress={() => doSkip(10)} disabled={!!current.isAd} hitSlop={10} style={styles.skipBtn}>
            <Ionicons name="play-forward" size={22} color={current.isAd ? colors.textTertiary : colors.text} />
            <Text style={[styles.skipLabel, !!current.isAd && { color: colors.textTertiary }]}>10</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.nextTrack')} onPress={() => { selection(); next(); }} disabled={!hasNext} hitSlop={10} style={styles.sideBtn}>
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
            <Text style={[styles.upNextLabel, nextItem.isAd && { color: colors.primary }]}>
              {nextItem.isAd ? t('ad.sponsored') : t('tv.cast.upNext')}
            </Text>
            <Text style={styles.upNextTitle} numberOfLines={1}>{nextItem.title}</Text>
          </View>
          <Ionicons name="play-skip-forward" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      )}
    </>
  );

  const disconnectEl = (
    <TouchableOpacity onPress={() => { selection(); disconnect(); }} style={styles.disconnectBtn} activeOpacity={0.8}>
      <Ionicons name="power" size={15} color={colors.textSecondary} />
      <Text style={styles.disconnectText}>{t('tv.setup.disconnect')}</Text>
    </TouchableOpacity>
  );

  // Now-playing music card (only when a song is playing on the phone alongside
  // the TV). Cover + title/artist + play-pause, labelled so it's clearly the
  // PHONE's music, distinct from the TV content above it.
  const musicCardEl = currentTrack ? (
    <View style={styles.musicCard}>
      {currentTrack.cover ? (
        <Image source={{ uri: currentTrack.cover }} style={styles.musicCover} />
      ) : (
        <LinearGradient colors={GRADIENTS.primary} style={styles.musicCover}>
          <Ionicons name="musical-note" size={18} color="#fff" />
        </LinearGradient>
      )}
      <View style={styles.musicInfo}>
        <View style={styles.musicLabelRow}>
          <Ionicons name="musical-notes" size={11} color={colors.primary} />
          <Text style={styles.musicLabel}>{t('tv.cast.musicOnPhone')}</Text>
        </View>
        <Text style={styles.musicTitle} numberOfLines={1}>{currentTrack.caption}</Text>
        {!!currentTrack.artist && <Text style={styles.musicArtist} numberOfLines={1}>{currentTrack.artist}</Text>}
      </View>
      <TouchableOpacity
        onPress={() => { selection(); musicPlaying ? pauseMusic() : resumeMusic(); }}
        hitSlop={10}
        style={styles.musicPlayBtn}
      >
        <Ionicons name={musicPlaying ? 'pause' : 'play'} size={22} color={colors.text} />
      </TouchableOpacity>
    </View>
  ) : null;

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
      {/* Header: collapse chevron + destination + 3-dot */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel={t('a11y.collapse')}>
          <Ionicons name="chevron-down" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Ionicons name="tv" size={14} color={colors.primary} />
          <Text style={styles.headerText} numberOfLines={1}>
            {t('tv.cast.castingTo', { device })}
          </Text>
        </View>
        {postId || current.authorId ? (
          <TouchableOpacity onPress={openOptions} hitSlop={10} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerBtn} />
        )}
      </View>

      {landscape ? (
        // Two columns: poster + title on the left, controls on the right.
        <View style={styles.lsBody}>
          <View style={styles.lsLeft}>
            {posterEl}
            {metaEl}
          </View>
          <ScrollView style={styles.lsRight} contentContainerStyle={styles.lsRightContent} showsVerticalScrollIndicator={false}>
            {socialEl}
            {adCtaEl}
            {transportEl}
            {disconnectEl}
          </ScrollView>
        </View>
      ) : (
        <>
          {posterEl}
          {metaEl}
          {socialEl}
          {adCtaEl}
          {/* Empty slot between the post meta and the transport controls — the
              phone's now-playing music card lives here, centered, when a song is
              playing; otherwise it's just breathing room. */}
          <View style={styles.musicSlot}>{musicCardEl}</View>
          {transportEl}
          {disconnectEl}
        </>
      )}
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
  // Landscape two-column body: poster/title left, scrolling controls right.
  lsBody: { flex: 1, flexDirection: 'row', gap: SPACING.lg, marginTop: SPACING.xs },
  lsLeft: { width: '46%', justifyContent: 'center', gap: SPACING.sm },
  lsRight: { flex: 1 },
  lsRightContent: { flexGrow: 1, justifyContent: 'center', gap: SPACING.xs },
  meta: { marginTop: SPACING.lg, gap: 5 },
  sponsoredRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sponsoredLabel: { color: c.primary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { color: c.text, fontSize: 22, fontWeight: '800', lineHeight: 28 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  // shrink (not flex:1) so the follow pill hugs the username instead of
  // being pushed to the far edge, while long handles still truncate.
  authorTap: { flexShrink: 1 },
  subtitle: { color: c.textSecondary, fontSize: 15.5, fontWeight: '600' },
  socialRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.lg, marginTop: SPACING.md },
  socialBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  socialBtnRight: { marginLeft: 'auto' },
  // Sponsor "Learn More" CTA on the remote (replaces the social row for ads).
  adCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: SPACING.md, backgroundColor: c.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 3, paddingHorizontal: SPACING.lg,
  },
  adCtaText: { color: c.text, fontSize: 15, fontWeight: '800' },
  socialCount: { color: c.textSecondary, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  flexSpace: { flex: 1 },
  // Music card slot: the same flexible gap, but centers the card when present.
  musicSlot: { flex: 1, justifyContent: 'center' },
  musicCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, padding: SPACING.sm,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  musicCover: { width: 46, height: 46, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.surface },
  musicInfo: { flex: 1, minWidth: 0 },
  musicLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  musicLabel: { color: c.primary, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  musicTitle: { color: c.text, fontSize: 14, fontWeight: '700', marginTop: 1 },
  musicArtist: { color: c.textTertiary, fontSize: 12 },
  musicPlayBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
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
