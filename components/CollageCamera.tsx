import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, ActivityIndicator, Linking, Animated, Easing,
} from 'react-native';
import { CameraView, type CameraType, useCameraPermissions } from 'expo-camera';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useCameraTurn } from '../lib/cameraTurn';
import { COLLAGE_LAYOUTS, getCollageLayout } from '../lib/storyLayouts';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { selection } from '../lib/haptics';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const GAP = 2;
// Size of each layout-picker preview tile (a mini 9:16 frame) + the even gap around its
// cells, so the cells sit symmetrically inside the tile (not offset to one side).
const PICK_W = 36;
const PICK_H = 50;
const CELL_GAP = 2.5;

export type CollageResult = { layout: string; slots: string[] };

// The TikTok-style photo-collage builder: pick a grid layout, then fill each slot by
// shooting with the LIVE camera in the active slot (the shutter fills it + advances) or
// picking from the gallery. When every slot is filled, the whole grid goes to the story
// editor as one "collage" background you can add stickers/text/music over.
export default function CollageCamera({
  onClose, onComplete, initialLayout = 'grid4',
}: {
  onClose: () => void;
  onComplete: (result: CollageResult) => void;
  initialLayout?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hasTurn = useCameraTurn();
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [layoutId, setLayoutId] = useState(initialLayout);
  const def = getCollageLayout(layoutId) ?? COLLAGE_LAYOUTS[0];
  const slotCount = def.slots.length;
  const [slots, setSlots] = useState<(string | null)[]>(() => Array(slotCount).fill(null));
  const [activeIndex, setActiveIndex] = useState(0);
  const [facing, setFacing] = useState<CameraType>('back');
  // Open the layout strip straight away so the first thing you do is pick a grid; it
  // collapses once you choose one (chooseLayout), and the button reopens it.
  const [pickerOpen, setPickerOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  // The layout strip slides in from the right edge + fades, instead of popping.
  const pickerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(pickerAnim, {
      toValue: pickerOpen ? 1 : 0,
      duration: pickerOpen ? 220 : 150,
      easing: pickerOpen ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [pickerOpen, pickerAnim]);

  const allFilled = slots.length === slotCount && slots.every((s) => !!s);
  const granted = !!camPermission?.granted;

  // Switch layout → start its slots fresh (a different count), active on the first slot.
  const chooseLayout = useCallback((id: string) => {
    const d = getCollageLayout(id);
    if (!d) return;
    selection();
    setLayoutId(id);
    setSlots(Array(d.slots.length).fill(null));
    setActiveIndex(0);
    setPickerOpen(false);
  }, []);

  // After filling a slot, jump the live camera to the next still-empty slot (if any).
  const advance = useCallback((filled: (string | null)[], from: number) => {
    const next = filled.findIndex((s, i) => i !== from && !s);
    if (next >= 0) setActiveIndex(next);
  }, []);

  const fillSlot = useCallback((index: number, uri: string) => {
    setSlots((prev) => {
      const next = prev.slice();
      next[index] = uri;
      advance(next, index);
      return next;
    });
  }, [advance]);

  const shoot = useCallback(async () => {
    if (busy || !granted || !hasTurn) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) fillSlot(activeIndex, photo.uri);
    } catch { /* capture failed — leave the slot empty */ }
    setBusy(false);
  }, [busy, granted, hasTurn, activeIndex, fillSlot]);

  const pickFromGallery = useCallback(async (index: number) => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.9 });
      if (res.canceled || !res.assets?.length) return;
      fillSlot(index, res.assets[0].uri);
    } catch { /* picker unavailable */ }
  }, [fillSlot]);

  const clearSlot = useCallback((index: number) => {
    setSlots((prev) => { const next = prev.slice(); next[index] = null; return next; });
    setActiveIndex(index);
  }, []);

  // Pixel rects for the current layout's slots, filling the whole screen.
  const rects = useMemo(() => def.slots.map((r) => ({
    left: r.x * SCREEN_W + GAP / 2,
    top: r.y * SCREEN_H + GAP / 2,
    width: r.w * SCREEN_W - GAP,
    height: r.h * SCREEN_H - GAP,
  })), [def]);

  return (
    <View style={styles.container}>
      {/* The ONE live CameraView, positioned at the active (empty) slot — mounted once and
          just repositioned when you aim at another slot, so the camera never re-binds on a
          tap (which would flash/stall, especially on Android). */}
      {granted && hasTurn && !slots[activeIndex] && (
        <View style={[styles.slot, rects[activeIndex]]} pointerEvents="none">
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode="picture"
            mirror={facing === 'front'}
            animateShutter={false}
            active
          />
        </View>
      )}

      {/* Slot overlays: filled → photo; the active empty slot is transparent so the camera
          shows through from behind; other empty slots are dark. Controls sit on top. Tap
          an empty slot to aim the camera there. */}
      {def.slots.map((_, i) => {
        const r = rects[i];
        const uri = slots[i];
        const isActive = i === activeIndex;
        return (
          <View key={i} style={[styles.slotOverlay, r]}>
            {uri ? (
              <ExpoImage source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
            ) : !isActive ? (
              <View style={[StyleSheet.absoluteFill, styles.slotEmpty]} />
            ) : null}

            {!uri && !isActive && (
              <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={0.8} onPress={() => setActiveIndex(i)} />
            )}

            {/* Filled slot: a CENTERED "replace from library" button + a small clear. (An
                empty slot is shot with the shutter or the bottom gallery button.) */}
            {uri ? (
              <>
                <TouchableOpacity style={styles.slotReplace} onPress={() => pickFromGallery(i)} hitSlop={6} accessibilityLabel={t('a11y.chooseFromLibrary')}>
                  <Ionicons name="images" size={19} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.slotClear} onPress={() => clearSlot(i)} hitSlop={6} accessibilityLabel={t('a11y.close')}>
                  <Ionicons name="close" size={15} color="#fff" />
                </TouchableOpacity>
              </>
            ) : null}

            {isActive && !uri && <View style={styles.activeRing} pointerEvents="none" />}
          </View>
        );
      })}

      {/* Camera permission prompt (gallery still works without it). */}
      {!granted && (
        <View style={[styles.permBanner, { top: insets.top + 64 }]} pointerEvents="box-none">
          <Text style={styles.permText}>{t('storyCamera.camNeededTitle')}</Text>
          <TouchableOpacity
            style={styles.permBtn}
            onPress={() => (camPermission?.canAskAgain ? requestCamPermission() : Linking.openSettings())}
          >
            <Text style={styles.permBtnText}>{camPermission?.canAskAgain ? t('storyCamera.allowCamera') : t('permissions.openSettings')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Top-left: close. Top-right: flip + layout picker. */}
      <TouchableOpacity style={[styles.topBtn, { top: insets.top + 8, left: SPACING.md }]} onPress={onClose} hitSlop={10} accessibilityLabel={t('a11y.back')}>
        <Ionicons name="close" size={26} color="#fff" />
      </TouchableOpacity>
      <View style={[styles.topRight, { top: insets.top + 8 }]}>
        <TouchableOpacity style={styles.topBtnPlain} onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} hitSlop={10} accessibilityLabel={t('a11y.flipCamera')}>
          <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.topBtnPlain, pickerOpen && styles.topBtnActive]} onPress={() => setPickerOpen((o) => !o)} hitSlop={10} accessibilityLabel={t('storyCamera.layout')}>
          <Ionicons name="grid-outline" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Layout strip — slides in from the right edge, directly below the flip/layout
          buttons, so it reads as part of the same control column (not a floating pop-out).
          Mini-frame previews; the selected layout is outlined in white with brighter,
          slightly-enlarged cells. */}
      <Animated.View
        style={[styles.picker, {
          top: insets.top + 108,
          opacity: pickerAnim,
          transform: [{ translateX: pickerAnim.interpolate({ inputRange: [0, 1], outputRange: [44, 0] }) }],
        }]}
        pointerEvents={pickerOpen ? 'auto' : 'none'}
      >
        {COLLAGE_LAYOUTS.map((l) => {
          const sel = l.id === layoutId;
          return (
            <TouchableOpacity key={l.id} style={[styles.pickerTile, sel && styles.pickerTileSel]} onPress={() => chooseLayout(l.id)} activeOpacity={0.85}>
              {l.slots.map((r, i) => (
                <View
                  key={i}
                  style={{
                    position: 'absolute',
                    left: r.x * PICK_W + CELL_GAP, top: r.y * PICK_H + CELL_GAP,
                    width: r.w * PICK_W - CELL_GAP * 2, height: r.h * PICK_H - CELL_GAP * 2,
                    borderRadius: 3,
                    backgroundColor: sel ? '#fff' : 'rgba(255,255,255,0.45)',
                  }}
                />
              ))}
            </TouchableOpacity>
          );
        })}
      </Animated.View>

      {/* Bottom bar: gallery (active slot), shutter, and Next once everything's filled. */}
      <View style={[styles.bottom, { bottom: insets.bottom + SPACING.lg }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.galleryBtn} onPress={() => pickFromGallery(activeIndex)} accessibilityLabel={t('a11y.chooseFromLibrary')}>
          <Ionicons name="images" size={24} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.shutter} onPress={shoot} disabled={busy || !granted} activeOpacity={0.85} accessibilityLabel={t('storyCamera.takePhoto')}>
          <View style={styles.shutterInner}>{busy ? <ActivityIndicator color="#111" /> : null}</View>
        </TouchableOpacity>
        {allFilled ? (
          <TouchableOpacity style={styles.nextBtn} onPress={() => onComplete({ layout: layoutId, slots: slots.filter(Boolean) as string[] })} accessibilityLabel={t('common.done')}>
            <Ionicons name="arrow-forward" size={26} color="#111" />
          </TouchableOpacity>
        ) : (
          <View style={styles.galleryBtn} />
        )}
      </View>
    </View>
  );
}

