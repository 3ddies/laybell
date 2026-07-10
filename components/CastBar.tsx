import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCast } from '../contexts/CastContext';
import Scrubber from './Scrubber';

// The phone-as-remote controller for Laybell TV casting. Appears only while a
// Cast session is live; drives the TV's playback (play/pause/seek/next/prev) and
// disconnects. The TV's own remote controls the same session independently, so
// either input works — like YouTube/Netflix. Renders nothing when not casting.

export default function CastBar() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const {
    connected, current, deviceName, isPlaying, positionSec, durationSec,
    play, pause, next, prev, hasNext, hasPrev, seekTo, disconnect,
  } = useCast();

  if (!connected || !current) return null;

  const isLive = !!current.isLive || durationSec <= 0;
  const progress = durationSec > 0 ? Math.min(1, positionSec / durationSec) : 0;

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 8 }]} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.row}>
          {/* Cast-to indicator + poster */}
          <View style={styles.coverWrap}>
            {current.poster ? (
              <Image source={{ uri: current.poster }} style={styles.cover} />
            ) : (
              <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                <Ionicons name="tv" size={16} color={colors.primary} />
              </LinearGradient>
            )}
            <View style={styles.castGlyph}><Ionicons name="tv" size={9} color="#fff" /></View>
          </View>

          {/* Title + "casting to <device>" */}
          <View style={styles.info}>
            <Text style={styles.title} numberOfLines={1}>{current.title}</Text>
            <Text style={styles.sub} numberOfLines={1}>
              {t('tv.cast.castingTo', { device: deviceName || t('tv.cast.yourTv') })}
            </Text>
          </View>

          {/* Transport */}
          {hasPrev && (
            <TouchableOpacity onPress={prev} hitSlop={8} style={styles.ctrl}>
              <Ionicons name="play-skip-back" size={20} color={colors.text} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => (isPlaying ? pause() : play())} hitSlop={8} style={styles.ctrl}>
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={24} color={colors.text} />
          </TouchableOpacity>
          {hasNext && (
            <TouchableOpacity onPress={next} hitSlop={8} style={styles.ctrl}>
              <Ionicons name="play-skip-forward" size={20} color={colors.text} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={disconnect} hitSlop={8} style={styles.ctrl}>
            <Ionicons name="close" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Scrubber (VOD only — a live stream has no seekable duration) */}
        {isLive ? (
          <View style={styles.liveRow}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t('live.live')}</Text>
          </View>
        ) : (
          <View style={styles.scrubWrap}>
            <Scrubber
              progress={progress}
              onSeek={(r) => seekTo(r * durationSec)}
              height={16} trackHeight={4} thumbSize={12}
            />
          </View>
        )}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: { position: 'absolute', left: SPACING.md, right: SPACING.md, zIndex: 60 },
  card: {
    backgroundColor: c.surfaceElevated,
    borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: c.primary + '55',
    paddingHorizontal: SPACING.sm + 2, paddingTop: SPACING.sm, paddingBottom: 6,
    // Lift it off the content a touch.
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  coverWrap: { width: 40, height: 40, borderRadius: RADIUS.sm, overflow: 'hidden' },
  cover: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  castGlyph: {
    position: 'absolute', bottom: 2, right: 2, width: 15, height: 15, borderRadius: 7.5,
    backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: c.text, fontSize: 14, fontWeight: '700' },
  sub: { color: c.textSecondary, fontSize: 11, marginTop: 1 },
  ctrl: { padding: 4, alignItems: 'center', justifyContent: 'center' },
  scrubWrap: { marginTop: 2 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, marginLeft: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#F43F5E' },
  liveText: { color: '#F43F5E', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
});
