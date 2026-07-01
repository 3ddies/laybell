import {
  View, Text, StyleSheet, FlatList, TextInput, Image,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
  Keyboard, Animated, Alert,
} from 'react-native';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useLinkGuard } from '../../contexts/LinkGuardContext';
import { scanText } from '../../lib/linkSafety';
import { createNotification } from '../../lib/createNotification';
import { useProfile } from '../../contexts/ProfileContext';
import { sharedPostId, internalPathFromUrl, parseStoryReply, type StoryReplyRef } from '../../lib/postLinks';
import { maskHiddenProfile } from '../../lib/hiddenProfile';
import SharedPostCard from '../../components/SharedPostCard';
import BadgeEmblem from '../../components/BadgeEmblem';
import TranslatableText from '../../components/TranslatableText';
import { ChatThreadSkeleton } from '../../components/Skeleton';

type Message = { id: string; body: string; sender_id: string; receiver_id: string; created_at: string };

export default function ChatScreen() {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const { profile: myProfile } = useProfile();
  const linkGuard = useLinkGuard();
  const styles = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The floating input bar is a frosted-glass strip; in Light mode it must use a
  // light blur + light fills (it was hardcoded dark → a dark bar on a white app).
  const light = mode === 'light';
  const inputFill = light ? colors.surface : colors.surfaceElevated;
  const inputBorder = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.14)';
  // iMessage-style blue for the user's own (sent) bubbles.
  const bubbleBlue = ['#1FA0FF', '#0A7CFF'] as const;
  // Message times: visible for the first 4s after the convo opens, then fade out.
  // Tapping a message re-reveals just that one's time (fades 4s after the last tap).
  const globalOpacity = useRef(new Animated.Value(1)).current;
  const tapOpacity = useRef(new Animated.Value(0)).current;
  const [tappedId, setTappedId] = useState<string | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [otherUser, setOtherUser] = useState<any>(null);

  // The compose bar is absolutely positioned (so messages scroll under its
  // blur), which means the KeyboardAvoidingView's padding never moves it —
  // slide it with the keyboard ourselves, matching the keyboard's own
  // animation timing. iOS only: Android resizes the window, so the bar
  // already rides up for free.
  const kbShift = useRef(new Animated.Value(0)).current;
  const [kbUp, setKbUp] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e: any) => {
      setKbUp(true);
      Animated.timing(kbShift, {
        toValue: -(e.endCoordinates?.height ?? 0),
        duration: e.duration ?? 250,
        useNativeDriver: true,
      }).start();
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e: any) => {
      setKbUp(false);
      Animated.timing(kbShift, { toValue: 0, duration: e?.duration ?? 220, useNativeDriver: true }).start();
    });
    return () => { show.remove(); hide.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setup(); }, [id]);

  // Reveal all times on open, then fade them out after 4s.
  useEffect(() => {
    if (loading) return;
    globalOpacity.setValue(1);
    const timer = setTimeout(() => {
      Animated.timing(globalOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start();
    }, 4000);
    return () => clearTimeout(timer);
  }, [loading]);

  // Tap a message → show its time, fading out 4s after the most recent tap.
  const showTap = (msgId: string) => {
    setTappedId(msgId);
    tapOpacity.setValue(1);
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      Animated.timing(tapOpacity, { toValue: 0, duration: 500, useNativeDriver: true }).start();
    }, 4000);
  };
  useEffect(() => () => { if (tapTimer.current) clearTimeout(tapTimer.current); }, []);

  useEffect(() => {
    if (!currentUserId) return;
    // Per-mount suffix: a repeated channel name returns the EXISTING (already
    // subscribed) instance and .on() then throws — fatal if this conversation
    // is ever stacked twice.
    const channel = supabase
      .channel(`chat-${currentUserId}-${id}-${Date.now().toString(36)}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${currentUserId}` },
        (payload) => {
          const msg = payload.new as Message;
          if (String(msg.sender_id) === String(id)) {
            setMessages(prev => [...prev, msg]);
            setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
            // Already viewing this conversation — mark it read immediately
            supabase.from('messages').update({ read: true }).eq('id', msg.id);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentUserId, id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) { setCurrentUserId(user.id); await fetchMessages(user.id); markAsRead(user.id); }
    const { data: profile } = await supabase.from('profiles').select('username, display_name, avatar_url, badge_tier, badge_show, profile_theme, hidden').eq('id', id).single();
    // A partner who has since hidden their account reads as "Hidden account".
    if (profile) setOtherUser(maskHiddenProfile(profile as any));
    setLoading(false);
  }

  // Mark this sender's messages to me as read
  async function markAsRead(userId: string) {
    await supabase.from('messages')
      .update({ read: true })
      .eq('receiver_id', userId).eq('sender_id', id).eq('read', false);
  }

  async function fetchMessages(userId: string) {
    const { data } = await supabase
      .from('messages').select('*')
      .or(`and(sender_id.eq.${userId},receiver_id.eq.${id}),and(sender_id.eq.${id},receiver_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    if (data) setMessages(data);
  }

  async function sendMessage() {
    if (!newMessage.trim() || !currentUserId || sending) return;
    // Hidden accounts browse/listen only — no DMs while invisible.
    if ((myProfile as any)?.hidden) {
      Alert.alert(t('messages.hiddenTitle'), t('messages.hiddenBody'));
      return;
    }
    // Link safety: refuse to SEND a message containing a dangerous link (bad
    // scheme, embedded credentials, blocklisted host) — stops malicious links
    // from propagating, in addition to the open-time guard on the recipient side.
    const linkScan = scanText(newMessage.trim());
    if (linkScan.verdict === 'block') {
      Alert.alert(t('messages.unsafeLinkTitle'), t('messages.unsafeLinkBody'));
      return;
    }
    setSending(true);
    const body = newMessage.trim();
    setNewMessage('');
    const { data, error } = await supabase.from('messages')
      .insert({ sender_id: currentUserId, receiver_id: id, body })
      .select().single();
    if (!error && data) {
      setMessages(prev => [...prev, data]);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      // Notify recipient — only on first message of session to avoid spam
      if (messages.filter(m => m.sender_id === currentUserId).length === 0) {
        createNotification({ userId: String(id), actorId: currentUserId, type: 'message' });
      }
    }
    setSending(false);
  }

  function formatTime(dateString: string) {
    return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Open the story a reply points at — stories live 24h, so check first and
  // explain when it's gone (the stillshot in the chat remains either way).
  async function openStoryReply(ref: StoryReplyRef) {
    try {
      const { data } = await supabase
        .from('stories').select('id, expires_at').eq('id', ref.storyId).maybeSingle();
      if (!data || new Date(data.expires_at).getTime() <= Date.now()) {
        Alert.alert(t('messages.storyUnavailableTitle'), t('messages.storyUnavailableBody'));
        return;
      }
      router.push(`/story/${ref.ownerId}`);
    } catch {
      Alert.alert(t('messages.storyUnavailableTitle'), t('messages.storyUnavailableBody'));
    }
  }

  // Open a link found in a message. Laybell links route inside the app; anything
  // else opens externally.
  function openLink(url: string) {
    const path = internalPathFromUrl(url);
    if (path) router.push(path as any);
    // External links route through the safety guard (destination shown, risky
    // links flagged, dangerous ones blocked) instead of opening directly.
    else linkGuard.open(url, { context: 'message' });
  }

  // Render a message body with any URLs as tappable links. Laybell post links
  // show as a friendly "View post" instead of the raw URL.
  function renderBody(body: string, isOwn: boolean) {
    const parts = body.split(/(laybell:\/\/\S+|https?:\/\/\S+)/g);
    return (
      <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>
        {parts.map((part, i) => {
          if (!part) return null;
          if (part.startsWith('laybell://') || /^https?:\/\//.test(part)) {
            const path = internalPathFromUrl(part);
            const label = path?.startsWith('/post/') ? t('messages.viewPost') : part;
            return (
              <Text
                key={i}
                style={[styles.link, isOwn ? styles.linkOwn : styles.linkOther]}
                onPress={() => openLink(part)}
              >
                {label}
              </Text>
            );
          }
          return part;
        })}
      </Text>
    );
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top }]}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={26} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <ChatThreadSkeleton rows={9} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerUser} activeOpacity={0.7} onPress={() => router.push(`/profile/${id}`)}>
          {otherUser?.avatar_url ? (
            <Image source={{ uri: otherUser.avatar_url }} style={styles.headerAvatar} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.headerAvatar}>
              <Text style={styles.headerAvatarText}>{(otherUser?.display_name || otherUser?.username || '?').charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
          <View style={styles.headerInfo}>
            <View style={styles.headerNameRow}>
              <Text style={styles.headerName} numberOfLines={1}>{otherUser?.display_name}</Text>
              <BadgeEmblem profile={otherUser} size={14} />
            </View>
            {!!otherUser?.username && <Text style={styles.headerUsername} numberOfLines={1}>@{otherUser.username}</Text>}
          </View>
        </TouchableOpacity>
      </View>

      {/* Only the message list avoids the keyboard. The compose bar lives OUTSIDE
          this KAV and slides itself (kbShift) — so the KAV's padding can't also
          shove the absolute bar, which is what made the pill vanish while typing. */}
      <KeyboardAvoidingView style={styles.chatBody} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        // renderItem reads `tappedId` (which time to reveal). It's outside `data`,
        // so FlatList needs extraData to re-render cells when a tap changes it —
        // otherwise the tap only takes effect on the next unrelated re-render.
        extraData={tappedId}
        contentContainerStyle={[styles.messagesList, { paddingBottom: insets.bottom + 76 }]}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>{t('messages.startConversation', { name: otherUser?.display_name ?? '' })}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isOwn = item.sender_id === currentUserId;
          // This message's time follows the tap fade if it was the last tapped,
          // otherwise the shared open-convo fade.
          const timeOpacity = tappedId === item.id ? tapOpacity : globalOpacity;
          // A story reply renders as its stillshot + the text underneath.
          const storyRef = parseStoryReply(item.body);
          if (storyRef) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <Text style={styles.storyReplyLabel}>
                  {isOwn ? t('messages.youRepliedStory') : t('messages.repliedYourStory')}
                </Text>
                <TouchableOpacity activeOpacity={0.85} onPress={() => openStoryReply(storyRef)}>
                  {storyRef.thumb ? (
                    <Image source={{ uri: storyRef.thumb }} style={styles.storyReplyThumb} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primarySoft} style={[styles.storyReplyThumb, styles.storyReplyThumbEmpty]}>
                      <Ionicons name="play-circle" size={30} color="#fff" />
                    </LinearGradient>
                  )}
                </TouchableOpacity>
                {storyRef.text ? (
                  isOwn ? (
                    <LinearGradient
                      colors={bubbleBlue}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={[styles.bubble, styles.bubbleOwn, styles.storyReplyBubble]}
                    >
                      <TranslatableText text={storyRef.text} render={(s) => renderBody(s, isOwn)} linkStyle={{ color: isOwn ? 'rgba(255,255,255,0.85)' : colors.textSecondary }} />
                    </LinearGradient>
                  ) : (
                    <View style={[styles.bubble, styles.bubbleOther, styles.storyReplyBubble]}>
                      <TranslatableText text={storyRef.text} render={(s) => renderBody(s, isOwn)} linkStyle={{ color: isOwn ? 'rgba(255,255,255,0.85)' : colors.textSecondary }} />
                    </View>
                  )
                ) : null}
                <Animated.Text style={[styles.cardTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>
              </View>
            );
          }
          const postId = sharedPostId(item.body);
          // A shared post renders as a standalone preview card (no chat bubble).
          if (postId) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <SharedPostCard postId={postId} />
                <Animated.Text style={[styles.cardTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>
              </View>
            );
          }
          return (
            <View style={[styles.bubbleRow, isOwn ? styles.bubbleRowOwn : styles.bubbleRowOther]}>
              {isOwn && <Animated.Text style={[styles.msgTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>}
              <TouchableOpacity activeOpacity={1} onPress={() => showTap(item.id)} style={styles.bubbleTouch}>
                {isOwn ? (
                  <LinearGradient
                    colors={bubbleBlue}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.bubble, styles.bubbleFill, styles.bubbleOwn]}
                  >
                    <TranslatableText text={item.body} render={(s) => renderBody(s, isOwn)} linkStyle={{ color: isOwn ? 'rgba(255,255,255,0.85)' : colors.textSecondary }} />
                  </LinearGradient>
                ) : (
                  <View style={[styles.bubble, styles.bubbleFill, styles.bubbleOther]}>
                    <TranslatableText text={item.body} render={(s) => renderBody(s, isOwn)} linkStyle={{ color: isOwn ? 'rgba(255,255,255,0.85)' : colors.textSecondary }} />
                  </View>
                )}
              </TouchableOpacity>
              {!isOwn && <Animated.Text style={[styles.msgTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>}
            </View>
          );
        }}
      />
      </KeyboardAvoidingView>

      <Animated.View style={[styles.inputBarWrap, { transform: [{ translateY: kbShift }] }]}>
      <View
        // No solid bar — just the floating input pill + send circle over the
        // messages, for a cleaner look.
        style={[styles.inputBar, { paddingBottom: kbUp ? SPACING.sm + 2 : Math.max(insets.bottom, SPACING.sm) + SPACING.sm }]}
      >
        <TextInput
          style={[styles.input, { backgroundColor: inputFill, borderColor: inputBorder }]}
          placeholder={t('messages.inputPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={newMessage}
          onChangeText={setNewMessage}
          multiline
          maxLength={500}
        />
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={sendMessage}
          disabled={!newMessage.trim() || sending}
          style={!newMessage.trim() && styles.sendBtnDisabled}
        >
          <View style={[styles.sendBtn, { backgroundColor: colors.text }]}>
            {sending
              ? <ActivityIndicator color={colors.background} size="small" />
              : <Ionicons name="arrow-up" size={20} color={colors.background} />
            }
          </View>
        </TouchableOpacity>
      </View>
      </Animated.View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  chatBody: { flex: 1 },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },

  // The chat presents as an iOS page sheet (it sits above the messages list's
  // transparent modal), so content starts at the SHEET's top — only a little
  // breathing room is needed, not status-bar clearance.
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border, gap: SPACING.xs,
  },
  backBtn: { padding: SPACING.xs },
  headerUser: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  headerAvatar: {
    width: 40, height: 40, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  headerAvatarText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  headerInfo: { flex: 1 },
  headerNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  headerName: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  headerUsername: { color: colors.textSecondary, fontSize: 13 },

  messagesList: { padding: SPACING.md, gap: 2, flexGrow: 1 },

  bubbleWrap: { marginBottom: SPACING.xs },
  bubbleWrapOwn: { alignItems: 'flex-end' },
  bubbleWrapOther: { alignItems: 'flex-start' },
  // Text-message row: the bubble + a small time on its INNER side, bottom-aligned
  // (time to the left of sent bubbles, to the right of received ones).
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: SPACING.xs, gap: 6 },
  bubbleRowOwn: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  msgTime: { fontSize: 10, color: colors.textTertiary, marginBottom: 3 },
  // The tap wrapper carries the width cap; the bubble fills it (a %-maxWidth on
  // the bubble wouldn't resolve inside an auto-width wrapper).
  bubbleTouch: { maxWidth: '80%' },
  bubbleFill: { maxWidth: '100%' },
  bubble: { maxWidth: '80%', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 26 },
  bubbleOwn: {
    borderBottomRightRadius: 9,
    shadowColor: '#0A7CFF', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  bubbleOther: {
    backgroundColor: colors.surfaceElevated, borderBottomLeftRadius: 9,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  // Regular (not medium) weight + SF's natural tight tracking = clean iOS look.
  bubbleText: { color: colors.text, fontSize: 17, lineHeight: 22, letterSpacing: -0.4, fontWeight: '400' },
  // Sent bubbles are the orange gradient → keep their text white in every theme
  // (the themed color went dark-on-orange in Light mode).
  bubbleTextOwn: { color: '#fff' },
  link: { textDecorationLine: 'underline', fontWeight: '700' },
  linkOwn: { color: '#fff' },
  linkOther: { color: colors.primaryLight },
  // Inline trailing timestamp — small + faded, baseline-flows after the message.
  inlineTime: { fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: '500' },
  inlineTimeOther: { color: colors.textTertiary },
  cardTime: { fontSize: 10, color: colors.textTertiary, marginTop: 3 },

  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.xxl },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },

  // Story replies: the story's stillshot above the text bubble.
  storyReplyLabel: { color: colors.textTertiary, fontSize: 12, fontWeight: '600', marginBottom: 5 },
  storyReplyThumb: {
    width: 112, height: 178, borderRadius: 14,
    backgroundColor: colors.surfaceLight,
  },
  storyReplyThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  storyReplyBubble: { marginTop: 6 },

  // Floating frosted-glass bar (iOS-style): messages scroll under the blur.
  // The Animated wrapper owns the absolute position + keyboard slide.
  inputBarWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm + 2, gap: SPACING.sm,
  },
  // Solid rounded pill so it reads cleanly floating over the messages (no bar).
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22, minHeight: 44, paddingHorizontal: SPACING.md + 2,
    paddingVertical: 11, color: colors.text, fontSize: 17, lineHeight: 22, maxHeight: 120,
  },
  // Flat solid circle — no glow/elevation (the halo read as Android Material).
  sendBtn: {
    width: 44, height: 44, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.35 },
});
