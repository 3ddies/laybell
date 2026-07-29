import { View, Text, StyleSheet, TouchableOpacity, Image, Modal, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { slideshowThumb } from '../lib/slideshow';
import { isSongPost } from '../lib/pageLayout';
import VideoThumb from './VideoThumb';

// Bottom-sheet picker for filling a layout slot. The parent passes the already-
// filtered list of eligible posts (right media type, not used in another slot);
// this just shows them as a tappable grid and reports the choice.
export default function LayoutSlotPicker({
  visible, title, subtitle, posts, selectedId, onPick, onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  posts: any[];
  selectedId?: string | null;
  onPick: (post: any) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={styles.backdropFill} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{title}</Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('a11y.close')}><Ionicons name="close" size={22} color={colors.textSecondary} /></TouchableOpacity>
          </View>

          {posts.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="albums-outline" size={36} color={colors.textTertiary} />
              <Text style={styles.emptyText}>{t('slotPicker.empty')}</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
              {posts.map((post) => {
                const selected = post.id === selectedId;
                return (
                  <TouchableOpacity key={post.id} style={styles.cell} activeOpacity={0.8} onPress={() => onPick(post)}>
                    {post.type === 'video' ? (
                      <VideoThumb thumbnailUrl={post.thumbnail_url} mediaUrl={post.media_url} style={styles.thumb} />
                    ) : post.type === 'slideshow' ? (
                      <Image source={{ uri: slideshowThumb(post) ?? undefined }} style={styles.thumb} resizeMode="cover" />
                    ) : post.type === 'image' ? (
                      <Image source={{ uri: post.media_url }} style={styles.thumb} resizeMode="cover" />
                    ) : isSongPost(post) && post.cover_url ? (
                      <Image source={{ uri: post.cover_url }} style={styles.thumb} resizeMode="cover" />
                    ) : (
                      <LinearGradient colors={['#1C0E06', '#120A04']} style={[styles.thumb, styles.ph]}>
                        <Ionicons name={isSongPost(post) ? 'musical-notes' : 'videocam'} size={22} color={colors.primary} />
                      </LinearGradient>
                    )}
                    {/* type glyph */}
                    {post.type !== 'image' && (
                      <View style={styles.glyph}>
                        <Ionicons name={post.type === 'video' ? 'play' : post.type === 'slideshow' ? 'copy' : 'musical-notes'} size={11} color="#fff" />
                      </View>
                    )}
                    {selected && (
                      <View style={styles.selectedOverlay}>
                        <Ionicons name="checkmark-circle" size={26} color={colors.primary} />
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  backdropFill: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingBottom: SPACING.xxl, maxHeight: '78%',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: SPACING.sm, marginBottom: SPACING.sm },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  subtitle: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },
  empty: { alignItems: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { color: colors.textTertiary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 2, gap: 2 },
  cell: { width: '32.7%', aspectRatio: 1, position: 'relative', borderRadius: RADIUS.sm, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },
  ph: { alignItems: 'center', justifyContent: 'center' },
  glyph: {
    position: 'absolute', top: 5, left: 5, width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  selectedOverlay: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(224,64,28,0.25)', borderWidth: 2, borderColor: colors.primary, borderRadius: RADIUS.sm,
  },
});
