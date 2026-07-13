import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AppVideo from './AppVideo';
import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { aspectToNumber } from '../lib/aspectRatio';
import SlideshowCarousel from './SlideshowCarousel';
import { parseSlides, isSlideshow } from '../lib/slideshow';
import { useCardPlayback } from '../lib/feedVideo';
import type { AdMeta } from '../lib/ads';

const SCREEN_W = Dimensions.get('window').width;
const MAX_VIDEO_H = SCREEN_W * 1.25;

// A feed ad rendered as a native-looking sponsored post. Distinct from a real
// PostCard: clear "Sponsored" label + advertiser name, a call-to-action button
// (no like/comment/save), and a 3-dot for Report ad / Why this ad? / ad
// settings. The item is post-shaped (built in lib/ads feedItemFor) with an
// __ad marker carrying the campaign + creative + CTA.

type Props = {
  item: any; // feed ad item: { id, type, media_url, slides, aspect_ratio, __ad }
  onCta: (item: any) => void;
  onOptions: (item: any) => void;
};

// Playback flags come from the per-card store (lib/feedVideo) instead of props,
// so a viewability/gate change re-renders only this card, never the whole list.
// The home feed is this component's only host (ad ids never enter the warm set,
// so isVisibleVideo here means exactly "this ad is the visible video").
const SponsoredCard = memo(function SponsoredCard({ item, onCta, onOptions }: Props) {
  const { isVisibleVideo, shouldPlayVideo } = useCardPlayback(item.id);
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const ad: AdMeta = item.__ad;
  const brand = ad?.advertiserName || t('ad.sponsored');

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        {ad?.avatarUrl ? (
          <ExpoImage source={{ uri: ad.avatarUrl }} style={styles.brandAvatar} contentFit="cover" cachePolicy="memory-disk" />
        ) : (
          <View style={styles.brandAvatar}>
            <Text style={styles.brandInitial}>{brand.charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.headerInfo}>
          <View style={styles.nameRow}>
            <Text style={styles.brandName} numberOfLines={1}>{brand}</Text>
            <View style={styles.sponsoredPill}>
              <Text style={styles.sponsoredText}>{t('ad.sponsored')}</Text>
            </View>
          </View>
          <Text style={styles.subline}>{t('sponsoredCard.ad')}</Text>
        </View>
        <TouchableOpacity
          style={styles.optionsBtn}
          onPress={() => onOptions(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Media */}
      {item.type === 'image' && !!item.media_url && (
        <TouchableOpacity activeOpacity={0.95} onPress={() => onCta(item)}>
          <ExpoImage
            source={{ uri: item.media_url }}
            style={[styles.media, { aspectRatio: aspectToNumber(item.aspect_ratio, 1), backgroundColor: '#000' }]}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        </TouchableOpacity>
      )}

      {isSlideshow(item.type) && (
        <View>
          <SlideshowCarousel
            slides={parseSlides(item)}
            width={SCREEN_W}
            aspectRatio={aspectToNumber(item.aspect_ratio, 1)}
            active={shouldPlayVideo}
            postId={item.id}
            onOpen={() => onCta(item)}
          />
        </View>
      )}

      {item.type === 'video' && !!item.media_url && (
        <TouchableOpacity activeOpacity={0.95} onPress={() => onCta(item)}>
          {isVisibleVideo ? (
            <AppVideo
              source={{ uri: item.media_url }}
              style={[styles.media, { height: Math.min(SCREEN_W / aspectToNumber(item.aspect_ratio, 16 / 9), MAX_VIDEO_H), backgroundColor: '#000' }]}
              contentFit="cover"
              loop
              muted
              active={shouldPlayVideo}
            />
          ) : (
            // Off-screen: hold the slot without a live AVPlayer (ads carry no
            // poster asset). The player mounts as the card approaches 40% visible.
            <View style={[styles.media, { height: Math.min(SCREEN_W / aspectToNumber(item.aspect_ratio, 16 / 9), MAX_VIDEO_H), backgroundColor: '#000' }]} />
          )}
        </TouchableOpacity>
      )}

      {/* Headline + body */}
      {!!ad?.headline && <Text style={styles.headline} numberOfLines={2}>{ad.headline}</Text>}
      {!!ad?.body && <Text style={styles.body} numberOfLines={3}>{ad.body}</Text>}

      {/* CTA */}
      <TouchableOpacity style={styles.cta} onPress={() => onCta(item)} activeOpacity={0.85}>
        <Text style={styles.ctaText}>{ad?.ctaLabel || t('sponsoredCard.learnMore')}</Text>
        <Ionicons name="arrow-forward" size={15} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
});

export default SponsoredCard;

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  card: {
    backgroundColor: colors.background,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.borderSubtle,
    paddingBottom: SPACING.sm,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2, gap: SPACING.sm,
  },
  brandAvatar: {
    width: 38, height: 38, borderRadius: RADIUS.full,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  brandInitial: { color: colors.text, fontSize: 16, fontWeight: '800' },
  headerInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  brandName: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  sponsoredPill: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: RADIUS.full,
    backgroundColor: colors.surfaceElevated,
  },
  sponsoredText: { color: colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  subline: { color: colors.textMeta, fontSize: 12, marginTop: 1 },
  optionsBtn: {
    width: 28, height: 28, borderRadius: RADIUS.full,
    backgroundColor: colors.primary + '18', alignItems: 'center', justifyContent: 'center',
  },

  media: { width: '100%', backgroundColor: colors.surfaceLight },

  headline: { color: colors.text, fontSize: 15, fontWeight: '700', paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  body: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, paddingHorizontal: SPACING.md, paddingTop: 3 },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginHorizontal: SPACING.md, marginTop: SPACING.sm,
    backgroundColor: colors.primary, borderRadius: RADIUS.full, paddingVertical: SPACING.sm + 2,
  },
  ctaText: { color: colors.text, fontSize: 14, fontWeight: '800' },
});
