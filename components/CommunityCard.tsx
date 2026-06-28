import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { genreLabel } from '../lib/genres';
import { formatCount } from '../lib/format';
import RoleBadge from './RoleBadge';
import type { Community } from '../lib/communities';

// A community's accent gradient is derived from its name so each one is visually
// distinct and stable (no avatar uploads in v1). Picks from the brand palette.
const ACCENTS: readonly (readonly [string, string])[] = [
  ['#E8401C', '#F26522'], ['#7C3AED', '#A855F7'], ['#0EA5E9', '#22D3EE'],
  ['#F59E0B', '#FBBF24'], ['#10B981', '#34D399'], ['#EC4899', '#F472B6'],
  ['#6366F1', '#818CF8'], ['#EF4444', '#F87171'],
];
function accentFor(seed: string): readonly [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

type Props = {
  community: Community;
  onPress: () => void;
  variant?: 'rail' | 'row';
};

export default function CommunityCard({ community, onPress, variant = 'rail' }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const accent = accentFor(community.name);
  const initial = community.name.trim().charAt(0).toUpperCase() || '#';

  if (variant === 'row') {
    return (
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.8}>
        {community.banner_url ? (
          <Image source={{ uri: community.banner_url }} style={styles.rowThumb} resizeMode="cover" />
        ) : (
          <LinearGradient colors={accent as any} style={styles.rowThumb}>
            <Text style={styles.thumbInitial}>{initial}</Text>
          </LinearGradient>
        )}
        <View style={styles.rowInfo}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowName} numberOfLines={1}>{community.name}</Text>
            {community.myRole && <RoleBadge role={community.myRole} size={10} showLabel={false} />}
          </View>
          <Text style={styles.rowMeta} numberOfLines={1}>
            #{community.hashtag} · {genreLabel(community.genre)}
          </Text>
        </View>
        <View style={styles.rowCount}>
          <Ionicons name="people" size={13} color={colors.textTertiary} />
          <Text style={styles.rowCountText}>{formatCount(community.member_count)}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.85}>
      {community.banner_url ? (
        <View style={[styles.banner, styles.bannerImgWrap]}>
          <Image source={{ uri: community.banner_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={styles.genrePill}>
            <Text style={styles.genrePillText} numberOfLines={1}>{genreLabel(community.genre)}</Text>
          </View>
        </View>
      ) : (
        <LinearGradient colors={accent as any} style={styles.banner}>
          <Text style={styles.bannerInitial}>{initial}</Text>
          <View style={styles.genrePill}>
            <Text style={styles.genrePillText} numberOfLines={1}>{genreLabel(community.genre)}</Text>
          </View>
        </LinearGradient>
      )}
      <View style={styles.cardBody}>
        <View style={styles.cardTitleLine}>
          <Text style={styles.cardName} numberOfLines={1}>{community.name}</Text>
          {community.myRole && <RoleBadge role={community.myRole} size={10} showLabel={false} />}
        </View>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {t('communities.members', { count: formatCount(community.member_count) })}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  // rail card
  card: {
    width: 154,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border,
  },
  banner: { height: 78, padding: SPACING.sm, justifyContent: 'space-between', overflow: 'hidden' },
  bannerImgWrap: { justifyContent: 'flex-end' },
  bannerInitial: { color: '#fff', fontSize: 30, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 4 },
  genrePill: {
    alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.32)',
    borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm, paddingVertical: 2,
  },
  genrePillText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  cardBody: { padding: SPACING.sm, gap: 3 },
  cardTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cardName: { color: colors.text, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  cardMeta: { color: colors.textTertiary, fontSize: 12 },

  // row (search results / lists)
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.sm,
  },
  rowThumb: { width: 52, height: 52, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  thumbInitial: { color: '#fff', fontSize: 22, fontWeight: '900' },
  rowInfo: { flex: 1 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  rowCount: { alignItems: 'center', flexDirection: 'row', gap: 3 },
  rowCountText: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
});
