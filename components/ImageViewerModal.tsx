import { StyleSheet, Modal, Pressable, TouchableOpacity, Platform, View, useWindowDimensions } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ImageViewerState } from '../lib/imageViewer';

// Full-screen image/GIF viewer. Tap anywhere (or the ✕) to close.
// `state.circle`: avatar mode — the image is shown in a large centered circle
// (matching the round profile picture it expanded from) instead of filling the
// screen. `inOverlay`: when shown from inside the iOS Now Playing
// FullWindowOverlay, a nested <Modal> deadlocks — so render into its own
// FullWindowOverlay instead (mirrors the report / block / GIF sheets).
export default function ImageViewerModal({ state, onClose, inOverlay }: { state: ImageViewerState; onClose: () => void; inOverlay?: boolean }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const url = state?.url ?? null;
  const circle = !!state?.circle;
  // A generous round frame that always fits the screen with margins.
  const diameter = Math.min(width, height) * 0.82;

  const content = (
    <Pressable style={styles.backdrop} onPress={onClose}>
      {url ? (
        circle ? (
          <View style={styles.center} pointerEvents="none">
            <Image
              source={{ uri: url }}
              style={{ width: diameter, height: diameter, borderRadius: diameter / 2 }}
              contentFit="cover"
              transition={120}
            />
          </View>
        ) : (
          <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="contain" transition={120} />
        )
      ) : null}
      <TouchableOpacity style={[styles.close, { top: insets.top + 8 }]} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Ionicons name="close" size={26} color="#fff" />
      </TouchableOpacity>
    </Pressable>
  );
  if (inOverlay && Platform.OS === 'ios') {
    return url ? <FullWindowOverlay>{content}</FullWindowOverlay> : null;
  }
  return (
    <Modal visible={!!url} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.96)' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  close: {
    position: 'absolute', right: 14,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
});
