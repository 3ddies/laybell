import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Dimensions, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { DjEngine } from '../lib/dj/DjEngine';
import type { DeckId } from '../lib/dj/constants';
import DjDeck, { type ProFx } from '../components/dj/DjDeck';
import DjCrossfader from '../components/dj/DjCrossfader';
import SongPickerModal, { type PickedSong } from '../components/SongPickerModal';
import { supabase } from '../lib/supabase';
import { usePostMusicActions } from '../contexts/PostMusicContext';
import { usePremium } from '../contexts/PremiumContext';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SCREEN_W = Dimensions.get('window').width;
const WAVE_W = SCREEN_W - 28 /* screen padding */ - 24 /* deck padding */;
const COLOR_A = '#F26522'; // deck A — brand orange
const COLOR_B = '#3FA7FF'; // deck B — contrasting blue

type Track = { title: string; artist: string } | null;

export default function DjBoothScreen() {
  const router = useRouter();
  const music = usePostMusicActions();
  const engineRef = useRef<DjEngine | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // The engine lives in a ref (imperative, no re-render on its internals), but we need
  // ONE render once it exists — a ref assignment doesn't trigger that, which left the
  // decks gated on a null ref and the screen blank. This flag flips them on.
  const [ready, setReady] = useState(false);

  const [trackA, setTrackA] = useState<Track>(null);
  const [trackB, setTrackB] = useState<Track>(null);
  const [peaksA, setPeaksA] = useState<Float32Array | null>(null);
  const [peaksB, setPeaksB] = useState<Float32Array | null>(null);
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);
  const [picker, setPicker] = useState<DeckId | null>(null);

  // ── Pro mode (Premium perk) ──────────────────────────────────────────────────
  const { isPremium } = usePremium();
  const [mode, setMode] = useState<'simple' | 'pro'>('simple'); // Simple is the default (owner: clean + simple)
  const [bpmA, setBpmA] = useState<number | null>(null);
  const [bpmB, setBpmB] = useState<number | null>(null);

  // Restore the saved mode once — Pro only if the viewer is actually Premium (a lapsed
  // member drops back to Simple). Default stays Simple.
  useEffect(() => {
    AsyncStorage.getItem('dj:mode').then((m) => { if (m === 'pro' && isPremium) setMode('pro'); }).catch(() => {});
  }, [isPremium]);

  const selectMode = (m: 'simple' | 'pro') => {
    if (m === 'pro' && !isPremium) { router.push('/premium'); return; } // Pro is gated behind the paywall
    setMode(m);
    AsyncStorage.setItem('dj:mode', m).catch(() => {});
  };

  const syncDeck = (d: DeckId): 'locked' | 'near' | 'unavailable' => {
    const engine = engineRef.current;
    if (!engine) return 'unavailable';
    const r = engine.deck(d).syncTo(engine.deck(d === 'a' ? 'b' : 'a'));
    (d === 'a' ? setBpmA : setBpmB)(engine.deck(d).bpm); // reflect the nudged tempo in the readout
    return r;
  };

  const fxDeck = (d: DeckId, fx: ProFx) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (fx === 'echo') engine.fxEcho(d);
    else if (fx === 'reverb') engine.fxReverb(d);
    else if (fx === 'riser') engine.fxRiser();
    else if (fx === 'chop') engine.fxChop(d);
    else if (fx === 'sweepDown') engine.fxSweepDown(d);
    else if (fx === 'sweepUp') engine.fxSweepUp(d);
  };

  useEffect(() => {
    let engine: DjEngine | null = null;
    try {
      // Loaded lazily, NOT as a top-level import: react-native-audio-api installs its
      // native bindings the instant its JS is imported and throws "failed to install"
      // on a build that predates the module. A static import would therefore crash the
      // whole app at startup (Expo Router evaluates every route file). Opening the booth
      // on an old build throws HERE instead — caught → the "needs a build" screen.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../lib/dj/DjEngine') as typeof import('../lib/dj/DjEngine');
      engine = new mod.DjEngine();
      engineRef.current = engine;
      setReady(true);
    } catch {
      setUnavailable(true);
      return;
    }
    engine.init();
    // The booth owns the audio from here; silence the feed's music player.
    try { music.stop(); } catch {}
    return () => { engine?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSong(d: DeckId, song: PickedSong) {
    setPicker(null);
    const engine = engineRef.current;
    if (!engine) return;
    const setLoading = d === 'a' ? setLoadingA : setLoadingB;
    const setTrack = d === 'a' ? setTrackA : setTrackB;
    const setPeaks = d === 'a' ? setPeaksA : setPeaksB;
    setLoading(true);
    try {
      const { data } = await supabase.from('posts').select('media_url').eq('id', song.id).single();
      const url = (data as any)?.media_url as string | undefined;
      if (!url) throw new Error('no media url');
      await engine.deck(d).load(url);
      setPeaks(engine.deck(d).peaks(440));
      (d === 'a' ? setBpmA : setBpmB)(engine.deck(d).bpm); // detected tempo for the Pro readout
      setTrack({ title: song.title, artist: song.artist });
    } catch {
      Alert.alert("Couldn't load that track", 'Try a different song.');
    } finally {
      setLoading(false);
    }
  }

  if (unavailable) {
    return (
      <SafeAreaView style={styles.container}>
        <Header onBack={() => router.back()} />
        <View style={styles.center}>
          <Ionicons name="disc-outline" size={48} color="#45454D" />
          <Text style={styles.unavailTitle}>DJ Booth needs the latest build</Text>
          <Text style={styles.unavailBody}>
            The booth uses a native audio engine that isn't in this build yet. Install the new
            development build and reopen it.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Header
        onBack={() => { router.back(); }}
        mode={mode}
        isPremium={isPremium}
        onSelectMode={selectMode}
      />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {ready && engineRef.current && (
          <>
            <DjDeck
              deck={engineRef.current.a}
              color={COLOR_A}
              track={trackA}
              peaks={peaksA}
              loading={loadingA}
              waveWidth={WAVE_W}
              onLoadPress={() => setPicker('a')}
              onTapeStop={() => engineRef.current?.deck('a').tapeStop()}
              onTapeStart={() => engineRef.current?.deck('a').tapeStart()}
              onRoll={() => engineRef.current?.deck('a').roll()}
              onReverse={() => engineRef.current?.deck('a').reverse()}
              pro={mode === 'pro'}
              bpm={bpmA}
              onSync={() => syncDeck('a')}
              onFx={(fx) => fxDeck('a', fx)}
            />
            <DjCrossfader onChange={(x) => engineRef.current?.crossfade(x)} colorA={COLOR_A} colorB={COLOR_B} />
            <DjDeck
              deck={engineRef.current.b}
              color={COLOR_B}
              track={trackB}
              peaks={peaksB}
              loading={loadingB}
              waveWidth={WAVE_W}
              onLoadPress={() => setPicker('b')}
              onTapeStop={() => engineRef.current?.deck('b').tapeStop()}
              onTapeStart={() => engineRef.current?.deck('b').tapeStart()}
              onRoll={() => engineRef.current?.deck('b').roll()}
              onReverse={() => engineRef.current?.deck('b').reverse()}
              pro={mode === 'pro'}
              bpm={bpmB}
              onSync={() => syncDeck('b')}
              onFx={(fx) => fxDeck('b', fx)}
            />
          </>
        )}
      </ScrollView>

      <SongPickerModal
        visible={picker !== null}
        onClose={() => setPicker(null)}
        onSelect={(song) => { if (picker) loadSong(picker, song); }}
      />
    </SafeAreaView>
  );
}

function Header({ onBack, mode, isPremium, onSelectMode }: {
  onBack: () => void;
  mode?: 'simple' | 'pro';
  isPremium?: boolean;
  onSelectMode?: (m: 'simple' | 'pro') => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.back}>
        <Ionicons name="chevron-down" size={24} color="#F5F5F5" />
      </Pressable>
      <Text style={styles.hTitle}>DJ Booth</Text>
      <View style={styles.betaTag}><Text style={styles.betaTxt}>BETA</Text></View>
      {/* Compact Simple/Pro switch in the header slot (not a full-width bar). Only on the
          live booth — the "needs a build" screen renders the Header without these props. */}
      {mode && onSelectMode && (
        <View style={styles.modeSeg}>
          <Pressable style={[styles.modeSegBtn, mode === 'simple' && styles.modeSegOn]} onPress={() => onSelectMode('simple')}>
            <Text style={[styles.modeSegTxt, mode === 'simple' && styles.modeSegTxtOn]}>Simple</Text>
          </Pressable>
          <Pressable style={[styles.modeSegBtn, mode === 'pro' && styles.modeSegOn]} onPress={() => onSelectMode('pro')}>
            <Ionicons name={isPremium ? 'sparkles' : 'lock-closed'} size={11} color={mode === 'pro' ? '#101013' : isPremium ? '#F5F5F5' : '#8A8A92'} />
            <Text style={[styles.modeSegTxt, mode === 'pro' && styles.modeSegTxtOn]}>Pro</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0C' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  back: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  hTitle: { color: '#F5F5F5', fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  betaTag: { backgroundColor: '#242429', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  betaTxt: { color: '#8A8A92', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  scroll: { padding: 14, gap: 14, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 36 },
  unavailTitle: { color: '#F5F5F5', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  unavailBody: { color: '#8A8A92', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  modeSeg: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A1D', borderRadius: 9, padding: 3, gap: 2, marginLeft: 'auto' },
  modeSegBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7 },
  modeSegOn: { backgroundColor: '#F26522' },
  modeSegTxt: { color: '#8A8A92', fontSize: 11.5, fontWeight: '800', letterSpacing: 0.2 },
  modeSegTxtOn: { color: '#101013' },
});
