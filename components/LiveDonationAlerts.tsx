import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { notifySuccess } from '../lib/haptics';
import { fmtCents } from '../lib/donations';
import type { LiveDonationEvent } from '../lib/live';

// The Twitch-style donation alert. Mounted on BOTH the viewer and the host's
// go-live screen; when a donation broadcast lands (see joinLiveChannel), it
// slides a gradient card in over the stream with the donor, amount, and message
// — with emphasis (bounce-in, gift burst, haptic), holds 10s, then rolls to the
// next queued donation so a flurry of tips plays one-at-a-time (each donor gets
// their own full 10s, in the order they were processed) instead of piling up.
//
// Fed the LATEST donation via `event`; it de-dupes by id and manages its own
// queue, so the parent just pipes channel donations straight in.

// Each donation holds at least this long before the next queued one plays.
const HOLD_MS = 10000;

export default function LiveDonationAlerts({ event, topOffset }: {
  event: LiveDonationEvent | null;
  // Distance from the top of this component's container to the card. Defaults to
  // clearing the status bar + top overlay (viewer, which mounts this full-screen).
  // The host mounts it inside a container that already sits below the header +
  // safe area, so it passes a small value to keep the banner up near the top.
  topOffset?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [queue, setQueue] = useState<LiveDonationEvent[]>([]);
  const [current, setCurrent] = useState<LiveDonationEvent | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const anim = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  // Enqueue each new donation once (broadcast self:true can echo; dedupe by id).
  useEffect(() => {
    if (!event || seenRef.current.has(event.id)) return;
    seenRef.current.add(event.id);
    setQueue((q) => [...q, event]);
  }, [event]);

  // Pull the next donation off the queue when nothing is showing.
  useEffect(() => {
    if (current || queue.length === 0) return;
    setCurrent(queue[0]);
    setQueue((q) => q.slice(1));
  }, [queue, current]);

  // Play the current alert: bounce in → hold → fade out → clear (→ next).
  useEffect(() => {
    if (!current) return;
    notifySuccess();
    anim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    const seq = Animated.sequence([
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, bounciness: 10, speed: 11 }),
      Animated.delay(HOLD_MS),
      Animated.timing(anim, { toValue: 0, duration: 320, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
    ]);
    seq.start(({ finished }) => { if (finished) setCurrent(null); });
    return () => { seq.stop(); loop.stop(); };
  }, [current, anim, shimmer]);

  if (!current) return null;

  const name = current.name || t('live.donate.someone');
  const amount = fmtCents(current.amountCents);
  const shimmerX = shimmer.interpolate({ inputRange: [0, 1], outputRange: [-120, 220] });

  return (
    <View style={[styles.wrap, { paddingTop: topOffset ?? insets.top + 56 }]} pointerEvents="none">
      <Animated.View
        style={[
          styles.card,
          {
            opacity: anim,
            transform: [
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) },
              { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) },
            ],
          },
        ]}
      >
        {/* GREEN, not the brand orange. Orange is what this app uses for "do
            something" — Share, Create, Follow back — so a tip alert wearing it
            read as another prompt rather than as money that has already arrived.
            Green is the one colour nobody has to be taught here: it is what the
            wallet's balance card is, and this is that number going up. */}
        <LinearGradient colors={GRADIENTS.money as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.grad}>
          {/* Sweep of light for emphasis. */}
          <Animated.View style={[styles.shimmer, { transform: [{ translateX: shimmerX }, { rotate: '18deg' }] }]} />

          <View style={styles.top}>
            {current.avatarUrl ? (
              <Image source={{ uri: current.avatarUrl }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarInitial}>{(name[0] || '?').toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.headText}>
              <Text style={styles.donatedLine} numberOfLines={1}>
                <Text style={styles.donorName}>{name}</Text>
                <Text style={styles.donatedVerb}>{` ${t('live.alert.donated')} `}</Text>
              </Text>
            </View>
            <View style={styles.amountPill}>
              <Ionicons name="gift" size={13} color={GRADIENTS.money[1]} />
              <Text style={styles.amountText}>{amount}</Text>
            </View>
          </View>

          {!!current.message && (
            <Text style={styles.message} numberOfLines={3}>{current.message}</Text>
          )}
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: {
    position: 'absolute', top: 0, left: 0, right: 0,
    alignItems: 'center', paddingHorizontal: SPACING.md,
    zIndex: 90,
  },
  card: {
    width: '100%', maxWidth: 440,
    borderRadius: RADIUS.lg, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 12,
  },
  grad: { paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md, gap: 6, overflow: 'hidden' },
  shimmer: {
    position: 'absolute', top: -40, bottom: -40, width: 60,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  avatar: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)' },
  avatarFallback: { backgroundColor: 'rgba(255,255,255,0.25)', alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { color: '#fff', fontSize: 15, fontWeight: '800' },
  headText: { flex: 1, minWidth: 0 },
  donatedLine: { color: '#fff' },
  donorName: { color: '#fff', fontSize: 15, fontWeight: '900' },
  donatedVerb: { color: 'rgba(255,255,255,0.92)', fontSize: 13.5, fontWeight: '600' },
  amountPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 4,
  },
  // The pill stays white with GREEN ink, so the amount is the highest-contrast
  // thing on the card. It is the one number anyone reads.
  amountText: { color: GRADIENTS.money[1], fontSize: 15, fontWeight: '900' },
  message: { color: '#fff', fontSize: 14, fontWeight: '600', lineHeight: 19, marginLeft: 34 + SPACING.sm },
});
