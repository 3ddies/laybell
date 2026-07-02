import { StyleSheet, Modal, Pressable, TouchableOpacity, Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Full-screen image/GIF viewer. Tap anywhere (or the ✕) to close.
// `inOverlay`: when shown from inside the iOS Now Playing FullWindowOverlay, a
// nested <Modal> deadlocks — so render into its own FullWindowOverlay instead
// (mirrors the report / block / GIF sheets).
export default function ImageViewerModal({ url, onClose, inOverlay }: { url: string | null; onClose: () => void; inOverlay?: boolean }) {
  const insets = useSafeAreaInsets();
  const content = (
    <Pressable style={styles.backdrop} onPress={onClose}>
      {url ? <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="contain" transition={120} /> : null}
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
  close: {
    position: 'absolute', right: 14,
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
});
