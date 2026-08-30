import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, useWindowDimensions,
  Pressable, Animated, PanResponder, Easing, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from './ThemeContext';
import { confirmDeletePost, reportPost, reportUser, confirmArchivePost } from '../lib/postActions';
import { withdrawSound, soundIsAvailable } from '../lib/sounds';
import { confirmBlockUser, isBlocked, unblockUser } from '../lib/blocks';
import { isAudioPost } from '../lib/genres';
import { supabase } from '../lib/supabase';
import { selection } from '../lib/haptics';
import { useProfile } from './ProfileContext';
import { useTranslation } from './LanguageContext';
import { isReposted, addRepost, removeRepost } from '../lib/reposts';
import { useDownloadAction } from '../hooks/useDownloadAction';
import { aspectToNumber } from '../lib/aspectRatio';
import { postToCastItem, type CastItem } from '../lib/cast';
import { useCast } from './CastContext';
import { openShareGlobal } from './ShareContext';
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
  // Video posts: seed Laybell TV eligibility (aspect_ratio) + the cast payload
  // (caption / thumbnail) so the "Laybell TV" row renders IMMEDIATELY for
  // landscape videos instead of popping in a network round-trip later (its
  // visibility keys off aspect). Callers that already hold the post row should
  // pass these; when omitted the lazy posts fetch back-fills them (old delay).
  aspect?: string | number | null;
  caption?: string | null;
  thumbnail?: string | null;
  // The item is already playing on the TV (menu opened from the cast remote) —
  // hides the "Laybell TV" option, which would restart it and drop the queue.
  hideLaybellTv?: boolean;
  // Opened from a Laybell TV surface — hides "Make GIF". The GIF maker's preview
  // is an on-phone video player, which a live cast session suspends (background
  // media is silenced behind the TV), so the frame preview never loads there.
  hideMakeGif?: boolean;
  onEdit?: () => void;
  onDeleted?: () => void;
  onArchived?: () => void;
  onRepostChanged?: (reposted: boolean) => void;
  onBlocked?: () => void;
  // Called right before the sheet navigates away (Artist) — hosts that render an
  // overlay (Now Playing) pass their collapse() so the profile shows in front.
  onNavigate?: () => void;
  // When the menu is opened from inside one of the user's own playlists, the
  // "Add to playlist" slot becomes "Remove from playlist" and calls this.
  onRemoveFromPlaylist?: () => void;
  // ── Hiding a song or video from the profile GRID ──────────────────────────
  // Not archiving: the post stays public, keeps its link, keeps playing, and
  // keeps its place on the Music or Videos tab. It just stops taking a square
  // in the Posts grid, so a musician can keep that grid visual.
  //
  // OFFERED ONLY WHEN THE OWNER HAS A PICTURE TO SHOW INSTEAD (canHideFromGrid),
  // because a grid emptied by hiding is worse than a mixed one — and pictures
  // themselves are never hideable this way. The only way a photo leaves the
  // grid is archiving, which takes it off the profile entirely and is therefore
  // a decision someone makes on purpose.
  hideFromGrid?: boolean;
  canHideFromGrid?: boolean;
  onGridVisibilityChanged?: (hidden: boolean) => void;
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

  // STABLE for the provider's lifetime. It only calls setState + a haptic, all
  // of which are themselves stable, so there is nothing to re-create.
  const show = useCallback((o: PostOptionsArgs) => {
    selection(); // native tick as the 3-dot / long-press sheet opens
    setOpts(o);
    setVisible(true);
  }, []);

  // Memoised, and this matters more than it looks. The value used to be a fresh
  // `{ show }` object on every provider render, and the provider re-renders on
  // every sheet state change — so opening or closing the 3-dot menu re-rendered
  // EVERY consumer of this context, the home feed included. That is why the
  // sheet felt heavier from Home than from the reel viewer, which hosts its own
  // copy instead of going through here. With a stable identity, consumers no
  // longer re-render at all when the sheet opens or closes.
  const ctxValue = useMemo(() => ({ show }), [show]);

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
    <PostOptionsContext.Provider value={ctxValue}>
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
  // Live theme (was the static dark COLORS): in white mode the sheet now
  // renders as a light menu instead of a mismatched dark one.
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Cap the sheet so it never exceeds the screen — in landscape the option list
  // is taller than the short viewport, which used to run off the top (clipped).
  // The list scrolls within this cap instead.
  const { height: winH } = useWindowDimensions();
  const sheetMaxHeight = winH - insets.top - SPACING.xl;
  const router = useRouter();
  const { profile } = useProfile();
  const { t } = useTranslation();
  const { download, confirmRemove, isPinned, isDownloading } = useDownloadAction();
  const translateY = useRef(new Animated.Value(DISMISS_DIST)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const optsRef = useRef(opts); optsRef.current = opts;
  const [reposted, setReposted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  // Offline-download inputs for the audio post. Seeded from the args, then
  // back-filled by a lazy `posts` fetch when the args don't carry them (most
  // call sites don't select media_url/cover_url/downloadable).
  // Is this audio still offered in the sound picker? Drives the withdraw action.
  const [soundAvailable, setSoundAvailable] = useState(false);
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
      setReposted(false); setBlocked(false);
      const o = opts;
      const uid = profile?.id;
      if (o && !o.isOwn && uid) {
        if (o.postId) isReposted(o.postId, uid).then(setReposted);
        if (o.authorId) isBlocked(o.authorId).then(setBlocked);
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
        // Sync-consent state, fetched separately from the download info above so a
        // pre-migration database (no sound_* columns) fails only this query and
        // doesn't take the Downloads row down with it.
        setSoundAvailable(false);
        supabase.from('posts').select('sound_opt_in, sound_withdrawn_at').eq('id', o.postId).maybeSingle()
          .then(({ data }) => setSoundAvailable(soundIsAvailable({
            optIn: (data as any)?.sound_opt_in,
            withdrawnAt: (data as any)?.sound_withdrawn_at ?? null,
          })), () => setSoundAvailable(false));
      } else {
        setDlUrl(null); setDlCover(null); setDownloadable(true); setDlTitle('');
        setSoundAvailable(false);
      }
      // Video posts: resolve media_url + duration so "Make GIF" can open the
      // maker, plus aspect/caption/thumbnail so "Laybell TV" can appear on
      // landscape videos and cast with the right title/poster.
      if (o?.postId && o.mediaType === 'video') {
        // Seed from the args the caller already has (aspect drives the Laybell TV
        // row's visibility) so it renders on first paint — no pop-in.
        setVidUrl(o.mediaUrl ?? null); setVidDur(0); setAllowGifs(true);
        setVidAspect(o.aspect ?? null); setVidCaption(o.caption ?? null); setVidThumb(o.thumbnail ?? null);
        supabase.from('posts').select('media_url, duration_seconds, allow_gifs, aspect_ratio, caption, thumbnail_url').eq('id', o.postId).maybeSingle()
          .then(({ data }) => {
            const d = data as any;
            if (!d) return;
            setVidUrl(d.media_url ?? o.mediaUrl ?? null);
            setVidDur(Number(d.duration_seconds) || 0);
            setAllowGifs(d.allow_gifs !== false);
            // Back-fill ONLY what the caller didn't seed — overwriting a seeded
            // aspect could make the row flash out then back in.
            if (o.aspect == null) setVidAspect(d.aspect_ratio ?? null);
            if (o.caption == null) setVidCaption(d.caption ?? null);
            if (o.thumbnail == null) setVidThumb(d.thumbnail_url ?? null);
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
    ]).start(({ finished }) => {
      // Tear down on the NEXT frame, not on the animation's final one.
      //
      // closeRef flips the host's state, which re-renders the whole host (in the
      // reel viewer: the screen, its list and every sheet) AND unmounts this
      // sheet's entire subtree — ScrollView, every option row, every icon; on
      // Android a real native Modal window. Running all of that in the same
      // frame the animation lands is what made the collapse end with a visible
      // stutter. One frame later the sheet is already invisible (opacity 0,
      // translated off), so nothing about the teardown can be seen — it just
      // stops being felt.
      if (!finished) { closeRef.current(); return; }
      requestAnimationFrame(() => closeRef.current());
    });
  }

  // Run an action after the dismiss animation so the sheet is gone first.
  function dismissThen(fn: () => void) { dismiss(); setTimeout(fn, 280); }

  // Withdrawing a sound edits OTHER people's posts — their video survives but the
  // borrowed audio stops and the credit disappears. That is a bigger action than
  // it sounds, so it confirms first and then reports how many posts it touched.
  function confirmWithdrawSound(postId: string) {
    Alert.alert(
      t('postOptions.withdrawSound'),
      t('postOptions.withdrawSoundBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('postOptions.withdrawSoundConfirm'),
          style: 'destructive',
          onPress: async () => {
            const res = await withdrawSound(postId);
            if (!res.ok) { Alert.alert(t('common.error'), res.error ?? ''); return; }
            setSoundAvailable(false);
            Alert.alert(
              t('postOptions.withdrawSoundDoneTitle'),
              t('postOptions.withdrawSoundDone', { count: String(res.postsUpdated) }),
            );
          },
        },
      ],
    );
  }

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
  // Hoisted ABOVE the option-list build so every hook in this component runs
  // before the visibility guard below. Its closure only touches values defined
  // further up (translateY / backdrop / closeRef / rubber / DISMISS_DIST), so
  // moving it is behaviour-neutral.
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
      // Softened from (60, 1.2). The gesture can only start on the grab strip,
      // where there is nothing else to do, so any downward drag that gets here
      // is already a dismiss attempt — holding it to a long pull or a hard flick
      // just made the sheet feel sticky. A short pull or an ordinary flick now
      // counts.
      if (g.dy > 48 || g.vy > 0.85) {
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

  // NOTHING below this line is built while the sheet is closed.
  //
  // This component stays mounted for every host that can show a 3-dot menu —
  // including the reel viewer, which re-renders it several times per swipe. It
  // used to construct the entire option list (~10 entries, each with t()
  // lookups and fresh closures) and its ~32-element tree on EVERY one of those
  // renders, then discard the result because `visible` was false. That was the
  // largest remaining piece of pure waste on the reel swipe path, and it made
  // the sheet's own collapse heavier than it needed to be.
  if (!visible) return null;

  const hasPost = !!opts?.postId;
  const isAudio = isAudioPost(opts?.mediaType);
  const target = opts?.authorName ? `@${opts.authorName}` : t('postOptions.user');

  const blockOpt: Opt = blocked
    ? { key: 'unblock', label: t('postOptions.unblockTarget', { target }), icon: 'person-add-outline',
        onPress: () => { const o = optsRef.current; dismissThen(async () => { if (o?.authorId) { await unblockUser(o.authorId); o.onBlocked?.(); } }); } }
    : { key: 'block', label: t('postOptions.blockTarget', { target }), icon: 'ban-outline', destructive: true,
        onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.authorId) confirmBlockUser(o.authorId, o.authorName, o.onBlocked); }); } };

  const options: Opt[] = [];

  // ── Share (ANY post, first in every menu) ─────────────────────────────────
  // Was audio-only, sitting below Like/Save. Now that those are gone it leads,
  // because it's the one action that means the same thing on every post type.
  // Opens the SAME global share sheet the rest of the app uses — via the
  // module-level opener, because this sheet renders ABOVE ShareProvider and a
  // useShare() here would resolve to the no-op default (see openShareGlobal).
  //
  // The payload falls back through whichever lazy back-fill ran for this media
  // type (dl* for audio, vid* for video), so the share sheet's preview shows a
  // real title and thumbnail even from the many call sites that pass neither.
  // Only the in-app preview depends on this: the link's own unfurl card is
  // built server-side from the post id.
  if (hasPost) {
    const shareCaption = opts?.caption ?? (isAudio ? (dlTitle || null) : vidCaption);
    const shareCover = opts?.cover ?? opts?.thumbnail ?? (isAudio ? dlCover : vidThumb);
    const shareMedia = opts?.mediaUrl ?? (isAudio ? dlUrl : vidUrl);
    options.push({ key: 'share', label: t('postOptions.share'), icon: 'share-social-outline',
      onPress: () => {
        const o = optsRef.current;
        dismissThen(() => {
          if (!o?.postId) return;
          openShareGlobal({
            postId: o.postId,
            caption: shareCaption,
            username: o.authorName ?? null,
            cover: shareCover,
            type: o.mediaType ?? null,
            mediaUrl: shareMedia,
          });
        });
      } });
  }

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
        active: downloadable, activeColor: colors.primary,
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
  if (hasPost && opts?.mediaType === 'video' && allowGifs && !opts?.hideMakeGif) {
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
    // Grid visibility — songs and videos only, and only where a picture is left
    // to fill the space. Sits ABOVE archive because it is the gentler of the two
    // and the one people actually want: archive removes the post, this only
    // moves it off one grid.
    // An ALLOW-list, not "anything that is not a picture": a media type nobody
    // has thought about yet should not quietly become hideable.
    if (opts?.canHideFromGrid && (opts?.mediaType === 'video' || isAudioPost(opts?.mediaType))) {
      const hidden = !!opts?.hideFromGrid;
      options.push({
        key: 'gridvis',
        label: t(hidden ? 'postOptions.showOnGrid' : 'postOptions.hideFromGrid'),
        icon: hidden ? 'grid-outline' : 'eye-off-outline',
        onPress: () => {
          const o = optsRef.current;
          dismissThen(async () => {
            if (!o?.postId) return;
            const next = !o.hideFromGrid;
            const { error } = await supabase.from('posts').update({ hide_from_grid: next }).eq('id', o.postId);
            // Silent on failure — the grid is unchanged, which is the truth, and
            // an alert about a column that may not be migrated yet helps nobody.
            if (!error) o.onGridVisibilityChanged?.(next);
          });
        },
      });
    }
    options.push({ key: 'archive', label: t('postOptions.archivePost'), icon: 'archive-outline',
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmArchivePost(o.postId, o.onArchived); }); } });
    options.push({ key: 'delete', label: t('postOptions.deletePost'), icon: 'trash-outline', destructive: true,
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmDeletePost(o.postId, o.onDeleted); }); } });
    // The sync kill switch. Only meaningful on audio, and only worth showing when
    // the sound is still available — withdrawing twice does nothing. Destructive
    // styling because it edits other people's posts: their video keeps playing,
    // but the borrowed audio stops.
    if (isAudioPost(optsRef.current?.mediaType) && soundAvailable) {
      options.push({ key: 'withdraw-sound', label: t('postOptions.withdrawSound'),
        icon: 'musical-notes-outline', destructive: true,
        onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmWithdrawSound(o.postId); }); } });
    }
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


  const content = (
    <View style={styles.overlay}>
      <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { maxHeight: sheetMaxHeight, paddingBottom: insets.bottom + SPACING.sm, transform: [{ translateY }] }]}>
        <View style={styles.grab} {...pan.panHandlers}>
          <View style={styles.handle} />
        </View>
        <View style={styles.divider} />
        {/* flexShrink lets the list scroll within the sheet's maxHeight instead
            of overflowing the top when there are many options (landscape). */}
        <ScrollView style={styles.optionsScroll} bounces={false} showsVerticalScrollIndicator={false}>
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
                opt.active && { backgroundColor: (opt.activeColor ?? colors.primary) + '1A' },
              ]}>
                {opt.loading ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Ionicons
                    name={opt.icon}
                    size={20}
                    color={opt.active ? (opt.activeColor ?? colors.primary) : opt.destructive ? colors.error : colors.text}
                  />
                )}
              </View>
              <Text style={[styles.optionLabel, opt.destructive && styles.destructive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
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

// Themed (light/grey/dark) — the 3-dot menu must match the active display mode.
const makeStyles = (c: ThemePalette) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  // The drag-to-dismiss target, and it is ONLY this strip — the options below
  // sit in a ScrollView that owns its own vertical gestures. At
  // paddingVertical: SPACING.sm it measured 21pt tall (8 + 5 + 8), under half
  // Apple's 44pt minimum, so a swipe that started even slightly below the
  // handle landed on the first option row and the sheet just sat there.
  //
  // Now 45pt (16 + 5 + 24), weighted BELOW the handle because that's the side
  // people undershoot from — the thumb travels up to the sheet and starts the
  // drag a little low. Deliberately no more than that: the strip has to stay
  // clear of the first option, which is a real tap target.
  grab: { alignItems: 'center', paddingTop: SPACING.md, paddingBottom: SPACING.lg },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: c.border },
  divider: { height: 0.5, backgroundColor: c.border },
  optionsScroll: { flexShrink: 1 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md + SPACING.xs,
    gap: SPACING.md,
  },
  optionBorder: { borderBottomWidth: 0.5, borderBottomColor: c.border },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.sm,
    backgroundColor: c.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapDestructive: { backgroundColor: '#F43F5E18' },
  optionLabel: { color: c.text, fontSize: 16, fontWeight: '500' },
  destructive: { color: c.error },
});
