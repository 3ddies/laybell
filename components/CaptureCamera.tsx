import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Linking, Dimensions, Pressable,
  Platform, Animated, Easing, PanResponder,
} from 'react-native';
import {
  CameraView, CameraType, FlashMode,
  useCameraPermissions, useMicrophonePermissions,
} from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { pauseMainPlayer } from '../lib/trackPlayerService';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// The live camera — Laybell's one capture interface. Stories use it as the page LEFT
// of Home (app/(tabs)/story-camera); the post composer opens it from the camera tile
// (app/(tabs)/post), where a recording goes straight on to the video editor. Moved out
// of the story camera whole (owner, 2026-09-11: "a capturing interface identical to
// the story capturer"), so the two can never drift apart.
//
// A swipe never unmounts its CameraView — mounting and unmounting it on each swipe is
// what froze the app before — `active` pauses it instead. While the story editor shows
// a capture, `hidden` closes the camera (as it always has) but keeps its settings, so
// the lens, flash, timer and camera you chose are still set for a retake. `reset()`
// tears down anything in flight and returns to a clean viewfinder.

type Mode = 'picture' | 'video';
/** A photo carries its pixel size; a recording's comes from probing the file. */
export type CapturedMedia = {
  uri: string; type: 'image' | 'video'; durationSec?: number; processed?: boolean;
  width?: number; height?: number;
};
export type CaptureCameraHandle = { reset: () => void };

const HOLD_MS = 240;            // hold the photo shutter longer than this → record video
const { height: SCREEN_H } = Dimensions.get('window');
const SHUTTER = 78;

// ── One camera view at a time ─────────────────────────────────────────────────
// The story camera stays mounted on its page while the composer's opens over the
// tabs, and on Android two camera views break each other: `active` is iOS-only, a
// view binds through CameraX's process-wide unbindAll() and calls it again when it's
// destroyed, and a bound view never re-binds by itself (ExpoCameraView.kt) — so the
// story camera would sit black after the composer's closed. Only the newest open
// camera renders a CameraView; an older one keeps its place and settings over black
// and gets a fresh view once the newer one has closed — a beat later, so the old
// view's teardown has run before the next one binds.
const HANDOVER_MS = 150;
const openCameras: number[] = [];
const turnListeners = new Set<() => void>();
let lastCameraId = 0;
function subscribeTurns(listener: () => void) {
  turnListeners.add(listener);
  return () => { turnListeners.delete(listener); };
}
function useCameraTurn(): boolean {
  const [id] = useState(() => ++lastCameraId);
  useEffect(() => {
    openCameras.push(id);
    turnListeners.forEach((listener) => listener());
    return () => {
      const i = openCameras.indexOf(id);
      if (i >= 0) openCameras.splice(i, 1);
      turnListeners.forEach((listener) => listener());
    };
  }, [id]);
  const newest = useSyncExternalStore(subscribeTurns, () => openCameras[openCameras.length - 1] === id);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!newest) return;
    const timer = setTimeout(() => setSettled(true), HANDOVER_MS);
    return () => clearTimeout(timer);
  }, [newest]);
  return newest && settled; // losing the turn is immediate; getting it waits the beat
}

type Props = {
  /** Running: preview live, ready to shoot. Paused (still mounted) otherwise. */
  active: boolean;
  /**
   * Really in front. Permission prompts and the library preview wait for it — a story
   * swipe pre-activates the camera before the page has settled.
   */
  focused: boolean;
  /** Renders nothing — camera closed, settings kept — while a story's editor shows. */
  hidden?: boolean;
  /** The longest recording, in seconds. */
  maxVideoSec: number;
  onCapture: (media: CapturedMedia) => void;
  onClose: () => void;
  /** The library button, bottom left. */
  onLibrary: () => void;
  /** The way out of the camera-permission screen. */
  closeLabel: string;
};

