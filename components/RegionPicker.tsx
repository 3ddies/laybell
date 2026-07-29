import { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, FlatList, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { US_REGIONS, regionName } from '../lib/geoBlock';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

// US state selector. Laybell launches US-only, and a couple of states now impose
// obligations that a pre-revenue service cannot meet (see lib/geoBlock.ts), so
// the app has to know which one the user is in.
//
// A dropdown rather than the chip grid the gender question uses: 56 chips is a
// wall, and one of them quietly ends the signup. Presenting it as an ordinary
// field keeps the interaction honest — the user is answering a question, not
// hunting for the option that lets them through.

export default function RegionPicker({ value, onChange }: {
  value: string | null;
  onChange: (code: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return US_REGIONS;
    return US_REGIONS.filter(
      (r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase() === q,
    );
  }, [query]);

  function pick(code: string) {
    onChange(code);
    setOpen(false);
    setQuery('');
  }

  return (
    <>
      <TouchableOpacity
        style={styles.field}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t('onboarding.region')}
      >
        <Text style={[styles.fieldText, !value && styles.fieldPlaceholder]}>
          {value ? regionName(value) : t('onboarding.regionPlaceholder')}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textTertiary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <View style={styles.head}>
              <Text style={styles.title}>{t('onboarding.region')}</Text>
              <TouchableOpacity
                onPress={() => setOpen(false)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('a11y.close')}
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder={t('onboarding.regionSearch')}
                placeholderTextColor={colors.textTertiary}
                selectionColor={colors.primary}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <FlatList
              data={results}
              keyExtractor={(r) => r.code}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => pick(item.code)} activeOpacity={0.7}>
                  <Text style={styles.rowLabel}>{item.name}</Text>
                  {value === item.code
                    ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                    : <View style={styles.radioOff} />}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 4,
  },
  fieldText: { color: c.text, fontSize: 15, fontWeight: '600' },
  fieldPlaceholder: { color: c.textTertiary, fontWeight: '500' },

  sheetWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '80%', minHeight: '55%', paddingBottom: SPACING.xl,
  },
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.lg, paddingBottom: SPACING.md,
  },
  title: { color: c.text, fontSize: 17, fontWeight: '800' },
  searchBar: {
    height: 44, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: c.surfaceLight, borderRadius: 22,
    borderWidth: 1, borderColor: c.borderStrong,
    paddingHorizontal: SPACING.md, marginHorizontal: SPACING.md, marginBottom: SPACING.sm,
  },
  searchInput: { flex: 1, paddingVertical: 0, color: c.text, fontSize: 15, lineHeight: 20 },
  list: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.lg },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: SPACING.sm + 4, paddingHorizontal: SPACING.sm,
  },
  rowLabel: { color: c.text, fontSize: 15, fontWeight: '500' },
  radioOff: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: c.border },
});
