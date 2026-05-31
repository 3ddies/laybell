import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
  ScrollView,
} from 'react-native';
import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { COLORS, SPACING, RADIUS } from '../../constants/theme';

type Playlist = {
  id: string;
  name: string;
  is_public: boolean;
  created_at: string;
  track_count?: number;
};

type Track = {
  id: string;
  post_id: string;
  position: number;
  posts: {
    id: string;
    media_url: string;
    caption: string;
    profiles: {
      username: string;
      display_name: string;
    };
  };
};

export default function MusicScreen() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const { playingId, play: handlePlayTrack } = useAudioPlayer();
  const [savedTracks, setSavedTracks] = useState<any[]>([]);
  const [activeView, setActiveView] = useState<'playlists' | 'saved'>('playlists');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    setup();
  }, []);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      await fetchPlaylists(user.id);
      await fetchSavedTracks(user.id);
    }
    setLoading(false);
  }

  async function fetchPlaylists(userId: string) {
    const { data } = await supabase
      .from('playlists')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (data) setPlaylists(data);
  }

  async function fetchSavedTracks(userId: string) {
    const { data } = await supabase
      .from('saves')
      .select(`
        id,
        posts (
          id, media_url, caption, type,
          profiles!posts_user_id_fkey (username, display_name)
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (data) {
      const audioTracks = data.filter((s: any) => s.posts?.type === 'audio');
      setSavedTracks(audioTracks);
    }
  }

  async function fetchPlaylistTracks(playlistId: string) {
    setTracksLoading(true);
    const { data } = await supabase
      .from('playlist_tracks')
      .select(`
        id,
        post_id,
        position,
        posts (
          id, media_url, caption,
          profiles!posts_user_id_fkey (username, display_name)
        )
      `)
      .eq('playlist_id', playlistId)
      .order('position', { ascending: true });

    if (data) setTracks(data as any);
    setTracksLoading(false);
  }

  async function createPlaylist() {
  if (!newPlaylistName.trim() || !currentUserId) return;

  const { data, error } = await supabase
    .from('playlists')
    .insert({
      user_id: currentUserId,
      name: newPlaylistName.trim(),
      is_public: false,
    })
    .select()
    .single();

  if (error) {
    Alert.alert('Error', error.message);
    return;
  }

  if (data) {
    setPlaylists(prev => [data, ...prev]);
    setNewPlaylistName('');
    setShowNewPlaylist(false);
  }
}

  async function deletePlaylist(playlistId: string) {
    Alert.alert(
      'Delete Playlist',
      'Are you sure you want to delete this playlist?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('playlists').delete().eq('id', playlistId);
            setPlaylists(prev => prev.filter(p => p.id !== playlistId));
            if (selectedPlaylist?.id === playlistId) setSelectedPlaylist(null);
          },
        },
      ]
    );
  }


  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Music</Text>
        <TouchableOpacity
          style={styles.newPlaylistBtn}
          onPress={() => setShowNewPlaylist(true)}
        >
          <Text style={styles.newPlaylistBtnText}>+ Playlist</Text>
        </TouchableOpacity>
      </View>

      {/* View Toggle */}
      <View style={styles.viewToggle}>
        <TouchableOpacity
          style={[styles.toggleBtn, activeView === 'playlists' && styles.toggleBtnActive]}
          onPress={() => {
            setActiveView('playlists');
            setSelectedPlaylist(null);
          }}
        >
          <Text style={[styles.toggleText, activeView === 'playlists' && styles.toggleTextActive]}>
            Playlists
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, activeView === 'saved' && styles.toggleBtnActive]}
          onPress={() => setActiveView('saved')}
        >
          <Text style={[styles.toggleText, activeView === 'saved' && styles.toggleTextActive]}>
            Saved Songs
          </Text>
        </TouchableOpacity>
      </View>

      {/* Playlists View */}
      {activeView === 'playlists' && !selectedPlaylist && (
        <FlatList
          data={playlists}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>🎵</Text>
              <Text style={styles.emptyTitle}>No playlists yet</Text>
              <Text style={styles.emptySubtitle}>
                Tap "+ Playlist" to create your first one
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.playlistRow}
              onPress={() => {
                setSelectedPlaylist(item);
                fetchPlaylistTracks(item.id);
              }}
              onLongPress={() => deletePlaylist(item.id)}
            >
              <View style={styles.playlistIcon}>
                <Text style={styles.playlistIconText}>🎵</Text>
              </View>
              <View style={styles.playlistInfo}>
                <Text style={styles.playlistName}>{item.name}</Text>
                <Text style={styles.playlistMeta}>
                  {item.is_public ? 'Public' : 'Private'} playlist
                </Text>
              </View>
              <Text style={styles.playlistArrow}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Playlist Tracks View */}
      {activeView === 'playlists' && selectedPlaylist && (
        <View style={styles.flex}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => {
              setSelectedPlaylist(null);
              setTracks([]);
            }}
          >
            <Text style={styles.backBtnText}>‹ Back to Playlists</Text>
          </TouchableOpacity>
          <Text style={styles.playlistTitle}>{selectedPlaylist.name}</Text>

          {tracksLoading ? (
            <ActivityIndicator color={COLORS.primary} style={{ marginTop: SPACING.xl }} />
          ) : (
            <FlatList
              data={tracks}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyIcon}>🎵</Text>
                  <Text style={styles.emptyTitle}>No tracks yet</Text>
                  <Text style={styles.emptySubtitle}>
                    Save audio posts to add them here
                  </Text>
                </View>
              }
              renderItem={({ item }) => (
                <View style={styles.trackRow}>
                  <TouchableOpacity
                    style={styles.trackPlayBtn}
                    onPress={() => handlePlayTrack(item.post_id, item.posts.media_url)}
                  >
                    <Text style={styles.trackPlayIcon}>
                      {playingId === item.post_id ? '■' : '▶'}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.trackInfo}>
                    <Text style={styles.trackCaption} numberOfLines={1}>
                      {item.posts.caption}
                    </Text>
                    <Text style={styles.trackArtist}>
                      {'@'}{item.posts.profiles?.username}
                    </Text>
                  </View>
                </View>
              )}
            />
          )}
        </View>
      )}

      {/* Saved Songs View */}
      {activeView === 'saved' && (
        <FlatList
          data={savedTracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>🎵</Text>
              <Text style={styles.emptyTitle}>No saved songs yet</Text>
              <Text style={styles.emptySubtitle}>
                Save audio posts from your feed
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.trackRow}>
              <TouchableOpacity
                style={styles.trackPlayBtn}
                onPress={() => handlePlayTrack(item.id, item.posts?.media_url)}
              >
                <Text style={styles.trackPlayIcon}>
                  {playingId === item.id ? '■' : '▶'}
                </Text>
              </TouchableOpacity>
              <View style={styles.trackInfo}>
                <Text style={styles.trackCaption} numberOfLines={1}>
                  {item.posts?.caption}
                </Text>
                <Text style={styles.trackArtist}>
                  {'@'}{item.posts?.profiles?.username}
                </Text>
              </View>
            </View>
          )}
        />
      )}

      {/* New Playlist Modal */}
      <Modal
        visible={showNewPlaylist}
        transparent
        animationType="slide"
        onRequestClose={() => setShowNewPlaylist(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>New Playlist</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Playlist name..."
              placeholderTextColor={COLORS.textTertiary}
              value={newPlaylistName}
              onChangeText={setNewPlaylistName}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => {
                  setShowNewPlaylist(false);
                  setNewPlaylistName('');
                }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCreateBtn}
                onPress={createPlaylist}
              >
                <Text style={styles.modalCreateText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  flex: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: 'bold',
  },
  newPlaylistBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.full,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
  },
  newPlaylistBtnText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  viewToggle: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  toggleBtn: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  toggleBtnActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  toggleText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  toggleTextActive: {
    color: COLORS.text,
    fontWeight: '700',
  },
  listContent: {
    padding: SPACING.md,
    gap: SPACING.sm,
  },
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.md,
  },
  playlistIcon: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary + '33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playlistIconText: {
    fontSize: 22,
  },
  playlistInfo: {
    flex: 1,
  },
  playlistName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
  },
  playlistMeta: {
    color: COLORS.textTertiary,
    fontSize: 12,
    marginTop: 2,
  },
  playlistArrow: {
    color: COLORS.textTertiary,
    fontSize: 22,
  },
  backBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  backBtnText: {
    color: COLORS.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  playlistTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: SPACING.md,
  },
  trackPlayBtn: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackPlayIcon: {
    color: COLORS.text,
    fontSize: 16,
  },
  trackInfo: {
    flex: 1,
  },
  trackCaption: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  trackArtist: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: SPACING.xxl,
    gap: SPACING.sm,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  emptySubtitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.lg,
    borderTopRightRadius: RADIUS.lg,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  modalInput: {
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    color: COLORS.text,
    fontSize: 15,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalCancelText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  modalCreateBtn: {
    flex: 1,
    backgroundColor: COLORS.primary,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    alignItems: 'center',
  },
  modalCreateText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
  },
});