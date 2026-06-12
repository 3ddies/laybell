import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, ActivityIndicator, Alert, Switch, Image, Dimensions, Animated,
} from 'react-native';
import { useState, useCallback, useRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { Audio } from 'expo-av';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge } from '../../lib/badges';
import { processMentions, getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { createNotification } from '../../lib/createNotification';
import MentionSuggestions from '../../components/MentionSuggestions';
import TagPeopleModal, { type TaggedPerson } from '../../components/TagPeopleModal';
import { useAudio } from '../../contexts/AudioContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { IMAGE_FORMATS, aspectToNumber, clampFeedAspect, defaultFormatFor } from '../../lib/aspectRatio';
import { GENRES } from '../../lib/genres';
import { Image as ExpoImage } from 'expo-image';
import MediaCropper, { type MediaCropperHandle, type CropRect } from '../../components/MediaCropper';
import PhotoGrid, { type PickedMedia } from '../../components/PhotoGrid';
import { MAX_SLIDES, type Slide } from '../../lib/slideshow';
import SongPickerModal, { type PickedSong } from '../../components/SongPickerModal';
import VideoTrimmer from '../../components/VideoTrimmer';
import ErrorBoundary from '../../components/ErrorBoundary';

type PostType = 'image' | 'video' | 'audio' | 'slideshow';
type Step = 'pick' | 'edit' | 'details';

// One picked item in a slideshow (before upload).
type PickedSlide = {
  id?: string;                  // source asset id — for in-app grid tap-to-toggle
  uri: string;
  type: 'image' | 'video';
  width: number;
  height: number;
  thumbnailUri?: string | null; // poster for video slides
  posterUri?: string | null;    // ph:// poster (video) — renders reliably via expo-image
  crop?: CropRect | null;       // user's drag/pinch crop (image slides) — baked on upload
};

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const PREVIEW_MAX_H = Math.round(SCREEN_H * 0.46);

// Duration limits (seconds).
const VIDEO_MAX_SEC  = 90;       // 1.5 min
const MUSIC_MAX_SEC  = 6 * 60;   // music tracks
const SPOKEN_MAX_SEC = 35 * 60;  // podcasts / audiobooks
const AUDIO_MIN_SEC  = 5;        // global minimum length for any audio

// Audio file-size cap (video is bounded by the 90s duration limit instead).
const AUDIO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

function fmtMins(sec: number) {
  return sec % 60 === 0 ? `${sec / 60} min` : `${Math.round(sec / 60)} min`;
}
function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PostScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [step, setStep] = useState<Step>('pick');
  const [postType, setPostType] = useState<PostType>('image');
  const [format, setFormat] = useState<string>('1:1');

  // slideshow selection (up to MAX_SLIDES images/videos, shared aspect ratio = `format`)
  const [slides, setSlides] = useState<PickedSlide[]>([]);

  // image/video selection
  const [media, setMedia] = useState<{ uri: string; width: number; height: number; posterUri?: string } | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null); // grid asset id of the single selection
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const [videoAspect, setVideoAspect] = useState(0.8); // native aspect for video display
  const [videoDuration, setVideoDuration] = useState(0); // seconds (source)
  const [trimStart, setTrimStart] = useState(0); // seconds — start of the chosen window
  const cropperRef = useRef<MediaCropperHandle>(null);
  const cropRef = useRef<CropRect | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;

  // audio selection
  const [audioFile, setAudioFile] = useState<any>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [audioKind, setAudioKind] = useState<'audio' | 'podcast' | 'audiobook'>('audio');
  const [isRecording, setIsRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewSoundRef = useRef<Audio.Sound | null>(null);

  // details
  const [caption, setCaption] = useState('');
  const [genre, setGenre] = useState('');
  const [song, setSong] = useState<PickedSong | null>(null); // another creator's track on this image/video
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [tagged, setTagged] = useState<TaggedPerson[]>([]); // accounts tagged on this post (≤10)
  const [showTagModal, setShowTagModal] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { stop } = useAudio();
  const swiping = usePagerSwiping();
  const setTabSwipe = useTabSwipeControl();
  const router = useRouter();
  useFocusEffect(useCallback(() => { stop(); }, []));

  // Swiping to an adjacent tab is on only while browsing the Posts picker with
  // NOTHING selected yet — selecting any media (single or a slide) turns it off.
  // The camera roll suppresses it during an active scroll and restores it when the
  // scroll settles (onScrollActive, below). Restored on leave so the other tabs
  // stay swipeable.
  const swipeOn = step === 'pick' && postType !== 'audio'
    && (postType === 'slideshow' ? slides.length === 0 : media == null);
  useFocusEffect(useCallback(() => {
    setTabSwipe(swipeOn);
    return () => setTabSwipe(true);
  }, [swipeOn, setTabSwipe]));

  function exitToExplore() {
    resetAll();
    router.navigate('/explore');
  }

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
  const hasMedia = postType === 'audio' ? !!audioFile : postType === 'slideshow' ? slides.length > 0 : !!media;
  const slideshowMode = postType === 'slideshow';
  const lastSlide = slides.length ? slides[slides.length - 1] : null; // most recent — shown on the square

  function resetAll() {
    if (recordingRef.current) { recordingRef.current.stopAndUnloadAsync().catch(() => {}); recordingRef.current = null; }
    unloadPreview();
    setIsRecording(false); setRecSecs(0);
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null; setSlides([]);
    setVideoDuration(0); setTrimStart(0);
    setAudioFile(null); setAudioDuration(null); setCoverUri(null); setAudioKind('audio');
    setCaption(''); setGenre(''); setSong(null); setTagged([]); setError(''); setStep('pick');
  }

  function switchType(t: PostType) {
    setPostType(t);
    setFormat(t === 'slideshow' ? '1:1' : defaultFormatFor(t as any));
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null; setSlides([]);
    setVideoDuration(0); setTrimStart(0);
    setAudioFile(null); setAudioDuration(null);
    setSong(null); setTagged([]);
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
    if (m.type !== postType) setFormat(defaultFormatFor(m.type as any)); // image↔video
    setPostType(m.type);
    setPickedId(m.id);
    setMedia({ uri: m.uri, width: m.width, height: m.height, posterUri: m.posterUri });
    setThumbnailUri(null);
    if (m.type === 'video') {
      setVideoAspect(clampFeedAspect((m.width || 1) / (m.height || 1)));
      setVideoDuration(m.duration ?? 0);
      setTrimStart(0);
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(m.uri, { time: 1000 });
        setThumbnailUri(uri);
      } catch {}
    }
  }


  // ── Unified Posts picker: single vs slideshow, both off one in-app grid ───────
  function clearMedia() {
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null;
    setVideoDuration(0); setTrimStart(0);
    setPostType('image'); setFormat('1:1');
  }
  function enterSingle() {
    if (postType !== 'slideshow') return;
    setPostType('image'); setFormat('1:1'); setSlides([]);
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null;
  }
  function enterSlideshow() {
    if (postType === 'slideshow') return;
    setPostType('slideshow'); setFormat('1:1');
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null;
  }
  // Save the crop the user set on the slide currently in the cropper (the last
  // image slide) before it's superseded by a new slide or committed on Next.
  function captureLastSlideCrop() {
    const c = cropperRef.current?.getCrop();
    if (!c) return;
    setSlides(prev => {
      const i = prev.length - 1;
      if (i < 0 || prev[i].type !== 'image') return prev;
      const next = [...prev];
      next[i] = { ...next[i], crop: c };
      return next;
    });
  }
  // Add the tapped grid item (already resolved to a file uri) as the next slide.
  async function addSlideFromGrid(m: PickedMedia) {
    captureLastSlideCrop(); // preserve the crop set on the current last slide first
    if (slides.length >= MAX_SLIDES) { Alert.alert('Limit reached', `A slideshow can have up to ${MAX_SLIDES} items.`); return; }
    if (m.type === 'video' && m.duration != null && m.duration > VIDEO_MAX_SEC) {
      Alert.alert('Video too long', `Slideshow videos must be ${VIDEO_MAX_SEC}s or shorter.`); return;
    }
    let thumb: string | null = null;
    if (m.type === 'video') { try { const { uri } = await VideoThumbnails.getThumbnailAsync(m.uri, { time: 1000 }); thumb = uri; } catch {} }
    setSlides(prev => prev.length >= MAX_SLIDES ? prev
      : [...prev, { id: m.id, uri: m.uri, type: m.type, width: m.width, height: m.height, thumbnailUri: thumb, posterUri: m.posterUri }]);
  }
  function removeSlideById(id: string) { setSlides(prev => prev.filter(s => s.id !== id)); }
  // Tabs: "Posts" returns from Music; "Music" is switchType('audio').
  function selectPostsTab() { if (postType === 'audio') switchType('image'); }

  async function startRecording() {
    await unloadPreview();
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Microphone needed', 'Enable microphone access in Settings to record audio.');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      rec.setProgressUpdateInterval(500);
      rec.setOnRecordingStatusUpdate((st) => {
        if (st.isRecording) setRecSecs(Math.floor((st.durationMillis ?? 0) / 1000));
      });
      await rec.startAsync();
      recordingRef.current = rec;
      setRecSecs(0);
      setIsRecording(true);
    } catch (e: any) {
      Alert.alert('Could not start recording', e?.message ?? 'Please try again.');
    }
  }

  async function stopRecording() {
    const rec = recordingRef.current;
    if (!rec) return;
    setIsRecording(false);
    const dur = recSecs;
    try {
      await rec.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    } catch {}
    const uri = rec.getURI();
    recordingRef.current = null;
    if (!uri) return;
    if (dur > SPOKEN_MAX_SEC) {
      Alert.alert('Recording too long', `Audio must be ${fmtMins(SPOKEN_MAX_SEC)} or shorter.`);
      return;
    }
    setAudioFile({ uri, name: uri.split('/').pop() || `recording-${Date.now()}.m4a`, mimeType: 'audio/m4a' });
    setAudioDuration(dur || null);
  }

  async function unloadPreview() {
    if (previewSoundRef.current) { await previewSoundRef.current.unloadAsync().catch(() => {}); previewSoundRef.current = null; }
    setIsPreviewPlaying(false);
  }

  // Let the user hear the recorded/selected audio before posting.
  async function togglePreview() {
    if (!audioFile) return;
    try {
      if (previewSoundRef.current) {
        const st: any = await previewSoundRef.current.getStatusAsync();
        if (st.isLoaded && st.isPlaying) { await previewSoundRef.current.pauseAsync(); setIsPreviewPlaying(false); }
        else { await previewSoundRef.current.playAsync(); setIsPreviewPlaying(true); }
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync({ uri: audioFile.uri }, { shouldPlay: true });
      previewSoundRef.current = sound;
      setIsPreviewPlaying(true);
      sound.setOnPlaybackStatusUpdate((s: any) => {
        if (s.isLoaded && s.didJustFinish) { setIsPreviewPlaying(false); sound.setPositionAsync(0); }
      });
    } catch (e: any) {
      Alert.alert('Playback failed', e?.message ?? 'Could not play this audio.');
    }
  }

  async function pickAudio() {
    await unloadPreview();
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
    if (asset.size != null && asset.size > AUDIO_MAX_BYTES) {
      Alert.alert('Audio too large', 'Please choose an audio file under 100 MB.');
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
    if (!hasMedia) {
      setError(postType === 'audio' ? 'Select an audio file first'
        : postType === 'slideshow' ? 'Add at least one photo or video'
        : `Select a ${postType} first`);
      return;
    }
    setError('');
    if (postType === 'image') cropRef.current = cropperRef.current?.getCrop() ?? null;
    if (postType === 'slideshow') captureLastSlideCrop();
    // Long videos go through the trim editor to pick a 90s window.
    if (postType === 'video' && videoDuration > VIDEO_MAX_SEC) { setStep('edit'); return; }
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
      if (audioDuration < AUDIO_MIN_SEC) {
        Alert.alert('Audio too short', `Audio must be at least ${AUDIO_MIN_SEC} seconds long.`);
        return;
      }
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
      let slidesPayload: Slide[] | null = null;

      if (postType === 'slideshow') {
        // Upload every slide, then mirror slide 1 onto media_url/thumbnail_url so
        // existing thumbnail surfaces show the cover.
        const built: Slide[] = [];
        for (const s of slides) {
          let url: string;
          if (s.type === 'image') {
            let outUri = s.uri;
            try {
              const crop = s.crop;
              const ops: any[] = [];
              if (crop && crop.width > 1 && crop.height > 1) ops.push({ crop });
              ops.push({ resize: { width: crop && crop.width > 1 ? Math.min(1440, crop.width) : 1440 } });
              const out = await manipulateAsync(s.uri, ops, { compress: 0.9, format: SaveFormat.JPEG });
              outUri = out.uri;
            } catch {}
            url = await uploadToStorage(user.id, outUri, 'jpg', 'image/jpeg');
          } else {
            const ext = s.uri.split('.').pop() || 'mp4';
            url = await uploadToStorage(user.id, s.uri, ext, 'video/mp4');
          }
          let thumb: string | null = s.type === 'image' ? url : null;
          if (s.type === 'video' && s.thumbnailUri) thumb = await uploadToStorage(user.id, s.thumbnailUri, 'jpg', 'image/jpeg');
          built.push({ type: s.type, url, thumbnail_url: thumb, aspect_ratio: format });
        }
        slidesPayload = built;
        mediaUrl = built[0].url;
        thumbnailUrl = built[0].thumbnail_url ?? null;
      } else if (postType === 'audio') {
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
            // Keep the crop at up to 1440px wide (sharp on high-DPI screens, never
            // upscaling past the source) at high JPEG quality.
            [{ crop }, { resize: { width: Math.min(1440, crop.width) } }],
            { compress: 0.92, format: SaveFormat.JPEG },
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

      const trimmed = postType === 'video' && videoDuration > VIDEO_MAX_SEC;
      const videoDurSec = trimmed ? VIDEO_MAX_SEC : Math.round(videoDuration);

      const { data: newPost, error: postError } = await supabase.from('posts').insert({
        user_id: user.id,
        type: postType === 'audio' ? audioKind : postType,
        media_url: mediaUrl,
        caption: caption.trim(),
        is_public: isPublic,
        ...(genre && showGenre ? { genre } : {}),
        ...(audioDuration !== null ? { duration_seconds: audioDuration } : {}),
        ...(postType === 'video' && videoDurSec > 0 ? { duration_seconds: videoDurSec } : {}),
        ...(postType === 'image' ? { aspect_ratio: format } : {}),
        ...(postType === 'video' ? { aspect_ratio: String(videoAspect) } : {}),
        ...(postType === 'slideshow' ? { aspect_ratio: format, slides: slidesPayload } : {}),
        ...(trimmed ? { trim_start: trimStart, trim_end: trimStart + VIDEO_MAX_SEC } : {}),
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        ...(coverUrl ? { cover_url: coverUrl } : {}),
        ...(song && postType !== 'audio'
          ? { song_id: song.id, song_title: song.title, song_artist: song.artist, song_artist_id: song.artistId }
          : {}),
        ...(tagged.length && postType !== 'audio' ? { tagged_user_ids: tagged.map((t) => t.id) } : {}),
      }).select('id').single();
      if (postError) throw postError;
      if (isPublic) bumpBadge('posts_created'); // recomputes the Posts badge from the live grid

      // Notify @mentions in the caption, and the original artist if their song was used.
      if (newPost?.id) {
        processMentions({ text: caption.trim(), actorId: user.id, postId: newPost.id });
        if (song && postType !== 'audio' && song.artistId && song.artistId !== user.id) {
          createNotification({ userId: song.artistId, actorId: user.id, type: 'song_used', postId: newPost.id });
        }
        if (postType !== 'audio') {
          for (const t of tagged) {
            if (t.id !== user.id) createNotification({ userId: t.id, actorId: user.id, type: 'tag', postId: newPost.id });
          }
        }
      }

      Alert.alert('Posted! 🎉', 'Your post is now live on Laybell');
      resetAll();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    }
    setLoading(false);
  }

  // ─── Trim step (long videos) ───────────────────────────────────────────────
  if (step === 'edit' && media && postType === 'video') {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setStep('pick')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Trim</Text>
          <TouchableOpacity style={styles.headerAction} onPress={() => setStep('details')}>
            <Ionicons name="arrow-forward" size={24} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.trimBody}>
          <VideoTrimmer
            uri={media.uri}
            posterUri={media.posterUri}
            duration={videoDuration}
            windowSec={VIDEO_MAX_SEC}
            frameW={frameW}
            frameH={frameH}
            onChange={setTrimStart}
          />
        </View>
      </View>
    );
  }

  // ─── Details step ──────────────────────────────────────────────────────────
  if (step === 'details') {
    const thumbUri = postType === 'audio' ? coverUri
      : postType === 'slideshow' ? (slides[0] ? (slides[0].type === 'video' ? slides[0].thumbnailUri : slides[0].uri) : null)
      : (postType === 'video' ? thumbnailUri : media?.uri);
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setStep('pick')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>New post</Text>
          <TouchableOpacity style={styles.headerAction} onPress={handleShare} disabled={loading}>
            {loading ? <ActivityIndicator color={colors.primary} size="small" /> : <Text style={styles.headerActionText}>Share</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.detailsContent} keyboardShouldPersistTaps="handled">
          {/* Caption row with media thumbnail (Instagram-style) */}
          <View style={styles.captionRow}>
            {thumbUri ? (
              <Image source={{ uri: thumbUri }} style={styles.captionThumb} />
            ) : (
              <View style={[styles.captionThumb, styles.captionThumbPlaceholder]}>
                <Ionicons name="musical-notes" size={20} color={colors.primary} />
              </View>
            )}
            <TextInput
              style={styles.captionInput}
              placeholder="Write a caption..."
              placeholderTextColor={colors.textTertiary}
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={500}
              editable={!swiping}
            />
          </View>

          <MentionSuggestions
            query={getActiveMentionQuery(caption, caption.length)}
            onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
          />

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
                      <Ionicons name={icon as any} size={15} color={on ? colors.primary : colors.textSecondary} />
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
                  <View style={styles.coverPlaceholder}><Ionicons name="image-outline" size={24} color={colors.textTertiary} /></View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.coverTitle}>{coverUri ? 'Cover selected' : 'Add cover art'}</Text>
                  <Text style={styles.coverSub}>{coverUri ? 'Tap to change or re-crop' : 'Square image shown next to your track'}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
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

          {/* Music — attach another creator's song to an image/video post */}
          {postType !== 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Music</Text>
              {song ? (
                <View style={styles.songRow}>
                  <Ionicons name="musical-notes" size={18} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.songRowTitle} numberOfLines={1}>{song.title}</Text>
                    <Text style={styles.songRowArtist} numberOfLines={1}>{song.artist}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setShowSongPicker(true)} style={styles.songChange}>
                    <Text style={styles.songChangeText}>Change</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSong(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.addSongBtn} onPress={() => setShowSongPicker(true)}>
                  <Ionicons name="musical-notes-outline" size={18} color={colors.primary} />
                  <Text style={styles.addSongText}>Add music</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Tag people — deliberate account tags (≤10), shown as a button on the post */}
          {postType !== 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Tag people</Text>
              {tagged.length > 0 ? (
                <TouchableOpacity style={styles.songRow} onPress={() => setShowTagModal(true)}>
                  <Ionicons name="people" size={18} color={colors.primary} />
                  <Text style={styles.songRowTitle} numberOfLines={1}>
                    {tagged.map((t) => `@${t.username}`).join(', ')}
                  </Text>
                  <View style={styles.songChange}><Text style={styles.songChangeText}>Edit</Text></View>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.addSongBtn} onPress={() => setShowTagModal(true)}>
                  <Ionicons name="person-add-outline" size={18} color={colors.primary} />
                  <Text style={styles.addSongText}>Tag people</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Visibility */}
          <View style={styles.visibilityRow}>
            <View style={styles.visibilityLeft}>
              <Ionicons name={isPublic ? 'globe-outline' : 'people-outline'} size={20} color={colors.primary} />
              <View>
                <Text style={styles.visibilityLabel}>{isPublic ? 'Public' : 'Friends only'}</Text>
                <Text style={styles.visibilitySub}>{isPublic ? 'Anyone on Laybell can see this' : 'Only your friends (mutual follows) can see this'}</Text>
              </View>
            </View>
            <Switch
              value={isPublic}
              onValueChange={setIsPublic}
              trackColor={{ false: colors.border, true: colors.primary + '88' }}
              thumbColor={isPublic ? colors.primary : colors.textTertiary}
            />
          </View>

          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </ScrollView>
        <SongPickerModal visible={showSongPicker} onClose={() => setShowSongPicker(false)} onSelect={setSong} />
        <TagPeopleModal visible={showTagModal} initial={tagged} onClose={() => setShowTagModal(false)} onDone={setTagged} />
      </View>
    );
  }

  // ─── Pick step (Instagram-style) ───────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBtn} onPress={exitToExplore}>
          <Ionicons name="close" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New post</Text>
        <TouchableOpacity style={styles.headerAction} onPress={goNext} disabled={!hasMedia}>
          <Ionicons name="arrow-forward" size={24} color={hasMedia ? colors.primary : colors.textTertiary} />
        </TouchableOpacity>
      </View>

      {postType === 'audio' ? (
        <View style={styles.audioPickArea}>
          {isRecording ? (
            <View style={styles.recordBox}>
              <View style={styles.recDot} />
              <Text style={styles.recTime}>{fmtClock(recSecs)}</Text>
              <Text style={styles.audioPickSub}>Recording…</Text>
              <TouchableOpacity style={styles.stopBtn} onPress={stopRecording}>
                <Ionicons name="stop" size={24} color={colors.text} />
                <Text style={styles.stopBtnText}>Stop</Text>
              </TouchableOpacity>
            </View>
          ) : audioFile ? (
            <View style={styles.audioSelected}>
              {/* Borderless filled-circle glyph, same as Today's Pick */}
              <TouchableOpacity onPress={togglePreview} activeOpacity={0.8} hitSlop={6}>
                <Ionicons name={isPreviewPlaying ? 'pause-circle' : 'play-circle'} size={64} color={colors.primary} />
              </TouchableOpacity>
              <Text style={styles.audioPickTitle} numberOfLines={1}>{audioFile.name || 'Audio selected'}</Text>
              <Text style={styles.audioPickSub}>
                {audioDuration != null ? `${fmtClock(audioDuration)} · ` : ''}{isPreviewPlaying ? 'Playing…' : 'Tap ▶ to preview'}
              </Text>
              <View style={styles.audioSelBtns}>
                <TouchableOpacity style={styles.audioSelBtn} onPress={pickAudio}>
                  <Ionicons name="cloud-upload-outline" size={16} color={colors.primary} />
                  <Text style={styles.audioSelBtnText}>Replace</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.audioSelBtn} onPress={() => { setAudioFile(null); setAudioDuration(null); startRecording(); }}>
                  <Ionicons name="mic" size={16} color={colors.primary} />
                  <Text style={styles.audioSelBtnText}>Record new</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={styles.audioChoices}>
              <TouchableOpacity style={styles.audioChoice} onPress={startRecording}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.audioChoiceIcon}>
                  <Ionicons name="mic" size={28} color={colors.text} />
                </LinearGradient>
                <Text style={styles.audioChoiceTitle}>Record</Text>
                <Text style={styles.audioChoiceSub}>Talk into the mic</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.audioChoice} onPress={pickAudio}>
                <View style={[styles.audioChoiceIcon, styles.audioChoiceIconAlt]}>
                  <Ionicons name="cloud-upload-outline" size={28} color={colors.primary} />
                </View>
                <Text style={styles.audioChoiceTitle}>Upload</Text>
                <Text style={styles.audioChoiceSub}>MP3 · WAV · M4A</Text>
              </TouchableOpacity>
            </View>
          )}
          <Text style={[styles.audioPickSub, { marginTop: SPACING.lg, textAlign: 'center' }]}>
            Music up to 6 min · Podcasts & Audiobooks up to 35 min
          </Text>
        </View>
      ) : (
        <>
          {/* Collapsing preview — single media cropper OR the slideshow cover */}
          <Animated.View style={[styles.previewArea, { height: animatedPreviewH }]}>
            {slideshowMode ? (
              lastSlide ? (
                lastSlide.type === 'image' ? (
                  <ErrorBoundary label="Couldn't open this photo">
                    <MediaCropper
                      key={`${lastSlide.uri}-${previewAspect}`}
                      ref={cropperRef}
                      uri={lastSlide.uri}
                      mediaWidth={lastSlide.width}
                      mediaHeight={lastSlide.height}
                      frameW={frameW}
                      frameH={frameH}
                      type="image"
                    />
                  </ErrorBoundary>
                ) : (
                  <ExpoImage
                    source={{ uri: lastSlide.posterUri || lastSlide.thumbnailUri || lastSlide.uri }}
                    style={{ width: frameW, height: frameH }}
                    contentFit="cover"
                  />
                )
              ) : (
                <View style={[styles.previewPlaceholder, { width: frameW, height: frameH }]}>
                  <Ionicons name="images-outline" size={40} color={colors.textTertiary} />
                  <Text style={styles.previewPlaceholderText}>Tap items below to build a slideshow</Text>
                </View>
              )
            ) : media ? (
              postType === 'video' ? (
                // Camera-roll videos are ph:// — expo-image renders the poster
                // frame reliably (a live loop would need a file:// copy of the clip).
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
                <Ionicons name="image-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.previewPlaceholderText}>Pick a photo or video below</Text>
              </View>
            )}
            {/* Aspect toggle — single images + slideshows (videos use native ratio) */}
            {((!slideshowMode && postType === 'image' && media) || (slideshowMode && slides.length > 0)) && (
              <TouchableOpacity style={styles.aspectBtn} onPress={cycleFormat}>
                <Ionicons name="resize-outline" size={16} color={colors.text} />
                <Text style={styles.aspectBtnText}>{format}</Text>
              </TouchableOpacity>
            )}
            {/* Remove the selected media from the square (single mode) */}
            {!slideshowMode && media && (
              <TouchableOpacity style={styles.removeBtn} onPress={clearMedia} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            )}
          </Animated.View>

          {/* Single / Slideshow toggle + hint */}
          <View style={styles.recentsRow}>
            <View style={styles.modeToggle}>
              <TouchableOpacity onPress={enterSingle} style={[styles.modePill, !slideshowMode && styles.modePillActive]}>
                <Text style={[styles.modePillText, !slideshowMode && styles.modePillTextActive]}>Single</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={enterSlideshow} style={[styles.modePill, slideshowMode && styles.modePillActive]}>
                <Text style={[styles.modePillText, slideshowMode && styles.modePillTextActive]}>Slideshow</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.recentsHint}>
              {slideshowMode ? `${slides.length}/${MAX_SLIDES} · tap in order` : 'Tap a photo or video'}
            </Text>
          </View>

          {/* One grid for all camera media (photos + videos) */}
          <View style={{ flex: 1 }}>
            <ErrorBoundary label="Couldn't open your photos">
              <PhotoGrid
                selectedIds={slideshowMode
                  ? slides.map(s => s.id).filter((x): x is string => x != null)
                  : (pickedId ? [pickedId] : [])}
                numbered={slideshowMode}
                onPick={slideshowMode ? addSlideFromGrid : onPickMedia}
                onRemove={slideshowMode ? removeSlideById : clearMedia}
                onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
                // Hold the tab swipe off only while actively scrolling the grid;
                // restore it (to swipeOn) once the scroll settles.
                onScrollActive={(active) => setTabSwipe(active ? false : swipeOn)}
              />
            </ErrorBoundary>
          </View>
        </>
      )}

      {/* Bottom strip — Posts (photo / video / slideshow) vs Music */}
      <View style={styles.typeStrip}>
        <TouchableOpacity onPress={selectPostsTab} style={styles.typeStripBtn}>
          <Text style={[styles.typeStripText, postType !== 'audio' && styles.typeStripTextActive]}>POSTS</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => switchType('audio')} style={styles.typeStripBtn}>
          <Text style={[styles.typeStripText, postType === 'audio' && styles.typeStripTextActive]}>MUSIC</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  trimBody: { flex: 1, justifyContent: 'center', padding: SPACING.md },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerBtn: { width: 64, paddingVertical: 4 },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  headerAction: { width: 64, alignItems: 'flex-end', paddingVertical: 4, paddingRight: SPACING.xs },
  headerActionText: { color: colors.primary, fontSize: 16, fontWeight: '700' },

  previewArea: { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xs, overflow: 'hidden' },
  previewPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, gap: SPACING.sm, alignSelf: 'center' },
  previewPlaceholderText: { color: colors.textTertiary, fontSize: 14 },
  aspectBtn: {
    position: 'absolute', left: SPACING.md, bottom: SPACING.md,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: SPACING.sm,
  },
  aspectBtnText: { color: colors.text, fontSize: 12, fontWeight: '700' },

  recentsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  recentsText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  recentsHint: { color: colors.textTertiary, fontSize: 12 },

  // Remove-media "x" on the preview square, and the Single/Slideshow mode toggle.
  removeBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  modeToggle: { flexDirection: 'row', backgroundColor: colors.surfaceLight, borderRadius: RADIUS.full, padding: 2 },
  modePill: { paddingHorizontal: SPACING.md, paddingVertical: 5, borderRadius: RADIUS.full },
  modePillActive: { backgroundColor: colors.primary },
  modePillText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  modePillTextActive: { color: '#fff' },


  typeStrip: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: SPACING.xl,
    paddingVertical: SPACING.md, borderTopWidth: 0.5, borderTopColor: colors.border,
  },
  typeStripBtn: { paddingHorizontal: SPACING.sm },
  typeStripText: { color: colors.textTertiary, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  typeStripTextActive: { color: colors.primary },

  audioPickArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  audioPickBtn: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl,
    borderWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed', borderRadius: RADIUS.lg,
    width: '100%',
  },
  audioPickTitle: { color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  audioPickSub: { color: colors.textTertiary, fontSize: 13, textAlign: 'center' },

  audioChoices: { flexDirection: 'row', gap: SPACING.md, width: '100%' },
  audioChoice: {
    flex: 1, alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xl,
    borderWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed', borderRadius: RADIUS.lg,
  },
  audioChoiceIcon: { width: 56, height: 56, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  audioChoiceIconAlt: { backgroundColor: colors.surfaceElevated },
  audioChoiceTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  audioChoiceSub: { color: colors.textTertiary, fontSize: 12 },

  recordBox: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl, width: '100%',
    borderWidth: 1.5, borderColor: colors.error, borderRadius: RADIUS.lg, backgroundColor: colors.error + '11',
  },
  recDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.error },
  recTime: { color: colors.text, fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums'] },
  stopBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.sm,
    backgroundColor: colors.error, borderRadius: RADIUS.full, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg,
  },
  stopBtnText: { color: colors.text, fontSize: 15, fontWeight: '700' },

  audioSelected: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl, width: '100%',
    borderWidth: 1.5, borderColor: colors.border, borderRadius: RADIUS.lg,
  },
  audioSelBtns: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.xs },
  audioSelBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.primary,
  },
  audioSelBtnText: { color: colors.primary, fontSize: 13, fontWeight: '700' },

  // details
  detailsContent: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },
  captionRow: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'flex-start' },
  captionThumb: { width: 64, height: 64, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceLight },
  captionThumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  captionInput: {
    flex: 1, minHeight: 64, color: colors.text, fontSize: 15,
    textAlignVertical: 'top', paddingTop: SPACING.xs,
  },

  section: { gap: 6 },
  sectionLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: SPACING.sm },
  choice: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: SPACING.sm + 2, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceLight,
  },
  choiceActive: { borderColor: colors.primary, backgroundColor: colors.primary + '11' },
  choiceText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  choiceTextActive: { color: colors.primary, fontWeight: '700' },

  coverPicker: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  coverPreview: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  coverPlaceholder: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  coverTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  coverSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  genreWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genreChip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
  },
  genreChipActive: { backgroundColor: colors.primary + '22', borderColor: colors.primary },
  genreChipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  genreChipTextActive: { color: colors.primary },

  addSongBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingVertical: SPACING.md,
  },
  addSongText: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  songRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm + 2,
  },
  songRowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  songRowArtist: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  songChange: { paddingHorizontal: SPACING.sm, paddingVertical: 4, borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border },
  songChangeText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },

  visibilityRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.md,
  },
  visibilityLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, flex: 1 },
  visibilityLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  visibilitySub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { color: colors.error, fontSize: 13 },
});
