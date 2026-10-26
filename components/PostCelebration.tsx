import { memo, useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '../contexts/LanguageContext';

// Neutral celebration confetti (soft whites/greys) — matches the card palette.
const CONFETTI_COLORS = ['#F2F1ED', '#D7D5CD', '#B4B2A9', '#E6E5E1', '#9A9893'];

// One-shot celebration burst: pieces fly out from the centre on the native driver and fade.
const Confetti = memo(function Confetti() {
  const a = useRef(new Animated.Value(0)).current;
  const pieces = useMemo(() => Array.from({ length: 18 }, (_, i) => {
    const ang = (Math.PI * 2 * i) / 18 + (Math.random() - 0.5);
    const dist = 80 + Math.random() * 80;
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 24, rot: Math.random() * 540 - 270, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] };
  }), []);
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 1150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [a]);
  return (
    <View style={[StyleSheet.absoluteFillObject, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
      {pieces.map((pc, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute', width: 10, height: 10, borderRadius: 2, backgroundColor: pc.color,
            opacity: a.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
            transform: [
              { translateX: a.interpolate({ inputRange: [0, 1], outputRange: [0, pc.x] }) },
              { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, pc.y] }) },
              { rotate: a.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${pc.rot}deg`] }) },
            ],
          }}
        />
      ))}
    </View>
  );
});

// Celebration overlay for a just-posted video. It rides on the REAL feed card (pinned
// to the top the moment the upload finishes) rather than a stand-in — so the video
// autoplays and its song plays through the normal feed machinery, which a simplified
// optimistic card could never do. A one-shot confetti burst plus View/Share pills at the
// bottom of the frame; both clear on the next pull-to-refresh, leaving an ordinary post.
export default memo(function PostCelebration({ onView, onShare }: { onView: () => void; onShare: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Confetti />
      <View style={styles.doneActions} pointerEvents="box-none">
        <TouchableOpacity style={styles.doneGhost} activeOpacity={0.85} onPress={onView}>
          <Ionicons name="eye-outline" size={18} color="#fff" />
          <Text style={styles.doneGhostText}>{t('upload.view')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.doneSolid} activeOpacity={0.85} onPress={onShare}>
          <Ionicons name="paper-plane-outline" size={18} color="#1C1C1E" />
          <Text style={styles.doneSolidText}>{t('upload.share')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  // iOS-style pills at the bottom of the frame: View a frosted ghost, Share a solid white.
  doneActions: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, padding: 14 },
  doneGhost: { flex: 1, height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.28)', borderRadius: 14 },
  doneGhostText: { color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  doneSolid: { flex: 1, height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#fff', borderRadius: 14 },
  doneSolidText: { color: '#1C1C1E', fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
});
