import { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, Linking, Animated, Easing } from 'react-native';
import { CameraView, type CameraType, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { useCameraTurn } from '../lib/cameraTurn';
import StoryBoomerang from './StoryBoomerang';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const FRAME_COUNT = 16;

export type BoomerangResult = { frames: string[] };

// The boomerang capturer: one tap grabs a quick burst of frames from the live camera (the
// screen flashes on each frame; tapping again cuts the burst short), then previews them
// looping forward-then-back. Its own CameraView, coordinated with the main camera by the
// shared camera-turn.
export default function BoomerangCamera({ onClose, onComplete }: {
  onClose: () => void;
  onComplete: (result: BoomerangResult) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hasTurn = useCameraTurn();
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [facing, setFacing] = useState<CameraType>('back');
  const [frames, setFrames] = useState<string[] | null>(null);
  const [capturing, setCapturing] = useState(false);
  const cancelRef = useRef(false); // a 2nd tap stops the burst after the current frame
  const granted = !!camPermission?.granted;

  // A brief, soft white flash marks each captured frame (kept subtle — a strobe at the
  // capture frame rate would be harsh/photosensitive).
  const flashAnim = useRef(new Animated.Value(0)).current;
  const flash = useCallback(() => {
    flashAnim.setValue(0.4);
    Animated.timing(flashAnim, { toValue: 0, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [flashAnim]);

  const captureBurst = useCallback(async () => {
    if (!granted || !hasTurn) return;
    setCapturing(true);
    cancelRef.current = false;
    const out: string[] = [];
    try {
      for (let i = 0; i < FRAME_COUNT; i++) {
        if (cancelRef.current) break;
        const p = await cameraRef.current?.takePictureAsync({ quality: 0.5, skipProcessing: true });
        if (p?.uri) { out.push(p.uri); flash(); }
      }
    } catch { /* capture failed mid-burst — keep whatever we got */ }
    // The last frame's flash animates to 0 with the native driver, but we switch to the
    // preview before that commits back to JS — leaving the overlay stuck semi-opaque (a
    // white tint when we return to capture). Force it clear.
    flashAnim.stopAnimation(); flashAnim.setValue(0);
    setCapturing(false);
    if (out.length >= 2) setFrames(out);
  }, [granted, hasTurn, flash, flashAnim]);

  // Start a burst, or (while one is running) cut it short.
  const onShutter = useCallback(() => {
    if (capturing) cancelRef.current = true;
    else captureBurst();
  }, [capturing, captureBurst]);

  const retake = useCallback(() => { flashAnim.stopAnimation(); flashAnim.setValue(0); setFrames(null); }, [flashAnim]);

  // ── Preview (after the burst) ──────────────────────────────────────────────
  if (frames) {
    return (
      <View style={styles.container}>
        <StoryBoomerang frames={frames} frameW={SCREEN_W} frameH={SCREEN_H} active />
        <TouchableOpacity style={[styles.topBtn, { top: insets.top + 8, left: SPACING.md }]} onPress={retake} hitSlop={10} accessibilityLabel={t('a11y.back')}>
          <Feather name="x" size={26} color="#fff" style={styles.glyph} />
        </TouchableOpacity>
        <View style={[styles.bottom, { bottom: insets.bottom + SPACING.lg }]} pointerEvents="box-none">
          <TouchableOpacity style={styles.retakeBtn} onPress={retake}>
            <Text style={styles.retakeText}>{t('storyCamera.retake')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.nextBtn} onPress={() => onComplete({ frames })} accessibilityLabel={t('common.done')}>
            <Feather name="arrow-right" size={26} color="#111" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Capture ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {granted && hasTurn ? (
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} mode="picture" mirror={facing === 'front'} animateShutter={false} active />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
      )}

      {/* Per-frame flash. Above the camera, below the controls (pointerEvents none). */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flashAnim }]} />

      {!granted && (
        <View style={[styles.permBanner, { top: insets.top + 80 }]}>
          <Text style={styles.permText}>{t('storyCamera.camNeededTitle')}</Text>
          <TouchableOpacity style={styles.permBtn} onPress={() => (camPermission?.canAskAgain ? requestCamPermission() : Linking.openSettings())}>
            <Text style={styles.permBtnText}>{camPermission?.canAskAgain ? t('storyCamera.allowCamera') : t('permissions.openSettings')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Boomerang badge. */}
      <View style={[styles.badge, { top: insets.top + 12 }]} pointerEvents="none">
        <MaterialCommunityIcons name="infinity" size={17} color="#fff" />
        <Text style={styles.badgeText}>{t('storyCamera.boomerang')}</Text>
      </View>

      <TouchableOpacity style={[styles.topBtn, { top: insets.top + 8, left: SPACING.md }]} onPress={onClose} hitSlop={10} accessibilityLabel={t('a11y.close')}>
        <Feather name="x" size={26} color="#fff" style={styles.glyph} />
      </TouchableOpacity>
      <TouchableOpacity style={[styles.topBtn, { top: insets.top + 8, right: SPACING.md }]} onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} hitSlop={10} accessibilityLabel={t('a11y.flipCamera')}>
        <Ionicons name="camera-reverse-outline" size={26} color="#fff" style={styles.glyph} />
      </TouchableOpacity>

      <View style={[styles.bottom, { bottom: insets.bottom + SPACING.lg }]} pointerEvents="box-none">
        <View style={styles.sideSpacer} />
        {/* Ring + dot (iPhone-style). While capturing the dot becomes a rounded square
            (iOS "recording" look); tap again to cut short. */}
        <TouchableOpacity style={styles.shutter} onPress={onShutter} disabled={!granted} activeOpacity={0.85} accessibilityLabel={t('storyCamera.boomerang')}>
          <View style={capturing ? styles.shutterStop : styles.shutterDot} />
        </TouchableOpacity>
        <View style={styles.sideSpacer} />
      </View>
    </View>
  );
}

const makeStyles = (_colors: ThemePalette) => StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  glyph: { textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 5 },
  topBtn: { position: 'absolute', width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.md, paddingVertical: 5,
  },
  badgeText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  bottom: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.xl },
  sideSpacer: { width: 54, height: 54 },
  // iPhone-style capture button: a white ring outline with a white dot inside + a thin gap.
  shutter: { width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterDot: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  // iOS "recording" look while capturing — a smaller rounded square (no spinner).
  shutterStop: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#fff' },
  retakeBtn: { backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm + 2 },
  retakeText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  nextBtn: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  permBanner: { position: 'absolute', left: SPACING.lg, right: SPACING.lg, alignItems: 'center', gap: SPACING.sm },
  permText: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  permBtn: { backgroundColor: '#fff', borderRadius: RADIUS.full, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  permBtnText: { color: '#111', fontSize: 14, fontWeight: '800' },
});
