import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { Room } from 'livekit-client';
import { GRADIENTS } from '../constants/theme';
import type { StudioMember } from '../lib/studio';

// The stage an AUDIENCE member sees during a live studio session — the artists
// on air, and a field that moves with what they are actually saying.
//
// Everything here is driven by real audio. LiveKit gives every participant an
// `audioLevel`, so the bars, the halos and the ambient glow are an envelope of
// the room rather than decoration on a timer: quiet room, flat field. That is
// the whole point — a listener should be able to tell someone is about to
// speak before they hear it.
//
// The catch is that `audioLevel` refreshes on the server's speaker updates,
// which is a few times a second, not sixty. Driving bar heights straight off
// it would step visibly. So each bar carries its own slow, native-driven
// wobble loop and the room's level only scales it: motion stays smooth at any
// update rate, and the level decides how big that motion is. One JS-driven
// value for the whole field, N cheap native loops — nothing per-frame crosses
// the bridge.
//
// Reduce Motion renders the same field at rest, matching PremiumBubbles.

const BARS = 15;
const BAR_W = 4;
const BAR_GAP = 5;
const BAR_H = 92;

// Shape of the field at full level: tall in the middle, low at the edges, so
// it reads as a waveform rather than a bar chart. A little asymmetry keeps it
// from looking like a rendered curve.
const PEAKS = [0.34, 0.46, 0.62, 0.78, 0.9, 1, 0.94, 1, 0.88, 0.8, 0.66, 0.52, 0.44, 0.36, 0.3];
const IDLES = [0.1, 0.12, 0.14, 0.17, 0.19, 0.22, 0.2, 0.22, 0.19, 0.18, 0.15, 0.13, 0.12, 0.1, 0.09];

// Wobble periods, deliberately coprime-ish so the field never resynchronises
// into a single pulsing block.
const WOBBLE_MS = [1130, 1490, 970, 1310, 1670, 1050, 1390, 890, 1550, 1210, 1010, 1450, 930, 1250, 1610];

// Speech rarely pushes audioLevel far above ~0.3, so without a gain the field
// would barely twitch. Clamped, and paired with a floor in the interpolation
// so a whisper still shows.
const LEVEL_GAIN = 3.4;
const SAMPLE_MS = 100;
const SMOOTH_MS = 150;
const ON_MIC_HOLD_MS = 1400;

// The circles are the screen. A studio session is usually one to four people,
// so they get to be big — at those sizes a face is recognisable across a room
// and the speaking halo is unmissable. Past four we fall back to a grid, since
// a wrapped row of large circles just pushes the field off the bottom.
function avatarSize(count: number) {
  if (count <= 1) return 156;
  if (count === 2) return 132;
  if (count === 3) return 112;
  if (count === 4) return 96;
  return 78;
}

