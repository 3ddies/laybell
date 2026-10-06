import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, Image, TextInput, Dimensions, Pressable, KeyboardAvoidingView,
  Platform, Keyboard, PanResponder, ScrollView, Animated, Easing,
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
import MentionSuggestions from '../../components/MentionSuggestions';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type Sticker, type CaptionStyle, type StickerBg, type StickerFont,
} from '../../components/StickerLayer';
import { getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { useStories } from '../../contexts/StoriesContext';
import { useStoryUpload } from '../../contexts/StoryUploadContext';
import { usePostMusicActions, useSongHostActive } from '../../contexts/PostMusicContext';
import { useAudioControls } from '../../contexts/AudioContext';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { showPermissionDenied } from '../../lib/permissions';

const VIDEO_MAX_SEC = 60;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

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
  // In-editor song preview (host id keys this screen's playback in the shared
  // post-music player, which fetches the track by song id on demand).
  // Narrow subscription: this ALWAYS-MOUNTED camera screen used to consume the
  // full usePostMusic() (activeId), so EVERY ambient song start/stop anywhere
  // in the app re-rendered the whole camera — a heavy hidden cost that fired
  // exactly when song posts scrolled by (even under the reels modal). Now it
  // re-renders only when ITS OWN preview flips.
  const { playSong, stop: stopSong } = usePostMusicActions();
  const previewing = useSongHostActive('story-editor');
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
  const cropAnim = useRef({ pan: new Animated.ValueXY({ x: 0, y: 0 }), scale: new Animated.Value(1) }).current;
  const cropSaved = useRef({ tx: 0, ty: 0, scale: 1 });
  const resetCrop = useCallback(() => {
    cropAnim.pan.setValue({ x: 0, y: 0 });
    cropAnim.scale.setValue(1);
    cropSaved.current = { tx: 0, ty: 0, scale: 1 };
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
  // start → add to the saved baseline + clamp. `Math.abs` makes one clamp serve both
  // cases: above cover it prevents an empty edge; below cover it keeps the smaller
  // photo within the frame. MIN is low so the photo can shrink well onto the backdrop.
  const MIN_IMG_SCALE = 0.2;
  const MAX_IMG_SCALE = 6;
  const onPhotoGesture = useCallback((e: { phase: 'move' | 'end'; dx: number; dy: number; scale: number }) => {
    const s = Math.min(Math.max(cropSaved.current.scale * e.scale, MIN_IMG_SCALE), MAX_IMG_SCALE);
    const mx = Math.abs(baseW * s - SCREEN_W) / 2;
    const my = Math.abs(baseH * s - SCREEN_H) / 2;
    const tx = Math.min(Math.max(cropSaved.current.tx + e.dx, -mx), mx);
    const ty = Math.min(Math.max(cropSaved.current.ty + e.dy, -my), my);
    cropAnim.pan.setValue({ x: tx, y: ty });
    cropAnim.scale.setValue(s);
    if (e.phase === 'end') cropSaved.current = { tx, ty, scale: s };
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
        stopSong('story-editor');
        setSong(null); setShowCaption(false); setSaved(false);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function close() {
    navigation.navigate('index');
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
    setSong(null); setShowCaption(false); setSaved(false);
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
    const framed = canAdjust && (cropSaved.current.scale !== 1 || cropSaved.current.tx !== 0 || cropSaved.current.ty !== 0);
    const frameLayer: any = framed
      ? { kind: 'frame', scale: cropSaved.current.scale, x: cropSaved.current.tx / SCREEN_W, y: cropSaved.current.ty / SCREEN_H, w: imgW, h: imgH }
      : null;
    const textStickers = stickers.map(({ text, x, y, scale, rotation, font, color, bg, size, emoji }) =>
      ({ text, x, y, scale, rotation, font, color, bg, size, emoji }));
    const allStickers: any[] = frameLayer ? [...textStickers, frameLayer] : textStickers;
    // Optimistic post: hand the (already-prewarming) upload + a snapshot of the edits
    // to the background provider, then return to Home immediately.
    enqueueStory({
      captured,
      caption: caption.trim() || null,
      aspectRatio: '9:16',
      durationSeconds: captured.type === 'video' ? captured.durationSec ?? null : null,
      song: song ? { id: song.id, title: song.title, artist: song.artist, artistId: song.artistId } : null,
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
              <ExpoImage source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" />
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

        {/* Drop-to-delete target (only while a sticker is being dragged) */}
        {dragActive && (
          <View style={[styles.trashZone, { bottom: insets.bottom + 56 }]} pointerEvents="none">
            <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
              <Ionicons name="trash-outline" size={overTrash ? 30 : 24} color="#fff" />
            </View>
          </View>
        )}

        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={retake} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
          <Ionicons name="arrow-back" size={26} color="#fff" />
        </TouchableOpacity>

        {/* Edit tool rail — text, emoji, caption, music, save */}
        {!dragActive && (
          <View style={[styles.toolRail, { top: insets.top + 8 }]}>
            <TouchableOpacity style={styles.roundBtn} onPress={() => addStickerAt(0.5, 0.4)}>
              <Text style={styles.aaBtnText}>Aa</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.roundBtn} onPress={() => setShowCaption(true)}>
              <Ionicons
                name={caption.trim() ? 'chatbox-ellipses' : 'chatbox-ellipses-outline'}
                size={23}
                color={caption.trim() ? colors.primaryLight : '#fff'}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.roundBtn} onPress={() => setShowSongPicker(true)}>
              <Ionicons
                name={song ? 'musical-notes' : 'musical-notes-outline'}
                size={23}
                color={song ? colors.primaryLight : '#fff'}
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
        {!dragActive && !editingId && (
        <View style={[styles.previewBottom, { bottom: kbHeight, paddingBottom: kbHeight > 0 ? SPACING.md : insets.bottom + SPACING.md }]}>
          {/* Chosen song / written caption show as compact pills; the actual
              "add" actions live on the right tool rail. */}
          {song && (
            <View style={styles.songCard}>
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
              {/* Preview the chosen track — the app's signature orange circle */}
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={previewing ? t('a11y.pause') : t('a11y.play')}
                onPress={() => (previewing ? stopSong('story-editor') : playSong('story-editor', song.id))}
                hitSlop={6}
              >
                {/* White in BOTH themes. This card floats on the photo, not on
                    the theme — its swap and close icons are already hardcoded
                    #fff for that reason — so following colors.text turned the
                    play button into a black disc on the media in light mode. */}
                <Ionicons name={previewing ? 'pause-circle' : 'play-circle'} size={44} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.flipCamera')} style={styles.songCardBtn} onPress={() => setShowSongPicker(true)} hitSlop={6}>
                <Ionicons name="swap-horizontal" size={20} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')}
                style={styles.songCardBtn}
                onPress={() => { stopSong('story-editor'); setSong(null); }}
                hitSlop={6}
              >
                <Ionicons name="close" size={20} color="#fff" />
              </TouchableOpacity>
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
          onSelect={(s) => { stopSong('story-editor'); setSong(s); }}
        />
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
  toolRail: { position: 'absolute', right: SPACING.md, gap: SPACING.sm },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)',
  },
  trashCircleHot: { backgroundColor: colors.error, borderColor: '#fff', transform: [{ scale: 1.15 }] },

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
  // Chosen-song card: tall and prominent, with comfortable touch targets for
  // preview / swap / remove.
  songCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)',
    padding: SPACING.sm + 4,
  },
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
});
