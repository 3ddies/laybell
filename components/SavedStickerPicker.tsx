import { useCallback, useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, ScrollView, Alert, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { getSavedStickers, deleteSavedSticker, type SavedSticker } from '../lib/stickers';

// The tray of cutout stickers the user has lifted from photos (Threads-style). Opened from
// the story composer's sticker sheet. Tap one to drop it onto the story; long-press to
// remove it. Empty until the user presses and holds a photo in their feed to make one.

export default function SavedStickerPicker({
  visible, onClose, onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (uri: string) => void;
}) {
  const [items, setItems] = useState<SavedSticker[]>([]);

  const load = useCallback(() => { getSavedStickers().then(setItems); }, []);
  useEffect(() => { if (visible) load(); }, [visible, load]);

  const confirmDelete = useCallback((s: SavedSticker) => {
    Alert.alert('Remove sticker?', 'This deletes it from your saved stickers.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { await deleteSavedSticker(s.id); load(); } },
    ]);
  }, [load]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          <View style={styles.handle} />
          <Text style={styles.title}>Your stickers</Text>

          {items.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="color-wand-outline" size={34} color="rgba(255,255,255,0.6)" />
              <Text style={styles.emptyText}>No stickers yet</Text>
              <Text style={styles.emptyHint}>Press and hold a photo in your feed to cut out a subject and save it here.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
              {items.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.tile}
                  activeOpacity={0.85}
                  onPress={() => { onPick(s.uri); onClose(); }}
                  onLongPress={() => confirmDelete(s)}
                  delayLongPress={300}
                >
                  <Image source={{ uri: s.uri }} style={styles.tileImg} contentFit="contain" transition={100} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const { width: SCREEN_W } = Dimensions.get('window');
const GAP = 10;
const COLS = 4;
const TILE = Math.floor((Math.min(SCREEN_W, 520) - 32 - GAP * (COLS - 1)) / COLS);

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#17171b', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28, maxHeight: '72%' },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 10 },
  title: { color: '#fff', fontSize: 16, fontWeight: '800', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingBottom: 8 },
  tile: { width: TILE, height: TILE, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tileImg: { width: '86%', height: '86%' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 24 },
  emptyText: { color: 'rgba(255,255,255,0.9)', fontSize: 15, fontWeight: '700' },
  emptyHint: { color: 'rgba(255,255,255,0.55)', fontSize: 13, textAlign: 'center', lineHeight: 18 },
});
