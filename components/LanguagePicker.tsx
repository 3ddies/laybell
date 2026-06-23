import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { LANGUAGES } from '../lib/i18n';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';

type LanguagePickerProps = {
  visible: boolean;
  onClose: () => void;
};

// Everything language-related lives here: the app-language list AND the
// auto-translate toggle for user-typed content. Settings opens this from a
// single "Language" row, so the screen itself stays compact.
export default function LanguagePicker({ visible, onClose }: LanguagePickerProps) {
  const { colors } = useTheme();
  const { t, lang, setLang, autoTranslate, setAutoTranslate } = useTranslation();
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('settings.section.language')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* App language — applies live, persisted. Each row shows the language's
              own name with its English name underneath. */}
          <View style={styles.card}>
            {LANGUAGES.map((l, i) => (
              <View key={l.code}>
                <TouchableOpacity
                  style={styles.row}
                  activeOpacity={0.7}
                  onPress={() => setLang(l.code)}
                >
                  <View style={styles.rowIcon}>
                    <Ionicons name="language-outline" size={22} color={colors.text} />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>{l.native}</Text>
                    <Text style={styles.rowSubtitle}>{l.label}</Text>
                  </View>
                  {lang === l.code
                    ? <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                    : <View style={styles.radioOff} />}
                </TouchableOpacity>
                {i < LANGUAGES.length - 1 && <View style={styles.separator} />}
              </View>
            ))}
          </View>

          {/* Auto-translate user content (comments/messages/captions/bios) into
              the chosen language. Separate from the static-UI language above. */}
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowIcon}>
                <Ionicons name="globe-outline" size={22} color={colors.text} />
              </View>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>{t('settings.autoTranslate')}</Text>
                <Text style={styles.rowSubtitle}>{t('settings.autoTranslateSub')}</Text>
              </View>
              <Switch
                value={autoTranslate}
                onValueChange={setAutoTranslate}
                trackColor={{ false: colors.border, true: colors.primary + '88' }}
                thumbColor={autoTranslate ? colors.primary : colors.textTertiary}
              />
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.background,
    paddingTop: SPACING.xxl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.md,
    borderBottomWidth: 0.5,
    borderBottomColor: c.borderSubtle,
  },
  closeBtn: {
    padding: SPACING.sm,
  },
  headerTitle: {
    color: c.text,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  content: {
    padding: SPACING.md,
    gap: SPACING.lg,
    paddingBottom: SPACING.xxl,
  },
  card: {
    backgroundColor: c.surfaceLight,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm + 4,
    paddingHorizontal: SPACING.md,
    gap: SPACING.md,
  },
  rowIcon: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    color: c.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  radioOff: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: c.border,
  },
  separator: {
    height: 0.5,
    backgroundColor: c.border,
    marginLeft: SPACING.md + 28 + SPACING.md,
  },
});
