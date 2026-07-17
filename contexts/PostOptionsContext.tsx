import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity,
  Pressable, Animated, PanResponder, Easing, Platform, ActivityIndicator,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS } from '../constants/theme';
import { confirmDeletePost, reportPost, reportUser, confirmArchivePost } from '../lib/postActions';
import { confirmBlockUser, isBlocked, unblockUser } from '../lib/blocks';
import { isAudioPost } from '../lib/genres';
import { supabase } from '../lib/supabase';
import { bumpBadge } from '../lib/badges';
import { createNotification } from '../lib/createNotification';
import { selection } from '../lib/haptics';
import { useProfile } from './ProfileContext';
import { useTranslation } from './LanguageContext';
import { isReposted, addRepost, removeRepost } from '../lib/reposts';
import { useDownloadAction } from '../hooks/useDownloadAction';
import { aspectToNumber } from '../lib/aspectRatio';
import { postToCastItem, type CastItem } from '../lib/cast';
import { useCast } from './CastContext';
import AddToPlaylistModal from '../components/AddToPlaylistModal';
import GifMakerModal from '../components/GifMakerModal';
import TVConnectModal from '../components/TVConnectModal';

export type PostOptionsArgs = {
  // postId is optional: omit it to show a profile-only (user) menu — e.g. the
  // block button from someone's profile page, where there's no specific post.
  postId?: string;
  isOwn: boolean;
  // The post's author / the target user — enables "Block user" and (for audio)
  // the "Artist" shortcut. authorName is the @handle used in labels/confirms.
  authorId?: string;
  authorName?: string;
  // The post's `type`. Audio-family posts (audio/podcast/audiobook) get the music
  // actions: Add to playlist, Like/Unlike, Save/Unsave, Artist, and Download.
  mediaType?: string | null;
  // Offline-download inputs for audio posts. mediaUrl is the remote audio URL
  // (posts.media_url) we pin; cover is the artwork. downloadable mirrors the
  // owner's posts.downloadable flag. Any of these may be omitted — the sheet
  // lazily fetches the missing pieces from `posts` when it opens an audio menu
  // (most call sites don't select `downloadable`), so callers only need to pass
  // what's already in scope.
  mediaUrl?: string | null;
  cover?: string | null;
  downloadable?: boolean;
  // The item is already playing on the TV (menu opened from the cast remote) —
  // hides the "Laybell TV" option, which would restart it and drop the queue.
  hideLaybellTv?: boolean;
  onEdit?: () => void;
  onDeleted?: () => void;
  onArchived?: () => void;
  onRepostChanged?: (reposted: boolean) => void;
  onBlocked?: () => void;
  // Keep an external like/save button (e.g. Now Playing) in sync when the menu
  // toggles it.
  onLikeChanged?: (liked: boolean) => void;
  onSaveChanged?: (saved: boolean) => void;
  // Called right before the sheet navigates away (Artist) — hosts that render an
  // overlay (Now Playing) pass their collapse() so the profile shows in front.
  onNavigate?: () => void;
  // When the menu is opened from inside one of the user's own playlists, the
  // "Add to playlist" slot becomes "Remove from playlist" and calls this.
  onRemoveFromPlaylist?: () => void;
  // Fired whenever the sheet closes (any path) — hosts that paused themselves
  // while the menu was up (e.g. the story viewer) resume here.
  onDismiss?: () => void;
};

type ContextValue = { show: (opts: PostOptionsArgs) => void };

const PostOptionsContext = createContext<ContextValue>({ show: () => {} });

export function usePostOptions() {
  return useContext(PostOptionsContext);
}

