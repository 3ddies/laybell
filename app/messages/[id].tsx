import {
  View, Text, StyleSheet, FlatList, TextInput, Image,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
  Keyboard, Animated, Alert, Modal, Pressable, Dimensions,
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
import { reportUser } from '../../lib/postActions';
import { parseAttachment, attachmentBody, pickImageAttachment, type Attachment } from '../../lib/attachments';
import { openGifAttachment } from '../../lib/gifAttachmentActions';
import GifPickerModal from '../../components/GifPickerModal';
import AttachmentView from '../../components/AttachmentView';
import ImageViewerModal from '../../components/ImageViewerModal';
import { useProfile } from '../../contexts/ProfileContext';
import { sharedPostId, internalPathFromUrl, parseStoryReply, type StoryReplyRef } from '../../lib/postLinks';
import { maskHiddenProfile } from '../../lib/hiddenProfile';
import SharedPostCard from '../../components/SharedPostCard';
import BadgeEmblem from '../../components/BadgeEmblem';
import TranslatableText from '../../components/TranslatableText';
import { ChatThreadSkeleton } from '../../components/Skeleton';
import { tabTick, reactionPop, impactLight } from '../../lib/haptics';

type Message = { id: string; body: string; sender_id: string; receiver_id: string; created_at: string };
type Reaction = { message_id: string; user_id: string; emoji: string };

// Classic iMessage "tapback" set — press-and-hold a bubble to pick one.
const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];

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
  // Tapping a message re-reveals just that one's time (fades 4s after the tap).
  // Each message owns its OWN opacity value + fade timer, and a tap animates it
  // DIRECTLY (no React state / re-render), so a tap always takes effect instantly.
  const opacityMap = useRef<Record<string, Animated.Value>>({}).current;
  const fadeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({}).current;
  const getTimeOpacity = (msgId: string) => (opacityMap[msgId] ||= new Animated.Value(0));
  const scheduleFade = (msgId: string) => {
    if (fadeTimers[msgId]) clearTimeout(fadeTimers[msgId]);
    fadeTimers[msgId] = setTimeout(() => {
      Animated.timing(getTimeOpacity(msgId), { toValue: 0, duration: 500, useNativeDriver: true }).start();
    }, 4000);
  };
  const flatListRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Reactions keyed by message id. Loaded with the thread, kept live via realtime,
  // and updated optimistically the instant the user taps an emoji.
  const [reactions, setReactions] = useState<Record<string, Reaction[]>>({});
  // The message whose reaction picker is open (null = picker closed).
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // The message whose reactor list is open (tap a reaction to see who reacted).
  const [reactorsFor, setReactorsFor] = useState<string | null>(null);
  // Header 3-dot chat-options menu (report, and room for more later).
  const [menuOpen, setMenuOpen] = useState(false);
  // Staged image/GIF attachment (sent with the next message) + GIF picker.
  const [pendingAttachment, setPendingAttachment] = useState<Attachment | null>(null);
  const [gifOpen, setGifOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
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
    // RAISE on willShow OR willChangeFrame (whichever fires — iOS skips willShow
    // during rapid focus), but only for an ON-SCREEN keyboard frame. LOWER only on
    // an explicit willHide. This is the fix for "slides up then glitches back down":
    // iOS emits a stray docked/off-screen frame right after the show, and the old
    // code treated its zero overlap as a hide and yanked the bar back under the
    // keyboard. Now nothing but a real willHide can lower it.
    const raise = (e: any) => {
      const kb = e.endCoordinates;
      if (!kb || kb.height <= 0) return;
      if (kb.screenY >= Dimensions.get('screen').height - 10) return; // off-screen → let willHide handle
      setKbUp(true);
      Animated.timing(kbShift, { toValue: -kb.height, duration: e.duration ?? 250, useNativeDriver: true }).start();
    };
    const lower = (e: any) => {
      setKbUp(false);
      Animated.timing(kbShift, { toValue: 0, duration: e?.duration ?? 220, useNativeDriver: true }).start();
    };
    // The DID events fire LAST (after the keyboard settles), so they authoritatively
    // correct the resting position — this is what keeps re-triggers (2nd+ open) from
    // ending up glitched under the keyboard when events interleave across cycles.
    const subs = [
      Keyboard.addListener('keyboardWillShow', raise),
      Keyboard.addListener('keyboardWillChangeFrame', raise),
      Keyboard.addListener('keyboardDidShow', raise),
      Keyboard.addListener('keyboardWillHide', lower),
      Keyboard.addListener('keyboardDidHide', lower),
    ];
    return () => subs.forEach((s) => s.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setup(); }, [id]);

  // Reveal every loaded message's time on open, then fade them out after 4s.
  useEffect(() => {
    if (loading) return;
    messages.forEach((m) => getTimeOpacity(m.id).setValue(1));
    const timer = setTimeout(() => {
      messages.forEach((m) =>
        Animated.timing(getTimeOpacity(m.id), { toValue: 0, duration: 500, useNativeDriver: true }).start());
    }, 4000);
    return () => clearTimeout(timer);
    // Runs once, right after the initial load resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Tap a message → show its time now, fading out 4s later.
  const showTap = (msgId: string) => {
    const o = getTimeOpacity(msgId);
    o.stopAnimation();
    o.setValue(1);
    scheduleFade(msgId);
  };
  // Clear any pending fade timers on unmount.
  useEffect(() => () => { Object.values(fadeTimers).forEach((t) => clearTimeout(t)); }, []);

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
      // RLS scopes reaction events to threads this user is part of, but that still
      // spans every conversation — reconcile only when the change touches a message
      // currently on screen. Read live message ids via the setState updater so this
      // effect needn't re-subscribe as messages arrive.
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions' },
        () => { setMessages(curr => { fetchReactions(curr.map(m => m.id)); return curr; }); }
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
    if (data) { setMessages(data); fetchReactions(data.map(m => m.id)); }
  }

  // Pull every reaction for the given messages and group them by message id.
  async function fetchReactions(ids: string[]) {
    if (!ids.length) { setReactions({}); return; }
    const { data } = await supabase
      .from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids);
    if (!data) return;
    const map: Record<string, Reaction[]> = {};
    for (const r of data as Reaction[]) (map[r.message_id] ||= []).push(r);
    setReactions(map);
  }

  // Press-and-hold a bubble → open the tapback picker (with a haptic tick).
  const openPicker = (msgId: string) => { tabTick(); setPickerFor(msgId); };

  // Delete one of your own messages (used by the GIF sheet's "Delete GIF"). Needs
  // the senders-delete-own RLS policy (supabase/sql/message_delete.sql).
  async function deleteMessage(msgId: string) {
    setMessages(prev => prev.filter(m => m.id !== msgId));
    await supabase.from('messages').delete().eq('id', msgId);
  }

  // Apply (or toggle off) a reaction. Optimistic: the emoji lands instantly, then
  // the DB write follows — realtime later reconciles the other participant's view.
  async function applyReaction(messageId: string, emoji: string) {
    if (!currentUserId) return;
    setPickerFor(null);
    reactionPop();
    const mine = (reactions[messageId] || []).find(r => r.user_id === currentUserId);
    const removing = mine?.emoji === emoji; // tapping your current emoji clears it
    setReactions(prev => {
      const rest = (prev[messageId] || []).filter(r => r.user_id !== currentUserId);
      if (!removing) rest.push({ message_id: messageId, user_id: currentUserId, emoji });
      return { ...prev, [messageId]: rest };
    });
    const { error } = removing
      ? await supabase.from('message_reactions')
          .delete().eq('message_id', messageId).eq('user_id', currentUserId)
      : await supabase.from('message_reactions')
          .upsert({ message_id: messageId, user_id: currentUserId, emoji }, { onConflict: 'message_id,user_id' });
    // If the write failed (most commonly: the message_reactions table/policies
    // haven't been created yet — run supabase/sql/message_reactions.sql), the DB
    // never changed, so reconcile local state back to the truth instead of
    // leaving a phantom reaction that would vanish on the next open.
    if (error) {
      if (__DEV__) console.warn('[reactions] write failed — did you run message_reactions.sql?', error.message);
      setMessages(curr => { fetchReactions(curr.map(m => m.id)); return curr; });
    }
  }

  // A small pill of reaction chips that hangs off the bubble's outer-bottom edge.
  function renderReactions(messageId: string, isOwn: boolean) {
    const list = reactions[messageId];
    if (!list?.length) return null;
    const counts: Record<string, number> = {};
    for (const r of list) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => setReactorsFor(messageId)}
        style={[styles.reactions, isOwn ? styles.reactionsOwn : styles.reactionsOther]}
      >
        {Object.entries(counts).map(([emoji, count]) => (
          <View key={emoji} style={styles.reactionChip}>
            <Text style={[styles.reactionEmoji, emoji === '❤️' && styles.reactionHeart]}>{emoji}</Text>
            {count > 1 && <Text style={styles.reactionCount}>{count}</Text>}
          </View>
        ))}
      </TouchableOpacity>
    );
  }

  // Name/avatar for whoever left a reaction (me, or the person I'm chatting with).
  function reactorName(userId: string) {
    if (userId === currentUserId) return t('messages.reactionYou');
    return otherUser?.display_name || otherUser?.username || '—';
  }
  function renderReactorAvatar(userId: string, size: number) {
    const p = userId === currentUserId ? myProfile : otherUser;
    if ((p as any)?.avatar_url) return <Image source={{ uri: (p as any).avatar_url }} style={{ width: size, height: size, borderRadius: RADIUS.full }} />;
    return (
      <LinearGradient colors={GRADIENTS.primary} style={{ width: size, height: size, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: size * 0.42, fontWeight: '800' }}>
          {((p as any)?.display_name || (p as any)?.username || '?').charAt(0).toUpperCase()}
        </Text>
      </LinearGradient>
    );
  }

  // Pick an image/GIF from the library and stage it as the next message's attachment.
  async function attachImage() {
    if (!currentUserId || attaching) return;
    setAttaching(true);
    try {
      const att = await pickImageAttachment(currentUserId);
      if (att) setPendingAttachment(att);
    } catch { Alert.alert(t('attach.uploadFailed')); }
    setAttaching(false);
  }

  async function sendMessage() {
    if ((!newMessage.trim() && !pendingAttachment) || !currentUserId || sending) return;
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
    // An attachment carries an optional caption; otherwise it's plain text.
    const body = pendingAttachment ? attachmentBody(pendingAttachment, newMessage.trim()) : newMessage.trim();
    setNewMessage('');
    setPendingAttachment(null);
    const { data, error } = await supabase.from('messages')
      .insert({ sender_id: currentUserId, receiver_id: id, body })
      .select().single();
    if (!error && data) {
      impactLight(); // soft confirming tap on a sent message
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
            <Ionicons name="chevron-back" size={26} color={colors.text} />
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
          <Ionicons name="chevron-back" size={26} color={colors.text} />
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
        <TouchableOpacity style={styles.headerMenuBtn} onPress={() => setMenuOpen(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
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
        // iOS: drag the transcript down to interactively dismiss the keyboard
        // (iMessage feel); keep taps (long-press to react) alive with the keyboard up.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.messagesList, { paddingBottom: insets.bottom + 76 }]}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>{t('messages.startConversation', { name: otherUser?.display_name ?? '' })}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isOwn = item.sender_id === currentUserId;
          const timeOpacity = getTimeOpacity(item.id);
          // A story reply renders as its stillshot + the text underneath.
          const storyRef = parseStoryReply(item.body);
          if (storyRef) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <Text style={styles.storyReplyLabel}>
                  {isOwn ? t('messages.youRepliedStory') : t('messages.repliedYourStory')}
                </Text>
                <TouchableOpacity activeOpacity={0.85} onPress={() => openStoryReply(storyRef)} onLongPress={() => openPicker(item.id)} delayLongPress={280}>
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
                {renderReactions(item.id, isOwn)}
              </View>
            );
          }
          const att = parseAttachment(item.body);
          // An image/GIF attachment: the media, then an optional caption bubble.
          if (att) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <TouchableOpacity
                  activeOpacity={0.9}
                  onPress={att.type === 'gif'
                    ? () => openGifAttachment(att, { userId: currentUserId, onView: () => setViewerUrl(att.url), canDelete: isOwn, onDelete: () => deleteMessage(item.id) })
                    : () => setViewerUrl(att.url)}
                  onLongPress={att.type === 'gif'
                    ? () => openGifAttachment(att, { userId: currentUserId, onView: () => setViewerUrl(att.url), canDelete: isOwn, onDelete: () => deleteMessage(item.id) })
                    : () => openPicker(item.id)}
                  delayLongPress={280}
                >
                  <AttachmentView url={att.url} w={att.w} h={att.h} />
                </TouchableOpacity>
                {att.text ? (
                  isOwn ? (
                    <LinearGradient colors={bubbleBlue} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.bubble, styles.bubbleOwn, styles.attachCaption]}>
                      <TranslatableText text={att.text} render={(s) => renderBody(s, isOwn)} linkStyle={{ color: 'rgba(255,255,255,0.85)' }} />
                    </LinearGradient>
                  ) : (
                    <View style={[styles.bubble, styles.bubbleOther, styles.attachCaption]}>
                      <TranslatableText text={att.text} render={(s) => renderBody(s, isOwn)} linkStyle={{ color: colors.textSecondary }} />
                    </View>
                  )
                ) : null}
                <Animated.Text style={[styles.cardTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>
                {renderReactions(item.id, isOwn)}
              </View>
            );
          }
          const postId = sharedPostId(item.body);
          // A shared post renders as a standalone preview card (no chat bubble).
          if (postId) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <TouchableOpacity activeOpacity={0.9} onLongPress={() => openPicker(item.id)} delayLongPress={280}>
                  <SharedPostCard postId={postId} />
                </TouchableOpacity>
                <Animated.Text style={[styles.cardTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>
                {renderReactions(item.id, isOwn)}
              </View>
            );
          }
          return (
            <View style={[styles.bubbleRow, isOwn ? styles.bubbleRowOwn : styles.bubbleRowOther]}>
              {/* Time sits OUTSIDE the bubble, vertically centered to its height. */}
              {isOwn && <Animated.Text style={[styles.msgTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>}
              {/* Bubble + its reactions stack together, so the reaction anchors to
                  the bubble's inner-bottom corner regardless of the row's width. */}
              <View style={[styles.bubbleStack, isOwn ? styles.bubbleStackOwn : styles.bubbleStackOther]}>
                <TouchableOpacity activeOpacity={1} onPress={() => showTap(item.id)} onLongPress={() => openPicker(item.id)} delayLongPress={280} style={styles.bubbleFill}>
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
                {renderReactions(item.id, isOwn)}
              </View>
              {!isOwn && <Animated.Text style={[styles.msgTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>}
            </View>
          );
        }}
      />
      </KeyboardAvoidingView>

      <Animated.View style={[styles.inputBarWrap, { transform: [{ translateY: kbShift }] }]}>
      {pendingAttachment && (
        // Full-width row is a keyboard-dismiss zone; the box hugs the GIF only, so
        // tapping the space beside it exits typing rather than doing nothing.
        <Pressable style={styles.attachPreviewRow} onPress={() => Keyboard.dismiss()}>
          <View style={styles.attachPreviewItem}>
            <AttachmentView url={pendingAttachment.url} w={pendingAttachment.w} h={pendingAttachment.h} maxWidth={110} radius={12} />
            <TouchableOpacity style={styles.attachRemove} onPress={() => setPendingAttachment(null)} hitSlop={8}>
              <Ionicons name="close-circle" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
        </Pressable>
      )}
      <View
        // No solid bar — just the floating input pill + send circle over the
        // messages, for a cleaner look.
        style={[styles.inputBar, { paddingBottom: kbUp ? SPACING.sm + 2 : Math.max(insets.bottom, SPACING.sm) + SPACING.sm }]}
      >
        <TouchableOpacity style={styles.attachBtn} onPress={attachImage} disabled={attaching} activeOpacity={0.7}>
          {attaching ? <ActivityIndicator size="small" color={colors.textSecondary} /> : <Ionicons name="image-outline" size={24} color={colors.textSecondary} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.gifBtn} onPress={() => setGifOpen(true)} activeOpacity={0.7}>
          <Text style={styles.gifBtnText}>GIF</Text>
        </TouchableOpacity>
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
          disabled={(!newMessage.trim() && !pendingAttachment) || sending}
          style={(!newMessage.trim() && !pendingAttachment) && styles.sendBtnDisabled}
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

      <GifPickerModal visible={gifOpen} userId={currentUserId} onClose={() => setGifOpen(false)} onSelect={(g) => setPendingAttachment({ type: 'gif', url: g.url, w: g.w, h: g.h, src: g.src })} />
      <ImageViewerModal url={viewerUrl} onClose={() => setViewerUrl(null)} />

      {/* Reaction picker — a floating tapback pill over a dimmed backdrop. */}
      <Modal visible={pickerFor !== null} transparent animationType="fade" onRequestClose={() => setPickerFor(null)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setPickerFor(null)}>
          <View style={styles.pickerRow}>
            {TAPBACKS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                activeOpacity={0.6}
                onPress={() => pickerFor && applyReaction(pickerFor, emoji)}
                style={styles.pickerEmojiBtn}
              >
                <Text style={styles.pickerEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Who reacted — tap a reaction to see each person and their emoji. */}
      <Modal visible={reactorsFor !== null} transparent animationType="fade" onRequestClose={() => setReactorsFor(null)}>
        <Pressable style={styles.reactorBackdrop} onPress={() => setReactorsFor(null)}>
          <Pressable style={styles.reactorCard} onPress={() => {}}>
            <Text style={styles.reactorTitle}>{t('messages.reactionsTitle')}</Text>
            {(reactorsFor ? reactions[reactorsFor] || [] : []).map((r) => (
              <TouchableOpacity
                key={r.user_id + r.emoji}
                style={styles.reactorRow}
                activeOpacity={0.7}
                onPress={() => { setReactorsFor(null); if (r.user_id !== currentUserId) router.push(`/profile/${r.user_id}`); }}
              >
                {renderReactorAvatar(r.user_id, 36)}
                <Text style={styles.reactorName} numberOfLines={1}>{reactorName(r.user_id)}</Text>
                <Text style={[styles.reactorEmoji, r.emoji === '❤️' && styles.reactionHeart]}>{r.emoji}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Chat options — 3-dot menu (report, and more in the future). */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuCard, { top: insets.top + 52 }]}>
            <TouchableOpacity
              style={styles.menuItem}
              activeOpacity={0.7}
              onPress={() => { setMenuOpen(false); reportUser(String(id)); }}
            >
              <Ionicons name="flag-outline" size={18} color={colors.error} />
              <Text style={[styles.menuItemText, { color: colors.error }]}>{t('chat.report')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
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
  headerMenuBtn: { padding: SPACING.xs, marginLeft: SPACING.xs },

  // 3-dot chat-options menu: a small card dropping from the top-right.
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.15)' },
  menuCard: {
    position: 'absolute', right: SPACING.md,
    minWidth: 180, backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.lg, paddingVertical: SPACING.xs,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2 },
  menuItemText: { fontSize: 15, fontWeight: '600' },

  messagesList: { padding: SPACING.md, gap: 2, flexGrow: 1 },

  bubbleWrap: { marginBottom: SPACING.xs },
  bubbleWrapOwn: { alignItems: 'flex-end' },
  bubbleWrapOther: { alignItems: 'flex-start' },
  // Text-message row: the bubble + a small time on its INNER side, bottom-aligned
  // (time to the left of sent bubbles, to the right of received ones).
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: SPACING.xs, gap: 6 },
  bubbleRowOwn: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  // Side time, vertically centered to the bubble's mid-height (not the corner).
  msgTime: { fontSize: 10, color: colors.textTertiary, alignSelf: 'center' },
  // The stack carries the width cap; the bubble fills it (a %-maxWidth on the
  // bubble wouldn't resolve inside an auto-width wrapper).
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

  // Who-reacted list (tap a reaction).
  reactorBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  reactorCard: {
    width: '100%', maxWidth: 340, backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.xl, paddingVertical: SPACING.md, paddingHorizontal: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  reactorTitle: { color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: SPACING.sm },
  reactorRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, paddingVertical: 7 },
  reactorName: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  reactorEmoji: { fontSize: 20 },

  // Bubble + reactions stack: caps the bubble width and holds the tapback pill
  // directly under it, aligned to the bubble's INNER edge (toward the middle) —
  // left for your own bubbles, right for received ones.
  bubbleStack: { maxWidth: '80%' },
  bubbleStackOwn: { alignItems: 'flex-start' },
  bubbleStackOther: { alignItems: 'flex-end' },
  // Rides up the bubble's inner side edge and pokes slightly OUT past the corner
  // (negative side margin) so it hugs the side edge, not the bottom edge.
  reactions: { flexDirection: 'row', gap: 3, marginTop: -12, zIndex: 2 },
  reactionsOwn: { marginLeft: -6 },
  reactionsOther: { marginRight: -6 },
  // No chip/border — just the bare emoji (+ count) hanging off the bubble.
  reactionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 2,
  },
  reactionEmoji: { fontSize: 13 },
  // ❤️ (U+2764 + emoji VS) is drawn smaller and lower than the pictographic
  // tapbacks; bump its size and lift it so it lines up with the rest.
  reactionHeart: { fontSize: 15, transform: [{ translateY: -1 }] },
  reactionCount: { fontSize: 11, color: colors.textSecondary, fontWeight: '700' },

  // Reaction picker overlay.
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  pickerRow: {
    flexDirection: 'row', gap: 4,
    backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 8, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  pickerEmojiBtn: { width: 46, height: 46, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  pickerEmoji: { fontSize: 28 },

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
  attachCaption: { marginTop: 4 },

  // Staged attachment preview above the compose bar.
  attachPreviewRow: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingBottom: SPACING.xs },
  attachPreviewItem: { alignSelf: 'flex-start' }, // hug the GIF; rest of the row dismisses the keyboard
  attachRemove: { position: 'absolute', top: -6, right: -6, backgroundColor: colors.background, borderRadius: RADIUS.full },
  // Image + GIF buttons on the compose bar.
  attachBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  gifBtn: {
    height: 44, paddingHorizontal: 8, borderRadius: RADIUS.md,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.textSecondary,
  },
  gifBtnText: { color: colors.textSecondary, fontSize: 12, fontWeight: '900', letterSpacing: 0.3 },

  // Floating frosted-glass bar (iOS-style): messages scroll under the blur.
  // The Animated wrapper owns the absolute position + keyboard slide.
  inputBarWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm + 2, gap: SPACING.xs,
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
