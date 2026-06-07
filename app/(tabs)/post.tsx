import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, ActivityIndicator, Alert, Switch, Image, Dimensions, Animated,
} from 'react-native';
import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { usePagerSwiping } from '../../contexts/PagerContext';
import { Audio } from 'expo-av';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAudio } from '../../contexts/AudioContext';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import { IMAGE_FORMATS, aspectToNumber, clampFeedAspect, defaultFormatFor } from '../../lib/aspectRatio';
import { GENRES } from '../../lib/genres';
import { Image as ExpoImage } from 'expo-image';
import MediaCropper, { type MediaCropperHandle, type CropRect } from '../../components/MediaCropper';
import PhotoGrid, { type PickedMedia } from '../../components/PhotoGrid';
import ErrorBoundary from '../../components/ErrorBoundary';

type PostType = 'image' | 'video' | 'audio';
type Step = 'pick' | 'details';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const PREVIEW_MAX_H = Math.round(SCREEN_H * 0.46);

// Duration limits (seconds).
const VIDEO_MAX_SEC  = 90;       // 1.5 min
const MUSIC_MAX_SEC  = 6 * 60;   // music tracks
const SPOKEN_MAX_SEC = 35 * 60;  // podcasts / audiobooks

function fmtMins(sec: number) {
  return sec % 60 === 0 ? `${sec / 60} min` : `${Math.round(sec / 60)} min`;
}

const POST_TYPES: { label: string; value: PostType }[] = [
  { label: 'Image', value: 'image' },
  { label: 'Video', value: 'video' },
  { label: 'Audio', value: 'audio' },
];

