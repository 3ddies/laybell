import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import SlideUpSheet from './SlideUpSheet';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { selection } from '../lib/haptics';
import {
  MINUTE_STEP, atDayTime, dayWord, defaultSchedule, earliestSchedule, formatSchedule,
  from12h, scheduleDays, scheduleProblem, startOfDay, to12h, uses12h,
} from '../lib/schedule';

// The day-and-time picker for scheduling a post. No native date picker is in this
// build and adding one means a native module (never without asking), so it is
// plain React Native: a row of days, and hour / minute / AM-PM wheels built from
// snapping scroll views. The rules — how soon, how far, the minute grid — are
// lib/schedule's.

const ITEM_H = 42;
const VISIBLE_ROWS = 5;
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);

export default function SchedulePicker({ visible, value, onClose, onSet, onClear }: {
  visible: boolean;
  /** The time already chosen, or null for a post going up right away. */
  value: number | null;
  onClose: () => void;
  onSet: (at: number) => void;
  /** Offered when a time is already chosen: back to posting right away. */
  onClear?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t, lang } = useTranslation();
  const twelve = useMemo(() => uses12h(lang), [lang]);

  const [now, setNow] = useState(() => Date.now());
  const [at, setAt] = useState(() => value ?? defaultSchedule(Date.now()));
  // Each opening starts from the chosen time, or a fresh suggestion.
  useEffect(() => {
    if (!visible) return;
    const n = Date.now();
    setNow(n);
    setAt(value != null && value > n ? value : defaultSchedule(n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const days = useMemo(() => scheduleDays(now), [now]);
  const chosen = new Date(at);
  const dayStart = startOfDay(at);
  const hour24 = chosen.getHours();
  const minute = chosen.getMinutes() - (chosen.getMinutes() % MINUTE_STEP);
  const { hour12, pm } = to12h(hour24);
  const problem = scheduleProblem(at, Date.now());

  const words = {
    today: t('schedule.today'),
    tomorrow: t('schedule.tomorrow'),
    dayTime: (day: string, time: string) => t('schedule.dayTime', { day, time }),
  };

  // A day whose chosen time has already passed (today, earlier than now) moves to
  // the earliest time offered, rather than showing an error for a tap on "Today".
  function pickDay(day: number) {
    let next = atDayTime(day, hour24, minute);
    const earliest = earliestSchedule(Date.now());
    if (next < earliest) next = earliest;
    setAt(next);
  }
  function pickTime(nextHour24: number, nextMinute: number) {
    setAt(atDayTime(dayStart, nextHour24, nextMinute));
  }

  const hourItems = twelve ? Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i)) : Array.from({ length: 24 }, (_, i) => i);
  const hourIndex = twelve ? hour12 % 12 : hour24;

  // Keep the chosen day in view when the sheet opens on a later date.
  const dayScroll = useRef<ScrollView>(null);
  const dayIndex = Math.max(0, days.indexOf(dayStart));
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => dayScroll.current?.scrollTo({ x: Math.max(0, dayIndex - 1) * DAY_CHIP_W, animated: false }), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <SlideUpSheet visible={visible} onClose={onClose} sheetStyle={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('schedule.title')}</Text>
        <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
          <Ionicons name="close" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={dayScroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dayRow}
      >
        {days.map((day) => {
          const on = day === dayStart;
          const word = dayWord(day, now);
          const date = new Date(day);
          return (
            <TouchableOpacity
              key={day}
              style={[styles.dayChip, on && styles.dayChipOn]}
              onPress={() => { selection(); pickDay(day); }}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.dayTop, on && styles.dayTextOn]} numberOfLines={1}>
                {word === 'today' ? t('schedule.today') : word === 'tomorrow' ? t('schedule.tomorrow') : date.toLocaleDateString(lang, { weekday: 'short' })}
              </Text>
              <Text style={[styles.dayBottom, on && styles.dayTextOn]} numberOfLines={1}>
                {date.toLocaleDateString(lang, { month: 'short', day: 'numeric' })}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.wheels}>
        <Wheel
          items={hourItems.map(String)}
          index={hourIndex}
          width={72}
          onIndex={(i) => pickTime(twelve ? from12h(hourItems[i], pm) : i, minute)}
          styles={styles}
        />
        <Text style={styles.colon}>:</Text>
        <Wheel
          items={MINUTES.map((m) => m.toString().padStart(2, '0'))}
          index={minute / MINUTE_STEP}
          width={72}
          onIndex={(i) => pickTime(hour24, MINUTES[i])}
          styles={styles}
        />
        {twelve && (
          <Wheel
            items={[t('schedule.am'), t('schedule.pm')]}
            index={pm ? 1 : 0}
            width={72}
            onIndex={(i) => pickTime(from12h(hour12, i === 1), minute)}
            styles={styles}
          />
        )}
      </View>

      <View style={styles.summary}>
        <Ionicons
          name={problem ? 'alert-circle-outline' : 'time-outline'}
          size={16}
          color={problem ? colors.error : colors.primary}
        />
        <Text style={[styles.summaryText, problem && { color: colors.error }]}>
          {problem === 'soon' ? t('schedule.tooSoon')
            : problem === 'far' ? t('schedule.tooFar')
            : t('schedule.goesLive', { when: formatSchedule(at, Date.now(), lang, words) })}
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.primary, !!problem && styles.primaryOff]}
        disabled={!!problem}
        onPress={() => onSet(at)}
        activeOpacity={0.85}
        accessibilityRole="button"
      >
        <Ionicons name="calendar" size={17} color="#fff" />
        <Text style={styles.primaryText}>{t('schedule.set')}</Text>
      </TouchableOpacity>
      {value != null && onClear && (
        <TouchableOpacity style={styles.secondary} onPress={onClear} accessibilityRole="button">
          <Text style={styles.secondaryText}>{t('schedule.now')}</Text>
        </TouchableOpacity>
      )}
    </SlideUpSheet>
  );
}

