import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, Modal, Image,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { useAudio } from '../../contexts/AudioContext';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';
import TrackRow from '../../components/TrackRow';

type Playlist = { id: string; name: string; is_public: boolean; created_at: string };
type Track = {
  post_id: string; position: number;
  posts: {
    id: string; media_url: string; caption: string; user_id: string;
    stream_count?: number; cover_url?: string | null;
    profiles: { id: string; username: string; display_name: string; avatar_url: string | null };
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
  const { playingId, play } = useAudioPlayer();
  const { playQueue } = useAudio();
  const [savedTracks, setSavedTracks] = useState<any[]>([]);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'playlists' | 'saved' | 'liked'>('playlists');
  const [likedTracks, setLikedTracks] = useState<any[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => { setup(); }, []);

  // Keep saved songs and playlists fresh when returning to this tab
  // (e.g. after saving a track from the feed).
  useFocusEffect(
    useCallback(() => {
      if (currentUserId) {
        fetchSavedTracks(currentUserId);
        fetchLikedTracks(currentUserId);
        fetchPlaylists(currentUserId);
      }
    }, [currentUserId])
  );

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      await Promise.all([fetchPlaylists(user.id), fetchSavedTracks(user.id), fetchLikedTracks(user.id)]);
    }
    setLoading(false);
  }

  async function fetchPlaylists(userId: string) {
    const { data } = await supabase.from('playlists').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (data) setPlaylists(data);
  }

  async function fetchSavedTracks(userId: string) {
    const { data } = await supabase
      .from('saves')
      .select('id, posts(id,media_url,caption,type,duration_seconds,stream_count,cover_url,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) setSavedTracks(data.filter((s: any) => s.posts?.type === 'audio'));
  }

  async function fetchLikedTracks(userId: string) {
    const { data } = await supabase
      .from('likes')
      .select('post_id, posts(id,media_url,caption,type,duration_seconds,stream_count,cover_url,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) setLikedTracks(data.filter((l: any) => l.posts?.type === 'audio'));
  }

  async function fetchPlaylistTracks(playlistId: string) {
    setTracksLoading(true);
    const { data } = await supabase
      .from('playlist_tracks')
      .select('post_id,position,posts(id,media_url,caption,stream_count,cover_url,user_id,profiles!posts_user_id_fkey(id,username,display_name,avatar_url))')
      .eq('playlist_id', playlistId)
      .order('position', { ascending: true });
    if (data) setTracks(data as any);
    setTracksLoading(false);
  }

  async function createPlaylist() {
    if (!newPlaylistName.trim() || !currentUserId) return;
    const { data, error } = await supabase.from('playlists')
      .insert({ user_id: currentUserId, name: newPlaylistName.trim(), is_public: false })
      .select().single();
    if (error) { Alert.alert('Error', error.message); return; }
    if (data) { setPlaylists(prev => [data, ...prev]); setNewPlaylistName(''); setShowNewPlaylist(false); }
  }

  async function deletePlaylist(playlistId: string) {
    Alert.alert('Delete Playlist', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await supabase.from('playlists').delete().eq('id', playlistId);
        setPlaylists(prev => prev.filter(p => p.id !== playlistId));
        if (selectedPlaylist?.id === playlistId) setSelectedPlaylist(null);
      }},
    ]);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Music</Text>
        <TouchableOpacity style={styles.newBtn} onPress={() => setShowNewPlaylist(true)}>
          <Ionicons name="add" size={18} color={COLORS.text} />
          <Text style={styles.newBtnText}>Playlist</Text>
        </TouchableOpacity>
      </View>

      {/* Toggle */}
      <View style={styles.toggleRow}>
        {(['playlists', 'saved', 'liked'] as const).map(view => {
          const icons: Record<typeof view, [any, any]> = {
            playlists: ['list', 'list-outline'],
            saved: ['bookmark', 'bookmark-outline'],
            liked: ['heart', 'heart-outline'],
          };
          const labels: Record<typeof view, string> = { playlists: 'Playlists', saved: 'Saved', liked: 'Liked' };
          const on = activeView === view;
          return (
            <TouchableOpacity
              key={view}
              style={[styles.toggleBtn, on && styles.toggleBtnActive]}
              onPress={() => { setActiveView(view); setSelectedPlaylist(null); }}
            >
              <Ionicons name={on ? icons[view][0] : icons[view][1]} size={16} color={on ? COLORS.text : COLORS.textSecondary} />
              <Text style={[styles.toggleText, on && styles.toggleTextActive]}>{labels[view]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Playlists list */}
      {activeView === 'playlists' && !selectedPlaylist && (
        <FlatList
          data={playlists}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="musical-notes" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No playlists yet</Text>
              <Text style={styles.emptySubtitle}>Tap "+ Playlist" to create your first one</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.playlistRow}
              onPress={() => { setSelectedPlaylist(item); fetchPlaylistTracks(item.id); }}
              onLongPress={() => deletePlaylist(item.id)}
            >
              <LinearGradient colors={GRADIENTS.primarySoft} style={styles.playlistIcon}>
                <Ionicons name="musical-notes" size={22} color={COLORS.primary} />
              </LinearGradient>
              <View style={styles.playlistInfo}>
                <Text style={styles.playlistName}>{item.name}</Text>
                <Text style={styles.playlistMeta}>{item.is_public ? 'Public' : 'Private'} · Long press to delete</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={COLORS.textTertiary} />
            </TouchableOpacity>
          )}
        />
      )}

      {/* Playlist tracks */}
      {activeView === 'playlists' && selectedPlaylist && (
        <View style={{ flex: 1 }}>
          <TouchableOpacity style={styles.backBtn} onPress={() => { setSelectedPlaylist(null); setTracks([]); }}>
            <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
            <Text style={styles.backText}>Playlists</Text>
          </TouchableOpacity>
          <Text style={styles.playlistTitle}>{selectedPlaylist.name}</Text>
          {tracksLoading ? (
            <ActivityIndicator color={COLORS.primary} style={{ marginTop: SPACING.xl }} />
          ) : (
            <FlatList
              data={tracks}
              keyExtractor={item => item.post_id}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptySubtitle}>No tracks yet — save audio posts from the feed</Text>
                </View>
              }
              renderItem={({ item, index }) => (
                <TrackRow
                  caption={item.posts.caption}
                  artist={item.posts.profiles?.display_name}
                  username={item.posts.profiles?.username}
                  streams={item.posts.stream_count}
                  cover={item.posts.cover_url}
                  avatarUrl={item.posts.profiles?.avatar_url}
                  isPlaying={playingId === item.post_id}
                  onPlay={() => playQueue(
                    tracks.map(t => ({
                      id: t.post_id, uri: t.posts.media_url,
                      caption: t.posts.caption, artist: t.posts.profiles?.display_name ?? '',
                    })),
                    index,
                  )}
                  onAvatarPress={() => router.push(`/profile/${item.posts.user_id}`)}
                />
              )}
            />
          )}
        </View>
      )}

      {/* Saved songs */}
      {activeView === 'saved' && (
        <FlatList
          data={savedTracks}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="bookmark" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No saved songs yet</Text>
              <Text style={styles.emptySubtitle}>Save audio posts from your feed</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TrackRow
              caption={item.posts?.caption}
              artist={item.posts?.profiles?.display_name}
              username={item.posts?.profiles?.username}
              duration={item.posts?.duration_seconds}
              streams={item.posts?.stream_count}
              cover={item.posts?.cover_url}
              avatarUrl={item.posts?.profiles?.avatar_url}
              isPlaying={playingId === item.posts?.id}
              onPlay={() => play(item.posts?.id, item.posts?.media_url, item.posts?.caption, item.posts?.profiles?.display_name)}
              onAddToPlaylist={() => setPlaylistModalPostId(item.posts?.id)}
              onAvatarPress={() => router.push(`/profile/${item.posts?.user_id}`)}
            />
          )}
        />
      )}

      {/* Liked songs */}
      {activeView === 'liked' && (
        <FlatList
          data={likedTracks}
          keyExtractor={item => item.post_id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.emptyIcon}>
                <Ionicons name="heart" size={32} color={COLORS.primary} />
              </LinearGradient>
              <Text style={styles.emptyTitle}>No liked songs yet</Text>
              <Text style={styles.emptySubtitle}>Like audio posts from your feed</Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <TrackRow
              caption={item.posts?.caption}
              artist={item.posts?.profiles?.display_name}
              username={item.posts?.profiles?.username}
              duration={item.posts?.duration_seconds}
              streams={item.posts?.stream_count}
              cover={item.posts?.cover_url}
              avatarUrl={item.posts?.profiles?.avatar_url}
              isPlaying={playingId === item.posts?.id}
              onPlay={() => playQueue(
                likedTracks.map((t: any) => ({
                  id: t.posts?.id, uri: t.posts?.media_url,
                  caption: t.posts?.caption, artist: t.posts?.profiles?.display_name ?? '',
                })),
                index,
              )}
              onAddToPlaylist={() => setPlaylistModalPostId(item.posts?.id)}
              onAvatarPress={() => router.push(`/profile/${item.posts?.user_id}`)}
            />
          )}
        />
      )}

      {/* New playlist modal */}
      <Modal visible={showNewPlaylist} transparent animationType="slide" onRequestClose={() => setShowNewPlaylist(false)}>
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
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setShowNewPlaylist(false); setNewPlaylistName(''); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalCreate} onPress={createPlaylist}>
                <Text style={styles.modalCreateText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Add to playlist modal */}
      <AddToPlaylistModal
        visible={!!playlistModalPostId}
        postId={playlistModalPostId ?? ''}
        onClose={() => setPlaylistModalPostId(null)}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerTitle: { color: COLORS.text, fontSize: 28, fontWeight: '800' },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.primary, borderRadius: RADIUS.full,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
  },
  newBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },

  toggleRow: { flexDirection: 'row', paddingHorizontal: SPACING.md, gap: SPACING.sm, marginBottom: SPACING.md },
  toggleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: COLORS.border,
  },
  toggleBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  toggleText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  toggleTextActive: { color: COLORS.text, fontWeight: '700' },

  listContent: { padding: SPACING.md, gap: SPACING.sm },

  playlistRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  playlistIcon: { width: 48, height: 48, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  playlistInfo: { flex: 1 },
  playlistName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  playlistMeta: { color: COLORS.textTertiary, fontSize: 12, marginTop: 2 },

  backBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  backText: { color: COLORS.primary, fontSize: 15, fontWeight: '600' },
  playlistTitle: { color: COLORS.text, fontSize: 22, fontWeight: '800', paddingHorizontal: SPACING.md, marginBottom: SPACING.sm },

  emptyContainer: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md },
  emptyIcon: { width: 72, height: 72, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: COLORS.surfaceLight, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl, padding: SPACING.lg, gap: SPACING.md },
  modalTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  modalInput: { backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADIUS.md, padding: SPACING.md, color: COLORS.text, fontSize: 15 },
  modalBtns: { flexDirection: 'row', gap: SPACING.sm },
  modalCancel: { flex: 1, backgroundColor: COLORS.background, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border },
  modalCancelText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '600' },
  modalCreate: { flex: 1, backgroundColor: COLORS.primary, borderRadius: RADIUS.md, padding: SPACING.md, alignItems: 'center' },
  modalCreateText: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
});
