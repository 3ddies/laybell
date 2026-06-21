import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { GENRES, genreLabel } from '../../lib/genres';
import { getActiveMentionQuery, applyMention } from '../../lib/mentions';
import MentionSuggestions from '../../components/MentionSuggestions';

export default function EditPostScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
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

    if (!post) { Alert.alert(t('editPost.notFoundTitle'), t('editPost.notFoundBody')); router.back(); return; }
    if (!user || post.user_id !== user.id) {
      Alert.alert(t('editPost.notAllowedTitle'), t('editPost.notAllowedBody')); router.back(); return;
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
    if (error) { Alert.alert(t('editPost.errorTitle'), error.message); return; }
    router.back();
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('editPost.title')}</Text>
        <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}>
          {saving
            ? <ActivityIndicator color={colors.text} size="small" />
            : <Text style={styles.saveBtnText}>{t('editProfile.save')}</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Caption */}
        <Text style={styles.label}>{t('editPost.caption')}</Text>
        <TextInput
          style={styles.captionInput}
          value={caption}
          onChangeText={setCaption}
          placeholder={t('post.captionPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={500}
        />
        <MentionSuggestions
          query={getActiveMentionQuery(caption, caption.length)}
          onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
          style={{ marginTop: SPACING.xs }}
        />

        {/* Visibility */}
        <Text style={styles.label}>{t('editPost.visibility')}</Text>
        <View style={styles.row}>
          {([
            { val: true,  label: t('post.public'),       icon: 'earth' },
            { val: false, label: t('post.friendsOnly'),  icon: 'people' },
          ] as const).map(({ val, label, icon }) => {
            const on = isPublic === val;
            return (
              <TouchableOpacity
                key={String(val)}
                style={[styles.choice, on && styles.choiceActive]}
                onPress={() => setIsPublic(val)}
              >
                <Ionicons name={icon as any} size={15} color={on ? colors.text : colors.textSecondary} />
                <Text style={[styles.choiceText, on && styles.choiceTextActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Genre (audio only) */}
        {type === 'audio' && (
          <>
            <Text style={styles.label}>{t('post.genre')}</Text>
            <View style={styles.pillsWrap}>
              {GENRES.map(g => {
                const on = genre === g;
                return (
                  <TouchableOpacity
                    key={g}
                    style={[styles.pill, on && styles.pillActive]}
                    onPress={() => setGenre(on ? null : g)}
                  >
                    <Text style={[styles.pillText, on && styles.pillTextActive]}>{genreLabel(g)}</Text>
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

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { padding: SPACING.sm, width: 60 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  saveBtn: {
    width: 60, alignItems: 'flex-end', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs,
  },
  saveBtnText: { color: colors.primary, fontSize: 16, fontWeight: '700' },

  content: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.xxl },
  label: { color: colors.textSecondary, fontSize: 13, fontWeight: '700', marginTop: SPACING.md },
  captionInput: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.md, color: colors.text, fontSize: 15,
    minHeight: 90, textAlignVertical: 'top',
  },

  row: { flexDirection: 'row', gap: SPACING.sm },
  choice: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: SPACING.sm + 2, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceLight,
  },
  choiceActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  choiceTextActive: { color: colors.text, fontWeight: '700' },

  pillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  pill: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  pillTextActive: { color: colors.text, fontWeight: '700' },
});
