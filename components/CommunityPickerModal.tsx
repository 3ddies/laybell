import { useEffect, useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { genreLabel } from '../lib/genres';
import { fetchMyPostableCommunities, MAX_POST_COMMUNITIES, type PostableCommunity } from '../lib/communities';

type Props = {
  visible: boolean;
  userId: string | null;
  selectedIds: string[];
  onClose: () => void;
  onApply: (communities: PostableCommunity[]) => void;
  onBrowse: () => void;          // open the Communities screen (no unlocked tags)
};

// The post composer's "Add to a community" picker — MULTI-select: a post can go
// to several communities the user is an active member of (not muted). Tap to
// toggle, then Done. When they have none it shows the locked empty state.
export default function CommunityPickerModal({ visible, userId, selectedIds, onClose, onApply, onBrowse }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [list, setList] = useState<PostableCommunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    setPicked(new Set(selectedIds));
    setLoading(true);
    fetchMyPostableCommunities(userId).then((l) => { setList(l); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, userId]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else { if (next.size >= MAX_POST_COMMUNITIES) return prev; next.add(id); } // cap at 3 tags
      return next;
    });
  }
  const atMax = picked.size >= MAX_POST_COMMUNITIES;
  function apply() {
    onApply(list.filter((c) => picked.has(c.id)));
    onClose();
  }

  // Heads-up when the picked communities span more than one genre (the post then
  // becomes "no genre").
  const pickedGenres = new Set(list.filter((c) => picked.has(c.id)).map((c) => c.genre));
  const mixedGenre = pickedGenres.size > 1;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.titleRow}>
            <View>
              <Text style={styles.title}>{t('communities.pickCommunity')}</Text>
              {!loading && list.length > 0 && (
                <Text style={styles.maxHint}>{t('communities.maxCommunities', { max: MAX_POST_COMMUNITIES })}</Text>
              )}
            </View>
            {!loading && list.length > 0 && (
              <TouchableOpacity onPress={apply} hitSlop={8}>
                <Text style={styles.done}>{t('communities.done')}</Text>
              </TouchableOpacity>
            )}
          </View>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginVertical: SPACING.xl }} />
          ) : list.length === 0 ? (
            <View style={styles.locked}>
              <Ionicons name="lock-closed-outline" size={36} color={colors.textTertiary} />
              <Text style={styles.lockedTitle}>{t('communities.lockedTitle')}</Text>
              <Text style={styles.lockedBody}>{t('communities.lockedBody')}</Text>
              <TouchableOpacity style={styles.browseBtn} onPress={() => { onClose(); onBrowse(); }}>
                <Ionicons name="compass-outline" size={18} color="#fff" />
                <Text style={styles.browseText}>{t('communities.browseCommunities')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                {list.map((c) => {
                  const on = picked.has(c.id);
                  const blocked = !on && atMax; // can't add more than the cap
                  return (
                    <TouchableOpacity key={c.id} style={[styles.row, blocked && styles.rowBlocked]} onPress={() => toggle(c.id)}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowText, on && { color: colors.primary, fontWeight: '800' }]} numberOfLines={1}>{c.name}</Text>
                        <Text style={styles.rowHash} numberOfLines={1}>#{c.hashtag} · {genreLabel(c.genre)}</Text>
                      </View>
                      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? colors.primary : colors.textTertiary} />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              {mixedGenre && (
                <View style={styles.mixedHint}>
                  <Ionicons name="information-circle-outline" size={15} color={colors.textTertiary} />
                  <Text style={styles.mixedHintText}>{t('communities.mixedGenreHint')}</Text>
                </View>
              )}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl, maxHeight: '70%' },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  maxHint: { color: colors.textTertiary, fontSize: 11, marginTop: 1 },
  done: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.sm + 2, borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle },
  rowBlocked: { opacity: 0.45 },
  rowText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowHash: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  mixedHint: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: SPACING.sm },
  mixedHintText: { color: colors.textTertiary, fontSize: 12, flex: 1 },

  locked: { alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.lg },
  lockedTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  lockedBody: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', paddingHorizontal: SPACING.md },
  browseBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: SPACING.sm, backgroundColor: colors.primary, borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.lg },
  browseText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
