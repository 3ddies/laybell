import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Countdown sticker: a title over the time remaining until `target` (an ISO string).
// `live` (the viewer + composer) ticks it every second; a static preview (thumbnails)
// passes live={false}. Once the target passes it reads all zeros. Pure presentation.
function parts(target?: string) {
  const t = target ? Date.parse(target) : NaN;
  const ms = Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
  const s = Math.floor(ms / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, done: ms <= 0 };
}

export function CountdownStickerContent({ title, target, live = true }: { title?: string; target?: string; live?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  const p = parts(target);
  const cells: Array<[number, string]> = [[p.d, 'D'], [p.h, 'H'], [p.m, 'M'], [p.s, 'S']];
  return (
    <View style={styles.card}>
      <Text style={styles.title} numberOfLines={1}>{title || 'Countdown'}</Text>
      <View style={styles.row}>
        {cells.map(([n, label], i) => (
          <View key={i} style={styles.cell}>
            <Text style={styles.num}>{String(n).padStart(2, '0')}</Text>
            <Text style={styles.unit}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, alignItems: 'center', gap: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10 },
  cell: { alignItems: 'center', minWidth: 34 },
  num: { color: '#fff', fontSize: 26, fontWeight: '900', fontVariant: ['tabular-nums'] },
  unit: { color: 'rgba(255,255,255,0.65)', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginTop: 1 },
});
