import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, ActivityIndicator, Alert, Switch, Image, Dimensions,
} from 'react-native';
import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { usePagerSwiping } from '../../contexts/PagerContext';
import { Audio, Video, ResizeMode } from 'expo-av';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../../lib/supabase';
import { useAudio } from '../../contexts/AudioContext';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import { IMAGE_FORMATS, VIDEO_FORMATS, aspectToArray, aspectToNumber, defaultFormatFor } from '../../lib/aspectRatio';
import { GENRES } from '../../lib/genres';

type PostType = 'image' | 'video' | 'audio';

const SCREEN_W = Dimensions.get('window').width;
const PREVIEW_MAX_H = 380; // cap tall (9:16) previews so the form stays usable

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
  const [format, setFormat] = useState<string>('1:1');
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  // Audio sub-category. 'audio' = music (stored as type 'audio'); the others are
  // stored as their own post type so they surface under the Podcasts/Audiobooks tabs.
  const [audioKind, setAudioKind] = useState<'audio' | 'podcast' | 'audiobook'>('audio');
  const { stop } = useAudio();
  const swiping = usePagerSwiping();

  // Stop any playing track when the create-post tab is opened.
  useFocusEffect(useCallback(() => { stop(); }, []));

  async function pickCover() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [1, 1], quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) setCoverUri(result.assets[0].uri);
  }

  async function pickMedia() {
    setFile(null); setError(''); setThumbnailUri(null);
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
      aspect: aspectToArray(format),
    });
    if (!result.canceled && result.assets[0]) {
      setFile(result.assets[0]);
      if (postType === 'video') {
        // Grab a frame ~1s in to use as the grid thumbnail
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(result.assets[0].uri, { time: 1000 });
          setThumbnailUri(uri);
        } catch {}
      }
    }
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

      // Upload the generated video thumbnail (if any)
      let thumbnailUrl: string | null = null;
      if (postType === 'video' && thumbnailUri) {
        const thumbPath = `${user.id}/${Date.now()}_thumb.jpg`;
        const thumbForm = new FormData();
        thumbForm.append('file', { uri: thumbnailUri, name: `${Date.now()}_thumb.jpg`, type: 'image/jpeg' } as any);
        const { error: thumbErr } = await supabase.storage.from('posts').upload(thumbPath, thumbForm, {
          contentType: 'image/jpeg', upsert: false,
        });
        if (!thumbErr) thumbnailUrl = supabase.storage.from('posts').getPublicUrl(thumbPath).data.publicUrl;
      }

      // Upload cover art for audio posts (if any)
      let coverUrl: string | null = null;
      if (postType === 'audio' && coverUri) {
        const coverPath = `${user.id}/${Date.now()}_cover.jpg`;
        const coverForm = new FormData();
        coverForm.append('file', { uri: coverUri, name: `${Date.now()}_cover.jpg`, type: 'image/jpeg' } as any);
        const { error: coverErr } = await supabase.storage.from('posts').upload(coverPath, coverForm, {
          contentType: 'image/jpeg', upsert: false,
        });
        if (!coverErr) coverUrl = supabase.storage.from('posts').getPublicUrl(coverPath).data.publicUrl;
      }

      const { error: postError } = await supabase.from('posts').insert({
        user_id: user.id, type: postType === 'audio' ? audioKind : postType, media_url: publicUrl,
        caption: caption.trim(), is_public: isPublic,
        ...(genre ? { genre } : {}),
        ...(audioDuration !== null ? { duration_seconds: audioDuration } : {}),
        ...(postType !== 'audio' ? { aspect_ratio: format } : {}),
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        ...(coverUrl ? { cover_url: coverUrl } : {}),
      });
      if (postError) throw postError;

      Alert.alert('Posted! 🎉', 'Your post is now live on Laybell');
      setFile(null); setCaption(''); setGenre(''); setThumbnailUri(null); setCoverUri(null); setAudioKind('audio');
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    }
    setLoading(false);
  }

  // Live preview dimensions for the selected format — shows the user the exact
  // frame their post will occupy (and reveals letterboxing if the crop doesn't
  // match, so they can re-crop before posting).
  const previewAspect = aspectToNumber(format, 1);
  const previewMaxW = SCREEN_W - SPACING.md * 2;
  const previewH = Math.min(previewMaxW / previewAspect, PREVIEW_MAX_H);
  const previewW = previewH * previewAspect;

  // Music genres apply to music + image/video, but not to podcasts/audiobooks.
  const showGenre = postType !== 'audio' || audioKind === 'audio';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
      {/* Header — Instagram-style: title left, Share action top-right */}
      <View style={styles.headerBar}>
        <Text style={styles.title}>New post</Text>
        <TouchableOpacity
          style={[styles.shareBtn, loading && styles.postBtnDisabled]}
          onPress={handlePost}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color={COLORS.text} size="small" />
            : <Text style={styles.shareBtnText}>Share</Text>}
        </TouchableOpacity>
      </View>

      {/* Type selector */}
      <View style={styles.typeRow}>
        {POST_TYPES.map(type => {
          const active = postType === type.value;
          return (
            <TouchableOpacity
              key={type.value}
              style={[styles.typeBtn, active && styles.typeBtnActive]}
              onPress={() => { setPostType(type.value); setFile(null); setFormat(defaultFormatFor(type.value)); setAudioKind('audio'); }}
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

      {/* Media picker + live preview */}
      {!file ? (
        <TouchableOpacity style={styles.filePicker} onPress={pickMedia}>
          <View style={styles.filePlaceholder}>
            <Ionicons
              name={postType === 'image' ? 'image-outline' : postType === 'audio' ? 'musical-notes-outline' : 'videocam-outline'}
              size={40}
              color={COLORS.textTertiary}
            />
            <Text style={styles.filePlaceholderText}>Tap to select {postType}</Text>
          </View>
        </TouchableOpacity>
      ) : postType === 'audio' ? (
        <TouchableOpacity style={styles.filePicker} onPress={pickMedia}>
          <View style={styles.fileSelected}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.fileIconWrap}>
              <Ionicons name="checkmark" size={28} color={COLORS.text} />
            </LinearGradient>
            <Text style={styles.fileName} numberOfLines={1}>
              {file.name || file.uri.split('/').pop()}
            </Text>
            <Text style={styles.fileChange}>Tap to change</Text>
          </View>
        </TouchableOpacity>
      ) : (
        // Image / video preview at the exact selected dimensions.
        <View style={styles.previewWrap}>
          <View style={[styles.previewBox, { width: previewW, height: previewH }]}>
            {postType === 'video' ? (
              <Video
                source={{ uri: file.uri }}
                style={styles.previewMedia}
                resizeMode={ResizeMode.CONTAIN}
                useNativeControls
                isLooping
              />
            ) : (
              <Image source={{ uri: file.uri }} style={styles.previewMedia} resizeMode="contain" />
            )}
            <View style={styles.previewBadge}>
              <Text style={styles.previewBadgeText}>{format}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.adjustBtn} onPress={pickMedia}>
            <Ionicons name="crop-outline" size={16} color={COLORS.primary} />
            <Text style={styles.adjustBtnText}>Adjust / re-crop</Text>
          </TouchableOpacity>
          <Text style={styles.previewHint}>
            This is exactly how your {postType} will appear at {format}. Pick a different
            format below, or re-crop to fill the frame.
          </Text>
        </View>
      )}

      {/* Caption — Instagram-style, directly under the media */}
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Caption</Text>
        <TextInput
          style={styles.textArea}
          placeholder="Write a caption..."
          placeholderTextColor={COLORS.textTertiary}
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={500}
          editable={!swiping}
        />
      </View>

      {/* Audio category (Music / Podcast / Audiobook) */}
      {postType === 'audio' && (
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Category</Text>
          <View style={styles.formatRow}>
            {([
              { val: 'audio',     label: 'Music',     icon: 'musical-notes' },
              { val: 'podcast',   label: 'Podcast',   icon: 'mic'           },
              { val: 'audiobook', label: 'Audiobook', icon: 'book'          },
            ] as const).map(({ val, label, icon }) => {
              const active = audioKind === val;
              return (
                <TouchableOpacity
                  key={val}
                  style={[styles.formatBtn, active && styles.formatBtnActive]}
                  onPress={() => setAudioKind(val)}
                >
                  <Ionicons name={icon as any} size={16} color={active ? COLORS.primary : COLORS.textSecondary} />
                  <Text style={[styles.formatLabel, active && styles.formatLabelActive]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Cover art (audio only) */}
      {postType === 'audio' && (
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Cover Art</Text>
          <TouchableOpacity style={styles.coverPicker} onPress={pickCover}>
            {coverUri ? (
              <Image source={{ uri: coverUri }} style={styles.coverPreview} />
            ) : (
              <View style={styles.coverPlaceholder}>
                <Ionicons name="image-outline" size={24} color={COLORS.textTertiary} />
              </View>
            )}
            <View style={styles.coverInfo}>
              <Text style={styles.coverTitle}>{coverUri ? 'Cover selected' : 'Add cover art'}</Text>
              <Text style={styles.coverSub}>{coverUri ? 'Tap to change or re-crop' : 'Square image shown next to your track'}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Format selector (image / video only) */}
      {postType !== 'audio' && (
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Format</Text>
          <View style={styles.formatRow}>
            {(postType === 'video' ? VIDEO_FORMATS : IMAGE_FORMATS).map(f => {
              const active = format === f;
              return (
                <TouchableOpacity
                  key={f}
                  style={[styles.formatBtn, active && styles.formatBtnActive]}
                  onPress={() => setFormat(f)}
                >
                  <Ionicons
                    name={f === '1:1' ? 'square-outline' : f === '16:9' ? 'tablet-landscape-outline' : 'tablet-portrait-outline'}
                    size={18}
                    color={active ? COLORS.primary : COLORS.textSecondary}
                  />
                  <Text style={[styles.formatLabel, active && styles.formatLabelActive]}>{f}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Genre (music genres — hidden for podcasts/audiobooks) */}
      {showGenre && (
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Genre</Text>
          <View style={styles.genreWrap}>
            {GENRES.map(g => {
              const value = g.toLowerCase();
              const active = genre === value;
              return (
                <TouchableOpacity
                  key={g}
                  style={[styles.genreChip, active && styles.genreChipActive]}
                  onPress={() => setGenre(active ? '' : value)}
                >
                  <Text style={[styles.genreChipText, active && styles.genreChipTextActive]}>{g}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  inner: { padding: SPACING.md, paddingTop: SPACING.xxl + SPACING.lg, gap: SPACING.md },

  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  title: { color: COLORS.text, fontSize: 28, fontWeight: '800' },
  shareBtn: {
    backgroundColor: COLORS.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.xs + 3, paddingHorizontal: SPACING.lg,
    minWidth: 84, alignItems: 'center', justifyContent: 'center',
  },
  shareBtnText: { color: COLORS.text, fontSize: 15, fontWeight: '700' },

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

  previewWrap: { alignItems: 'center', gap: SPACING.sm },
  previewBox: {
    borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1, borderColor: COLORS.border, alignSelf: 'center',
  },
  previewMedia: { width: '100%', height: '100%' },
  previewBadge: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 2,
  },
  previewBadgeText: { color: COLORS.text, fontSize: 11, fontWeight: '700' },
  adjustBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: COLORS.primary,
  },
  adjustBtnText: { color: COLORS.primary, fontSize: 13, fontWeight: '700' },
  previewHint: { color: COLORS.textTertiary, fontSize: 12, textAlign: 'center', paddingHorizontal: SPACING.md },

  formatRow: { flexDirection: 'row', gap: SPACING.sm },

  genreWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genreChip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full, backgroundColor: COLORS.surfaceLight,
    borderWidth: 1, borderColor: COLORS.border,
  },
  genreChipActive: { backgroundColor: COLORS.primary + '22', borderColor: COLORS.primary },
  genreChipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  genreChipTextActive: { color: COLORS.primary },

  coverPicker: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  coverPreview: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceElevated },
  coverPlaceholder: {
    width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceElevated,
    alignItems: 'center', justifyContent: 'center',
  },
  coverInfo: { flex: 1 },
  coverTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  coverSub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  formatBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.xs,
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingVertical: SPACING.sm + 2,
  },
  formatBtnActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '11' },
  formatLabel: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },
  formatLabelActive: { color: COLORS.primary },

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
