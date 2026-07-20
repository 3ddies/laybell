import { View, Text, StyleSheet, TouchableOpacity, Modal, Dimensions, Animated } from 'react-native';
import { useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useLinkGuard } from '../contexts/LinkGuardContext';
import { openAdOptions } from '../contexts/AdOptionsContext';
import { recordAdClick, type AdMeta } from '../lib/ads';
import AppVideo from './AppVideo';

// Fullscreen, DISMISSABLE viewer for a Laybell TV ad — opened by tapping a
// sponsored card on the TV landing grid. Unlike the woven ads (landscape pager /
// cast), this one is OPTIONAL: the user chose to watch it, so it plays with
// sound and can be closed any time. Shows Sponsored + advertiser + a CTA button.
const { width: SCREEN_W } = Dimensions.get('window');

export type TVAdViewerItem = { media_url: string; thumbnail_url?: string | null; __ad?: AdMeta };

export default function TVAdViewer({ item, uid, onClose }: {
  item: TVAdViewerItem | null;
  uid: string | null;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const linkGuard = useLinkGuard();

  const meta = item?.__ad;
  const progress = useRef(new Animated.Value(0)).current;

  const onCta = () => {
    if (!meta?.ctaUrl) return;
    linkGuard.open(meta.ctaUrl, {
      context: 'ad',
      sourceName: meta.advertiserName,
      onProceed: () => recordAdClick({ __ad: meta }, 'tv', uid),
    });
  };
  const onReport = () => {
    if (meta) openAdOptions({ campaignId: meta.campaignId, creativeId: meta.creativeId, advertiserName: meta.advertiserName });
  };

  return (
    <Modal visible={!!item} transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {item?.media_url ? (
          <AppVideo
            source={{ uri: item.media_url }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            active
            loop
            muted={false}
            poster={item.thumbnail_url ?? undefined}
            posterContentFit="contain"
            onProgress={(pos, dur) => { if (dur > 0) progress.setValue(Math.min(1, pos / dur)); }}
          />
        ) : null}

        {/* Top bar: Sponsored tag + 3-dot report + close */}
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <View style={styles.sponsoredTag}>
            <Ionicons name="megaphone" size={12} color="#fff" />
            <Text style={styles.sponsoredText}>{t('ad.sponsored')}</Text>
          </View>
          <View style={styles.topRight}>
            <TouchableOpacity style={styles.iconBtn} onPress={onReport} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="ellipsis-horizontal" size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Bottom: advertiser + headline + CTA */}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.8)']} style={styles.bottomFade} pointerEvents="none" />
        <View style={[styles.meta, { bottom: insets.bottom + 24 }]}>
          {!!meta?.advertiserName && <Text style={styles.advertiser} numberOfLines={1}>{meta.advertiserName}</Text>}
          {!!meta?.headline && <Text style={styles.headline} numberOfLines={2}>{meta.headline}</Text>}
          {!!meta?.body && <Text style={styles.body} numberOfLines={2}>{meta.body}</Text>}
          {!!meta?.ctaUrl && (
            <TouchableOpacity style={styles.cta} onPress={onCta} activeOpacity={0.85}>
              <Text style={styles.ctaText}>{meta.ctaLabel || t('reelAd.learnMore')}</Text>
              <Ionicons name="arrow-forward" size={15} color={colors.text} />
            </TouchableOpacity>
          )}
        </View>

        {/* Video progress bar (imperative — no re-render per tick). */}
        <View style={[styles.progressTrack, { bottom: insets.bottom + 2 }]}>
          <Animated.View style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  sponsoredTag: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.sm, paddingVertical: 4,
  },
  sponsoredText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  iconBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  progressTrack: { position: 'absolute', left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  progressFill: { height: 3, backgroundColor: colors.primary },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240 },
  meta: { position: 'absolute', left: SPACING.md, right: SPACING.md, gap: SPACING.xs, maxWidth: SCREEN_W },
  advertiser: { color: '#fff', fontSize: 15, fontWeight: '800' },
  headline: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 2 },
  body: { color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 18 },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.sm + 2, marginTop: SPACING.sm,
  },
  ctaText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
