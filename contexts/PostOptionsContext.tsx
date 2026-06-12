import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity,
  Pressable, Animated, PanResponder, Easing, Platform,
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
import { useProfile } from './ProfileContext';
import { isReposted, addRepost, removeRepost } from '../lib/reposts';
import AddToPlaylistModal from '../components/AddToPlaylistModal';

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
  // actions: Add to playlist, Like/Unlike, Save/Unsave, Artist.
  mediaType?: string | null;
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
};

type ContextValue = { show: (opts: PostOptionsArgs) => void };

const PostOptionsContext = createContext<ContextValue>({ show: () => {} });

export function usePostOptions() {
  return useContext(PostOptionsContext);
}

export function PostOptionsProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<PostOptionsArgs | null>(null);
  const [visible, setVisible] = useState(false);
  // "Add to playlist" opens a modal owned here (so it works from any 3-dot menu).
  const [playlistPostId, setPlaylistPostId] = useState<string | null>(null);

  const show = (o: PostOptionsArgs) => { setOpts(o); setVisible(true); };

  const sheets = (
    <>
      <PostOptionsSheet
        visible={visible}
        opts={opts}
        onClose={() => setVisible(false)}
        onAddToPlaylist={setPlaylistPostId}
      />
      <AddToPlaylistModal
        visible={!!playlistPostId}
        postId={playlistPostId ?? ''}
        onClose={() => setPlaylistPostId(null)}
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
  onPress: () => void;
};

export function PostOptionsSheet({ visible, opts, onClose, onAddToPlaylist }: {
  visible: boolean;
  opts: PostOptionsArgs | null;
  onClose: () => void;
  onAddToPlaylist: (postId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useProfile();
  const translateY = useRef(new Animated.Value(DISMISS_DIST)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const optsRef = useRef(opts); optsRef.current = opts;
  const [reposted, setReposted] = useState(false);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState(false);

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

  const isOwn = opts?.isOwn ?? false;
  const hasPost = !!opts?.postId;
  const isAudio = isAudioPost(opts?.mediaType);
  const targetSuffix = opts?.authorName ? ` @${opts.authorName}` : ' user';

  const blockOpt: Opt = blocked
    ? { key: 'unblock', label: `Unblock${targetSuffix}`, icon: 'person-add-outline',
        onPress: () => { const o = optsRef.current; dismissThen(async () => { if (o?.authorId) { await unblockUser(o.authorId); o.onBlocked?.(); } }); } }
    : { key: 'block', label: `Block${targetSuffix}`, icon: 'ban-outline', destructive: true,
        onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.authorId) confirmBlockUser(o.authorId, o.authorName, o.onBlocked); }); } };

  const options: Opt[] = [];

  // ── Music actions (audio posts) ───────────────────────────────────────────
  if (hasPost && isAudio) {
    if (opts?.onRemoveFromPlaylist) {
      // Opened from inside one of the user's playlists — the playlist slot
      // removes the song from THAT playlist instead of adding to one.
      options.push({ key: 'playlist', label: 'Remove from playlist', icon: 'remove-circle-outline',
        onPress: () => { const o = optsRef.current; dismissThen(() => o?.onRemoveFromPlaylist?.()); } });
    } else {
      options.push({ key: 'playlist', label: 'Add to playlist', icon: 'add-circle-outline',
        onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) onAddToPlaylist(o.postId); }); } });
    }
    options.push({ key: 'like', label: liked ? 'Unlike' : 'Like', icon: liked ? 'heart' : 'heart-outline',
      active: liked, activeColor: COLORS.like, onPress: toggleLike });
    options.push({ key: 'save', label: saved ? 'Unsave' : 'Save', icon: saved ? 'bookmark' : 'bookmark-outline',
      active: saved, activeColor: COLORS.primary, onPress: toggleSave });
    if (opts?.authorId && !isOwn) {
      options.push({ key: 'artist', label: 'Artist', icon: 'person-outline',
        onPress: () => { const o = optsRef.current; dismissThen(() => { o?.onNavigate?.(); if (o?.authorId) router.push(`/profile/${o.authorId}`); }); } });
    }
  }

  // ── Ownership / general actions ────────────────────────────────────────────
  if (hasPost && isOwn) {
    options.push({ key: 'edit', label: 'Edit post', icon: 'pencil-outline',
      onPress: () => dismissThen(() => optsRef.current?.onEdit?.()) });
    options.push({ key: 'archive', label: 'Archive post', icon: 'archive-outline',
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmArchivePost(o.postId, o.onArchived); }); } });
    options.push({ key: 'delete', label: 'Delete post', icon: 'trash-outline', destructive: true,
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) confirmDeletePost(o.postId, o.onDeleted); }); } });
  } else if (hasPost && !isOwn) {
    options.push({ key: 'repost', label: reposted ? 'Remove from reposts' : 'Repost',
      icon: reposted ? 'repeat' : 'repeat-outline', onPress: toggleRepost });
    options.push({ key: 'report', label: 'Report post', icon: 'flag-outline', destructive: true,
      onPress: () => { const o = optsRef.current; dismissThen(() => { if (o?.postId) reportPost(o.postId); }); } });
    if (opts?.authorId) options.push(blockOpt);
  } else if (!hasPost && opts?.authorId && !isOwn) {
    // Profile-only menu (no specific post): report + block the user.
    options.push({ key: 'report-user', label: 'Report user', icon: 'flag-outline', destructive: true,
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

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
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
            >
              <View style={[
                styles.iconWrap,
                opt.destructive && styles.iconWrapDestructive,
                opt.active && { backgroundColor: (opt.activeColor ?? COLORS.primary) + '1A' },
              ]}>
                <Ionicons
                  name={opt.icon}
                  size={20}
                  color={opt.active ? (opt.activeColor ?? COLORS.primary) : opt.destructive ? COLORS.error : COLORS.text}
                />
              </View>
              <Text style={[styles.optionLabel, opt.destructive && styles.destructive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      </View>
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
