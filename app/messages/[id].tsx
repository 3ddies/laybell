import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';
import { createNotification } from '../../lib/createNotification';

type Message = { id: string; body: string; sender_id: string; receiver_id: string; created_at: string };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [otherUser, setOtherUser] = useState<any>(null);

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
    const { data: profile } = await supabase.from('profiles').select('username, display_name').eq('id', id).single();
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

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{otherUser?.display_name}</Text>
          <Text style={styles.headerUsername}>@{otherUser?.username}</Text>
        </View>
      </View>

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.messagesList}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Start a conversation with {otherUser?.display_name}</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isOwn = item.sender_id === currentUserId;
          return (
            <View style={[styles.bubbleWrap, isOwn ? styles.bubbleWrapOwn : styles.bubbleWrapOther]}>
              <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
                <Text style={styles.bubbleText}>{item.body}</Text>
                <Text style={[styles.bubbleTime, !isOwn && styles.bubbleTimeOther]}>{formatTime(item.created_at)}</Text>
              </View>
            </View>
          );
        }}
      />

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          placeholder="Message..."
          placeholderTextColor={COLORS.textTertiary}
          value={newMessage}
          onChangeText={setNewMessage}
          multiline
          maxLength={500}
        />
        <TouchableOpacity
          style={[styles.sendBtn, !newMessage.trim() && styles.sendBtnDisabled]}
          onPress={sendMessage}
          disabled={!newMessage.trim() || sending}
        >
          {sending
            ? <ActivityIndicator color={COLORS.text} size="small" />
            : <Ionicons name="arrow-up" size={20} color={COLORS.text} />
          }
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border, gap: SPACING.sm,
  },
  backBtn: { padding: SPACING.sm },
  headerInfo: { flex: 1 },
  headerName: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  headerUsername: { color: COLORS.textSecondary, fontSize: 13 },

  messagesList: { padding: SPACING.md, gap: SPACING.xs, flexGrow: 1 },

  bubbleWrap: { marginBottom: SPACING.xs },
  bubbleWrapOwn: { alignItems: 'flex-end' },
  bubbleWrapOther: { alignItems: 'flex-start' },
  bubble: { maxWidth: '75%', padding: SPACING.sm + 2, borderRadius: RADIUS.lg },
  bubbleOwn: { backgroundColor: COLORS.primary, borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: COLORS.surfaceElevated, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: COLORS.border },
  bubbleText: { color: COLORS.text, fontSize: 15, lineHeight: 21 },
  bubbleTime: { fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 3, alignSelf: 'flex-end' },
  bubbleTimeOther: { color: COLORS.textTertiary },

  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: SPACING.xxl },
  emptyText: { color: COLORS.textTertiary, fontSize: 14, textAlign: 'center' },

  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    padding: SPACING.md, borderTopWidth: 0.5, borderTopColor: COLORS.border, gap: SPACING.sm,
  },
  input: {
    flex: 1, backgroundColor: COLORS.surfaceLight,
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2, color: COLORS.text, fontSize: 15, maxHeight: 100,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.35 },
});
