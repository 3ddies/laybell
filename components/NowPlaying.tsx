import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Animated, PanResponder, Easing } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAudio } from '../contexts/AudioContext';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { formatCount } from '../lib/format';
import Scrubber from './Scrubber';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const ART = Math.min(SCREEN_W - SPACING.xl * 2, 340);

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Full-screen "now playing" overlay that slides up over the current screen, so
// the page behind shows through when you swipe it down.
export default function NowPlaying() {
  const { currentTrack, isPlaying, isBuffering, positionMs, durationMs, pause, resume, seekTo, expanded, collapse } = useAudio();
  const router = useRouter();
  const [stats, setStats] = useState<{ streams: number; saves: number; username?: string; userId?: string } | null>(null);
  const [render, setRender] = useState(false);
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;

  // Mount + slide in / out as `expanded` toggles.
  useEffect(() => {
    if (expanded) {
      setRender(true);
      Animated.timing(translateY, {
        toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(translateY, {
        toValue: SCREEN_H, duration: 280, easing: Easing.in(Easing.cubic), useNativeDriver: true,
      }).start(() => setRender(false));
    }
  }, [expanded]);

  useEffect(() => {
    const id = currentTrack?.id;
    if (!id) return;
    supabase
      .from('posts')
      .select('stream_count, save_count, user_id, profiles!posts_user_id_fkey(username)')
      .eq('id', id).single()
      .then(({ data }) => {
        if (data) setStats({
          streams: (data as any).stream_count || 0,
          saves: (data as any).save_count || 0,
          username: (data as any).profiles?.username,
          userId: (data as any).user_id,
        });
      });
  }, [currentTrack?.id]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => { if (g.dy > 0) translateY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        // Close only on a fluent downward flick (still moving at release). If the
        // finger paused/held — even far down — vy is ~0, so it springs back. This
        // prevents accidental closes from slow or held drags.
        if (g.vy > 0.5 && g.dy > 70) collapse();
        else Animated.timing(translateY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start(),
    })
  ).current;

  if (!render || !currentTrack) return null;

  const progress = durationMs > 0 ? positionMs / durationMs : 0;
  const goProfile = () => { if (stats?.userId) { collapse(); router.push(`/profile/${stats.userId}`); } };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.layer, { transform: [{ translateY }] }]}>
      <LinearGradient colors={['#2A1206', '#150A04', COLORS.background]} style={styles.container}>
        {/* Top drag zone — swipe down to close */}
        <View {...pan.panHandlers}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBtn} onPress={collapse}>
              <Ionicons name="chevron-down" size={26} color={COLORS.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Now Playing</Text>
            <View style={{ width: 40 }} />
          </View>

          <View style={styles.artWrap}>
            {currentTrack.cover ? (
              <Image source={{ uri: currentTrack.cover }} style={styles.art} />
            ) : (
              <LinearGradient colors={GRADIENTS.primary} style={styles.art}>
                <Ionicons name="musical-notes" size={72} color={COLORS.text} />
              </LinearGradient>
            )}
          </View>

          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={1}>{currentTrack.caption || 'Audio Track'}</Text>
            <TouchableOpacity disabled={!stats?.userId} onPress={goProfile}>
              <Text style={styles.artist} numberOfLines={1}>
                {currentTrack.artist || (stats?.username ? `@${stats.username}` : '')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.progressBlock}>
          <Scrubber
            progress={progress}
            onSeek={r => durationMs > 0 && seekTo(Math.floor(r * durationMs))}
            height={24} trackHeight={5} thumbSize={16}
          />
          <View style={styles.times}>
            <Text style={styles.timeText}>{formatMs(positionMs)}</Text>
            <Text style={styles.timeText}>{durationMs > 0 ? formatMs(durationMs) : '--:--'}</Text>
          </View>
        </View>

        <View style={styles.controls}>
          <TouchableOpacity style={styles.playBtn} onPress={() => (isPlaying ? pause() : resume())}>
            <Ionicons name={isBuffering ? 'hourglass' : isPlaying ? 'pause' : 'play'} size={32} color={COLORS.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.stats}>
          <View style={styles.statItem}>
            <Ionicons name="play" size={16} color={COLORS.primary} />
            <Text style={styles.statNum}>{formatCount(stats?.streams)}</Text>
            <Text style={styles.statLabel}>streams</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Ionicons name="bookmark" size={16} color={COLORS.primary} />
            <Text style={styles.statNum}>{formatCount(stats?.saves)}</Text>
            <Text style={styles.statLabel}>saves</Text>
          </View>
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { zIndex: 200, elevation: 200 },
  container: { flex: 1, paddingHorizontal: SPACING.xl, paddingBottom: SPACING.xxl },
  handle: {
    width: 40, height: 5, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignSelf: 'center', marginTop: SPACING.lg + SPACING.sm,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: SPACING.md, marginBottom: SPACING.xl,
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },

  artWrap: { alignItems: 'center', marginTop: SPACING.lg },
  art: {
    width: ART, height: ART, borderRadius: RADIUS.lg,
    alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight,
  },

  meta: { marginTop: SPACING.xl, alignItems: 'center', gap: SPACING.xs },
  title: { color: COLORS.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  artist: { color: COLORS.textSecondary, fontSize: 15 },

  progressBlock: { marginTop: SPACING.xl },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACING.xs },
  timeText: { color: COLORS.textTertiary, fontSize: 12, fontVariant: ['tabular-nums'] },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: SPACING.md },
  playBtn: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },

  stats: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 'auto', gap: SPACING.xl,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.lg,
    paddingVertical: SPACING.md, borderWidth: 1, borderColor: COLORS.border,
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statNum: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  statLabel: { color: COLORS.textSecondary, fontSize: 13 },
  statDivider: { width: 1, height: 24, backgroundColor: COLORS.border },
});
