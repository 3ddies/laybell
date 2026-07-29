import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Animated, PanResponder, Alert,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

export type EditableTrack = { post_id: string; posts: any };

// Edit mode for a playlist: select multiple tracks to remove them in one go,
// and drag the ≡ handle to reorder. Drag is a hand-rolled PanResponder (the
// project has no gesture-handler/reanimated, and adding them would force a
// dev-client rebuild): rows are fixed-height, the dragged row follows the
// finger, and the list live-swaps whenever the drag crosses a row boundary.
const ROW_H = 64;

export default function PlaylistEditor({ tracks, onCommitOrder, onRemove }: {
  tracks: EditableTrack[];
  // Fired when a drag is dropped — `next` is the full new order.
  onCommitOrder: (next: EditableTrack[]) => void;
  // Fired after the user confirms removal — selected ids + the remaining order.
  onRemove: (postIds: string[], next: EditableTrack[]) => void;
}) {
  const { colors } = useTheme();
  // Aliased to `tr` because the track-list .map() below binds `t` to each track.
  const { t: tr } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [order, setOrder] = useState<EditableTrack[]>(tracks);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  // Parent owns the source of truth — resync after it applies our callbacks.
  useEffect(() => { setOrder(tracks); }, [tracks]);

  const orderRef = useRef(order); orderRef.current = order;
  const dragY = useRef(new Animated.Value(0)).current;
  const startIdxRef = useRef(0);
  const curIdxRef = useRef(0);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function endDrag() {
    setDraggingKey(null);
    dragY.setValue(0);
    onCommitOrder(orderRef.current);
  }

  // One responder per row render — bound to the row's key via closure. The
  // dragged row's translate keeps it under the finger across live swaps.
  const makePan = (key: string) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      const idx = orderRef.current.findIndex(t => t.post_id === key);
      startIdxRef.current = idx;
      curIdxRef.current = idx;
      dragY.setValue(0);
      setDraggingKey(key);
    },
    onPanResponderMove: (_e, g) => {
      const target = Math.max(0, Math.min(
        orderRef.current.length - 1,
        startIdxRef.current + Math.round(g.dy / ROW_H),
      ));
      if (target !== curIdxRef.current) {
        const next = [...orderRef.current];
        const [moved] = next.splice(curIdxRef.current, 1);
        next.splice(target, 0, moved);
        curIdxRef.current = target;
        orderRef.current = next;
        setOrder(next);
      }
      dragY.setValue(g.dy - (curIdxRef.current - startIdxRef.current) * ROW_H);
    },
    onPanResponderRelease: endDrag,
    onPanResponderTerminate: endDrag,
  });

  function confirmRemove() {
    const ids = [...selected];
    if (!ids.length) return;
    Alert.alert(
      tr('playlistEditor.removeTitle'),
      tr('playlistEditor.removeConfirm', { n: ids.length }),
      [
        { text: tr('common.cancel'), style: 'cancel' },
        {
          text: tr('playlistEditor.remove'), style: 'destructive',
          onPress: () => {
            const next = orderRef.current.filter(t => !selected.has(t.post_id));
            setSelected(new Set());
            onRemove(ids, next);
          },
        },
      ],
    );
  }

  return (
    <View style={styles.flex}>
      <ScrollView
        scrollEnabled={!draggingKey}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
      >
        {order.map(t => {
          const isDragging = draggingKey === t.post_id;
          const isSelected = selected.has(t.post_id);
          return (
            <Animated.View
              key={t.post_id}
              style={[styles.row, isDragging && [styles.rowDragging, { transform: [{ translateY: dragY }] }]]}
            >
              <TouchableOpacity onPress={() => toggle(t.post_id)} hitSlop={8}>
                <Ionicons
                  name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={24}
                  color={isSelected ? colors.primary : colors.textTertiary}
                />
              </TouchableOpacity>

              <TouchableOpacity style={styles.body} activeOpacity={0.7} onPress={() => toggle(t.post_id)}>
                {t.posts?.cover_url ? (
                  <ExpoImage source={{ uri: t.posts.cover_url }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" />
                ) : (
                  <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.cover}>
                    <Ionicons name="musical-notes" size={16} color={colors.primary} />
                  </LinearGradient>
                )}
                <View style={styles.info}>
                  <Text style={styles.title} numberOfLines={1}>{t.posts?.caption || tr('playlistEditor.audioTrack')}</Text>
                  <Text style={styles.artist} numberOfLines={1}>@{t.posts?.profiles?.username}</Text>
                </View>
              </TouchableOpacity>

              {/* Drag handle */}
              <View style={styles.handle} {...makePan(t.post_id).panHandlers}>
                <Ionicons name="reorder-three" size={26} color={colors.textTertiary} />
              </View>
            </Animated.View>
          );
        })}
      </ScrollView>

      {selected.size > 0 && (
        <TouchableOpacity style={styles.removeBar} onPress={confirmRemove} activeOpacity={0.85}>
          <Ionicons name="trash-outline" size={18} color="#fff" />
          <Text style={styles.removeBarText}>
            {tr('playlistEditor.removeBar', { n: selected.size })}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  flex: { flex: 1 },
  list: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xxl * 2 },
  row: {
    height: ROW_H,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
  },
  rowDragging: {
    zIndex: 10,
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.md,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  cover: { width: 44, height: 44, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  info: { flex: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  artist: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },
  handle: { paddingHorizontal: SPACING.sm, paddingVertical: SPACING.md },

  removeBar: {
    position: 'absolute', left: SPACING.md, right: SPACING.md, bottom: SPACING.lg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: colors.error, borderRadius: RADIUS.full, paddingVertical: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  removeBarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
