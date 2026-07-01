import { StyleSheet, Modal, Pressable, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Full-screen image/GIF viewer. Tap anywhere (or the ✕) to close.
export default function ImageViewerModal({ url, onClose }: { url: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!url} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {url ? <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="contain" transition={120} /> : null}
        <TouchableOpacity style={[styles.close, { top: insets.top + 8 }]} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
      </Pressable>
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
