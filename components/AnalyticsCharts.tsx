import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { formatCount } from '../lib/format';

type Datum = { label: string; value: number };

// Vertical bar chart, pure-View (no native chart dep). The tallest bar is
// highlighted. Labels thin out automatically when there are many bars.
export function BarChart({
  data, height = 132, accent = true,
}: { data: Datum[]; height?: number; accent?: boolean }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const peakIdx = data.reduce((mi, d, i) => (d.value > data[mi].value ? i : mi), 0);
  const labelStep = Math.ceil(data.length / 8); // show ~8 labels max

  if (data.every((d) => d.value === 0)) {
    return <View style={[styles.emptyChart, { height: height + 20 }]}><Text style={styles.emptyText}>No data yet for this range</Text></View>;
  }

  return (
    <View>
      <View style={[styles.barsRow, { height, gap: data.length > 14 ? 2 : 5 }]}>
        {data.map((d, i) => {
          const h = Math.max(3, (d.value / max) * height);
          const isPeak = accent && d.value > 0 && i === peakIdx;
          return (
            <View key={i} style={styles.barCol}>
              {isPeak && <Text style={styles.peakValue}>{formatCount(d.value)}</Text>}
              <View style={[styles.bar, { height: h }, isPeak ? styles.barPeak : styles.barDim]} />
            </View>
          );
        })}
      </View>
      <View style={styles.labelsRow}>
        {data.map((d, i) => (
          <Text key={i} style={styles.barLabel} numberOfLines={1}>
            {i % labelStep === 0 ? d.label : ''}
          </Text>
        ))}
      </View>
    </View>
  );
}

// Horizontal bars — good for category breakdowns (content mix, etc.).
export function HBars({
  data, accentTop = false,
}: { data: { label: string; value: number; caption?: string }[]; accentTop?: boolean }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View style={{ gap: SPACING.md }}>
      {data.map((d, i) => (
        <View key={d.label + i}>
          <View style={styles.hbarHead}>
            <Text style={styles.hbarLabel} numberOfLines={1}>{d.label}</Text>
            <Text style={styles.hbarCaption}>{d.caption ?? formatCount(d.value)}</Text>
          </View>
          <View style={styles.hbarTrack}>
            {accentTop && i === 0 ? (
              <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.hbarFill, { width: `${(d.value / max) * 100}%` }]} />
            ) : (
              <View style={[styles.hbarFill, { width: `${(d.value / max) * 100}%`, backgroundColor: COLORS.primary + (i === 0 ? 'FF' : '88') }]} />
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  barsRow: { flexDirection: 'row', alignItems: 'flex-end' },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '74%', minWidth: 3, borderRadius: 4 },
  barPeak: { backgroundColor: COLORS.primary },
  barDim: { backgroundColor: COLORS.primary + '4D' },
  peakValue: { color: COLORS.primaryLight, fontSize: 10, fontWeight: '800', marginBottom: 3 },
  labelsRow: { flexDirection: 'row', marginTop: 6 },
  barLabel: { flex: 1, textAlign: 'center', color: COLORS.textTertiary, fontSize: 9 },

  emptyChart: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: COLORS.textTertiary, fontSize: 13 },

  hbarHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  hbarLabel: { color: COLORS.text, fontSize: 13, fontWeight: '600', flex: 1 },
  hbarCaption: { color: COLORS.textSecondary, fontSize: 12, marginLeft: SPACING.sm },
  hbarTrack: { height: 9, borderRadius: RADIUS.full, backgroundColor: COLORS.surfaceElevated, overflow: 'hidden' },
  hbarFill: { height: '100%', borderRadius: RADIUS.full },
});
