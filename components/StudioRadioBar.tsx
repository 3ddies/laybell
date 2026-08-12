import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Image, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS } from '../constants/theme';
import type { RadioTrack } from '../lib/studioRadio';

// The "on air" card — what the room is playing, shown to everyone in a studio
// session. The host's copy carries transport controls; everybody else gets the
// artwork, the names, and a local mute.
//
// It doubles as the discovery surface for the whole feature: this is a Laybell
// song being played to a live audience, so tapping it opens the record. A
// listener who likes what they hear is one tap from the artist.

const BARS = [0, 1, 2, 3];
const BAR_MS = [520, 700, 610, 780];

const EqBars = memo(function EqBars({ animate }: { animate: boolean }) {
  const vals = useRef(BARS.map(() => new Animated.Value(0.35))).current;
  useEffect(() => {
    if (!animate) {
      vals.forEach((v) => v.setValue(0.35));
      return;
    }
    const loops = vals.map((v, i) => Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: BAR_MS[i], easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0.3, duration: BAR_MS[i], easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [animate, vals]);
  return (
    <View style={styles.eq}>
      {vals.map((v, i) => (
        <Animated.View key={i} style={[styles.eqBar, { transform: [{ scaleY: v }] }]} />
      ))}
    </View>
  );
});

// A volume control, built here because the project carries no slider package
// and this needs exactly one behaviour: drag a bar, get a number 0–1.
//
// It is LOCAL. The room is unaffected — this is how loud the song is in the
// holder's own ears, which is the whole point: a host talking over a record
// needs it down without taking it down for the audience.
const VolumeSlider = memo(function VolumeSlider({
  value, onChange,
}: { value: number; onChange: (v: number) => void }) {
  const width = useRef(1);
  const set = (x: number) => onChange(Math.max(0, Math.min(1, x / width.current)));
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => set(e.nativeEvent.locationX),
      onPanResponderMove: (e) => set(e.nativeEvent.locationX),
    }),
  ).current;
  return (
    <View
      style={styles.sliderHit}
      onLayout={(e) => { width.current = Math.max(1, e.nativeEvent.layout.width); }}
      {...pan.panHandlers}
    >
      <View style={styles.sliderTrack}>
        <View style={[styles.sliderFill, { width: `${Math.round(value * 100)}%` }]} />
      </View>
      <View style={[styles.sliderKnob, { left: `${Math.round(value * 100)}%` }]} />
    </View>
  );
});

type Props = {
  track: RadioTrack;
  paused: boolean;
  /** Host-only transport. Omit them all and the card is read-only. */
  onPause?: () => void;
  onResume?: () => void;
  onPrevious?: () => void;
  onSkip?: () => void;
  onStop?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  queueCount?: number;
  volume: number;
  onVolume: (v: number) => void;
  localMuted: boolean;
  onToggleMute: () => void;
  onOpenTrack?: (id: string) => void;
  busy?: boolean;
  labels: {
    onAir: string;
    queued: (n: number) => string;
    mute: string;
    unmute: string;
    volume: string;
  };
};

