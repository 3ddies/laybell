import { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSharedValue } from 'react-native-reanimated';
import DjKnob from './DjKnob';
import DjWaveform from './DjWaveform';
import type { Deck } from '../../lib/dj/DjEngine';
import { TEMPO_MIN, TEMPO_MAX } from '../../lib/dj/constants';

// One deck's full surface: track header + load, waveform, EQ/filter/tempo/vol knobs,
// transport, loop, and 4 hot-cue pads. It owns a ~60fps loop that drives the waveform
// playhead (a shared value, so no React churn) and auto-stops at the end of a track.
type Props = {
  deck: Deck;
  color: string;
  track: { title: string; artist: string } | null;
  peaks: Float32Array | null;
  loading: boolean;
  waveWidth: number;
  onLoadPress: () => void;
};

const LOOP_SECONDS = 2; // a fixed time-based loop until Phase-3 adds a beat grid

export default memo(function DjDeck({ deck, color, track, peaks, loading, waveWidth, onLoadPress }: Props) {
  const progress = useSharedValue(0);
  const [playing, setPlaying] = useState(false);
  const [loopOn, setLoopOn] = useState(false);
  const [loopRegion, setLoopRegion] = useState<{ start: number; end: number } | null>(null);
  const [cues, setCues] = useState<boolean[]>([false, false, false, false]);
  const hasTrack = !!track;

  // Playhead + end-of-track handling.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const dur = deck.durationS || 0;
      const pos = deck.position();
      progress.value = dur > 0 ? Math.min(1, pos / dur) : 0;
      if (deck.isPlaying && dur > 0 && pos >= dur - 0.04 && !deck.loopActive) {
        deck.pause();
        setPlaying(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deck, progress]);

  const togglePlay = () => { if (!hasTrack) return; deck.toggle(); setPlaying(deck.isPlaying); };
  const cueToStart = () => { if (!hasTrack) return; deck.seek(0); };
  const toggleLoop = () => {
    if (!hasTrack) return;
    if (loopOn) { deck.clearLoop(); setLoopOn(false); setLoopRegion(null); return; }
    const start = deck.position();
    deck.setLoop(start, LOOP_SECONDS);
    setLoopOn(true);
    const dur = deck.durationS || 1;
    setLoopRegion({ start: start / dur, end: Math.min(1, (start + LOOP_SECONDS) / dur) });
  };
  const cuePad = (i: number) => {
    if (!hasTrack) return;
    const wasSet = cues[i];
    deck.jumpCue(i); // empty slot → drop a cue here; set slot → jump + play
    if (!wasSet) { const next = [...cues]; next[i] = true; setCues(next); }
    else setPlaying(deck.isPlaying);
  };
  const clearCue = (i: number) => {
    if (!cues[i]) return;
    deck.cues[i] = null; // long-press removes a cue so it can be re-dropped
    const next = [...cues]; next[i] = false; setCues(next);
  };

  return (
    <View style={[styles.deck, { borderColor: color + '55' }]}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{track?.title ?? 'Empty deck'}</Text>
          <Text style={[styles.artist, { color }]} numberOfLines={1}>
            {loading ? 'Loading track…' : track?.artist ?? 'Tap Load to pick a song'}
          </Text>
        </View>
        <Pressable style={[styles.loadBtn, { borderColor: color }]} onPress={onLoadPress} disabled={loading}>
          <Ionicons name="musical-notes" size={13} color={color} />
          <Text style={[styles.loadTxt, { color }]}>{hasTrack ? 'Swap' : 'Load'}</Text>
        </Pressable>
      </View>

      <View style={styles.wave}>
        <DjWaveform peaks={peaks} progress={progress} width={waveWidth} height={54} color={color} loop={loopRegion} />
      </View>

      <View style={styles.knobs}>
        <DjKnob label="Low" onChange={(v) => deck.setEq('low', v)} color={color} />
        <DjKnob label="Mid" onChange={(v) => deck.setEq('mid', v)} color={color} />
        <DjKnob label="High" onChange={(v) => deck.setEq('high', v)} color={color} />
        <DjKnob label="Filter" onChange={(v) => deck.setFilter(v)} color={color} />
        <DjKnob label="Tempo" min={TEMPO_MIN} max={TEMPO_MAX} initial={1} resetTo={1} onChange={(v) => deck.setTempo(v)} color={color} />
        <DjKnob label="Vol" min={0} max={1} initial={1} resetTo={1} onChange={(v) => deck.setVolume(v)} color={color} />
      </View>

      <View style={styles.transport}>
        <Pressable style={styles.tBtn} onPress={cueToStart}><Ionicons name="play-skip-back" size={17} color="#fff" /></Pressable>
        <Pressable style={[styles.playBtn, { backgroundColor: color }]} onPress={togglePlay}>
          <Ionicons name={playing ? 'pause' : 'play'} size={22} color="#101013" />
        </Pressable>
        <Pressable style={[styles.tBtn, loopOn && { backgroundColor: color }]} onPress={toggleLoop}>
          <Ionicons name="repeat" size={17} color={loopOn ? '#101013' : '#fff'} />
        </Pressable>
        <View style={styles.cuesCol}>
          <Text style={styles.cuesLabel}>CUES</Text>
          <View style={styles.cues}>
            {[0, 1, 2, 3].map((i) => (
              <Pressable
                key={i}
                style={[styles.cue, cues[i] && { backgroundColor: color, borderColor: color }]}
                onPress={() => cuePad(i)}
                onLongPress={() => clearCue(i)}
                delayLongPress={350}
              >
                {cues[i]
                  ? <Text style={[styles.cueTxt, { color: '#101013' }]}>{i + 1}</Text>
                  : <Ionicons name="add" size={18} color="#6F6F79" />}
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  deck: { backgroundColor: '#141417', borderRadius: 16, borderWidth: 1, padding: 12, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: '#F5F5F5', fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  artist: { fontSize: 12, fontWeight: '600', marginTop: 1 },
  loadBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  loadTxt: { fontSize: 12.5, fontWeight: '800', letterSpacing: 0.2 },
  wave: { backgroundColor: '#0D0D10', borderRadius: 8, overflow: 'hidden' },
  knobs: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#242429', alignItems: 'center', justifyContent: 'center' },
  playBtn: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  cuesCol: { marginLeft: 'auto', alignItems: 'center', gap: 4 },
  cuesLabel: { color: '#6F6F79', fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  cues: { flexDirection: 'row', gap: 6 },
  cue: { width: 38, height: 44, borderRadius: 8, borderWidth: 1.5, borderColor: '#2E2E34', backgroundColor: '#1A1A1D', alignItems: 'center', justifyContent: 'center' },
  cueTxt: { color: '#8A8A92', fontSize: 14, fontWeight: '800' },
});
