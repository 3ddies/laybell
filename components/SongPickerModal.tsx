import {
  View, Text, StyleSheet, Modal, FlatList, TextInput,
  TouchableOpacity, ActivityIndicator, Image, Keyboard,
} from 'react-native';
import { useEffect, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { formatCount } from '../lib/format';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

export type PickedSong = {
  id: string;
  title: string;
  artist: string;
  artistId: string;
};

// Pick another creator's track to use on your image/video/story. Searches public
// audio (music/podcast/audiobook) by song name or artist; defaults to trending.
export default function SongPickerModal({ visible, onClose, onSelect }: {
  visible: boolean;
  onClose: () => void;
  onSelect: (song: PickedSong) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (visible) { setQuery(''); runSearch(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => runSearch(query), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function runSearch(q: string) {
    setLoading(true);
    const term = q.trim();
    let req = supabase
      .from('posts')
      .select('id, caption, cover_url, user_id, stream_count, profiles!posts_user_id_fkey(id, username, display_name, avatar_url)')
      .eq('is_public', true)
      .in('type', ['audio', 'podcast', 'audiobook'])
      .limit(30);

    if (term) {
      // Also match by artist: find matching profiles, then OR their tracks in.
      const { data: profs } = await supabase
        .from('profiles').select('id').or(`username.ilike.%${term}%,display_name.ilike.%${term}%`).limit(15);
      const ids = (profs ?? []).map((p: any) => p.id);
      req = ids.length
        ? req.or(`caption.ilike.%${term}%,user_id.in.(${ids.join(',')})`)
        : req.ilike('caption', `%${term}%`);
    } else {
      req = req.order('stream_count', { ascending: false });
    }

    const { data } = await req;
    setResults(data ?? []);
    setLoading(false);
  }

  function pick(item: any) {
    Keyboard.dismiss();
    onSelect({
      id: item.id,
      title: item.caption || 'Audio track',
      artist: item.profiles?.display_name || item.profiles?.username || 'Unknown artist',
      artistId: item.profiles?.id || item.user_id,
    });
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text style={styles.title}>Add music</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textSecondary} /></TouchableOpacity>
          </View>

          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={18} color={COLORS.textTertiary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search songs or artists..."
              placeholderTextColor={COLORS.textTertiary}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close-circle" size={18} color={COLORS.textTertiary} />
              </TouchableOpacity>
            )}
          </View>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
          ) : results.length === 0 ? (
            <View style={styles.center}><Text style={styles.empty}>No songs found</Text></View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => pick(item)} activeOpacity={0.8}>
                  {item.cover_url ? (
                    <Image source={{ uri: item.cover_url }} style={styles.cover} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primarySoft} style={styles.cover}>
                      <Ionicons name="musical-notes" size={18} color={COLORS.primary} />
                    </LinearGradient>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{item.caption || 'Audio track'}</Text>
                    <Text style={styles.rowArtist} numberOfLines={1}>
                      {item.profiles?.display_name || item.profiles?.username}
                      {item.stream_count ? ` · ${formatCount(item.stream_count)} plays` : ''}
                    </Text>
                  </View>
                  <Ionicons name="add-circle" size={24} color={COLORS.primary} />
                </TouchableOpacity>
              )}
            />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: COLORS.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '80%', minHeight: '55%', paddingBottom: SPACING.xl,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: COLORS.border, alignSelf: 'center', marginTop: SPACING.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  title: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: SPACING.md, marginHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: COLORS.text, fontSize: 15 },
  center: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl },
  empty: { color: COLORS.textTertiary, fontSize: 14 },
  list: { padding: SPACING.md, gap: SPACING.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border, padding: SPACING.sm + 2,
  },
  cover: { width: 44, height: 44, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  rowArtist: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
});