export function PostOptionsProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  const cast = useCast();
  const [opts, setOpts] = useState<PostOptionsArgs | null>(null);
  const [visible, setVisible] = useState(false);
  // "Add to playlist" opens a modal owned here (so it works from any 3-dot menu).
  const [playlistPostId, setPlaylistPostId] = useState<string | null>(null);
  // "Make GIF" opens the maker on the tapped video (owned here so it floats above
  // the sheet's overlay). {url, dur} of the source video, or null when closed.
  const [gifVideo, setGifVideo] = useState<{ url: string; dur: number; postId: string | null } | null>(null);
  // "Laybell TV" on a landscape video with no session up yet: the video waits
  // here while the connect wizard runs, then plays the moment the TV connects.
  const [tvConnect, setTvConnect] = useState<CastItem | null>(null);

  const show = (o: PostOptionsArgs) => { selection(); setOpts(o); setVisible(true); }; // native tick as the 3-dot / long-press sheet opens

  const sheets = (
    <>
      <PostOptionsSheet
        visible={visible}
        opts={opts}
        onClose={() => { setVisible(false); opts?.onDismiss?.(); }}
        onAddToPlaylist={setPlaylistPostId}
        onMakeGif={(url, dur, postId) => setGifVideo({ url, dur, postId: postId ?? null })}
        onLaybellTv={(item) => {
          // Already casting → throw it straight to the TV; otherwise run the
          // guided connect wizard with this video queued up.
          if (cast.connected) cast.cast(item);
          else setTvConnect(item);
        }}
      />
      <AddToPlaylistModal
        visible={!!playlistPostId}
        postId={playlistPostId ?? ''}
        onClose={() => setPlaylistPostId(null)}
        inOverlay
      />
      <GifMakerModal
        visible={!!gifVideo}
        videoUrl={gifVideo?.url ?? null}
        durationSec={gifVideo?.dur ?? null}
        userId={profile?.id ?? null}
        sourcePostId={gifVideo?.postId ?? null}
        onClose={() => setGifVideo(null)}
        inOverlay
      />
    </>
  );

  return (
    <PostOptionsContext.Provider value={{ show }}>
      {children}
      {/* iOS: hosted in a FullWindowOverlay so the sheet presents ABOVE the
          native-modal swipe-back screens (playlist viewer, settings, …) —
          otherwise it opens invisibly behind them. */}
      {Platform.OS === 'ios' ? <FullWindowOverlay>{sheets}</FullWindowOverlay> : sheets}
      {/* The TV connect wizard is a REAL native Modal, so it must live OUTSIDE
          the FullWindowOverlay (presenting a Modal from the overlay's window
          deadlocks iOS — see the sheet's presentation note). The 3-dot sheet is
          already dismissed by the time this opens, so nothing overlaps. */}
      <TVConnectModal visible={!!tvConnect} onClose={() => setTvConnect(null)} pendingItem={tvConnect} />
    </PostOptionsContext.Provider>
  );
}

const DISMISS_DIST = 300;

function rubber(drag: number, max = 32): number {
  return max * (1 - Math.exp(-drag / max));
}

type Opt = {
  key: string;
  label: string;
  icon: any;
  destructive?: boolean;
  active?: boolean;        // filled state for like/save
  activeColor?: string;
  loading?: boolean;       // show a spinner in place of the icon (e.g. downloading)
  accessibilityLabel?: string;
  onPress: () => void;
};

