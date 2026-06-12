import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Image, TextInput, Linking, Dimensions, Pressable, KeyboardAvoidingView,
  Platform, Keyboard, Animated, Easing, PanResponder, ScrollView,
} from 'react-native';
import {
  CameraView, CameraType, FlashMode,
  useCameraPermissions, useMicrophonePermissions,
} from 'expo-camera';
import { Video, ResizeMode } from 'expo-av';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as MediaLibrary from 'expo-media-library';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Image as ExpoImage } from 'expo-image';
import { useIsFocused, useNavigation, useNavigationState } from '@react-navigation/native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { uploadStoryMedia, createStory } from '../../lib/stories';
import SongPickerModal, { type PickedSong } from '../../components/SongPickerModal';
import MentionSuggestions from '../../components/MentionSuggestions';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type Sticker, type CaptionStyle, type StickerBg, type StickerFont,
} from '../../components/StickerLayer';
import { getActiveMentionQuery, applyMention } from '../../lib/mentions';
import { useStories } from '../../contexts/StoriesContext';
import { usePostMusic } from '../../contexts/PostMusicContext';
import { usePagerSwiping, useTabSwipeControl } from '../../contexts/PagerContext';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';

const VIDEO_MAX_SEC = 60;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Text-size slider range (editor): top of the track = biggest type.
const SLIDER_H = 220;
const SIZE_MIN = 14;
const SIZE_MAX = 56;

type Captured = { uri: string; type: 'image' | 'video'; durationSec?: number; processed?: boolean };
type Mode = 'picture' | 'video';

