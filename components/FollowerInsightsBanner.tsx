import { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// Advertises the Premium "See unfollowers" feature (app/follower-insights) at the top
// of the signed-in user's OWN followers / following lists. The caller shows it only for
// a non-Premium viewer on their own list; tapping opens follower-insights, which itself
// paywalls non-Premium users (so this is a second, in-context entry point to upgrade).
function FollowerInsightsBannerBase({ onPress }: { onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${t('unfollowersBanner.title')}. ${t('unfollowersBanner.tag')}`}>
      <LinearGradient colors={GRADIENTS.primary as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
        <View style={styles.iconBubble}>
          <Ionicons name="person-remove" size={22} color="#fff" />
        </View>
        <View style={styles.text}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>{t('unfollowersBanner.title')}</Text>
            <View style={styles.pill}>
              <Ionicons name="star" size={10} color="#7A3A00" />
              <Text style={styles.pillText}>{t('unfollowersBanner.tag')}</Text>
            </View>
          </View>
          <Text style={styles.sub} numberOfLines={2}>{t('unfollowersBanner.sub')}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.9)" />
      </LinearGradient>
    </TouchableOpacity>
  );
}

export default memo(FollowerInsightsBannerBase);

const makeStyles = (_colors: ThemePalette) => StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.md + 2, paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg, overflow: 'hidden',
  },
  iconBubble: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center',
  },
  text: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: '#fff', fontSize: 16, fontWeight: '800', flexShrink: 1 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: RADIUS.full,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  pillText: { color: '#7A3A00', fontSize: 10, fontWeight: '900', letterSpacing: 0.3 },
  sub: { color: 'rgba(255,255,255,0.9)', fontSize: 13, marginTop: 2 },
});