const makeStyles = (_colors: ThemePalette) => StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  slot: { position: 'absolute', overflow: 'hidden', backgroundColor: '#141416' },
  slotOverlay: { position: 'absolute', overflow: 'hidden' },
  slotEmpty: { backgroundColor: '#141416' },
  activeRing: { ...StyleSheet.absoluteFillObject, borderWidth: 2.5, borderColor: '#fff' },
  // Centered on the slot (not a corner), semi-transparent so the photo shows through.
  slotReplace: {
    position: 'absolute', left: '50%', top: '50%', marginLeft: -21, marginTop: -21,
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.6)',
  },
  slotClear: {
    position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  topBtn: {
    position: 'absolute', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  topBtnPlain: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topBtnActive: { backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 22 },
  topRight: { position: 'absolute', right: SPACING.md, alignItems: 'center', gap: SPACING.sm },
  picker: {
    position: 'absolute', right: SPACING.md + 2, backgroundColor: 'rgba(20,20,22,0.94)',
    borderRadius: RADIUS.lg, paddingVertical: SPACING.sm, paddingHorizontal: 5, gap: SPACING.sm, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  // No border — a border shrinks the content box and the cells (positioned against the
  // full tile size) then sit off-centre inside it. A rounded bg + overflow:hidden gives
  // the framed look with the cells perfectly centred.
  pickerTile: {
    width: PICK_W, height: PICK_H, borderRadius: 8, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pickerTileSel: { backgroundColor: 'rgba(255,255,255,0.24)', transform: [{ scale: 1.06 }] },
  bottom: {
    position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingHorizontal: SPACING.xl,
  },
  galleryBtn: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  shutter: {
    width: 78, height: 78, borderRadius: 39, borderWidth: 5, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.2)',
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  nextBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  permBanner: { position: 'absolute', left: SPACING.lg, right: SPACING.lg, alignItems: 'center', gap: SPACING.sm },
  permText: { color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  permBtn: { backgroundColor: '#fff', borderRadius: RADIUS.full, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  permBtnText: { color: '#111', fontSize: 14, fontWeight: '800' },
});
