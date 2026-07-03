import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, ActivityIndicator, Alert, Image, Dimensions, Animated, Modal, Switch, Pressable, Easing,
} from 'react-native';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync, createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { probeAudioDurationSec } from '../../lib/audioProbe';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { bumpBadge, publicPostLimit, rawTier, tierLabel } from '../../lib/badges';
import { useProfile } from '../../contexts/ProfileContext';
import { processMentions, getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { createNotification } from '../../lib/createNotification';
import MentionSuggestions from '../../components/MentionSuggestions';
import TagPeopleModal, { type TaggedPerson } from '../../components/TagPeopleModal';
import { useAudio } from '../../contexts/AudioContext';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { IMAGE_FORMATS, aspectToNumber, clampVideoAspect, defaultFormatFor } from '../../lib/aspectRatio';
import { GENRES, genreLabel } from '../../lib/genres';
import { Image as ExpoImage } from 'expo-image';
import MediaCropper, { type MediaCropperHandle, type CropRect } from '../../components/MediaCropper';
import PhotoGrid, { type PickedMedia, type PhotoGridHandle } from '../../components/PhotoGrid';
import { MAX_SLIDES, type Slide } from '../../lib/slideshow';
import { uploadToStorageWithProgress, compressVideoIfPossible } from '../../lib/upload';
import { peekPendingSpotlight, clearPendingSpotlight, activateCampaign, spotlightDurationPhrase } from '../../lib/spotlight';
import {
  loadDrafts, saveDraft, deleteDraft, draftThumb, draftSummary, makeDraftId, type Draft,
} from '../../lib/drafts';
import SongPickerModal, { type PickedSong } from '../../components/SongPickerModal';
import CommunityPickerModal from '../../components/CommunityPickerModal';
import { type PostableCommunity } from '../../lib/communities';
import VideoTrimmer from '../../components/VideoTrimmer';
import ErrorBoundary from '../../components/ErrorBoundary';
import Toast from '../../components/Toast';
import ConfirmDialog from '../../components/ConfirmDialog';

type PostType = 'image' | 'video' | 'audio' | 'slideshow';
type Step = 'pick' | 'edit' | 'details';

// One picked item in a slideshow (before upload).
type PickedSlide = {
  id?: string;                  // source asset id — for in-app grid tap-to-toggle
  uri: string;
  type: 'image' | 'video';
  width: number;
  height: number;
  durationSec?: number | null;  // video slides — drives the slideshow video budget
  thumbnailUri?: string | null; // poster for video slides
  posterUri?: string | null;    // ph:// poster (video) — renders reliably via expo-image
  crop?: CropRect | null;       // user's drag/pinch crop (image slides) — baked on upload
};

// A slideshow's combined video time must stay under this — uploads of several
// long clips in one post are where total size blows up, so the budget is the
// guardrail (any single clip over it is auto-rejected too).
const SLIDESHOW_VIDEO_BUDGET_SEC = 60;

// Total seconds of video across the picked slides (images count as 0).
function slideshowVideoSecs(list: PickedSlide[]): number {
  return list.reduce((sum, s) => sum + (s.type === 'video' ? (s.durationSec ?? 0) : 0), 0);
}

// Translate raw upload/database failures into messages a person can act on.
// Anything unrecognized falls back to the raw message so real bugs stay visible.
function friendlyShareError(err: any, t: (key: string) => string): string {
  const raw = String(err?.message ?? err ?? '').toLowerCase();
  if (raw.includes('exceeded the maximum allowed size') || raw.includes('payload too large') || raw.includes('413')) {
    // Not a duration problem — the file's byte size is over the storage upload
    // limit (see supabase/sql/storage_limits.sql + the Storage dashboard cap).
    // Posting on Wi-Fi lets the on-device compressor finish on the full clip.
    return t('post.errSize');
  }
  if (raw.includes('network') || raw.includes('nsurlerror') || raw.includes('timed out') || raw.includes('socket') || raw.includes('connection')) {
    return t('post.errNetwork');
  }
  if (raw.includes('not authenticated') || raw.includes('jwt') || raw.includes('token')) {
    return t('post.errSession');
  }
  if (raw.includes('row-level security') || raw.includes('policy')) {
    return t('post.errSave');
  }
  if (raw.includes('storage') && raw.includes('bucket')) {
    return t('post.errStorage');
  }
  // A resumed draft whose on-device media was deleted/evicted since it was saved.
  if (raw.includes('no such file') || raw.includes('file not found') || raw.includes('does not exist')
      || raw.includes('cannot find') || raw.includes("couldn't be opened") || raw.includes('could not be opened')
      || raw.includes('unable to open') || raw.includes('no such') ) {
    return t('post.errMissingFile');
  }
  return err?.message || t('post.errGeneric');
}

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const PREVIEW_MAX_H = Math.round(SCREEN_H * 0.46);
// Details-step square preview: scales with the screen but capped so the right
// column (genre/music dropdowns) always keeps a usable width on big phones.
const DETAILS_PREVIEW = Math.min(Math.round(SCREEN_W * 0.44), 190);

// Duration limits (seconds). Duration is the ONLY rule for videos — there are
// deliberately NO file-size caps (an iPhone HD clip can be hundreds of MB and
// must never be rejected for it; the storage bucket's limit is raised to
// match). Videos longer than the cap aren't rejected either: the trim editor
// lets the user pick a 3-minute window.
const VIDEO_MAX_SEC  = 180;      // 3 min
const MUSIC_MAX_SEC  = 6 * 60;   // music tracks
const SPOKEN_MAX_SEC = 35 * 60;  // podcasts / audiobooks
const AUDIO_MIN_SEC  = 5;        // global minimum length for any audio

// Audio file-size cap (video is bounded by the 3-minute duration limit instead).
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
  const { t } = useTranslation();
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
  // Lets a pick scroll the camera-roll grid back to the top so the collapsing
  // preview re-expands and shows the media that was just tapped.
  const photoGridRef = useRef<PhotoGridHandle>(null);
  // True once the gallery has been scrolled enough that the preview is collapsed.
  // While collapsed, a tap on the preview area scrolls the grid back to the top
  // (re-expanding it) — the cropper isn't usable at that size, so capturing the
  // tap there is safe.
  const [previewCollapsed, setPreviewCollapsed] = useState(false);

  // audio selection
  const [audioFile, setAudioFile] = useState<any>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [audioKind, setAudioKind] = useState<'audio' | 'podcast' | 'audiobook'>('audio');
  const [isRecording, setIsRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  // expo-audio recorder (replaces expo-av Audio.Recording). The hook owns the
  // native recorder; recActiveRef gates stop/reset and recTimerRef polls elapsed
  // seconds (expo-audio has no setOnRecordingStatusUpdate cadence callback).
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recActiveRef = useRef(false);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewSoundRef = useRef<AudioPlayer | null>(null);
  const previewSubRef = useRef<{ remove: () => void } | null>(null);

  // details
  const [caption, setCaption] = useState('');
  const [genre, setGenre] = useState('');
  const [showGenrePicker, setShowGenrePicker] = useState(false);
  const [song, setSong] = useState<PickedSong | null>(null); // another creator's track on this image/video
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [tagged, setTagged] = useState<TaggedPerson[]>([]); // accounts tagged on this post (≤10)
  const [showTagModal, setShowTagModal] = useState(false);
  // Communities this post is attributed to (a post can belong to several). Only
  // communities the user is an active, non-muted member of are postable.
  const [communities, setCommunities] = useState<PostableCommunity[]>([]);
  const [showCommunityPicker, setShowCommunityPicker] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  // Per-post creator controls — both default ON, so the poster only ever toggles
  // OFF to opt out. downloads → audio offline pin (posts.downloadable); gifs →
  // whether others may Make GIF from a video (posts.allow_gifs).
  const [allowDownloads, setAllowDownloads] = useState(true);
  const [allowGifs, setAllowGifs] = useState(true);
  // "Learn more" explanation popup for the creator-control toggles.
  const [info, setInfo] = useState<{ icon: string; title: string; body: string } | null>(null);
  const infoAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!info) return;
    infoAnim.setValue(0);
    Animated.timing(infoAnim, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [info, infoAnim]);
  // Tier-gated public slots: none/bronze 6, silver 12, gold 24, diamond ∞.
  // Friends-only posts are never gated; deleting/archiving frees a slot.
  const { profile } = useProfile();
  const myPostLimit = publicPostLimit(rawTier(profile));
  const [publicCount, setPublicCount] = useState<number | null>(null);

  // Live count of public (non-archived) posts for the slot hint + gate.
  const refreshPublicCount = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const base = () => supabase.from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_public', true);
    const filtered = await base().is('archived_at', null);
    if (!filtered.error) { setPublicCount(filtered.count ?? 0); return; }
    // archived_at not migrated yet → count all public posts
    const plain = await base();
    if (!plain.error) setPublicCount(plain.count ?? 0);
  }, []);
  useFocusEffect(useCallback(() => { refreshPublicCount(); }, [refreshPublicCount]));
  const [loading, setLoading] = useState(false);
  // Live byte progress for the big uploads (video / audio); null = no upload
  // in flight or a small file going through the plain helper.
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState('');

  // A paid spotlight campaign waiting for this post (Spotlight → "Create a new
  // post"). Mirrored into state so the details-step banner renders; refreshed
  // on focus since the handoff happens on another screen.
  const [pendingSpot, setPendingSpotBanner] = useState(peekPendingSpotlight());
  useFocusEffect(useCallback(() => { setPendingSpotBanner(peekPendingSpotlight()); }, []));

  // Local drafts (device-only, see lib/drafts). editingDraftId tracks a draft
  // being resumed so saving again UPDATES it (no dup) and publishing it removes
  // it. A ref — it must not trigger re-renders or reset on step changes.
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [savedToast, setSavedToast] = useState(false); // "Saved to Drafts" confirmation
  // Polished "Posted!" confirmation shown after a successful share (replaces the
  // default OS alert). Holds the title/body so the spotlight variant can differ.
  const [postedToast, setPostedToast] = useState<{ title: string; message: string; spotlight: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Draft | null>(null); // draft pending delete-confirm
  const editingDraftId = useRef<string | null>(null);
  useFocusEffect(useCallback(() => { loadDrafts().then(setDrafts); }, []));
  // Drop the "I'm editing draft X" link. Called whenever the resumed media is
  // abandoned (cleared / type-switched) so a later UNRELATED post can't, on
  // publish or re-save, delete or overwrite the original draft.
  function forgetResumedDraft() { editingDraftId.current = null; }

  const { stop } = useAudio();
  const swiping = usePagerSwiping();
  const setTabSwipe = useTabSwipeControl();
  const router = useRouter();
  // Music keeps playing while browsing the picker — the global MiniPlayer
  // migrates to a compact top-right card on this tab (see app/_layout.tsx).
  // Entering the DETAILS step is the cutoff: the song exits there so the user
  // finishes their post in full focus.
  useEffect(() => { if (step === 'details') stop(); }, [step, stop]);

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

  // Flip previewCollapsed once the user has scrolled the gallery down a bit, so
  // the tap-to-expand overlay only exists when the preview is actually shrunk
  // (and never blocks the cropper at the top). Only toggles on threshold crossings.
  useEffect(() => {
    const id = scrollY.addListener(({ value }) => {
      const collapsed = value > 50;
      setPreviewCollapsed(prev => (prev === collapsed ? prev : collapsed));
    });
    return () => scrollY.removeListener(id);
  }, [scrollY]);

  const showGenre = postType !== 'audio' || audioKind === 'audio';
  const hasMedia = postType === 'audio' ? !!audioFile : postType === 'slideshow' ? slides.length > 0 : !!media;
  const slideshowMode = postType === 'slideshow';
  const lastSlide = slides.length ? slides[slides.length - 1] : null; // most recent — shown on the square

  // Apply the picked communities: force Public, and set the genre to the shared
  // genre if they all agree, else clear it (mixed communities → "no genre").
  const hasCommunity = communities.length > 0;
  function applyCommunities(list: PostableCommunity[]) {
    setCommunities(list);
    if (list.length > 0) {
      setIsPublic(true);
      const genres = new Set(list.map((c) => c.genre));
      setGenre(genres.size === 1 ? list[0].genre : ''); // one shared genre, else no genre
    }
  }

  function resetAll() {
    if (recActiveRef.current) { audioRecorder.stop().catch(() => {}); recActiveRef.current = false; }
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    unloadPreview();
    setIsRecording(false); setRecSecs(0);
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null; setSlides([]);
    setVideoDuration(0); setTrimStart(0);
    setAudioFile(null); setAudioDuration(null); setCoverUri(null); setAudioKind('audio');
    setCaption(''); setGenre(''); setSong(null); setTagged([]); setCommunities([]); setError(''); setStep('pick');
    setAllowDownloads(true); setAllowGifs(true);
    // Abandoning the compose drops any parked spotlight handoff so it can't
    // silently attach to an unrelated later post — the paid campaign itself
    // stays safe as `pending` on the Spotlight screen. (No-op on the share
    // path: the campaign was already consumed before resetAll runs.)
    clearPendingSpotlight(); setPendingSpotBanner(null);
    // Drop the resumed-draft link — the next compose is a fresh post unless the
    // user opens a draft again. (The draft row itself is untouched here; it's
    // removed explicitly on publish, or kept if the user just navigated away.)
    editingDraftId.current = null;
  }

  // ─── Drafts (saved locally) ──────────────────────────────────────────────────
  // Snapshot the current composer state into a draft. Re-saving a resumed draft
  // updates it in place. Media stays on-device and is uploaded only on Share.
  async function handleSaveDraft() {
    if (!hasMedia) {
      setError(postType === 'audio' ? t('post.selectAudioFirst')
        : postType === 'slideshow' ? t('post.addSlideFirst')
        : t(postType === 'image' ? 'post.selectImageFirst' : 'post.selectVideoFirst'));
      return;
    }
    // Capture the live crop the cropper holds while it's still mounted (pick
    // step). On the details step goNext already stored it into cropRef.
    if (step === 'pick') {
      if (postType === 'image') cropRef.current = cropperRef.current?.getCrop() ?? cropRef.current;
      if (postType === 'slideshow') captureLastSlideCrop();
    }
    const now = Date.now();
    const id = editingDraftId.current ?? makeDraftId();
    const draft: Draft = {
      id, createdAt: now, updatedAt: now,
      postType, format, caption, genre, isPublic,
      media, crop: cropRef.current as any, thumbnailUri,
      videoAspect, videoDuration, trimStart,
      slides,
      audioFile, audioDuration, coverUri, audioKind,
      song, tagged,
      allowDownloads, allowGifs,
    };
    const next = await saveDraft(draft);
    setDrafts(next);
    resetAll(); // clears the composer + the editing link (lands back on the pick step)
    setSavedToast(true); // polished in-app confirmation (replaces the default OS alert)
  }

  // Load a saved draft back into the composer and jump to the details step.
  function resumeDraft(d: Draft) {
    editingDraftId.current = d.id;
    setPostType(d.postType);
    setFormat(d.format);
    setCaption(d.caption);
    setGenre(d.genre);
    setIsPublic(d.isPublic);
    setMedia(d.media);
    cropRef.current = (d.crop as any) ?? null;
    setThumbnailUri(d.thumbnailUri);
    setVideoAspect(d.videoAspect);
    setVideoDuration(d.videoDuration);
    setTrimStart(d.trimStart);
    setSlides(d.slides ?? []);
    setPickedId(null);
    setAudioFile(d.audioFile);
    setAudioDuration(d.audioDuration);
    setCoverUri(d.coverUri);
    setAudioKind(d.audioKind);
    setSong(d.song);
    setTagged(d.tagged ?? []);
    setAllowDownloads(d.allowDownloads ?? true);
    setAllowGifs(d.allowGifs ?? true);
    setError('');
    setDraftsOpen(false);
    setStep('details');
  }

  // Open the polished confirm dialog (replaces the default OS alert).
  function confirmDeleteDraft(d: Draft) { setDeleteTarget(d); }

  async function performDeleteDraft() {
    const d = deleteTarget;
    if (!d) return;
    setDeleteTarget(null);
    const next = await deleteDraft(d.id);
    setDrafts(next);
    if (editingDraftId.current === d.id) editingDraftId.current = null;
  }

  function switchType(t: PostType) {
    setPostType(t);
    setFormat(t === 'slideshow' ? '1:1' : defaultFormatFor(t as any));
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null; setSlides([]);
    setVideoDuration(0); setTrimStart(0);
    setAudioFile(null); setAudioDuration(null);
    setSong(null); setTagged([]);
    forgetResumedDraft(); // the resumed draft's media is gone — stop tracking it
  }

  function cycleFormat() {
    const i = IMAGE_FORMATS.indexOf(format as any);
    setFormat(IMAGE_FORMATS[(i + 1) % IMAGE_FORMATS.length]);
  }

  async function onPickMedia(m: PickedMedia) {
    // Tapping a thumbnail (even far down the grid) snaps back to the top so the
    // collapsing preview re-expands and shows the media that was just picked.
    photoGridRef.current?.scrollToTop();
    // Long videos are never rejected — the edit step's trimmer picks a
    // 3-minute window out of them instead.
    if (m.type !== postType) setFormat(defaultFormatFor(m.type as any)); // image↔video
    setPostType(m.type);
    setPickedId(m.id);
    setMedia({ uri: m.uri, width: m.width, height: m.height, posterUri: m.posterUri });
    setThumbnailUri(null);
    // Freshly picked media starts at the centered cover crop — drop any crop
    // carried over from a previous selection (the cropper now seeds from
    // cropRef via initialCrop, so a stale value would mis-position the new pick).
    cropRef.current = null;
    if (m.type === 'video') {
      setVideoAspect(clampVideoAspect((m.width || 1) / (m.height || 1)));
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
    forgetResumedDraft();
  }
  function enterSingle() {
    if (postType !== 'slideshow') return;
    setPostType('image'); setFormat('1:1'); setSlides([]);
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null;
    forgetResumedDraft();
  }
  function enterSlideshow() {
    if (postType === 'slideshow') return;
    setPostType('slideshow'); setFormat('1:1');
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null;
    forgetResumedDraft();
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
    if (slides.length >= MAX_SLIDES) { Alert.alert(t('post.limitReachedTitle'), t('post.slideshowMaxBody', { max: MAX_SLIDES })); return; }
    // Slides have no trim editor, so slideshows keep hard duration gates: one
    // clip can't exceed the video budget, and neither can all clips combined.
    if (m.type === 'video' && m.duration != null && m.duration > SLIDESHOW_VIDEO_BUDGET_SEC) {
      Alert.alert(
        t('post.clipTooLongTitle'),
        t('post.clipTooLongBody'),
      );
      return;
    }
    if (m.type === 'video' && slideshowVideoSecs(slides) + (m.duration ?? 0) > SLIDESHOW_VIDEO_BUDGET_SEC) {
      Alert.alert(
        t('post.slideshowVideoLimitTitle'),
        t('post.slideshowVideoLimitBody1'),
      );
      return;
    }
    let thumb: string | null = null;
    if (m.type === 'video') { try { const { uri } = await VideoThumbnails.getThumbnailAsync(m.uri, { time: 1000 }); thumb = uri; } catch {} }
    setSlides(prev => prev.length >= MAX_SLIDES ? prev
      : [...prev, {
          id: m.id, uri: m.uri, type: m.type, width: m.width, height: m.height,
          durationSec: m.type === 'video' ? m.duration ?? null : null,
          thumbnailUri: thumb, posterUri: m.posterUri,
        }]);
  }
  function removeSlideById(id: string) { setSlides(prev => prev.filter(s => s.id !== id)); }
  // Tabs: "Posts" returns from Music; "Music" is switchType('audio').
  function selectPostsTab() { if (postType === 'audio') switchType('image'); }

  async function startRecording() {
    await unloadPreview();
    stop(); // background music would bleed into (and distract from) the recording
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(t('post.micNeededTitle'), t('post.micNeededBody'));
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      recActiveRef.current = true;
      setRecSecs(0);
      setIsRecording(true);
      // expo-audio has no status-update cadence callback — poll the recorder's
      // elapsed time (seconds) to drive the on-screen timer.
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      recTimerRef.current = setInterval(() => {
        setRecSecs(Math.floor(audioRecorder.currentTime || 0));
      }, 500);
    } catch (e: any) {
      Alert.alert(t('post.recordStartFailTitle'), e?.message ?? t('post.tryAgain'));
    }
  }

  async function stopRecording() {
    if (!recActiveRef.current) return;
    recActiveRef.current = false;
    setIsRecording(false);
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    const dur = recSecs;
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
    } catch {}
    const uri = audioRecorder.uri;
    if (!uri) return;
    if (dur > SPOKEN_MAX_SEC) {
      Alert.alert(t('post.recordingTooLongTitle'), t('post.audioMaxBody', { duration: fmtMins(SPOKEN_MAX_SEC) }));
      return;
    }
    setAudioFile({ uri, name: uri.split('/').pop() || `recording-${Date.now()}.m4a`, mimeType: 'audio/m4a' });
    setAudioDuration(dur || null);
  }

  async function unloadPreview() {
    if (previewSubRef.current) { previewSubRef.current.remove(); previewSubRef.current = null; }
    if (previewSoundRef.current) { try { previewSoundRef.current.remove(); } catch {} previewSoundRef.current = null; }
    setIsPreviewPlaying(false);
  }

  // Let the user hear the recorded/selected audio before posting.
  async function togglePreview() {
    if (!audioFile) return;
    stop(); // never layer the preview over background music
    try {
      if (previewSoundRef.current) {
        const p = previewSoundRef.current;
        if (isPreviewPlaying) { p.pause(); setIsPreviewPlaying(false); }
        else { p.play(); setIsPreviewPlaying(true); }
        return;
      }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const player = createAudioPlayer({ uri: audioFile.uri });
      previewSoundRef.current = player;
      setIsPreviewPlaying(true);
      previewSubRef.current = player.addListener('playbackStatusUpdate', (s: any) => {
        if (s.isLoaded && s.didJustFinish) { setIsPreviewPlaying(false); player.seekTo(0).catch(() => {}); }
      });
      player.play();
    } catch (e: any) {
      Alert.alert(t('post.playbackFailTitle'), e?.message ?? t('post.playbackFailBody'));
    }
  }

  async function pickAudio() {
    await unloadPreview();
    const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];

    const probed = await probeAudioDurationSec(asset.uri);
    const dur: number | null = probed != null ? Math.floor(probed) : null;

    // Absolute ceiling (podcasts/audiobooks). The tighter 6-min music limit is
    // enforced on Share, since the category is chosen on the next step.
    if (dur != null && dur > SPOKEN_MAX_SEC) {
      Alert.alert(t('post.audioTooLongTitle'), t('post.audioMaxBody', { duration: fmtMins(SPOKEN_MAX_SEC) }));
      return;
    }
    if (asset.size != null && asset.size > AUDIO_MAX_BYTES) {
      Alert.alert(t('post.audioTooLargeTitle'), t('post.audioTooLargeBody'));
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
      setError(postType === 'audio' ? t('post.selectAudioFirst')
        : postType === 'slideshow' ? t('post.addSlideFirst')
        : t(postType === 'image' ? 'post.selectImageFirst' : 'post.selectVideoFirst'));
      return;
    }
    setError('');
    if (postType === 'image') cropRef.current = cropperRef.current?.getCrop() ?? null;
    if (postType === 'slideshow') captureLastSlideCrop();
    // Long videos go through the trim editor to pick a 3-minute window.
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
    if (!caption.trim()) { setError(t('post.errCaption')); return; }
    // Spotlights only serve public posts — a friends-only spotlight would buy
    // invisible reach.
    if (pendingSpot && !isPublic) {
      Alert.alert(
        t('post.spotlightPublicTitle'),
        t('post.spotlightPublicBody'),
      );
      return;
    }
    // Re-check the slideshow video budget at the Share button (slides can be
    // added/removed after the add-time gate) — BEFORE any upload work starts.
    if (postType === 'slideshow' && slideshowVideoSecs(slides) > SLIDESHOW_VIDEO_BUDGET_SEC) {
      Alert.alert(
        t('post.slideshowVideoLimitTitle'),
        t('post.slideshowVideoLimitBody2'),
      );
      return;
    }
    if (postType === 'audio' && audioDuration != null) {
      if (audioDuration < AUDIO_MIN_SEC) {
        Alert.alert(t('post.audioTooShortTitle'), t('post.audioTooShortBody', { seconds: AUDIO_MIN_SEC }));
        return;
      }
      const limit = audioKind === 'audio' ? MUSIC_MAX_SEC : SPOKEN_MAX_SEC;
      if (audioDuration > limit) {
        Alert.alert(
          t('post.trackTooLongTitle'),
          audioKind === 'audio'
            ? t('post.musicMaxBody', { duration: fmtMins(MUSIC_MAX_SEC) })
            : t(audioKind === 'podcast' ? 'post.podcastsMaxBody' : 'post.audiobooksMaxBody', { duration: fmtMins(SPOKEN_MAX_SEC) }),
        );
        return;
      }
    }
    setLoading(true); setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Tier gate for PUBLIC posts — checked fresh before any upload work so a
      // full slot count never wastes a long video upload. Friends-only always OK.
      if (isPublic && Number.isFinite(myPostLimit)) {
        const base = () => supabase.from('posts')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('is_public', true);
        const filtered = await base().is('archived_at', null);
        const count = (!filtered.error ? filtered.count : (await base()).count) ?? 0;
        setPublicCount(count);
        if (count >= myPostLimit) {
          setLoading(false);
          const tier = rawTier(profile);
          Alert.alert(
            t('post.publicLimitTitle'),
            tier
              ? t('post.publicLimitTieredBody', { tier: tierLabel(tier), limit: myPostLimit })
              : t('post.publicLimitFreeBody'),
          );
          return;
        }
      }

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
            const upUri = await compressVideoIfPossible(s.uri, setUploadPct);
            setUploadPct(null);
            const ext = (upUri === s.uri ? s.uri.split('.').pop() : 'mp4') || 'mp4';
            url = await uploadToStorageWithProgress('posts', user.id, upUri, ext, 'video/mp4', setUploadPct);
            setUploadPct(null);
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
        mediaUrl = await uploadToStorageWithProgress('posts', user.id, a.uri, ext, a.mimeType || 'audio/mpeg', setUploadPct);
        setUploadPct(null);
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
        // video — duration is the only rule (no size caps). Big files are
        // first compressed to 1080p H.264 on-device (pass-through until the
        // dev client carries the native compressor), then streamed with live
        // progress so long uploads never look hung.
        const upUri = await compressVideoIfPossible(media!.uri, setUploadPct);
        setUploadPct(null);
        const ext = (upUri === media!.uri ? media!.uri.split('.').pop() : 'mp4') || 'mp4';
        mediaUrl = await uploadToStorageWithProgress('posts', user.id, upUri, ext, 'video/mp4', setUploadPct);
        setUploadPct(null);
        if (thumbnailUri) thumbnailUrl = await uploadToStorage(user.id, thumbnailUri, 'jpg', 'image/jpeg');
      }

      const trimmed = postType === 'video' && videoDuration > VIDEO_MAX_SEC;
      const videoDurSec = trimmed ? VIDEO_MAX_SEC : Math.round(videoDuration);

      const { data: newPost, error: postError } = await supabase.from('posts').insert({
        user_id: user.id,
        type: postType === 'audio' ? audioKind : postType,
        media_url: mediaUrl,
        caption: caption.trim(),
        // Posting to a community is always public (the UI locks it; this is the
        // safety net so a community post can never be saved friends-only).
        is_public: hasCommunity ? true : isPublic,
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
        ...(hasCommunity ? { community_ids: communities.map((c) => c.id) } : {}),
        // Creator controls: only send the flag relevant to the media type.
        ...(postType === 'audio' ? { downloadable: allowDownloads } : {}),
        ...(postType === 'video' ? { allow_gifs: allowGifs } : {}),
      }).select('id').single();
      if (postError) throw postError;
      if (isPublic) {
        bumpBadge('posts_created'); // recomputes the Posts badge from the live grid
        setPublicCount((c) => (c == null ? c : c + 1)); // slot hint stays honest
      }

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

      // The "create a brand new post" spotlight path: attach the paid campaign
      // to the post that was just created — the moment the spotlight goes live.
      let spotLabel: string | null = null;
      const ps = peekPendingSpotlight();
      if (ps && newPost?.id) {
        const ok = await activateCampaign(ps.campaignId, newPost.id, ps.days);
        if (ok) spotLabel = ps.label;
        clearPendingSpotlight();
        setPendingSpotBanner(null);
      }

      // If this post came from a saved draft, the draft has now been published
      // — remove it. (resetAll, below, clears the editing link, so capture +
      // delete first.)
      if (editingDraftId.current) deleteDraft(editingDraftId.current).then(setDrafts);

      // Polished in-app confirmation (replaces the default OS alert). Lands on
      // the pick step after resetAll, where the Toast is rendered.
      setPostedToast({
        title: spotLabel ? t('post.postedSpotlightTitle') : t('post.postedTitle'),
        message: spotLabel
          ? t('post.postedSpotlightBody', { duration: spotlightDurationPhrase(spotLabel) })
          : t('post.postedBody'),
        spotlight: !!spotLabel,
      });
      resetAll();
    } catch (err: any) {
      setError(friendlyShareError(err, t));
    }
    setUploadPct(null);
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
          <Text style={styles.headerTitle}>{t('post.trim')}</Text>
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
            initialStart={trimStart}
          />
        </View>
      </View>
    );
  }

  // ─── Details step ──────────────────────────────────────────────────────────
  if (step === 'details') {
    // Prefer the durable ph:// poster over the evictable cache thumbnail for
    // videos (matches the live-preview fallback order elsewhere) so a resumed
    // draft whose cache thumb was cleared still shows an image.
    const thumbUri = postType === 'audio' ? coverUri
      : postType === 'slideshow'
        ? (slides[0] ? (slides[0].type === 'video' ? (slides[0].posterUri || slides[0].thumbnailUri || slides[0].uri) : slides[0].uri) : null)
        : (postType === 'video' ? (thumbnailUri ?? media?.posterUri ?? null) : media?.uri);
    // The display label for the chosen genre (state stores the lowercase value).
    const selGenre = GENRES.find((g) => g.toLowerCase() === genre);
    const selectedGenreLabel = selGenre ? genreLabel(selGenre) : '';
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setStep('pick')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('post.newPost')}</Text>
          <TouchableOpacity style={styles.headerAction} onPress={handleShare} disabled={loading}>
            {loading
              ? uploadPct != null
                ? <Text style={styles.headerActionText}>{Math.round(uploadPct * 100)}%</Text>
                : <ActivityIndicator color={colors.primary} size="small" />
              : <Text style={styles.headerActionText}>{t('post.share')}</Text>}
          </TouchableOpacity>
        </View>

        {/* Real upload progress for big files (3-min videos can be 100s of MB) */}
        {loading && uploadPct != null && (
          <View style={styles.uploadBarTrack}>
            <View style={[styles.uploadBarFill, { width: `${Math.round(uploadPct * 100)}%` }]} />
          </View>
        )}

        <ScrollView contentContainerStyle={styles.detailsContent} keyboardShouldPersistTaps="handled">
          {/* This post is spoken for: a paid spotlight attaches on Share. */}
          {pendingSpot && (
            <View style={styles.adPendingRow}>
              <Ionicons name="sparkles" size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.adPendingTitle}>{t('post.inSpotlight')} · {pendingSpot.label}</Text>
                <Text style={styles.adPendingSub}>{t('post.spotlightStartsOnShare')}</Text>
              </View>
              <TouchableOpacity
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => {
                  // Detach only — the paid campaign stays `pending` on the
                  // Spotlight screen, so the purchase is never lost.
                  clearPendingSpotlight();
                  setPendingSpotBanner(null);
                }}
              >
                <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          )}

          {/* ── Top: bigger preview + Genre/Music dropdowns (image/video/slideshow) */}
          {postType !== 'audio' && (
            <View style={styles.twoCol}>
              {/* Bigger post preview, with a Tag-people shortcut overlaid on it */}
              <View style={styles.previewCol}>
                {thumbUri ? (
                  // ExpoImage renders ph:// reliably and degrades to empty (not a
                  // broken-image glyph) if the file is gone — unlike RN core Image.
                  <ExpoImage source={{ uri: thumbUri }} style={styles.previewBig} contentFit="cover" />
                ) : (
                  <View style={[styles.previewBig, styles.previewBigPlaceholder]}>
                    <Ionicons name="image-outline" size={28} color={colors.textTertiary} />
                  </View>
                )}
                <TouchableOpacity
                  style={styles.tagOverlay}
                  onPress={() => setShowTagModal(true)}
                  accessibilityRole="button"
                  accessibilityLabel={t('post.tagPeople')}
                >
                  <Ionicons name="person-add" size={14} color="#fff" />
                  <Text style={styles.tagOverlayText} numberOfLines={1}>
                    {tagged.length > 0 ? String(tagged.length) : t('post.tagPeople')}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Right column: Genre + Music as compact dropdowns */}
              <View style={styles.rightCol}>
                {showGenre && (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('post.genre')}</Text>
                    {/* Locked when posting to communities: the post takes their
                        shared genre, or "no genre" when they differ. */}
                    <TouchableOpacity style={styles.dropdown} onPress={() => { if (!hasCommunity) setShowGenrePicker(true); }} activeOpacity={hasCommunity ? 1 : 0.8}>
                      <Text style={[styles.dropdownText, !genre && styles.dropdownPlaceholder]} numberOfLines={1}>
                        {selectedGenreLabel || (hasCommunity ? t('post.noGenre') : t('post.selectGenre'))}
                      </Text>
                      <Ionicons name={hasCommunity ? 'lock-closed' : 'chevron-down'} size={16} color={colors.textTertiary} />
                    </TouchableOpacity>
                    {hasCommunity && <Text style={styles.genreLockHint}>{t('post.genreFromCommunity')}</Text>}
                  </View>
                )}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>{t('post.musicLabel')}</Text>
                  <TouchableOpacity style={styles.dropdown} onPress={() => setShowSongPicker(true)} activeOpacity={0.8}>
                    <Ionicons name="musical-notes" size={15} color={song ? colors.primary : colors.textTertiary} />
                    <Text style={[styles.dropdownText, !song && styles.dropdownPlaceholder]} numberOfLines={1}>
                      {song ? song.title : t('post.addMusic')}
                    </Text>
                    {song ? (
                      <TouchableOpacity onPress={() => setSong(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                      </TouchableOpacity>
                    ) : (
                      <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* Audio category */}
          {postType === 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t('post.category')}</Text>
              <View style={styles.row}>
                {([
                  { val: 'audio', icon: 'musical-notes' },
                  { val: 'podcast', icon: 'mic' },
                  { val: 'audiobook', icon: 'book' },
                ] as const).map(({ val, icon }) => {
                  const on = audioKind === val;
                  return (
                    <TouchableOpacity key={val} style={[styles.choice, on && styles.choiceActive]} onPress={() => setAudioKind(val)}>
                      <Ionicons name={icon as any} size={15} color={on ? colors.primary : colors.textSecondary} />
                      <Text style={[styles.choiceText, on && styles.choiceTextActive]}>{t(`post.cat.${val}`)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {/* Cover art (audio) */}
          {postType === 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t('post.coverArt')}</Text>
              <TouchableOpacity style={styles.coverPicker} onPress={pickCover}>
                {coverUri ? (
                  <Image source={{ uri: coverUri }} style={styles.coverPreview} />
                ) : (
                  <View style={styles.coverPlaceholder}><Ionicons name="image-outline" size={24} color={colors.textTertiary} /></View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.coverTitle}>{coverUri ? t('post.coverSelected') : t('post.addCoverArt')}</Text>
                  <Text style={styles.coverSub}>{coverUri ? t('post.coverChangeHint') : t('post.coverHint')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            </View>
          )}

          {/* Genre (audio) — same dropdown control as the non-audio column.
              Locked when posting to communities (shared genre, or "no genre"). */}
          {postType === 'audio' && showGenre && (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('post.genre')}</Text>
              <TouchableOpacity style={styles.dropdown} onPress={() => { if (!hasCommunity) setShowGenrePicker(true); }} activeOpacity={hasCommunity ? 1 : 0.8}>
                <Text style={[styles.dropdownText, !genre && styles.dropdownPlaceholder]} numberOfLines={1}>
                  {selectedGenreLabel || (hasCommunity ? t('post.noGenre') : t('post.selectGenre'))}
                </Text>
                <Ionicons name={hasCommunity ? 'lock-closed' : 'chevron-down'} size={16} color={colors.textTertiary} />
              </TouchableOpacity>
              {hasCommunity && <Text style={styles.genreLockHint}>{t('post.genreFromCommunity')}</Text>}
            </View>
          )}

          {/* Caption — full width */}
          <View style={styles.field}>
            <TextInput
              style={styles.captionBox}
              placeholder={t('post.captionPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={500}
              editable={!swiping}
            />
            <MentionSuggestions
              query={getActiveMentionQuery(caption, caption.length)}
              onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
            />
          </View>

          {/* Communities — multi-select the communities you want this post in */}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{t('communities.postLabel')}</Text>
            <TouchableOpacity style={styles.dropdown} onPress={() => setShowCommunityPicker(true)} activeOpacity={0.8}>
              <Ionicons name="people" size={15} color={hasCommunity ? colors.primary : colors.textTertiary} />
              <Text style={[styles.dropdownText, !hasCommunity && styles.dropdownPlaceholder]} numberOfLines={1}>
                {communities.length === 0 ? t('communities.addToCommunity')
                  : communities.length === 1 ? communities[0].name
                  : t('communities.communityCount', { count: communities.length })}
              </Text>
              {hasCommunity ? (
                <TouchableOpacity onPress={() => setCommunities([])} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : (
                <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
              )}
            </TouchableOpacity>
          </View>

          {/* Public / Private — one button that flips visibility. Posting to a
              community FORCES Public, so the toggle locks to Public (with a
              lock icon) while a community is attached. Remove the community to
              regain the friends-only option. */}
          <TouchableOpacity
            style={[styles.visBtn, hasCommunity && styles.visBtnLocked]}
            onPress={() => { if (hasCommunity) return; setIsPublic((v) => !v); }}
            disabled={hasCommunity}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('post.public')}
          >
            <Ionicons name={hasCommunity || isPublic ? 'globe-outline' : 'people-outline'} size={20} color={colors.primary} />
            <View style={styles.visText}>
              <Text style={styles.visLabel}>{hasCommunity || isPublic ? t('post.public') : t('post.friendsOnly')}</Text>
              <Text style={styles.visSub} numberOfLines={1}>
                {hasCommunity ? t('post.communityPublicLock') : isPublic ? t('post.publicSub') : t('post.friendsOnlySub')}
              </Text>
            </View>
            <Ionicons name={hasCommunity ? 'lock-closed' : 'swap-horizontal'} size={18} color={colors.textTertiary} />
          </TouchableOpacity>

          {/* Badge-tier public slots */}
          {isPublic && publicCount != null && (
            <Text style={[styles.slotHint, Number.isFinite(myPostLimit) && publicCount >= myPostLimit && { color: colors.error }]}>
              {Number.isFinite(myPostLimit)
                ? (rawTier(profile)
                    ? t('post.slotHintTiered', { count: publicCount, limit: myPostLimit, tier: tierLabel(rawTier(profile)) })
                    : t('post.slotHint', { count: publicCount, limit: myPostLimit }))
                : t('post.slotHintUnlimited')}
            </Text>
          )}

          {/* Per-post creator controls (both default ON — flip OFF to opt out).
              Just a title + switch, with a "Learn more" link that opens a themed
              explanation popup (cleaner than a bordered card with body copy). */}
          {postType === 'audio' && (
            <View style={styles.optRow}>
              <Text style={styles.optLabel}>{t('offline.downloadableLabel')}</Text>
              <Switch
                style={styles.optSwitch}
                value={allowDownloads}
                onValueChange={setAllowDownloads}
                trackColor={{ true: colors.primary, false: colors.surfaceLight }}
                thumbColor="#fff"
              />
              <TouchableOpacity onPress={() => setInfo({ icon: 'cloud-download-outline', title: t('offline.downloadableLabel'), body: t('offline.downloadableHelp') })} hitSlop={8}>
                <Text style={styles.learnMore}>{t('post.learnMore')}</Text>
              </TouchableOpacity>
            </View>
          )}
          {postType === 'video' && (
            <View style={styles.optRow}>
              <Text style={styles.optLabel}>{t('post.allowGifsLabel')}</Text>
              <Switch
                style={styles.optSwitch}
                value={allowGifs}
                onValueChange={setAllowGifs}
                trackColor={{ true: colors.primary, false: colors.surfaceLight }}
                thumbColor="#fff"
              />
              <TouchableOpacity onPress={() => setInfo({ icon: 'film-outline', title: t('post.allowGifsLabel'), body: t('post.allowGifsHelp') })} hitSlop={8}>
                <Text style={styles.learnMore}>{t('post.learnMore')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Save as draft — keeps everything (media stays on-device, nothing
              uploaded) to finish and publish later. Disabled mid-upload. */}
          <TouchableOpacity
            style={[styles.draftSaveBtn, loading && styles.draftSaveBtnDisabled]}
            onPress={handleSaveDraft}
            disabled={loading}
          >
            <Text style={styles.draftSaveText}>
              {editingDraftId.current ? t('post.updateDraft') : t('post.saveDraft')}
            </Text>
          </TouchableOpacity>
        </ScrollView>
        <SongPickerModal visible={showSongPicker} onClose={() => setShowSongPicker(false)} onSelect={setSong} />
        <TagPeopleModal visible={showTagModal} initial={tagged} onClose={() => setShowTagModal(false)} onDone={setTagged} />
        <CommunityPickerModal
          visible={showCommunityPicker}
          userId={profile?.id ?? null}
          selectedIds={communities.map((c) => c.id)}
          onClose={() => setShowCommunityPicker(false)}
          onApply={applyCommunities}
          onBrowse={() => router.push('/communities')}
        />

        {/* "Learn more" explanation — a themed centered card (cleaner than a system
            alert), fade + subtle scale in. Tap outside or "Got it" to dismiss. */}
        <Modal visible={!!info} transparent animationType="fade" onRequestClose={() => setInfo(null)} statusBarTranslucent>
          <View style={styles.infoRoot}>
            <Pressable style={styles.infoBackdrop} onPress={() => setInfo(null)} />
            <Animated.View style={[styles.infoCard, { opacity: infoAnim, transform: [{ scale: infoAnim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}>
              <View style={styles.infoIcon}><Ionicons name={(info?.icon ?? 'information-circle-outline') as any} size={26} color={colors.primary} /></View>
              <Text style={styles.infoTitle}>{info?.title}</Text>
              <Text style={styles.infoBody}>{info?.body}</Text>
              <TouchableOpacity style={styles.infoBtn} onPress={() => setInfo(null)} activeOpacity={0.85}>
                <Text style={styles.infoBtnText}>{t('post.gotIt')}</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </Modal>

        {/* Genre picker — a tap-to-open bottom sheet of genre chips. */}
        <Modal visible={showGenrePicker} transparent animationType="fade" onRequestClose={() => setShowGenrePicker(false)}>
          <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setShowGenrePicker(false)}>
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>{t('post.pickGenre')}</Text>
              <ScrollView contentContainerStyle={styles.sheetList} keyboardShouldPersistTaps="handled">
                <TouchableOpacity
                  style={[styles.genreChip, !genre && styles.genreChipActive]}
                  onPress={() => { setGenre(''); setShowGenrePicker(false); }}
                >
                  <Text style={[styles.genreChipText, !genre && styles.genreChipTextActive]}>{t('post.noGenre')}</Text>
                </TouchableOpacity>
                {GENRES.map((g) => {
                  const value = g.toLowerCase();
                  const active = genre === value;
                  return (
                    <TouchableOpacity
                      key={g}
                      style={[styles.genreChip, active && styles.genreChipActive]}
                      onPress={() => { setGenre(value); setShowGenrePicker(false); }}
                    >
                      <Text style={[styles.genreChipText, active && styles.genreChipTextActive]}>{genreLabel(g)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
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
        <Text style={styles.headerTitle}>{t('post.newPost')}</Text>
        <TouchableOpacity style={styles.headerAction} onPress={goNext} disabled={!hasMedia}>
          <Ionicons name="arrow-forward" size={24} color={hasMedia ? colors.primary : colors.textTertiary} />
        </TouchableOpacity>
      </View>

      {/* Drafts opener — only when there are saved drafts to resume. */}
      {drafts.length > 0 && (
        <TouchableOpacity style={styles.draftsBar} onPress={() => setDraftsOpen(true)} activeOpacity={0.7}>
          <Ionicons name="document-text-outline" size={16} color={colors.primary} />
          <Text style={styles.draftsBarText}>
            {t('post.drafts')} <Text style={styles.draftsBarCount}>({drafts.length})</Text>
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>
      )}

      {postType === 'audio' ? (
        isRecording ? (
          // Recording fills the whole page in red — a focused capture screen.
          <View style={styles.recordingFull}>
            <View style={styles.recDot} />
            <Text style={styles.recTimeLg}>{fmtClock(recSecs)}</Text>
            <Text style={styles.recLabel}>{t('post.recording')}</Text>
            <TouchableOpacity style={styles.stopBtn} onPress={stopRecording} activeOpacity={0.85}>
              <Ionicons name="stop" size={22} color={colors.error} />
              <Text style={styles.stopBtnText}>{t('post.stop')}</Text>
            </TouchableOpacity>
          </View>
        ) : audioFile ? (
          <View style={styles.audioPickArea}>
            <View style={styles.audioSelected}>
              {/* Borderless filled-circle glyph, same as Today's Pick */}
              <TouchableOpacity onPress={togglePreview} activeOpacity={0.8} hitSlop={6}>
                <Ionicons name={isPreviewPlaying ? 'pause-circle' : 'play-circle'} size={72} color={colors.primary} />
              </TouchableOpacity>
              <Text style={styles.audioPickTitle} numberOfLines={1}>{audioFile.name || t('post.audioSelected')}</Text>
              <Text style={styles.audioPickSub}>
                {audioDuration != null ? `${fmtClock(audioDuration)} · ` : ''}{isPreviewPlaying ? t('post.playing') : t('post.tapToPreview')}
              </Text>
              <View style={styles.audioSelBtns}>
                <TouchableOpacity style={styles.audioSelBtn} onPress={pickAudio} activeOpacity={0.85}>
                  <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                  <Text style={styles.audioSelBtnText}>{t('post.replace')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.audioSelBtn} onPress={() => { setAudioFile(null); setAudioDuration(null); startRecording(); }} activeOpacity={0.85}>
                  <Ionicons name="mic" size={16} color={colors.text} />
                  <Text style={styles.audioSelBtnText}>{t('post.recordNew')}</Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={[styles.audioPickSub, { marginTop: SPACING.lg, textAlign: 'center' }]}>
              {t('post.audioLimitsHint', { music: fmtMins(MUSIC_MAX_SEC), spoken: fmtMins(SPOKEN_MAX_SEC) })}
            </Text>
          </View>
        ) : (
          // Record / Upload split the FULL area into two halves divided by a shallow
          // diagonal: a rotated, oversized board (clipped to the frame) so the seam
          // reads as a near-horizontal diagonal; content counter-rotates upright.
          <View style={styles.audioChoices}>
            <View style={styles.diagBoard}>
              <TouchableOpacity style={styles.diagHalf} onPress={startRecording} activeOpacity={0.9}>
                <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                <View style={styles.diagContent}>
                  <Ionicons name="mic" size={34} color="#fff" />
                  <Text style={styles.diagTitleOnPrimary}>{t('post.record')}</Text>
                  <Text style={styles.diagSubOnPrimary}>{t('post.recordSub')}</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.diagHalf, styles.diagUpload]} onPress={pickAudio} activeOpacity={0.9}>
                <View style={styles.diagContent}>
                  <Ionicons name="cloud-upload-outline" size={34} color={colors.primary} />
                  <Text style={styles.diagTitle}>{t('post.upload')}</Text>
                  <Text style={styles.diagSub}>MP3 · WAV · M4A</Text>
                </View>
              </TouchableOpacity>
            </View>
            <Text style={styles.audioHint} pointerEvents="none">
              {t('post.audioLimitsHint', { music: fmtMins(MUSIC_MAX_SEC), spoken: fmtMins(SPOKEN_MAX_SEC) })}
            </Text>
          </View>
        )
      ) : (
        <>
          {/* Collapsing preview — single media cropper OR the slideshow cover */}
          <Animated.View style={[styles.previewArea, { height: animatedPreviewH }]}>
            {slideshowMode ? (
              lastSlide ? (
                lastSlide.type === 'image' ? (
                  <ErrorBoundary label={t('post.cantOpenPhoto')}>
                    <MediaCropper
                      key={`${lastSlide.uri}-${previewAspect}`}
                      ref={cropperRef}
                      uri={lastSlide.uri}
                      mediaWidth={lastSlide.width}
                      mediaHeight={lastSlide.height}
                      frameW={frameW}
                      frameH={frameH}
                      type="image"
                      initialCrop={lastSlide.crop}
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
                  <Text style={styles.previewPlaceholderText}>{t('post.slideshowPlaceholder')}</Text>
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
                <ErrorBoundary label={t('post.cantOpenPhoto')}>
                  <MediaCropper
                    key={`${media.uri}-${previewAspect}`}
                    ref={cropperRef}
                    uri={media.uri}
                    mediaWidth={media.width}
                    mediaHeight={media.height}
                    frameW={frameW}
                    frameH={frameH}
                    type="image"
                    initialCrop={cropRef.current}
                  />
                </ErrorBoundary>
              )
            ) : (
              <View style={[styles.previewPlaceholder, { width: frameW, height: frameH }]}>
                <Ionicons name="image-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.previewPlaceholderText}>{t('post.pickPlaceholder')}</Text>
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
            {/* While scrolled down, tapping the shrunken preview snaps the gallery
                back to the top and re-expands it (cropper is unusable at this size,
                so capturing the tap here is safe). */}
            {previewCollapsed && (
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={() => photoGridRef.current?.scrollToTop()}
              />
            )}
          </Animated.View>

          {/* Single / Slideshow toggle + hint */}
          <View style={styles.recentsRow}>
            <View style={styles.modeToggle}>
              <TouchableOpacity onPress={enterSingle} style={[styles.modePill, !slideshowMode && styles.modePillActive]}>
                <Text style={[styles.modePillText, !slideshowMode && styles.modePillTextActive]}>{t('post.single')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={enterSlideshow} style={[styles.modePill, slideshowMode && styles.modePillActive]}>
                <Text style={[styles.modePillText, slideshowMode && styles.modePillTextActive]}>{t('post.slideshow')}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.recentsHint}>
              {slideshowMode ? t('post.slideshowCountHint', { count: slides.length, max: MAX_SLIDES }) : t('post.tapPhotoVideo')}
            </Text>
          </View>

          {/* One grid for all camera media (photos + videos) */}
          <View style={{ flex: 1 }}>
            <ErrorBoundary label={t('post.cantOpenPhotos')}>
              <PhotoGrid
                ref={photoGridRef}
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
        <TouchableOpacity onPress={selectPostsTab} activeOpacity={0.85} style={styles.typeStripBtn}>
          <Text style={[styles.typeStripText, postType !== 'audio' && styles.typeStripTextActive]}>{t('post.tabPosts')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => switchType('audio')} activeOpacity={0.85} style={styles.typeStripBtn}>
          <Text style={[styles.typeStripText, postType === 'audio' && styles.typeStripTextActive]}>{t('post.tabMusic')}</Text>
        </TouchableOpacity>
      </View>

      {/* Saved drafts — resume or delete. Local to this device. */}
      <Modal visible={draftsOpen} animationType="slide" onRequestClose={() => setDraftsOpen(false)}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBtn} onPress={() => setDraftsOpen(false)}>
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('post.drafts')}</Text>
            <View style={{ width: 64 }} />
          </View>
          {drafts.length === 0 ? (
            <View style={styles.draftsEmpty}>
              <Ionicons name="document-text-outline" size={44} color={colors.textTertiary} />
              <Text style={styles.draftsEmptyTitle}>{t('post.noDrafts')}</Text>
              <Text style={styles.draftsEmptySub}>{t('post.noDraftsSub')}</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.draftsList}>
              <Text style={styles.draftsHint}>{t('post.draftsHint')}</Text>
              {drafts.map((d) => {
                const thumb = draftThumb(d);
                return (
                  <TouchableOpacity key={d.id} style={styles.draftRow} onPress={() => resumeDraft(d)} activeOpacity={0.8}>
                    {thumb ? (
                      <ExpoImage source={{ uri: thumb }} style={styles.draftThumb} contentFit="cover" />
                    ) : (
                      <View style={[styles.draftThumb, styles.draftThumbPlaceholder]}>
                        <Ionicons name="musical-notes" size={20} color={colors.primary} />
                      </View>
                    )}
                    <View style={styles.draftInfo}>
                      <Text style={styles.draftCaption} numberOfLines={1}>{draftSummary(d)}</Text>
                      <Text style={styles.draftMeta}>
                        {d.postType === 'audio' ? t(`post.cat.${d.audioKind}`)
                          : t(`post.type.${d.postType}`)}
                        {' · '}{new Date(d.updatedAt).toLocaleDateString()}
                        {!d.isPublic ? ` · ${t('post.friendsOnly')}` : ''}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.draftDelete}
                      onPress={() => confirmDeleteDraft(d)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      accessibilityRole="button"
                      accessibilityLabel={t('common.delete')}
                    >
                      <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* Delete-draft confirmation — overlays the drafts list. */}
          <ConfirmDialog
            visible={!!deleteTarget}
            icon="trash"
            destructive
            title={t('post.deleteDraftTitle')}
            message={t('post.deleteDraftBody')}
            confirmLabel={t('common.delete')}
            onConfirm={performDeleteDraft}
            onCancel={() => setDeleteTarget(null)}
          />
        </View>
      </Modal>

      {/* Draft-saved confirmation — lands here after handleSaveDraft resets to pick. */}
      <Toast
        visible={savedToast}
        icon="checkmark-circle"
        title={t('post.savedDraftTitle')}
        message={t('post.savedDraftBody')}
        bottomOffset={SPACING.xxl + SPACING.md}
        onHide={() => setSavedToast(false)}
      />

      {/* Posted! confirmation — replaces the default OS alert after a share. */}
      <Toast
        visible={!!postedToast}
        icon={postedToast?.spotlight ? 'sparkles' : 'checkmark-circle'}
        title={postedToast?.title ?? ''}
        message={postedToast?.message}
        duration={postedToast?.spotlight ? 3800 : 2800}
        bottomOffset={SPACING.xxl + SPACING.md}
        onHide={() => setPostedToast(null)}
      />
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
  // Byte-level upload progress under the header while a big file streams up.
  uploadBarTrack: { height: 3, backgroundColor: colors.surfaceLight, overflow: 'hidden' },
  uploadBarFill: { height: 3, backgroundColor: colors.primary },

  previewArea: { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.xs, overflow: 'hidden' },
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
  modePillActive: { backgroundColor: '#fff', ...SHADOWS.sm },
  modePillText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  modePillTextActive: { color: '#000' },

  // Bottom Posts | Music strip — two equal halves, centered labels, same (dark)
  // background; the active label is orange and bolder.
  typeStrip: {
    flexDirection: 'row', alignItems: 'stretch',
    borderTopWidth: 0.5, borderTopColor: colors.border,
  },
  typeStripBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md },
  typeStripText: { color: colors.textTertiary, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  typeStripTextActive: { color: colors.primary, fontWeight: '900' },

  audioPickArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  audioPickBtn: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl,
    borderWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed', borderRadius: RADIUS.lg,
    width: '100%',
  },
  audioPickTitle: { color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  audioPickSub: { color: colors.textTertiary, fontSize: 13, textAlign: 'center' },

  // Record / Upload as two halves split by a shallow diagonal. The board is
  // oversized + rotated and clipped by the rounded card, so its centre seam reads
  // as a near-horizontal diagonal; content counter-rotates back to upright.
  audioChoices: { flex: 1, width: '100%', overflow: 'hidden' },
  diagBoard: { position: 'absolute', top: -80, bottom: -80, left: -80, right: -80, transform: [{ rotate: '-7deg' }] },
  audioHint: {
    position: 'absolute', left: 0, right: 0, bottom: SPACING.md,
    color: 'rgba(255,255,255,0.75)', fontSize: 12, textAlign: 'center', paddingHorizontal: SPACING.lg,
  },
  diagHalf: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  diagUpload: { backgroundColor: colors.surfaceElevated, borderTopWidth: 2, borderTopColor: colors.background },
  diagContent: { alignItems: 'center', gap: SPACING.xs, transform: [{ rotate: '7deg' }] },
  diagTitleOnPrimary: { color: '#fff', fontSize: 18, fontWeight: '800' },
  diagSubOnPrimary: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' },
  diagTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  diagSub: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },

  // Full-page recording screen — the whole area goes red.
  recordingFull: {
    flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.md, backgroundColor: colors.error,
  },
  recDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff' },
  recTimeLg: { color: '#fff', fontSize: 64, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 1 },
  recLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  stopBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginTop: SPACING.md,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.xl,
  },
  stopBtnText: { color: colors.error, fontSize: 15, fontWeight: '800' },

  audioSelected: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl, width: '100%',
  },
  audioSelBtns: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  audioSelBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: SPACING.sm + 1, paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight,
  },
  audioSelBtnText: { color: colors.text, fontSize: 13.5, fontWeight: '700' },

  // details
  detailsContent: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },

  // Top row of the details step: bigger preview + the genre/music dropdowns.
  twoCol: { flexDirection: 'row', gap: SPACING.md },
  previewCol: {
    width: DETAILS_PREVIEW, height: DETAILS_PREVIEW,
    borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: colors.surfaceLight,
  },
  previewBig: { width: '100%', height: '100%' },
  previewBigPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  tagOverlay: {
    position: 'absolute', left: SPACING.xs, bottom: SPACING.xs,
    maxWidth: DETAILS_PREVIEW - SPACING.sm,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: SPACING.sm,
  },
  tagOverlayText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  rightCol: { flex: 1, gap: SPACING.sm },
  field: { gap: 6 },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  dropdown: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, minHeight: 46,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.sm + 2, paddingVertical: SPACING.sm,
  },
  dropdownText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  dropdownPlaceholder: { color: colors.textTertiary, fontWeight: '500' },
  genreLockHint: { color: colors.textTertiary, fontSize: 11, marginTop: 3 },

  // Full-width caption box.
  captionBox: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm + 2, minHeight: 88,
    color: colors.text, fontSize: 15, textAlignVertical: 'top',
  },

  // Public/Private pill button.
  visBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.full, paddingVertical: SPACING.md, paddingHorizontal: SPACING.lg,
  },
  // Visibility locked to Public because a community is attached.
  visBtnLocked: { opacity: 0.7 },
  visText: { flex: 1 },
  visLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  visSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  // Per-post creator controls (Allow downloads / Allow GIFs) — no outline: the
  // title, the switch left-aligned under it, then a small grey "Learn more" link.
  optRow: { marginTop: SPACING.lg, alignItems: 'flex-start', gap: SPACING.sm },
  optLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  optSwitch: { alignSelf: 'flex-start' },
  learnMore: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
  // "Learn more" explanation popup.
  infoRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  infoBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  infoCard: {
    width: '100%', maxWidth: 340, backgroundColor: colors.surfaceElevated,
    borderRadius: RADIUS.xl, borderWidth: 1, borderColor: colors.border,
    padding: SPACING.lg, alignItems: 'center',
  },
  infoIcon: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '22',
    alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.sm,
  },
  infoTitle: { color: colors.text, fontSize: 18, fontWeight: '800', textAlign: 'center', letterSpacing: -0.3 },
  infoBody: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: SPACING.xs },
  infoBtn: {
    alignSelf: 'stretch', backgroundColor: colors.primary, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md, marginTop: SPACING.md,
  },
  infoBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Genre picker bottom sheet.
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl, maxHeight: '70%',
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: SPACING.sm },
  sheetList: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, paddingBottom: SPACING.sm },

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

  // Genre chips — reused inside the genre picker bottom sheet.
  genreChip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
  },
  genreChipActive: { backgroundColor: colors.primary + '22', borderColor: colors.primary },
  genreChipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  genreChipTextActive: { color: colors.primary },

  adPendingRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.primary + '11', borderWidth: 1, borderColor: colors.primary + '55',
    borderRadius: RADIUS.md, padding: SPACING.sm + 2,
  },
  adPendingTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  adPendingSub: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
  slotHint: { color: colors.textTertiary, fontSize: 12, marginTop: -SPACING.xs, paddingHorizontal: SPACING.xs },

  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { color: colors.error, fontSize: 13 },

  // Save-as-draft button (details step)
  draftSaveBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: RADIUS.full,
    paddingVertical: SPACING.md, marginTop: SPACING.xs,
  },
  draftSaveBtnDisabled: { opacity: 0.5 },
  draftSaveText: { color: colors.primary, fontSize: 14, fontWeight: '800' },

  // Drafts opener bar (pick step)
  draftsBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  draftsBarText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  draftsBarCount: { color: colors.textSecondary, fontWeight: '600' },

  // Drafts modal
  draftsList: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.xxl },
  draftsHint: { color: colors.textTertiary, fontSize: 12, paddingHorizontal: SPACING.xs, paddingBottom: SPACING.xs },
  draftRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  draftThumb: { width: 52, height: 52, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  draftThumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  draftInfo: { flex: 1 },
  draftCaption: { color: colors.text, fontSize: 14, fontWeight: '600' },
  draftMeta: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },
  draftDelete: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
  },

  draftsEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.lg },
  draftsEmptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  draftsEmptySub: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
});
