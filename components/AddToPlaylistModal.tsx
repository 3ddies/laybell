import {
  View, Text, StyleSheet, Modal, FlatList,
  TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { useEffect, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

type Playlist = { id: string; name: string; is_public: boolean };

type Props = {
  visible: boolean;
  postId: string;
  onClose: () => void;
};

export default function AddToPlaylistModal({ visible, postId, onClose }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (visible) fetchPlaylists();
  }, [visible]);

  async function fetchPlaylists() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Fetch playlists + which ones already contain this post
    const [playlistsRes, existingRes] = await Promise.all([
      supabase.from('playlists').select('id, name, is_public').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('playlist_tracks').select('playlist_id').eq('post_id', postId),
    ]);

    if (playlistsRes.data) setPlaylists(playlistsRes.data);
    if (existingRes.data) setAdded(new Set(existingRes.data.map(t => t.playlist_id)));
    setLoading(false);
  }

  async function handleAdd(playlistId: string) {
    if (added.has(playlistId)) return;
    setAdding(playlistId);

    const { count } = await supabase
      .from('playlist_tracks')
      .select('*', { count: 'exact', head: true })
      .eq('playlist_id', playlistId);

    const { error } = await supabase.from('playlist_tracks').insert({
      playlist_id: playlistId,
      post_id: postId,
      position: (count ?? 0) + 1,
    });

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setAdded(prev => new Set([...prev, playlistId]));
    }
    setAdding(null);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          {/* Handle */}
          <View style={styles.handle} />

          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Add to Playlist</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={22} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={COLORS.primary} />
            </View>
          ) : playlists.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="musical-notes-outline" size={36} color={COLORS.textTertiary} />
              <Text style={styles.emptyText}>No playlists yet</Text>
              <Text style={styles.emptySubtext}>Create a playlist in the Music tab first</Text>
            </View>
          ) : (
            <FlatList
              data={playlists}
              keyExtractor={item => item.id}
              contentContainerStyle={styles.list}
              renderItem={({ item }) => {
                const isAdded = added.has(item.id);
                const isAdding = adding === item.id;
                return (
                  <TouchableOpacity
                    style={[styles.playlistRow, isAdded && styles.playlistRowAdded]}
                    onPress={() => handleAdd(item.id)}
                    disabled={isAdded || isAdding}
                  >
                    <LinearGradient
                      colors={isAdded ? GRADIENTS.primaryWarm : GRADIENTS.primarySoft}
                      style={styles.playlistIcon}
                    >
                      <Ionicons
                        name={isAdded ? 'checkmark' : 'musical-notes'}
                        size={18}
                        color={isAdded ? COLORS.text : COLORS.primary}
                      />
                    </LinearGradient>
                    <View style={styles.playlistInfo}>
                      <Text style={styles.playlistName}>{item.name}</Text>
                      <Text style={styles.playlistMeta}>{item.is_public ? 'Public' : 'Private'}</Text>
                    </View>
                    {isAdding ? (
                      <ActivityIndicator size="small" color={COLORS.primary} />
                    ) : isAdded ? (
                      <Text style={styles.addedText}>Added</Text>
                    ) : (
                      <Ionicons name="add-circle-outline" size={22} color={COLORS.primary} />
                    )}
                  </TouchableOpacity>
                );
              }}
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
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '70%', paddingBottom: SPACING.xxl,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: COLORS.border, alignSelf: 'center', marginTop: SPACING.sm,
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  sheetTitle: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  loadingWrap: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl },
  emptyWrap: { alignItems: 'center', padding: SPACING.xxl, gap: SPACING.sm },
  emptyText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  emptySubtext: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center' },
  list: { padding: SPACING.md, gap: SPACING.sm },
  playlistRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  playlistRowAdded: { borderColor: COLORS.primary + '44', backgroundColor: COLORS.primary + '0A' },
  playlistIcon: { width: 40, height: 40, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  playlistInfo: { flex: 1 },
  playlistName: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  playlistMeta: { color: COLORS.textTertiary, fontSize: 12, marginTop: 2 },
  addedText: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },
});