const BAR_COLORS = Array.from({ length: BARS }, (_, i) => {
  // #E8401C → #FAB525 across the row, computed once.
  const t = i / (BARS - 1);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(0xe8, 0xfa)},${lerp(0x40, 0xb5)},${lerp(0x1c, 0x25)})`;
});

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduce(!!v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(!!v));
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  return reduce;
}

/** The LIVE badge's dot, breathing. Pure native loop — no audio involved. */
export const LiveDot = memo(function LiveDot() {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 720, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 720, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, v]);
  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[
          styles.dotHalo,
          { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }] },
        ]}
      />
      <View style={styles.dotCore} />
    </View>
  );
});

/** Listener count that pops when it changes, so arrivals are felt not just read. */
export const CountPop = memo(function CountPop({ value }: { value: number }) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(1)).current;
  const seen = useRef(value);
  useEffect(() => {
    if (seen.current === value) return;
    seen.current = value;
    if (reduce) return;
    Animated.sequence([
      Animated.timing(v, { toValue: 1.28, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(v, { toValue: 1, friction: 4, tension: 140, useNativeDriver: true }),
    ]).start();
  }, [value, reduce, v]);
  return (
    <Animated.Text style={[styles.countText, { transform: [{ scale: v }] }]}>{value}</Animated.Text>
  );
});

type Props = {
  room: Room | null;
  roster: StudioMember[];
  onPressMember: (userId: string) => void;
  hostLabel: string;
};

function StudioStage({ room, roster, onPressMember, hostLabel }: Props) {
  const reduce = useReduceMotion();

  // One Animated.Value per member plus one for the room. Kept in a ref and
  // driven by short timings, so a level update never re-renders the tree.
  const levels = useRef(new Map<string, Animated.Value>()).current;
  const roomLevel = useRef(new Animated.Value(0)).current;
  const [onMic, setOnMic] = useState<string | null>(null);
  const heldAt = useRef(0);
  // Who is ACTUALLY in the room. The roster is the database's answer — every
  // seat ever granted — so on its own it left the face of someone who had
  // closed the app hours ago sitting on stage. LiveKit's participant list is
  // the honest one, and it is also what makes a host removing someone take
  // effect on the audience's screen within a tick rather than at the next
  // 25-second roster poll.
  const [present, setPresent] = useState<string[] | null>(null);

  // Stable across renders — `levels` is a ref-held Map — so the sampling effect
  // below is not torn down and rebuilt on every render.
  const levelFor = useCallback((id: string) => {
    let v = levels.get(id);
    if (!v) { v = new Animated.Value(0); levels.set(id, v); }
    return v;
  }, [levels]);
  // Called during render for members that appear mid-session; safe because it
  // only ever adds to a ref-held map.
  roster.forEach((m) => levelFor(m.user_id));

  useEffect(() => {
    if (!room) return;
    let alive = true;
    const drive = (v: Animated.Value, to: number) => {
      Animated.timing(v, { toValue: to, duration: SMOOTH_MS, useNativeDriver: true }).start();
    };
    const tick = () => {
      if (!alive) return;
      let peak = 0;
      let loudest = 0;
      let loudestId: string | null = null;
      const seen = new Set<string>();
      room.remoteParticipants.forEach((p: any) => {
        const lv = Math.max(0, Math.min(1, (p.audioLevel || 0) * LEVEL_GAIN));
        seen.add(p.identity);
        drive(levelFor(p.identity), lv);
        // The FIELD follows any audio in the room, deliberately including the
        // producer's beat — a listener tuning in during an instrumental should
        // see the music, not a dead screen. Only the NAME below is gated on
        // isSpeaking, since a beat has no one to credit.
        if (lv > peak) peak = lv;
        if (p.isSpeaking && lv > loudest) { loudest = lv; loudestId = p.identity; }
      });
      // Anyone in the roster the room is not reporting has gone quiet or left.
      levels.forEach((v, id) => { if (!seen.has(id)) drive(v, 0); });
      drive(roomLevel, peak);
      // Only re-render when the set of people in the room actually changes —
      // this runs ten times a second.
      const ids = [...seen].sort();
      setPresent((prev) =>
        prev && prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids);
      // `isSpeaking` drops between words, so writing it straight through would
      // blink the name out mid-sentence. Hold the last speaker briefly and only
      // clear once the pause is longer than a breath.
      if (loudestId) {
        heldAt.current = Date.now();
        setOnMic((prev) => (prev === loudestId ? prev : loudestId));
      } else if (Date.now() - heldAt.current > ON_MIC_HOLD_MS) {
        setOnMic((prev) => (prev === null ? prev : null));
      }
    };
    tick();
    const iv = setInterval(tick, SAMPLE_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [room, levels, levelFor, roomLevel]);

  // `present` is null only until the first sample lands. Falling back to the
  // roster for that one tick avoids an empty stage flashing on connect;
  // afterwards an empty list is the truth and is rendered as one.
  const onAir = present === null ? roster : roster.filter((m) => present.includes(m.user_id));
  const onMicName = onMic
    ? (() => { const m = onAir.find((r) => r.user_id === onMic); return m?.display_name || m?.username || null; })()
    : null;
  const size = avatarSize(onAir.length);

  return (
    <View style={styles.stage} pointerEvents="box-none">
      {/* Ambient wash behind everything, brightening with the room. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.glow,
          { opacity: reduce ? 0.16 : roomLevel.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.34] }) },
        ]}
      >
        <LinearGradient colors={['#FFFFFF40', '#FFFFFF00']} style={StyleSheet.absoluteFill} />
      </Animated.View>

      {/* On-air artists */}
      <View style={styles.grid}>
        {onAir.map((m) => (
          <SpeakerTile
            key={m.user_id}
            member={m}
            size={size}
            level={levelFor(m.user_id)}
            reduce={reduce}
            hostLabel={hostLabel}
            onPress={() => onPressMember(m.user_id)}
          />
        ))}
      </View>

      {/* The field */}
      <View style={styles.bars} pointerEvents="none">
        {BAR_COLORS.map((color, i) => (
          <Bar key={i} index={i} color={color} level={roomLevel} reduce={reduce} />
        ))}
      </View>

      {/* Who is on the mic right now. A glyph and a name — no copy, so it needs
          no translation and reads the same in every language. */}
      <View style={styles.onMic} pointerEvents="none">
        {!!onMicName && (
          <>
            <Ionicons name="mic" size={13} color="#FAB525" />
            <Text style={styles.onMicName} numberOfLines={1}>{onMicName}</Text>
          </>
        )}
      </View>
    </View>
  );
}

const Bar = memo(function Bar({
  index, color, level, reduce,
}: { index: number; color: string; level: Animated.Value; reduce: boolean }) {
  const wob = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (reduce) return;
    const dur = WOBBLE_MS[index % WOBBLE_MS.length];
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(wob, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(wob, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [index, reduce, wob]);

  const envelope = level.interpolate({
    inputRange: [0, 1],
    outputRange: [IDLES[index % IDLES.length], PEAKS[index % PEAKS.length]],
    extrapolate: 'clamp',
  });
  const scaleY = reduce
    ? envelope
    : Animated.multiply(envelope, wob.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1.28] }));

  return <Animated.View style={[styles.bar, { backgroundColor: color, transform: [{ scaleY }] }]} />;
});

const SpeakerTile = memo(function SpeakerTile({
  member, size, level, reduce, hostLabel, onPress,
}: {
  member: StudioMember;
  size: number;
  level: Animated.Value;
  reduce: boolean;
  hostLabel: string;
  onPress: () => void;
}) {
  const name = member.display_name || member.username || '';
  // Three layers of the same signal, so it reads at a glance and up close:
  // a soft white bloom that swells, a crisp ring that snaps on, and the whole
  // circle lifting very slightly. White rather than brand orange — against the
  // orange field below it, a white bloom is what makes the screen look lit
  // rather than tinted.
  const clamp = 'clamp' as const;
  const bloom = {
    opacity: level.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.28, 0.58], extrapolate: clamp }),
    transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.34], extrapolate: clamp }) }],
  };
  const ring = {
    opacity: level.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0.12, 0.85, 1], extrapolate: clamp }),
  };
  const lift = {
    transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05], extrapolate: clamp }) }],
  };

  const wrap = { width: size, height: size, borderRadius: size / 2 };
  const inner = size - 10;
  return (
    <TouchableOpacity style={[styles.tile, { width: size + 12 }]} onPress={onPress} activeOpacity={0.85}>
      <Animated.View style={[styles.tileAvatarWrap, wrap, reduce ? null : lift]}>
        {!reduce && <Animated.View style={[styles.bloom, wrap, bloom]} pointerEvents="none" />}
        <Animated.View
          style={[styles.ring, wrap, { borderWidth: size >= 112 ? 3 : 2.5 }, ring]}
          pointerEvents="none"
        />
        {member.avatar_url ? (
          <Image source={{ uri: member.avatar_url }} style={[styles.tileAvatar, { width: inner, height: inner, borderRadius: inner / 2 }]} />
        ) : (
          <LinearGradient colors={GRADIENTS.avatar} style={[styles.tileAvatar, { width: inner, height: inner, borderRadius: inner / 2 }]}>
            <Text style={[styles.tileInitial, { fontSize: Math.round(inner * 0.36) }]}>
              {(name || '?').charAt(0).toUpperCase()}
            </Text>
          </LinearGradient>
        )}
      </Animated.View>
      <Text style={[styles.tileName, { maxWidth: size + 10 }]} numberOfLines={1}>{name}</Text>
      {member.role === 'host' && <Text style={styles.hostTag}>{hostLabel}</Text>}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  stage: { alignItems: 'center', justifyContent: 'center' },
  glow: {
    position: 'absolute', top: -80, left: -100, right: -100, height: 360,
    borderRadius: 360, overflow: 'hidden',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, justifyContent: 'center', paddingHorizontal: 16 },
  tile: { alignItems: 'center', gap: 9 },
  tileAvatarWrap: { alignItems: 'center', justifyContent: 'center' },
  bloom: { position: 'absolute', backgroundColor: '#fff' },
  ring: { position: 'absolute', borderColor: 'rgba(255,255,255,0.92)' },
  tileAvatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  tileInitial: { color: '#fff', fontWeight: '700' },
  tileName: { color: '#fff', fontSize: 13.5, fontWeight: '700' },
  hostTag: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  bars: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: BAR_GAP, height: BAR_H, marginTop: 30,
  },
  bar: { width: BAR_W, height: BAR_H, borderRadius: BAR_W / 2 },
  onMic: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 20, marginTop: 10 },
  onMicName: { color: 'rgba(255,255,255,0.82)', fontSize: 12.5, fontWeight: '700', maxWidth: 200 },
  dotWrap: { width: 6, height: 6, alignItems: 'center', justifyContent: 'center' },
  dotHalo: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  dotCore: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  countText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});

export default memo(StudioStage);