// The live story camera, page 0 of the tab pager (LEFT of Home) so swiping right
// off Home reveals the camera as the background. CameraView is ALWAYS mounted and
// paused via `active={isFocused}` — mounting/unmounting it on each swipe is what
// froze the app before, so we never unmount it; we just pause it.
export default function StoryCameraScreen() {
  const { colors } = useTheme();
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

  const [camPermission, requestCamPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');         // photo flash: off → auto → on
  const [torchOn, setTorchOn] = useState(false);                // video continuous light
  const [mode, setMode] = useState<Mode>('picture');

  // ── Pro-camera state ────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(0);                           // 0..1 (fraction of device max)
  const zoomRef = useRef(0);
  const [zoomHudVisible, setZoomHudVisible] = useState(false);
  const zoomHudTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasUltraWide, setHasUltraWide] = useState(false);       // iOS: 0.5x lens available
  const [ultraWide, setUltraWide] = useState(false);
  const [grid, setGrid] = useState(false);
  const [timerMode, setTimerMode] = useState<0 | 3 | 10>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [afPulse, setAfPulse] = useState<'on' | 'off'>('off');   // tap-to-focus retrigger
  const afTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const focusAnim = useRef(new Animated.Value(0)).current;
  const [screenFlash, setScreenFlash] = useState(false);         // front-camera "flash"
  const [libThumb, setLibThumb] = useState<string | null>(null); // last library asset preview
  const holdRef = useRef<null | 'starting' | 'recording'>(null); // hold-shutter-to-record

  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recSecsRef = useRef(0);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recProgress = useRef(new Animated.Value(0)).current;     // top progress bar (0→1 over 60s)

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
  const [caption, setCaption] = useState('');                       // plain bottom caption
  const [stickers, setStickers] = useState<Sticker[]>([]);           // draggable text/emoji stickers
  const [editingId, setEditingId] = useState<string | null>(null);  // sticker whose text is being edited
  const [editingText, setEditingText] = useState('');               // the editor's working text
  const [editingFont, setEditingFont] = useState<StickerFont>('classic');
  const [editingColor, setEditingColor] = useState('#FFFFFF');
  const [editingBg, setEditingBg] = useState<StickerBg>('none');
  const [editingSize, setEditingSize] = useState(26);               // slider-chosen font size
  const [editorTextH, setEditorTextH] = useState(0);                // measured input height (reliable growth)
  // Vertical size slider (left edge of the text editor) — position → font size.
  const sizeSliderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setEditingSize(sizeFromTrackY(e.nativeEvent.locationY)),
      onPanResponderMove: (e) => setEditingSize(sizeFromTrackY(e.nativeEvent.locationY)),
    }),
  ).current;
  const [kbHeight, setKbHeight] = useState(0);                       // keyboard height (lifts the bottom caption)
  const stickerIdRef = useRef(0);
  const [song, setSong] = useState<PickedSong | null>(null);
  const [showSongPicker, setShowSongPicker] = useState(false);
  // In-editor song preview (host id keys this screen's playback in the shared
  // post-music player, which fetches the track by song id on demand).
  const { playSong, stop: stopSong, activeId: previewActiveId } = usePostMusic();
  const previewing = previewActiveId === 'story-editor';
  const [showCaption, setShowCaption] = useState(false);            // caption input (opened from the rail)
  const [dragActive, setDragActive] = useState(false);              // a sticker is mid-drag → show trash
  const [overTrash, setOverTrash] = useState(false);
  const [saved, setSaved] = useState(false);                         // media saved to device
  const [uploading, setUploading] = useState(false);

  // ── Text / emoji stickers ───────────────────────────────────────────────────
  function addStickerAt(xNorm: number, yNorm: number) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, {
      id, text: '', x: xNorm, y: yNorm, scale: 1, rotation: 0,
      font: editingFont, color: editingColor, bg: editingBg, size: editingSize,
    }]);
    setEditingId(id);
    setEditingText('');
    setEditorTextH(0);
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
    setEditorTextH(0);
  }
  function manipulateSticker(id: string, style: CaptionStyle) {
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...style } : s)));
  }
  function finishEditing() {
    setStickers((prev) =>
      prev
        .map((s) => (s.id === editingId
          ? { ...s, text: editingText.trim(), font: editingFont, color: editingColor, bg: editingBg, size: editingSize }
          : s))
        .filter((s) => s.text !== ''),
    );
    setEditingId(null);
    setEditingText('');
  }
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

  // Ask for camera access the first time you actually open the camera.
  useEffect(() => {
    if (isFocused && camPermission && !camPermission.granted && camPermission.canAskAgain) {
      requestCamPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, camPermission]);

  // Gallery button preview: the most recent library asset — only if the library
  // permission was already granted elsewhere (never prompts from here).
  useEffect(() => {
    if (!isFocused) return;
    (async () => {
      try {
        const perm = await MediaLibrary.getPermissionsAsync();
        if (!perm.granted) return;
        const { assets } = await MediaLibrary.getAssetsAsync({
          first: 1,
          sortBy: [MediaLibrary.SortBy.creationTime],
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        });
        if (assets[0]?.uri) setLibThumb(assets[0].uri);
      } catch {}
    })();
  }, [isFocused]);

  // iOS: discover the ultra-wide lens so we can offer a real 0.5x like the
  // native camera (not a digital crop).
  const probeLenses = useCallback(async () => {
    if (Platform.OS !== 'ios') return;
    try {
      const lenses = await cameraRef.current?.getAvailableLensesAsync?.();
      setHasUltraWide(!!lenses?.includes('builtInUltraWideCamera'));
    } catch {}
  }, []);

  // Reset to a clean live viewfinder whenever we leave the page (so re-opening
  // never lands on a stale preview, and any recording is torn down).
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
        if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
        if (afTimer.current) { clearTimeout(afTimer.current); afTimer.current = null; }
        if (recordingRef.current) cameraRef.current?.stopRecording();
        holdRef.current = null;
        setRecording(false);
        setRecSecs(0);
        recProgress.setValue(0);
        setCountdown(null);
        setStage('capture');
        setCaptured(null);
        setCaption(''); setStickers([]); setEditingId(null); setEditingText('');
        stopSong('story-editor');
        setSong(null); setShowCaption(false); setSaved(false);
        setMode('picture');
        setTorchOn(false);
        setZoom(0); zoomRef.current = 0;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  function close() {
    navigation.navigate('index');
  }

  async function toggleMode() {
    const next: Mode = mode === 'picture' ? 'video' : 'picture';
    if (next === 'video' && micPermission && !micPermission.granted && micPermission.canAskAgain) {
      await requestMicPermission();
    }
    setMode(next);
  }

  // ── Viewfinder gestures: pinch zoom, tap-to-focus, double-tap flip ──────────
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchBase = useRef({ dist: 0, zoom: 0 });
  const dragBase = useRef({ y: 0, zoom: 0 });
  const gestureMoved = useRef(false);
  const recordingRef = useRef(false); recordingRef.current = recording;
  const facingRef = useRef(facing); facingRef.current = facing;
  const countdownRef = useRef<number | null>(null); countdownRef.current = countdown;

  function showZoomHud() {
    setZoomHudVisible(true);
    if (zoomHudTimer.current) clearTimeout(zoomHudTimer.current);
    zoomHudTimer.current = setTimeout(() => setZoomHudVisible(false), 1200);
  }
  function applyZoom(z: number) {
    const clamped = Math.max(0, Math.min(1, z));
    zoomRef.current = clamped;
    setZoom(clamped);
    showZoomHud();
  }

  function tapToFocus(x: number, y: number) {
    setFocusPoint({ x, y });
    focusAnim.setValue(0);
    Animated.sequence([
      Animated.timing(focusAnim, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.delay(450),
      Animated.timing(focusAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(() => setFocusPoint(null));
    // expo-camera has no focus-point API — retrigger a focus pass instead
    // ('on' focuses then locks; back to 'off' resumes continuous AF).
    setAfPulse('on');
    if (afTimer.current) clearTimeout(afTimer.current);
    afTimer.current = setTimeout(() => setAfPulse('off'), 400);
  }

  function flipCamera() {
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
    setUltraWide(false);
    applyZoom(0);
  }

  // One responder for the whole viewfinder. Single-finger horizontal swipes are
  // NOT claimed (the tab pager keeps its swipe-to-Home); we take taps, two-finger
  // pinches, and — while recording — one-finger vertical drags (slide-to-zoom).
  const viewfinderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (e, g) =>
        e.nativeEvent.touches.length >= 2 ||
        (recordingRef.current && Math.abs(g.dy) > Math.abs(g.dx) * 1.5 && Math.abs(g.dy) > 8),
      onPanResponderTerminationRequest: () => true,
      onPanResponderGrant: (e) => {
        const t = e.nativeEvent.touches;
        gestureMoved.current = false;
        if (t.length >= 2) {
          const dx = t[1].pageX - t[0].pageX, dy = t[1].pageY - t[0].pageY;
          pinchBase.current = { dist: Math.hypot(dx, dy), zoom: zoomRef.current };
        } else {
          dragBase.current = { y: t[0]?.pageY ?? 0, zoom: zoomRef.current };
        }
      },
      onPanResponderMove: (e) => {
        const t = e.nativeEvent.touches;
        if (t.length >= 2) {
          if (pinchBase.current.dist === 0) {
            const dx = t[1].pageX - t[0].pageX, dy = t[1].pageY - t[0].pageY;
            pinchBase.current = { dist: Math.hypot(dx, dy), zoom: zoomRef.current };
            return;
          }
          const dx = t[1].pageX - t[0].pageX, dy = t[1].pageY - t[0].pageY;
          const ratio = Math.hypot(dx, dy) / pinchBase.current.dist;
          gestureMoved.current = true;
          applyZoom(pinchBase.current.zoom + (ratio - 1) * 0.6);
        } else if (recordingRef.current && t.length === 1) {
          // Slide up to zoom while recording (one continuous motion, IG-style).
          const dy = (t[0]?.pageY ?? 0) - dragBase.current.y;
          if (Math.abs(dy) > 6) gestureMoved.current = true;
          applyZoom(dragBase.current.zoom - dy / 420);
        }
      },
      onPanResponderRelease: (e) => {
        if (gestureMoved.current) { pinchBase.current.dist = 0; return; }
        // A clean tap. Double-tap flips; otherwise (after a beat) focus.
        const { pageX: x, pageY: y } = e.nativeEvent;
        const now = Date.now();
        const isDouble = now - lastTap.current.t < 300 &&
          Math.hypot(x - lastTap.current.x, y - lastTap.current.y) < 60;
        lastTap.current = { t: now, x, y };
        if (countdownRef.current != null) { cancelCountdown(); return; }
        if (isDouble) {
          if (singleTapTimer.current) { clearTimeout(singleTapTimer.current); singleTapTimer.current = null; }
          // Flipping mid-record would tear down the in-flight recording.
          if (!recordingRef.current) flipCamera();
        } else {
          if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
          singleTapTimer.current = setTimeout(() => {
            singleTapTimer.current = null;
            if (facingRef.current === 'back') tapToFocus(x, y);
          }, 280);
        }
        pinchBase.current.dist = 0;
      },
      onPanResponderTerminate: () => { pinchBase.current.dist = 0; },
    }),
  ).current;

  // ── Capture ─────────────────────────────────────────────────────────────────
  async function takePhoto() {
    try {
      // Front "flash": light the subject with a full-white screen for a beat.
      const needScreenFlash = facing === 'front' && flash !== 'off';
      if (needScreenFlash) {
        setScreenFlash(true);
        await new Promise((r) => setTimeout(r, 220));
      }
      // Full-quality capture (the CameraView's `mirror` prop already matches
      // front shots to the preview), then ONE manipulate pass: downscale to
      // high-res story width and compress. Single re-encode keeps it sharp.
      const photo = await cameraRef.current?.takePictureAsync({ quality: 1, shutterSound: false });
      if (needScreenFlash) setScreenFlash(false);
      if (!photo?.uri) return;
      let uri = photo.uri;
      try {
        const out = await manipulateAsync(
          photo.uri,
          [{ resize: { width: 1920 } }],
          { compress: 0.9, format: SaveFormat.JPEG },
        );
        uri = out.uri;
      } catch {}
      setCapturedMedia({ uri, type: 'image', processed: true });
    } catch (e: any) {
      setScreenFlash(false);
      Alert.alert('Could not take photo', e?.message ?? 'Please try again.');
    }
  }

  async function startRecording(fromHold = false) {
    if (recording) return;
    setRecording(true);
    setRecSecs(0);
    recSecsRef.current = 0;
    recTimer.current = setInterval(() => { recSecsRef.current += 1; setRecSecs(recSecsRef.current); }, 1000);
    recProgress.setValue(0);
    Animated.timing(recProgress, {
      toValue: 1, duration: VIDEO_MAX_SEC * 1000, easing: Easing.linear, useNativeDriver: false,
    }).start();
    try {
      const video = await cameraRef.current?.recordAsync({ maxDuration: VIDEO_MAX_SEC });
      if (video?.uri) {
        setCapturedMedia({ uri: video.uri, type: 'video', durationSec: recSecsRef.current || undefined });
      }
    } catch (e: any) {
      Alert.alert('Could not record video', e?.message ?? 'Please try again.');
    } finally {
      if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
      recProgress.stopAnimation();
      recProgress.setValue(0);
      setRecording(false);
      if (fromHold || holdRef.current) { holdRef.current = null; setMode('picture'); }
    }
  }

  function stopRecording() {
    if (!recording) return;
    cameraRef.current?.stopRecording();
  }

  function setCapturedMedia(c: Captured) {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    setRecording(false);
    setSaved(false);
    setCaptured(c);
    setStage('preview');
  }

  // ── Timer countdown ─────────────────────────────────────────────────────────
  function cancelCountdown() {
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    setCountdown(null);
  }
  function startCountdown(then: () => void) {
    let n = timerMode as number;
    setCountdown(n);
    countdownTimer.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        cancelCountdown();
        then();
      } else {
        setCountdown(n);
      }
    }, 1000);
  }

  function capture() {
    if (mode === 'video') {
      recording ? stopRecording() : startRecording();
    } else {
      takePhoto();
    }
  }

  function onShutterPress() {
    if (countdown != null) { cancelCountdown(); return; }
    if (timerMode > 0 && !recording) startCountdown(capture);
    else capture();
  }

  // Hold the shutter in PHOTO mode to record a video; release to stop.
  async function onShutterLongPress() {
    if (mode !== 'picture' || recording || countdown != null) return;
    if (micPermission && !micPermission.granted && micPermission.canAskAgain) {
      await requestMicPermission();
    }
    holdRef.current = 'starting';
    setMode('video'); // the pipeline needs a beat to reconfigure before recording
    setTimeout(() => {
      if (holdRef.current === 'starting') {
        holdRef.current = 'recording';
        startRecording(true);
      }
    }, 420);
  }
  function onShutterPressOut() {
    if (holdRef.current === 'starting') {
      holdRef.current = null;
      setMode('picture');
    } else if (holdRef.current === 'recording') {
      stopRecording();
    }
  }

  async function pickFromLibrary() {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 1,
      videoMaxDuration: VIDEO_MAX_SEC,
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
        Alert.alert('Photos access needed', 'Allow access to save to your library.');
        return;
      }
      await MediaLibrary.saveToLibraryAsync(captured.uri);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Saving may need the latest app build.');
    }
  }

  async function shareStory() {
    if (!captured) return;
    stopSong('story-editor');
    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let mediaUrl: string;
      let thumbnailUrl: string | null = null;

      if (captured.type === 'image') {
        let outUri = captured.uri;
        // Camera shots are already processed in takePhoto; only library picks
        // still need the downscale/compress pass here.
        if (!captured.processed) {
          try {
            const out = await manipulateAsync(captured.uri, [{ resize: { width: 1920 } }], {
              compress: 0.9, format: SaveFormat.JPEG,
            });
            outUri = out.uri;
          } catch {}
        }
        mediaUrl = await uploadStoryMedia(user.id, outUri, 'jpg', 'image/jpeg');
      } else {
        const ext = captured.uri.split('.').pop() || 'mp4';
        mediaUrl = await uploadStoryMedia(user.id, captured.uri, ext, 'video/mp4');
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(captured.uri, { time: 0 });
          thumbnailUrl = await uploadStoryMedia(user.id, uri, 'jpg', 'image/jpeg');
        } catch {}
      }

      await createStory({
        userId: user.id,
        mediaUrl,
        mediaType: captured.type,
        thumbnailUrl,
        caption: caption.trim() || null,
        aspectRatio: '9:16',
        durationSeconds: captured.type === 'video' ? captured.durationSec ?? null : null,
        song,
        stickers: stickers.length
          ? stickers.map(({ text, x, y, scale, rotation, font, color, bg, size, emoji }) =>
              ({ text, x, y, scale, rotation, font, color, bg, size, emoji }))
          : null,
      });

      retake();
      refreshStories();
      navigation.navigate('index');
    } catch (e: any) {
      Alert.alert('Could not post story', e?.message ?? 'Please try again.');
    } finally {
      setUploading(false);
    }
  }

  // ─── Permission gate ─────────────────────────────────────────────────────
  if (camPermission && !camPermission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Ionicons name="camera-outline" size={48} color={colors.textTertiary} />
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permSub}>Allow camera access to capture stories.</Text>
        <TouchableOpacity
          style={styles.permBtn}
          onPress={() => (camPermission.canAskAgain ? requestCamPermission() : Linking.openSettings())}
        >
          <Text style={styles.permBtnText}>
            {camPermission.canAskAgain ? 'Allow camera' : 'Open settings'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.permClose} onPress={close}>
          <Text style={styles.permCloseText}>Back to feed</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Preview / edit ────────────────────────────────────────────────────────
  if (stage === 'preview' && captured) {
    const editingPreview = resolveSticker({ font: editingFont, color: editingColor, bg: editingBg, size: editingSize });
    const sliderKnobTop = ((SIZE_MAX - editingSize) / (SIZE_MAX - SIZE_MIN)) * SLIDER_H - 11;
    return (
      <View style={styles.container}>
        {captured.type === 'image' ? (
          <Image source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Video
            source={{ uri: captured.uri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.COVER}
            shouldPlay
            isLooping
            isMuted={false}
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

        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={retake}>
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
              <TouchableOpacity
                onPress={() => (previewing ? stopSong('story-editor') : playSong('story-editor', song.id))}
                hitSlop={6}
              >
                <Ionicons name={previewing ? 'pause-circle' : 'play-circle'} size={44} color={colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.songCardBtn} onPress={() => setShowSongPicker(true)} hitSlop={6}>
                <Ionicons name="swap-horizontal" size={20} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity
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
                placeholder="Add a caption…"
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
          <TouchableOpacity style={styles.shareBtn} onPress={shareStory} disabled={uploading}>
            {uploading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text style={styles.shareBtnText}>Add to story</Text>
                <Ionicons name="arrow-forward-circle" size={22} color="#fff" />
              </>
            )}
          </TouchableOpacity>
        </View>
        )}

        {/* Full-screen text editor — live-styled preview + font/color toolbar. */}
        {editingId && (
          <KeyboardAvoidingView
            style={[StyleSheet.absoluteFill, styles.stickerEditor]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={finishEditing} />
            <View style={[styles.stickerDoneRow, { top: insets.top + 8 }]} pointerEvents="box-none">
              <TouchableOpacity style={styles.stickerDoneBtn} onPress={finishEditing} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={styles.stickerDoneText}>Done</Text>
              </TouchableOpacity>
            </View>

            {/* Size slider — drag to set the type size (how much fits per row) */}
            <View style={[styles.sizeSlider, { top: SCREEN_H * 0.24 }]} {...sizeSliderPan.panHandlers}>
              <View style={styles.sizeTrack} />
              <View style={[styles.sizeKnob, { top: Math.max(0, Math.min(SLIDER_H - 22, sliderKnobTop)) }]} pointerEvents="none" />
            </View>
            <View style={styles.stickerInputWrap} pointerEvents="box-none">
              <View style={[editingPreview.boxStyle, styles.editorBox]}>
                {/* Deterministic layout: FIXED width (identical to the placed
                    sticker's wrap width) and the height measured by an
                    INVISIBLE mirror <Text> below — Text layout is exact, while
                    a height-controlled iOS TextInput under-reports its own
                    content (that's why wrapped lines were vanishing). The
                    mirror is slightly NARROWER than the input to compensate
                    for UITextView's internal caret padding, so it always wraps
                    at-or-before the input does → never under-measures. */}
                <TextInput
                  style={[styles.stickerInput, editingPreview.textStyle, {
                    height: (editorTextH > 0
                      ? editorTextH
                      : ((editingPreview.textStyle.lineHeight as number) ?? 34)) + 8,
                    maxHeight: SCREEN_H * 0.45, // can never push itself off-screen
                  }]}
                  value={editingText}
                  onChangeText={setEditingText}
                  placeholder="Type something…"
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
                  style={[styles.stickerInput, editingPreview.textStyle, styles.measureGhost]}
                  onLayout={(e) => {
                    const h = Math.ceil(e.nativeEvent.layout.height);
                    setEditorTextH((prev) => (prev === h ? prev : h));
                  }}
                >
                  {editingText.length === 0 ? ' ' : editingText.endsWith('\n') ? `${editingText} ` : editingText}
                </Text>
              </View>
              <MentionSuggestions
                query={getActiveMentionQuery(editingText, editingText.length)}
                onPick={(u) => setEditingText(applyMention(editingText, editingText.length, u).text)}
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
                    style={[styles.swatch, { backgroundColor: c }, editingColor === c && styles.swatchActive]}
                    onPress={() => setEditingColor(c)}
                  />
                ))}
              </ScrollView>
              <View style={styles.fontRow}>
                <TouchableOpacity
                  style={[styles.bgToggle, editingBg !== 'none' && styles.bgToggleActive]}
                  onPress={() => setEditingBg((b) => (b === 'none' ? 'soft' : b === 'soft' ? 'pill' : 'none'))}
                >
                  <Ionicons name="color-fill-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontPills} keyboardShouldPersistTaps="always">
                  {STICKER_FONTS.map((f) => (
                    <TouchableOpacity
                      key={f.key}
                      style={[styles.fontPill, editingFont === f.key && styles.fontPillActive]}
                      onPress={() => setEditingFont(f.key)}
                    >
                      <Text style={[styles.fontPillText, resolveStickerFontPreview(f.key)]}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
          </KeyboardAvoidingView>
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
  const zoomFactor = ultraWide ? 0.5 : 1 + zoom * 4; // display-only approximation
  return (
    <View style={styles.container}>
      {camPermission?.granted ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          flash={flash}
          enableTorch={facing === 'back' && mode === 'video' && torchOn}
          mode={mode}
          zoom={zoom}
          // Output matches the mirrored selfie preview without a re-encode pass.
          mirror={facing === 'front'}
          autofocus={afPulse}
          animateShutter={false}
          // 1080p + stabilization: the sharpest stories that still upload
          // reliably (4K hits the storage size cap on long clips).
          videoQuality="1080p"
          videoStabilizationMode="auto"
          {...(Platform.OS === 'ios' && facing === 'back' && hasUltraWide
            ? { selectedLens: ultraWide ? 'builtInUltraWideCamera' : 'builtInWideAngleCamera' }
            : {})}
          mute={!micPermission?.granted}
          active={cameraActive}
          onCameraReady={probeLenses}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
      )}

      {/* Gesture surface: pinch zoom, tap focus, double-tap flip, record-zoom */}
      <View style={StyleSheet.absoluteFill} {...viewfinderPan.panHandlers} />

      {/* Rule-of-thirds grid */}
      {grid && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={[styles.gridLine, { left: SCREEN_W / 3, width: 1, top: 0, bottom: 0 }]} />
          <View style={[styles.gridLine, { left: (SCREEN_W / 3) * 2, width: 1, top: 0, bottom: 0 }]} />
          <View style={[styles.gridLine, { top: SCREEN_H / 3, height: 1, left: 0, right: 0 }]} />
          <View style={[styles.gridLine, { top: (SCREEN_H / 3) * 2, height: 1, left: 0, right: 0 }]} />
        </View>
      )}

      {/* Tap-to-focus reticle */}
      {focusPoint && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.focusBox,
            {
              left: focusPoint.x - 36, top: focusPoint.y - 36,
              opacity: focusAnim,
              transform: [{ scale: focusAnim.interpolate({ inputRange: [0, 1], outputRange: [1.5, 1] }) }],
            },
          ]}
        />
      )}

      {/* Front-camera screen flash */}
      {screenFlash && <View style={[StyleSheet.absoluteFill, { backgroundColor: '#fff' }]} />}

      {/* Recording progress (60s) along the very top */}
      {recording && (
        <View style={[styles.recBarTrack, { top: insets.top + 4 }]}>
          <Animated.View
            style={[styles.recBarFill, { width: recProgress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
          />
        </View>
      )}

      {/* Top controls */}
      <View style={[styles.topRow, { top: insets.top + 12 }]}>
        {!recording ? (
          <TouchableOpacity style={styles.roundBtn} onPress={close}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        ) : <View style={styles.roundBtn} />}

        {recording && (
          <View style={styles.recPill}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>{fmtClock(recSecs)}</Text>
          </View>
        )}

        {/* Tool rail */}
        {!recording ? (
          <View style={styles.railCol}>
            <TouchableOpacity
              style={styles.roundBtn}
              onPress={() => {
                if (mode === 'video') setTorchOn((t) => !t);
                else setFlash((f) => (f === 'off' ? 'auto' : f === 'auto' ? 'on' : 'off'));
              }}
            >
              {mode === 'video' ? (
                <Ionicons name={torchOn ? 'flashlight' : 'flashlight-outline'} size={22} color={torchOn ? colors.primaryLight : '#fff'} />
              ) : flash === 'auto' ? (
                <View style={styles.flashAutoWrap}>
                  <Ionicons name="flash" size={20} color="#fff" />
                  <Text style={styles.flashAutoA}>A</Text>
                </View>
              ) : (
                <Ionicons name={flash === 'off' ? 'flash-off' : 'flash'} size={22} color={flash === 'on' ? colors.primaryLight : '#fff'} />
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.roundBtn} onPress={() => setTimerMode((t) => (t === 0 ? 3 : t === 3 ? 10 : 0))}>
              {timerMode === 0 ? (
                <Ionicons name="timer-outline" size={22} color="#fff" />
              ) : (
                <Text style={styles.timerBadge}>{timerMode}s</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.roundBtn} onPress={() => setGrid((g) => !g)}>
              <Ionicons name="grid-outline" size={20} color={grid ? colors.primaryLight : '#fff'} />
            </TouchableOpacity>
          </View>
        ) : <View style={styles.roundBtn} />}
      </View>

      {/* Zoom HUD */}
      {(zoomHudVisible || ultraWide) && !recording && (
        <View style={styles.zoomHud} pointerEvents="none">
          <Text style={styles.zoomHudText}>{zoomFactor.toFixed(1)}×</Text>
        </View>
      )}

      {/* Timer countdown */}
      {countdown != null && (
        <Pressable style={[StyleSheet.absoluteFill, styles.countdownWrap]} onPress={cancelCountdown}>
          <Text style={styles.countdownText}>{countdown}</Text>
          <Text style={styles.countdownHint}>Tap to cancel</Text>
        </Pressable>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + SPACING.md }]}>
        {/* iOS lens presets (real ultra-wide, not a digital crop) */}
        {!recording && hasUltraWide && facing === 'back' && (
          <View style={styles.lensRow}>
            {([true, false] as const).map((uw) => (
              <TouchableOpacity
                key={String(uw)}
                style={[styles.lensBtn, ultraWide === uw && styles.lensBtnActive]}
                onPress={() => { setUltraWide(uw); applyZoom(0); }}
              >
                <Text style={[styles.lensText, ultraWide === uw && styles.lensTextActive]}>{uw ? '.5' : '1×'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {!recording && (
          <View style={styles.modeRow}>
            {(['picture', 'video'] as Mode[]).map((m) => (
              <TouchableOpacity key={m} onPress={() => m !== mode && toggleMode()} style={[styles.modePill, mode === m && styles.modePillActive]}>
                <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
                  {m === 'picture' ? 'PHOTO' : 'VIDEO'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={styles.shutterRow}>
          {!recording ? (
            <TouchableOpacity style={styles.galleryBtn} onPress={pickFromLibrary}>
              {libThumb ? (
                <ExpoImage source={{ uri: libThumb }} style={styles.galleryThumb} contentFit="cover" />
              ) : (
                <Ionicons name="images-outline" size={26} color="#fff" />
              )}
            </TouchableOpacity>
          ) : <View style={styles.galleryBtn} />}

          <Pressable
            onPress={onShutterPress}
            onLongPress={onShutterLongPress}
            onPressOut={onShutterPressOut}
            delayLongPress={260}
            style={({ pressed }) => [styles.shutterOuter, recording && styles.shutterOuterRec, pressed && !recording && { transform: [{ scale: 0.92 }] }]}
          >
            <View
              style={[
                styles.shutterInner,
                mode === 'video' && styles.shutterInnerVideo,
                recording && styles.shutterInnerRecording,
              ]}
            />
          </Pressable>

          {!recording ? (
            <TouchableOpacity style={styles.galleryBtn} onPress={flipCamera}>
              <Ionicons name="camera-reverse-outline" size={28} color="#fff" />
            </TouchableOpacity>
          ) : <View style={styles.galleryBtn} />}
        </View>

        {!recording && mode === 'picture' && (
          <Text style={styles.holdHint}>Hold for video</Text>
        )}
        {recording && (
          <Text style={styles.holdHint}>Slide up to zoom</Text>
        )}
      </View>
    </View>
  );
}

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

function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SHUTTER = 78;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // Absolute-fill (not flex:1) so it ignores the navigator's sceneContainerStyle
  // bottom padding and stays edge-to-edge — full-screen camera, no gray slot.
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },

  permTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: SPACING.sm },
  permSub: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  permBtn: {
    marginTop: SPACING.md, backgroundColor: colors.primary,
    borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.xl,
  },
  permBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  permClose: { marginTop: SPACING.sm, padding: SPACING.sm },
  permCloseText: { color: colors.textSecondary, fontSize: 14 },

  topRow: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
  },
  railCol: { gap: SPACING.sm },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  flashAutoWrap: { flexDirection: 'row', alignItems: 'flex-start' },
  flashAutoA: { color: '#fff', fontSize: 10, fontWeight: '800', marginLeft: -2 },
  timerBadge: { color: colors.primaryLight, fontSize: 14, fontWeight: '800' },

  gridLine: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.28)' },

  focusBox: {
    position: 'absolute', width: 72, height: 72, borderRadius: 14,
    borderWidth: 1.5, borderColor: '#FAB525',
  },

  zoomHud: {
    position: 'absolute', alignSelf: 'center', top: SCREEN_H * 0.18,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: 14,
  },
  zoomHudText: { color: '#fff', fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },

  countdownWrap: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  countdownText: {
    color: '#fff', fontSize: 110, fontWeight: '800', fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 12,
  },
  countdownHint: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600', marginTop: SPACING.sm },

  recBarTrack: {
    position: 'absolute', left: SPACING.md, right: SPACING.md, height: 3,
    borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden',
  },
  recBarFill: { height: 3, borderRadius: 1.5, backgroundColor: colors.error },

  recPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: SPACING.sm + 2, marginTop: 2,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.error },
  recText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },

  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: SPACING.sm + 2 },

  lensRow: {
    flexDirection: 'row', gap: 6, backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: RADIUS.full, padding: 4,
  },
  lensBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  lensBtnActive: { backgroundColor: 'rgba(255,255,255,0.22)' },
  lensText: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '700' },
  lensTextActive: { color: colors.primaryLight, fontSize: 13, fontWeight: '800' },

  modeRow: {
    flexDirection: 'row', gap: 4, backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: RADIUS.full, padding: 4,
  },
  modePill: { paddingHorizontal: SPACING.md, paddingVertical: 6, borderRadius: RADIUS.full },
  modePillActive: { backgroundColor: 'rgba(255,255,255,0.18)' },
  modeText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '800', letterSpacing: 1.4 },
  modeTextActive: { color: colors.primaryLight },

  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingHorizontal: SPACING.xl },
  galleryBtn: {
    width: 48, height: 48, alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, overflow: 'hidden',
  },
  galleryThumb: {
    width: 40, height: 40, borderRadius: 10,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)',
  },

  shutterOuter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterOuterRec: { borderColor: colors.error },
  shutterInner: {
    width: SHUTTER - 16, height: SHUTTER - 16, borderRadius: (SHUTTER - 16) / 2,
    backgroundColor: '#fff',
  },
  shutterInnerVideo: { backgroundColor: colors.error },
  shutterInnerRecording: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.error },

  holdHint: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '600', letterSpacing: 0.4 },

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
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.md,
  },
  shareBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

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
