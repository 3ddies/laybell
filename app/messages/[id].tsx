import {
  View, Text, StyleSheet, FlatList, TextInput, Image,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator, Linking,
  Keyboard, Animated, Alert,
} from 'react-native';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { createNotification } from '../../lib/createNotification';
import { sharedPostId, internalPathFromUrl, parseStoryReply, type StoryReplyRef } from '../../lib/postLinks';
import SharedPostCard from '../../components/SharedPostCard';
import BadgeEmblem from '../../components/BadgeEmblem';

type Message = { id: string; body: string; sender_id: string; receiver_id: string; created_at: string };

export default function ChatScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
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

  useEffect(() => {
    if (!currentUserId) return;
    const channel = supabase
      .channel(`chat-${currentUserId}-${id}`)
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
    const { data: profile } = await supabase.from('profiles').select('username, display_name, avatar_url, badge_tier, badge_show, profile_theme').eq('id', id).single();
    if (profile) setOtherUser(profile);
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
        Alert.alert('Story unavailable', 'Stories disappear after 24 hours.');
        return;
      }
      router.push(`/story/${ref.ownerId}`);
    } catch {
      Alert.alert('Story unavailable', 'Stories disappear after 24 hours.');
    }
  }

  // Open a link found in a message. Laybell links route inside the app; anything
  // else opens externally.
  function openLink(url: string) {
    const path = internalPathFromUrl(url);
    if (path) router.push(path as any);
    else Linking.openURL(url).catch(() => {});
  }

  // Render a message body with any URLs as tappable links. Laybell post links
  // show as a friendly "View post" instead of the raw URL.
  function renderBody(body: string, isOwn: boolean, time: string) {
    const parts = body.split(/(laybell:\/\/\S+|https?:\/\/\S+)/g);
    return (
      <Text style={styles.bubbleText}>
        {parts.map((part, i) => {
          if (!part) return null;
          if (part.startsWith('laybell://') || /^https?:\/\//.test(part)) {
            const path = internalPathFromUrl(part);
            const label = path?.startsWith('/post/') ? 'View post' : part;
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
        {/* Time flows inline after the text, hugging the trailing edge — no
            cramped second line. The spacer keeps it off the last word. */}
        <Text style={[styles.inlineTime, !isOwn && styles.inlineTimeOther]}>{`   ${time}`}</Text>
      </Text>
    );
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
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
            <Text style={styles.headerUsername} numberOfLines={1}>@{otherUser?.username}</Text>
          </View>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        contentContainerStyle={[styles.messagesList, { paddingBottom: insets.bottom + 76 }]}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Start a conversation with {otherUser?.display_name}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isOwn = item.sender_id === currentUserId;
          // A story reply renders as its stillshot + the text underneath.
          const storyRef = parseStoryReply(item.body);
          if (storyRef) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <Text style={styles.storyReplyLabel}>
                  {isOwn ? 'You replied to their story' : 'Replied to your story'}
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
                      colors={GRADIENTS.primary}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={[styles.bubble, styles.bubbleOwn, styles.storyReplyBubble]}
                    >
                      {renderBody(storyRef.text, isOwn, formatTime(item.created_at))}
                    </LinearGradient>
                  ) : (
                    <View style={[styles.bubble, styles.bubbleOther, styles.storyReplyBubble]}>
                      {renderBody(storyRef.text, isOwn, formatTime(item.created_at))}
                    </View>
                  )
                ) : (
                  <Text style={styles.cardTime}>{formatTime(item.created_at)}</Text>
                )}
              </View>
            );
          }
          const postId = sharedPostId(item.body);
          // A shared post renders as a standalone preview card (no chat bubble).
          if (postId) {
            return (
              <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
                <SharedPostCard postId={postId} />
                <Text style={styles.cardTime}>{formatTime(item.created_at)}</Text>
              </View>
            );
          }
          return (
            <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
              {isOwn ? (
                <LinearGradient
                  colors={GRADIENTS.primary}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.bubble, styles.bubbleOwn]}
                >
                  {renderBody(item.body, isOwn, formatTime(item.created_at))}
                </LinearGradient>
              ) : (
                <View style={[styles.bubble, styles.bubbleOther]}>
                  {renderBody(item.body, isOwn, formatTime(item.created_at))}
                </View>
              )}
            </View>
          );
        }}
      />

      <Animated.View style={[styles.inputBarWrap, { transform: [{ translateY: kbShift }] }]}>
      <BlurView
        intensity={70}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        // Above the keyboard the home-indicator inset is irrelevant — use the
        // slim padding so the bar hugs the keyboard like iMessage.
        style={[styles.inputBar, { paddingBottom: kbUp ? SPACING.sm + 2 : Math.max(insets.bottom, SPACING.sm) + SPACING.sm }]}
      >
        <TextInput
          style={styles.input}
          placeholder="Message..."
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
          <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.sendBtn}>
            {sending
              ? <ActivityIndicator color={colors.text} size="small" />
              : <Ionicons name="arrow-up" size={20} color={colors.text} />
            }
          </LinearGradient>
        </TouchableOpacity>
      </BlurView>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
  bubble: { maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 22 },
  bubbleOwn: {
    borderBottomRightRadius: 7,
    shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  bubbleOther: {
    backgroundColor: colors.surfaceElevated, borderBottomLeftRadius: 7,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  bubbleText: { color: colors.text, fontSize: 16, lineHeight: 22, letterSpacing: 0.1 },
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
    // A whisper of a seam — the blur itself does the separating.
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.07)',
    backgroundColor: 'rgba(9,9,9,0.55)',
    overflow: 'hidden',
  },
  // Quiet glass pill: low-key fill, hairline border, true 44pt height.
  input: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 22, minHeight: 44, paddingHorizontal: SPACING.md + 2,
    paddingVertical: 11, color: colors.text, fontSize: 16, lineHeight: 21, maxHeight: 120,
  },
  // Flat solid circle — no glow/elevation (the halo read as Android Material).
  sendBtn: {
    width: 44, height: 44, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.35 },
});
