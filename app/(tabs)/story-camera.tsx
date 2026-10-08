import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, Image, TextInput, Dimensions, Pressable, KeyboardAvoidingView,
  Platform, Keyboard, PanResponder, ScrollView, Animated, Easing, Modal,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AppVideo from '../../components/AppVideo';
import * as MediaLibrary from 'expo-media-library';
import { useIsFocused, useNavigation, useNavigationState } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import CaptureCamera, { type CaptureCameraHandle, type CapturedMedia } from '../../components/CaptureCamera';
import SongPickerModal, { type PickedSong } from '../../components/SongPickerModal';
import { SongPartStrip, SOUND_H_PAD } from '../../components/SoundControls';
import MentionSuggestions from '../../components/MentionSuggestions';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type Sticker, type CaptionStyle, type StickerBg, type StickerFont,
} from '../../components/StickerLayer';
import { StoryDrawCanvas, StoryDrawRenderer, type DrawStroke } from '../../components/StoryDrawLayer';
import { StoryBackground, StoryBackgroundPicker, DEFAULT_BG, type StoryBg } from '../../components/StoryBackgroundLayer';
import { getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { useStories } from '../../contexts/StoriesContext';
import { useStoryUpload } from '../../contexts/StoryUploadContext';
import { usePostMusicActions } from '../../contexts/PostMusicContext';
import { useAudioControls } from '../../contexts/AudioContext';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { showPermissionDenied } from '../../lib/permissions';
import { selection } from '../../lib/haptics';
import { supabase } from '../../lib/supabase';
import { clampStart, formatClock } from '../../lib/songMix';
import { STORY_MUSIC_MIN_SEC, STORY_MUSIC_MAX_SEC, STORY_MUSIC_DEFAULT_SEC } from '../../lib/stories';

const VIDEO_MAX_SEC = 60;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Clip-length choices for the story-music duration menu (5s … 25s).
const DURATION_OPTIONS = Array.from(
  { length: STORY_MUSIC_MAX_SEC - STORY_MUSIC_MIN_SEC + 1 },
  (_, i) => STORY_MUSIC_MIN_SEC + i,
);

// Text-size slider range (editor): top of the track = biggest type.
// Shorter + screen-relative so the slider's bottom always clears the keyboard-attached
// color/font toolbar (it used to run long and overlap those buttons).
const SLIDER_H = Math.round(Math.min(176, SCREEN_H * 0.21));
const SIZE_MIN = 14;
const SIZE_MAX = 56;

type Captured = CapturedMedia;

// The story camera, page 0 of the tab pager (LEFT of Home) so swiping right off Home
// reveals the camera as the background. The live viewfinder is components/CaptureCamera
// — the same one the post composer opens — and a swipe only ever pauses it, never
// unmounts it (mounting/unmounting on each swipe is what froze the app before). This
// screen adds the story editor for whatever it captures.
export default function StoryCameraScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const swiping = usePagerSwiping();
  const setTabSwipe = useTabSwipeControl();
  // Name of the currently-settled tab. While dragging from Home toward the camera
  // it's still 'index' (focus only flips on settle), so we can light up the live
  // camera DURING the drag — without activating it on unrelated tab swipes.
  const focusedTab = useNavigationState((s: any) => s?.routes?.[s.index]?.name);
  const cameraActive = isFocused || (swiping && focusedTab === 'index');
  // Arriving at the camera pauses the user's music — not politeness, accuracy:
  // a song playing out of the speaker records straight into the clip's audio,
  // and the clip you play back afterwards has to be heard on its own.
  // PAUSE, never stop — stop() would silence that playback (useAudioControls).
  const { pause: pauseMainSong } = useAudioControls();
  useEffect(() => { if (isFocused) pauseMainSong(); }, [isFocused, pauseMainSong]);
  const { refresh: refreshStories } = useStories();
  const { prewarmStory, enqueueStory, discardPrewarm } = useStoryUpload();

  const captureRef = useRef<CaptureCameraHandle>(null);

  const [stage, setStage] = useState<'capture' | 'preview'>('capture');
  // Pager-swipe locking:
  //  • preview/edit: OFF immediately (sticker drags fought the pager — froze).
  //  • live capture: ON for the first 5 seconds (so a quick peek can swipe
  //    straight back to Home), then LOCKED — once someone has dwelled on the
  //    camera they're here to shoot, and pinch/zoom/shutter gestures must
  //    never drag the page away mid-shot. The X button exits while locked.
  //  • leaving the page unlocks and resets the 5s clock for next time.
  useEffect(() => {
    if (!isFocused) { setTabSwipe(true); return; }
    if (stage === 'preview') {
      setTabSwipe(false);
      return () => setTabSwipe(true);
    }
    setTabSwipe(true);
    const t = setTimeout(() => setTabSwipe(false), 5000);
    return () => { clearTimeout(t); setTabSwipe(true); };
  }, [isFocused, stage]);

  // Track keyboard height so the bottom caption can sit above it (not covered).
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const h = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { s.remove(); h.remove(); };
  }, []);

  // ── Editor state ────────────────────────────────────────────────────────────
  const [captured, setCaptured] = useState<Captured | null>(null);
  // Prep in the background the instant media is captured: compress + thumbnail +
  // byte upload all start now, so tapping Post is just a row insert (instant).
  useEffect(() => {
    if (captured) prewarmStory(captured);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured?.uri]);
  const [caption, setCaption] = useState('');                       // plain bottom caption
  const [stickers, setStickers] = useState<Sticker[]>([]);           // draggable text/emoji stickers
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);          // pen doodle (draw tool)
  const [drawing, setDrawing] = useState(false);                     // draw-mode overlay open
  // Background behind the media — only shows where a shrunk/dragged photo leaves room
  // (default = the photo's own blur). Picked from the bg rail; saved as a 'bg' layer.
  const [bg, setBg] = useState<StoryBg>(DEFAULT_BG);
  const [bgPicking, setBgPicking] = useState(false);                 // bg picker rail open
  const [editingId, setEditingId] = useState<string | null>(null);  // sticker whose text is being edited
  const [editingText, setEditingText] = useState('');               // the editor's working text
  const [editingFont, setEditingFont] = useState<StickerFont>('classic');
  const [editingColor, setEditingColor] = useState('#FFFFFF');
  const [editingBg, setEditingBg] = useState<StickerBg>('none');
  // Last-used slider size: seeds new stickers + the editor (the editor owns the
  // LIVE value while open — see StickerTextEditor — and commits it back here).
  const [editingSize, setEditingSize] = useState(26);
  const [kbHeight, setKbHeight] = useState(0);                       // keyboard height (lifts the bottom caption)
  const stickerIdRef = useRef(0);
  const [song, setSong] = useState<PickedSong | null>(null);
  const [showSongPicker, setShowSongPicker] = useState(false);
  // Which part of the chosen song plays, and for how long. startSec is the offset
  // into the song; clipSec (5..25) is how long it plays AND how long the image
  // stays up in the viewer. songDragStart follows the finger while scrubbing.
  const [songStartSec, setSongStartSec] = useState(0);
  const [songClipSec, setSongClipSec] = useState(STORY_MUSIC_DEFAULT_SEC);
  const [songDragStart, setSongDragStart] = useState<number | null>(null);
  // The song's audio URL + length — PickedSong carries neither, so (like the video
  // studio) resolve them by id. Length scales the trim strip; url pre-feeds preview.
  const [songInfo, setSongInfo] = useState<{ id: string; url: string | null; durationSec: number } | null>(null);
  // Done trimming → the editing card collapses and the song name shows as a top
  // pill; the clip keeps looping as a preview until the story is posted.
  const [songDone, setSongDone] = useState(false);
  const [showDurationPicker, setShowDurationPicker] = useState(false);  // scroll menu for clip length
  // In-editor song preview (host id keys this screen's playback in the shared
  // post-music player, which fetches the track by song id on demand).
  const { playSong, stop: stopSong } = usePostMusicActions();
  // Resolve the chosen song's audio URL + length by id (PickedSong has neither).
  useEffect(() => {
    const sid = song?.id;
    if (!sid || songInfo?.id === sid) return;
    let cancelled = false;
    supabase.from('posts').select('media_url, duration_seconds').eq('id', sid).single()
      .then(({ data }) => {
        if (cancelled) return;
        const d: any = data;
        setSongInfo({ id: sid, url: d?.media_url ?? null, durationSec: Number(d?.duration_seconds) || 0 });
      }, () => { if (!cancelled) setSongInfo({ id: sid, url: null, durationSec: 0 }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);
  const songSec = song && songInfo?.id === song.id ? (songInfo?.durationSec ?? 0) : 0;
  const songUrl = song && songInfo?.id === song.id ? (songInfo?.url ?? null) : null;
  const clipSec = Math.min(STORY_MUSIC_MAX_SEC, Math.max(STORY_MUSIC_MIN_SEC, songClipSec));
  const songStart = clampStart(songStartSec, songSec, clipSec);
  // Auto-preview: the moment a song is chosen it plays, looping its chosen part, and
  // keeps looping (through editing AND after Done) until the story is posted or the
  // song is removed/changed. Re-applying on start/length changes moves the clip in
  // place (same host → the player swaps the mix without restarting). Paused while the
  // song picker is open — its own list plays previews on another host there.
  useEffect(() => {
    if (song && stage === 'preview' && !showSongPicker) {
      playSong('story-editor', song.id, songUrl, { startSec: songStart, volume: 1, videoStartSec: 0, clipSec });
    } else {
      stopSong('story-editor');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id, songStart, clipSec, songUrl, stage, showSongPicker]);
  const [showCaption, setShowCaption] = useState(false);            // caption input (opened from the rail)
  const [dragActive, setDragActive] = useState(false);              // a sticker is mid-drag → show trash
  const [overTrash, setOverTrash] = useState(false);
  const [saved, setSaved] = useState(false);                         // media saved to device

  // ── Photo drag/pinch crop ────────────────────────────────────────────────────
  // Library photos rarely match the frame. Rather than a silent centre crop, the
  // photo is DIRECTLY draggable/pinchable (no button): StickerLayer forwards any
  // gesture that isn't on a sticker to onPhotoGesture below. Zooming out below the
  // frame reveals a soft blurred backdrop of the same photo. The framing is stored
  // as a 'frame' layer and recomposed by the viewer — nothing is baked.
  // RN Animated (NOT reanimated), to match StickerLayer's own stickers — they drive
  // smoothly off this exact JS gesture path, so the photo will too. `cropAnim` is the
  // live transform; `cropSaved` is the committed baseline the next gesture adds to.
  const cropAnim = useRef({ pan: new Animated.ValueXY({ x: 0, y: 0 }), scale: new Animated.Value(1), rot: new Animated.Value(0) }).current;
  const cropSaved = useRef({ tx: 0, ty: 0, scale: 1, rotation: 0 });
  // Center-alignment guides for the PHOTO drag (same aid as StickerLayer's). When the
  // photo's centre nears the frame's it snaps there, a faint line shows, and a subtle
  // tick fires once on entry. `photoSnapPrev` latches so the tick fires per entry;
  // `.flat` latches the rotate-to-flat (nearest 90°) snap tick.
  const [photoGuide, setPhotoGuide] = useState({ v: false, h: false });
  const photoSnapPrev = useRef({ x: false, y: false, flat: false });
  const resetCrop = useCallback(() => {
    cropAnim.pan.setValue({ x: 0, y: 0 });
    cropAnim.scale.setValue(1);
    cropAnim.rot.setValue(0);
    cropSaved.current = { tx: 0, ty: 0, scale: 1, rotation: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The photo can be framed when it's an image whose pixel size we know.
  const imgW = captured?.width ?? 0;
  const imgH = captured?.height ?? 0;
  const canAdjust = captured?.type === 'image' && imgW > 0 && imgH > 0;
  // Size that exactly covers the frame at scale 1 (aspect preserved). scale > 1 zooms
  // in; scale < 1 shrinks the photo smaller than the frame (onto the backdrop).
  const coverScale = canAdjust ? Math.max(SCREEN_W / imgW, SCREEN_H / imgH) : 1;
  const baseW = imgW * coverScale;
  const baseH = imgH * coverScale;

  // StickerLayer forwards non-sticker drag/pinch here. Deltas are from the gesture
  // start → add to the saved baseline + clamp. MIN is low so the photo can shrink
  // well onto the backdrop; MAX is generous so it can be blown up well past the frame.
  const MIN_IMG_SCALE = 0.2;
  const MAX_IMG_SCALE = 8;
  const PHOTO_SNAP_PX = 9; // within this of the frame centre the photo snaps + shows a guide
  const PHOTO_ROT_SNAP = 7; // within this of a 90° multiple, the photo snaps FLAT
  const onPhotoGesture = useCallback((e: { phase: 'move' | 'end'; dx: number; dy: number; scale: number; rotation: number }) => {
    const s = Math.min(Math.max(cropSaved.current.scale * e.scale, MIN_IMG_SCALE), MAX_IMG_SCALE);
    // Let the photo be dragged ALL THE WAY off-screen (its centre can travel until its
    // trailing edge reaches the far frame edge → nothing of it on screen but the
    // blurred backdrop). The gesture lives on the whole frame, so an off-screen photo
    // is still grabbable to drag back.
    const mx = (baseW * s) / 2 + SCREEN_W / 2;
    const my = (baseH * s) / 2 + SCREEN_H / 2;
    let tx = Math.min(Math.max(cropSaved.current.tx + e.dx, -mx), mx);
    let ty = Math.min(Math.max(cropSaved.current.ty + e.dy, -my), my);
    // Rotate the photo (two-finger), with a FLAT snap to the nearest 90° — same aid
    // as text stickers so a slightly-off photo clicks straight.
    let rot = cropSaved.current.rotation + e.rotation;
    const rotTarget = Math.round(rot / 90) * 90;
    const nearFlat = Math.abs(rot - rotTarget) <= PHOTO_ROT_SNAP;
    if (nearFlat) rot = rotTarget;
    // Magnetic centre (same aid as stickers): pin to the frame centre when near,
    // show the guide line, tick once on entry (one tick even if several lock at once).
    const nearX = Math.abs(tx) <= PHOTO_SNAP_PX;
    const nearY = Math.abs(ty) <= PHOTO_SNAP_PX;
    if (nearX) tx = 0;
    if (nearY) ty = 0;
    const entered = (nearX && !photoSnapPrev.current.x) || (nearY && !photoSnapPrev.current.y) || (nearFlat && !photoSnapPrev.current.flat);
    if (entered) selection();
    if (photoSnapPrev.current.x !== nearX || photoSnapPrev.current.y !== nearY) setPhotoGuide({ v: nearX, h: nearY });
    photoSnapPrev.current = { x: nearX, y: nearY, flat: nearFlat };
    cropAnim.pan.setValue({ x: tx, y: ty });
    cropAnim.scale.setValue(s);
    cropAnim.rot.setValue(rot);
    if (e.phase === 'end') {
      cropSaved.current = { tx, ty, scale: s, rotation: rot };
      photoSnapPrev.current = { x: false, y: false, flat: false };
      setPhotoGuide({ v: false, h: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseW, baseH]);

  // ── Text / emoji stickers ───────────────────────────────────────────────────
  function addStickerAt(xNorm: number, yNorm: number) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, {
      id, text: '', x: xNorm, y: yNorm, scale: 1, rotation: 0,
      font: editingFont, color: editingColor, bg: editingBg, size: editingSize,
    }]);
    setEditingId(id);
    setEditingText('');
  }
  function editSticker(id: string) {
    const s = stickers.find((x) => x.id === id);
    if (s?.emoji) return; // emoji stickers are placed/scaled, not text-edited
    setEditingId(id);
    setEditingText(s?.text ?? '');
    setEditingFont(s?.font ?? 'classic');
    setEditingColor(s?.color ?? '#FFFFFF');
    setEditingBg(s?.bg ?? 'none');
    setEditingSize(s?.size ?? 26);
  }
  function manipulateSticker(id: string, style: CaptionStyle) {
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...style } : s)));
  }
  // The editor overlay commits its working values here (Done / backdrop tap) —
  // same fields, same timing as the old top-level finishEditing. The style also
  // writes back into the editing* state so it seeds the NEXT sticker, exactly
  // like the old always-live top-level state did.
  const commitEditing = useCallback((vals: { text: string; font: StickerFont; color: string; bg: StickerBg; size: number }) => {
    setStickers((prev) =>
      prev
        .map((s) => (s.id === editingId
          ? { ...s, text: vals.text.trim(), font: vals.font, color: vals.color, bg: vals.bg, size: vals.size }
          : s))
        .filter((s) => s.text !== ''),
    );
    setEditingFont(vals.font);
    setEditingColor(vals.color);
    setEditingBg(vals.bg);
    setEditingSize(vals.size);
    setEditingId(null);
    setEditingText('');
  }, [editingId]);
  // Drop-on-trash deletion: the zone is the bottom-center circle shown mid-drag.
  function inTrashZone(xNorm: number, yNorm: number) {
    const x = xNorm * SCREEN_W, y = yNorm * SCREEN_H;
    return y > SCREEN_H - insets.bottom - 150 && Math.abs(x - SCREEN_W / 2) < 80;
  }
  function onStickerRelease(id: string, xNorm: number, yNorm: number) {
    setOverTrash(false);
    if (inTrashZone(xNorm, yNorm)) {
      setStickers((prev) => prev.filter((s) => s.id !== id));
    }
  }

  // Reset to a clean live viewfinder whenever we leave the page (so re-opening
  // never lands on a stale preview, and any recording is torn down).
  useFocusEffect(
    useCallback(() => {
      return () => {
        // The camera's own teardown: timers, any recording, the mic, zoom, torch, PHOTO.
        captureRef.current?.reset();
        // Abandoned capture (left without posting) → cancel its speculative
        // upload. No-op if the capture was already handed to a post.
        discardPrewarm();
        setStage('capture');
        setCaptured(null);
        setCaption(''); setStickers([]); setEditingId(null); setEditingText('');
        setStrokes([]); setDrawing(false); setBg(DEFAULT_BG); setBgPicking(false);
        stopSong('story-editor');
        setSong(null); resetSongTrim(); setShowCaption(false); setSaved(false);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function close() {
    navigation.navigate('index');
  }

  // Drop the song-trim choices (start/length/resolved info) back to defaults —
  // on removing the song, picking a different one, retaking, or leaving.
  function resetSongTrim() {
    setSongStartSec(0);
    setSongClipSec(STORY_MUSIC_DEFAULT_SEC);
    setSongDragStart(null);
    setSongInfo(null);
    setSongDone(false);
  }

  function setCapturedMedia(c: Captured) {
    setSaved(false);
    resetCrop();
    setCaptured(c);
    setStage('preview');
  }

  async function pickFromLibrary() {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 1,
      videoMaxDuration: VIDEO_MAX_SEC,
      // iOS: hand back the ORIGINAL file instead of exporting/transcoding at
      // pick time — the default 'automatic' mode re-encoded HEVC video (and
      // HEIC stills) before returning, which was seconds of dead wait on the
      // picker. Safe here: the story upload path re-encodes library images to
      // JPEG itself (StoryUploadContext.uploadCaptured), and videos ride the
      // existing compress-before-upload path. Together with quality:1 (and no
      // editing) this also takes the picker's native fast path, which copies
      // the bytes rather than re-encoding them.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setCapturedMedia({
      uri: a.uri,
      type: a.type === 'video' ? 'video' : 'image',
      durationSec: a.duration ? Math.round(a.duration / 1000) : undefined,
      // Natural pixels — drive the drag/pinch crop + the bake on post.
      width: a.width,
      height: a.height,
    });
  }

  function retake() {
    stopSong('story-editor');
    // Drop any in-flight prewarm (no-op once it's been claimed by a post) so an
    // abandoned capture's speculative upload is cancelled + its orphan cleaned up.
    discardPrewarm();
    setCaptured(null);
    setCaption(''); setStickers([]); setEditingId(null); setEditingText('');
    setStrokes([]); setDrawing(false); setBg(DEFAULT_BG); setBgPicking(false);
    setSong(null); resetSongTrim(); setShowCaption(false); setSaved(false);
    resetCrop();
    setStage('capture');
  }

  // Save the captured media to the device's photo library.
  async function saveToDevice() {
    if (!captured || saved) return;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        showPermissionDenied('photos', t);
        return;
      }
      await MediaLibrary.saveToLibraryAsync(captured.uri);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (e: any) {
      Alert.alert(t('storyCamera.saveFailTitle'), e?.message ?? t('storyCamera.saveFailBody'));
    }
  }

  function shareStory() {
    if (!captured) return;
    // The photo's framing (drag/pinch/zoom), stored as a 'frame' layer and recomposed
    // by the viewer over a blurred backdrop — so a zoomed-OUT photo keeps its backdrop.
    // x/y are fractions of the frame; scale is relative to a cover fit; w/h are the
    // source pixels (the viewer needs the aspect to recompute cover for its screen).
    const framed = canAdjust && (cropSaved.current.scale !== 1 || cropSaved.current.tx !== 0 || cropSaved.current.ty !== 0 || cropSaved.current.rotation !== 0);
    const frameLayer: any = framed
      ? { kind: 'frame', scale: cropSaved.current.scale, x: cropSaved.current.tx / SCREEN_W, y: cropSaved.current.ty / SCREEN_H, rotation: cropSaved.current.rotation, w: imgW, h: imgH }
      : null;
    // Pen doodle + chosen background, stored the SAME way reshared posts do (so the
    // viewer composes them identically). bg is omitted when it's the plain blur default.
    const drawLayer: any = strokes.length ? { kind: 'draw', strokes } : null;
    const bgLayer: any = bg.type !== 'blur' ? { kind: 'bg', background: bg } : null;
    const textStickers = stickers.map(({ text, x, y, scale, rotation, font, color, bg, size, emoji }) =>
      ({ text, x, y, scale, rotation, font, color, bg, size, emoji }));
    const allStickers: any[] = [
      ...textStickers,
      ...(frameLayer ? [frameLayer] : []),
      ...(drawLayer ? [drawLayer] : []),
      ...(bgLayer ? [bgLayer] : []),
    ];
    // Optimistic post: hand the (already-prewarming) upload + a snapshot of the edits
    // to the background provider, then return to Home immediately.
    enqueueStory({
      captured,
      caption: caption.trim() || null,
      aspectRatio: '9:16',
      durationSeconds: captured.type === 'video' ? captured.durationSec ?? null : null,
      song: song ? { id: song.id, title: song.title, artist: song.artist, artistId: song.artistId } : null,
      // Start offset + clip length are photo-story only (a video keeps its own length).
      songStartSec: song && captured.type === 'image' ? songStart : null,
      songClipSec: song && captured.type === 'image' ? clipSec : null,
      stickers: allStickers.length ? allStickers : null,
    });
    retake();
    navigation.navigate('index');
  }

  // ─── Preview / edit ────────────────────────────────────────────────────────
  let preview: ReactNode = null;
  if (stage === 'preview' && captured) {
    preview = (
      <View style={styles.container}>
        {captured.type === 'image' ? (
          canAdjust ? (
            // Drag/pinch to reframe the photo directly. A soft blurred copy fills the
            // screen behind it, so zooming OUT reveals a backdrop that resembles the photo.
            <View style={StyleSheet.absoluteFill}>
              {bg.type === 'blur' ? (
                <ExpoImage source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" />
              ) : (
                <StoryBackground bg={bg} backdropUri={captured.uri} />
              )}
              <Animated.Image
                source={{ uri: captured.uri }}
                resizeMode="cover"
                style={{
                  position: 'absolute', width: baseW, height: baseH,
                  left: (SCREEN_W - baseW) / 2, top: (SCREEN_H - baseH) / 2,
                  transform: [
                    { translateX: cropAnim.pan.x },
                    { translateY: cropAnim.pan.y },
                    { scale: cropAnim.scale },
                    { rotate: cropAnim.rot.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
                  ],
                }}
              />
            </View>
          ) : (
            <Image source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          )
        ) : (
          <AppVideo
            source={{ uri: captured.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            active
            loop
            // Your own clip, played back to decide whether to keep it: it keeps
            // its sound. Reaching the camera has already stopped the music.
            ownsAudio
            muted={false}
          />
        )}

        {/* Photo center guides — faint lines while the photo is dragged near centre. */}
        {(photoGuide.v || photoGuide.h) && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {photoGuide.v && <View style={[styles.guideLineV, { left: SCREEN_W / 2 - 0.5 }]} />}
            {photoGuide.h && <View style={[styles.guideLineH, { top: SCREEN_H / 2 - 0.5 }]} />}
          </View>
        )}

        {/* Text/emoji stickers + the photo gesture. StickerLayer routes to the
            sticker nearest the touch (tap to edit, drag/pinch to move/resize); any
            gesture NOT on a sticker repositions/zooms the photo via onPhotoGesture.
            A tap on open media still adds a sticker. */}
        <StickerLayer
          stickers={stickers}
          frameW={SCREEN_W}
          frameH={SCREEN_H}
          editingId={editingId}
          onManipulate={manipulateSticker}
          onTapSticker={editSticker}
          onTapEmpty={(x, y) => {
            // If the caption keyboard is up, the first tap just dismisses it
            // (don't spawn a sticker); tap again on open media to add one.
            if (kbHeight > 0) { Keyboard.dismiss(); return; }
            addStickerAt(x, y);
          }}
          onDragActive={(a) => { setDragActive(a); if (!a) setOverTrash(false); }}
          onDragMove={(x, y) => {
            const over = inTrashZone(x, y);
            setOverTrash((prev) => (prev === over ? prev : over));
          }}
          onRelease={onStickerRelease}
          onPhotoGesture={canAdjust ? onPhotoGesture : undefined}
        />

        {/* Committed doodle — over the media AND the text (matches the viewer's order).
            pointerEvents:none, so text stickers under it stay tappable. Hidden while
            the draw canvas is open, which renders its own live copy. */}
        {!drawing && strokes.length > 0 && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <StoryDrawRenderer strokes={strokes} frameW={SCREEN_W} frameH={SCREEN_H} />
          </View>
        )}

        {/* Drop-to-delete target (only while a sticker is being dragged) */}
        {dragActive && (
          <View style={[styles.trashZone, { bottom: insets.bottom + 56 }]} pointerEvents="none">
            <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
              <Ionicons name="trash-outline" size={overTrash ? 30 : 24} color="#fff" />
            </View>
          </View>
        )}

        {!drawing && (
          <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={retake} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
            <Ionicons name="arrow-back" size={26} color="#fff" />
          </TouchableOpacity>
        )}

        {/* Top music entry (white pill). "Add music" when none is set; while a song
            is being trimmed the bottom card takes over and this hides; after Done the
            card collapses and the song NAME shows here — tap it to edit again. */}
        {!dragActive && !drawing && !editingId && (song ? songDone : true) && (
          <View style={[styles.addMusicWrap, { top: insets.top + 8 }]} pointerEvents="box-none">
            <TouchableOpacity
              style={styles.addMusicBtn}
              onPress={() => (song ? setSongDone(false) : setShowSongPicker(true))}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={song ? song.title : t('post.addMusic')}
            >
              <Ionicons name="musical-notes" size={16} color="#111" />
              <Text style={styles.addMusicText} numberOfLines={1}>{song ? song.title : t('post.addMusic')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Edit tool rail — text, draw, background, caption, save */}
        {!dragActive && !drawing && (
          <View style={[styles.toolRail, { top: insets.top + 8 }]}>
            <TouchableOpacity style={styles.roundBtn} onPress={() => addStickerAt(0.5, 0.4)}>
              <Text style={styles.aaBtnText}>Aa</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.roundBtn} onPress={() => setDrawing(true)}>
              <Ionicons name={strokes.length ? 'brush' : 'brush-outline'} size={22} color={strokes.length ? colors.primaryLight : '#fff'} />
            </TouchableOpacity>
            {canAdjust && (
              <TouchableOpacity style={styles.roundBtn} onPress={() => setBgPicking((p) => !p)}>
                <Ionicons name={bg.type !== 'blur' ? 'color-palette' : 'color-palette-outline'} size={22} color={bg.type !== 'blur' ? colors.primaryLight : '#fff'} />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.roundBtn} onPress={() => setShowCaption(true)}>
              <Ionicons
                name={caption.trim() ? 'chatbox-ellipses' : 'chatbox-ellipses-outline'}
                size={23}
                color={caption.trim() ? colors.primaryLight : '#fff'}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.roundBtn} onPress={saveToDevice}>
              <Ionicons name={saved ? 'checkmark' : 'download-outline'} size={24} color={saved ? colors.success : '#fff'} />
            </TouchableOpacity>
          </View>
        )}

        {/* Hidden while the text-sticker editor is open: this bar is pinned to the
            keyboard (bottom: kbHeight), so otherwise it rides up and collides with
            that editor's color/font toolbar — and "Add to story" has no use mid-edit. */}
        {!dragActive && !editingId && !drawing && !bgPicking && (
        <View style={[styles.previewBottom, { bottom: kbHeight, paddingBottom: kbHeight > 0 ? SPACING.md : insets.bottom + SPACING.md }]}>
          {/* The music editing card — only while trimming (before Done). After Done
              it collapses to the top song pill; the clip keeps looping underneath. */}
          {song && !songDone && (
            <View style={styles.songCard}>
              <View style={styles.songCardRow}>
                {song.cover ? (
                  <Image source={{ uri: song.cover }} style={styles.songCardCover} />
                ) : (
                  <View style={[styles.songCardCover, styles.songCardCoverEmpty]}>
                    <Ionicons name="musical-notes" size={18} color="#fff" />
                  </View>
                )}
                <View style={styles.songCardInfo}>
                  <Text style={styles.songCardTitle} numberOfLines={1}>{song.title}</Text>
                  <Text style={styles.songCardArtist} numberOfLines={1}>{song.artist}</Text>
                </View>
                {/* Done — collapse to the top pill; the clip keeps looping. */}
                <TouchableOpacity style={styles.songDoneBtn} onPress={() => setSongDone(true)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('common.done')} hitSlop={6}>
                  <Ionicons name="checkmark" size={20} color="#111" />
                </TouchableOpacity>
                {/* Remove the music entirely. */}
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')}
                  style={styles.songCardBtn}
                  onPress={() => { stopSong('story-editor'); setSong(null); resetSongTrim(); }}
                  hitSlop={6}
                >
                  <Ionicons name="close" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
              {/* Trim (photos only): drag the window for WHERE the song starts. The
                  length is picked from the scroll menu below and also sets how long
                  the photo stays up. The clip auto-previews on a loop as you edit. */}
              {captured?.type === 'image' && (
                <>
                  <View style={styles.songDivider} />
                  <Text style={[styles.songTrimStart, styles.songTrimPad]}>{t('sound.startsAt', { time: formatClock(songDragStart ?? songStart) })}</Text>
                  {songSec > 0 ? (
                    <SongPartStrip
                      seed={song.id}
                      songSec={songSec}
                      windowSec={clipSec}
                      startSec={songStart}
                      onDrag={setSongDragStart}
                      onCommit={(sec) => setSongStartSec(clampStart(sec, songSec, clipSec))}
                    />
                  ) : (
                    <Text style={[styles.songTrimHint, styles.songTrimPad]}>{t('storyCamera.musicPreparing')}</Text>
                  )}
                </>
              )}
              {/* Controls: pick the clip LENGTH (scroll menu) and change the song.
                  Done (✓) and remove (✕) sit together in the row above. */}
              <View style={styles.songControlsRow}>
                {captured?.type === 'image' && (
                  <TouchableOpacity style={styles.songChip} onPress={() => setShowDurationPicker(true)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('storyCamera.clipLength')}>
                    <Ionicons name="timer-outline" size={15} color="#fff" />
                    <Text style={styles.songChipText}>{t('storyCamera.clipSeconds', { n: clipSec })}</Text>
                    <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.8)" />
                  </TouchableOpacity>
                )}
                <View style={{ flex: 1 }} />
                <TouchableOpacity style={styles.songChip} onPress={() => setShowSongPicker(true)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('storyCamera.changeSong')}>
                  <Ionicons name="musical-notes" size={15} color="#fff" />
                  <Text style={styles.songChipText}>{t('storyCamera.changeSong')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {showCaption ? (
            <>
              <MentionSuggestions
                query={getActiveMentionQuery(caption, caption.length)}
                onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
                style={{ marginBottom: SPACING.xs }}
                maxHeight={150}
              />
              <TextInput
                style={styles.captionInput}
                placeholder={t('storyCamera.captionPlaceholder')}
                placeholderTextColor="rgba(255,255,255,0.7)"
                value={caption}
                onChangeText={setCaption}
                onBlur={() => setShowCaption(false)}
                autoFocus
                maxLength={200}
              />
            </>
          ) : caption.trim() ? (
            <TouchableOpacity style={styles.captionPreview} onPress={() => setShowCaption(true)}>
              <Text style={styles.captionPreviewText} numberOfLines={2}>{caption}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.shareBtn} onPress={shareStory}>
            <Text style={styles.shareBtnText}>{t('storyCamera.addToStory')}</Text>
            <Ionicons name="arrow-forward-circle" size={22} color="#000" />
          </TouchableOpacity>
        </View>
        )}

        {/* Full-screen text editor — live-styled preview + font/color toolbar.
            Extracted + memoized (module scope, below) so the size slider's
            per-move setState re-renders ONLY the overlay, not the whole camera
            screen. Keyed by sticker id: each editing session mounts fresh from
            the seed values. */}
        {editingId && (
          <StickerTextEditor
            key={editingId}
            initialText={editingText}
            initialFont={editingFont}
            initialColor={editingColor}
            initialBg={editingBg}
            initialSize={editingSize}
            onCommit={commitEditing}
          />
        )}

        <SongPickerModal
          visible={showSongPicker}
          onClose={() => setShowSongPicker(false)}
          onSelect={(s) => { stopSong('story-editor'); resetSongTrim(); setSong(s); }}
        />

        {/* Clip-length scroll menu — a bottom sheet of 5–25s; tap to choose. */}
        <Modal visible={showDurationPicker} transparent animationType="slide" onRequestClose={() => setShowDurationPicker(false)}>
          <TouchableOpacity style={styles.durationOverlay} activeOpacity={1} onPress={() => setShowDurationPicker(false)}>
            <TouchableOpacity style={[styles.durationSheet, { paddingBottom: insets.bottom + SPACING.md }]} activeOpacity={1}>
              <View style={styles.durationHandle} />
              <Text style={styles.durationTitle}>{t('storyCamera.clipLength')}</Text>
              <ScrollView style={styles.durationList} contentContainerStyle={{ paddingVertical: SPACING.xs }} showsVerticalScrollIndicator={false}>
                {DURATION_OPTIONS.map((n) => {
                  const sel = n === clipSec;
                  return (
                    <TouchableOpacity
                      key={n}
                      style={[styles.durationRow, sel && styles.durationRowSel]}
                      onPress={() => { setSongClipSec(n); selection(); setShowDurationPicker(false); }}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.durationRowText, sel && styles.durationRowTextSel]}>{t('storyCamera.clipSeconds', { n })}</Text>
                      {sel && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>

        {/* Background picker rail — solid / gradient / blurred backdrop behind the
            media (shows where a shrunk photo leaves room); live preview as you tap. */}
        {bgPicking && (
          <View style={[styles.bgPickerWrap, { paddingBottom: insets.bottom + SPACING.sm }]} pointerEvents="box-none">
            <View style={styles.bgPickerHeader}>
              <Text style={styles.bgPickerTitle}>{t('storyCamera.background')}</Text>
              <TouchableOpacity style={styles.bgDoneBtn} onPress={() => setBgPicking(false)} hitSlop={8}>
                <Text style={styles.bgDoneText}>{t('storyCamera.done')}</Text>
              </TouchableOpacity>
            </View>
            <StoryBackgroundPicker value={bg} onChange={setBg} backdropUri={captured.uri} />
          </View>
        )}

        {/* Draw mode — full-screen pen canvas with its own undo / colour / width / done. */}
        {drawing && (
          <StoryDrawCanvas
            strokes={strokes}
            onChange={setStrokes}
            onClose={() => setDrawing(false)}
            frameW={SCREEN_W}
            frameH={SCREEN_H}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
          />
        )}
      </View>
    );
  }

  // ─── Live capture ────────────────────────────────────────────────────────
  // components/CaptureCamera. Hidden (camera closed, settings kept) while the editor
  // above shows a capture.
  return (
    <>
      <CaptureCamera
        ref={captureRef}
        active={cameraActive}
        focused={isFocused}
        hidden={preview != null}
        maxVideoSec={VIDEO_MAX_SEC}
        onCapture={setCapturedMedia}
        onClose={close}
        onLibrary={pickFromLibrary}
        closeLabel={t('storyCamera.backToFeed')}
      />
      {preview}
    </>
  );
}

// ─── Sticker text editor overlay ─────────────────────────────────────────────
// Extracted from the (~1200-line) screen component and memoized: the size
// slider's PanResponder sets state on EVERY pan move (~30 discrete sizes per
// sweep), and as top-level screen state each move re-rendered the ENTIRE
// camera screen (viewfinder, rails, sticker layer) mid-gesture. The working
// values (text, font, color, bg, size, measured height) live HERE — nothing
// behind the overlay renders them live (StickerLayer hides the sticker being
// edited until commit) — and flow back to the screen in one commit, with the
// same fields and timing as the old finishEditing.
const StickerTextEditor = memo(function StickerTextEditor({
  initialText, initialFont, initialColor, initialBg, initialSize, onCommit,
}: {
  initialText: string;
  initialFont: StickerFont;
  initialColor: string;
  initialBg: StickerBg;
  initialSize: number;
  onCommit: (vals: { text: string; font: StickerFont; color: string; bg: StickerBg; size: number }) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const [text, setText] = useState(initialText);
  const [font, setFont] = useState<StickerFont>(initialFont);
  const [color, setColor] = useState(initialColor);
  const [bg, setBg] = useState<StickerBg>(initialBg);
  const [size, setSize] = useState(initialSize);   // slider-chosen font size
  const [textH, setTextH] = useState(0);           // measured input height (reliable growth)

  // Smooth entrance/exit: the dim fades, the input pops, and the toolbar rises in
  // WITH the keyboard instead of snapping. On close we play it in reverse, then commit.
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [appear]);

  // Vertical size slider (left edge of the text editor) — position → font size.
  const sizeSliderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setSize(sizeFromTrackY(e.nativeEvent.locationY)),
      onPanResponderMove: (e) => setSize(sizeFromTrackY(e.nativeEvent.locationY)),
    }),
  ).current;

  const preview = resolveSticker({ font, color, bg, size });
  const sliderKnobTop = ((SIZE_MAX - size) / (SIZE_MAX - SIZE_MIN)) * SLIDER_H - 13;
  const knobTop = Math.max(0, Math.min(SLIDER_H - 26, sliderKnobTop));
  const finish = () => {
    Keyboard.dismiss();
    Animated.timing(appear, { toValue: 0, duration: 190, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => onCommit({ text, font, color, bg, size }));
  };

  return (
    <KeyboardAvoidingView
      style={StyleSheet.absoluteFill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.stickerEditor, { opacity: appear }]} />
      <Pressable style={StyleSheet.absoluteFill} onPress={finish} />
      <Animated.View style={[styles.stickerDoneRow, { top: insets.top + 8, opacity: appear }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.stickerDoneBtn} onPress={finish} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.stickerDoneText}>{t('storyCamera.done')}</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Size slider — a wedge (wide at top, narrow at bottom) so the shape itself
          reads as the type size growing; a live bubble shows the value. Sits in the
          upper-left, clear of the color/font toolbar below. */}
      <Animated.View style={[styles.sizeSlider, { top: SCREEN_H * 0.19, opacity: appear }]} {...sizeSliderPan.panHandlers}>
        {/* The wedge is an over-tall downward triangle clipped by its wrap → a
            trapezoid (16px wide up top, ~6px at the bottom). Pure RN, no SVG. */}
        <View style={styles.sizeTrackWrap} pointerEvents="none">
          <View style={styles.sizeWedge} />
        </View>
        <View style={[styles.sizeKnob, { top: knobTop }]} pointerEvents="none" />
        <View style={[styles.sizeValue, { top: knobTop }]} pointerEvents="none">
          <Text style={styles.sizeValueText}>{Math.round(size)}</Text>
        </View>
      </Animated.View>
      <View style={styles.stickerInputWrap} pointerEvents="box-none">
        <Animated.View style={[preview.boxStyle, styles.editorBox, { opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}>
          {/* Deterministic layout: FIXED width (identical to the placed
              sticker's wrap width) and the height measured by an
              INVISIBLE mirror <Text> below — Text layout is exact, while
              a height-controlled iOS TextInput under-reports its own
              content (that's why wrapped lines were vanishing). The
              mirror is slightly NARROWER than the input to compensate
              for UITextView's internal caret padding, so it always wraps
              at-or-before the input does → never under-measures. */}
          <TextInput
            style={[styles.stickerInput, preview.textStyle, {
              height: (textH > 0
                ? textH
                : ((preview.textStyle.lineHeight as number) ?? 34)) + 8,
              maxHeight: SCREEN_H * 0.45, // can never push itself off-screen
            }]}
            value={text}
            onChangeText={setText}
            selectionColor="#FAB525"
            cursorColor="#FAB525"
            multiline
            scrollEnabled={false}
            autoFocus
            maxLength={200}
            textAlign="center"
          />
          <Text
            style={[styles.stickerInput, preview.textStyle, styles.measureGhost]}
            onLayout={(e) => {
              const h = Math.ceil(e.nativeEvent.layout.height);
              setTextH((prev) => (prev === h ? prev : h));
            }}
          >
            {text.length === 0 ? ' ' : text.endsWith('\n') ? `${text} ` : text}
          </Text>
        </Animated.View>
        <MentionSuggestions
          query={getActiveMentionQuery(text, text.length)}
          onPick={(u) => setText(applyMention(text, text.length, u).text)}
          style={{ marginTop: SPACING.md, alignSelf: 'center', minWidth: 240 }}
          maxHeight={160}
        />
      </View>

      {/* Style toolbar — colors, then background toggle + font pills. */}
      <Animated.View style={[styles.styleBar, { opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatchRow} keyboardShouldPersistTaps="always">
          {STICKER_COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]}
              onPress={() => setColor(c)}
            />
          ))}
        </ScrollView>
        <View style={styles.fontRow}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.colour')}
            style={[styles.bgToggle, bg !== 'none' && styles.bgToggleActive]}
            onPress={() => setBg((b) => (b === 'none' ? 'soft' : b === 'soft' ? 'pill' : b === 'pill' ? 'boxy' : 'none'))}
          >
            <Ionicons name="color-fill-outline" size={18} color="#fff" />
          </TouchableOpacity>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontPills} keyboardShouldPersistTaps="always">
            {STICKER_FONTS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.fontPill, font === f.key && styles.fontPillActive]}
                onPress={() => setFont(f.key)}
              >
                <Text style={[styles.fontPillText, resolveStickerFontPreview(f.key), font === f.key && styles.fontPillTextActive]}>{f.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
});

// Tiny preview style for the font pills in the editor toolbar.
function resolveStickerFontPreview(font: StickerFont) {
  switch (font) {
    case 'bold': return { fontWeight: '900' as const };
    case 'typewriter': return { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' };
    case 'serif': return { fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' };
    case 'neon': return { textShadowColor: '#fff', textShadowRadius: 8 };
    default: return { fontWeight: '700' as const };
  }
}

// Map a touch on the size-slider track to a font size (top = biggest).
function sizeFromTrackY(y: number) {
  const clamped = Math.max(0, Math.min(SLIDER_H, y));
  return Math.round(SIZE_MAX - (clamped / SLIDER_H) * (SIZE_MAX - SIZE_MIN));
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Absolute-fill (not flex:1) so it ignores the navigator's sceneContainerStyle
  // bottom padding and stays edge-to-edge — full-screen camera, no gray slot.
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },

  // ── Preview / editor ─────────────────────────────────────────────────────
  // Top-centred "Add music" pill (clears the back button at left and the tool rail
  // at right). box-none wrapper so only the pill itself is tappable.
  addMusicWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // White pill, black text — the top "Add music" entry, and the song-name pill once
  // Done. maxWidth so a long title truncates instead of colliding with back/rail.
  addMusicBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 9, maxWidth: SCREEN_W * 0.62,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  addMusicText: { color: '#111', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  toolRail: { position: 'absolute', right: SPACING.md, gap: SPACING.sm },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)',
  },
  trashCircleHot: { backgroundColor: colors.error, borderColor: '#fff', transform: [{ scale: 1.15 }] },

  // Background picker rail (bottom overlay) + its header.
  bgPickerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  bgPickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  bgPickerTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  bgDoneBtn: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, paddingHorizontal: SPACING.md, paddingVertical: 6 },
  bgDoneText: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Faint photo center-alignment guides (match StickerLayer's subtle lines).
  guideLineV: {
    position: 'absolute', top: 0, bottom: 0, width: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 1.5, shadowOffset: { width: 0, height: 0 },
  },
  guideLineH: {
    position: 'absolute', left: 0, right: 0, height: 1,
    backgroundColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 1.5, shadowOffset: { width: 0, height: 0 },
  },

  previewBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: SPACING.md, gap: SPACING.sm },
  captionInput: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md,
    color: '#fff', fontSize: 15, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
  },
  aaBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  stickerEditor: { backgroundColor: 'rgba(0,0,0,0.55)' },
  stickerDoneRow: { position: 'absolute', right: SPACING.md, flexDirection: 'row', justifyContent: 'flex-end', zIndex: 2 },
  stickerDoneBtn: {
    backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 7,
  },
  stickerDoneText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  // Text-size slider (left edge of the editor).
  sizeSlider: {
    position: 'absolute', left: 4, width: 44, height: SLIDER_H,
    alignItems: 'center', zIndex: 2,
  },
  // Tapered track: a clipping wrap holding an over-tall downward triangle, so the
  // visible shape is a wedge (wide top → narrow bottom), mirroring font size.
  sizeTrackWrap: { width: 18, height: '100%', overflow: 'hidden', alignItems: 'center' },
  sizeWedge: {
    width: 0, height: 0,
    borderLeftWidth: 9, borderRightWidth: 9,
    borderTopWidth: SLIDER_H + 90,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderTopColor: 'rgba(255,255,255,0.32)',
  },
  sizeKnob: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  // Live type-size readout that rides alongside the knob.
  sizeValue: {
    position: 'absolute', left: 38, minWidth: 34, height: 26, borderRadius: 13,
    paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
  },
  sizeValueText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stickerInputWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.lg },
  // Fixed 300 width = the placed sticker's wrap width (resolveSticker maxWidth),
  // so editing wrap === final wrap and the layout never re-measures mid-keystroke.
  stickerInput: { width: 300, paddingVertical: 0, paddingHorizontal: 0, textAlignVertical: 'center' },
  editorBox: { alignSelf: 'center' },
  // Invisible height-measuring twin of the input (narrower: see comment above).
  measureGhost: { position: 'absolute', opacity: 0, width: 286, left: 7 },

  styleBar: { paddingBottom: SPACING.sm, gap: SPACING.sm },
  // Vertical padding gives the scaled-up selected swatch room — without it the
  // ScrollView clips the top/bottom of the highlight ring.
  swatchRow: { paddingHorizontal: SPACING.md, paddingVertical: 8, gap: SPACING.sm, alignItems: 'center' },
  swatch: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  swatchActive: { borderColor: '#fff', borderWidth: 3, transform: [{ scale: 1.2 }] },
  fontRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, gap: SPACING.sm },
  bgToggle: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.28)',
  },
  bgToggleActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  fontPills: { gap: SPACING.sm, alignItems: 'center' },
  fontPill: {
    paddingHorizontal: SPACING.md, paddingVertical: 8,
    borderRadius: RADIUS.full, backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.28)',
  },
  fontPillActive: { backgroundColor: '#fff', borderColor: '#fff' },
  fontPillText: { color: '#fff', fontSize: 14 },
  fontPillTextActive: { color: '#111' },

  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: '#fff', borderRadius: RADIUS.full,
    paddingVertical: SPACING.md,
  },
  shareBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },

  captionPreview: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    alignSelf: 'flex-start', maxWidth: '100%',
  },
  captionPreviewText: { color: '#fff', fontSize: 14, lineHeight: 19 },
  // Chosen-song card — ONE integrated panel: the track row on top, then (photos
  // only) a hairline divider and the trim controls below. previewBottom pads 16 each
  // side, so this card is SCREEN_W-32 wide — exactly SongPartStrip's own width, which
  // lets the strip run full-bleed while the row/label/slider stay inset by SOUND_H_PAD.
  // No horizontal padding on the card itself, for that reason.
  songCard: {
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)',
    paddingVertical: SPACING.sm + 2, overflow: 'hidden',
  },
  songCardRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2,
    paddingHorizontal: SOUND_H_PAD,
  },
  songDivider: {
    height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.16)',
    marginHorizontal: SOUND_H_PAD, marginTop: SPACING.sm, marginBottom: SPACING.xs,
  },
  songTrimPad: { paddingHorizontal: SOUND_H_PAD },
  songTrimStart: { color: '#fff', fontSize: 12.5, fontWeight: '700', textAlign: 'center', marginBottom: 2 },
  songTrimHint: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, textAlign: 'center', paddingVertical: SPACING.md },
  songCardCover: { width: 46, height: 46, borderRadius: RADIUS.sm, overflow: 'hidden' },
  songCardCoverEmpty: { backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  songCardInfo: { flex: 1 },
  songCardTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  songCardArtist: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 1 },
  songCardBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  // Bottom control row: [length] … [change song] [✓ done].
  songControlsRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SOUND_H_PAD, marginTop: SPACING.sm, gap: SPACING.sm,
  },
  songChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm + 4, paddingVertical: 7,
  },
  songChipText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  songDoneBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  // Clip-length scroll menu (bottom sheet) — respects the app theme.
  durationOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  durationSheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.sm, paddingHorizontal: SPACING.md, maxHeight: '60%',
  },
  durationHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  durationTitle: { color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: SPACING.xs },
  durationList: { alignSelf: 'stretch' },
  durationRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, borderRadius: RADIUS.md,
  },
  durationRowSel: { backgroundColor: 'rgba(127,127,127,0.14)' },
  durationRowText: { color: colors.textSecondary, fontSize: 17, fontWeight: '600' },
  durationRowTextSel: { color: colors.text, fontWeight: '800' },
});
