import {
  View, Text, StyleSheet, FlatList, TextInput, Image,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
  Keyboard, Animated, Modal, Pressable, Alert, Dimensions,
} from 'react-native';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../../components/SwipeBackPager';
import { supabase } from '../../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../../constants/theme';
import { useTheme, useThemedStyles } from '../../../contexts/ThemeContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { useLinkGuard } from '../../../contexts/LinkGuardContext';
import { createNotification } from '../../../lib/createNotification';
import { sharedPostId, internalPathFromUrl } from '../../../lib/postLinks';
import { groupTitle, markGroupRead, renameGroup, renameEventBody, parseRenameEvent, type GroupProfile } from '../../../lib/groups';
import { reportConversation } from '../../../lib/postActions';
import { parseAttachment, attachmentBody, pickImageAttachment, type Attachment } from '../../../lib/attachments';
import { openGifAttachment } from '../../../lib/gifAttachmentActions';
import GifPickerModal from '../../../components/GifPickerModal';
import AttachmentView from '../../../components/AttachmentView';
import ImageViewerModal from '../../../components/ImageViewerModal';
import { tabTick, reactionPop, impactLight } from '../../../lib/haptics';
import SharedPostCard from '../../../components/SharedPostCard';
import GroupAvatar from '../../../components/GroupAvatar';
import { ChatThreadSkeleton } from '../../../components/Skeleton';

type Message = { id: string; body: string; sender_id: string; conversation_id: string; created_at: string };
type Reaction = { message_id: string; user_id: string; emoji: string };
type Conversation = { id: string; title: string | null; avatar_url: string | null; created_by: string | null };

const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓'];
const RUN_GAP_MS = 15 * 60 * 1000; // separator + re-show sender after a 15-min gap

