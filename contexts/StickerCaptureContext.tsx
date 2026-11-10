import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, TouchableOpacity, StyleSheet, Dimensions, Platform, Animated, Easing } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Image } from 'expo-image';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import { liftPreview, publishStickerToLibrary, saveLiftedSticker, stickerLiftAvailable } from '../lib/stickers';
import type { LiftPoint } from '../modules/laybell-subject-lift';

// Press-and-hold any image → lift its subject into a sticker (Threads-style). This host is
// mounted once app-wide; `useStickerCapture().capture(uri)` opens it over whatever's on
// screen. It lifts to a temp preview first, then the user keeps or discards it. All
// on-device — nothing leaves the phone until a saved sticker is placed in a post.

type Phase = 'preview' | 'none' | 'saved';

type Ctx = { capture: (sourceUri: string, point?: LiftPoint) => void; available: boolean };
const StickerCaptureCtx = createContext<Ctx>({ capture: () => {}, available: false });
export const useStickerCapture = () => useContext(StickerCaptureCtx);

const { width: SCREEN_W } = Dimensions.get('window');

export function StickerCaptureProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('preview');
  const [preview, setPreview] = useState<string | null>(null);
  const reqRef = useRef(0);
  // Fade the whole frosted overlay in/out. iOS uses a FullWindowOverlay (no built-in
  // transition), so `mounted` lags `open` — it stays true through the exit fade and
  // flips false once the fade finishes, so we don't unmount mid-animation.
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);

  const discardTemp = useCallback((uri: string | null) => {
    if (uri) { FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPreview(null);
  }, []);

  const capture = useCallback((sourceUri: string, point?: LiftPoint) => {
    if (!sourceUri || !stickerLiftAvailable()) return;
    const req = ++reqRef.current;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    // Lift in the background with NO loading UI — reveal the frosted overlay only once
    // the subject is ready, so it fades straight in to the finished sticker.
    liftPreview(sourceUri, point).then((out) => {
      if (req !== reqRef.current) { discardTemp(out); return; } // superseded by a newer press
      if (out) { setPreview(out); setPhase('preview'); setOpen(true); }
      else { setPreview(null); setPhase('none'); setOpen(true); setTimeout(() => { if (req === reqRef.current) close(); }, 1300); }
    });
  }, [close, discardTemp]);

  const onSave = useCallback(async () => {
    if (!preview) return;
    const temp = preview;
    const saved = await saveLiftedSticker(temp);
    discardTemp(temp);
    if (saved) {
      // Also publish a cloud copy into "My GIFs" so it's usable in comments/DMs.
      // Fire-and-forget: the local sticker is already saved, so the UI stays instant
      // and a failed upload just means it won't appear in the GIF picker.
      publishStickerToLibrary(saved.uri).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setPreview(null);
      setPhase('saved');
      setTimeout(() => close(), 1100);
    } else {
      close();
    }
  }, [preview, discardTemp, close]);

  const onCancel = useCallback(() => {
    discardTemp(preview);
    close();
  }, [preview, discardTemp, close]);

  const value = useMemo<Ctx>(() => ({ capture, available: stickerLiftAvailable() }), [capture]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.timing(anim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, anim]);

  // The lift overlay's contents — a dimmed backdrop (tap to cancel, except while
  // previewing) with the phase card centered.
  const body = (
    <View style={styles.backdrop}>
      {/* Frosted glass: blur the screen (e.g. the now-playing art) behind the card. */}
      <BlurView tint="dark" intensity={45} style={StyleSheet.absoluteFill} />
      <View style={styles.scrim} pointerEvents="none" />
      {/* Tap anywhere outside the card to cancel. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
      <Pressable style={styles.sheet} onPress={() => {}}>
        {phase === 'none' && (
          <View style={styles.center}>
            <Ionicons name="scan-outline" size={34} color="rgba(255,255,255,0.7)" />
            <Text style={styles.msg}>No clear subject found</Text>
          </View>
        )}

        {phase === 'saved' && (
          <View style={styles.center}>
            <Ionicons name="checkmark-circle" size={40} color="#3ad17a" />
            <Text style={styles.msg}>Saved to your stickers</Text>
          </View>
        )}

        {phase === 'preview' && preview && (
          <>
            <Text style={styles.title}>Make a sticker</Text>
            <View style={styles.previewBox}>
              <Image source={{ uri: preview }} style={styles.previewImg} contentFit="contain" transition={120} />
            </View>
            <View style={styles.actions}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onCancel}>
                <Text style={styles.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={onSave}>
                <Ionicons name="add" size={18} color="#000" />
                <Text style={styles.btnPrimaryText}>Save sticker</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </Pressable>
    </View>
  );

  return (
    <StickerCaptureCtx.Provider value={value}>
      {children}
      {/* The overlay must paint ABOVE the global player chrome. On iOS that chrome
          lives in its own FullWindowOverlay (a native window that sits over RN
          <Modal>s), so a plain Modal would land UNDER the now-playing sheet — we
          render into a FullWindowOverlay too, mounted after the app content so it
          stacks on top. Android keeps the Modal, which already sits above the
          plain-sibling chrome there. */}
      {Platform.OS === 'ios'
        ? (mounted ? (
            <FullWindowOverlay>
              <Animated.View style={[StyleSheet.absoluteFill, { opacity: anim }]}>{body}</Animated.View>
            </FullWindowOverlay>
          ) : null)
        : (
          <Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
            {body}
          </Modal>
        )}
    </StickerCaptureCtx.Provider>
  );
}

const CARD = Math.min(SCREEN_W - 48, 360);

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  // A light scrim over the blur so white text stays legible on bright artwork.
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)' },
  // Translucent card so the frosted screen shows through it (not a solid panel).
  sheet: {
    width: CARD, borderRadius: 22, backgroundColor: 'rgba(22,22,28,0.5)', padding: 18, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)', overflow: 'hidden',
  },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 28 },
  msg: { color: 'rgba(255,255,255,0.9)', fontSize: 15, fontWeight: '600' },
  title: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: -0.2, marginBottom: 14 },
  previewBox: {
    width: CARD - 36, height: CARD - 36, borderRadius: 16, backgroundColor: 'transparent',
    // Fully transparent instead of the old grey fill — the BlurView absoluteFill
    // child gives the cut-out a slight frosted blur, with no solid frame.
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  previewImg: { width: '92%', height: '92%' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16, alignSelf: 'stretch' },
  btn: { flex: 1, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  btnGhost: { backgroundColor: 'rgba(255,255,255,0.12)' },
  btnGhostText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnPrimary: { backgroundColor: '#fff' },
  btnPrimaryText: { color: '#000', fontSize: 15, fontWeight: '800' },
});
