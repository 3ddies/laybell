import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, Pressable,
  ScrollView, Image, Share, ActivityIndicator,
  Linking, Platform,
} from 'react-native';
import Reanimated, {
  Easing as REasing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from './ThemeContext';
import { supabase } from '../lib/supabase';
import { useProfile } from './ProfileContext';
import { useTranslation } from './LanguageContext';
import { createNotification } from '../lib/createNotification';
import { postShareUrl } from '../lib/appLinks';
import { isAudioPost } from '../lib/genres';
import { tg, countLabel } from '../lib/i18n';
import VideoThumb from '../components/VideoThumb';
import { AvatarRowSkeleton } from '../components/Skeleton';

// Global share sheet. Any component calls useShare().share(payload) and a bar
// slides up from the bottom with options to (a) send the content to people
// inside the app via DM, and (b) hand off to the native OS share sheet for
// everything outside the app (copy link, social apps, messages, …).

export type SharePayload = {
  postId: string;
  caption?: string | null;
  username?: string | null;   // author handle, for the share text + preview
  cover?: string | null;      // best available image (cover/thumbnail/avatar) for the preview
  type?: string | null;       // post type — videos generate a thumbnail frame when no cover
  mediaUrl?: string | null;   // the video URL, used to generate a frame when cover is missing
};

type Person = { id: string; username: string | null; display_name: string | null; avatar_url: string | null };

type ContextValue = { share: (payload: SharePayload) => void };

const ShareContext = createContext<ContextValue>({ share: () => {} });

export function useShare() {
  return useContext(ShareContext);
}

// Module-level opener for hosts that sit ABOVE ShareProvider in the tree and
// therefore can't useShare() — the 3-dot sheet lives in PostOptionsProvider,
// which WRAPS ShareProvider, so its useShare() would resolve to the no-op
// default. Same registration idiom as lib/postActions' reportHandler: the
// provider registers on mount, and the opener silently no-ops in the
// (impossible in practice) window where no provider is mounted.
let shareHandler: ((p: SharePayload) => void) | null = null;
export function openShareGlobal(p: SharePayload) { shareHandler?.(p); }

export function ShareProvider({ children }: { children: React.ReactNode }) {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [visible, setVisible] = useState(false);

  // Stable identity so screens consuming useShare() don't re-render when the
  // sheet opens/closes.
  const share = useCallback((p: SharePayload) => { setPayload(p); setVisible(true); }, []);
  const value = useMemo(() => ({ share }), [share]);
  const close = useCallback(() => setVisible(false), []);
  // Register the module-level opener (see openShareGlobal above).
  useEffect(() => {
    shareHandler = share;
    return () => { if (shareHandler === share) shareHandler = null; };
  }, [share]);

  return (
    <ShareContext.Provider value={value}>
      {children}
      <ShareSheet visible={visible} payload={payload} onClose={close} />
    </ShareContext.Provider>
  );
}

const DISMISS_DIST = 600;

// Called from the drag worklet (UI thread), so it is one itself.
function rubber(drag: number, max = 32): number {
  'worklet';
  return max * (1 - Math.exp(-drag / max));
}

// Shared links use the https universal-link form (not the laybell:// scheme) so
// that messaging apps auto-linkify them — custom schemes show as dead text in
// SMS/WhatsApp/etc. With the app's associated-domain config, tapping opens the
// app directly; otherwise it falls back to the web.
const WEB_BASE = 'https://laybell.app';

function buildShareText(p: SharePayload) {
  // External link = the smart open.html link (lib/appLinks): unfurls the
  // branded card and deep-links into the exact post on tap.
  const link = postShareUrl(p.postId);
  // In-app DMs keep the canonical laybell.app/post form — the chat renders
  // its OWN rich preview card by parsing this exact pattern.
  const dmLink = `${WEB_BASE}/post/${p.postId}`;
  const handle = p.username ? `@${p.username}` : '';
  // Songs read like a music share ("🎵 Title — @artist"), the way Spotify and
  // Apple Music captions their links, instead of the generic post phrasing.
  const isSong = isAudioPost(p.type) && !!p.caption;
  const text = isSong
    ? tg('share.textSong', { caption: p.caption!, handle })
    : p.caption
      ? tg('share.textCaption', { caption: p.caption, handle })
      : handle
        ? tg('share.textPlain', { handle })
        : tg('share.textPlainNoUser');
  const title = p.caption || (handle ? tg('share.titleUser', { handle }) : 'Laybell');
  // `message` = caption line + link. Only EMAIL uses it now: mail clients don't
  // render a link card, so a bare URL body would arrive as a naked link.
  // Everywhere else sends the LINK ALONE, so the recipient gets the unfurled
  // card by itself instead of a text bubble repeating the caption above a
  // second bubble with the card — the card already shows the caption as its
  // title, so the text was pure duplication.
  return { link, dmLink, title, message: `${text}\n${link}` };
}

const enc = encodeURIComponent;
type ShareCtx = { message: string; link: string; title: string };

// Scrollable row of external targets (TikTok-style). Each opens the app via its
// URL scheme, falling back to a web URL, then to the OS sheet. "More" goes
// straight to the native sheet (which also covers Copy Link, Instagram, etc.).
type ExternalApp = {
  key: string;
  label: string;
  labelKey?: string;   // when set, the label is localized via t(labelKey); brand names keep `label`
  icon: any;
  // Brand hex, or null → the render resolves it from the live theme (the
  // neutral "More" circle must match light/dark).
  color: string | null;
  urls?: (c: ShareCtx) => string[];
  native?: boolean;
};

const EXTERNAL_APPS: ExternalApp[] = [
  // Every card-rendering target below sends the LINK ONLY (see buildShareText):
  // the unfurled card already carries the caption as its title, so attaching the
  // text too produced two bubbles saying the same thing.
  {
    key: 'sms', label: 'Messages', labelKey: 'share.messages', icon: 'chatbubble-ellipses', color: '#34C759',
    urls: ({ link }) => [Platform.OS === 'ios' ? `sms:&body=${enc(link)}` : `sms:?body=${enc(link)}`],
  },
  {
    key: 'whatsapp', label: 'WhatsApp', icon: 'logo-whatsapp', color: '#25D366',
    urls: ({ link }) => [`whatsapp://send?text=${enc(link)}`, `https://wa.me/?text=${enc(link)}`],
  },
  {
    key: 'facebook', label: 'Facebook', icon: 'logo-facebook', color: '#1877F2',
    urls: ({ link }) => [`https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`],
  },
  {
    // The exception: mail clients don't unfurl a card, so this keeps the caption
    // line — otherwise the email body would be a naked URL.
    key: 'email', label: 'Email', labelKey: 'share.email', icon: 'mail', color: '#EA4335',
    urls: ({ message, title }) => [`mailto:?subject=${enc(title)}&body=${enc(message)}`],
  },
  {
    key: 'telegram', label: 'Telegram', icon: 'paper-plane', color: '#229ED9',
    urls: ({ link }) => [`tg://msg_url?url=${enc(link)}`, `https://t.me/share/url?url=${enc(link)}`],
  },
  {
    key: 'x', label: 'X', icon: 'logo-twitter', color: '#1DA1F2',
    urls: ({ link }) => [`twitter://post?message=${enc(link)}`, `https://twitter.com/intent/tweet?text=${enc(link)}`],
  },
  {
    key: 'reddit', label: 'Reddit', icon: 'logo-reddit', color: '#FF4500',
    urls: ({ link, title }) => [`https://www.reddit.com/submit?url=${enc(link)}&title=${enc(title)}`],
  },
  {
    key: 'more', label: 'More', labelKey: 'share.more', icon: 'ellipsis-horizontal', color: null, native: true,
  },
];

export const ShareSheet = memo(function ShareSheet({ visible, payload, onClose, inOverlay }: {
  visible: boolean;
  payload: SharePayload | null;
  onClose: () => void;
  // True when hosted inside the iOS FullWindowOverlay (the TV remote, via
  // CastBar) — renders as a plain view instead of a real Modal, exactly like
  // CommentsSheet (see its return-site note for why a Modal can't work there).
  inOverlay?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const { t } = useTranslation();
  // Live theme (was the static dark COLORS): in white mode the share sheet now
  // slides up as a light menu instead of a mismatched dark one.
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // Same construction as the 3-dot sheet (contexts/PostOptionsContext): the
  // sheet's position is a shared value so the drag runs on the UI thread, and
  // the backdrop is derived FROM that position rather than animated beside it.
  const ty = useSharedValue(DISMISS_DIST);
  // Measured, because the exit aims at it — a fixed distance can be shorter than
  // the sheet, and then a long drag is answered by an exit that moves the sheet
  // back UP before it unmounts (that was a real bug on the 3-dot sheet).
  const sheetH = useSharedValue(DISMISS_DIST);
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.max(0, ty.value) / DISMISS_DIST),
  }));
  const closeRef = useRef(onClose); closeRef.current = onClose;
  // One frame after the animation lands, so the host's re-render and this
  // sheet's teardown can't be seen happening (see PostOptionsContext).
  const finishClose = useCallback(() => { requestAnimationFrame(() => closeRef.current()); }, []);

  const [people, setPeople] = useState<Person[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (visible) {
      ty.value = DISMISS_DIST;
      setSelected(new Set());
      setSent(false);
      setSending(false);
      ty.value = withTiming(0, { duration: 260, easing: REasing.out(REasing.cubic) });
      loadPeople();
    }
  }, [visible]);

  async function loadPeople() {
    const uid = profile?.id ?? (await supabase.auth.getUser()).data.user?.id;
    if (!uid) return;
    setLoadingPeople(true);

    // Recent conversation partners (most-recent first), then people you follow.
    const [{ data: msgs }, { data: follows }] = await Promise.all([
      supabase.from('messages')
        .select('sender_id, receiver_id, created_at')
        .or(`sender_id.eq.${uid},receiver_id.eq.${uid}`)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.from('follows')
        .select('profiles:profiles!follows_following_id_fkey(id, username, display_name, avatar_url)')
        .eq('follower_id', uid),
    ]);

    const recentIds: string[] = [];
    const seen = new Set<string>();
    (msgs ?? []).forEach((m: any) => {
      const pid = m.sender_id === uid ? m.receiver_id : m.sender_id;
      if (pid && pid !== uid && !seen.has(pid)) { seen.add(pid); recentIds.push(pid); }
    });

    let recentProfiles: Person[] = [];
    if (recentIds.length) {
      const { data } = await supabase.from('profiles')
        .select('id, username, display_name, avatar_url').in('id', recentIds);
      const map = Object.fromEntries((data ?? []).map((p: any) => [p.id, p]));
      recentProfiles = recentIds.map((id) => map[id]).filter(Boolean);
    }

    const followProfiles: Person[] = (follows ?? [])
      .map((f: any) => f.profiles)
      .filter(Boolean);

    // Merge recent-first, then follows, de-duplicated.
    const merged: Person[] = [];
    const added = new Set<string>();
    [...recentProfiles, ...followProfiles].forEach((p) => {
      if (p && !added.has(p.id)) { added.add(p.id); merged.push(p); }
    });

    setPeople(merged);
    setLoadingPeople(false);
  }

  function dismiss() {
    ty.value = withTiming(Math.max(sheetH.value, DISMISS_DIST), { duration: 220, easing: REasing.in(REasing.cubic) }, (done) => {
      'worklet';
      if (done) runOnJS(finishClose)();
    });
  }

  // Drag to dismiss on the UI thread, the pattern the 3-dot sheet proved on
  // device: the finger goes straight into the shared value, the release is
  // judged by where the motion would come to REST (position + a slice of
  // velocity, as iOS does), and the exit leaves at the speed the finger was
  // already going instead of easing in from a standstill.
  const drag = useMemo(() => Gesture.Pan()
    // The same 3pt of slop the PanResponder waited for before claiming a drag.
    .activeOffsetY([-3, 3])
    .onUpdate((e) => {
      'worklet';
      // Upward drags rubber-band instead of lifting the sheet off the bottom.
      ty.value = e.translationY < 0 ? -rubber(-e.translationY) : e.translationY;
    })
    .onEnd((e) => {
      'worklet';
      if (e.translationY + e.velocityY * 0.12 > 60) {
        ty.value = withTiming(Math.max(sheetH.value, DISMISS_DIST), { duration: 220, easing: REasing.out(REasing.quad) }, (done) => {
          'worklet';
          if (done) runOnJS(finishClose)();
        });
      } else {
        ty.value = withSpring(0, { damping: 15, stiffness: 240, mass: 0.7 });
      }
    }), [finishClose, ty, sheetH]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function sendToSelected() {
    const uid = profile?.id ?? (await supabase.auth.getUser()).data.user?.id;
    if (!uid || !payload || selected.size === 0) return;
    setSending(true);
    // Send just the post link as the body — the chat renders it as a rich
    // preview card (thumbnail + author + caption), Instagram-style.
    const { dmLink } = buildShareText(payload);
    const ids = Array.from(selected);
    await Promise.all(ids.map(async (rid) => {
      const { error } = await supabase.from('messages').insert({ sender_id: uid, receiver_id: rid, body: dmLink });
      if (!error) createNotification({ userId: rid, actorId: uid, type: 'message' });
    }));
    bumpShare();
    setSending(false);
    setSent(true);
    setTimeout(() => dismiss(), 750);
  }

  // Bump the post's public share counter (no-op if not migrated). supabase
  // builders are lazy, so .then() is needed to actually fire the request.
  function bumpShare() {
    const id = payload?.postId;
    if (id) supabase.rpc('increment_share_count', { p_post_id: id }).then(() => {}, () => {});
  }

  function nativeShare(link: string) {
    dismiss();
    // Open the OS sheet after ours has closed, so the two modals don't fight.
    //
    // The LINK ALONE, no accompanying text. Handing iOS both `message` and
    // `url` makes Messages send two bubbles — the caption as plain text, then
    // the card — and the card already shows that caption as its title. `url` is
    // the iOS-only field (Android ignores it and reads `message`), so each
    // platform gets the one field it actually honours.
    setTimeout(() => {
      Share.share(Platform.OS === 'ios' ? { url: link } : { message: link }).catch(() => {});
    }, 280);
  }

  async function openApp(app: ExternalApp) {
    if (!payload) return;
    const { message, link, title } = buildShareText(payload);
    bumpShare();
    if (app.native || !app.urls) { nativeShare(link); return; }
    // Try the app scheme, then the web fallback, then the OS sheet.
    for (const url of app.urls({ message, link, title })) {
      try { await Linking.openURL(url); dismiss(); return; } catch {}
    }
    nativeShare(link);
  }

  const content = (
      <View style={styles.overlay}>
        <Reanimated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Reanimated.View>
        <Reanimated.View
          style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }, sheetStyle]}
          onLayout={(e) => { sheetH.value = e.nativeEvent.layout.height; }}
        >
          <GestureDetector gesture={drag}>
            <View style={styles.grab}>
              <View style={styles.handle} />
              <Text style={styles.title}>{t('share.title')}</Text>
            </View>
          </GestureDetector>

          {/* Content preview */}
          {payload && (
            <View style={styles.preview}>
              {payload.type === 'video' && payload.mediaUrl ? (
                <VideoThumb thumbnailUrl={payload.cover} mediaUrl={payload.mediaUrl} style={styles.previewThumb} />
              ) : payload.cover ? (
                <Image source={{ uri: payload.cover }} style={styles.previewThumb} />
              ) : (
                <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.previewThumb}>
                  <Ionicons name="musical-notes" size={18} color={colors.primary} />
                </LinearGradient>
              )}
              <View style={styles.previewInfo}>
                <Text style={styles.previewCaption} numberOfLines={1}>{payload.caption || t('share.previewPost')}</Text>
                {!!payload.username && <Text style={styles.previewUser} numberOfLines={1}>@{payload.username}</Text>}
              </View>
            </View>
          )}

          <View style={styles.divider} />

          {/* In-app: send to people */}
          <Text style={styles.sectionLabel}>{t('share.sendTo')}</Text>
          {loadingPeople ? (
            <AvatarRowSkeleton count={6} />
          ) : people.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleRow}>
              {people.map((p) => {
                const on = selected.has(p.id);
                return (
                  <TouchableOpacity key={p.id} style={styles.person} onPress={() => toggle(p.id)} activeOpacity={0.8}>
                    <View>
                      {p.avatar_url ? (
                        <Image source={{ uri: p.avatar_url }} style={[styles.personAvatar, on && styles.personAvatarSel]} />
                      ) : (
                        <LinearGradient colors={GRADIENTS.avatar} style={[styles.personAvatar, on && styles.personAvatarSel]}>
                          <Text style={styles.personInitial}>{(p.display_name || p.username || '?').charAt(0).toUpperCase()}</Text>
                        </LinearGradient>
                      )}
                      {on && (
                        <View style={styles.checkBadge}>
                          <Ionicons name="checkmark" size={13} color="#fff" />
                        </View>
                      )}
                    </View>
                    <Text style={styles.personName} numberOfLines={1}>{p.display_name || p.username}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : (
            <Text style={styles.emptyPeople}>{t('share.emptyPeople')}</Text>
          )}

          {/* Send button (only when at least one person is selected) */}
          {selected.size > 0 && (
            <TouchableOpacity
              style={[styles.sendBtn, (sending || sent) && styles.sendBtnBusy]}
              onPress={sendToSelected}
              disabled={sending || sent}
              activeOpacity={0.85}
            >
              {sending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : sent ? (
                <><Ionicons name="checkmark-circle" size={18} color="#fff" /><Text style={styles.sendBtnText}>{t('share.sent')}</Text></>
              ) : (
                <Text style={styles.sendBtnText}>{t('share.sendToN', { count: countLabel('person', selected.size) })}</Text>
              )}
            </TouchableOpacity>
          )}

          <View style={styles.divider} />

          {/* Outside the app — scrollable row of app circles (TikTok-style) */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleRow}>
            {EXTERNAL_APPS.map((app) => (
              <TouchableOpacity key={app.key} style={styles.person} onPress={() => openApp(app)} activeOpacity={0.8}>
                <View style={[styles.appCircle, { backgroundColor: app.color ?? colors.surfaceElevated }]}>
                  <Ionicons name={app.icon} size={26} color={app.key === 'more' ? colors.text : '#fff'} />
                </View>
                <Text style={styles.personName} numberOfLines={1}>{app.labelKey ? t(app.labelKey) : app.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Reanimated.View>
      </View>
  );

  // Hosted inside the iOS FullWindowOverlay (the TV remote): render as a plain
  // absolute-fill view stacked above the remote by z-order — a real Modal can
  // neither present from the overlay window (deadlock) nor from the main
  // window over the native-modal /tv route (never appears). Everywhere else
  // (and on Android) keeps the real Modal.
  //
  // Either host is a window of its OWN — the overlay, or a real Modal — outside
  // the app's root gesture handler, where a GestureDetector silently does
  // nothing. So each gets its own root (as app/_layout.tsx does for the player
  // chrome, and ReportContext for this same sheet shape).
  if (inOverlay && Platform.OS === 'ios') {
    return visible ? <GestureHandlerRootView style={[StyleSheet.absoluteFill, styles.overlayHost]}>{content}</GestureHandlerRootView> : null;
  }
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      <GestureHandlerRootView style={styles.overlay}>{content}</GestureHandlerRootView>
    </Modal>
  );
});

// Themed (light/grey/dark) — the share sheet must match the active display mode.
const makeStyles = (c: ThemePalette) => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  // Above the TV remote (70) and level with the comments sheet (80) — the two
  // are never open at once (both launch from the remote, which sits beneath).
  overlayHost: { zIndex: 80 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  grab: { alignItems: 'center', paddingTop: SPACING.sm, paddingBottom: SPACING.sm, gap: SPACING.sm },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: c.border },
  title: { color: c.text, fontSize: 16, fontWeight: '800' },

  preview: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  previewThumb: { width: 44, height: 44, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceLight },
  previewInfo: { flex: 1 },
  previewCaption: { color: c.text, fontSize: 14, fontWeight: '600' },
  previewUser: { color: c.textSecondary, fontSize: 12, marginTop: 1 },

  divider: { height: 0.5, backgroundColor: c.border },

  sectionLabel: {
    color: c.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: SPACING.sm,
  },
  peopleLoading: { paddingVertical: SPACING.lg, alignItems: 'center' },
  peopleRow: { paddingHorizontal: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.sm },
  person: { width: 64, alignItems: 'center', gap: 6 },
  personAvatar: {
    width: 56, height: 56, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'transparent',
  },
  personAvatarSel: { borderColor: c.primary },
  personInitial: { color: '#fff', fontSize: 20, fontWeight: '700' },
  checkBadge: {
    position: 'absolute', bottom: -2, right: -2,
    width: 20, height: 20, borderRadius: 10, backgroundColor: c.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: c.surface,
  },
  personName: { color: c.textSecondary, fontSize: 11, maxWidth: 60, textAlign: 'center' },
  emptyPeople: { color: c.textSecondary, fontSize: 13, paddingHorizontal: SPACING.md, paddingBottom: SPACING.md },

  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: c.primary,
    marginHorizontal: SPACING.md, marginVertical: SPACING.sm,
    paddingVertical: SPACING.md, borderRadius: RADIUS.md,
  },
  sendBtnBusy: { opacity: 0.85 },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  appCircle: {
    width: 56, height: 56, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
  },
});
