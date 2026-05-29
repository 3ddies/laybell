import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type PostType = 'image' | 'video' | 'audio';

export default function PostScreen() {
  const [postType, setPostType] = useState<PostType>('image');
  const [caption, setCaption] = useState('');
  const [genre, setGenre] = useState('');
  const [file, setFile] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function pickMedia() {
    setFile(null);
    setError('');

    if (postType === 'audio') {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets[0]) {
        setFile(result.assets[0]);
      }
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: postType === 'video'
        ? ImagePicker.MediaTypeOptions.Videos
        : ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      setFile(result.assets[0]);
    }
  }

  async function handlePost() {
    if (!file) {
      setError('Please select a file first');
      return;
    }
    if (!caption.trim()) {
      setError('Please add a caption');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Build file path
      const fileExt = file.name
        ? file.name.split('.').pop()
        : file.uri.split('.').pop();
      const filePath = `${user.id}/${Date.now()}.${fileExt}`;

      // Fetch file as blob
      // Upload to Supabase Storage
const formData = new FormData();
formData.append('file', {
  uri: file.uri,
  name: `${Date.now()}.${fileExt}`,
  type: file.mimeType || 'image/jpeg',
} as any);

const { error: uploadError } = await supabase.storage
  .from('posts')
  .upload(filePath, formData, {
    contentType: file.mimeType || 'image/jpeg',
    upsert: false,
  });

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('posts')
        .getPublicUrl(filePath);

      // Save post to database
      const { error: postError } = await supabase
        .from('posts')
        .insert({
          user_id: user.id,
          type: postType,
          media_url: publicUrl,
          caption: caption.trim(),
          is_public: true,
        });

      if (postError) throw postError;

      // Save genre tag if provided
      if (genre.trim()) {
  const { data: postData } = await supabase
    .from('posts')
    .select('id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (postData && postData[0]) {
    await supabase.from('post_tags').insert({
      post_id: postData[0].id,
      tag: genre.trim().toLowerCase(),
      genre: genre.trim().toLowerCase(),
    });
  }
}

      Alert.alert('Posted!', 'Your post is now live on Laybell 🎉');
      setFile(null);
      setCaption('');
      setGenre('');

    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    }

    setLoading(false);
  }

  const postTypes: { label: string; value: PostType; emoji: string }[] = [
    { label: 'Image', value: 'image', emoji: '🖼️' },
    { label: 'Audio', value: 'audio', emoji: '🎵' },
    { label: 'Video', value: 'video', emoji: '🎬' },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.inner}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>New Post</Text>

      {/* Post Type Selector */}
      <View style={styles.typeSelector}>
        {postTypes.map((type) => (
          <TouchableOpacity
            key={type.value}
            style={[
              styles.typeButton,
              postType === type.value && styles.typeButtonActive,
            ]}
            onPress={() => {
              setPostType(type.value);
              setFile(null);
            }}
          >
            <Text style={styles.typeEmoji}>{type.emoji}</Text>
            <Text style={[
              styles.typeLabel,
              postType === type.value && styles.typeLabelActive,
            ]}>
              {type.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* File Picker */}
      <TouchableOpacity style={styles.filePicker} onPress={pickMedia}>
        {file ? (
          <View style={styles.fileSelected}>
            <Text style={styles.fileSelectedIcon}>✅</Text>
            <Text style={styles.fileSelectedText} numberOfLines={1}>
              {file.name || file.uri.split('/').pop()}
            </Text>
          </View>
        ) : (
          <View style={styles.filePlaceholder}>
            <Text style={styles.filePlaceholderIcon}>
              {postType === 'image' ? '🖼️' : postType === 'audio' ? '🎵' : '🎬'}
            </Text>
            <Text style={styles.filePlaceholderText}>
              Tap to select {postType}
            </Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Caption */}
      <TextInput
        style={styles.captionInput}
        placeholder="Write a caption..."
        placeholderTextColor={COLORS.textTertiary}
        value={caption}
        onChangeText={setCaption}
        multiline
        maxLength={500}
      />

      {/* Genre Tag */}
      <TextInput
        style={styles.genreInput}
        placeholder="Genre tag (e.g. rap, r&b, pop)"
        placeholderTextColor={COLORS.textTertiary}
        value={genre}
        onChangeText={setGenre}
        autoCapitalize="none"
      />

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {/* Post Button */}
      <TouchableOpacity
        style={[styles.postButton, loading && styles.postButtonDisabled]}
        onPress={handlePost}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={COLORS.text} />
        ) : (
          <Text style={styles.postButtonText}>Post to Laybell</Text>
        )}
      </TouchableOpacity>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  inner: {
    padding: SPACING.lg,
    paddingTop: SPACING.xxl + SPACING.lg,
    gap: SPACING.md,
  },
  title: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: SPACING.sm,
  },
  typeSelector: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  typeButton: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    gap: SPACING.xs,
  },
  typeButtonActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary + '22',
  },
  typeEmoji: {
    fontSize: 22,
  },
  typeLabel: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  typeLabelActive: {
    color: COLORS.primary,
    fontWeight: '700',
  },
  filePicker: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    borderStyle: 'dashed',
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filePlaceholder: {
    alignItems: 'center',
    gap: SPACING.sm,
  },
  filePlaceholderIcon: {
    fontSize: 36,
  },
  filePlaceholderText: {
    color: COLORS.textTertiary,
    fontSize: 14,
  },
  fileSelected: {
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  fileSelectedIcon: {
    fontSize: 32,
  },
  fileSelectedText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  captionInput: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    color: COLORS.text,
    fontSize: 15,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  genreInput: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    color: COLORS.text,
    fontSize: 15,
  },
  errorText: {
    color: COLORS.error,
    fontSize: 13,
    textAlign: 'center',
  },
  postButton: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  postButtonDisabled: {
    opacity: 0.6,
  },
  postButtonText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
});