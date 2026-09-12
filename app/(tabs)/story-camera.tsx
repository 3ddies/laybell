import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, Image, TextInput, Dimensions, Pressable, KeyboardAvoidingView,
  Platform, Keyboard, PanResponder, ScrollView,
} from 'react-native';
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
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { showPermissionDenied } from '../../lib/permissions';

const VIDEO_MAX_SEC = 60;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Text-size slider range (editor): top of the track = biggest type.
const SLIDER_H = 220;
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
    // Optimistic post: hand the (already-prewarming) upload + a snapshot of the
    // edits to the background provider, then return to Home immediately. No % —
    // the story pops into the tray, already-ready, once the upload lands.
    enqueueStory({
      captured,
      caption: caption.trim() || null,
      aspectRatio: '9:16',
      durationSeconds: captured.type === 'video' ? captured.durationSec ?? null : null,
      song: song ? { id: song.id, title: song.title, artist: song.artist, artistId: song.artistId } : null,
      stickers: stickers.length
        ? stickers.map(({ text, x, y, scale, rotation, font, color, bg, size, emoji }) =>
            ({ text, x, y, scale, rotation, font, color, bg, size, emoji }))
        : null,
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
          <Image source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <AppVideo
            source={{ uri: captured.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            active
            loop
            muted={false}
          />
        )}

        {/* Text/emoji stickers — ONE gesture layer that routes to the sticker
            nearest the touch: tap a sticker to edit, tap open media to add one,
            drag/pinch to move/resize, drop on the trash to delete. */}
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

        {!dragActive && (
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
  const sliderKnobTop = ((SIZE_MAX - size) / (SIZE_MAX - SIZE_MIN)) * SLIDER_H - 11;
  const finish = () => onCommit({ text, font, color, bg, size });

  return (
    <KeyboardAvoidingView
      style={[StyleSheet.absoluteFill, styles.stickerEditor]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={finish} />
      <View style={[styles.stickerDoneRow, { top: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.stickerDoneBtn} onPress={finish} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.stickerDoneText}>{t('storyCamera.done')}</Text>
        </TouchableOpacity>
      </View>

      {/* Size slider — drag to set the type size (how much fits per row) */}
      <View style={[styles.sizeSlider, { top: SCREEN_H * 0.24 }]} {...sizeSliderPan.panHandlers}>
        <View style={styles.sizeTrack} />
        <View style={[styles.sizeKnob, { top: Math.max(0, Math.min(SLIDER_H - 22, sliderKnobTop)) }]} pointerEvents="none" />
      </View>
      <View style={styles.stickerInputWrap} pointerEvents="box-none">
        <View style={[preview.boxStyle, styles.editorBox]}>
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
            placeholder={t('storyCamera.typeSomething')}
            placeholderTextColor="rgba(255,255,255,0.55)"
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
        </View>
        <MentionSuggestions
          query={getActiveMentionQuery(text, text.length)}
          onPick={(u) => setText(applyMention(text, text.length, u).text)}
          style={{ marginTop: SPACING.md, alignSelf: 'center', minWidth: 240 }}
          maxHeight={160}
        />
      </View>

      {/* Style toolbar — colors, then background toggle + font pills. */}
      <View style={styles.styleBar}>
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
                <Text style={[styles.fontPillText, resolveStickerFontPreview(f.key)]}>{f.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
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
  sizeTrack: { width: 4, height: '100%', borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  sizeKnob: {
    position: 'absolute', width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
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
  swatchRow: { paddingHorizontal: SPACING.md, paddingVertical: 6, gap: SPACING.sm, alignItems: 'center' },
  swatch: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)',
  },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.18 }] },
  fontRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, gap: SPACING.sm },
  bgToggle: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  bgToggleActive: { backgroundColor: colors.primary },
  fontPills: { gap: SPACING.sm, alignItems: 'center' },
  fontPill: {
    paddingHorizontal: SPACING.md, paddingVertical: 7,
    borderRadius: RADIUS.full, backgroundColor: 'rgba(255,255,255,0.15)',
  },
  fontPillActive: { backgroundColor: 'rgba(255,255,255,0.35)' },
  fontPillText: { color: '#fff', fontSize: 13 },

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
