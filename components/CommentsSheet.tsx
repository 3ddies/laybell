import { Modal, View, Text, StyleSheet, TouchableOpacity, KeyboardAvoidingView, Platform, Pressable, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Comments from './Comments';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const SHEET_H = Math.round(Dimensions.get('window').height * 0.78);

// Instagram-style slide-up comments. Rendered as a transparent modal so whatever
// is behind (e.g. a playing reel) stays visible and keeps playing.
export default function CommentsSheet({ visible, postId, ownerId, onClose }: {
  visible: boolean;
  postId: string;
  ownerId?: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.sheet, { height: SHEET_H, paddingBottom: insets.bottom }]}>
            <View style={styles.handleRow}><View style={styles.handle} /></View>
            <View style={styles.headerRow}>
              <Text style={styles.title}>Comments</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>
            {visible && postId ? (
              <Comments postId={postId} ownerId={ownerId} contentPadding={SPACING.md} />
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    overflow: 'hidden',
  },
  handleRow: { alignItems: 'center', paddingTop: SPACING.sm },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.border },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  title: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
});