const CaptureCamera = forwardRef<CaptureCameraHandle, Props>(function CaptureCamera({
  active, focused, hidden = false, maxVideoSec, onCapture, onClose, onLibrary, closeLabel,
}, ref) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const hasTurn = useCameraTurn();
  // Mic attaches ONLY while a recording is active/imminent (see
  // beginRecording): a live mic claims the iOS record audio session, which
  // force-pauses the main player's music and desyncs the lock-screen card.
  // Browsing the camera — and a story swipe's pre-activation — stays video-only,
  // so music keeps playing until the user actually records.
  const [micLive, setMicLive] = useState(false);
  const micLiveRef = useRef(false); micLiveRef.current = micLive;
  // The latest handler for a capture that lands after a re-render — and whether the
  // camera is still open to deliver it (the composer's can close mid-recording).
  const onCaptureRef = useRef(onCapture); onCaptureRef.current = onCapture;
  const mounted = useRef(true);

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
  const [timerMode, setTimerMode] = useState<0 | 3 | 10>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [afPulse, setAfPulse] = useState<'on' | 'off'>('off');   // tap-to-focus retrigger
  const afTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const focusAnim = useRef(new Animated.Value(0)).current;
  const [screenFlash, setScreenFlash] = useState(false);         // front-camera "flash"
  const [libThumb, setLibThumb] = useState<string | null>(null); // last library asset preview
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // tap-vs-hold decision timer
  const pressActiveRef = useRef(false);                           // finger is currently down on the shutter
  const photoHoldRef = useRef(false);                             // this recording came from holding in PHOTO mode (→ restore PHOTO on stop)

  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recSecsRef = useRef(0);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recProgress = useRef(new Animated.Value(0)).current;     // top progress bar (0→1 over the longest recording)
  // Shutter button animations (all JS-driven so colour + transform can share a
  // view): press feedback, photo↔video tint, and the idle→recording morph.
  const pressScale = useRef(new Animated.Value(1)).current;      // tactile press scale
  const modeAnim = useRef(new Animated.Value(0)).current;        // 0 photo · 1 video (inner colour)
  const recAnim = useRef(new Animated.Value(0)).current;         // 0 idle · 1 recording (ring + dot morph)

  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchBase = useRef({ dist: 0, zoom: 0 });
  const dragBase = useRef({ y: 0, zoom: 0 });
  const gestureMoved = useRef(false);
  const recordingRef = useRef(false); recordingRef.current = recording;
  const facingRef = useRef(facing); facingRef.current = facing;
  const countdownRef = useRef<number | null>(null); countdownRef.current = countdown;

  // Ask for camera (then mic) access the first time you actually open the
  // camera. Granting the mic up-front matters: requesting it mid-gesture (when
  // you first hold to record) pops a dialog that derails that first recording —
  // which is exactly why the very first hold used to fail.
  useEffect(() => {
    if (!focused) return;
    if (camPermission && !camPermission.granted && camPermission.canAskAgain) {
      requestCamPermission();
    } else if (camPermission?.granted && micPermission && !micPermission.granted && micPermission.canAskAgain) {
      requestMicPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, camPermission, micPermission]);

  // Animate the shutter between photo/video tint and idle/recording shape so the
  // button morphs smoothly instead of snapping between styles.
  useEffect(() => {
    Animated.timing(modeAnim, {
      toValue: mode === 'video' ? 1 : 0, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: false,
    }).start();
  }, [mode, modeAnim]);
  useEffect(() => {
    Animated.spring(recAnim, {
      toValue: recording ? 1 : 0, friction: 7, tension: 90, useNativeDriver: false,
    }).start();
  }, [recording, recAnim]);

  // Gallery button preview: the most recent library asset — only if the library
  // permission was already granted elsewhere (never prompts from here).
  useEffect(() => {
    if (!focused) return;
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
  }, [focused]);

  // iOS: discover the ultra-wide lens so we can offer a real 0.5x like the
  // native camera (not a digital crop).
  const probeLenses = useCallback(async () => {
    if (Platform.OS !== 'ios') return;
    try {
      const lenses = await cameraRef.current?.getAvailableLensesAsync?.();
      setHasUltraWide(!!lenses?.includes('builtInUltraWideCamera'));
    } catch {}
  }, []);

  // A clean live viewfinder again: timers cleared, any recording torn down, zoom and
  // torch off, back to PHOTO. Lens, flash, timer and camera are kept.
  const reset = useCallback(() => {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    if (countdownTimer.current) { clearInterval(countdownTimer.current); countdownTimer.current = null; }
    if (afTimer.current) { clearTimeout(afTimer.current); afTimer.current = null; }
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (recordingRef.current) cameraRef.current?.stopRecording();
    pressActiveRef.current = false;
    photoHoldRef.current = false;
    setRecording(false);
    setMicLive(false); // release the mic's session claim
    setRecSecs(0);
    recProgress.setValue(0);
    setCountdown(null);
    setMode('picture');
    setTorchOn(false);
    setZoom(0); zoomRef.current = 0;
  }, [recProgress]);
  useImperativeHandle(ref, () => ({ reset }), [reset]);

  // Closing the camera for good (the composer's) leaves nothing running, and drops a
  // recording that the close cut short instead of delivering it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recTimer.current) clearInterval(recTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
      if (afTimer.current) clearTimeout(afTimer.current);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (zoomHudTimer.current) clearTimeout(zoomHudTimer.current);
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
      if (recordingRef.current) cameraRef.current?.stopRecording();
    };
  }, []);

  // Hand what the shutter made to whoever opened the camera.
  function deliver(media: CapturedMedia) {
    if (!mounted.current) return;
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    setRecording(false);
    onCaptureRef.current(media);
  }

  async function toggleMode() {
    const next: Mode = mode === 'picture' ? 'video' : 'picture';
    if (next === 'video' && micPermission && !micPermission.granted && micPermission.canAskAgain) {
      await requestMicPermission();
    }
    setMode(next);
  }

  // Dedicated shutter responder. A PanResponder (not Pressable) so a hold ends
  // only on a true finger-lift; drifting off the button — or a parent pager/
  // viewfinder trying to grab the touch — can't cancel a recording mid-way
  // (that was the glitchy/unpredictable behaviour). It delegates to refs holding
  // the latest handlers so the once-created responder always sees current state.
  const shutterHandlers = useRef<{ down: () => void; move: (g: any) => void; up: () => void }>({
    down: () => {}, move: () => {}, up: () => {},
  });
  const shutterZoomBase = useRef(0);
  const shutterPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => shutterHandlers.current.down(),
      onPanResponderMove: (_e, g) => shutterHandlers.current.move(g),
      onPanResponderRelease: () => shutterHandlers.current.up(),
      onPanResponderTerminate: () => shutterHandlers.current.up(),
    }),
  ).current;

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
  // NOT claimed (the story page keeps the tab pager's swipe-to-Home); we take taps,
  // two-finger pinches, and — while recording — one-finger vertical drags
  // (slide-to-zoom).
  const viewfinderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (e, g) =>
        e.nativeEvent.touches.length >= 2 ||
        (recordingRef.current && Math.abs(g.dy) > Math.abs(g.dx) * 1.5 && Math.abs(g.dy) > 8),
      onPanResponderTerminationRequest: () => true,
      onPanResponderGrant: (e) => {
        const tt = e.nativeEvent.touches;
        gestureMoved.current = false;
        if (tt.length >= 2) {
          const dx = tt[1].pageX - tt[0].pageX, dy = tt[1].pageY - tt[0].pageY;
          pinchBase.current = { dist: Math.hypot(dx, dy), zoom: zoomRef.current };
        } else {
          dragBase.current = { y: tt[0]?.pageY ?? 0, zoom: zoomRef.current };
        }
      },
      onPanResponderMove: (e) => {
        const tt = e.nativeEvent.touches;
        if (tt.length >= 2) {
          if (pinchBase.current.dist === 0) {
            const dx = tt[1].pageX - tt[0].pageX, dy = tt[1].pageY - tt[0].pageY;
            pinchBase.current = { dist: Math.hypot(dx, dy), zoom: zoomRef.current };
            return;
          }
          const dx = tt[1].pageX - tt[0].pageX, dy = tt[1].pageY - tt[0].pageY;
          const ratio = Math.hypot(dx, dy) / pinchBase.current.dist;
          gestureMoved.current = true;
          applyZoom(pinchBase.current.zoom + (ratio - 1) * 0.6);
        } else if (recordingRef.current && tt.length === 1) {
          // Slide up to zoom while recording (one continuous motion, IG-style).
          const dy = (tt[0]?.pageY ?? 0) - dragBase.current.y;
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
      let size = { width: photo.width, height: photo.height };
      try {
        const out = await manipulateAsync(
          photo.uri,
          [{ resize: { width: 1920 } }],
          { compress: 0.9, format: SaveFormat.JPEG },
        );
        uri = out.uri;
        size = { width: out.width, height: out.height };
      } catch {}
      deliver({ uri, type: 'image', processed: true, ...size });
    } catch (e: any) {
      setScreenFlash(false);
      if (mounted.current) Alert.alert(t('storyCamera.photoFailTitle'), e?.message ?? t('post.tryAgain'));
    }
  }

  // The camera lives in video mode permanently (CameraView mode="video"), so the
  // video pipeline is always ready — recording starts instantly, no mode switch,
  // no retry. Photos still work because iOS keeps the photo output alive in video
  // mode. `photoHold` just remembers to flip the UI label back to PHOTO after a
  // hold-to-record that started from photo mode.
  async function beginRecording() {
    if (recordingRef.current || !cameraRef.current) return;
    recordingRef.current = true;
    // Recording owns audio: pause the song through the app's OWN player
    // BEFORE the mic claims the session — the in-app buttons and the iOS
    // card stay in sync (the OS interruption path left them disagreeing).
    pauseMainPlayer();
    if (micPermission?.granted && !micLiveRef.current) {
      setMicLive(true);
      // The native session needs a beat to attach the audio input —
      // recordAsync in the same tick races the reconfiguration and can
      // produce a soundless first recording.
      await new Promise((r) => setTimeout(r, 350));
    }
    setRecording(true);
    setRecSecs(0);
    recSecsRef.current = 0;
    recTimer.current = setInterval(() => { recSecsRef.current += 1; setRecSecs(recSecsRef.current); }, 1000);
    recProgress.setValue(0);
    Animated.timing(recProgress, {
      // Native-driven scaleX (same pattern as the story viewer's progress bar):
      // as a JS width% animation this ran a JS-thread layout pass continuously
      // for the entire recording, right while the camera loads the JS thread.
      toValue: 1, duration: maxVideoSec * 1000, easing: Easing.linear, useNativeDriver: true,
    }).start();
    cameraRef.current?.recordAsync({ maxDuration: maxVideoSec })
      .then((video) => {
        if (video?.uri) deliver({ uri: video.uri, type: 'video', durationSec: recSecsRef.current || undefined });
      })
      .catch((e: any) => {
        if (mounted.current) Alert.alert(t('storyCamera.videoFailTitle'), e?.message ?? t('post.tryAgain'));
      })
      .finally(() => {
        if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
        recProgress.stopAnimation();
        recProgress.setValue(0);
        recordingRef.current = false;
        setRecording(false);
        if (photoHoldRef.current) { photoHoldRef.current = false; setMode('picture'); }
      });
  }

  function endRecording() {
    cameraRef.current?.stopRecording();   // safe no-op if nothing is recording
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

  function animatePress(down: boolean) {
    Animated.spring(pressScale, {
      toValue: down ? 0.9 : 1, friction: 6, tension: 160, useNativeDriver: true,
    }).start();
  }

  // One shutter, three intents: tap = photo, hold = video, tap-while-recording =
  // stop. A PanResponder (see shutterPan) so the gesture only ends on a real
  // finger-lift — drift or a parent grab can't cancel a hold mid-recording.
  function onShutterDown() {
    animatePress(true);
    if (recordingRef.current || countdown != null || !cameraRef.current) return;
    pressActiveRef.current = true;
    shutterZoomBase.current = zoomRef.current;
    if (mode !== 'picture') return;          // VIDEO mode records on release (tap)
    // Arm the hold→video timer. Releasing before it fires is a photo tap.
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      if (!pressActiveRef.current) return;             // already released → it was a tap
      animatePress(false);                              // hand the button to the recording UI
      photoHoldRef.current = true;                      // restore PHOTO label when it stops
      setMode('video');                                 // UI label only (camera is already video)
      beginRecording();                                 // instant — pipeline is always ready
    }, HOLD_MS);
  }
  // Slide up while holding to zoom in, once recording is live (IG-style). The
  // threshold ignores the small finger jitter of just holding still.
  function onShutterMove(g: { dy: number }) {
    if (!recordingRef.current || Math.abs(g.dy) < 12) return;
    applyZoom(shutterZoomBase.current - (g.dy + (g.dy < 0 ? 12 : -12)) / 600);
  }
  function onShutterUp() {
    animatePress(false);
    const wasActive = pressActiveRef.current;
    pressActiveRef.current = false;
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }

    if (countdown != null) { cancelCountdown(); return; }   // any tap cancels the self-timer
    if (recordingRef.current) { endRecording(); return; }   // recording (hold or video-tap) → stop
    if (!wasActive) return;                                 // not our press

    // A quick release with nothing recording → it's a TAP.
    if (mode === 'video') {
      timerMode > 0 ? startCountdown(beginRecording) : beginRecording();
    } else {
      timerMode > 0 ? startCountdown(takePhoto) : takePhoto();
    }
  }
  shutterHandlers.current.down = onShutterDown;
  shutterHandlers.current.move = onShutterMove;
  shutterHandlers.current.up = onShutterUp;

  // Stable (memoized) interpolations so the 1s timer re-render during recording
  // doesn't rebuild the animated styles and cause flicker.
  const shutterStyle = useMemo(() => ({
    ringBorder: recAnim.interpolate({ inputRange: [0, 1], outputRange: ['#FFFFFF', colors.error] }),
    ringScale: recAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }),
    dotSize: recAnim.interpolate({ inputRange: [0, 1], outputRange: [SHUTTER - 16, 28], extrapolate: 'clamp' }),
    dotRadius: recAnim.interpolate({ inputRange: [0, 1], outputRange: [(SHUTTER - 16) / 2, 9], extrapolate: 'clamp' }),
    dotColor: modeAnim.interpolate({ inputRange: [0, 1], outputRange: ['#FFFFFF', colors.error] }),
    controlsFade: recAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
  }), [recAnim, modeAnim, colors.error]);

  if (hidden) return null;

  // ─── Permission gate ─────────────────────────────────────────────────────
  if (camPermission && !camPermission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Ionicons name="camera-outline" size={48} color={colors.textTertiary} />
        <Text style={styles.permTitle}>{t('storyCamera.camNeededTitle')}</Text>
        <Text style={styles.permSub}>{t('storyCamera.camNeededBody')}</Text>
        <TouchableOpacity
          style={styles.permBtn}
          onPress={() => (camPermission.canAskAgain ? requestCamPermission() : Linking.openSettings())}
        >
          <Text style={styles.permBtnText}>
            {camPermission.canAskAgain ? t('storyCamera.allowCamera') : t('permissions.openSettings')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.permClose} onPress={onClose}>
          <Text style={styles.permCloseText}>{closeLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Live capture ────────────────────────────────────────────────────────
  const zoomFactor = ultraWide ? 0.5 : 1 + zoom * 4; // display-only approximation
  return (
    <View style={styles.container}>
      {camPermission?.granted && hasTurn ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          flash={flash}
          enableTorch={facing === 'back' && torchOn && (mode === 'video' || recording)}
          // Permanent video mode: no photo↔video reconfiguration race. Photos
          // still work via takePictureAsync (iOS keeps the photo output alive).
          mode="video"
          zoom={zoom}
          // Output matches the mirrored selfie preview without a re-encode pass.
          mirror={facing === 'front'}
          autofocus={afPulse}
          animateShutter={false}
          // 1080p + stabilization: the sharpest clips that still upload
          // reliably (4K hits the storage size cap on long clips).
          videoQuality="1080p"
          videoStabilizationMode="auto"
          {...(Platform.OS === 'ios' && facing === 'back' && hasUltraWide
            ? { selectedLens: ultraWide ? 'builtInUltraWideCamera' : 'builtInWideAngleCamera' }
            : {})}
          // Mic engages only while recording (micLive, armed in
          // beginRecording). A muted CameraView never touches the audio
          // session, so neither swipe pre-activation nor browsing the camera
          // can interrupt the main player's music.
          mute={!micPermission?.granted || !micLive}
          active={active}
          onCameraReady={probeLenses}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
      )}

      {/* Gesture surface: pinch zoom, tap focus, double-tap flip, record-zoom */}
      <View style={StyleSheet.absoluteFill} {...viewfinderPan.panHandlers} />

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

      {/* Recording progress, to the longest recording, along the very top */}
      {recording && (
        <View style={[styles.recBarTrack, { top: insets.top + 4 }]}>
          <Animated.View
            style={[styles.recBarFill, { transform: [{ scaleX: recProgress }] }]}
          />
        </View>
      )}

      {/* Top controls */}
      <View style={[styles.topRow, { top: insets.top + 12 }]}>
        {!recording ? (
          <TouchableOpacity style={styles.roundBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
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
                if (mode === 'video') setTorchOn((on) => !on);
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
            <TouchableOpacity style={styles.roundBtn} onPress={() => setTimerMode((m) => (m === 0 ? 3 : m === 3 ? 10 : 0))}>
              {timerMode === 0 ? (
                <Ionicons name="timer-outline" size={22} color="#fff" />
              ) : (
                <Text style={styles.timerBadge}>{timerMode}s</Text>
              )}
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
          <Text style={styles.countdownHint}>{t('storyCamera.tapToCancel')}</Text>
        </Pressable>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + SPACING.md }]}>
        {/* iOS lens presets (real ultra-wide, not a digital crop). Kept mounted
            and faded during recording so the controls don't pop in/out. */}
        {hasUltraWide && facing === 'back' && (
          <Animated.View style={[styles.lensRow, { opacity: shutterStyle.controlsFade }]} pointerEvents={recording ? 'none' : 'auto'}>
            {([true, false] as const).map((uw) => (
              <TouchableOpacity
                key={String(uw)}
                style={[styles.lensBtn, ultraWide === uw && styles.lensBtnActive]}
                onPress={() => { setUltraWide(uw); applyZoom(0); }}
              >
                <Text style={[styles.lensText, ultraWide === uw && styles.lensTextActive]}>{uw ? '.5' : '1×'}</Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}

        <Animated.View style={[styles.modeRow, { opacity: shutterStyle.controlsFade }]} pointerEvents={recording ? 'none' : 'auto'}>
          {(['picture', 'video'] as Mode[]).map((m) => (
            <TouchableOpacity key={m} onPress={() => m !== mode && toggleMode()} style={[styles.modePill, mode === m && styles.modePillActive]}>
              <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
                {m === 'picture' ? t('storyCamera.modePhoto') : t('storyCamera.modeVideo')}
              </Text>
            </TouchableOpacity>
          ))}
        </Animated.View>

        <View style={styles.shutterRow}>
          {/* Faded out (not unmounted) while recording so it doesn't pop. */}
          <Animated.View style={{ opacity: shutterStyle.controlsFade }} pointerEvents={recording ? 'none' : 'auto'}>
            <TouchableOpacity style={styles.galleryBtn} onPress={onLibrary} accessibilityRole="button" accessibilityLabel={t('a11y.chooseFromLibrary')}>
              {libThumb ? (
                <ExpoImage source={{ uri: libThumb }} style={styles.galleryThumb} contentFit="cover" />
              ) : (
                <Ionicons name="images-outline" size={26} color="#fff" />
              )}
            </TouchableOpacity>
          </Animated.View>

          <Animated.View {...shutterPan.panHandlers} style={styles.shutterHit}>
            <Animated.View style={{ transform: [{ scale: pressScale }] }}>
              <Animated.View
                style={[styles.shutterOuter, {
                  borderColor: shutterStyle.ringBorder,
                  transform: [{ scale: shutterStyle.ringScale }],
                }]}
              >
                <Animated.View
                  style={{
                    width: shutterStyle.dotSize,
                    height: shutterStyle.dotSize,
                    borderRadius: shutterStyle.dotRadius,
                    backgroundColor: shutterStyle.dotColor,
                  }}
                />
              </Animated.View>
            </Animated.View>
          </Animated.View>

          <Animated.View style={{ opacity: shutterStyle.controlsFade }} pointerEvents={recording ? 'none' : 'auto'}>
            <TouchableOpacity style={styles.galleryBtn} onPress={flipCamera} accessibilityRole="button" accessibilityLabel={t('a11y.flipCamera')}>
              <Ionicons name="camera-reverse-outline" size={28} color="#fff" />
            </TouchableOpacity>
          </Animated.View>
        </View>

        {/* Fixed-height row: the label changes but the height never does, so the
            shutter above it stays put instead of jumping as mode/recording flip. */}
        <View style={styles.hintRow}>
          <Text style={styles.holdHint}>
            {recording ? t('storyCamera.slideToZoom') : mode === 'picture' ? t('storyCamera.holdForVideo') : t('storyCamera.tapToRecord')}
          </Text>
        </View>
      </View>
    </View>
  );
});

export default CaptureCamera;

function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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
  // Full-width + left-anchored: the native scaleX drive reveals it exactly like
  // the old width% animation (track's overflow:hidden clips the ends).
  recBarFill: { width: '100%', height: 3, borderRadius: 1.5, backgroundColor: colors.error, transformOrigin: 'left' },

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
  // Literal white, not a theme colour: the camera is a full-screen viewfinder
  // with its own dark chrome, so every control here is white-on-video and reads
  // the same in light and dark mode. The selected pill already carries a lighter
  // background, so full-white vs the 60% inactive label is contrast enough.
  modeTextActive: { color: '#fff' },

  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingHorizontal: SPACING.xl },
  galleryBtn: {
    width: 48, height: 48, alignItems: 'center', justifyContent: 'center',
    borderRadius: 12, overflow: 'hidden',
  },
  galleryThumb: {
    width: 40, height: 40, borderRadius: 10,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)',
  },

  // Wraps the 78px ring at its natural size (hitSlop extends the touch area
  // without changing layout, so the row keeps its original height).
  shutterHit: { alignItems: 'center', justifyContent: 'center' },
  shutterOuter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },

  hintRow: { height: 16, justifyContent: 'center' },
  holdHint: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '600', letterSpacing: 0.4 },
});
