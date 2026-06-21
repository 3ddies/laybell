import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, Pressable,
  Animated, PanResponder, Easing, ScrollView, Image, Share, ActivityIndicator,
  Linking, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { useProfile } from './ProfileContext';
import { useTranslation } from './LanguageContext';
import { createNotification } from '../lib/createNotification';
import { tg, countLabel } from '../lib/i18n';
import VideoThumb from '../components/VideoThumb';

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

export function ShareProvider({ children }: { children: React.ReactNode }) {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [visible, setVisible] = useState(false);

  // Stable identity so screens consuming useShare() don't re-render when the
  // sheet opens/closes.
  const share = useCallback((p: SharePayload) => { setPayload(p); setVisible(true); }, []);
  const value = useMemo(() => ({ share }), [share]);
  const close = useCallback(() => setVisible(false), []);

  return (
    <ShareContext.Provider value={value}>
      {children}
      <ShareSheet visible={visible} payload={payload} onClose={close} />
    </ShareContext.Provider>
  );
}

const DISMISS_DIST = 600;

function rubber(drag: number, max = 32): number {
  return max * (1 - Math.exp(-drag / max));
}

// Shared links use the https universal-link form (not the laybell:// scheme) so
// that messaging apps auto-linkify them — custom schemes show as dead text in
// SMS/WhatsApp/etc. With the app's associated-domain config, tapping opens the
// app directly; otherwise it falls back to the web.
const WEB_BASE = 'https://laybell.app';

function buildShareText(p: SharePayload) {
  const link = `${WEB_BASE}/post/${p.postId}`;
  const handle = p.username ? `@${p.username}` : '';
  const text = p.caption
    ? tg('share.textCaption', { caption: p.caption, handle })
    : handle
      ? tg('share.textPlain', { handle })
      : tg('share.textPlainNoUser');
  const title = p.caption || (handle ? tg('share.titleUser', { handle }) : 'Laybell');
  return { link, title, message: `${text}\n${link}` };
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
  color: string;
  urls?: (c: ShareCtx) => string[];
  native?: boolean;
};

const EXTERNAL_APPS: ExternalApp[] = [
  {
    key: 'sms', label: 'Messages', labelKey: 'share.messages', icon: 'chatbubble-ellipses', color: '#34C759',
    urls: ({ message }) => [Platform.OS === 'ios' ? `sms:&body=${enc(message)}` : `sms:?body=${enc(message)}`],
  },
  {
    key: 'whatsapp', label: 'WhatsApp', icon: 'logo-whatsapp', color: '#25D366',
    urls: ({ message }) => [`whatsapp://send?text=${enc(message)}`, `https://wa.me/?text=${enc(message)}`],
  },
  {
    key: 'facebook', label: 'Facebook', icon: 'logo-facebook', color: '#1877F2',
    urls: ({ link }) => [`https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`],
  },
  {
    key: 'email', label: 'Email', labelKey: 'share.email', icon: 'mail', color: '#EA4335',
    urls: ({ message, title }) => [`mailto:?subject=${enc(title)}&body=${enc(message)}`],
  },
  {
    key: 'telegram', label: 'Telegram', icon: 'paper-plane', color: '#229ED9',
    urls: ({ message, link }) => [`tg://msg_url?url=${enc(link)}&text=${enc(message)}`, `https://t.me/share/url?url=${enc(link)}&text=${enc(message)}`],
  },
  {
    key: 'x', label: 'X', icon: 'logo-twitter', color: '#1DA1F2',
    urls: ({ message }) => [`twitter://post?message=${enc(message)}`, `https://twitter.com/intent/tweet?text=${enc(message)}`],
  },
  {
    key: 'reddit', label: 'Reddit', icon: 'logo-reddit', color: '#FF4500',
    urls: ({ link, title }) => [`https://www.reddit.com/submit?url=${enc(link)}&title=${enc(title)}`],
  },
  {
    key: 'more', label: 'More', labelKey: 'share.more', icon: 'ellipsis-horizontal', color: COLORS.surfaceElevated, native: true,
  },
];