const DAY_CHIP_W = 66 + 8;

// One wheel: a snapping column with the choice under the centre band. Settles on
// momentum end — or shortly after a slow release that has no momentum, which some
// platforms never report as a momentum end at all.
function Wheel({ items, index, width, onIndex, styles }: {
  items: string[];
  index: number;
  width: number;
  onIndex: (i: number) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const ref = useRef<ScrollView>(null);
  const current = useRef(index);
  const dragging = useRef(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the value when it changes from outside (a day that moved the time, a
  // reopened sheet) — never while a finger is on the wheel.
  useEffect(() => {
    if (dragging.current) return;
    current.current = index;
    ref.current?.scrollTo({ y: index * ITEM_H, animated: false });
  }, [index]);

  const settleAt = (y: number) => {
    if (releaseTimer.current) { clearTimeout(releaseTimer.current); releaseTimer.current = null; }
    dragging.current = false;
    const i = Math.max(0, Math.min(items.length - 1, Math.round(y / ITEM_H)));
    ref.current?.scrollTo({ y: i * ITEM_H, animated: true });
    if (i !== current.current) {
      current.current = i;
      selection();
      onIndex(i);
    }
  };

  return (
    <View style={{ width, height: ITEM_H * VISIBLE_ROWS }}>
      <View pointerEvents="none" style={[styles.wheelBand, { top: ITEM_H * 2, height: ITEM_H }]} />
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        nestedScrollEnabled
        contentOffset={{ x: 0, y: index * ITEM_H }}
        contentContainerStyle={{ paddingVertical: ITEM_H * 2 }}
        onScrollBeginDrag={() => { dragging.current = true; }}
        onScrollEndDrag={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          releaseTimer.current = setTimeout(() => settleAt(y), 220);
        }}
        onMomentumScrollBegin={() => {
          if (releaseTimer.current) { clearTimeout(releaseTimer.current); releaseTimer.current = null; }
        }}
        onMomentumScrollEnd={(e) => settleAt(e.nativeEvent.contentOffset.y)}
      >
        {items.map((label, i) => (
          <TouchableOpacity key={`${label}-${i}`} style={styles.wheelItem} onPress={() => settleAt(i * ITEM_H)} activeOpacity={0.7}>
            <Text style={[styles.wheelText, i === index && styles.wheelTextOn]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  dayRow: { paddingHorizontal: SPACING.md, gap: 8 },
  dayChip: {
    width: 66, paddingVertical: 9, borderRadius: RADIUS.md, alignItems: 'center',
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: 'transparent',
  },
  dayChipOn: { backgroundColor: colors.primary + '1A', borderColor: colors.primary },
  dayTop: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  dayBottom: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 2 },
  dayTextOn: { color: colors.primary },
  wheels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  colon: { color: colors.text, fontSize: 22, fontWeight: '800', marginBottom: 2 },
  wheelBand: {
    position: 'absolute', left: 0, right: 0, borderRadius: RADIUS.md,
    backgroundColor: colors.surfaceLight,
  },
  wheelItem: { height: ITEM_H, alignItems: 'center', justifyContent: 'center' },
  wheelText: { color: colors.textTertiary, fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  wheelTextOn: { color: colors.text, fontSize: 21, fontWeight: '800' },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: SPACING.lg },
  summaryText: { color: colors.text, fontSize: 14, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  primary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: SPACING.lg, paddingVertical: SPACING.md, borderRadius: RADIUS.full,
    backgroundColor: colors.primary,
  },
  primaryOff: { opacity: 0.45 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secondary: { alignItems: 'center', paddingVertical: SPACING.xs },
  secondaryText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
});