export default function PostScreen() {
  const [step, setStep] = useState<Step>('pick');
  const [postType, setPostType] = useState<PostType>('image');
  const [format, setFormat] = useState<string>('1:1');

  // image/video selection
  const [media, setMedia] = useState<{ uri: string; width: number; height: number; posterUri?: string } | null>(null);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [videoAspect, setVideoAspect] = useState(0.8); // native aspect for video display
  const cropperRef = useRef<MediaCropperHandle>(null);
  const cropRef = useRef<CropRect | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;

  // audio selection
  const [audioFile, setAudioFile] = useState<any>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [audioKind, setAudioKind] = useState<'audio' | 'podcast' | 'audiobook'>('audio');

  // details
  const [caption, setCaption] = useState('');
  const [genre, setGenre] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { stop } = useAudio();
  const swiping = usePagerSwiping();
  useFocusEffect(useCallback(() => { stop(); }, []));

  // Cropper frame within the preview cap. Videos use their native aspect (clamped
  // to IG bounds) so they fill without being force-cropped; images use the chosen
  // format and are cropped to it interactively.
  const previewAspect = postType === 'video' ? videoAspect : aspectToNumber(format, 1);
  let frameW = SCREEN_W;
  let frameH = SCREEN_W / previewAspect;
  if (frameH > PREVIEW_MAX_H) { frameH = PREVIEW_MAX_H; frameW = PREVIEW_MAX_H * previewAspect; }

  // Collapsing preview — shrinks as the gallery scrolls down so more photos show.
  const fullPreviewH = frameH + SPACING.xs * 2;
  const collapsedPreviewH = 96;
  const animatedPreviewH = scrollY.interpolate({
    inputRange: [0, Math.max(1, fullPreviewH - collapsedPreviewH)],
    outputRange: [fullPreviewH, collapsedPreviewH],
    extrapolate: 'clamp',
  });

  const showGenre = postType !== 'audio' || audioKind === 'audio';
  const hasMedia = postType === 'audio' ? !!audioFile : !!media;

  function resetAll() {
    setMedia(null); setThumbnailUri(null); cropRef.current = null;
    setAudioFile(null); setAudioDuration(null); setCoverUri(null); setAudioKind('audio');
    setCaption(''); setGenre(''); setError(''); setStep('pick');
  }

  function switchType(t: PostType) {
    setPostType(t);
    setFormat(defaultFormatFor(t));
    setMedia(null); setThumbnailUri(null); cropRef.current = null;
    setAudioFile(null); setAudioDuration(null);
  }

  function cycleFormat() {
    const i = IMAGE_FORMATS.indexOf(format as any);
    setFormat(IMAGE_FORMATS[(i + 1) % IMAGE_FORMATS.length]);
  }

  async function onPickMedia(m: PickedMedia) {
    if (m.type === 'video' && m.duration != null && m.duration > VIDEO_MAX_SEC) {
      Alert.alert('Video too long', `Videos must be ${VIDEO_MAX_SEC} seconds or shorter.`);
      return;
    }
    setMedia({ uri: m.uri, width: m.width, height: m.height, posterUri: m.posterUri });
    setThumbnailUri(null);
    if (m.type === 'video') {
      setVideoAspect(clampFeedAspect((m.width || 1) / (m.height || 1)));
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(m.uri, { time: 1000 });
        setThumbnailUri(uri);
      } catch {}
    }
  }

  async function pickAudio() {
    const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];

    let dur: number | null = null;
    try {
      const { sound, status } = await Audio.Sound.createAsync({ uri: asset.uri });
      if ((status as any).isLoaded && (status as any).durationMillis) dur = Math.floor((status as any).durationMillis / 1000);
      await sound.unloadAsync();
    } catch {}

    // Absolute ceiling (podcasts/audiobooks). The tighter 6-min music limit is
    // enforced on Share, since the category is chosen on the next step.
    if (dur != null && dur > SPOKEN_MAX_SEC) {
      Alert.alert('Audio too long', `Audio must be ${fmtMins(SPOKEN_MAX_SEC)} or shorter.`);
      return;
    }
    setAudioFile(asset);
    setAudioDuration(dur);
  }

  async function pickCover() {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [1, 1], quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) setCoverUri(result.assets[0].uri);
  }

  function goNext() {
    if (!hasMedia) { setError(`Select ${postType === 'audio' ? 'an audio file' : `a ${postType}`} first`); return; }
    setError('');
    if (postType === 'image') cropRef.current = cropperRef.current?.getCrop() ?? null;
    setStep('details');
  }

  async function uploadToStorage(userId: string, uri: string, ext: string, mime: string): Promise<string> {
    const path = `${userId}/${Date.now()}.${ext}`;
    const form = new FormData();
    form.append('file', { uri, name: `${Date.now()}.${ext}`, type: mime } as any);
    const { error: upErr } = await supabase.storage.from('posts').upload(path, form, { contentType: mime, upsert: false });
    if (upErr) throw upErr;
    return supabase.storage.from('posts').getPublicUrl(path).data.publicUrl;
  }

  async function handleShare() {
    if (!caption.trim()) { setError('Please add a caption'); return; }
    if (postType === 'audio' && audioDuration != null) {
      const limit = audioKind === 'audio' ? MUSIC_MAX_SEC : SPOKEN_MAX_SEC;
      if (audioDuration > limit) {
        Alert.alert(
          'Track too long',
          audioKind === 'audio'
            ? `Music must be ${fmtMins(MUSIC_MAX_SEC)} or shorter. Choose Podcast or Audiobook for longer audio.`
            : `${audioKind === 'podcast' ? 'Podcasts' : 'Audiobooks'} must be ${fmtMins(SPOKEN_MAX_SEC)} or shorter.`,
        );
        return;
      }
    }
    setLoading(true); setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let mediaUrl: string;
      let thumbnailUrl: string | null = null;
      let coverUrl: string | null = null;

      if (postType === 'audio') {
        const a = audioFile;
        const ext = a.name ? a.name.split('.').pop() : (a.uri.split('.').pop() || 'mp3');
        mediaUrl = await uploadToStorage(user.id, a.uri, ext, a.mimeType || 'audio/mpeg');
        if (coverUri) coverUrl = await uploadToStorage(user.id, coverUri, 'jpg', 'image/jpeg');
      } else if (postType === 'image') {
        // Bake the user's pan/pinch crop into the uploaded image.
        let outUri = media!.uri;
        const crop = cropRef.current;
        if (crop && crop.width > 1 && crop.height > 1) {
          const out = await manipulateAsync(
            media!.uri,
            [{ crop }, { resize: { width: Math.min(1080, crop.width) } }],
            { compress: 0.85, format: SaveFormat.JPEG },
          );
          outUri = out.uri;
        }
        mediaUrl = await uploadToStorage(user.id, outUri, 'jpg', 'image/jpeg');
      } else {
        // video — uploaded as-is, shown contained at the chosen format
        const ext = media!.uri.split('.').pop() || 'mp4';
        mediaUrl = await uploadToStorage(user.id, media!.uri, ext, 'video/mp4');
        if (thumbnailUri) thumbnailUrl = await uploadToStorage(user.id, thumbnailUri, 'jpg', 'image/jpeg');
      }

      const { error: postError } = await supabase.from('posts').insert({
        user_id: user.id,
        type: postType === 'audio' ? audioKind : postType,
        media_url: mediaUrl,
        caption: caption.trim(),
        is_public: isPublic,
        ...(genre && showGenre ? { genre } : {}),
        ...(audioDuration !== null ? { duration_seconds: audioDuration } : {}),
        ...(postType === 'image' ? { aspect_ratio: format } : {}),
        ...(postType === 'video' ? { aspect_ratio: String(videoAspect) } : {}),
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        ...(coverUrl ? { cover_url: coverUrl } : {}),
      });
      if (postError) throw postError;

      Alert.alert('Posted! 🎉', 'Your post is now live on Laybell');
      resetAll();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    }
    setLoading(false);
  }

  // ─── Details step ──────────────────────────────────────────────────────────
  if (step === 'details') {
    const thumbUri = postType === 'audio' ? coverUri : (postType === 'video' ? thumbnailUri : media?.uri);
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setStep('pick')}>
            <Ionicons name="chevron-back" size={26} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>New post</Text>
          <TouchableOpacity style={styles.headerAction} onPress={handleShare} disabled={loading}>
            {loading ? <ActivityIndicator color={COLORS.primary} size="small" /> : <Text style={styles.headerActionText}>Share</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.detailsContent} keyboardShouldPersistTaps="handled">
          {/* Caption row with media thumbnail (Instagram-style) */}
          <View style={styles.captionRow}>
            {thumbUri ? (
              <Image source={{ uri: thumbUri }} style={styles.captionThumb} />
            ) : (
              <View style={[styles.captionThumb, styles.captionThumbPlaceholder]}>
                <Ionicons name="musical-notes" size={20} color={COLORS.primary} />
              </View>
            )}
            <TextInput
              style={styles.captionInput}
              placeholder="Write a caption..."
              placeholderTextColor={COLORS.textTertiary}
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={500}
              editable={!swiping}
            />
          </View>

          {/* Audio category */}
          {postType === 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Category</Text>
              <View style={styles.row}>
                {([
                  { val: 'audio', label: 'Music', icon: 'musical-notes' },
                  { val: 'podcast', label: 'Podcast', icon: 'mic' },
                  { val: 'audiobook', label: 'Audiobook', icon: 'book' },
                ] as const).map(({ val, label, icon }) => {
                  const on = audioKind === val;
                  return (
                    <TouchableOpacity key={val} style={[styles.choice, on && styles.choiceActive]} onPress={() => setAudioKind(val)}>
                      <Ionicons name={icon as any} size={15} color={on ? COLORS.primary : COLORS.textSecondary} />
                      <Text style={[styles.choiceText, on && styles.choiceTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Cover art (audio) */}
          {postType === 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Cover Art</Text>
              <TouchableOpacity style={styles.coverPicker} onPress={pickCover}>
                {coverUri ? (
                  <Image source={{ uri: coverUri }} style={styles.coverPreview} />
                ) : (
                  <View style={styles.coverPlaceholder}><Ionicons name="image-outline" size={24} color={COLORS.textTertiary} /></View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.coverTitle}>{coverUri ? 'Cover selected' : 'Add cover art'}</Text>
                  <Text style={styles.coverSub}>{coverUri ? 'Tap to change or re-crop' : 'Square image shown next to your track'}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
              </TouchableOpacity>
            </View>
          )}

          {/* Genre */}
          {showGenre && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Genre</Text>
              <View style={styles.genreWrap}>
                {GENRES.map(g => {
                  const value = g.toLowerCase();
                  const active = genre === value;
                  return (
                    <TouchableOpacity key={g} style={[styles.genreChip, active && styles.genreChipActive]} onPress={() => setGenre(active ? '' : value)}>
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
              <Ionicons name={isPublic ? 'globe-outline' : 'lock-closed-outline'} size={20} color={COLORS.primary} />
              <View>
                <Text style={styles.visibilityLabel}>{isPublic ? 'Public' : 'Followers only'}</Text>
                <Text style={styles.visibilitySub}>{isPublic ? 'Anyone on Laybell can see this' : 'Only your followers can see this'}</Text>
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
      </View>
    );
  }

  // ─── Pick step (Instagram-style) ───────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBtn} onPress={resetAll}>
          <Ionicons name="close" size={26} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New post</Text>
        <TouchableOpacity style={styles.headerAction} onPress={goNext} disabled={!hasMedia}>
          <Ionicons name="arrow-forward" size={24} color={hasMedia ? COLORS.primary : COLORS.textTertiary} />
        </TouchableOpacity>
      </View>

      {postType === 'audio' ? (
        // Audio: document picker (no camera roll)
        <View style={styles.audioPickArea}>
          <TouchableOpacity style={styles.audioPickBtn} onPress={pickAudio}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.audioPickIcon}>
              <Ionicons name={audioFile ? 'checkmark' : 'musical-notes'} size={30} color={COLORS.text} />
            </LinearGradient>
            <Text style={styles.audioPickTitle}>{audioFile ? (audioFile.name || 'Audio selected') : 'Select an audio file'}</Text>
            <Text style={styles.audioPickSub}>{audioFile ? 'Tap to change' : 'Music up to 6 min · Podcasts & Audiobooks up to 35 min'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Collapsing cropper preview — shrinks as the gallery scrolls */}
          <Animated.View style={[styles.previewArea, { height: animatedPreviewH }]}>
            {media ? (
              postType === 'video' ? (
                // Static poster preview (cover) — reliable vs. live playback.
                <ExpoImage
                  source={{ uri: media.posterUri || thumbnailUri || media.uri }}
                  style={{ width: frameW, height: frameH }}
                  contentFit="cover"
                />
              ) : (
                <ErrorBoundary label="Couldn't open this photo">
                  <MediaCropper
                    key={`${media.uri}-${previewAspect}`}
                    ref={cropperRef}
                    uri={media.uri}
                    mediaWidth={media.width}
                    mediaHeight={media.height}
                    frameW={frameW}
                    frameH={frameH}
                    type="image"
                  />
                </ErrorBoundary>
              )
            ) : (
              <View style={[styles.previewPlaceholder, { width: frameW, height: frameH }]}>
                <Ionicons name={postType === 'video' ? 'videocam-outline' : 'image-outline'} size={40} color={COLORS.textTertiary} />
                <Text style={styles.previewPlaceholderText}>Pick a {postType} below</Text>
              </View>
            )}
            {/* Aspect toggle (images only — videos use their native ratio) */}
            {postType === 'image' && (
              <TouchableOpacity style={styles.aspectBtn} onPress={cycleFormat}>
                <Ionicons name="resize-outline" size={16} color={COLORS.text} />
                <Text style={styles.aspectBtnText}>{format}</Text>
              </TouchableOpacity>
            )}
          </Animated.View>

          {/* Gallery */}
          <View style={styles.recentsRow}>
            <Text style={styles.recentsText}>Recents</Text>
            {postType === 'image' && <Text style={styles.recentsHint}>Drag / pinch to crop</Text>}
            {postType === 'video' && <Text style={styles.recentsHint}>Up to 90s</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <ErrorBoundary label="Couldn't open your photos">
              <PhotoGrid
                mediaType={postType as 'image' | 'video'}
                onPick={onPickMedia}
                onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
              />
            </ErrorBoundary>
          </View>
        </>
      )}

      {/* Bottom type strip (Instagram mode-strip style) */}
      <View style={styles.typeStrip}>
        {POST_TYPES.map(t => {
          const on = postType === t.value;
          return (
            <TouchableOpacity key={t.value} onPress={() => switchType(t.value)} style={styles.typeStripBtn}>
              <Text style={[styles.typeStripText, on && styles.typeStripTextActive]}>{t.label.toUpperCase()}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerBtn: { width: 64, paddingVertical: 4 },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  headerAction: { width: 64, alignItems: 'flex-end', paddingVertical: 4, paddingRight: SPACING.xs },
  headerActionText: { color: COLORS.primary, fontSize: 16, fontWeight: '700' },

  previewArea: { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xs, overflow: 'hidden' },
  previewPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surface, gap: SPACING.sm, alignSelf: 'center' },
  previewPlaceholderText: { color: COLORS.textTertiary, fontSize: 14 },
  aspectBtn: {
    position: 'absolute', left: SPACING.md, bottom: SPACING.md,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: SPACING.sm,
  },
  aspectBtnText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },

  recentsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  recentsText: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  recentsHint: { color: COLORS.textTertiary, fontSize: 12 },

  typeStrip: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: SPACING.xl,
    paddingVertical: SPACING.md, borderTopWidth: 0.5, borderTopColor: COLORS.border,
  },
  typeStripBtn: { paddingHorizontal: SPACING.sm },
  typeStripText: { color: COLORS.textTertiary, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  typeStripTextActive: { color: COLORS.primary },

  audioPickArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  audioPickBtn: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl,
    borderWidth: 1.5, borderColor: COLORS.border, borderStyle: 'dashed', borderRadius: RADIUS.lg,
    width: '100%',
  },
  audioPickIcon: { width: 64, height: 64, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  audioPickTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  audioPickSub: { color: COLORS.textTertiary, fontSize: 13 },

  // details
  detailsContent: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },
  captionRow: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'flex-start' },
  captionThumb: { width: 64, height: 64, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceLight },
  captionThumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  captionInput: {
    flex: 1, minHeight: 64, color: COLORS.text, fontSize: 15,
    textAlignVertical: 'top', paddingTop: SPACING.xs,
  },

  section: { gap: 6 },
  sectionLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: SPACING.sm },
  choice: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: SPACING.sm + 2, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceLight,
  },
  choiceActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '11' },
  choiceText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  choiceTextActive: { color: COLORS.primary, fontWeight: '700' },

  coverPicker: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  coverPreview: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceElevated },
  coverPlaceholder: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: COLORS.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  coverTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  coverSub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },

  genreWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genreChip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full, backgroundColor: COLORS.surfaceLight,
    borderWidth: 1, borderColor: COLORS.border,
  },
  genreChipActive: { backgroundColor: COLORS.primary + '22', borderColor: COLORS.primary },
  genreChipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  genreChipTextActive: { color: COLORS.primary },

  visibilityRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, padding: SPACING.md,
  },
  visibilityLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  visibilityLabel: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  visibilitySub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },

  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { color: COLORS.error, fontSize: 13 },
});