export default function GroupChatScreen() {
  const { colors, mode } = useTheme();
  const { t } = useTranslation();
  const linkGuard = useLinkGuard();
  const styles = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const light = mode === 'light';
  const inputFill = light ? colors.surface : colors.surfaceElevated;
  const inputBorder = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.14)';
  const bubbleBlue = ['#1FA0FF', '#0A7CFF'] as const;

  const flatListRef = useRef<FlatList>(null);
  // NOTE ON SCROLL POSITION — there is deliberately none of it. Same inverted
  // list as the 1:1 thread, for the same reason: offset 0 IS the bottom of the
  // conversation, so a group opens on its newest message without scrolling, and
  // a cell that measures late grows towards the older end rather than shoving
  // the newest one off the bottom. See app/messages/[id].tsx for the full note.
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [members, setMembers] = useState<GroupProfile[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  // Oldest-first in state, reversed only for the inverted list.
  const orderedMessages = useMemo(() => [...messages].reverse(), [messages]);
  const [reactions, setReactions] = useState<Record<string, Reaction[]>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [reactorsFor, setReactorsFor] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<Attachment | null>(null);
  const [gifOpen, setGifOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');

  const membersById: Record<string, GroupProfile> = {};
  for (const m of members) membersById[m.id] = m;

  // Message times: reveal for 4s on open, then fade; tap a message to re-reveal.
  // Identical per-message opacity system to the 1:1 DM screen so both behave the
  // same (each message owns its Animated.Value + fade timer; a tap animates it
  // directly, so it always registers instantly).
  const opacityMap = useRef<Record<string, Animated.Value>>({}).current;
  const fadeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({}).current;
  const getTimeOpacity = (msgId: string) => (opacityMap[msgId] ||= new Animated.Value(0));
  const scheduleFade = (msgId: string) => {
    if (fadeTimers[msgId]) clearTimeout(fadeTimers[msgId]);
    fadeTimers[msgId] = setTimeout(() => {
      Animated.timing(getTimeOpacity(msgId), { toValue: 0, duration: 500, useNativeDriver: true }).start();
    }, 4000);
  };
  const showTap = (msgId: string) => {
    const o = getTimeOpacity(msgId);
    o.stopAnimation();
    o.setValue(1);
    scheduleFade(msgId);
  };

  // Compose bar slides with the keyboard (iOS) — same approach as the DM screen.
  const kbShift = useRef(new Animated.Value(0)).current;
  const [kbUp, setKbUp] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    // RAISE on willShow OR willChangeFrame (iOS skips willShow during rapid focus),
    // but only for an ON-SCREEN frame; LOWER only on an explicit willHide. Fixes
    // "slides up then glitches back down": iOS emits a stray off-screen frame after
    // the show, which the old code misread as a hide and dropped the bar.
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
    // correct the resting position — this keeps re-triggers (2nd+ open) from ending
    // up glitched under the keyboard when events interleave across cycles.
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

  useEffect(() => {
    if (!currentUserId || !id) return;
    const channel = supabase
      .channel(`group-${id}-${currentUserId}-${Date.now().toString(36)}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` },
        (payload) => {
          const msg = payload.new as Message;
          // My own sends are appended optimistically; skip the echo.
          if (String(msg.sender_id) === String(currentUserId)) return;
          setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
          // onContentSizeChange follows the bottom only if already there.
          markGroupRead(String(id), currentUserId);
        }
      )
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'message_reactions' },
        () => { setMessages(curr => { fetchReactions(curr.map(m => m.id)); return curr; }); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, id]);

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
  // Clear any pending fade timers on unmount.
  useEffect(() => () => { Object.values(fadeTimers).forEach((t) => clearTimeout(t)); }, []);

  async function setup() {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);

      const [{ data: conv }, { data: memberRows }, { data: msgs }] = await Promise.all([
        supabase.from('conversations').select('id, title, avatar_url, created_by').eq('id', id).single(),
        supabase.from('conversation_members').select('user_id').eq('conversation_id', id),
        supabase.from('messages').select('id, body, sender_id, conversation_id, created_at')
          .eq('conversation_id', id).order('created_at', { ascending: true }),
      ]);
      if (conv) setConversation(conv as Conversation);
      if (memberRows?.length) {
        const ids = memberRows.map(r => r.user_id);
        const { data: profiles } = await supabase
          .from('profiles').select('id, username, display_name, avatar_url, badge_tier, badge_show').in('id', ids);
        if (profiles) setMembers(profiles as GroupProfile[]);
      }
      if (msgs) { setMessages(msgs as Message[]); fetchReactions(msgs.map((m: any) => m.id)); }
      markGroupRead(String(id), user.id);
    } finally {
      // Never strand the group thread on a skeleton if a fetch rejects.
      setLoading(false);
    }
  }

  async function fetchReactions(ids: string[]) {
    if (!ids.length) { setReactions({}); return; }
    const { data } = await supabase.from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids);
    if (!data) return;
    const map: Record<string, Reaction[]> = {};
    for (const r of data as Reaction[]) (map[r.message_id] ||= []).push(r);
    setReactions(map);
  }

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
    setSending(true);
    const prevText = newMessage;
    const prevAttachment = pendingAttachment;
    const body = pendingAttachment ? attachmentBody(pendingAttachment, newMessage.trim()) : newMessage.trim();
    setNewMessage('');
    setPendingAttachment(null);
    const { data, error } = await supabase.from('messages')
      .insert({ sender_id: currentUserId, conversation_id: id, body })
      .select('id, body, sender_id, conversation_id, created_at').single();
    if (!error && data) {
      impactLight(); // soft confirming tap on a sent message
      setMessages(prev => [...prev, data as Message]);
      // You always follow your own sent message. Offset 0 is the bottom on an
      // inverted list, so this only does anything if they had scrolled up.
      flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
      // Notify the other members (fire-and-forget).
      members.filter(m => m.id !== currentUserId).forEach(m =>
        createNotification({ userId: m.id, actorId: currentUserId, type: 'message' }));
    } else {
      // Send failed — restore the typed text and staged attachment so nothing
      // the user wrote is silently dropped.
      setNewMessage(prevText);
      setPendingAttachment(prevAttachment);
    }
    setSending(false);
  }

  const openPicker = (msgId: string) => { tabTick(); setPickerFor(msgId); };

  // Delete your own message (used by the GIF sheet's "Delete GIF"). Needs the
  // senders-delete-own RLS policy (supabase/sql/message_delete.sql).
  async function deleteMessage(msgId: string) {
    setMessages(prev => prev.filter(m => m.id !== msgId));
    await supabase.from('messages').delete().eq('id', msgId);
  }

  async function applyReaction(messageId: string, emoji: string) {
    if (!currentUserId) return;
    setPickerFor(null);
    reactionPop();
    const mine = (reactions[messageId] || []).find(r => r.user_id === currentUserId);
    const removing = mine?.emoji === emoji;
    setReactions(prev => {
      const rest = (prev[messageId] || []).filter(r => r.user_id !== currentUserId);
      if (!removing) rest.push({ message_id: messageId, user_id: currentUserId, emoji });
      return { ...prev, [messageId]: rest };
    });
    const { error } = removing
      ? await supabase.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', currentUserId)
      : await supabase.from('message_reactions').upsert({ message_id: messageId, user_id: currentUserId, emoji }, { onConflict: 'message_id,user_id' });
    if (error) {
      if (__DEV__) console.warn('[reactions] write failed — run message_reactions.sql + group_chats.sql', error.message);
      setMessages(curr => { fetchReactions(curr.map(m => m.id)); return curr; });
    }
  }

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

  function reactorName(userId: string) {
    if (userId === currentUserId) return t('messages.reactionYou');
    return membersById[userId]?.display_name || membersById[userId]?.username || '—';
  }

  function reportGroup() {
    setMenuOpen(false);
    reportConversation(String(id)); // opens the app's themed report sheet
  }

  function formatTime(dateString: string) {
    return new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function saveRename() {
    const trimmed = draftName.trim();
    const ok = await renameGroup(String(id), trimmed);
    if (!ok) return;
    setConversation(c => (c ? { ...c, title: trimmed || null } : c));
    setRenaming(false);
    // Drop a system line into the thread marking the change (with a timestamp).
    if (currentUserId) {
      const { data } = await supabase.from('messages')
        .insert({ sender_id: currentUserId, conversation_id: id, body: renameEventBody(trimmed) })
        .select('id, body, sender_id, conversation_id, created_at').single();
      if (data) {
        setMessages(prev => [...prev, data as Message]);
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
    }
  }

  function openLink(url: string) {
    const path = internalPathFromUrl(url);
    if (path) router.push(path as any);
    else linkGuard.open(url, { context: 'message' });
  }

  function renderBody(body: string, isOwn: boolean) {
    const parts = body.split(/(laybell:\/\/\S+|https?:\/\/\S+)/g);
    return (
      <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>
        {parts.map((part, i) => {
          if (!part) return null;
          if (part.startsWith('laybell://') || /^https?:\/\//.test(part)) {
            const path = internalPathFromUrl(part);
            const label = path?.startsWith('/post/') ? t('messages.viewPost') : part;
            return <Text key={i} style={[styles.link, isOwn ? styles.linkOwn : styles.linkOther]} onPress={() => openLink(part)}>{label}</Text>;
          }
          return part;
        })}
      </Text>
    );
  }

  function renderAvatar(p: GroupProfile | undefined, size: number) {
    if (p?.avatar_url) return <Image source={{ uri: p.avatar_url }} style={{ width: size, height: size, borderRadius: RADIUS.full }} />;
    return (
      <LinearGradient colors={GRADIENTS.primary} style={{ width: size, height: size, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: size * 0.42, fontWeight: '800' }}>
          {(p?.display_name || p?.username || '?').charAt(0).toUpperCase()}
        </Text>
      </LinearGradient>
    );
  }

  const title = groupTitle(members, currentUserId, conversation?.title);
  const otherMembers = members.filter(m => m.id !== currentUserId);

  if (loading) {
    return (
      <SwipeBackPager>
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ChatThreadSkeleton rows={9} />
      </View>
      </SwipeBackPager>
    );
  }

  return (
    <SwipeBackPager>
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerUser} activeOpacity={0.7} onPress={() => setMembersOpen(true)}>
          <GroupAvatar avatarUrl={conversation?.avatar_url} members={otherMembers} size={40} />
          <View style={styles.headerInfo}>
            <Text style={styles.headerName} numberOfLines={1}>{title}</Text>
            <Text style={styles.headerSub} numberOfLines={1}>{t('groups.memberCount', { count: members.length })}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.moreOptions')} style={styles.headerMenuBtn} onPress={() => setMenuOpen(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={styles.chatBody} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <FlatList
          ref={flatListRef}
          inverted
          data={orderedMessages}
          keyExtractor={item => item.id}
          // 'on-drag', not 'interactive' — see the note in app/messages/[id].tsx:
          // interactive dismissal tracks the finger in the ScrollView's own
          // coordinate space, which `inverted` flips.
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // paddingTOP, not bottom: inverted flips the content, so the start of
          // the content is the visual bottom — the clearance under the compose bar.
          contentContainerStyle={[styles.messagesList, { paddingTop: insets.bottom + 76 }]}
          ListEmptyComponent={
            // Counter-flipped: unlike the cells, the empty component gets no
            // correction for the list's scaleY(-1) of its own.
            <View style={[styles.emptyContainer, styles.unflip]}>
              <Text style={styles.emptyText}>{t('groups.startConversation')}</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            const isOwn = item.sender_id === currentUserId;
            // The chronologically OLDER neighbour, which the clustering rules below
            // compare against. The list is inverted and newest-first, so that is
            // index + 1 — reading it from `messages[index - 1]` would compare each
            // bubble against the message AFTER it and cluster the wrong ones.
            const prev = orderedMessages[index + 1];
            // A group-name change renders as a centered system line with its time,
            // never as a chat bubble.
            const renameTo = parseRenameEvent(item.body);
            if (renameTo !== null) {
              const actor = isOwn
                ? t('groups.you')
                : (membersById[item.sender_id]?.display_name || membersById[item.sender_id]?.username || '—');
              const label = renameTo
                ? t('groups.renamedTo', { actor, name: renameTo })
                : t('groups.renamedCleared', { actor });
              return (
                <Text style={styles.systemLine}>{label} · {formatTime(item.created_at)}</Text>
              );
            }
            const gap = prev ? new Date(item.created_at).getTime() - new Date(prev.created_at).getTime() : Infinity;
            // A new sender, a long pause, or a preceding system line restarts the
            // "run" → re-show the avatar + name. No date separator — times live
            // beside each bubble.
            const prevIsSystem = !!prev && parseRenameEvent(prev.body) !== null;
            const firstOfRun = !prev || prevIsSystem || gap > RUN_GAP_MS || prev.sender_id !== item.sender_id;
            const sender = membersById[item.sender_id];
            const postId = sharedPostId(item.body);
            const att = parseAttachment(item.body);
            const timeOpacity = getTimeOpacity(item.id);
            // Time sits OUTSIDE the bubble, vertically centered to its height.
            const sideTime = <Animated.Text style={[styles.msgTime, { opacity: timeOpacity }]}>{formatTime(item.created_at)}</Animated.Text>;
            return (
              <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
                {isOwn && sideTime}
                {!isOwn && (firstOfRun
                  ? <View style={styles.avatarSlot}>{renderAvatar(sender, 28)}</View>
                  : <View style={styles.avatarSlot} />)}
                <View style={[styles.col, isOwn ? styles.colOwn : styles.colOther]}>
                  {!isOwn && firstOfRun && (
                    <Text style={styles.senderName} numberOfLines={1}>{sender?.display_name || sender?.username || '—'}</Text>
                  )}
                  {/* Bubble + reactions stack, so the tapback anchors to the
                      bubble's inner-bottom corner (not the sender-name width). */}
                  <View style={isOwn ? styles.bubbleStackOwn : styles.bubbleStackOther}>
                    {att ? (
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
                        <AttachmentView url={att.url} w={att.w} h={att.h} maxWidth={200} />
                        {att.text ? (
                          isOwn ? (
                            <LinearGradient colors={bubbleBlue} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.bubble, styles.bubbleOwn, styles.attachCaption]}>
                              {renderBody(att.text, true)}
                            </LinearGradient>
                          ) : (
                            <View style={[styles.bubble, styles.bubbleOther, styles.attachCaption]}>{renderBody(att.text, false)}</View>
                          )
                        ) : null}
                      </TouchableOpacity>
                    ) : postId ? (
                      <TouchableOpacity activeOpacity={0.9} onPress={() => showTap(item.id)} onLongPress={() => openPicker(item.id)} delayLongPress={280}>
                        <SharedPostCard postId={postId} />
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity activeOpacity={0.9} onPress={() => showTap(item.id)} onLongPress={() => openPicker(item.id)} delayLongPress={280} style={styles.bubbleTouch}>
                        {isOwn ? (
                          <LinearGradient colors={bubbleBlue} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.bubble, styles.bubbleOwn]}>
                            {renderBody(item.body, true)}
                          </LinearGradient>
                        ) : (
                          <View style={[styles.bubble, styles.bubbleOther]}>{renderBody(item.body, false)}</View>
                        )}
                      </TouchableOpacity>
                    )}
                    {renderReactions(item.id, isOwn)}
                  </View>
                </View>
                {!isOwn && sideTime}
              </View>
            );
          }}
        />
      </KeyboardAvoidingView>

      <Animated.View style={[styles.inputBarWrap, { transform: [{ translateY: kbShift }] }]}>
        {pendingAttachment && (
          // Full-width row is a keyboard-dismiss zone; the box hugs the GIF only, so
          // tapping the space beside it exits typing rather than doing nothing.
          <Pressable accessibilityRole="button" accessibilityLabel={t('a11y.clear')} style={styles.attachPreviewRow} onPress={() => Keyboard.dismiss()}>
            <View style={styles.attachPreviewItem}>
              <AttachmentView url={pendingAttachment.url} w={pendingAttachment.w} h={pendingAttachment.h} maxWidth={110} radius={12} />
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} style={styles.attachRemove} onPress={() => setPendingAttachment(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
          </Pressable>
        )}
        <View style={[styles.inputBar, { paddingBottom: kbUp ? SPACING.sm + 2 : Math.max(insets.bottom, SPACING.sm) + SPACING.sm }]}>
          <TouchableOpacity style={styles.attachBtn} onPress={attachImage} disabled={attaching} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={t('a11y.attachImage')}>
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
          <TouchableOpacity activeOpacity={0.85} onPress={sendMessage} disabled={(!newMessage.trim() && !pendingAttachment) || sending} style={(!newMessage.trim() && !pendingAttachment) && styles.sendBtnDisabled}>
            <View style={[styles.sendBtn, { backgroundColor: colors.text }]}>
              {sending ? <ActivityIndicator color={colors.background} size="small" /> : <Ionicons name="arrow-up" size={20} color={colors.background} />}
            </View>
          </TouchableOpacity>
        </View>
      </Animated.View>

      <GifPickerModal visible={gifOpen} userId={currentUserId} onClose={() => setGifOpen(false)} onSelect={(g) => setPendingAttachment({ type: 'gif', url: g.url, w: g.w, h: g.h, src: g.src })} />
      <ImageViewerModal state={viewerUrl ? { url: viewerUrl } : null} onClose={() => setViewerUrl(null)} />

      {/* Reaction picker */}
      <Modal visible={pickerFor !== null} transparent animationType="fade" onRequestClose={() => setPickerFor(null)}>
        <Pressable style={styles.pickerBackdrop} onPress={() => setPickerFor(null)}>
          <View style={styles.pickerRow}>
            {TAPBACKS.map((emoji) => (
              <TouchableOpacity key={emoji} activeOpacity={0.6} onPress={() => pickerFor && applyReaction(pickerFor, emoji)} style={styles.pickerEmojiBtn}>
                <Text style={styles.pickerEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Members list */}
      <Modal visible={membersOpen} transparent animationType="fade" onRequestClose={() => { setMembersOpen(false); setRenaming(false); }}>
        <KeyboardAvoidingView style={styles.sheetKav} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.sheetBackdrop} onPress={() => { setMembersOpen(false); setRenaming(false); }}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }]} onPress={() => {}}>
            <Text style={styles.sheetTitle}>{t('groups.membersTitle', { count: members.length })}</Text>

            {/* Rename the group (any member can). */}
            {renaming ? (
              <View style={styles.renameRow}>
                <TextInput
                  style={styles.renameInput}
                  value={draftName}
                  onChangeText={setDraftName}
                  placeholder={t('groups.namePlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  maxLength={40}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={saveRename}
                />
                <TouchableOpacity onPress={saveRename} style={styles.renameSaveBtn} activeOpacity={0.85}>
                  <Text style={styles.renameSaveText}>{t('groups.save')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.renameBtnWrap}
                activeOpacity={0.85}
                onPress={() => { setDraftName(conversation?.title || ''); setRenaming(true); }}
              >
                <LinearGradient colors={bubbleBlue} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.renameBtn}>
                  <Text style={styles.renameBtnText}>{t('groups.changeName')}</Text>
                </LinearGradient>
              </TouchableOpacity>
            )}

            {members.map(m => (
              <TouchableOpacity
                key={m.id}
                style={styles.memberRow}
                activeOpacity={0.7}
                onPress={() => { setMembersOpen(false); if (m.id !== currentUserId) router.push(`/profile/${m.id}`); }}
              >
                {renderAvatar(m, 40)}
                <View style={styles.memberInfo}>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {m.display_name || m.username}{m.id === currentUserId ? ` ${t('groups.you')}` : ''}
                  </Text>
                  {!!m.username && <Text style={styles.memberUsername} numberOfLines={1}>@{m.username}</Text>}
                </View>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
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
                {renderAvatar(membersById[r.user_id], 36)}
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
            <TouchableOpacity style={styles.menuItem} activeOpacity={0.7} onPress={reportGroup}>
              <Ionicons name="flag-outline" size={18} color={colors.error} />
              <Text style={[styles.menuItemText, { color: colors.error }]}>{t('chat.report')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  chatBody: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.md, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border, gap: SPACING.xs,
  },
  backBtn: { padding: SPACING.xs },
  headerUser: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  headerInfo: { flex: 1 },
  headerName: { color: colors.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  headerSub: { color: colors.textSecondary, fontSize: 13 },
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
  // Side time, vertically centered to the bubble's mid-height (not the corner).
  msgTime: { fontSize: 10, color: colors.textTertiary, alignSelf: 'center' },
  // Centered system line (e.g. a group-name change) with an always-visible time.
  systemLine: { alignSelf: 'center', textAlign: 'center', color: colors.textTertiary, fontSize: 12, fontWeight: '500', marginVertical: SPACING.sm, paddingHorizontal: SPACING.lg },

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

  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginBottom: 2 },
  rowOwn: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  avatarSlot: { width: 28, alignItems: 'center' },
  col: { maxWidth: '78%' },
  colOwn: { alignItems: 'flex-end' },
  colOther: { alignItems: 'flex-start' },
  senderName: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 2, marginLeft: 4 },

  bubbleTouch: { maxWidth: '100%' },
  bubble: { paddingHorizontal: 15, paddingVertical: 10, borderRadius: 26 },
  bubbleOwn: {
    borderBottomRightRadius: 9,
    shadowColor: '#0A7CFF', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 3,
  },
  bubbleOther: {
    backgroundColor: colors.surfaceElevated, borderBottomLeftRadius: 9,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  bubbleText: { color: colors.text, fontSize: 17, lineHeight: 22, letterSpacing: -0.4, fontWeight: '400' },
  bubbleTextOwn: { color: '#fff' },
  link: { textDecorationLine: 'underline', fontWeight: '700' },
  linkOwn: { color: '#fff' },
  linkOther: { color: colors.primaryLight },

  // Bubble + reactions stack: the tapback sits under the bubble, aligned to its
  // INNER edge (toward the middle) — left for own bubbles, right for received.
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

  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.xxl },
  unflip: { transform: [{ scaleY: -1 }] },
  emptyText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },

  attachCaption: { marginTop: 4 },
  attachPreviewRow: { flexDirection: 'row', paddingHorizontal: SPACING.md, paddingBottom: SPACING.xs },
  attachPreviewItem: { alignSelf: 'flex-start' }, // hug the GIF; rest of the row dismisses the keyboard
  attachRemove: { position: 'absolute', top: -6, right: -6, backgroundColor: colors.background, borderRadius: RADIUS.full },
  attachBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  gifBtn: {
    height: 44, paddingHorizontal: 8, borderRadius: RADIUS.md,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.textSecondary,
  },
  gifBtnText: { color: colors.textSecondary, fontSize: 12, fontWeight: '900', letterSpacing: 0.3 },

  inputBarWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: SPACING.md, paddingTop: SPACING.sm + 2, gap: SPACING.xs },
  input: {
    flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, minHeight: 44,
    paddingHorizontal: SPACING.md + 2, paddingVertical: 11, color: colors.text, fontSize: 17, lineHeight: 22, maxHeight: 120,
  },
  sendBtn: { width: 44, height: 44, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.35 },

  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  pickerRow: {
    flexDirection: 'row', gap: 4, backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 8, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  pickerEmojiBtn: { width: 46, height: 46, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  pickerEmoji: { fontSize: 28 },

  sheetKav: { flex: 1 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.md, paddingHorizontal: SPACING.md, maxHeight: '70%',
  },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: SPACING.sm, textAlign: 'center' },
  // Rename group control inside the members sheet.
  renameBtnWrap: { alignSelf: 'center', borderRadius: RADIUS.full, overflow: 'hidden', marginBottom: SPACING.sm },
  renameBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg, alignItems: 'center', justifyContent: 'center' },
  renameBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  renameInput: {
    flex: 1, backgroundColor: colors.surface, borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15,
  },
  renameSaveBtn: { paddingHorizontal: SPACING.sm + 2, paddingVertical: SPACING.sm + 2 },
  renameSaveText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, paddingVertical: 8 },
  memberInfo: { flex: 1 },
  memberName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  memberUsername: { color: colors.textSecondary, fontSize: 13 },
});
