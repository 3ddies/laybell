import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useEffect, useState, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type Message = {
  id: string;
  body: string;
  sender_id: string;
  receiver_id: string;
  created_at: string;
};

export default function ChatScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [otherUser, setOtherUser] = useState<any>(null);

  useEffect(() => {
    setup();
  }, [id]);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      await fetchMessages(user.id);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('username, display_name')
      .eq('id', id)
      .single();

    if (profile) setOtherUser(profile);
    setLoading(false);
  }

  async function fetchMessages(userId: string) {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .or(
        `and(sender_id.eq.${userId},receiver_id.eq.${id}),and(sender_id.eq.${id},receiver_id.eq.${userId})`
      )
      .order('created_at', { ascending: true });

    if (data) setMessages(data);
  }

  async function sendMessage() {
    if (!newMessage.trim() || !currentUserId || sending) return;
    setSending(true);

    const messageBody = newMessage.trim();
    setNewMessage('');

    const { data, error } = await supabase
      .from('messages')
      .insert({
        sender_id: currentUserId,
        receiver_id: id,
        body: messageBody,
      })
      .select()
      .single();

    if (!error && data) {
      setMessages(prev => [...prev, data]);
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }

    setSending(false);
  }

  function timeAgo(dateString: string) {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backBtn}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{otherUser?.display_name}</Text>
          <Text style={styles.headerUsername}>
            {'@'}{otherUser?.username}
          </Text>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messagesList}
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: false })
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              Start a conversation with {otherUser?.display_name}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isOwn = item.sender_id === currentUserId;
          return (
            <View style={[
              styles.messageBubble,
              isOwn ? styles.ownBubble : styles.otherBubble,
            ]}>
              <Text style={[
                styles.messageText,
                isOwn ? styles.ownText : styles.otherText,
              ]}>
                {item.body}
              </Text>
              <Text style={styles.messageTime}>
                {timeAgo(item.created_at)}
              </Text>
            </View>
          );
        }}
      />

      {/* Input */}
      <View style={styles.inputContainer}>
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
          {sending ? (
            <ActivityIndicator color={COLORS.text} size="small" />
          ) : (
            <Text style={styles.sendBtnText}>↑</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.border,
    gap: SPACING.md,
  },
  backBtn: {
    color: COLORS.primary,
    fontSize: 28,
    fontWeight: '600',
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  headerUsername: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  messagesList: {
    padding: SPACING.md,
    gap: SPACING.sm,
    flexGrow: 1,
  },
  messageBubble: {
    maxWidth: '75%',
    padding: SPACING.sm,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.xs,
  },
  ownBubble: {
    backgroundColor: COLORS.primary,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  otherBubble: {
    backgroundColor: COLORS.surface,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  ownText: {
    color: COLORS.text,
  },
  otherText: {
    color: COLORS.text,
  },
  messageTime: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 2,
    alignSelf: 'flex-end',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: SPACING.xxl,
  },
  emptyText: {
    color: COLORS.textTertiary,
    fontSize: 14,
    textAlign: 'center',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: SPACING.md,
    borderTopWidth: 0.5,
    borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    color: COLORS.text,
    fontSize: 15,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendBtnText: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
  },
});