export function ShareSheet({ visible, payload, onClose }: {
  visible: boolean;
  payload: SharePayload | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();
  const { t } = useTranslation();
  const translateY = useRef(new Animated.Value(DISMISS_DIST)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const closeRef = useRef(onClose); closeRef.current = onClose;

  const [people, setPeople] = useState<Person[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (visible) {
      translateY.setValue(DISMISS_DIST);
      backdrop.setValue(0);
      setSelected(new Set());
      setSent(false);
      setSending(false);
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
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
    Animated.parallel([
      Animated.timing(translateY, { toValue: DISMISS_DIST, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => closeRef.current());
  }

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 3,
    onPanResponderMove: (_e, g) => {
      if (g.dy < 0) {
        translateY.setValue(-rubber(Math.abs(g.dy)));
        backdrop.setValue(1);
      } else {
        translateY.setValue(g.dy);
        backdrop.setValue(Math.max(0, 1 - g.dy / DISMISS_DIST));
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
    const { link } = buildShareText(payload);
    const ids = Array.from(selected);
    await Promise.all(ids.map(async (rid) => {
      const { error } = await supabase.from('messages').insert({ sender_id: uid, receiver_id: rid, body: link });
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

  function nativeShare(message: string, link: string) {
    dismiss();
    // Open the OS sheet after ours has closed, so the two modals don't fight.
    setTimeout(() => { Share.share({ message, url: link }).catch(() => {}); }, 280);
  }

  async function openApp(app: ExternalApp) {
    if (!payload) return;
    const { message, link, title } = buildShareText(payload);
    bumpShare();
    if (app.native || !app.urls) { nativeShare(message, link); return; }
    // Try the app scheme, then the web fallback, then the OS sheet.
    for (const url of app.urls({ message, link, title })) {
      try { await Linking.openURL(url); dismiss(); return; } catch {}
    }
    nativeShare(message, link);
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>
        <Animated.View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md, transform: [{ translateY }] }]}>
          <View style={styles.grab} {...pan.panHandlers}>
            <View style={styles.handle} />
            <Text style={styles.title}>{t('share.title')}</Text>
          </View>

          {/* Content preview */}
          {payload && (
            <View style={styles.preview}>
              {payload.type === 'video' && payload.mediaUrl ? (
                <VideoThumb thumbnailUrl={payload.cover} mediaUrl={payload.mediaUrl} style={styles.previewThumb} />
              ) : payload.cover ? (
                <Image source={{ uri: payload.cover }} style={styles.previewThumb} />
              ) : (
                <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.previewThumb}>
                  <Ionicons name="musical-notes" size={18} color={COLORS.primary} />
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
            <View style={styles.peopleLoading}><ActivityIndicator color={COLORS.primary} /></View>
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
                        <LinearGradient colors={GRADIENTS.primary} style={[styles.personAvatar, on && styles.personAvatarSel]}>
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
                <View style={[styles.appCircle, { backgroundColor: app.color }]}>
                  <Ionicons name={app.icon} size={26} color={app.key === 'more' ? COLORS.text : '#fff'} />
                </View>
                <Text style={styles.personName} numberOfLines={1}>{app.labelKey ? t(app.labelKey) : app.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
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
  grab: { alignItems: 'center', paddingTop: SPACING.sm, paddingBottom: SPACING.sm, gap: SPACING.sm },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: COLORS.border },
  title: { color: COLORS.text, fontSize: 16, fontWeight: '800' },

  preview: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  previewThumb: { width: 44, height: 44, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight },
  previewInfo: { flex: 1 },
  previewCaption: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  previewUser: { color: COLORS.textSecondary, fontSize: 12, marginTop: 1 },

  divider: { height: 0.5, backgroundColor: COLORS.border },

  sectionLabel: {
    color: COLORS.textTertiary, fontSize: 11, fontWeight: '700',
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
  personAvatarSel: { borderColor: COLORS.primary },
  personInitial: { color: '#fff', fontSize: 20, fontWeight: '700' },
  checkBadge: {
    position: 'absolute', bottom: -2, right: -2,
    width: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: COLORS.surface,
  },
  personName: { color: COLORS.textSecondary, fontSize: 11, maxWidth: 60, textAlign: 'center' },
  emptyPeople: { color: COLORS.textSecondary, fontSize: 13, paddingHorizontal: SPACING.md, paddingBottom: SPACING.md },

  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: COLORS.primary,
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
