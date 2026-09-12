import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, ActivityIndicator, Alert, Image, Dimensions, Animated, Modal, Switch, Pressable, Easing,
  Keyboard, Platform, LayoutAnimation,
} from 'react-native';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync, createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { probeAudioDurationSec } from '../../lib/audioProbe';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import {
  type Album, fetchAlbums, createAlbum, addTrack as addAlbumTrack,
} from '../../lib/albums';
import { bumpBadge, publicPostLimit, postKindOf, MUSIC_POST_TYPES, rawTier, tierLabel } from '../../lib/badges';
import { useProfile } from '../../contexts/ProfileContext';
import { usePremium } from '../../contexts/PremiumContext';
import { FILM_MIN_SEC, FILM_MAX_SEC } from '../../lib/entitlements';
import { probeVideo } from '../../lib/videoProbe';
import { getNetworkState } from '../../lib/network';
import { processMentions, getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { checkFields } from '../../lib/contentFilter';
import { DEFAULT_SOUND_OPT_IN } from '../../lib/sounds';
import { viewerIsMinor } from '../../lib/minors';
import { createNotification } from '../../lib/createNotification';
import { notifySuccess } from '../../lib/haptics';
import MentionSuggestions from '../../components/MentionSuggestions';
import TagPeopleModal, { type TaggedPerson } from '../../components/TagPeopleModal';
import VideoStudio, { type StudioResult } from '../../components/VideoStudio';
import CaptureCamera, { type CapturedMedia } from '../../components/CaptureCamera';
import SchedulePicker from '../../components/SchedulePicker';
import PostedCelebration, { type Celebration } from '../../components/PostedCelebration';
import PullDownMenu, { type MenuAnchor, type MenuOption } from '../../components/PullDownMenu';
import { canSaveFinishedVideo, queueFinishedVideoSave, reportSaveSkipped, requestSavePermission } from '../../lib/videoExport';
import { FullWindowOverlay } from 'react-native-screens';
import { openShareGlobal } from '../../contexts/ShareContext';
import { formatSchedule, scheduleProblem } from '../../lib/schedule';
import { scheduleLiveReminder } from '../../lib/scheduleNotify';
import { mixColumns, type SongMix } from '../../lib/songMix';
import type { Sticker } from '../../components/StickerLayer';
import { splitForPublish, timingForPublish } from '../../lib/stickerTiming';
import { bandStickersFromLegacy, isBandSticker, legacyBandCaption } from '../../lib/bandCaptions';
import FeaturesModal from '../../components/FeaturesModal';
import { type Feature } from '../../lib/features';
import { useAudioControls } from '../../contexts/AudioContext';
import { SPACING, RADIUS, GRADIENTS, SHADOWS, isDarkPalette, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { showPermissionDenied } from '../../lib/permissions';
import {
  IMAGE_FORMATS, aspectToNumber, clampVideoAspect, defaultFormatFor,
  defaultSlideFit, isAutoFormat, resolveFrameAspect, slideshowCanvasAspect, slideFitFor,
  centeredCrop, type SlideFit,
} from '../../lib/aspectRatio';
import { GENRES, genreLabel } from '../../lib/genres';
import { Image as ExpoImage } from 'expo-image';
import MediaCropper, { type MediaCropperHandle, type CropRect } from '../../components/MediaCropper';
import SlideArranger, { type SlideArrangerHandle } from '../../components/SlideArranger';
import PhotoGrid, { type PickedMedia, type PhotoGridHandle } from '../../components/PhotoGrid';
import { MAX_SLIDES, type Slide } from '../../lib/slideshow';
import { uploadToStorageWithProgress, compressVideoIfPossible, fileSizeBytes } from '../../lib/upload';
import { useUploadActions } from '../../contexts/UploadQueueContext';
import { peekPendingSpotlight, clearPendingSpotlight, activateCampaign, spotlightDurationPhrase } from '../../lib/spotlight';
import {
  loadDrafts, saveDraft, deleteDraft, draftThumb, draftSummary, makeDraftId, consumeResumeDraftId, type Draft,
} from '../../lib/drafts';
import SongPickerModal, { type PickedSong } from '../../components/SongPickerModal';
import CommunityPickerModal from '../../components/CommunityPickerModal';
import { type PostableCommunity } from '../../lib/communities';
import VideoTrimmer from '../../components/VideoTrimmer';
import ErrorBoundary from '../../components/ErrorBoundary';
import Toast from '../../components/Toast';
import ConfirmDialog from '../../components/ConfirmDialog';

type PostType = 'image' | 'video' | 'audio' | 'slideshow';
type Step = 'pick' | 'edit' | 'arrange' | 'studio' | 'details';

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
  // How this slide meets the frame. Now DERIVED from `shape` for any slide that
  // has one; still read here for slides that predate shapes, which stored it
  // directly.
  fit?: SlideFit | null;
  // What this slide is cropped to — 'full'/unset means uncropped. Per-slide, so
  // one photo can be square and the next left whole inside the same carousel.
  // See SlideArranger's ArrangerSlide, which this mirrors.
  shape?: string | null;
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
// iOS system colours for the details step's two menu buttons: who sees the post,
// and when it goes up.
const IOS_BLUE = '#007AFF';
const IOS_GREEN = '#34C759';
const IOS_ORANGE = '#FF9500';
const IOS_INDIGO = '#5856D6';

// Duration limits (seconds). Duration is the ONLY rule for videos — there are
// deliberately NO file-size caps (an iPhone HD clip can be hundreds of MB and
// must never be rejected for it; the storage bucket's limit is raised to
// match). Videos longer than the cap aren't rejected either: the trim editor
// lets the user pick a window.
//
// The window is PER-ORIENTATION: vertical stays short-form, landscape gets
// long-form room for Laybell TV (performances, sets, video podcasts). The same
// `videoAspect > 1` rule that already routes captions and the reel pager
// decides which window applies — a square clip counts as vertical. 9 minutes
// is the ceiling the upload pipeline can actually deliver: the uploader is a
// single multipart POST capped by Cloudflare at 200 MB, and 9 min of 1080p at
// the adaptive bitrate (lib/upload.ts) lands under that with headroom. Going
// longer means migrating the uploader to tus first.
const VIDEO_MAX_SEC   = 180;     // 3 min — vertical (and square) WINDOW
const VIDEO_MAX_SEC_H = 540;     // 9 min — landscape WINDOW (Laybell TV)
// Trimming a long clip is VIRTUAL: we store trim_start/trim_end and upload the
// FULL source file (no re-encode). Cloudflare, meanwhile, rejects any direct
// upload longer than the maxDurationSeconds its upload URL was minted with — so
// the ceiling we request has to cover the SOURCE, not the 3-minute window, and
// sources past what stream-direct-upload will grant (it clamps at 600) have to
// be refused up front. Sending the window ceiling was the bug that let a long
// video fail on Cloudflare's side AFTER the composer had already said "Posted",
// leaving a permanently unplayable post in the feed.
const VIDEO_SOURCE_MAX_SEC = 600; // 10 min — matches the edge function's clamp
// When the duration is UNKNOWN (0 — a picker that didn't report one) we ask for
// the maximum rather than the minimum: under-asking is what makes Cloudflare
// reject the upload later, and asking high costs nothing (Stream bills actual
// stored minutes, not the ceiling the upload URL was minted with).
// sourceMaxSec is per-tier: 10 minutes normally, the film ceiling for a
// Premium+ landscape pick (films mint through stream-tus-upload, which clamps
// to the same number server-side).
// +90s cushion, not +30: pickers report container duration, which can run
// SHORT of the true stream length (VFR clips, rounding) — and Cloudflare
// KILLS the encode of anything past the minted ceiling, after the entire
// upload has already succeeded. The ceiling is billing-reserved, not billed,
// so generosity here costs nothing and a tight fit costs the whole post.
const streamCeilingFor = (sourceSec: number, sourceMaxSec: number = VIDEO_SOURCE_MAX_SEC) =>
  sourceSec > 0
    ? Math.min(sourceMaxSec, Math.max(VIDEO_MAX_SEC, Math.ceil(sourceSec)) + 90)
    : sourceMaxSec;
// A Premium+ film source may run past the 1-hour film window by the same cushion the
// free tier gets over ITS window (trim picks the window out of it).
const FILM_SOURCE_MAX_SEC = FILM_MAX_SEC + 60;
const MUSIC_MAX_SEC  = 12 * 60;  // music tracks — live cuts, mixes and extended
                                 // versions routinely run past the old 6-minute
                                 // cap on a music-first app
const SPOKEN_MAX_SEC = 35 * 60;  // podcasts / audiobooks
const AUDIO_MIN_SEC  = 5;        // global minimum length for any audio

// Audio file-size cap (video is bounded by its duration windows instead).
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
  const { colors, mode } = useTheme();
  // Ink for the Upload half. Dark themes get a white slab, so its content is
  // near-black; light keeps its raised off-white and its normal text colours.
  const uploadInk = mode === 'light' ? colors.text : '#101010';
  const uploadInkSoft = mode === 'light' ? colors.textSecondary : '#5A5A5A';
  const { t, lang } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [step, setStep] = useState<Step>('pick');
  const [postType, setPostType] = useState<PostType>('image');
  const [format, setFormat] = useState<string>('1:1');

  // slideshow selection (up to MAX_SLIDES images/videos, shared aspect ratio = `format`)
  const [slides, setSlides] = useState<PickedSlide[]>([]);

  // image/video selection
  const [media, setMedia] = useState<{ uri: string; width: number; height: number; posterUri?: string } | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null); // grid asset id of the single selection
  // A video's cover: a frame grabbed at pick time, until the studio's Cover panel
  // replaces it with any frame of the clip or a camera-roll photo. Post-time only —
  // it uploads through the existing path.
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  // Video captions, placed in the studio with the story sticker system — as many
  // as you like. VERTICAL clips: anywhere over the picture. HORIZONTAL clips: in
  // the black letterbox bands above and below it, kept as band captions
  // (lib/bandCaptions).
  const [videoCaptions, setVideoCaptions] = useState<Sticker[]>([]);
  const [videoAspect, setVideoAspect] = useState(0.8); // native aspect for video display
  const [videoDuration, setVideoDuration] = useState(0); // seconds (source)
  const [trimStart, setTrimStart] = useState(0); // seconds — start of the chosen window
  // End of the chosen window. Both edges are draggable, so the window is no
  // longer a fixed VIDEO_MAX_SEC slab — it can be pinched shorter to cut the
  // start, the end, or both. 0 means "not chosen yet"; the trimmer seeds it.
  const [trimEnd, setTrimEnd] = useState(0);
  // Premium+ unlocks FILMS: the landscape window stretches from 9 minutes to 3
  // hours. Server-enforced too — the tus mint refuses non-plus callers.
  const { isPremiumPlus } = usePremium();
  // The published window for THIS clip — landscape gets the long-form (Laybell
  // TV) window (or the film window for Premium+), vertical/square the short
  // one. videoAspect is set at pick time (from the asset's own width/height),
  // so this is settled before any gate, prewarm or trim seed ever reads it.
  const videoWindowSec = videoAspect > 1 ? (isPremiumPlus ? FILM_MAX_SEC : VIDEO_MAX_SEC_H) : VIDEO_MAX_SEC;
  const videoSourceMaxSec = videoAspect > 1 && isPremiumPlus ? FILM_SOURCE_MAX_SEC : VIDEO_SOURCE_MAX_SEC;
  // A FILM = what will actually PUBLISH runs past the free window — judged on
  // the chosen trim window, not the source (a Premium+ user who pinches a
  // 20-minute source down to 8 minutes is posting a video, not a film), and
  // never true without Premium+ (a free user's virtually-trimmed long source
  // publishes a ≤9-minute window, whatever the file length). Drives the title
  // field, the insert, and which upload pipeline the queue uses.
  const publishedVideoSec = trimEnd > trimStart ? trimEnd - trimStart : Math.min(videoDuration, videoWindowSec);
  const isFilm = postType === 'video' && videoAspect > 1 && isPremiumPlus && publishedVideoSec > FILM_MIN_SEC;
  const [filmTitle, setFilmTitle] = useState('');
  const cropperRef = useRef<MediaCropperHandle>(null);
  const cropRef = useRef<CropRect | null>(null);
  const arrangerRef = useRef<SlideArrangerHandle>(null);
  // Mirrors the arranger crop sheet, so the header can re-render and swap its
  // buttons. A ref check cannot drive that — it does not trigger a render.
  const [arrangeCropping, setArrangeCropping] = useState(false);
  // Preview height is animated with a single spring on collapse/expand (see the
  // threshold effect below) — deliberately NOT bound frame-by-frame to the grid
  // scroll. The old scroll-linked interpolation resized the grid container every
  // frame, which on iOS made the grid stutter and flash big blank rows.
  const previewH = useRef(new Animated.Value(PREVIEW_MAX_H)).current;
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
  // Music-video mode: the attached song is a CREDIT + LINK, never played, because
  // it is already this video's own soundtrack. Video posts only — see lib/postSong.
  const [musicVideo, setMusicVideo] = useState(false);
  // The switch only means anything on a video, and both the lock and the
  // in-section picker key off the same derived flag so they can never disagree.
  const musicVideoOn = musicVideo && postType === 'video';
  const [showSongPicker, setShowSongPicker] = useState(false);
  // The song's part and levels, set in the video studio (lib/songMix). Tied to the
  // song they were set for, so picking a different song quietly starts fresh — a
  // part chosen in one track means nothing in another.
  const [songMix, setSongMix] = useState<(SongMix & { songId: string }) | null>(null);
  // Where the cover's frame was taken from (seconds on the source's clock), so the
  // studio's cover picker opens on it; null for a photo or the automatic frame.
  const [coverSec, setCoverSec] = useState<number | null>(null);
  // A panel for the studio to open on — the details page's cover square asks for
  // the cover picker.
  const [studioPanel, setStudioPanel] = useState<'cover' | null>(null);
  // What publishes: a video, with a song that PLAYS (a music video's is a credit),
  // and a mix set for that song.
  const activeMix = postType === 'video' && song && !musicVideoOn && songMix?.songId === song.id ? songMix : null;
  const [tagged, setTagged] = useState<TaggedPerson[]>([]); // accounts tagged on this post (≤10)
  const [features, setFeatures] = useState<Feature[]>([]); // song collaborators (audio, ≤6)
  const [showFeaturesModal, setShowFeaturesModal] = useState(false);
  // Album this track is part of (audio only). Null = a standalone single, which
  // is the default and stays the common case: most songs are not on a record.
  // True from the tap until the photo sheet has been and gone. NO visual of its
  // own: the pre-warm below is what actually made the tap feel instant, and a
  // spinner on top of a picker that already opens promptly is noise. This is
  // purely the re-entrancy guard — two taps in that gap opened two sheets.
  const [coverBusy, setCoverBusy] = useState(false);
  // expo-image-picker, resolved AHEAD of the tap. The dynamic import is
  // deliberate — it keeps the picker off the startup path — but doing it inside
  // the handler made the first tap pay for loading the module before the sheet
  // could even start opening.
  const imagePickerRef = useRef<any>(null);
  useEffect(() => {
    let alive = true;
    import('expo-image-picker')
      .then((m) => { if (alive) imagePickerRef.current = m; })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [showTagModal, setShowTagModal] = useState(false);
  // Communities this post is attributed to (a post can belong to several). Only
  // communities the user is an active, non-muted member of are postable.
  const [communities, setCommunities] = useState<PostableCommunity[]>([]);
  const [showCommunityPicker, setShowCommunityPicker] = useState(false);
  // Minors default to friends-only rather than public. It stays a DEFAULT, not a
  // restriction — a teen can still choose to post publicly — but the safe option
  // is the one they have to opt out of, which is what regulators and both app
  // stores now expect. Adults are unaffected.
  const [isPublic, setIsPublic] = useState(true);
  useEffect(() => {
    let cancelled = false;
    viewerIsMinor().then((minor) => { if (minor && !cancelled) setIsPublic(false); });
    return () => { cancelled = true; };
  }, []);
  // Per-post creator controls — both default ON, so the poster only ever toggles
  // OFF to opt out. downloads → audio offline pin (posts.downloadable); gifs →
  // whether others may Make GIF from a video (posts.allow_gifs).
  const [allowDownloads, setAllowDownloads] = useState(true);
  const [allowGifs, setAllowGifs] = useState(true);
  // Marks the post as mature (artistic nudity, adult themes). The community
  // guidelines both PERMIT that content and promise to keep it away from users
  // known to be under 18 — this switch is the control they refer to, and
  // mature_content.sql is the gate that actually enforces it in the database.
  // Defaults off: nothing becomes age-restricted unless the author says so.
  const [mature, setMature] = useState(false);
  // Sync consent for audio uploads — see DEFAULT_SOUND_OPT_IN in lib/sounds.ts,
  // where the opt-in vs opt-out tradeoff is spelled out. Kept separate from the
  // general upload grant deliberately: a specific per-track choice is what makes
  // the consent defensible.
  const [allowSound, setAllowSound] = useState(DEFAULT_SOUND_OPT_IN);
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
  const navigation = useNavigation<any>();
  // Actions only: the composer reads no queue state, so it must not re-render on
  // every upload progress tick while a previous post is still uploading.
  const { enqueueVideo, prewarmVideo, discardPrewarm, scrollHomeTop } = useUploadActions();
  const myPostLimit = publicPostLimit(rawTier(profile));

  // Speculatively start the video upload the moment the user reaches the studio or
  // the details step — most people who get here do post, so by the time they hit
  // Share the clip is usually already uploaded and publishing feels instant. If
  // they instead switch clips or leave without posting, the prewarmed (unpublished)
  // Stream asset is discarded so it doesn't linger as paid storage. A claimed
  // prewarm (being published) is never discarded.
  const prewarmedUriRef = useRef<string | null>(null);
  useEffect(() => {
    if ((step === 'studio' || step === 'details') && postType === 'video' && media?.uri) {
      if (prewarmedUriRef.current && prewarmedUriRef.current !== media.uri) discardPrewarm(prewarmedUriRef.current);
      // Clips that need TRIMMING are deliberately not prewarmed. The prewarm is
      // keyed on the source uri and uploads it as-is, but the user can still go
      // back and move the trim window — so a prewarmed upload would be the wrong
      // window (or the whole untrimmed source). Those posts upload at Share
      // instead, and now upload only the chosen window, which more than pays
      // back the lost head start. Untrimmed clips keep the prewarm unchanged.
      if (videoDuration <= videoWindowSec) {
        prewarmedUriRef.current = media.uri;
        prewarmVideo(media.uri, streamCeilingFor(videoDuration, videoSourceMaxSec), videoDuration, isFilm);
      } else {
        prewarmedUriRef.current = null;
      }
    } else if (prewarmedUriRef.current) {
      discardPrewarm(prewarmedUriRef.current);
      prewarmedUriRef.current = null;
    }
    // videoDuration is a dep because the ceiling is derived from it (and
    // videoWindowSec/videoSourceMaxSec/isFilm because the gate + ceiling +
    // pipeline choice are); prewarmVideo is idempotent per uri, so a re-run
    // after any lands is a no-op.
  }, [step, postType, media?.uri, videoDuration, videoWindowSec, videoSourceMaxSec, isFilm, prewarmVideo, discardPrewarm]);
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
  // When the post goes live (epoch ms), or null to post right away — lib/schedule.
  const [scheduleAt, setScheduleAt] = useState<number | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  // How many of this account's posts are waiting to go live: the pick step's bar.
  const [scheduledCount, setScheduledCount] = useState(0);
  const scheduleWhen = (at: number) => formatSchedule(at, Date.now(), lang, {
    today: t('schedule.today'),
    tomorrow: t('schedule.tomorrow'),
    dayTime: (day: string, time: string) => t('schedule.dayTime', { day, time }),
  });
  const [savedToast, setSavedToast] = useState(false); // "Saved to Drafts" confirmation
  // The post just shared, celebrated on the pick step (components/PostedCelebration).
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  // Closing the composer with something picked or written asks first.
  const [confirmExit, setConfirmExit] = useState(false);
  // Where the caption's cursor is, so an @ typed mid-caption suggests people too.
  const [captionCursor, setCaptionCursor] = useState(0);
  // The details step's two menu buttons — who sees the post, when it goes up —
  // measured when tapped so their menu opens from them (components/PullDownMenu).
  const visTileRef = useRef<View>(null);
  const timeTileRef = useRef<View>(null);
  const [tileMenu, setTileMenu] = useState<{ kind: 'visibility' | 'time'; anchor: MenuAnchor } | null>(null);
  // The details step's Advanced settings fold.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Save to camera roll: once a video post is up, its finished copy — trimmed, with
  // its text and song — goes to the camera roll (lib/videoExport). On by default.
  const [saveToCameraRoll, setSaveToCameraRoll] = useState(true);
  // Polished "Posted!" confirmation shown after a successful share (replaces the
  // default OS alert). Holds the title/body so the spotlight variant can differ.
  const [postedToast, setPostedToast] = useState<{ title: string; message: string; spotlight: boolean; uploading?: boolean; scheduled?: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Draft | null>(null); // draft pending delete-confirm
  const [importingFile, setImportingFile] = useState(false); // Files-app probe in flight
  // The mode dropdown (Single / Slideshow / Post from Files). Rendered in a
  // Modal so its items stay tappable — an absolutely-positioned menu hanging
  // below its parent row would draw fine but lose Android touches outside the
  // parent's bounds. Anchored by measuring the button at open time.
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modeMenuAnchor, setModeMenuAnchor] = useState<{ x: number; y: number; h: number } | null>(null);
  const modeBtnRef = useRef<View>(null);
  const modeMenuAnim = useRef(new Animated.Value(0)).current;
  // iOS can't present the document picker while the menu Modal is still
  // dismissing — the pending action fires from the Modal's onDismiss instead.
  const pendingMenuAction = useRef<(() => void) | null>(null);
  // The in-app camera (components/CaptureCamera, the story camera's own), opened
  // from the grid's camera tile — see onCameraCapture.
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false); // a recording being probed
  // The same iOS rule for the camera's Modal: an alert can't show while it's still
  // sliding away, so whatever a capture leads to runs from its onDismiss.
  const pendingCameraAction = useRef<(() => void) | null>(null);
  // Film upload heads-up: holds the estimate plus the promise resolver for the
  // Share flow, which awaits the user's answer before any work begins.
  const [filmNotice, setFilmNotice] = useState<{ minutes: number; resolve: (go: boolean) => void } | null>(null);
  const editingDraftId = useRef<string | null>(null);
  useFocusEffect(useCallback(() => { loadDrafts().then(setDrafts); }, []));
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { count, error: countError } = await supabase.from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gt('publish_at', new Date().toISOString());
      if (!cancelled && !countError) setScheduledCount(count ?? 0);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, []));

  // Boot-time upload recovery handoff: the _layout prompt parked a draft id for
  // us — load it straight into the composer so "Resume" is one tap from Share.
  useFocusEffect(useCallback(() => {
    const rid = consumeResumeDraftId();
    if (!rid) return;
    loadDrafts().then((list) => {
      const d = list.find((x) => x.id === rid);
      if (d) { setDrafts(list); resumeDraft(d); }
    }).catch(() => {});
    // resumeDraft is a stable in-component function; deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));
  // Drop the "I'm editing draft X" link. Called whenever the resumed media is
  // abandoned (cleared / type-switched) so a later UNRELATED post can't, on
  // publish or re-save, delete or overwrite the original draft.
  function forgetResumedDraft() { editingDraftId.current = null; }

  // Controls only — this screen never renders audio state, so it must not
  // re-render on it. `stop` is also stable now, which means the effect below
  // fires when the STEP changes rather than on every provider commit.
  const { stop } = useAudioControls();
  const swiping = usePagerSwiping();
  const setTabSwipe = useTabSwipeControl();
  const router = useRouter();
  // Music keeps playing while browsing the picker — the global MiniPlayer
  // migrates to a compact top-right card on this tab (see app/_layout.tsx).
  // Entering the DETAILS step is the cutoff: the song exits there so the user
  // finishes their post in full focus.
  // The video studio counts too: its song preview runs through the ambient song
  // player, which stays silent while the main one plays.
  useEffect(() => { if (step === 'studio' || step === 'details') stop(); }, [step, stop]);

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

  // Silence the audio preview whenever it shouldn't be audible — which is any
  // time this tab isn't focused OR the composer has moved past the picker.
  //
  // Two separate ways it used to keep playing, which is why this is derived from
  // BOTH conditions rather than a blur handler:
  //   • The tab navigator keeps every page MOUNTED, so swiping away neither
  //     unmounts this screen nor stops the expo-audio player — the recording
  //     carried on over whatever the user swiped to.
  //   • The details form is an internal STEP, not a route (see `step` above), so
  //     going "forward" to it fires no navigation event at all. A blur-only
  //     handler could never have caught that one, and it's the case you hit
  //     first: the clip played on under the title/genre form.
  //
  // Pause rather than unload — coming back should show the same clip ready to
  // resume, just not still going.
  const isFocused = useIsFocused();
  // Leaving the composer (a notification tap, say) takes the camera with it — its
  // Modal would otherwise stay up over whichever screen opened.
  useEffect(() => { if (!isFocused) setCameraOpen(false); }, [isFocused]);
  useEffect(() => {
    if (isFocused && step === 'pick') return;
    const p = previewSoundRef.current;
    if (p) { try { p.pause(); } catch {} }
    setIsPreviewPlaying(false);
  }, [isFocused, step]);

  // Belt and braces: release the player outright if this screen ever unmounts
  // with a clip loaded — the root layout remounts the whole per-user tree on an
  // account switch, and a player that outlives its screen has nothing left
  // holding a reference to stop it. No setState here; the component is gone.
  useEffect(() => () => {
    if (previewSubRef.current) { try { previewSubRef.current.remove(); } catch {} previewSubRef.current = null; }
    const p = previewSoundRef.current;
    if (p) { try { p.pause(); } catch {} try { p.remove(); } catch {} }
    previewSoundRef.current = null;
  }, []);

  function exitToExplore() {
    resetAll();
    router.navigate('/explore');
  }

  // Cropper frame within the preview cap. Videos use their native aspect (clamped
  // to IG bounds) so they fill without being force-cropped; images use the chosen
  // format and are cropped to it interactively.
  // 'full' and 'mixed' carry no ratio, so they resolve against the media — the
  // first slide for a carousel, the single pick otherwise.
  // A carousel's frame is measured across the WHOLE set — sized to its tallest
  // slide, so every other slide fits inside it whole and each one keeps its own
  // crop shape. It is deliberately NOT `format`: the frame used to be whatever
  // shape the last-cropped slide was given, which re-cropped every untouched
  // photo in the post.
  const previewAspect = postType === 'video'
    ? videoAspect
    : postType === 'slideshow'
      ? slideshowCanvasAspect(slides)
      : resolveFrameAspect(format, media);
  let frameW = SCREEN_W;
  let frameH = SCREEN_W / previewAspect;
  if (frameH > PREVIEW_MAX_H) { frameH = PREVIEW_MAX_H; frameW = PREVIEW_MAX_H * previewAspect; }

  // Collapsing preview — shrinks once the gallery is scrolled so more photos show.
  const fullPreviewH = frameH + SPACING.xs * 2;
  const collapsedPreviewH = 96;

  // Animate the preview height with a single spring whenever the collapse state
  // (or the expanded target) changes — exactly two height changes per scroll, not
  // one per frame. The old approach interpolated the live scroll offset straight
  // into this height with useNativeDriver:false, so every scroll frame resized the
  // grid container underneath; on iOS that makes a virtualized grid jump and flash
  // big blank rows. Keeping the grid a stable size while browsing is what makes
  // scrolling smooth.
  useEffect(() => {
    Animated.timing(previewH, {
      toValue: previewCollapsed ? collapsedPreviewH : fullPreviewH,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [previewCollapsed, fullPreviewH, collapsedPreviewH, previewH]);

  // Cheap scroll handler: only flips the collapse threshold (a guarded setState,
  // so it no-ops on every frame except the two crossings). No per-frame Animated
  // or layout work runs on the JS thread here — that's what frees the grid to keep
  // up and stops the blank-cell flashing.
  const onGridScroll = useCallback((e: any) => {
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    setPreviewCollapsed(prev => {
      const next = y > 50;
      return prev === next ? prev : next;
    });
  }, []);

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
    setVideoDuration(0); setTrimStart(0); setTrimEnd(0); setVideoCaptions([]);
    setAudioFile(null); setAudioDuration(null); setCoverUri(null); setAudioKind('audio');
    setCaption(''); setFilmTitle(''); setGenre(''); setSong(null); setSongMix(null); setCoverSec(null); setScheduleAt(null); setMusicVideo(false); setTagged([]); setCommunities([]); setError(''); setStep('pick');
    // features was MISSING here, which meant collaborators credited on one song
    // silently rode onto the next one posted in the same sitting — and every
    // one of them would have been notified they were on a track they are not.
    setFeatures([]); setAlbumId(null); setNewAlbumName('');
    setAllowDownloads(true); setAllowGifs(true); setMature(false); setSaveToCameraRoll(true);
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
      videoAspect, videoDuration, trimStart, trimEnd, videoCaptions,
      filmTitle,
      slides,
      audioFile, audioDuration, coverUri, audioKind,
      song, songMix, tagged, features,
      allowDownloads, allowGifs,
      publishAt: scheduleAt,
      mature, allowSound, musicVideo, coverSec, albumId, communities, saveToCameraRoll,
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
    setTrimEnd(d.trimEnd ?? 0);
    // A horizontal clip's captions from before band captions were one bubble per
    // band; they reopen in the studio as band captions.
    setVideoCaptions(d.videoAspect > 1 && !(d.videoCaptions ?? []).some(isBandSticker)
      ? bandStickersFromLegacy(d.topCaption, d.bottomCaption)
      : d.videoCaptions ?? []);
    setFilmTitle(d.filmTitle ?? '');
    setSlides(d.slides ?? []);
    setPickedId(null);
    setAudioFile(d.audioFile);
    setAudioDuration(d.audioDuration);
    setCoverUri(d.coverUri);
    setAudioKind(d.audioKind);
    setSong(d.song);
    setSongMix(d.songMix ?? null);
    // A schedule that lapsed while the draft sat is dropped, not honoured early.
    setScheduleAt(d.publishAt && d.publishAt > Date.now() ? d.publishAt : null);
    setTagged(d.tagged ?? []);
    setFeatures(d.features ?? []);
    setAllowDownloads(d.allowDownloads ?? true);
    setAllowGifs(d.allowGifs ?? true);
    // The rest of the details form, on drafts saved since 1.0.3; older ones fall
    // back to the composer's defaults.
    setMature(d.mature ?? false);
    setAllowSound(d.allowSound ?? DEFAULT_SOUND_OPT_IN);
    setMusicVideo(d.musicVideo ?? false);
    setCoverSec(d.coverSec ?? null);
    setAlbumId(d.albumId ?? null);
    setCommunities(d.communities ?? []);
    setSaveToCameraRoll(d.saveToCameraRoll ?? true);
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
    // 4:5 for a slideshow, matching startSlideshow — a PORTRAIT frame, so a
    // landscape photo lands with bars above and below rather than down its
    // sides. This said '1:1', which disagreed with the other entry point and now
    // matters more than it did: `format` is the shape a slide falls back to when
    // it has none of its own, so a square default would have quietly cropped
    // every untouched portrait photo to a square.
    setFormat(t === 'slideshow' ? '4:5' : defaultFormatFor(t as any));
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null; setSlides([]);
    setVideoDuration(0); setTrimStart(0); setTrimEnd(0);
    setAudioFile(null); setAudioDuration(null);
    setSong(null); setSongMix(null); setCoverSec(null); setTagged([]);
    forgetResumedDraft(); // the resumed draft's media is gone — stop tracking it
  }

  // Single photos only. A slideshow's frame is chosen on the Arrange screen
  // instead, where you can see what it does to every slide rather than to the
  // one thumbnail the picker happens to be showing.
  function cycleFormat() {
    const i = IMAGE_FORMATS.indexOf(format as any);
    setFormat(IMAGE_FORMATS[(i + 1) % IMAGE_FORMATS.length]);
  }

  // (The old "Large video" system alert lived here. It measured the RAW pick,
  // which stopped meaning anything once every long video is compressed before
  // upload — a 4K source would warn about 1024 MB for an upload that lands at
  // ~180 MB. Worse, on a film it fired on top of the Laybell film notice, so
  // the user answered two popups about the same upload. The themed
  // ConfirmDialog at Share is the single, accurate warning now.)

  // Resolves false when a gate below refused the pick (having already said why).
  async function onPickMedia(m: PickedMedia): Promise<boolean> {
    // Tapping a thumbnail (even far down the grid) snaps back to the top so the
    // collapsing preview re-expands and shows the media that was just picked.
    photoGridRef.current?.scrollToTop();
    // Long videos are still not rejected for LENGTH in the normal case — the
    // edit step's trimmer picks a 3-minute window out of them. But the source
    // itself is what gets uploaded, so anything past the Stream ceiling can
    // never publish; refuse it here, while the user still has the picker open,
    // rather than failing invisibly after they hit Share.
    if (m.type === 'video') {
      const srcSec = m.duration ?? 0;
      // videoAspect isn't set yet — the pick gate reads the asset's own dims.
      const landscape = (m.width || 1) > (m.height || 1);
      // A film-length landscape pick without the film right → upsell, not the
      // generic refusal: the length is fine, the TIER is what's missing.
      if (landscape && !isPremiumPlus && srcSec > VIDEO_SOURCE_MAX_SEC) {
        Alert.alert(t('film.upsellTitle'), t('film.upsellBody'), [
          { text: t('film.getPlus'), onPress: () => router.push('/premium' as any) },
          { text: t('film.notNow'), style: 'cancel' },
        ]);
        return false;
      }
      const srcMax = landscape && isPremiumPlus ? FILM_SOURCE_MAX_SEC : VIDEO_SOURCE_MAX_SEC;
      if (srcSec > srcMax) {
        Alert.alert(
          t('post.videoSourceTooLongTitle'),
          t('post.videoSourceTooLongBody', { max: fmtMins(srcMax) }),
        );
        return false;
      }
    }
    if (m.type !== postType) setFormat(defaultFormatFor(m.type as any)); // image↔video
    setPostType(m.type);
    setPickedId(m.id);
    setMedia({ uri: m.uri, width: m.width, height: m.height, posterUri: m.posterUri });
    setThumbnailUri(null); setCoverSec(null);
    // Freshly picked media starts at the centered cover crop — drop any crop
    // carried over from a previous selection (the cropper now seeds from
    // cropRef via initialCrop, so a stale value would mis-position the new pick).
    cropRef.current = null;
    if (m.type === 'video') {
      setVideoAspect(clampVideoAspect((m.width || 1) / (m.height || 1)));
      setVideoDuration(m.duration ?? 0);
      setTrimStart(0); setTrimEnd(0);
      setVideoCaptions([]); // captions belong to the clip they were placed on
      try {
        // Grab an early frame, but never past the clip's end — a time beyond
        // the duration fails to decode and would leave the cover blank.
        const durMs = (m.duration ?? 0) * 1000;
        const at = durMs > 0 ? Math.min(1000, Math.round(durMs / 2)) : 1000;
        const { uri } = await VideoThumbnails.getThumbnailAsync(m.uri, { time: at, quality: 0.5 });
        setThumbnailUri(uri);
      } catch {}
    }
    return true;
  }


  // ── Import from the Files app ───────────────────────────────────────────────
  // The other road into the composer, built for films: a 12-minute master lives
  // in Files/iCloud Drive or an AirDrop folder, not the camera roll. It also
  // dodges the camera-roll sandbox fight outright — the picker's
  // copyToCacheDirectory IS the ensureLocalFile copy, so the compressor can
  // always read what it hands us. Files picks carry no metadata, so probeVideo
  // supplies duration + oriented dims; after that the import is an ordinary
  // onPickMedia and every gate (film upsell, source ceilings) applies as-is.
  async function importFromFiles() {
    if (importingFile) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'video/*', copyToCacheDirectory: true, multiple: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const f = res.assets[0];
      setImportingFile(true);
      // A film master can't ride in a slideshow slot — imports are single-mode.
      enterSingle();
      const meta = await probeVideo(f.uri);
      await onPickMedia({
        id: `files:${f.uri}`,
        uri: f.uri,
        posterUri: meta.posterUri,
        width: meta.width,
        height: meta.height,
        duration: meta.durationSec,
        type: 'video',
      });
    } catch {
      Alert.alert(t('post.filesImportFailedTitle'), t('post.filesImportFailedBody'));
    } finally {
      setImportingFile(false);
    }
  }

  // ── The in-app camera ───────────────────────────────────────────────────────
  // The grid's camera tile opens components/CaptureCamera — the story camera itself
  // (owner, 2026-09-11). A photo lands exactly as a grid pick does; a recording goes
  // straight on to the video editor (through the trimmer first if it runs past the
  // window, as Next would decide), or becomes the next slide in a slideshow.
  function closeCamera(then?: () => void) {
    setCameraOpen(false);
    if (!then) return;
    if (Platform.OS === 'ios') pendingCameraAction.current = then;
    else then();
  }
  async function onCameraCapture(c: CapturedMedia) {
    if (c.type === 'image') {
      // Keyed by its uri, as the system camera's captures were.
      const m: PickedMedia = { id: c.uri, uri: c.uri, posterUri: c.uri, width: c.width ?? 1, height: c.height ?? 1, type: 'image' };
      closeCamera(() => { if (slideshowMode) addSlideFromGrid(m); else onPickMedia(m); });
      return;
    }
    if (cameraBusy) return;
    setCameraBusy(true);
    try {
      // The camera reports neither a trustworthy length nor the oriented size.
      const meta = await probeVideo(c.uri);
      const m: PickedMedia = {
        id: c.uri, uri: c.uri, posterUri: meta.posterUri,
        width: meta.width, height: meta.height, duration: meta.durationSec, type: 'video',
      };
      if (slideshowMode) { closeCamera(() => { addSlideFromGrid(m); }); return; }
      if (!(await onPickMedia(m))) return; // its gate's alert shows over the camera
      // goNext's routing, from this clip's own numbers: the state onPickMedia just
      // set hasn't reached this closure.
      const windowSec = meta.width > meta.height ? (isPremiumPlus ? FILM_MAX_SEC : VIDEO_MAX_SEC_H) : VIDEO_MAX_SEC;
      setStep(meta.durationSec > windowSec ? 'edit' : 'studio');
      closeCamera();
    } catch {
      Alert.alert(t('storyCamera.videoFailTitle'), t('post.tryAgain'));
    } finally {
      setCameraBusy(false);
    }
  }

  function openTileMenu(kind: 'visibility' | 'time') {
    const ref = kind === 'visibility' ? visTileRef : timeTileRef;
    ref.current?.measureInWindow((x, y, width, height) => setTileMenu({ kind, anchor: { x, y, width, height } }));
  }

  function openModeMenu() {
    modeBtnRef.current?.measureInWindow((x, y, _w, h) => {
      setModeMenuAnchor({ x, y, h });
      setModeMenuOpen(true);
      modeMenuAnim.setValue(0);
      Animated.timing(modeMenuAnim, {
        toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true,
      }).start();
    });
  }

  function chooseMode(action: () => void, presentsNative = false) {
    setModeMenuOpen(false);
    // Mode switches run immediately; only natively-presented pickers must wait
    // for the Modal to finish dismissing (and only iOS has that conflict).
    if (presentsNative && Platform.OS === 'ios') pendingMenuAction.current = action;
    else action();
  }

  // ── Unified Posts picker: single vs slideshow, both off one in-app grid ───────
  function clearMedia() {
    setMedia(null); setPickedId(null); setThumbnailUri(null); cropRef.current = null;
    setVideoDuration(0); setTrimStart(0); setTrimEnd(0);
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
    // 4:5 — a PORTRAIT frame, so a landscape photo lands with bars above and
    // below it rather than down its sides. See defaultSlideFit for why that
    // asymmetry matters.
    setPostType('slideshow'); setFormat('4:5');
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
    // Append the slide IMMEDIATELY (the ph:// posterUri renders via expo-image),
    // then swap in the generated file thumbnail when it lands — previously the
    // slide didn't even appear until getThumbnailAsync finished.
    setSlides(prev => prev.length >= MAX_SLIDES ? prev
      : [...prev, {
          id: m.id, uri: m.uri, type: m.type, width: m.width, height: m.height,
          durationSec: m.type === 'video' ? m.duration ?? null : null,
          thumbnailUri: null, posterUri: m.posterUri,
        }]);
    if (m.type === 'video') {
      VideoThumbnails.getThumbnailAsync(m.uri, { time: 1000 })
        .then(({ uri }) => setSlides(prev => prev.map(s => (s.id === m.id ? { ...s, thumbnailUri: uri } : s))))
        .catch(() => {});
    }
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
        // Was a bare Alert with only OK — it named the problem and offered no
        // way to fix it, which on a second denial is a dead end.
        showPermissionDenied('microphone', t);
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
    const p = previewSoundRef.current;
    if (p) {
      // PAUSE BEFORE RELEASING. `remove()` tears down the handle but does not
      // reliably stop an expo-audio player that is mid-playback first — so a
      // clip released while playing carried on with nothing left holding a
      // reference to stop it. That's why closing the composer with ✕ (which
      // resets through here) left audio running in the background.
      try { p.pause(); } catch {}
      try { p.remove(); } catch {}
      previewSoundRef.current = null;
    }
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
    if (coverBusy) return; // a second tap while the sheet is coming up opens two
    setCoverBusy(true);
    try {
      // Warmed at mount (see the pre-warm effect); the await is the fallback for
      // the case where that has not resolved yet.
      const ImagePicker = imagePickerRef.current ?? await import('expo-image-picker');
      imagePickerRef.current = ImagePicker;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [1, 1], quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) setCoverUri(result.assets[0].uri);
    } catch {
      // Cancelled, denied, or the module failed to load — nothing to say that
      // the unchanged artwork does not already say.
    } finally {
      setCoverBusy(false);
    }
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
    // Backstop for the source ceiling. onPickMedia already refuses these, but a
    // DRAFT saved before that gate existed can still carry an over-length clip
    // back in (drafts restore videoDuration verbatim) — and letting one through
    // here is exactly the silent post-Share failure this is all guarding against.
    if (postType === 'video' && videoDuration > videoSourceMaxSec) {
      Alert.alert(
        t('post.videoSourceTooLongTitle'),
        t('post.videoSourceTooLongBody', { max: fmtMins(videoSourceMaxSec) }),
      );
      return;
    }
    if (postType === 'video' && videoDuration > videoWindowSec) { setStep('edit'); return; }
    // Slideshows get their own step before the details form. Until now the pick
    // screen only ever mounted a cropper on the LAST slide, so every earlier
    // photo published at whatever centred cover crop it landed on, and there was
    // no way to change the order at all.
    if (postType === 'slideshow' && slides.length > 0) {
      captureLastSlideCrop(); // the pick screen's cropper is still mounted — take its crop with us
      setStep('arrange');
      return;
    }
    // A video goes through the studio — captions, music, sound and cover on one
    // screen — the way a slideshow goes through Arrange.
    if (postType === 'video') { setStep('studio'); return; }
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

  // Share re-entry latch. handleShare awaits several things (the crash-
  // insurance draft write, size confirms) before the enqueue, so a double-tap
  // used to run the WHOLE pipeline twice — observed on device as two identical
  // posts created 18ms apart sharing one Cloudflare asset (the second job's
  // tus resume found the first's finished bytes). The DB now also enforces
  // one-asset-one-post; this latch stops the double spend before it starts.
  const sharingRef = useRef(false);

  async function handleShare() {
    if (sharingRef.current) return;
    sharingRef.current = true;
    try {
      await handleShareInner();
    } finally {
      sharingRef.current = false;
    }
  }

  async function handleShareInner() {
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
    // A time that passed while the post was being written is flagged, not
    // published early. And a paid spotlight goes live the moment it attaches —
    // its campaign clock would run while a scheduled post sat hidden.
    if (scheduleAt != null) {
      if (scheduleProblem(scheduleAt, Date.now())) { setError(t('schedule.lapsed')); setShowSchedule(true); return; }
      if (pendingSpot) { setError(t('schedule.noSpotlight')); return; }
    }
    const publishAt = scheduleAt != null ? new Date(scheduleAt).toISOString() : null;
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
      // Objectionable-text gate (Apple 1.2 / Play UGC) — before any upload work,
      // so a refusal never costs the user a long video upload first.
      // Every piece of on-video text too. A vertical clip's captions were never
      // screened, though they sit on the video as prominently as the caption.
      const screened = await checkFields(caption, ...videoCaptions.map((s) => s.text));
      if (!screened.ok) {
        setLoading(false);
        setError(t('filter.blockedBody'));
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Tier gate for PUBLIC posts — checked fresh before any upload work so a
      // full slot count never wastes a long video upload. Friends-only always OK.
      if (isPublic && Number.isFinite(myPostLimit)) {
        // Counted PER KIND. Music and everything else hold separate allowances,
        // so a full catalogue of tracks never blocks a photo and vice versa —
        // see PUBLIC_POST_LIMIT. The filter has to match postKindOf exactly, or
        // the count and the limit would be describing different sets.
        const kind = postKindOf(postType === 'audio' ? 'audio' : postType);
        const base = () => {
          const q = supabase.from('posts')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('is_public', true);
          return kind === 'music'
            ? q.in('type', MUSIC_POST_TYPES as unknown as string[])
            : q.not('type', 'in', `(${MUSIC_POST_TYPES.join(',')})`);
        };
        const filtered = await base().is('archived_at', null);
        const count = (!filtered.error ? filtered.count : (await base()).count) ?? 0;
        setPublicCount(count);
        if (count >= myPostLimit) {
          setLoading(false);
          const tier = rawTier(profile);
          // The message names the KIND that is full, because "you have hit your
          // limit" is misleading when there is room for the other one.
          const kindLabel = t(kind === 'music' ? 'post.limitKindMusic' : 'post.limitKindRegular');
          Alert.alert(
            t('post.publicLimitTitle'),
            tier
              ? t('post.publicLimitTieredBody', { tier: tierLabel(tier), limit: myPostLimit, kind: kindLabel })
              : t('post.publicLimitFreeBody', { kind: kindLabel }),
          );
          return;
        }
      }

      // VIDEO → background upload queue. We hand the whole publish (upload to
      // Cloudflare Stream, insert the row, mentions/badges/notifications/spotlight)
      // to the queue and return to the feed IMMEDIATELY, where an optimistic card
      // plays the local file with a progress badge until the CDN copy is ready.
      // Posting feels instant and never blocks on the upload.
      if (postType === 'video') {
        const trimmedV = videoDuration > videoWindowSec;
        // Both trimmer edges are draggable, so the window is whatever the user
        // pinched it to — not always a full window. trimEnd is only set
        // once they actually drag, so someone who walks straight through the
        // trim step still gets a sane full-length window from trimStart.
        const winEndV = trimEnd > trimStart ? trimEnd : Math.min(trimStart + videoWindowSec, videoDuration);
        const videoDurSecV = trimmedV ? Math.max(1, Math.round(winEndV - trimStart)) : Math.round(videoDuration);
        // Captions are timed on the SOURCE's clock, inside the window that gets
        // posted: [trimStart, winEndV] when trimmed, the whole clip otherwise.
        const captionSplit = splitForPublish(videoCaptions.filter((s) => !isBandSticker(s)), trimmedV ? trimStart : 0, trimmedV ? winEndV : videoDuration);
        // A horizontal clip's band captions are stored together, timed or not
        // (lib/bandCaptions).
        const bandCaptions = videoAspect > 1
          ? timingForPublish(videoCaptions.filter(isBandSticker), trimmedV ? trimStart : 0, trimmedV ? winEndV : videoDuration)
          : [];
        const ps = peekPendingSpotlight();
        // Films on cellular: a multi-hundred-MB transfer on mobile data is a
        // bill and a failure risk the user should choose knowingly. One clear
        // ask, then respect the answer.
        if (isFilm) {
          const net = await getNetworkState().catch(() => null);
          if (net && net.isConnected && !net.isWifi) {
            const goAhead = await new Promise<boolean>((resolve) => {
              Alert.alert(t('film.cellularTitle'), t('film.cellularBody'), [
                { text: t('film.cellularAnyway'), onPress: () => resolve(true) },
                { text: t('film.notNow'), style: 'cancel', onPress: () => resolve(false) },
              ]);
            });
            if (!goAhead) return;
          }
        }
        // EXPECTATION BEFORE COMMITMENT. A film is prepared, uploaded and
        // encoded — tens of minutes of real work. Users don't mind a long wait
        // they were told about; they mind a long wait that ambushes them. So
        // say it plainly BEFORE the work starts, with the one instruction that
        // actually matters (stay in the app), and let them back out.
        if (isFilm) {
          const mins = Math.max(5, Math.ceil((videoDurSecV || videoDuration || 0) / 60));
          // Put the keyboard away first. Share is usually pressed straight from
          // the caption field, and a dialog sharing the screen with a keyboard
          // is both cramped and easy to mis-tap.
          Keyboard.dismiss();
          const proceed = await new Promise<boolean>((resolve) => {
            setFilmNotice({ minutes: mins, resolve });
          });
          if (!proceed) { setLoading(false); return; }
        }
        const spotLabel = ps?.label ?? null;
        // CRASH INSURANCE: snapshot the whole post as a draft BEFORE the upload
        // starts. If the app is closed/killed mid-upload (a film uploads for
        // tens of minutes), the post isn't lost — it's sitting in Drafts, and
        // re-sharing it resumes the transfer from the bytes Cloudflare already
        // holds (tus resume is keyed to the same source file). The queue
        // deletes this draft only when the post ACTUALLY exists.
        const resumeDraftId = editingDraftId.current ?? makeDraftId();
        const draftNow = Date.now();
        await saveDraft({
          id: resumeDraftId, createdAt: draftNow, updatedAt: draftNow,
          postType, format, caption, genre, isPublic,
          media, crop: cropRef.current as any, thumbnailUri,
          videoAspect, videoDuration, trimStart, trimEnd, videoCaptions,
          filmTitle,
          slides: [],
          audioFile: null, audioDuration: null, coverUri: null, audioKind,
          song, songMix, tagged, features,
          allowDownloads, allowGifs,
          publishAt: scheduleAt,
          mature, allowSound, musicVideo, coverSec, albumId, communities, saveToCameraRoll,
          // Marks this as an in-flight upload for boot-time recovery — cleared
          // only when the post truly exists (see lib/uploadRecovery).
          pendingUpload: true,
        }).then(setDrafts).catch(() => {});
        // Save to camera roll: "Add to Photos" is asked for here, beside the switch
        // that wants it. No permission, no copy — said so, and the post goes up either
        // way. Films are too long to re-encode on a phone, so they never offer it.
        const wantsCopy = !isFilm && saveToCameraRoll && canSaveFinishedVideo();
        // eslint-disable-next-line no-console
        if (__DEV__) console.log(`[save-video] share: switch ${saveToCameraRoll ? 'on' : 'off'}, film ${isFilm}, exporter ${canSaveFinishedVideo() ? 'yes' : 'NO'}`);
        const saveCopy = wantsCopy && await requestSavePermission();
        if (wantsCopy && !saveCopy) reportSaveSkipped('permission');
        enqueueVideo({
          userId: user.id,
          localUri: media!.uri,
          thumbnailUri: thumbnailUri ?? null,               // file:// → uploaded as the post poster
          posterUri: media?.posterUri ?? thumbnailUri ?? null, // ph:// ok → shown in the optimistic card
          aspectRatio: String(videoAspect),
          caption: caption.trim(),
          isPublic,
          hasCommunity,
          genre: genre && showGenre ? genre : null,
          durationSeconds: videoDurSecV > 0 ? videoDurSecV : null,
          trim: trimmedV ? { start: trimStart, end: winEndV } : null,
          song: song ? { id: song.id, title: song.title, artist: song.artist, artistId: song.artistId ?? null, linkOnly: musicVideoOn } : null,
          // Only when the studio set one; clamped into the database's range.
          songMix: activeMix ? mixColumns(activeMix) : null,
          taggedIds: tagged.map((tp) => tp.id),
          communityIds: communities.map((c) => c.id),
          allowGifs,
          // Mature content — the switch is on the details form for every post type,
          // and until 1.0.3 it never reached a video.
          mature,
          // Vertical → captions placed over the clip: the ones shown for the whole
          // clip go to posts.captions, which every app version draws; ones timed to
          // part of it go to timed_captions, which only 1.0.3+ reads
          // (lib/stickerTiming.splitForPublish). Horizontal → band captions, all in
          // timed_captions, plus the one bubble per band that apps before 1.0.3
          // draw (lib/bandCaptions). Only the matching kind is sent.
          topCaption: videoAspect > 1 ? legacyBandCaption(bandCaptions, 'top') : null,
          bottomCaption: videoAspect > 1 ? legacyBandCaption(bandCaptions, 'bottom') : null,
          captions: videoAspect <= 1 && captionSplit.always.length ? captionSplit.always : null,
          timedCaptions: videoAspect > 1
            ? (bandCaptions.length ? bandCaptions : null)
            : (captionSplit.timed.length ? captionSplit.timed : null),
          // Covers the SOURCE, not the chosen window: if the physical cut falls
          // back, the file that goes up is untrimmed, and Cloudflare rejects
          // anything past this ceiling.
          maxDurationSeconds: streamCeilingFor(videoDuration, videoSourceMaxSec),
          // For the adaptive bitrate that keeps long uploads under the POST cap.
          sourceSeconds: videoDuration,
          // Films: route through the tus pipeline; the movie-shelf title shows
          // on the Laybell TV rail.
          film: isFilm,
          filmTitle: isFilm ? filmTitle.trim() || null : null,
          // The crash-insurance draft above — deleted by the queue at REAL
          // completion (upload + encode + row), never before.
          resumeDraftId,
          spotlight: ps ? { campaignId: ps.campaignId, days: ps.days } : null,
          // Scheduled: the row goes in hidden until then, and the server announces it.
          publishAt,
        });
        if (saveCopy) {
          // The finished copy starts now, beside the upload: the person is still in
          // the app, and iOS stops an export once it leaves (lib/videoExport). Times
          // are on the SOURCE clock, as the captions are.
          queueFinishedVideoSave({
            localUri: media!.uri,
            windowStart: trimmedV ? trimStart : 0,
            windowEnd: trimmedV ? winEndV : videoDuration,
            vertical: videoAspect <= 1,
            captions: videoAspect <= 1 && captionSplit.always.length ? captionSplit.always : null,
            // A horizontal clip's band captions: it's saved upright, with them in the bands.
            timedCaptions: videoAspect > 1
              ? (bandCaptions.length ? bandCaptions : null)
              : (captionSplit.timed.length ? captionSplit.timed : null),
            songId: song?.id ?? null,
            songPlays: !!song && !musicVideoOn,
            songMix: activeMix ? mixColumns(activeMix) : null,
          }).catch(() => {});
        }
        if (publishAt) setScheduledCount((n) => n + 1);
        if (ps) { clearPendingSpotlight(); setPendingSpotBanner(null); }
        if (isPublic) setPublicCount((c) => (c == null ? c : c + 1));
        // NO celebration here. At this point the file has not uploaded,
        // Cloudflare has not encoded it, and either can still fail and roll the
        // whole post back — the queue deletes the row and shows a retry card.
        // "Posted! 🎉 / Your post is now live" was therefore a claim the app
        // could not back up, and paired with an invisible progress card it left
        // the user holding a success message and an empty feed. The celebratory
        // buzz now fires from UploadQueueContext at real completion, where the
        // post genuinely exists.
        setPostedToast(scheduleAt != null
          ? { title: t('schedule.doneTitle'), message: t('schedule.uploadingBody', { when: scheduleWhen(scheduleAt) }), spotlight: false, uploading: true, scheduled: true }
          : {
              title: spotLabel ? t('post.postedSpotlightTitle') : t('post.uploadingTitle'),
              message: spotLabel
                ? t('post.postedSpotlightBody', { duration: spotlightDurationPhrase(spotLabel) })
                : t('post.uploadingBody'),
              spotlight: !!spotLabel,
              uploading: true,
            });
        resetAll();
        setLoading(false);
        return;
      }

      let mediaUrl = '';
      let thumbnailUrl: string | null = null;
      let coverUrl: string | null = null;
      let slidesPayload: Slide[] | null = null;

      if (postType === 'slideshow') {
        // Upload every slide, then mirror slide 1 onto media_url/thumbnail_url so
        // existing thumbnail surfaces show the cover.
        const built: Slide[] = [];
        for (const s of slides) {
          let url: string;
          // Hoisted out of the upload branch because the row below needs it too:
          // the shape decides BOTH what gets baked into the file and how the
          // finished file meets the frame.
          const shape = s.shape
            ?? ((s.fit ?? defaultSlideFit(previewAspect, s)) === 'contain' ? 'full' : format);
          // Whether this slide is cropped at all, which is now a question about
          // its SHAPE and not about its fit. A slide cropped square inside a
          // portrait frame is 'contain' — it shows its whole crop, with bars —
          // so keying the bake off 'contain', as this used to, would throw that
          // crop away. Slides from before shapes existed carry no shape and are
          // read the old way: not-contain meant cropped to the post's format.
          const cropped = s.type === 'image' && !isAutoFormat(shape);
          if (s.type === 'image') {
            let outUri = s.uri;
            try {
              // A slide left at Original uploads whole and the carousel
              // letterboxes it at render time. A cropped one bakes its rect —
              // falling back to the centred crop for that shape, because a slide
              // can be given a shape and never hand-framed, and it was PREVIEWED
              // in that shape. Uploading it uncropped would publish something
              // nobody was shown.
              const crop = cropped
                ? (s.crop && s.crop.width > 1 && s.crop.height > 1
                    ? s.crop
                    : centeredCrop(s.width, s.height, aspectToNumber(shape, previewAspect)))
                : null;
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
          built.push({
            type: s.type, url, thumbnail_url: thumb,
            // This slide's OWN ratio, which after baking is the shape it was
            // cropped to. It used to record the post format on every slide,
            // which is now wrong by construction — slides differ.
            aspect_ratio: s.type === 'image' && !isAutoFormat(shape) ? shape : format,
            // Measured against the shape the file now HAS, since the crop is
            // already baked in — a slide cropped square is a square file, and it
            // sits whole inside the frame rather than being cropped a second
            // time on the way to the feed. Original is honoured as 'contain'
            // even when the photo is taller than the frame: defaultSlideFit's
            // no-side-bars rule is about what a slide gets when NOBODY chose,
            // and here somebody did.
            fit: s.type === 'image'
              ? (cropped ? slideFitFor({ shape }, previewAspect) : 'contain')
              : (s.fit ?? defaultSlideFit(previewAspect, s)),
          });
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
      }
      // (video is handled earlier via the background upload queue and returns.)

      const trimmed = false; // videos (the only trimmed type) never reach here

      const { data: newPost, error: postError } = await supabase.from('posts').insert({
        user_id: user.id,
        // Scheduled: in the table now, hidden until then (post_scheduling.sql).
        ...(publishAt ? { publish_at: publishAt } : {}),
        type: postType === 'audio' ? audioKind : postType,
        media_url: mediaUrl,
        caption: caption.trim(),
        // Posting to a community is always public (the UI locks it; this is the
        // safety net so a community post can never be saved friends-only).
        is_public: hasCommunity ? true : isPublic,
        ...(genre && showGenre ? { genre } : {}),
        ...(audioDuration !== null ? { duration_seconds: audioDuration } : {}),
        ...(postType === 'image' ? { aspect_ratio: format } : {}),
        // 'full' and 'mixed' are composer modes, never storage values — the feed
        // lays a carousel out from a NUMBER, so they resolve to slide 1's ratio
        // on the way into the row.
        ...(postType === 'slideshow' ? {
          // The frame the composer laid these out in, which is measured across
          // the whole set — not `format`, which is now only a legacy fallback
          // for slides that predate per-slide shapes.
          aspect_ratio: String(previewAspect),
          slides: slidesPayload,
        } : {}),
        ...(trimmed
          ? { trim_start: trimStart, trim_end: trimEnd > trimStart ? trimEnd : Math.min(trimStart + videoWindowSec, videoDuration) }
          : {}),
        // Spread-conditional so a database without mature_content.sql applied
        // simply never sees the column and the insert still succeeds.
        ...(mature ? { mature: true } : {}),
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
        ...(coverUrl ? { cover_url: coverUrl } : {}),
        ...(song && postType !== 'audio'
          ? { song_id: song.id, song_title: song.title, song_artist: song.artist, song_artist_id: song.artistId }
          : {}),
        ...(tagged.length && postType !== 'audio' ? { tagged_user_ids: tagged.map((t) => t.id) } : {}),
        // Song "features" (collaborators) — audio posts only, ≤6.
        ...(features.length && postType === 'audio' ? { features: features.slice(0, 6) } : {}),
        ...(hasCommunity ? { community_ids: communities.map((c) => c.id) } : {}),
        // Creator controls: only send the flag relevant to the media type.
        // (video's allow_gifs is set in the background queue, not here.)
        ...(postType === 'audio' ? { downloadable: allowDownloads } : {}),
        // Sync consent, stamped with when it was given so the grant carries a
        // timestamp rather than being inferred from a column's current value.
        // Spread-conditional like the rest: a pre-migration database simply never
        // sees these columns.
        ...(postType === 'audio'
          ? { sound_opt_in: allowSound, sound_opt_in_at: new Date().toISOString() }
          : {}),
      }).select('id').single();
      if (postError) throw postError;
      notifySuccess(); // celebratory buzz on a published post
      if (isPublic) {
        // A scheduled post counts once it is live, when the badge next evaluates.
        if (!publishAt) bumpBadge('posts_created'); // recomputes the Posts badge from the live grid
        setPublicCount((c) => (c == null ? c : c + 1)); // slot hint stays honest
      }
      if (publishAt && newPost?.id && scheduleAt != null) {
        scheduleLiveReminder(newPost.id, scheduleAt);
        setScheduledCount((n) => n + 1);
      }

      // Notify @mentions in the caption, and the original artist if their song was used.
      if (newPost?.id) {
        // A scheduled post's notifications are the server's to send when it goes
        // live (publish_scheduled_posts) — sent now, they would open a post nobody
        // can see yet.
        if (!publishAt) processMentions({ text: caption.trim(), actorId: user.id, postId: newPost.id });
        if (!publishAt && song && postType !== 'audio' && song.artistId && song.artistId !== user.id) {
          createNotification({ userId: song.artistId, actorId: user.id, type: 'song_used', postId: newPost.id });
        }
        if (!publishAt && postType !== 'audio') {
          for (const t of tagged) {
            if (t.id !== user.id) createNotification({ userId: t.id, actorId: user.id, type: 'tag', postId: newPost.id });
          }
        }
        // Notify each credited collaborator (audio features).
        //
        // Only the ones with an account. A credit can now name someone who is
        // not on Laybell — their name renders on the song, but there is no user
        // to notify and no profile to open. Reaching those people needs a
        // "you've been credited, claim your profile" invite, which is a
        // different and larger piece of work.
        if (!publishAt && postType === 'audio') {
          for (const f of features) {
            if (f.id && f.id !== user.id) createNotification({ userId: f.id, actorId: user.id, type: 'tag', postId: newPost.id });
          }
        }
        // Put the track on its album. Last, and NOT awaited into the publish
        // result: the song is already live and correct at this point, and an
        // album row that fails to write is a track missing from a shelf the
        // owner can fix in two taps — not a reason to tell them the post failed.
        if (postType === 'audio' && albumId) {
          addAlbumTrack(albumId, newPost.id).catch(() => {});
        }
      }

      // The "create a brand new post" spotlight path: attach the paid campaign
      // to the post that was just created — the moment the spotlight goes live.
      let spotLabel: string | null = null;
      const ps = peekPendingSpotlight();
      if (ps && newPost?.id) {
        const ok = await activateCampaign(ps.campaignId, newPost.id, ps.days);
        if (ok) {
          spotLabel = ps.label;
        } else {
          // The post published but the Spotlight didn't attach. The campaign is
          // paid for and still sitting in the user's Spotlights — say so, rather
          // than clearing the handoff silently and leaving them to wonder why
          // the post they paid to promote isn't promoted.
          Alert.alert(t('spotlight.attachFailedTitle'), t('spotlight.attachFailedBody'));
        }
        clearPendingSpotlight();
        setPendingSpotBanner(null);
      }

      // If this post came from a saved draft, the draft has now been published
      // — remove it. (resetAll, below, clears the editing link, so capture +
      // delete first.)
      if (editingDraftId.current) deleteDraft(editingDraftId.current).then(setDrafts);

      // Polished in-app confirmation (replaces the default OS alert). Lands on
      // the pick step after resetAll, where the Toast is rendered.
      const posted = publishAt && scheduleAt != null
        ? { title: t('schedule.doneTitle'), message: t('schedule.doneBody', { when: scheduleWhen(scheduleAt) }), spotlight: false, scheduled: true }
        : {
            title: spotLabel ? t('post.postedSpotlightTitle') : t('post.postedTitle'),
            message: spotLabel
              ? t('post.postedSpotlightBody', { duration: spotlightDurationPhrase(spotLabel) })
              : t('post.postedBody'),
            spotlight: !!spotLabel,
            scheduled: false,
          };
      // The post exists, so it gets its moment — with the way to see it and to
      // share it (components/PostedCelebration). The toast is only the fallback.
      if (newPost?.id) {
        setCelebration({
          ...posted,
          postId: newPost.id,
          thumb: (postType === 'audio' ? coverUrl : postType === 'slideshow' ? (thumbnailUrl ?? mediaUrl) : mediaUrl) ?? null,
          caption: caption.trim(),
          type: postType === 'audio' ? audioKind : postType,
          mediaUrl: mediaUrl ?? null,
        });
      } else {
        setPostedToast(posted);
      }
      resetAll();
    } catch (err: any) {
      setError(friendlyShareError(err, t));
    }
    setUploadPct(null);
    setLoading(false);
  }

  // ─── Arrange step (slideshows) ─────────────────────────────────────────────
  if (step === 'arrange' && postType === 'slideshow' && slides.length > 0) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          {/* One back affordance, not two. With the crop sheet open this arrow
              closes it — keeping the crop — rather than leaving the step, which
              is why the sheet needs no Done button of its own. */}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('a11y.back')}
            style={styles.headerBtn}
            onPress={() => {
              if (arrangeCropping) { arrangerRef.current?.closeAdjust(); return; }
              arrangerRef.current?.commit();
              setStep('pick');
            }}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('post.arrangeTitle')}</Text>
          {/* While cropping, the right-hand action is a TICK that keeps the crop
              and returns — not the arrow onward. Advancing straight out of a
              crop skips the step of seeing what it did, and the arrow next to a
              crop reads as "go on" when what the user wants is "that's it".
              Both paths commit first: the crop lives inside the cropper until
              something asks for it, so leaving without asking discards it. */}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={arrangeCropping ? t('a11y.save') : t('a11y.forward')}
            style={styles.headerAction}
            onPress={() => {
              if (arrangeCropping) { arrangerRef.current?.closeAdjust(); return; }
              arrangerRef.current?.commit();
              setStep('details');
            }}
          >
            <Ionicons name={arrangeCropping ? 'checkmark' : 'arrow-forward'} size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ErrorBoundary label={t('post.cantOpenPhoto')}>
          <SlideArranger
            ref={arrangerRef}
            slides={slides}
            frameW={frameW}
            frameH={frameH}
            format={format}
            onAdjustingChange={setArrangeCropping}
            onChange={(next) => setSlides(next as typeof slides)}
          />
        </ErrorBoundary>
      </View>
    );
  }

  // ─── Trim step (long videos) ───────────────────────────────────────────────
  if (step === 'edit' && media && postType === 'video') {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => setStep('pick')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('post.trim')}</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.forward')} style={styles.headerAction} onPress={() => setStep('studio')}>
            <Ionicons name="arrow-forward" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
        <View style={styles.trimBody}>
          <VideoTrimmer
            uri={media.uri}
            posterUri={media.posterUri}
            duration={videoDuration}
            windowSec={videoWindowSec}
            frameW={frameW}
            frameH={frameH}
            onChange={(s, e) => { setTrimStart(s); setTrimEnd(e); }}
            initialStart={trimStart}
            initialEnd={trimEnd || undefined}
          />
        </View>
      </View>
    );
  }

  // ─── Studio step (videos) ──────────────────────────────────────────────────
  // Captions, music, the sound mix and the cover, on one full-screen editor
  // between picking (or trimming) and the details — see components/VideoStudio.
  if (step === 'studio' && media && postType === 'video') {
    const trimmedV = videoDuration > videoWindowSec;
    // The part that gets posted — the same window publish times the captions in.
    const winStart = trimmedV ? trimStart : 0;
    const winEnd = trimmedV ? (trimEnd > trimStart ? trimEnd : Math.min(trimStart + videoWindowSec, videoDuration)) : videoDuration;
    const keep = (r: StudioResult) => {
      setStudioPanel(null);
      setVideoCaptions(r.captions);
      if (r.mix && song && !musicVideoOn) setSongMix({ ...r.mix, songId: song.id });
    };
    return (
      <View style={styles.container}>
        <VideoStudio
          videoUri={media.uri}
          posterUri={thumbnailUri ?? media.posterUri ?? null}
          aspect={videoAspect}
          windowStart={winStart}
          windowEnd={winEnd}
          initialCaptions={videoCaptions}
          song={song}
          onSong={setSong}
          musicVideo={musicVideo}
          onMusicVideo={setMusicVideo}
          songMix={activeMix}
          coverUri={thumbnailUri}
          onCover={setThumbnailUri}
          coverSec={coverSec}
          onCoverSec={setCoverSec}
          initialPanel={studioPanel}
          onBack={(r) => { keep(r); setStep(trimmedV ? 'edit' : 'pick'); }}
          onNext={(r) => { keep(r); setStep('details'); }}
        />
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
    // Communities: in the right column for a video — whose music lives in the
    // studio, one Back away — and full width under the caption for everything else.
    const communityField = (compact: boolean) => (
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t('communities.postLabel')}</Text>
        <TouchableOpacity style={styles.dropdown} onPress={() => setShowCommunityPicker(true)} activeOpacity={0.8}>
          <Ionicons name="people" size={15} color={hasCommunity ? colors.primary : colors.textTertiary} />
          <Text style={[styles.dropdownText, !hasCommunity && styles.dropdownPlaceholder]} numberOfLines={1}>
            {communities.length === 0 ? (compact ? t('communities.addShort') : t('communities.addToCommunity'))
              : communities.length === 1 ? communities[0].name
              : t('communities.communityCount', { count: communities.length })}
          </Text>
          {hasCommunity ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} onPress={() => setCommunities([])} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          ) : (
            <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
          )}
        </TouchableOpacity>
      </View>
    );
    // The two menu buttons' choices.
    const visibilityOptions: MenuOption[] = [
      { key: 'public', label: t('post.public'), sub: t('post.publicSub'), icon: 'globe-outline', selected: isPublic, onPress: () => setIsPublic(true) },
      { key: 'friends', label: t('post.friendsOnly'), sub: t('post.friendsOnlySub'), icon: 'people-outline', selected: !isPublic, onPress: () => setIsPublic(false) },
    ];
    const timeOptions: MenuOption[] = [
      { key: 'now', label: t('schedule.postNow'), icon: 'paper-plane-outline', selected: scheduleAt == null, onPress: () => setScheduleAt(null) },
      {
        key: 'later',
        label: scheduleAt != null ? t('schedule.changeTime') : t('schedule.menuLater'),
        sub: scheduleAt != null ? scheduleWhen(scheduleAt) : undefined,
        icon: 'calendar-outline',
        selected: scheduleAt != null,
        // Opens the day-and-time sheet once the menu has gone.
        presents: true,
        onPress: () => setShowSchedule(true),
      },
    ];
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          {/* Back goes to whichever step actually preceded this one. A slideshow
              came through Arrange, and dropping the user past it to the picker
              would look like their crops and ordering had been thrown away. */}
          {/* The same width as the Share pill's side, so the title stays centred — but
              the arrow itself keeps its usual button at the left edge. */}
          <View style={styles.headerSideStart}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => setStep(slideshowMode && slides.length > 0 ? 'arrange' : postType === 'video' && media ? 'studio' : 'pick')}>
              <Ionicons name="chevron-back" size={26} color={colors.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.headerTitle}>{t('post.newPost')}</Text>
          {/* The terminal action as a pill that sizes to its word — the old slot was
              a fixed 64 pt, which broke "Schedule" over two lines. Black on light and
              white on dark, like the Share button at the bottom (owner, 2026-09-11).
              Both header sides are the same width, so the title stays centred. */}
          <View style={styles.headerSideWide}>
            <TouchableOpacity
              style={[styles.sharePill, loading && styles.sharePillBusy]}
              onPress={handleShare}
              disabled={loading}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              {loading ? (
                uploadPct != null
                  ? <Text style={styles.sharePillText}>{Math.round(uploadPct * 100)}%</Text>
                  : <ActivityIndicator color={colors.background} size="small" />
              ) : (
                <>
                  <Ionicons name={scheduleAt != null ? 'calendar' : 'paper-plane'} size={14} color={colors.background} />
                  <Text style={styles.sharePillText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                    {scheduleAt != null ? t('schedule.shareBtn') : t('post.share')}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
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
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')}
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
              {/* Bigger post preview, with a Tag-people shortcut overlaid on it.
                  For VIDEO posts the square opens the studio's cover picker (any
                  frame from the clip, or a camera-roll image). */}
              <View style={styles.previewCol}>
                <TouchableOpacity
                  style={styles.previewBig}
                  activeOpacity={postType === 'video' && media?.uri ? 0.85 : 1}
                  disabled={!(postType === 'video' && media?.uri)}
                  onPress={() => { setStudioPanel('cover'); setStep('studio'); }}
                >
                  {thumbUri ? (
                    // ExpoImage renders ph:// reliably and degrades to empty (not a
                    // broken-image glyph) if the file is gone — unlike RN core Image.
                    <ExpoImage source={{ uri: thumbUri }} style={styles.previewBig} contentFit="cover" />
                  ) : (
                    <View style={[styles.previewBig, styles.previewBigPlaceholder]}>
                      <Ionicons name="image-outline" size={28} color={colors.textTertiary} />
                    </View>
                  )}
                </TouchableOpacity>
                {postType === 'video' && !!media?.uri && (
                  <View style={styles.coverOverlay} pointerEvents="none">
                    <Ionicons name="images-outline" size={12} color="#fff" />
                    <Text style={styles.tagOverlayText}>{t('post.editCover')}</Text>
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

              {/* Right column: Genre, then Music — or, on a video, Communities. */}
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
                {postType === 'video' ? (
                  // No Video field: its music, sound, text and cover are all in the
                  // studio, one Back away. Its communities sit here instead.
                  communityField(true)
                ) : (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>{t('post.musicLabel')}</Text>
                    <TouchableOpacity style={styles.dropdown} onPress={() => setShowSongPicker(true)} activeOpacity={0.8}>
                      <Ionicons name="musical-notes" size={15} color={song ? colors.primary : colors.textTertiary} />
                      <Text style={[styles.dropdownText, !song && styles.dropdownPlaceholder]} numberOfLines={1}>
                        {song ? song.title : t('post.addMusic')}
                      </Text>
                      {song ? (
                        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} onPress={() => setSong(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                        </TouchableOpacity>
                      ) : (
                        <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
                      )}
                    </TouchableOpacity>
                  </View>
                )}
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

          {/* Cover art (audio) — the artwork IS the release, so it gets to be
              the size of one rather than a 72pt thumbnail on a settings row.
              Features moved onto its bottom corner: crediting a collaborator is
              a fact about this artwork's song, and it was competing for the eye
              as a second identical row directly beneath. */}
          {postType === 'audio' && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{t('post.coverArt')}</Text>
              <View style={styles.coverStage}>
                <TouchableOpacity style={styles.coverBox} onPress={pickCover} activeOpacity={0.75} disabled={coverBusy}>
                  {coverUri ? (
                    <Image source={{ uri: coverUri }} style={styles.coverBoxImage} />
                  ) : (
                    <View style={styles.coverBoxEmpty}>
                      <Ionicons name="image-outline" size={40} color={colors.textTertiary} />
                      <Text style={styles.coverBoxTitle}>{t('post.addCoverArt')}</Text>
                      <Text style={styles.coverBoxSub}>{t('post.coverHint')}</Text>
                    </View>
                  )}
                  {/* Only over a real image: on the empty state it would be a
                      button floating on instructions telling you to press the
                      thing underneath it. */}
                  {!!coverUri && (
                    <View style={styles.coverChangeTag} pointerEvents="none">
                      <Text style={styles.coverChangeTagText}>{t('post.coverChangeHint')}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.coverCornerBtn, features.length > 0 && styles.coverCornerBtnOn]}
                  onPress={() => setShowFeaturesModal(true)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={t('features.title')}
                >
                  <Ionicons name="people" size={15} color={features.length ? colors.background : colors.text} />
                  <Text style={[styles.coverCornerBtnText, features.length > 0 && styles.coverCornerBtnTextOn]} numberOfLines={1}>
                    {features.length ? features.map((f) => f.name).join(', ') : t('features.add')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Album (audio) — optional, and quiet about it. Most songs are
              singles, so this is a row that says "no album" until someone means
              otherwise, rather than a step that has to be dismissed. */}
          {postType === 'audio' && (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('album.section')}</Text>
              <TouchableOpacity
                style={styles.dropdown}
                onPress={async () => {
                  setShowAlbumPicker(true);
                  const { data: { user } } = await supabase.auth.getUser();
                  if (user) { try { setAlbums(await fetchAlbums(user.id)); } catch { setAlbums([]); } }
                }}
                activeOpacity={0.8}
              >
                <Text style={[styles.dropdownText, !albumId && styles.dropdownPlaceholder]} numberOfLines={1}>
                  {albums.find((a) => a.id === albumId)?.title ?? t('album.none')}
                </Text>
                <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
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

          {/* FILM title — the movie-shelf name shown on the Laybell TV rail.
              Only a film (Premium+ landscape past the free window) sees it;
              captions make bad movie titles, so it gets its own slim box. */}
          {isFilm && (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('film.titleLabel')}</Text>
              <TextInput
                style={styles.titleBox}
                placeholder={t('film.titlePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={filmTitle}
                onChangeText={setFilmTitle}
                maxLength={120}
                editable={!swiping}
              />
            </View>
          )}

          {/* Caption (media) / Title (music) — full width. Music uses a slim,
              single-line box labelled "Title" to discourage caption-like names. */}
          <View style={styles.field}>
            {postType === 'audio' && <Text style={styles.fieldLabel}>{t('post.titleLabel')}</Text>}
            <TextInput
              style={postType === 'audio' ? styles.titleBox : styles.captionBox}
              placeholder={postType === 'audio' ? t('post.titlePlaceholder') : t('post.captionPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={caption}
              onChangeText={setCaption}
              onSelectionChange={(e) => setCaptionCursor(e.nativeEvent.selection.end)}
              multiline={postType !== 'audio'}
              // Cap the title where the song-card marquee can still reveal it
              // in full (see MEASURE_W in SongCardTitle) — longer would scroll
              // past what the measurer covers and get cut off.
              maxLength={postType === 'audio' ? 80 : 500}
              editable={!swiping}
            />
            <Text style={[styles.captionCount, caption.length >= (postType === 'audio' ? 80 : 500) * 0.9 && { color: colors.error }]}>
              {caption.length}/{postType === 'audio' ? 80 : 500}
            </Text>
            {/* At the cursor, not the end: an @ typed mid-caption suggests too. */}
            <MentionSuggestions
              query={getActiveMentionQuery(caption, captionCursor)}
              onPick={(u) => { const r = applyMention(caption, captionCursor, u); setCaption(r.text); setCaptionCursor(r.cursor); }}
            />
          </View>

          {/* Communities, full width — a video has them beside its genre instead. */}
          {postType !== 'video' && communityField(false)}

          {/* Who sees it and when it goes up, side by side: two iOS-style menu
              buttons (components/PullDownMenu). A community post is always public
              and a spotlighted one goes up right away, so each locks then. */}
          <View style={styles.tileRow}>
            <View ref={visTileRef} collapsable={false} style={styles.tileWrap}>
              <TouchableOpacity
                style={[
                  styles.tile,
                  { backgroundColor: hasCommunity || isPublic ? IOS_BLUE : IOS_GREEN, shadowColor: hasCommunity || isPublic ? IOS_BLUE : IOS_GREEN },
                  hasCommunity && styles.tileLocked,
                ]}
                onPress={() => openTileMenu('visibility')}
                disabled={hasCommunity}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`${t('editPost.visibility')}: ${hasCommunity || isPublic ? t('post.public') : t('post.friendsOnly')}`}
              >
                <View style={styles.tileIcon}>
                  <Ionicons name={hasCommunity || isPublic ? 'globe' : 'people'} size={21} color="#fff" />
                </View>
                <View style={styles.tileText}>
                  <View style={styles.tileTitleRow}>
                    <Text style={styles.tileTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                      {hasCommunity || isPublic ? t('post.public') : t('post.friendsOnly')}
                    </Text>
                    <Ionicons name={hasCommunity ? 'lock-closed' : 'chevron-expand'} size={12} color="rgba(255,255,255,0.9)" />
                  </View>
                  <Text style={styles.tileSub} numberOfLines={2}>
                    {hasCommunity ? t('post.visCommunityShort') : isPublic ? t('post.visPublicShort') : t('post.visFriendsShort')}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
            <View ref={timeTileRef} collapsable={false} style={styles.tileWrap}>
              <TouchableOpacity
                style={[
                  styles.tile,
                  { backgroundColor: scheduleAt != null ? IOS_INDIGO : IOS_ORANGE, shadowColor: scheduleAt != null ? IOS_INDIGO : IOS_ORANGE },
                  !!pendingSpot && styles.tileLocked,
                ]}
                onPress={() => openTileMenu('time')}
                disabled={!!pendingSpot}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`${t('schedule.row')}: ${scheduleAt != null ? scheduleWhen(scheduleAt) : t('schedule.postNow')}`}
              >
                <View style={styles.tileIcon}>
                  <Ionicons name={scheduleAt != null ? 'calendar' : 'paper-plane'} size={20} color="#fff" />
                </View>
                <View style={styles.tileText}>
                  <View style={styles.tileTitleRow}>
                    <Text style={styles.tileTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                      {scheduleAt != null ? t('schedule.doneTitle') : t('schedule.postNow')}
                    </Text>
                    <Ionicons name={pendingSpot ? 'lock-closed' : 'chevron-expand'} size={12} color="rgba(255,255,255,0.9)" />
                  </View>
                  <Text style={styles.tileSub} numberOfLines={2}>
                    {pendingSpot ? t('schedule.tileSpotlightSub') : scheduleAt != null ? scheduleWhen(scheduleAt) : t('schedule.tileNowSub')}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>

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

          {/* Audio only, and kept in view rather than folded into Advanced: this is
              the per-track sync consent — the entire legal basis for anyone attaching
              this song to their video. It has to be visible and its own choice, not
              folded into the general upload grant. See lib/sounds.ts and
              supabase/sql/sound_optin.sql. */}
          {postType === 'audio' && (
            <View style={styles.settingsCard}>
              <SettingSwitch
                label={t('post.allowSoundLabel')}
                value={allowSound}
                onChange={setAllowSound}
                onInfo={() => setInfo({ icon: 'musical-notes-outline', title: t('post.allowSoundLabel'), body: t('post.allowSoundHelp') })}
                infoLabel={t('post.learnMore')}
                last
                styles={styles}
                colors={colors}
              />
            </View>
          )}

          {/* The per-post switches most posts never change — mature content, GIFs in
              the comments, a track's downloads — folded under a quiet header. While
              it is closed, a dot says one of them is not at its default. Mature
              content is offered for every post type, because adult themes are not
              only a visual question; the gate in mature_content.sql does nothing
              until it is switched on. */}
          <View style={styles.advanced}>
            <TouchableOpacity
              style={styles.advancedHeader}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
                setAdvancedOpen((open) => !open);
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedOpen }}
            >
              <Ionicons name="options-outline" size={16} color={colors.textSecondary} />
              <Text style={styles.advancedTitle}>{t('post.advancedSettings')}</Text>
              {!advancedOpen && (mature || (postType === 'video' && !allowGifs) || (postType === 'audio' && !allowDownloads) || (postType === 'video' && !isFilm && canSaveFinishedVideo() && !saveToCameraRoll)) && (
                <View style={styles.advancedDot} />
              )}
              <Ionicons name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={15} color={colors.textSecondary} />
            </TouchableOpacity>
            {advancedOpen && (
              <View style={styles.settingsCard}>
                {postType === 'audio' && (
                  <SettingSwitch
                    label={t('offline.downloadableLabel')}
                    value={allowDownloads}
                    onChange={setAllowDownloads}
                    onInfo={() => setInfo({ icon: 'cloud-download-outline', title: t('offline.downloadableLabel'), body: t('offline.downloadableHelp') })}
                    infoLabel={t('post.learnMore')}
                    styles={styles}
                    colors={colors}
                  />
                )}
                {postType === 'video' && !isFilm && canSaveFinishedVideo() && (
                  <SettingSwitch
                    label={t('post.saveVideoLabel')}
                    value={saveToCameraRoll}
                    onChange={setSaveToCameraRoll}
                    onInfo={() => setInfo({ icon: 'download-outline', title: t('post.saveVideoLabel'), body: t('post.saveVideoHelp') })}
                    infoLabel={t('post.learnMore')}
                    styles={styles}
                    colors={colors}
                  />
                )}
                <SettingSwitch
                  label={t('post.matureLabel')}
                  value={mature}
                  onChange={setMature}
                  onInfo={() => setInfo({ icon: 'alert-circle-outline', title: t('post.matureLabel'), body: t('post.matureHelp') })}
                  infoLabel={t('post.learnMore')}
                  last={postType !== 'video'}
                  styles={styles}
                  colors={colors}
                />
                {postType === 'video' && (
                  <SettingSwitch
                    label={t('post.allowGifsLabel')}
                    value={allowGifs}
                    onChange={setAllowGifs}
                    onInfo={() => setInfo({ icon: 'film-outline', title: t('post.allowGifsLabel'), body: t('post.allowGifsHelp') })}
                    infoLabel={t('post.learnMore')}
                    last
                    styles={styles}
                    colors={colors}
                  />
                )}
              </View>
            )}
          </View>

          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* The post's main action where the thumb already is when the form is
              done — the header's Share is easy to lose after a long scroll. */}
          <TouchableOpacity
            style={[styles.shareCta, loading && styles.draftSaveBtnDisabled]}
            onPress={handleShare}
            disabled={loading}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            {loading ? (
              <ActivityIndicator color={colors.background} size="small" />
            ) : (
              <>
                <Ionicons name={scheduleAt != null ? 'calendar' : 'paper-plane'} size={18} color={colors.background} />
                <Text style={styles.shareCtaText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                  {scheduleAt != null ? t('schedule.ctaFor', { when: scheduleWhen(scheduleAt) }) : t('post.share')}
                </Text>
              </>
            )}
          </TouchableOpacity>

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
        <SongPickerModal visible={showSongPicker} onClose={() => setShowSongPicker(false)} onSelect={setSong} ownOnly={musicVideoOn} />
        <TagPeopleModal visible={showTagModal} initial={tagged} onClose={() => setShowTagModal(false)} onDone={setTagged} />
        <SchedulePicker
          visible={showSchedule}
          value={scheduleAt}
          onClose={() => setShowSchedule(false)}
          onSet={(at) => { setScheduleAt(at); setShowSchedule(false); setError(''); }}
          onClear={() => { setScheduleAt(null); setShowSchedule(false); }}
        />
        <PullDownMenu
          visible={!!tileMenu}
          anchor={tileMenu?.anchor ?? null}
          options={tileMenu?.kind === 'time' ? timeOptions : visibilityOptions}
          onClose={() => setTileMenu(null)}
        />
        <FeaturesModal visible={showFeaturesModal} initial={features} onClose={() => setShowFeaturesModal(false)} onDone={setFeatures} />
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

        {/* Album picker — existing albums, or name a new one on the spot. The
            create field is IN the sheet rather than behind another screen: the
            moment someone wants an album is while posting the first track of
            one, and sending them elsewhere to make it loses the post. */}
        <Modal visible={showAlbumPicker} transparent animationType="fade" onRequestClose={() => setShowAlbumPicker(false)}>
          <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setShowAlbumPicker(false)}>
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>{t('album.section')}</Text>
              <ScrollView contentContainerStyle={styles.albumSheetList} keyboardShouldPersistTaps="handled">
                <TouchableOpacity
                  style={[styles.albumOption, !albumId && styles.albumOptionActive]}
                  onPress={() => { setAlbumId(null); setShowAlbumPicker(false); }}
                >
                  <Text style={[styles.albumOptionText, !albumId && styles.albumOptionTextActive]}>{t('album.none')}</Text>
                  {!albumId && <Ionicons name="checkmark" size={17} color={colors.background} />}
                </TouchableOpacity>
                {albums.map((a) => {
                  const on = albumId === a.id;
                  return (
                    <TouchableOpacity
                      key={a.id}
                      style={[styles.albumOption, on && styles.albumOptionActive]}
                      onPress={() => { setAlbumId(a.id); setShowAlbumPicker(false); }}
                    >
                      <Text style={[styles.albumOptionText, on && styles.albumOptionTextActive]} numberOfLines={1}>{a.title}</Text>
                      {on && <Ionicons name="checkmark" size={17} color={colors.background} />}
                    </TouchableOpacity>
                  );
                })}
                <View style={styles.albumNewRow}>
                  <TextInput
                    style={styles.albumNewInput}
                    placeholder={t('album.newPlaceholder')}
                    placeholderTextColor={colors.textTertiary}
                    value={newAlbumName}
                    onChangeText={setNewAlbumName}
                    maxLength={120}
                    returnKeyType="done"
                  />
                  <TouchableOpacity
                    style={[styles.albumNewBtn, !newAlbumName.trim() && styles.albumNewBtnOff]}
                    disabled={!newAlbumName.trim()}
                    onPress={async () => {
                      const { data: { user } } = await supabase.auth.getUser();
                      if (!user) return;
                      try {
                        const made = await createAlbum(user.id, newAlbumName);
                        setAlbums((prev) => [made, ...prev]);
                        setAlbumId(made.id);
                        setNewAlbumName('');
                        setShowAlbumPicker(false);
                      } catch { /* the sheet stays open, nothing is lost */ }
                    }}
                  >
                    <Text style={styles.albumNewBtnText}>{t('album.create')}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.albumSheetHint}>{t('album.sheetHint')}</Text>
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* The film heads-up MUST live here as well as in the pick step: this
            screen owns the Share button, and each step returns its own tree, so
            a dialog mounted only in the pick step simply does not exist while
            the user is standing on the one screen that opens it. */}
        <ConfirmDialog
          visible={!!filmNotice}
          icon="film"
          title={t('film.longUploadTitle')}
          message={t('film.longUploadBody', { minutes: String(filmNotice?.minutes ?? 10) })}
          confirmLabel={t('film.startUpload')}
          cancelLabel={t('film.notNow')}
          onConfirm={() => { filmNotice?.resolve(true); setFilmNotice(null); }}
          onCancel={() => { filmNotice?.resolve(false); setFilmNotice(null); }}
        />
      </View>
    );
  }

  // ─── Pick step (Instagram-style) ───────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBtn} onPress={() => { if (hasMedia || caption.trim()) setConfirmExit(true); else exitToExplore(); }} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
          <Ionicons name="close" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('post.newPost')}</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.forward')} style={styles.headerAction} onPress={goNext} disabled={!hasMedia}>
          <Ionicons name="arrow-forward" size={24} color={hasMedia ? colors.text : colors.textTertiary} />
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
      {/* Scheduled posts waiting to go live, managed on their own screen. */}
      {scheduledCount > 0 && (
        <TouchableOpacity style={styles.draftsBar} onPress={() => router.push('/scheduled')} activeOpacity={0.7}>
          <Ionicons name="calendar-outline" size={16} color={colors.primary} />
          <Text style={styles.draftsBarText}>
            {t('schedule.screenTitle')} <Text style={styles.draftsBarCount}>({scheduledCount})</Text>
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
              {/* A real disc rather than the play-circle glyph. This is the one
                  thing on the screen worth touching before Next, and a flat icon
                  the same weight as the text beside it did not say so. Drawn as
                  a view so it can carry a shadow and lift off the page. */}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={isPreviewPlaying ? t('a11y.pause') : t('a11y.play')}
                onPress={togglePreview}
                activeOpacity={0.85}
                hitSlop={10}
                style={styles.audioPlayBtn}
              >
                <Ionicons
                  name={isPreviewPlaying ? 'pause' : 'play'}
                  size={38}
                  color={colors.background}
                  // A play triangle's optical centre sits left of its bounding
                  // box, so centring it geometrically leaves it looking shoved
                  // left. Pause is symmetric and needs no help.
                  style={isPreviewPlaying ? undefined : styles.audioPlayGlyph}
                />
              </TouchableOpacity>
              <Text style={styles.audioPickTitle} numberOfLines={1}>{audioFile.name || t('post.audioSelected')}</Text>
              <Text style={styles.audioPickSub}>
                {audioDuration != null ? `${fmtClock(audioDuration)} · ` : ''}{isPreviewPlaying ? t('post.playing') : t('post.tapToPreview')}
              </Text>
              {/* No icons. A cloud and a mic beside two words that already say
                  Replace and Record new were decoration doing a job the words
                  had done — and the pair reads as one control now that they are
                  equal halves rather than two different widths. */}
              <View style={styles.audioSelBtns}>
                <TouchableOpacity style={styles.audioSelBtn} onPress={pickAudio} activeOpacity={0.85}>
                  <Text style={styles.audioSelBtnText}>{t('post.replace')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.audioSelBtn} onPress={() => { setAudioFile(null); setAudioDuration(null); startRecording(); }} activeOpacity={0.85}>
                  <Text style={styles.audioSelBtnText}>{t('post.recordNew')}</Text>
                </TouchableOpacity>
              </View>
            </View>
            {/* Pinned to the floor, and held to ONE line. It is a footnote about
                limits — wrapping to two put it in the middle of the page arguing
                with the track for attention. */}
            <Text
              style={styles.audioPickHint}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
            >
              {t('post.audioLimitsHint', { music: fmtMins(MUSIC_MAX_SEC), spoken: fmtMins(SPOKEN_MAX_SEC) })}
            </Text>
          </View>
        ) : (
          // Record / Upload split the FULL area into two halves divided by a shallow
          // diagonal: a rotated, oversized board (clipped to the frame) so the seam
          // reads as a near-horizontal diagonal; content counter-rotates upright.
          <View style={styles.audioChoices}>
            <View style={styles.diagBoard}>
              {/* RECORD used to be a full-bleed brand gradient. Neutral now
                  (owner, 2026-08-28), which meant everything sitting on it had to
                  move with it: the label and sub were hardcoded #fff for that
                  orange ground and would have been white-on-near-white the moment
                  the light theme loaded, and the mic's white-22% badge had nothing
                  left to sit on.
                  The two halves stay distinguishable by TONE rather than hue —
                  `surface` here is recessed, `surfaceElevated` on Upload is
                  raised — which the diagonal seam and its border already lean on. */}
              <TouchableOpacity style={[styles.diagHalf, styles.diagRecord]} onPress={startRecording} activeOpacity={0.9}>
                <View style={styles.diagContent}>
                  <View style={[styles.diagIconWrap, styles.diagIconWrapRecord]}>
                    <Ionicons name="mic" size={42} color={colors.text} />
                  </View>
                  <Text style={styles.diagTitle}>{t('post.record')}</Text>
                  <Text style={styles.diagSub}>{t('post.recordSub')}</Text>
                </View>
              </TouchableOpacity>
              {/* UPLOAD is the light half. On the dark theme it is a white slab
                  with black content — the loudest a surface can be on a near-
                  black page without spending the accent, and the last orange
                  emblem left on this screen goes with it. Light mode keeps its
                  raised off-white: a white slab on a near-white page would have
                  no edge at all, which is the same asymmetry the TV pill and
                  Live's background both settled on. */}
              <TouchableOpacity style={[styles.diagHalf, styles.diagUpload]} onPress={pickAudio} activeOpacity={0.9}>
                <View style={styles.diagContent}>
                  <View style={[styles.diagIconWrap, styles.diagIconWrapUpload]}>
                    <Ionicons name="cloud-upload-outline" size={42} color={uploadInk} />
                  </View>
                  <Text style={[styles.diagTitle, { color: uploadInk }]}>{t('post.upload')}</Text>
                  <Text style={[styles.diagSub, { color: uploadInkSoft }]}>MP3 · WAV · M4A</Text>
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
          <Animated.View style={[styles.previewArea, { height: previewH }]}>
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
            {/* Aspect toggle — SINGLE images only. Videos already publish at
                their native shape, and a slideshow's frame moved to Arrange. */}
            {!slideshowMode && postType === 'image' && media && (
              <TouchableOpacity style={styles.aspectBtn} onPress={cycleFormat}>
                <Ionicons name="resize-outline" size={16} color={colors.text} />
                {/* '1:1' reads as a ratio on its own; 'full' needs a word, since
                    there is no number to show. */}
                <Text style={styles.aspectBtnText}>
                  {isAutoFormat(format) ? t(`post.format.${format}`) : format}
                </Text>
              </TouchableOpacity>
            )}
            {/* Remove the selected media from the square (single mode) */}
            {!slideshowMode && media && (
              <TouchableOpacity style={styles.removeBtn} onPress={clearMedia} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
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

          {/* Mode button (Single ▾ / Slideshow ▾) + hint. The dropdown holds the
              other mode and Post from Files. */}
          <View style={styles.recentsRow}>
            {/* collapsable=false so Android can measureInWindow this anchor. */}
            <View ref={modeBtnRef} collapsable={false}>
              <TouchableOpacity
                onPress={openModeMenu}
                disabled={importingFile}
                style={styles.modeBtn}
                accessibilityRole="button"
                accessibilityLabel={slideshowMode ? t('post.slideshow') : t('post.single')}
              >
                <Text style={styles.modeBtnText}>{slideshowMode ? t('post.slideshow') : t('post.single')}</Text>
                {importingFile
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />}
              </TouchableOpacity>
            </View>
            <Text style={[styles.recentsHint, styles.recentsHintFlex]} numberOfLines={1}>
              {slideshowMode ? t('post.slideshowCountHint', { count: slides.length, max: MAX_SLIDES }) : t('post.tapPhotoVideo')}
            </Text>
          </View>

          {/* The mode dropdown. */}
          <Modal
            visible={modeMenuOpen}
            transparent
            animationType="none"
            statusBarTranslucent
            onRequestClose={() => setModeMenuOpen(false)}
            onDismiss={() => {
              const a = pendingMenuAction.current;
              pendingMenuAction.current = null;
              a?.();
            }}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setModeMenuOpen(false)}>
              {modeMenuAnchor && (
                <Animated.View
                  style={[
                    styles.modeMenu,
                    { top: modeMenuAnchor.y + modeMenuAnchor.h + 6, left: modeMenuAnchor.x },
                    {
                      opacity: modeMenuAnim,
                      transform: [
                        { translateY: modeMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
                        { scale: modeMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                      ],
                    },
                  ]}
                >
                  <TouchableOpacity
                    style={styles.modeMenuItem}
                    onPress={() => chooseMode(enterSingle)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="image-outline" size={17} color={colors.text} />
                    <Text style={styles.modeMenuLabel}>{t('post.single')}</Text>
                    {!slideshowMode && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                  </TouchableOpacity>
                  <View style={styles.modeMenuDivider} />
                  <TouchableOpacity
                    style={styles.modeMenuItem}
                    onPress={() => chooseMode(enterSlideshow)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="albums-outline" size={17} color={colors.text} />
                    <Text style={styles.modeMenuLabel}>{t('post.slideshow')}</Text>
                    {slideshowMode && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                  </TouchableOpacity>
                  <View style={styles.modeMenuDivider} />
                  <TouchableOpacity
                    style={styles.modeMenuItem}
                    onPress={() => chooseMode(importFromFiles, true)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="folder-open-outline" size={17} color={colors.text} />
                    <Text style={styles.modeMenuLabel}>{t('post.fromFiles')}</Text>
                  </TouchableOpacity>
                </Animated.View>
              )}
            </Pressable>
          </Modal>

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
                onCamera={() => setCameraOpen(true)}
                onScroll={onGridScroll}
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

      {/* The in-app camera, from the grid's camera tile. A slideshow's recording is
          capped at what its video budget has left. */}
      <Modal
        visible={cameraOpen}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => { if (!cameraBusy) closeCamera(); }}
        onDismiss={() => {
          const a = pendingCameraAction.current;
          pendingCameraAction.current = null;
          a?.();
        }}
      >
        <CaptureCamera
          active
          focused
          maxVideoSec={slideshowMode
            ? Math.max(1, Math.floor(SLIDESHOW_VIDEO_BUDGET_SEC - slideshowVideoSecs(slides)))
            : VIDEO_MAX_SEC}
          onCapture={onCameraCapture}
          onClose={() => closeCamera()}
          onLibrary={() => closeCamera()}
          closeLabel={t('common.back')}
        />
        {cameraBusy && (
          <View style={[StyleSheet.absoluteFill, styles.cameraBusy]}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        )}
      </Modal>

      {/* Saved drafts — resume or delete. Local to this device. */}
      <Modal visible={draftsOpen} animationType="slide" onRequestClose={() => setDraftsOpen(false)}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} style={styles.headerBtn} onPress={() => setDraftsOpen(false)}>
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

      {/* Films take real time — say so in Laybell's own voice BEFORE any work
          starts, rather than through a bare system alert. Setting expectations
          is the difference between a patient wait and a broken-feeling app. */}
      <ConfirmDialog
        visible={!!filmNotice}
        icon="film"
        title={t('film.longUploadTitle')}
        message={t('film.longUploadBody', { minutes: String(filmNotice?.minutes ?? 10) })}
        confirmLabel={t('film.startUpload')}
        cancelLabel={t('film.notNow')}
        onConfirm={() => { filmNotice?.resolve(true); setFilmNotice(null); }}
        onCancel={() => { filmNotice?.resolve(false); setFilmNotice(null); }}
      />

      {/* Leaving with a post in progress: throw it away, keep it as a draft, or stay. */}
      {Platform.OS === 'ios' ? (
        <FullWindowOverlay>
          <ConfirmDialog
            visible={confirmExit}
            icon="trash-outline"
            destructive
            title={t('compose.discardTitle')}
            message={t('compose.discardBody')}
            confirmLabel={t('compose.discard')}
            secondaryLabel={t('post.saveDraft')}
            onSecondary={() => { setConfirmExit(false); handleSaveDraft(); }}
            onConfirm={() => { setConfirmExit(false); exitToExplore(); }}
            onCancel={() => setConfirmExit(false)}
          />
        </FullWindowOverlay>
      ) : (
        <ConfirmDialog
          visible={confirmExit}
          icon="trash-outline"
          destructive
          title={t('compose.discardTitle')}
          message={t('compose.discardBody')}
          confirmLabel={t('compose.discard')}
          secondaryLabel={t('post.saveDraft')}
          onSecondary={() => { setConfirmExit(false); handleSaveDraft(); }}
          onConfirm={() => { setConfirmExit(false); exitToExplore(); }}
          onCancel={() => setConfirmExit(false)}
        />
      )}

      {/* The post just shared: see it, share it, or carry on. */}
      <PostedCelebration
        celebration={celebration}
        onClose={() => setCelebration(null)}
        onView={(c) => {
          setCelebration(null);
          router.push(c.scheduled ? '/scheduled' : `/post/${c.postId}`);
        }}
        onShare={(c) => {
          setCelebration(null);
          // After the card's exit, so the share sheet is not presented over a closing modal.
          setTimeout(() => openShareGlobal({
            postId: c.postId, caption: c.caption, username: profile?.username ?? null,
            cover: c.thumb, type: c.type, mediaUrl: c.mediaUrl,
          }), 260);
        }}
      />

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
        // Uploading lingers longer than a completion notice: it's the handoff to
        // the card now sitting at the top of the feed, so it has to survive the
        // swipe over to Home to be worth anything.
        duration={postedToast?.uploading ? 5200 : postedToast?.spotlight ? 3800 : 2800}
        bottomOffset={SPACING.xxl + SPACING.md}
        // Tap the confirmation to jump to the Home feed (scrolled to the top) and
        // watch the just-posted video, which is pinned there.
        onPress={() => {
          const scheduled = postedToast?.scheduled;
          setPostedToast(null);
          if (scheduled) { router.push('/scheduled'); return; }
          scrollHomeTop();
          navigation.navigate('index');
        }}
        onHide={() => setPostedToast(null)}
      />
    </View>
  );
}

// One iOS-style settings row on the details step: the label, an ⓘ that explains
// it, and its switch.
function SettingSwitch({ label, value, onChange, onInfo, infoLabel, last, styles, colors }: {
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  onInfo: () => void;
  infoLabel: string;
  last?: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemePalette;
}) {
  // iOS's own off-track grey: the app's surfaceLight would vanish into the card.
  const offTrack = isDarkPalette(colors) ? '#39393D' : '#E3E3E8';
  return (
    <View style={[styles.settingRow, !last && styles.settingRowDivider]}>
      <Text style={styles.settingLabel}>{label}</Text>
      <TouchableOpacity onPress={onInfo} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${infoLabel}: ${label}`}>
        <Ionicons name="information-circle-outline" size={20} color={colors.textTertiary} />
      </TouchableOpacity>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.text, false: offTrack }}
        ios_backgroundColor={offTrack}
        thumbColor={value ? colors.background : '#fff'}
        accessibilityLabel={label}
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
  // The details step's header: both sides one width, so the title stays centred
  // however wide the Share / Schedule pill is.
  headerSideWide: { width: 124, alignItems: 'flex-end' },
  headerSideStart: { width: 124, alignItems: 'flex-start' },
  // Black on light, white on dark, now or scheduled — the same as the bottom Share
  // button, so the post's two send buttons are one colour (owner, 2026-09-11).
  sharePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 124,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.full,
    backgroundColor: colors.text,
  },
  sharePillBusy: { opacity: 0.8 },
  sharePillText: { flexShrink: 1, color: colors.background, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  // Byte-level upload progress under the header while a big file streams up.
  uploadBarTrack: { height: 3, backgroundColor: colors.surfaceLight, overflow: 'hidden' },
  uploadBarFill: { height: 3, backgroundColor: '#ffffff' },

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
  // The hint yields space to the Files button and hugs it from the left, so on
  // narrow phones it truncates rather than pushing the button off-screen.
  recentsHintFlex: { flex: 1, textAlign: 'right', marginLeft: SPACING.sm },

  // Remove-media "x" on the preview square, and the Single/Slideshow mode toggle.
  removeBtn: {
    position: 'absolute', top: SPACING.sm, right: SPACING.sm,
    width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  // The mode dropdown button — replaces the old Single/Slideshow pill pair.
  modeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: SPACING.md, paddingVertical: 6,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight,
  },
  modeBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  modeMenu: {
    position: 'absolute', minWidth: 190,
    backgroundColor: colors.surface, borderRadius: RADIUS.lg,
    paddingVertical: 4, ...SHADOWS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  modeMenuItem: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: 11,
  },
  modeMenuLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  modeMenuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: SPACING.sm },
  // Over the in-app camera while a recording is probed; also blocks a second take.
  cameraBusy: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },

  // Bottom Posts | Music strip — two equal halves, centered labels, same (dark)
  // background; the active label is orange and bolder.
  typeStrip: {
    flexDirection: 'row', alignItems: 'stretch',
    borderTopWidth: 0.5, borderTopColor: colors.border,
  },
  typeStripBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md },
  typeStripText: { color: colors.textTertiary, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  // Neutral, not brand: this is a MODE SWITCH between Posts and Music, not an
  // action. colors.text is white on dark and near-black on light.
  typeStripTextActive: { color: colors.text, fontWeight: '900', fontSize: 14 },

  audioPickArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  audioPickBtn: {
    alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl,
    borderWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed', borderRadius: RADIUS.lg,
    width: '100%',
  },
  // The filename is the headline of this screen — it is what the user is about
  // to post — so it is sized like one, and the line under it recedes to say so.
  audioPickTitle: {
    color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5,
    textAlign: 'center', marginTop: SPACING.lg,
  },
  audioPickSub: { color: colors.textTertiary, fontSize: 13, textAlign: 'center', marginTop: 5 },
  // A footnote, at the floor. Absolute rather than in flow so it cannot push the
  // track off centre, and one line so it never grows into a paragraph.
  // Flush to the parent's padding edge rather than inset again: 55 characters of
  // English (and more in German and Russian) need every point of width to hold
  // one line, and adjustsFontSizeToFit should be the fallback, not the plan.
  audioPickHint: {
    position: 'absolute', left: 0, right: 0, bottom: SPACING.sm,
    paddingHorizontal: SPACING.xs,
    color: colors.textTertiary, fontSize: 12, textAlign: 'center',
  },

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
  // Recessed against Upload's raised surfaceElevated — the two halves separate by
  // tone now that neither carries the brand.
  diagRecord: { backgroundColor: colors.surface },
  // White on a dark page, the theme's raised off-white on a light one — see the
  // note at the JSX. isDarkPalette rather than a mode string, because a styles
  // factory is handed the colours and never the mode name.
  diagUpload: {
    backgroundColor: isDarkPalette(colors) ? '#FFFFFF' : colors.surfaceElevated,
    borderTopWidth: 2, borderTopColor: colors.background,
  },
  diagContent: { alignItems: 'center', gap: SPACING.sm, transform: [{ rotate: '7deg' }] },
  // Prominent circular icon badge behind each glyph.
  diagIconWrap: { width: 82, height: 82, borderRadius: 41, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  // Was rgba(255,255,255,0.22) — a white wash that only read on the orange
  // ground this half used to have. surfaceLight is the theme's own next step up,
  // so the badge stays visible on both themes.
  diagIconWrapRecord: { backgroundColor: colors.surfaceLight },
  // The orange wash goes with the orange glyph — this was the last accent left
  // on the screen. A neutral ink badge on the white slab; the theme's own next
  // step up on the light one.
  diagIconWrapUpload: {
    backgroundColor: isDarkPalette(colors) ? 'rgba(16,16,16,0.07)' : colors.surfaceLight,
    borderWidth: 1.5,
    borderColor: isDarkPalette(colors) ? 'rgba(16,16,16,0.16)' : colors.border,
  },
  diagTitle: { color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
  diagSub: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '600' },

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

  audioSelected: { alignItems: 'center', paddingHorizontal: SPACING.xl, width: '100%' },
  // 92pt of solid ink with a shadow under it. The old 72pt glyph sat flat on the
  // page at the same visual weight as the words beneath it, which is not what a
  // "press this" looks like.
  audioPlayBtn: {
    width: 92, height: 92, borderRadius: 46,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.text,
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  audioPlayGlyph: { marginLeft: 5 },
  // Equal halves of one row, capped so they do not sprawl on a tablet. The pair
  // reading as a single control is most of what makes it look finished.
  audioSelBtns: {
    flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xl,
    width: '100%', maxWidth: 360,
  },
  audioSelBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 13, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceLight,
    // The border is what gives these an edge. On the light theme a pale fill on
    // a pale page has none, which is why they read as absent rather than quiet.
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong,
  },
  audioSelBtnText: { color: colors.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },

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
  // "Edit cover" chip (video posts) — top of the preview square, mirroring the
  // tag chip at the bottom; the whole square opens the cover picker.
  coverOverlay: {
    position: 'absolute', left: SPACING.xs, top: SPACING.xs,
    maxWidth: DETAILS_PREVIEW - SPACING.sm,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: SPACING.sm,
  },
  rightCol: { flex: 1, gap: SPACING.sm },
  field: { gap: 6 },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8 },
  // Music-video switch. Same shape as the ad-manager switch rows so the two
  // composers read as one app.
  switchRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    padding: SPACING.md,
  },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  switchSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, letterSpacing: -0.1, marginTop: 2 },
  // Switched on, the card grows a picker underneath: square off its bottom
  // corners so the two halves read as one control rather than two stacked ones.
  switchRowOpen: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottomWidth: 0 },
  mvPick: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderTopWidth: 0,
    borderBottomLeftRadius: 14, borderBottomRightRadius: 14,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 4,
  },
  // Locked MUSIC dropdown while music-video mode owns the song. Dimmed rather
  // than hidden so the control explains itself instead of disappearing.
  dropdownLocked: { opacity: 0.55 },
  dropdown: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minHeight: 48,
    backgroundColor: colors.surfaceLight,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    borderRadius: 12, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
  },
  dropdownText: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '500', letterSpacing: -0.3 },
  dropdownPlaceholder: { color: colors.textTertiary, fontWeight: '400' },
  genreLockHint: { color: colors.textTertiary, fontSize: 11, marginTop: 3 },

  // Full-width caption box.
  captionBox: {
    backgroundColor: colors.surfaceLight,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    borderRadius: 12, padding: SPACING.md, minHeight: 96,
    color: colors.text, fontSize: 16, lineHeight: 22, letterSpacing: -0.3, textAlignVertical: 'top',
  },
  // Music "Title" box: slim, single-line — nudges toward a real title, not a caption.
  titleBox: {
    backgroundColor: colors.surfaceLight,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    borderRadius: 12, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, minHeight: 48,
    color: colors.text, fontSize: 16, letterSpacing: -0.3, marginTop: 6,
  },

  // Who sees it and when it goes up — two iOS-style menu buttons side by side.
  tileRow: { flexDirection: 'row', gap: SPACING.sm },
  tileWrap: { flex: 1 },
  // Filled with its symbol's colour, rounded, with a soft shadow of the same colour.
  // flexGrow keeps both buttons one height when a line under one of them wraps.
  tile: {
    flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 64,
    borderRadius: 24, paddingVertical: 11, paddingLeft: 14, paddingRight: 14,
    shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 10,
  },
  tileLocked: { opacity: 0.75 },
  // The symbol on its own, in a fixed column so both buttons' titles line up.
  tileIcon: { width: 24, alignItems: 'center', justifyContent: 'center' },
  tileText: { flex: 1, minWidth: 0 },
  tileTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tileTitle: { flexShrink: 1, color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: -0.3 },
  tileSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '500', lineHeight: 15, marginTop: 1, letterSpacing: -0.1 },
  // Advanced settings: a header folding away the switches most posts never change —
  // quieter than a field label, but plainly there.
  advanced: { gap: SPACING.sm },
  advancedHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 6 },
  advancedTitle: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', letterSpacing: -0.2 },
  advancedDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  // An iOS inset-grouped card of switch rows.
  settingsCard: {
    backgroundColor: colors.surfaceLight, borderRadius: 14, paddingLeft: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingRight: 12, paddingVertical: 8 },
  settingRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '500', letterSpacing: -0.2 },
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
  sectionLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8 },
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
  // ── Cover art, at the size of a record sleeve ───────────────────────────────
  // The stage is the positioning context for the corner button; the box is the
  // artwork itself, square and centred, capped so it does not become a poster on
  // a tablet.
  coverStage: { alignSelf: 'center', width: '100%', maxWidth: 260 },
  coverBox: {
    width: '100%', aspectRatio: 1, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
  },
  coverBoxImage: { width: '100%', height: '100%' },
  coverBoxEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: SPACING.md },
  coverBoxTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 2 },
  coverBoxSub: { color: colors.textTertiary, fontSize: 12, textAlign: 'center' },
  // Top-left, so it never collides with the features button in the other corner.
  coverChangeTag: {
    position: 'absolute', top: SPACING.sm, left: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: RADIUS.full,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  coverChangeTagText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  // Sits ON the artwork's bottom edge, overhanging it slightly so it reads as
  // attached to the sleeve rather than printed on it. maxWidth keeps a long list
  // of names from spanning the whole cover.
  coverCornerBtn: {
    position: 'absolute', right: -SPACING.xs, bottom: -SPACING.sm, maxWidth: '92%',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: SPACING.md, paddingVertical: 9,
    borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated,
    borderWidth: 1, borderColor: colors.borderStrong,
    shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  // Credited: the button fills in, because "who is on this" is answered rather
  // than pending, and a filled chip is how the rest of the app says so.
  coverCornerBtnOn: { backgroundColor: colors.text, borderColor: colors.text },
  coverCornerBtnText: { color: colors.text, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  coverCornerBtnTextOn: { color: colors.background },

  coverPreview: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  coverPlaceholder: { width: 72, height: 72, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  coverTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  coverSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  // ── Album picker sheet ──────────────────────────────────────────────────────
  // Full-width rows rather than the genre sheet's wrapping chips: album titles
  // are sentences, not one-word tags, and a chip row of them wraps into rubble.
  albumSheetList: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.sm },
  albumOption: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm,
    paddingHorizontal: SPACING.md, paddingVertical: 13,
    borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight,
  },
  albumOptionActive: { backgroundColor: colors.text },
  albumOptionText: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  albumOptionTextActive: { color: colors.background, fontWeight: '700' },
  albumNewRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  albumNewInput: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: 11,
    color: colors.text, fontSize: 15, backgroundColor: colors.surfaceLight,
  },
  albumNewBtn: {
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: SPACING.lg, borderRadius: RADIUS.md, backgroundColor: colors.text,
  },
  albumNewBtnOff: { opacity: 0.4 },
  albumNewBtnText: { color: colors.background, fontSize: 14, fontWeight: '700' },
  albumSheetHint: { color: colors.textTertiary, fontSize: 12.5, lineHeight: 17, marginTop: SPACING.xs },

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
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.md, marginTop: SPACING.xs,
  },
  draftSaveBtnDisabled: { opacity: 0.5 },
  draftSaveText: { color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  // The details step's primary action, above Save draft.
  shareCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: RADIUS.full, paddingVertical: SPACING.md, marginTop: SPACING.sm,
    backgroundColor: colors.text,
  },
  shareCtaText: { color: colors.background, fontSize: 16, fontWeight: '800', letterSpacing: -0.2, flexShrink: 1 },
  captionCount: { alignSelf: 'flex-end', color: colors.textTertiary, fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'], marginTop: 4 },

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
