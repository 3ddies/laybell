import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Modal, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GRADIENTS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { myRadioSongs, searchRadioSongs, type RadioTrack } from '../lib/studioRadio';

// The host's record crate. Two tabs, because the two things a host actually
// wants are "play my own record" and "play that song I heard" — and an empty
// search box is a bad answer to either.
//
// Tapping a song puts it on air if nothing is playing, or on the end of the
// queue if something is. The row says which happened, so the host never has to
// guess whether that tap did anything.

type Tab = 'mine' | 'all';

type Props = {
  visible: boolean;
  userId: string | null;
  queue: RadioTrack[];
  nowPlayingId: string | null;
  onPick: (t: RadioTrack) => 'playing' | 'queued';
  onRemoveQueued: (id: string) => void;
  onClose: () => void;
  labels: {
    title: string; mine: string; all: string; search: string;
    empty: string; queue: string; nowPlaying: string; queued: string; play: string;
  };
};

export default function StudioRadioPicker({
  visible, userId, queue, nowPlayingId, onPick, onRemoveQueued, onClose, labels,
}: Props) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('mine');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<RadioTrack[]>([]);
  const [loading, setLoading] = useState(false);
  // id -> what just happened to it, so the row can say so for a moment.
  const [flash, setFlash] = useState<Record<string, 'playing' | 'queued'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = tab === 'mine' && userId
        ? await myRadioSongs(userId)
        : await searchRadioSongs(term);
      setRows(data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, term, userId]);

  useEffect(() => {
    if (!visible) return;
    // Debounced so typing doesn't fire a query per keystroke.
    const h = setTimeout(load, term ? 280 : 0);
    return () => clearTimeout(h);
  }, [visible, load, term]);

  function pick(t: RadioTrack) {
    const what = onPick(t);
    setFlash((f) => ({ ...f, [t.id]: what }));
    setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[t.id]; return n; }), 1600);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 10 }]}>
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text style={styles.title}>{labels.title}</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={10} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color="#fff" />
            </TouchableOpacity>
          </View>

          <View style={styles.tabs}>
            {(['mine', 'all'] as Tab[]).map((k) => (
              <TouchableOpacity
                key={k}
                style={[styles.tab, tab === k && styles.tabOn]}
                onPress={() => setTab(k)}
                accessibilityRole="button"
              >
                <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>
                  {k === 'mine' ? labels.mine : labels.all}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {tab === 'all' && (
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={16} color="rgba(255,255,255,0.5)" />
              <TextInput
                style={styles.search}
                placeholder={labels.search}
                placeholderTextColor="rgba(255,255,255,0.4)"
                value={term}
                onChangeText={setTerm}
                autoCorrect={false}
                returnKeyType="search"
              />
              {!!term && (
                <TouchableOpacity onPress={() => setTerm('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color="rgba(255,255,255,0.5)" />
                </TouchableOpacity>
              )}
            </View>
          )}

          {!!queue.length && (
            <View style={styles.queueWrap}>
              <Text style={styles.queueTitle}>{labels.queue} · {queue.length}</Text>
              <FlatList
                horizontal
                data={queue}
                keyExtractor={(t) => t.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.queueChip}
                    onPress={() => onRemoveQueued(item.id)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.queueChipText} numberOfLines={1}>{item.title}</Text>
                    <Ionicons name="close" size={13} color="rgba(255,255,255,0.7)" />
                  </TouchableOpacity>
                )}
              />
            </View>
          )}

          {loading ? (
            <ActivityIndicator style={{ marginTop: 28 }} color="#F26522" />
          ) : (
            <FlatList
              data={rows}
              keyExtractor={(t) => t.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: 12 }}
              ListEmptyComponent={<Text style={styles.empty}>{labels.empty}</Text>}
              renderItem={({ item }) => {
                const f = flash[item.id];
                const live = nowPlayingId === item.id;
                return (
                  <TouchableOpacity style={styles.row} onPress={() => pick(item)} activeOpacity={0.75}>
                    {item.cover ? (
                      <Image source={{ uri: item.cover }} style={styles.cover} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.primary} style={styles.cover}>
                        <Ionicons name="musical-note" size={16} color="#fff" />
                      </LinearGradient>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                      {!!item.artist && <Text style={styles.rowArtist} numberOfLines={1}>{item.artist}</Text>}
                    </View>
                    {live ? (
                      <Text style={styles.badgeLive}>{labels.nowPlaying}</Text>
                    ) : f ? (
                      <Text style={styles.badgeFlash}>{f === 'playing' ? labels.play : labels.queued}</Text>
                    ) : (
                      <Ionicons name="add-circle-outline" size={22} color="rgba(255,255,255,0.6)" />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '86%', backgroundColor: '#141318', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16 },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', marginTop: 9, marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  title: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '800' },
  closeBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)' },
  tabOn: { backgroundColor: c.primary },
  tabText: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: '#fff' },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 14, marginBottom: 10,
  },
  search: { flex: 1, color: '#fff', fontSize: 14 },
  queueWrap: { gap: 7, marginBottom: 12 },
  queueTitle: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  queueChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 190,
    backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 999, paddingLeft: 12, paddingRight: 9, paddingVertical: 7,
  },
  queueChipText: { color: '#fff', fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  cover: { width: 42, height: 42, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  rowTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  rowArtist: { color: 'rgba(255,255,255,0.55)', fontSize: 12 },
  badgeLive: { color: '#FAB525', fontSize: 10.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  badgeFlash: { color: '#22C55E', fontSize: 10.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  empty: { color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center', marginTop: 28 },
});
