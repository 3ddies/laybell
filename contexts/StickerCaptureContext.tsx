import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, TouchableOpacity, StyleSheet, ActivityIndicator, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import { liftPreview, saveLiftedSticker, stickerLiftAvailable } from '../lib/stickers';
import type { LiftPoint } from '../modules/laybell-subject-lift';

// Press-and-hold any image → lift its subject into a sticker (Threads-style). This host is
// mounted once app-wide; `useStickerCapture().capture(uri)` opens it over whatever's on
// screen. It lifts to a temp preview first, then the user keeps or discards it. All
// on-device — nothing leaves the phone until a saved sticker is placed in a post.

type Phase = 'lifting' | 'preview' | 'none' | 'saved';

type Ctx = { capture: (sourceUri: string, point?: LiftPoint) => void; available: boolean };
const StickerCaptureCtx = createContext<Ctx>({ capture: () => {}, available: false });
export const useStickerCapture = () => useContext(StickerCaptureCtx);

const { width: SCREEN_W } = Dimensions.get('window');

export function StickerCaptureProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('lifting');
  const [preview, setPreview] = useState<string | null>(null);
  const reqRef = useRef(0);

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
    setPreview(null);
    setPhase('lifting');
    setOpen(true);
    liftPreview(sourceUri, point).then((out) => {
      if (req !== reqRef.current) { discardTemp(out); return; } // superseded by a newer press
      if (out) { setPreview(out); setPhase('preview'); }
      else { setPhase('none'); setTimeout(() => { if (req === reqRef.current) close(); }, 1300); }
    });
  }, [close, discardTemp]);

  const onSave = useCallback(async () => {
    if (!preview) return;
    const temp = preview;
    const saved = await saveLiftedSticker(temp);
    discardTemp(temp);
    if (saved) {
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

  return (
    <StickerCaptureCtx.Provider value={value}>
      {children}
      <Modal visible={open} transparent animationType="fade" onRequestClose={onCancel}>
        <Pressable style={styles.backdrop} onPress={phase === 'preview' ? undefined : onCancel}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            {phase === 'lifting' && (
              <View style={styles.center}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.msg}>Lifting subject…</Text>
              </View>
            )}

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
        </Pressable>
      </Modal>
    </StickerCaptureCtx.Provider>
  );
}

const CARD = Math.min(SCREEN_W - 48, 360);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  sheet: { width: CARD, borderRadius: 22, backgroundColor: '#1b1b20', padding: 18, alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 28 },
  msg: { color: 'rgba(255,255,255,0.9)', fontSize: 15, fontWeight: '600' },
  title: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: -0.2, marginBottom: 14 },
  previewBox: {
    width: CARD - 36, height: CARD - 36, borderRadius: 16, backgroundColor: '#6a6a70',
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
