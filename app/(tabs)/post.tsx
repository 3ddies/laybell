import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, ActivityIndicator, Alert, Switch,
} from 'react-native';
import { useState } from 'react';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';

type PostType = 'image' | 'video' | 'audio';

const POST_TYPES: { label: string; value: PostType; icon: any }[] = [
  { label: 'Image', value: 'image', icon: 'image-outline' },
  { label: 'Audio', value: 'audio', icon: 'musical-notes-outline' },
  { label: 'Video', value: 'video', icon: 'videocam-outline' },
];

export default function PostScreen() {
  const [postType, setPostType] = useState<PostType>('image');
  const [caption, setCaption] = useState('');
  const [genre, setGenre] = useState('');
  const [file, setFile] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);

  async function pickMedia() {
    setFile(null); setError('');
    if (postType === 'audio') {
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
      if (!result.canceled && result.assets[0]) {
        setFile(result.assets[0]);
        try {
          const { sound, status } = await Audio.Sound.createAsync({ uri: result.assets[0].uri });
          if ((status as any).isLoaded && (status as any).durationMillis) {
            setAudioDuration(Math.floor((status as any).durationMillis / 1000));
          }
          await sound.unloadAsync();
        } catch {}
      }
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: postType === 'video' ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) setFile(result.assets[0]);
  }

  async function handlePost() {
    if (!file) { setError('Please select a file first'); return; }
    if (!caption.trim()) { setError('Please add a caption'); return; }
    setLoading(true); setError('');

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const fileExt = file.name ? file.name.split('.').pop() : file.uri.split('.').pop();
      const filePath = `${user.id}/${Date.now()}.${fileExt}`;

      const formData = new FormData();
      formData.append('file', { uri: file.uri, name: `${Date.now()}.${fileExt}`, type: file.mimeType || 'image/jpeg' } as any);

      const { error: uploadError } = await supabase.storage.from('posts').upload(filePath, formData, {
        contentType: file.mimeType || 'image/jpeg', upsert: false,
      });
      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage.from('posts').getPublicUrl(filePath);

      const { error: postError } = await supabase.from('posts').insert({
        user_id: user.id, type: postType, media_url: publicUrl,
        caption: caption.trim(), is_public: isPublic,
        ...(audioDuration !== null ? { duration_seconds: audioDuration } : {}),
      });
      if (postError) throw postError;

      if (genre.trim()) {
        const { data: postData } = await supabase.from('posts').select('id').eq('user_id', user.id).order('created_at', { ascending: false }).limit(1);
        if (postData?.[0]) {
          await supabase.from('post_tags').insert({ post_id: postData[0].id, tag: genre.trim().toLowerCase(), genre: genre.trim().toLowerCase() });
        }
      }

      Alert.alert('Posted! 🎉', 'Your post is now live on Laybell');
      setFile(null); setCaption(''); setGenre('');
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    }
    setLoading(false);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>New Post</Text>

      {/* Type selector */}
      <View style={styles.typeRow}>
        {POST_TYPES.map(type => {
          const active = postType === type.value;
          return (
            <TouchableOpacity
              key={type.value}
              style={[styles.typeBtn, active && styles.typeBtnActive]}
              onPress={() => { setPostType(type.value); setFile(null); }}
            >
              {active ? (
                <LinearGradient colors={GRADIENTS.primary} style={styles.typeIconWrap}>
                  <Ionicons name={type.icon} size={22} color={COLORS.text} />
                </LinearGradient>
              ) : (
                <View style={[styles.typeIconWrap, styles.typeIconWrapInactive]}>
                  <Ionicons name={type.icon} size={22} color={COLORS.textSecondary} />
                </View>
              )}
              <Text style={[styles.typeLabel, active && styles.typeLabelActive]}>{type.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* File picker */}
      <TouchableOpacity style={styles.filePicker} onPress={pickMedia}>
        {file ? (
          <View style={styles.fileSelected}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.fileIconWrap}>
              <Ionicons name="checkmark" size={28} color={COLORS.text} />
            </LinearGradient>
            <Text style={styles.fileName} numberOfLines={1}>
              {file.name || file.uri.split('/').pop()}
            </Text>
            <Text style={styles.fileChange}>Tap to change</Text>
          </View>
        ) : (
          <View style={styles.filePlaceholder}>
            <Ionicons
              name={postType === 'image' ? 'image-outline' : postType === 'audio' ? 'musical-notes-outline' : 'videocam-outline'}
              size={40}
              color={COLORS.textTertiary}
            />
            <Text style={styles.filePlaceholderText}>Tap to select {postType}</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Caption */}
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Caption</Text>
        <TextInput
          style={styles.textArea}
          placeholder="What's this about?"
          placeholderTextColor={COLORS.textTertiary}
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={500}
        />
      </View>

      {/* Genre */}
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Genre Tag</Text>
        <TextInput
          style={styles.textInput}
          placeholder="rap, r&b, pop, jazz..."
          placeholderTextColor={COLORS.textTertiary}
          value={genre}
          onChangeText={setGenre}
          autoCapitalize="none"
        />
      </View>

      {/* Visibility */}
      <View style={styles.visibilityRow}>
        <View style={styles.visibilityLeft}>
          <Ionicons
            name={isPublic ? 'globe-outline' : 'lock-closed-outline'}
            size={20} color={COLORS.primary}
          />
          <View>
            <Text style={styles.visibilityLabel}>{isPublic ? 'Public' : 'Followers only'}</Text>
            <Text style={styles.visibilitySub}>
              {isPublic ? 'Anyone on Laybell can see this' : 'Only your followers can see this'}
            </Text>
          </View>
        </View>
        <Switch
          value={isPublic}
          onValueChange={setIsPublic}
          trackColor={{ false: COLORS.border, true: COLORS.primary + '88' }}
          thumbColor={isPublic ? COLORS.primary : COLORS.textTertiary}
        />
      </View>

      {!!error && (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle-outline" size={16} color={COLORS.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.postBtn, loading && styles.postBtnDisabled]}
        onPress={handlePost}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={COLORS.text} />
        ) : (
          <>
            <Ionicons name="cloud-upload-outline" size={20} color={COLORS.text} />
            <Text style={styles.postBtnText}>Post to Laybell</Text>
          </>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  inner: { padding: SPACING.md, paddingTop: SPACING.xxl + SPACING.lg, gap: SPACING.md },

  title: { color: COLORS.text, fontSize: 28, fontWeight: '800', marginBottom: SPACING.xs },

  typeRow: { flexDirection: 'row', gap: SPACING.sm },
  typeBtn: {
    flex: 1, backgroundColor: COLORS.surfaceLight,
    borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingVertical: SPACING.md,
    alignItems: 'center', gap: SPACING.xs,
  },
  typeBtnActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '11' },
  typeIconWrap: { width: 44, height: 44, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  typeIconWrapInactive: { backgroundColor: COLORS.surfaceElevated },
  typeLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  typeLabelActive: { color: COLORS.primary, fontWeight: '700' },

  filePicker: {
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1.5, borderColor: COLORS.border,
    borderStyle: 'dashed', borderRadius: RADIUS.md,
    height: 160, alignItems: 'center', justifyContent: 'center',
  },
  filePlaceholder: { alignItems: 'center', gap: SPACING.sm },
  filePlaceholderText: { color: COLORS.textTertiary, fontSize: 14 },
  fileSelected: { alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md },
  fileIconWrap: { width: 52, height: 52, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  fileName: { color: COLORS.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  fileChange: { color: COLORS.textTertiary, fontSize: 12 },

  inputGroup: { gap: 6 },
  inputLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  textArea: {
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, padding: SPACING.md,
    color: COLORS.text, fontSize: 15, minHeight: 100, textAlignVertical: 'top',
  },
  textInput: {
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 4,
    color: COLORS.text, fontSize: 15,
  },

  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { color: COLORS.error, fontSize: 13 },

  postBtn: {
    backgroundColor: COLORS.primary, borderRadius: RADIUS.md,
    paddingVertical: SPACING.md, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  postBtnDisabled: { opacity: 0.6 },
  postBtnText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },

  visibilityRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, padding: SPACING.md,
  },
  visibilityLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  visibilityLabel: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  visibilitySub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
});
