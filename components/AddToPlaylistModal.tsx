import {
  View, Text, StyleSheet, Modal, FlatList,
  TouchableOpacity, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useEffect, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';

type Playlist = { id: string; name: string; is_public: boolean };

type Props = {
  visible: boolean;
  postId: string;
  onClose: () => void;
  // True when this instance is hosted inside a FullWindowOverlay (the global
  // 3-dot provider). A real <Modal> presented from inside an overlay window
  // DEADLOCKS on iOS, so overlay-hosted instances render as plain views.
  inOverlay?: boolean;
};

export default function AddToPlaylistModal({ visible, postId, onClose, inOverlay }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
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

  // First tap adds the track; tapping a playlist it's already in removes it.
  async function handleToggle(playlistId: string) {
    if (adding) return;
    setAdding(playlistId);

    if (added.has(playlistId)) {
      const { error } = await supabase
        .from('playlist_tracks')
        .delete()
        .eq('playlist_id', playlistId)
        .eq('post_id', postId);
      if (error) {
        Alert.alert('Error', error.message);
      } else {
        setAdded(prev => { const next = new Set(prev); next.delete(playlistId); return next; });
      }
    } else {
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
    }
    setAdding(null);
  }

  const content = (
      <TouchableOpacity style={styles.overlay} onPress={onClose} activeOpacity={1}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          {/* Handle */}
          <View style={styles.handle} />

          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Add to Playlist</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : playlists.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="musical-notes-outline" size={36} color={colors.textTertiary} />
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
                    onPress={() => handleToggle(item.id)}
                    disabled={isAdding}
                  >
                    <LinearGradient
                      colors={isAdded ? GRADIENTS.primaryWarm : GRADIENTS.primarySoft}
                      style={styles.playlistIcon}
                    >
                      <Ionicons
                        name={isAdded ? 'checkmark' : 'musical-notes'}
                        size={18}
                        color={isAdded ? colors.text : colors.primary}
                      />
                    </LinearGradient>
                    <View style={styles.playlistInfo}>
                      <Text style={styles.playlistName}>{item.name}</Text>
                      <Text style={styles.playlistMeta}>{item.is_public ? 'Public' : 'Private'}</Text>
                    </View>
                    {isAdding ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : isAdded ? (
                      <Text style={styles.addedText}>Added</Text>
                    ) : (
                      <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
  );

  if (inOverlay && Platform.OS === 'ios') {
    return visible ? <View style={StyleSheet.absoluteFill}>{content}</View> : null;
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '70%', paddingBottom: SPACING.xxl,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.border, alignSelf: 'center', marginTop: SPACING.sm,
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  loadingWrap: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xxl },
  emptyWrap: { alignItems: 'center', padding: SPACING.xxl, gap: SPACING.sm },
  emptyText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptySubtext: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  list: { padding: SPACING.md, gap: SPACING.sm },
  playlistRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border, gap: SPACING.md,
  },
  playlistRowAdded: { borderColor: colors.primary + '44', backgroundColor: colors.primary + '0A' },
  playlistIcon: { width: 40, height: 40, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  playlistInfo: { flex: 1 },
  playlistName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  playlistMeta: { color: colors.textTertiary, fontSize: 12, marginTop: 2 },
  addedText: { color: colors.primary, fontSize: 13, fontWeight: '600' },
});
