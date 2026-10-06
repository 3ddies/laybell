import { useEffect, useState, type ReactNode } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedReaction, withSpring, runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';

// A hold-to-drag reorderable list, built on the reanimated + gesture-handler the
// app already ships — no new dependency, so it rides to the dev build over Metro.
//
// It is DELIBERATELY not a FlatList: a virtualised list recycles rows, which
// fights a drag that needs every row to hold still at a known Y. Instead each row
// is absolutely positioned at `position * rowHeight` inside a fixed-height
// ScrollView, and the drag moves one row's `top` under the finger while the rest
// spring to their new slots.
//
// THE DRAG TARGET IS THE WHOLE BODY (`renderItem`) — hold anywhere on it and
// drag. Trailing controls go through `renderActions`, which sits OUTSIDE the
// gesture, so a tap on one fires as a tap instead of being read as the start of a
// hold. Rows are a FIXED height (`rowHeight`): the clean math's price, so the
// caller's content must fit it.

const SPRING = { damping: 20, stiffness: 220, mass: 0.6 } as const;

// Shift a {id: index} map when the row at `from` is dropped at `to`. A worklet so
// it runs on the UI thread inside the pan handler without a bridge hop.
function movePositions(positions: Record<string, number>, from: number, to: number): Record<string, number> {
  'worklet';
  const next: Record<string, number> = {};
  for (const id in positions) {
    const p = positions[id];
    if (p === from) next[id] = to;
    else if (from < to && p > from && p <= to) next[id] = p - 1;
    else if (from > to && p < from && p >= to) next[id] = p + 1;
    else next[id] = p;
  }
  return next;
}

type Props<T> = {
  data: T[];
  keyExtractor: (item: T) => string;
  rowHeight: number;
  /** The draggable body of a row — hold anywhere on this and drag. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Trailing controls, rendered OUTSIDE the drag gesture so their taps work. */
  renderActions?: (item: T, index: number) => ReactNode;
  onReorder: (orderedKeys: string[]) => void;
  /** Opaque row background, so a lifted row cleanly covers the ones beneath it. */
  rowBackground?: string;
  contentStyle?: any;
};

export default function ReorderableList<T>({
  data, keyExtractor, rowHeight, renderItem, renderActions, onReorder, rowBackground, contentStyle,
}: Props<T>) {
  const keys = data.map(keyExtractor);
  const positions = useSharedValue<Record<string, number>>(Object.fromEntries(keys.map((k, i) => [k, i])));
  const active = useSharedValue<string | null>(null);
  const [scrollEnabled, setScrollEnabled] = useState(true);

  // Re-seed when the SET or ORDER of rows changes from outside (add, remove, or a
  // committed reorder) so the shared map never drifts from what's on screen.
  const keySig = keys.join('|');
  useEffect(() => {
    positions.value = Object.fromEntries(keys.map((k, i) => [k, i]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig]);

  const commit = (posMap: Record<string, number>) => {
    const order = [...keys].sort((a, b) => (posMap[a] ?? 0) - (posMap[b] ?? 0));
    onReorder(order);
  };

  return (
    <ScrollView
      style={styles.scroll}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[{ height: data.length * rowHeight }, contentStyle]}
    >
      {data.map((item, index) => (
        <Row
          key={keyExtractor(item)}
          id={keyExtractor(item)}
          rowHeight={rowHeight}
          count={data.length}
          positions={positions}
          active={active}
          onCommit={commit}
          setScrollEnabled={setScrollEnabled}
          rowBackground={rowBackground}
          body={renderItem(item, index)}
          actions={renderActions ? renderActions(item, index) : null}
        />
      ))}
    </ScrollView>
  );
}

function Row({
  id, rowHeight, count, positions, active, onCommit, setScrollEnabled, rowBackground, body, actions,
}: {
  id: string; rowHeight: number; count: number;
  positions: SharedValue<Record<string, number>>; active: SharedValue<string | null>;
  onCommit: (m: Record<string, number>) => void; setScrollEnabled: (b: boolean) => void;
  rowBackground?: string; body: ReactNode; actions: ReactNode;
}) {
  const top = useSharedValue((positions.value[id] ?? 0) * rowHeight);
  const isActive = useSharedValue(false);
  // The Y of the slot the drag STARTED from, captured once on pickup. The finger's
  // translationY is cumulative from that point, so this base must stay fixed.
  const startTop = useSharedValue(0);

  // When THIS row's slot changes because another row was dragged over it, glide to
  // the new slot. The lifted row is exempt — its `top` is the finger, not the slot.
  useAnimatedReaction(
    () => positions.value[id],
    (p) => {
      if (p == null || isActive.value) return;
      top.value = withSpring(p * rowHeight, SPRING);
    },
  );

  const pan = Gesture.Pan()
    .activateAfterLongPress(140)
    .onStart(() => {
      isActive.value = true;
      active.value = id;
      // Freeze the base at the slot we lifted from. Recomputing it from the LIVE
      // position (which moves as we drag) plus the cumulative translationY
      // double-counts, and the row shoots straight to the last slot.
      startTop.value = (positions.value[id] ?? 0) * rowHeight;
      runOnJS(setScrollEnabled)(false);
    })
    .onUpdate((e) => {
      top.value = startTop.value + e.translationY;
      const newIdx = Math.min(Math.max(Math.round(top.value / rowHeight), 0), count - 1);
      const oldIdx = positions.value[id] ?? 0;
      if (newIdx !== oldIdx) positions.value = movePositions(positions.value, oldIdx, newIdx);
    })
    .onEnd(() => {
      top.value = withSpring((positions.value[id] ?? 0) * rowHeight, SPRING);
    })
    .onFinalize(() => {
      if (!isActive.value) return;
      isActive.value = false;
      active.value = null;
      runOnJS(setScrollEnabled)(true);
      runOnJS(onCommit)({ ...positions.value });
    });

  const style = useAnimatedStyle(() => ({
    top: top.value,
    zIndex: isActive.value ? 20 : 1,
    transform: [{ scale: withSpring(isActive.value ? 1.03 : 1, SPRING) }],
    shadowOpacity: withSpring(isActive.value ? 0.28 : 0),
    elevation: isActive.value ? 8 : 0,
  }));

  return (
    <Animated.View style={[styles.row, { height: rowHeight, backgroundColor: rowBackground }, style]}>
      <GestureDetector gesture={pan}>
        <View style={styles.grab}>{body}</View>
      </GestureDetector>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  row: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  // The drag target: fills the row's full height and all the width the actions
  // don't take, so a hold truly anywhere on the track picks it up.
  grab: { flex: 1, alignSelf: 'stretch', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', paddingRight: 6 },
});
