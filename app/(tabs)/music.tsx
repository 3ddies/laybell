import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, TextInput, Modal,
} from 'react-native';
import { useState, useEffect } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { useAudioPlayer } from '../../hooks/useAudioPlayer';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';
import AddToPlaylistModal from '../../components/AddToPlaylistModal';

type Playlist = { id: string; name: string; is_public: boolean; created_at: string };
type Track = {
  post_id: string; position: number;
  posts: { id: string; media_url: string; caption: string; profiles: { username: string; display_name: string } };
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
  const [savedTracks, setSavedTracks] = useState<any[]>([]);
  const [playlistModalPostId, setPlaylistModalPostId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'playlists' | 'saved'>('playlists');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => { setup(); }, []);

  async function setup() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
      await Promise.all([fetchPlaylists(user.id), fetchSavedTracks(user.id)]);
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
      .select('id, posts(id,media_url,caption,type,duration_seconds,profiles!posts_user_id_fkey(username,display_name))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (data) setSavedTracks(data.filter((s: any) => s.posts?.type === 'audio'));
  }

  async function fetchPlaylistTracks(playlistId: string) {
    setTracksLoading(true);
    const { data } = await supabase
      .from('playlist_tracks')
      .select('post_id,position,posts(id,media_url,caption,profiles!posts_user_id_fkey(username,display_name))')
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
        {(['playlists', 'saved'] as const).map(view => (
          <TouchableOpacity
            key={view}
            style={[styles.toggleBtn, activeView === view && styles.toggleBtnActive]}
            onPress={() => { setActiveView(view); setSelectedPlaylist(null); }}
          >
            <Ionicons
              name={view === 'playlists' ? (activeView === view ? 'list' : 'list-outline') : (activeView === view ? 'bookmark' : 'bookmark-outline')}
              size={16} color={activeView === view ? COLORS.text : COLORS.textSecondary}
            />
            <Text style={[styles.toggleText, activeView === view && styles.toggleTextActive]}>
              {view === 'playlists' ? 'Playlists' : 'Saved Songs'}
            </Text>
          </TouchableOpacity>
        ))}
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
              renderItem={({ item }) => (
                <TrackRow
                  caption={item.posts.caption}
                  artist={item.posts.profiles?.display_name}
                  username={item.posts.profiles?.username}
                  isPlaying={playingId === item.post_id}
                  onPlay={() => play(item.post_id, item.posts.media_url, item.posts.caption, item.posts.profiles?.display_name)}
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
              isPlaying={playingId === item.id}
              onPlay={() => play(item.id, item.posts?.media_url, item.posts?.caption, item.posts?.profiles?.display_name)}
              onAddToPlaylist={() => setPlaylistModalPostId(item.posts?.id)}
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

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function TrackRow({ caption, artist, username, duration, isPlaying, onPlay, onAddToPlaylist }: {
  caption: string; artist: string; username: string; duration?: number | null;
  isPlaying: boolean; onPlay: () => void; onAddToPlaylist?: () => void;
}) {
  const durationLabel = formatDuration(duration);
  return (
    <View style={trackStyles.row}>
      <TouchableOpacity style={[trackStyles.playBtn, isPlaying && trackStyles.playBtnActive]} onPress={onPlay}>
        <Ionicons name={isPlaying ? 'stop' : 'play'} size={18} color={COLORS.text} />
      </TouchableOpacity>
      <View style={trackStyles.info}>
        <Text style={trackStyles.caption} numberOfLines={1}>{caption || 'Audio Track'}</Text>
        <Text style={trackStyles.artist}>@{username}{durationLabel ? ` · ${durationLabel}` : ''}</Text>
      </View>
      {isPlaying && (
        <View style={trackStyles.playingBadge}>
          <Text style={trackStyles.playingText}>Playing</Text>
        </View>
      )}
      {onAddToPlaylist && (
        <TouchableOpacity style={trackStyles.addBtn} onPress={onAddToPlaylist}>
          <Ionicons name="add-circle-outline" size={22} color={COLORS.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const trackStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  playBtn: {
    width: 40, height: 40, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  playBtnActive: { backgroundColor: COLORS.error },
  info: { flex: 1 },
  caption: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  artist: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  playingBadge: { backgroundColor: COLORS.primary + '22', borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm, paddingVertical: 3 },
  playingText: { color: COLORS.primary, fontSize: 11, fontWeight: '600' },
  addBtn: { padding: SPACING.xs },
});

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
