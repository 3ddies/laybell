import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import SwipeBackPager from './SwipeBackPager';
import { SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

// Shape of the legal documents in lib/legal/*.json. The renderer styles each
// block purely by its `type`, so the source documents carry no markup.
export type LegalBlock = {
  type: 'p' | 'bullet' | 'subheading';
  text: string;
};
export type LegalSection = {
  heading: string;
  blocks: LegalBlock[];
};
export type LegalDoc = {
  title: string;
  effective?: string;
  sections: LegalSection[];
};

// Generic reader for a long-form legal document (Privacy Policy, Terms of
// Service). Matches the app's settings/analytics chrome: SwipeBackPager so the
// whole page slides off to reveal Settings underneath, themed header with a
// back chevron, and a single scroll of numbered sections.
export default function LegalScreen({ doc }: { doc: LegalDoc }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{doc.title}</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {!!doc.effective && (
            <Text style={styles.effective}>Last Updated: {doc.effective}</Text>
          )}

          {doc.sections.map((section, si) => (
            <View key={si} style={styles.section}>
              <Text style={styles.heading}>{section.heading}</Text>
              {section.blocks
                // The `effective` line is shown once at the top — drop any
                // duplicate "Last Updated" block the source may also carry.
                .filter((b) => !b.text.trim().toLowerCase().startsWith('last updated'))
                .map((block, bi) => {
                  if (block.type === 'subheading') {
                    return <Text key={bi} style={styles.subheading}>{block.text}</Text>;
                  }
                  if (block.type === 'bullet') {
                    return (
                      <View key={bi} style={styles.bulletRow}>
                        <Text style={styles.bulletDot}>{'•'}</Text>
                        <Text style={styles.bulletText}>{block.text}</Text>
                      </View>
                    );
                  }
                  return <Text key={bi} style={styles.paragraph}>{block.text}</Text>;
                })}
            </View>
          ))}

          <Text style={styles.footer}>{'©'} 2026 Laybell LLC. All rights reserved.</Text>
        </ScrollView>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    // Clear the status bar / notch (matches settings/analytics chrome) so the
    // back chevron isn't cut off at the top.
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.borderSubtle,
  },
  backBtn: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle: { flex: 1, color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl, gap: SPACING.lg },
  effective: { color: c.textTertiary, fontSize: 12, fontWeight: '600' },
  section: { gap: SPACING.sm },
  heading: { color: c.text, fontSize: 16, fontWeight: '700' },
  subheading: { color: c.text, fontSize: 14, fontWeight: '700', marginTop: SPACING.xs },
  paragraph: { color: c.textSecondary, fontSize: 14, lineHeight: 21 },
  bulletRow: { flexDirection: 'row', paddingLeft: SPACING.xs },
  bulletDot: { color: c.primary, fontSize: 14, lineHeight: 21, marginRight: SPACING.sm },
  bulletText: { flex: 1, color: c.textSecondary, fontSize: 14, lineHeight: 21 },
  footer: { color: c.textTertiary, fontSize: 12, textAlign: 'center', marginTop: SPACING.lg },
});
