import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { countLabel } from '../lib/i18n';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { genreLabel } from '../lib/genres';
import { communityImage } from '../lib/sampleImages';
import { formatCount } from '../lib/format';
import RoleBadge from './RoleBadge';
import type { Community } from '../lib/communities';

type Props = {
  community: Community;
  onPress: () => void;
  variant?: 'rail' | 'row';
};

export default function CommunityCard({ community, onPress, variant = 'rail' }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  // Always a picture (owner: no gradient fallbacks): the uploaded banner, else a photo
  // matching the GENRE (music communities) or the official-TOPIC hashtag, else a default.
  const img = community.banner_url || communityImage(community.genre, community.hashtag);
  const genreTag = genreLabel(community.genre); // '' for the official topic tabs (null genre)

  if (variant === 'row') {
    return (
      <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.8}>
        <Image source={{ uri: img }} style={styles.rowThumb} resizeMode="cover" />
        <View style={styles.rowInfo}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowName} numberOfLines={1}>{community.name}</Text>
            {community.myRole && <RoleBadge role={community.myRole} size={10} showLabel={false} />}
          </View>
          <Text style={styles.rowMeta} numberOfLines={1}>
            #{community.hashtag}{genreTag ? ` · ${genreTag}` : ''}
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
      <View style={[styles.banner, styles.bannerImgWrap]}>
        <Image source={{ uri: img }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        {!!genreTag && (
          <View style={styles.genrePill}>
            <Text style={styles.genrePillText} numberOfLines={1}>{genreTag}</Text>
          </View>
        )}
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardTitleLine}>
          <Text style={styles.cardName} numberOfLines={1}>{community.name}</Text>
          {community.myRole && <RoleBadge role={community.myRole} size={10} showLabel={false} />}
        </View>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {countLabel('member', community.member_count)}
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
  banner: { height: 78, padding: SPACING.sm, justifyContent: 'space-between', overflow: 'hidden', backgroundColor: colors.surface },
  bannerImgWrap: { justifyContent: 'flex-end' },
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
  rowThumb: { width: 52, height: 52, borderRadius: RADIUS.sm, overflow: 'hidden', backgroundColor: colors.surface },
  rowInfo: { flex: 1 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  rowCount: { alignItems: 'center', flexDirection: 'row', gap: 3 },
  rowCountText: { color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
});
