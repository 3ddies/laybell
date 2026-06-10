import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';
import { GENRES } from '../../lib/genres';
import { getActiveMentionQuery, applyMention } from '../../lib/mentions';
import MentionSuggestions from '../../components/MentionSuggestions';

export default function EditPostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<string>('');
  const [caption, setCaption] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [genre, setGenre] = useState<string | null>(null); // display label or null

  useEffect(() => { load(); }, [id]);

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: post } = await supabase
      .from('posts')
      .select('user_id, type, caption, is_public, genre')
      .eq('id', id).single();

    if (!post) { Alert.alert('Not found', 'This post no longer exists.'); router.back(); return; }
    if (!user || post.user_id !== user.id) {
      Alert.alert('Not allowed', 'You can only edit your own posts.'); router.back(); return;
    }

    setType(post.type);
    setCaption(post.caption ?? '');
    setIsPublic(post.is_public ?? true);
    // Stored lowercase — map back to the canonical display label.
    setGenre(post.genre ? (GENRES.find(g => g.toLowerCase() === post.genre) ?? null) : null);
    setLoading(false);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    const { error } = await supabase
      .from('posts')
      .update({
        caption: caption.trim(),
        is_public: isPublic,
        ...(genre ? { genre: genre.toLowerCase() } : {}),
      })
      .eq('id', id);
    setSaving(false);
    if (error) { Alert.alert('Error', error.message); return; }
    router.back();
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={24} color={COLORS.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit post</Text>
        <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}>
          {saving
            ? <ActivityIndicator color={COLORS.text} size="small" />
            : <Text style={styles.saveBtnText}>Save</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Caption */}
        <Text style={styles.label}>Caption</Text>
        <TextInput
          style={styles.captionInput}
          value={caption}
          onChangeText={setCaption}
          placeholder="Write a caption…"
          placeholderTextColor={COLORS.textTertiary}
          multiline
          maxLength={500}
        />
        <MentionSuggestions
          query={getActiveMentionQuery(caption, caption.length)}
          onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
          style={{ marginTop: SPACING.xs }}
        />

        {/* Visibility */}
        <Text style={styles.label}>Visibility</Text>
        <View style={styles.row}>
          {([
            { val: true,  label: 'Public',       icon: 'earth' },
            { val: false, label: 'Friends only', icon: 'people' },
          ] as const).map(({ val, label, icon }) => {
            const on = isPublic === val;
            return (
              <TouchableOpacity
                key={label}
                style={[styles.choice, on && styles.choiceActive]}
                onPress={() => setIsPublic(val)}
              >
                <Ionicons name={icon as any} size={15} color={on ? COLORS.text : COLORS.textSecondary} />
                <Text style={[styles.choiceText, on && styles.choiceTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Genre (audio only) */}
        {type === 'audio' && (
          <>
            <Text style={styles.label}>Genre</Text>
            <View style={styles.pillsWrap}>
              {GENRES.map(g => {
                const on = genre === g;
                return (
                  <TouchableOpacity
                    key={g}
                    style={[styles.pill, on && styles.pillActive]}
                    onPress={() => setGenre(on ? null : g)}
                  >
                    <Text style={[styles.pillText, on && styles.pillTextActive]}>{g}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm, width: 60 },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700' },
  saveBtn: {
    width: 60, alignItems: 'flex-end', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs,
  },
  saveBtnText: { color: COLORS.primary, fontSize: 16, fontWeight: '700' },

  content: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.xxl },
  label: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '700', marginTop: SPACING.md },
  captionInput: {
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, padding: SPACING.md, color: COLORS.text, fontSize: 15,
    minHeight: 90, textAlignVertical: 'top',
  },

  row: { flexDirection: 'row', gap: SPACING.sm },
  choice: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: SPACING.sm + 2, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceLight,
  },
  choiceActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  choiceText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },
  choiceTextActive: { color: COLORS.text, fontWeight: '700' },

  pillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  pill: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: COLORS.border,
  },
  pillActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  pillText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  pillTextActive: { color: COLORS.text, fontWeight: '700' },
});