export function PostOptionsSheet({ visible, opts, onClose, onAddToPlaylist, onMakeGif, onLaybellTv }: {
  visible: boolean;
  opts: PostOptionsArgs | null;
  onClose: () => void;
  onAddToPlaylist: (postId: string) => void;
  onMakeGif: (videoUrl: string, durationSec: number, postId?: string | null) => void;
  onLaybellTv: (item: CastItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useProfile();
  const { t } = useTranslation();
  const { download, confirmRemove, isPinned, isDownloading } = useDownloadAction();
  const translateY = useRef(new Animated.Value(DISMISS_DIST)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const optsRef = useRef(opts); optsRef.current = opts;
  const [reposted, setReposted] = useState(false);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // Offline-download inputs for the audio post. Seeded from the args, then
  // back-filled by a lazy `posts` fetch when the args don't carry them (most
  // call sites don't select media_url/cover_url/downloadable).
  const [dlUrl, setDlUrl] = useState<string | null>(null);
  const [dlCover, setDlCover] = useState<string | null>(null);
  const [dlTitle, setDlTitle] = useState('');
  const [downloadable, setDownloadable] = useState(true);
  // Source video for "Make GIF" (video posts). Seeded from args, back-filled by a
  // lazy posts fetch for media_url + duration.
  const [vidUrl, setVidUrl] = useState<string | null>(null);
  const [vidDur, setVidDur] = useState(0);
  // Creator opt-out: when the video's owner turned off "Allow GIFs" at posting,
  // hide the Make GIF option. Defaults true (opt-out only, safe pre-migration).
  const [allowGifs, setAllowGifs] = useState(true);
  // Laybell TV eligibility (landscape video — mirrors lib/tv.isHorizontalVideo)
  // + the caption/thumbnail the cast payload shows on the TV. Back-filled by the
  // same lazy video fetch; null aspect (pre-fetch) keeps the option hidden.
  const [vidAspect, setVidAspect] = useState<any>(null);
  const [vidCaption, setVidCaption] = useState<string | null>(null);
  const [vidThumb, setVidThumb] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      translateY.setValue(DISMISS_DIST);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();

      // Resolve the dynamic option states for this post/user.
      setReposted(false); setLiked(false); setSaved(false); setBlocked(false);
      const o = opts;
      const uid = profile?.id;
      if (o && !o.isOwn && uid) {
        if (o.postId) isReposted(o.postId, uid).then(setReposted);
        if (o.authorId) isBlocked(o.authorId).then(setBlocked);
      }
      if (o?.postId && isAudioPost(o.mediaType) && uid) {
        supabase.from('likes').select('user_id').eq('post_id', o.postId).eq('user_id', uid).maybeSingle()
          .then(({ data }) => setLiked(!!data));
        supabase.from('saves').select('id').eq('post_id', o.postId).eq('user_id', uid).maybeSingle()
          .then(({ data }) => setSaved(!!data));
      }
      // Download inputs: seed from args, then fetch the rest. We always fetch for
      // audio posts because the song TITLE (caption) is needed for the Downloads
      // list and is never in the args; the same round-trip back-fills media_url /
      // cover / downloadable when the caller didn't pass them.
      if (o?.postId && isAudioPost(o.mediaType)) {
        setDlUrl(o.mediaUrl ?? null);
        setDlCover(o.cover ?? null);
        setDownloadable(o.downloadable ?? true);
        setDlTitle('');
        supabase.from('posts').select('media_url, cover_url, downloadable, caption').eq('id', o.postId).maybeSingle()
          .then(({ data }) => {
            if (!data) return;
            const d = data as any;
            if (!o.mediaUrl) setDlUrl(d.media_url ?? null);
            if (o.cover == null) setDlCover(d.cover_url ?? null);
            if (o.downloadable === undefined) setDownloadable(d.downloadable ?? true);
            setDlTitle(d.caption ?? '');
          }, () => {});
      } else {
        setDlUrl(null); setDlCover(null); setDownloadable(true); setDlTitle('');
      }
      // Video posts: resolve media_url + duration so "Make GIF" can open the
      // maker, plus aspect/caption/thumbnail so "Laybell TV" can appear on
      // landscape videos and cast with the right title/poster.
      if (o?.postId && o.mediaType === 'video') {
        setVidUrl(o.mediaUrl ?? null); setVidDur(0); setAllowGifs(true);
        setVidAspect(null); setVidCaption(null); setVidThumb(null);
        supabase.from('posts').select('media_url, duration_seconds, allow_gifs, aspect_ratio, caption, thumbnail_url').eq('id', o.postId).maybeSingle()
          .then(({ data }) => {
            const d = data as any;
            if (!d) return;
            setVidUrl(d.media_url ?? o.mediaUrl ?? null);
            setVidDur(Number(d.duration_seconds) || 0);
            setAllowGifs(d.allow_gifs !== false);
            setVidAspect(d.aspect_ratio ?? null);
            setVidCaption(d.caption ?? null);
            setVidThumb(d.thumbnail_url ?? null);
          }, () => {});
      } else {
        setVidUrl(null); setVidDur(0); setAllowGifs(true);
        setVidAspect(null); setVidCaption(null); setVidThumb(null);
      }
    }
  }, [visible]);

  function dismiss() {
    Animated.parallel([
      Animated.timing(translateY, { toValue: DISMISS_DIST, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => closeRef.current());
  }

  // Run an action after the dismiss animation so the sheet is gone first.
  function dismissThen(fn: () => void) { dismiss(); setTimeout(fn, 280); }

  function toggleRepost() {
    const o = optsRef.current;
    const uid = profile?.id;
    if (!o?.postId || !uid) { dismiss(); return; }
    const next = !reposted;
    setReposted(next); // optimistic
    (next ? addRepost(o.postId, uid) : removeRepost(o.postId, uid)).then((ok) => {
      if (ok) o.onRepostChanged?.(next);
      else setReposted(!next); // revert if the write failed (e.g. table not migrated)
    });
    dismiss();
  }

  // Like/Save toggles keep the sheet OPEN so the filled state is visible and the
  // user can chain actions (e.g. like, then add to playlist).
  async function toggleLike() {
    const o = optsRef.current;
    const uid = profile?.id;
    if (!o?.postId || !uid) return;
    const next = !liked;
    setLiked(next); // optimistic
    if (next) {
      await supabase.from('likes').insert({ user_id: uid, post_id: o.postId });
      bumpBadge('likes');
      if (o.authorId && o.authorId !== uid) {
        createNotification({ userId: o.authorId, actorId: uid, type: 'like', postId: o.postId });
      }
    } else {
      await supabase.from('likes').delete().eq('user_id', uid).eq('post_id', o.postId);
    }
    o.onLikeChanged?.(next);
  }

  async function toggleSave() {
    const o = optsRef.current;
    const uid = profile?.id;
    if (!o?.postId || !uid) return;
    const next = !saved;
    setSaved(next); // optimistic
    if (next) await supabase.from('saves').insert({ user_id: uid, post_id: o.postId });
    else await supabase.from('saves').delete().eq('user_id', uid).eq('post_id', o.postId);
    o.onSaveChanged?.(next);
  }

  // Download / remove-download for any viewer. Keeps the sheet OPEN so the
  // pinned/removing state is reflected (and the spinner shows while pinning).
  function toggleDownload() {
    const o = optsRef.current;
    if (!o?.postId) return;
    if (isDownloading(o.postId)) return;
    if (isPinned(o.postId)) {
      confirmRemove(o.postId, dlTitle || undefined);
    } else if (dlUrl) {
      download({ id: o.postId, uri: dlUrl, title: dlTitle || undefined, artist: o.authorName, cover: dlCover, downloadable });
    }
  }

  // Owner-only toggle of posts.downloadable. Optimistic + fire-and-forget; keeps
  // the sheet open so the on/off state is visible.
  function toggleDownloadable() {
    const o = optsRef.current;
    if (!o?.postId) return;
    const next = !downloadable;
    setDownloadable(next); // optimistic
    supabase.from('posts').update({ downloadable: next }).eq('id', o.postId).then(undefined, () => {});
  }

  // Ownership is authoritative from the app-wide ProfileContext. A caller may
  // pass isOwn:false only because ITS locally-fetched currentUserId hadn't
  // loaded yet — the seed-rendered post/reel screens render your tapped post
  // instantly but resolve the user id a beat later, which made your OWN post's
  // 3-dot show another user's menu (Repost/Report/Block). profile.id is loaded
  // once at app start, so whenever the post's authorId matches it, it's yours —
  // no false positives (authorId is always the post's owner).
  const isOwn = (opts?.isOwn ?? false) ||
    (!!opts?.authorId && !!profile?.id && opts.authorId === profile.id);
  const hasPost = !!opts?.postId;
  const isAudio = isAudioPost(opts?.mediaType);
  const target = opts?.authorName ? `@${opts.authorName}` : t('postOptions.user');

  const blockOpt: Opt = blocked
    ? { key: 'unblock', label: t('postOptions.unblockTarget', { target }), icon: 'person-add-outline',
        onPress: () => { const o = optsRef.current; dismissThen(async () => { if (o?.authorId) { await unblockUser(o.authorId); o.onBlocked?.(); } }); } }
    : { key: 'block', label: t('postOptions.blockTarget', { target }), icon: 'ban-outline', destructive: true,
        onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.authorId) confirmBlockUser(o.authorId, o.authorName, o.onBlocked); }); } };

  const options: Opt[] = [];

  // ── Music actions (audio posts) ───────────────────────────────────────────
  if (hasPost && isAudio) {
    if (opts?.onRemoveFromPlaylist) {
      // Opened from inside one of the user's playlists — the playlist slot
      // removes the song from THAT playlist instead of adding to one.
      options.push({ key: 'playlist', label: t('postOptions.removeFromPlaylist'), icon: 'remove-circle-outline',
        onPress: () => { const o = optsRef.current; dismissThen(() => o?.onRemoveFromPlaylist?.()); } });
    } else {
      options.push({ key: 'playlist', label: t('postOptions.addToPlaylist'), icon: 'add-circle-outline',
        onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) onAddToPlaylist(o.postId); }); } });
    }
    options.push({ key: 'like', label: liked ? t('postOptions.unlike') : t('postOptions.like'), icon: liked ? 'heart' : 'heart-outline',
      active: liked, activeColor: COLORS.like, onPress: toggleLike });
    options.push({ key: 'save', label: saved ? t('postOptions.unsave') : t('postOptions.save'), icon: saved ? 'bookmark' : 'bookmark-outline',
      active: saved, activeColor: COLORS.primary, onPress: toggleSave });
    // Download for offline (any viewer). Pinned → "Remove download"; otherwise
    // "Download". useDownloadAction owns all the failure alerts (tier/space/opt-out).
    {
      const pinned = !!opts?.postId && isPinned(opts.postId);
      const downloading = !!opts?.postId && isDownloading(opts.postId);
      options.push(pinned
        ? { key: 'download', label: t('offline.remove'), icon: 'trash-outline', loading: downloading,
            accessibilityLabel: t('offline.remove'), onPress: toggleDownload }
        : { key: 'download', label: t('offline.download'), icon: 'cloud-download-outline', loading: downloading,
            accessibilityLabel: t('offline.download'), onPress: toggleDownload });
    }
    // Owner-only: toggle whether listeners may download this track.
    if (isOwn) {
      options.push({ key: 'downloadable', label: t('offline.downloadableLabel'),
        icon: downloadable ? 'cloud-done' : 'cloud-offline-outline',
        active: downloadable, activeColor: COLORS.primary,
        accessibilityLabel: t('offline.downloadableLabel'), onPress: toggleDownloadable });
    }
    if (opts?.authorId && !isOwn) {
      options.push({ key: 'artist', label: t('postOptions.artist'), icon: 'person-outline',
        onPress: () => { const o = optsRef.current; dismissThen(() => { o?.onNavigate?.(); if (o?.authorId) router.push(`/profile/${o.authorId}`); }); } });
    }
  }

  // ── Laybell TV (landscape videos, any viewer) ──────────────────────────────
  // Same eligibility as the Laybell TV hub (aspect > 1; null pre-fetch aspect
  // stays hidden). Casting already? The video goes straight to the TV. Not yet?
  // The connect wizard opens with this video queued — it plays on connect.
  if (hasPost && opts?.mediaType === 'video' && !opts?.hideLaybellTv && aspectToNumber(vidAspect, 9 / 16) > 1) {
    options.push({ key: 'laybelltv', label: t('tv.title'), icon: 'tv-outline',
      onPress: () => {
        const o = optsRef.current;
        const url = vidUrl ?? o?.mediaUrl ?? null;
        if (!o?.postId || !url) { dismiss(); return; }
        const item = postToCastItem({
          id: o.postId,
          media_url: url,
          caption: vidCaption,
          thumbnail_url: vidThumb,
          user_id: o.authorId,
          profiles: { username: o.authorName },
        });
        dismissThen(() => { if (item) onLaybellTv(item); });
      } });
  }

  // ── Make GIF (any video, any viewer — unless the creator opted out) ────────
  if (hasPost && opts?.mediaType === 'video' && allowGifs) {
    options.push({ key: 'makegif', label: t('postOptions.makeGif'), icon: 'film-outline',
      onPress: () => {
        const o = optsRef.current;
        const url = vidUrl ?? o?.mediaUrl ?? null;
        dismissThen(() => { if (url) onMakeGif(url, vidDur, o?.postId ?? null); });
      } });
  }

  // ── Ownership / general actions ────────────────────────────────────────────
  if (hasPost && isOwn) {
    options.push({ key: 'edit', label: t('postOptions.editPost'), icon: 'pencil-outline',
      onPress: () => dismissThen(() => optsRef.current?.onEdit?.()) });
    options.push({ key: 'archive', label: t('postOptions.archivePost'), icon: 'archive-outline',
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmArchivePost(o.postId, o.onArchived); }); } });
    options.push({ key: 'delete', label: t('postOptions.deletePost'), icon: 'trash-outline', destructive: true,
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmDeletePost(o.postId, o.onDeleted); }); } });
  } else if (hasPost && !isOwn) {
    options.push({ key: 'repost', label: reposted ? t('postOptions.removeFromReposts') : t('postOptions.repost'),
      icon: reposted ? 'repeat' : 'repeat-outline', onPress: toggleRepost });
    options.push({ key: 'report', label: t('postOptions.reportPost'), icon: 'flag-outline', destructive: true,
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) reportPost(o.postId); }); } });
    if (opts?.authorId) options.push(blockOpt);
  } else if (!hasPost && opts?.authorId && !isOwn) {
    // Profile-only menu (no specific post): report + block the user.
    options.push({ key: 'report-user', label: t('postOptions.reportUser'), icon: 'flag-outline', destructive: true,
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.authorId) reportUser(o.authorId); }); } });
    options.push(blockOpt);
  }

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 3,
    onPanResponderMove: (_e, g) => {
      if (g.dy < 0) {
        translateY.setValue(-rubber(Math.abs(g.dy)));
        backdrop.setValue(1);
      } else {
        const dy = g.dy;
        translateY.setValue(dy);
        backdrop.setValue(Math.max(0, 1 - dy / DISMISS_DIST));
      }
    },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 60 || g.vy > 1.2) {
        Animated.parallel([
          Animated.timing(translateY, { toValue: DISMISS_DIST, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
          Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
        ]).start(() => closeRef.current());
      } else {
        Animated.parallel([
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 5, speed: 16 }),
          Animated.timing(backdrop, { toValue: 1, duration: 150, useNativeDriver: true }),
        ]).start();
      }
    },
  })).current;

  const content = (
    <View style={styles.overlay}>
      <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.sm, transform: [{ translateY }] }]}>
        <View style={styles.grab} {...pan.panHandlers}>
          <View style={styles.handle} />
        </View>
        <View style={styles.divider} />
        {options.map((opt, i) => (
          <TouchableOpacity
            key={opt.key}
            style={[styles.option, i < options.length - 1 && styles.optionBorder]}
            onPress={opt.onPress}
            activeOpacity={0.7}
            accessibilityLabel={opt.accessibilityLabel}
          >
            <View style={[
              styles.iconWrap,
              opt.destructive && styles.iconWrapDestructive,
              opt.active && { backgroundColor: (opt.activeColor ?? COLORS.primary) + '1A' },
            ]}>
              {opt.loading ? (
                <ActivityIndicator size="small" color={COLORS.text} />
              ) : (
                <Ionicons
                  name={opt.icon}
                  size={20}
                  color={opt.active ? (opt.activeColor ?? COLORS.primary) : opt.destructive ? COLORS.error : COLORS.text}
                />
              )}
            </View>
            <Text style={[styles.optionLabel, opt.destructive && styles.destructive]}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
      </Animated.View>
    </View>
  );

  // iOS: this sheet lives inside the provider's FullWindowOverlay, which
  // already floats above EVERYTHING (native-modal screens included). A real
  // <Modal> in there tries to present from the overlay's window and DEADLOCKS
  // the app — so on iOS the overlay itself is the presentation layer.
  if (Platform.OS === 'ios') {
    return visible ? <View style={StyleSheet.absoluteFill}>{content}</View> : null;
  }
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  grab: { alignItems: 'center', paddingVertical: SPACING.sm },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: COLORS.border },
  divider: { height: 0.5, backgroundColor: COLORS.border },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md + SPACING.xs,
    gap: SPACING.md,
  },
  optionBorder: { borderBottomWidth: 0.5, borderBottomColor: COLORS.border },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapDestructive: { backgroundColor: '#F43F5E18' },
  optionLabel: { color: COLORS.text, fontSize: 16, fontWeight: '500' },
  destructive: { color: COLORS.error },
});
