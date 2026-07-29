import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ScrollView,
  Dimensions, Platform, KeyboardAvoidingView, Pressable, Keyboard,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '../contexts/LanguageContext';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type CaptionStyle, type Sticker, type StickerBg, type StickerFont,
} from './StickerLayer';

// Story-style caption editor for VERTICAL reels: the exact sticker mechanism
// stories use — tap open video to ADD a caption, tap a caption to edit it,
// drag to move, pinch to resize/rotate, drop on the trash to delete, and place
// as MANY as you like. Reuses the shared StickerLayer gesture engine so the
// feel is identical to stories. Placement is clamped to the safe band so a
// caption can never sit under the reel's own controls (back button up top; the
// meta block, action rail and scrub bar down low).

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// Matches captionZone('screen', …) in TopCaption.ts — the reel UI reserve.
const SAFE_TOP = 74;
const SAFE_BOTTOM = SCREEN_H - 240;

// Background cycle now includes 'boxy' (the TikTok per-line pill look).
const BG_ORDER: StickerBg[] = ['none', 'soft', 'pill', 'boxy'];

export default function VideoStickerEditor({ visible, posterUri, initial, onSave, onClose }: {
  visible: boolean;
  posterUri: string | null;
  initial: Sticker[];
  onSave: (stickers: Sticker[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [stickers, setStickers] = useState<Sticker[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [overTrash, setOverTrash] = useState(false);
  // The style the NEXT new caption inherits (last-used), and the live values
  // while the text overlay is open.
  const [font, setFont] = useState<StickerFont>('classic');
  const [color, setColor] = useState<string>('#FFFFFF');
  const [bg, setBg] = useState<StickerBg>('boxy');
  const [text, setText] = useState('');
  const idRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    setStickers(initial);
    setEditingId(null);
    setText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const clampY = (y: number) => Math.min(SAFE_BOTTOM / SCREEN_H, Math.max(SAFE_TOP / SCREEN_H, y));

  function addStickerAt(xNorm: number, yNorm: number) {
    const id = `vc${idRef.current++}`;
    setStickers((prev) => [...prev, {
      id, text: '', x: Math.min(0.9, Math.max(0.1, xNorm)), y: clampY(yNorm),
      scale: 1, rotation: 0, font, color, bg, size: 26,
    }]);
    setEditingId(id);
    setText('');
  }

  function editSticker(id: string) {
    const s = stickers.find((k) => k.id === id);
    if (!s) return;
    setFont(s.font ?? 'classic');
    setColor(s.color ?? '#FFFFFF');
    setBg(s.bg ?? 'none');
    setText(s.text);
    setEditingId(id);
  }

  function manipulateSticker(id: string, style: CaptionStyle) {
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...style, y: clampY(style.y) } : s)));
  }

  // Text overlay committed → write style + text back; drop if left empty.
  function commitEditing() {
    setStickers((prev) => prev
      .map((s) => (s.id === editingId ? { ...s, text: text.trim(), font, color, bg } : s))
      .filter((s) => s.text !== ''));
    setEditingId(null);
    Keyboard.dismiss();
  }

  function onStickerRelease(id: string, xNorm: number, yNorm: number) {
    // Dropped on the trash → delete.
    if (inTrash(xNorm, yNorm)) setStickers((prev) => prev.filter((s) => s.id !== id));
  }

  function inTrash(xNorm: number, yNorm: number) {
    return yNorm > (SCREEN_H - insets.bottom - 130) / SCREEN_H && Math.abs(xNorm - 0.5) < 0.18;
  }

  function done() {
    onSave(stickers.filter((s) => s.text.trim()).map((s) => ({ ...s, text: s.text.trim() })));
  }

  const preview = resolveSticker({ font, color, bg, size: 26 });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {posterUri ? (
          <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.videoGhost]}>
            <Ionicons name="videocam-outline" size={34} color="rgba(255,255,255,0.3)" />
          </View>
        )}

        {/* Reserved-area ghosts so the safe band is tangible. */}
        <View style={[styles.reserveGhost, { top: 0, height: SAFE_TOP }]} pointerEvents="none" />
        <View style={styles.reelGhost} pointerEvents="none">
          <View style={styles.ghostMeta}>
            <View style={[styles.ghostLine, { width: 84, height: 11 }]} />
            <View style={[styles.ghostLine, { width: 190 }]} />
          </View>
          <View style={styles.ghostRail}>
            {[0, 1, 2, 3].map((i) => <View key={i} style={styles.ghostDot} />)}
          </View>
          <View style={styles.ghostScrub} />
        </View>

        {/* The story gesture engine — add / edit / move / pinch / delete. */}
        <StickerLayer
          stickers={stickers}
          frameW={SCREEN_W}
          frameH={SCREEN_H}
          editingId={editingId}
          onManipulate={manipulateSticker}
          onTapSticker={editSticker}
          onTapEmpty={addStickerAt}
          onDragActive={(a) => { setDragActive(a); if (!a) setOverTrash(false); }}
          onDragMove={(x, y) => { const over = inTrash(x, y); setOverTrash((p) => (p === over ? p : over)); }}
          onRelease={onStickerRelease}
        />

        {/* Trash target (only while dragging). */}
        {dragActive && (
          <View style={[styles.trashZone, { bottom: insets.bottom + 40 }]} pointerEvents="none">
            <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
              <Ionicons name="trash" size={22} color="#fff" />
            </View>
          </View>
        )}

        {/* Top bar (hidden while typing so the overlay owns the screen). */}
        {!editingId && (
          <>
            <View style={[styles.topBar, { top: insets.top + 8 }]}>
              <TouchableOpacity style={styles.barBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity style={styles.addBtn} onPress={() => addStickerAt(0.5, 0.3)}>
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.addText}>{t('topcap.textBtn')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={done}>
                <Text style={styles.saveText}>{t('topcap.save')}</Text>
              </TouchableOpacity>
            </View>
            {stickers.length === 0 && (
              <Text style={[styles.hint, { bottom: insets.bottom + 24 }]}>{t('topcap.tapHint')}</Text>
            )}
          </>
        )}

        {/* Text editing overlay (per caption). */}
        {editingId && (
          <KeyboardAvoidingView
            style={[StyleSheet.absoluteFill, styles.editScrim]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={commitEditing} />
            <View style={[styles.editDoneRow, { top: insets.top + 8 }]} pointerEvents="box-none">
              <TouchableOpacity style={styles.editDone} onPress={commitEditing} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={styles.editDoneText}>{t('storyCamera.done')}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.editCenter} pointerEvents="box-none">
              <View style={preview.boxStyle}>
                <TextInput
                  style={[preview.textStyle, styles.input]}
                  value={text}
                  onChangeText={setText}
                  placeholder={t('storyCamera.typeSomething')}
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  selectionColor="#FAB525"
                  cursorColor="#FAB525"
                  multiline
                  autoFocus
                  maxLength={200}
                  textAlign="center"
                />
              </View>
            </View>

            {/* Style toolbar — colors, then background toggle + font pills. */}
            <View style={[styles.styleBar, { bottom: insets.bottom + 10 }]}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatchRow} keyboardShouldPersistTaps="always">
                {STICKER_COLORS.map((c) => (
                  <TouchableOpacity key={c} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]} onPress={() => setColor(c)} />
                ))}
              </ScrollView>
              <View style={styles.fontRow}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.colour')}
                  style={[styles.bgToggle, bg !== 'none' && styles.bgToggleActive]}
                  onPress={() => setBg((b) => BG_ORDER[(BG_ORDER.indexOf(b) + 1) % BG_ORDER.length])}
                >
                  <Ionicons name="color-fill-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontPills} keyboardShouldPersistTaps="always">
                  {STICKER_FONTS.map((f) => (
                    <TouchableOpacity key={f.key} style={[styles.fontPill, font === f.key && styles.fontPillActive]} onPress={() => setFont(f.key)}>
                      <Text style={[styles.fontPillText, font === f.key && styles.fontPillTextActive]}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
          </KeyboardAvoidingView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  videoGhost: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#101010' },
  reserveGhost: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.18)' },
  reelGhost: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, opacity: 0.4 },
  ghostMeta: { position: 'absolute', left: 16, bottom: 58, gap: 9 },
  ghostLine: { height: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.3)' },
  ghostRail: { position: 'absolute', right: 14, bottom: 96, gap: 22, alignItems: 'center' },
  ghostDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.25)' },
  ghostScrub: { position: 'absolute', left: 0, right: 0, bottom: 12, height: 3, backgroundColor: 'rgba(255,255,255,0.28)' },
  topBar: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  barBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  addText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  saveBtn: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9 },
  saveText: { color: '#111', fontSize: 14, fontWeight: '800' },
  hint: { position: 'absolute', left: 24, right: 24, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  trashCircleHot: { backgroundColor: '#F43F5E', transform: [{ scale: 1.2 }] },
  editScrim: { backgroundColor: 'rgba(0,0,0,0.72)' },
  editDoneRow: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', justifyContent: 'flex-end' },
  editDone: { paddingHorizontal: 10, paddingVertical: 6 },
  editDoneText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  editCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  input: { minWidth: 60, maxWidth: SCREEN_W * 0.8 },
  styleBar: { position: 'absolute', left: 0, right: 0, gap: 12 },
  swatchRow: { paddingHorizontal: 16, gap: 10, alignItems: 'center' },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.15 }] },
  fontRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  bgToggle: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.15)' },
  bgToggleActive: { backgroundColor: 'rgba(255,255,255,0.32)' },
  fontPills: { gap: 8, alignItems: 'center', paddingRight: 12 },
  fontPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)' },
  fontPillActive: { backgroundColor: '#fff' },
  fontPillText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  fontPillTextActive: { color: '#111' },
});