function StudioRadioBar({
  track, paused, onPause, onResume, onPrevious, onSkip, onStop,
  hasPrevious, hasNext, queueCount = 0,
  volume, onVolume, localMuted, onToggleMute, onOpenTrack, busy, labels,
}: Props) {
  const isHost = !!(onPause || onResume);
  const [volOpen, setVolOpen] = useState(false);
  const reduceRef = useRef(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) reduceRef.current = !!v; });
    return () => { alive = false; };
  }, []);

  return (
    <View style={styles.wrap}>
      <LinearGradient
        colors={['rgba(242,101,34,0.20)', 'rgba(232,64,28,0.06)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <TouchableOpacity
        style={styles.row}
        activeOpacity={onOpenTrack ? 0.75 : 1}
        disabled={!onOpenTrack}
        accessibilityRole={onOpenTrack ? 'button' : undefined}
        accessibilityLabel={`${labels.onAir}: ${track.title}`}
        onPress={() => onOpenTrack?.(track.id)}
      >
        {track.cover ? (
          <Image source={{ uri: track.cover }} style={styles.cover} />
        ) : (
          <LinearGradient colors={GRADIENTS.primary} style={styles.cover}>
            <Ionicons name="musical-note" size={20} color="#fff" />
          </LinearGradient>
        )}

        <View style={styles.textWrap}>
          <View style={styles.tagRow}>
            <EqBars animate={!paused && !localMuted && !reduceRef.current} />
            <Text style={styles.onAir} numberOfLines={1}>
              {labels.onAir}{queueCount > 0 ? `  ·  ${labels.queued(queueCount)}` : ''}
            </Text>
          </View>
          <Text style={styles.title} numberOfLines={1}>{track.title}</Text>
          {!!track.artist && <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>}
        </View>

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={labels.volume}
          onPress={() => setVolOpen((v) => !v)}
          onLongPress={onToggleMute}
          style={styles.iconBtn}
          hitSlop={8}
        >
          <Ionicons
            name={localMuted || volume === 0 ? 'volume-mute' : volume < 0.45 ? 'volume-low' : 'volume-high'}
            size={18}
            color={localMuted ? '#F43F5E' : '#fff'}
          />
        </TouchableOpacity>
      </TouchableOpacity>

      {volOpen && (
        <View style={styles.volRow}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={localMuted ? labels.unmute : labels.mute}
            onPress={onToggleMute}
            hitSlop={8}
          >
            <Ionicons name={localMuted ? 'volume-mute' : 'volume-off'} size={16} color={localMuted ? '#F43F5E' : 'rgba(255,255,255,0.75)'} />
          </TouchableOpacity>
          <VolumeSlider value={localMuted ? 0 : volume} onChange={onVolume} />
          <Text style={styles.volPct}>{Math.round((localMuted ? 0 : volume) * 100)}</Text>
        </View>
      )}

      {isHost && (
        <View style={styles.controls}>
          {/* Previous is never disabled: deep into a song it restarts the
              track, which is useful even when there is nothing behind it. */}
          <TouchableOpacity accessibilityRole="button" onPress={onPrevious} style={styles.ctrl}>
            <Ionicons name="play-skip-back" size={17} color={hasPrevious ? '#fff' : 'rgba(255,255,255,0.75)'} />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={paused ? onResume : onPause}
            style={styles.ctrlPrimary}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Ionicons name={paused ? 'play' : 'pause'} size={18} color="#fff" />}
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={onSkip} style={styles.ctrl} disabled={!hasNext}>
            <Ionicons name="play-skip-forward" size={17} color={hasNext ? '#fff' : 'rgba(255,255,255,0.35)'} />
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={onStop} style={styles.ctrl}>
            <Ionicons name="stop" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(242,101,34,0.35)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 11 },
  cover: { width: 48, height: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  textWrap: { flex: 1, gap: 2 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  onAir: { color: '#FAB525', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
  title: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
  artist: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  iconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  eq: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 12 },
  eqBar: { width: 2.5, height: 12, borderRadius: 1.5, backgroundColor: '#FAB525' },
  volRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, paddingBottom: 11 },
  sliderHit: { flex: 1, height: 26, justifyContent: 'center' },
  sliderTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  sliderFill: { height: 4, borderRadius: 2, backgroundColor: '#FAB525' },
  sliderKnob: { position: 'absolute', width: 13, height: 13, borderRadius: 7, backgroundColor: '#fff', marginLeft: -6.5 },
  volPct: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '700', width: 26, textAlign: 'right' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11, paddingBottom: 11 },
  ctrlPrimary: {
    flex: 1, height: 38, borderRadius: 19, backgroundColor: 'rgba(242,101,34,0.85)',
    alignItems: 'center', justifyContent: 'center',
  },
  ctrl: {
    width: 44, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center',
  },
});

export default memo(StudioRadioBar);
