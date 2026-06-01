import {
  View, Text, StyleSheet, Image, TouchableOpacity, ScrollView, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';
import { aspectToNumber } from '../lib/aspectRatio';

type GridPost = {
  id: string; type: string; media_url: string; caption: string;
  thumbnail_url?: string | null; aspect_ratio?: string | null;
  profiles?: { username: string; display_name: string } | null;
};

const GAP = 6;
const H_PADDING = SPACING.md;
const COL_W = (Dimensions.get('window').width - H_PADDING * 2 - GAP) / 2;
const ROW_H = COL_W / 3;            // a song row is 1/3 of a picture tile
const MUSIC_HEADER_H = 30;

type Cell =
  | { kind: 'media'; key: string; post: GridPost; height: number }
  | { kind: 'music'; key: string; songs: GridPost[]; height: number };

// Chunk trending songs into groups of 2-4, avoiding a leftover singleton.
function groupSongs(songs: GridPost[]): GridPost[][] {
  const groups: GridPost[][] = [];
  let i = 0;
  while (i < songs.length) {
    let size = Math.min(4, songs.length - i);
    if (songs.length - i - size === 1 && size > 2) size -= 1;
    groups.push(songs.slice(i, i + size));
    i += size;
  }
  return groups;
}

function mediaHeight(post: GridPost): number {
  if (post.type === 'video') {
    // Reflect the posted dimensions (w/h); clamp ultra-tall so it doesn't dominate.
    return Math.min(COL_W / aspectToNumber(post.aspect_ratio, 16 / 9), COL_W * 1.9);
  }
  return COL_W; // pictures always render 1:1
}

export default function ExploreGrid({ posts }: { posts: GridPost[] }) {
  const router = useRouter();

  if (!posts || posts.length === 0) {
    return <View style={styles.empty}><Text style={styles.emptyText}>No posts in this genre yet</Text></View>;
  }

  const media = posts.filter(p => p.type === 'image' || p.type === 'video');
  const musicGroups = groupSongs(posts.filter(p => p.type === 'audio'));

  // Interleave music stacks among the media tiles for a varied layout.
  const cells: Cell[] = [];
  let mi = 0;
  const pushMusic = () => {
    const g = musicGroups[mi];
    cells.push({ kind: 'music', key: `music-${mi}`, songs: g, height: MUSIC_HEADER_H + g.length * ROW_H });
    mi++;
  };
  media.forEach((m, idx) => {
    cells.push({ kind: 'media', key: m.id, post: m, height: mediaHeight(m) });
    if (idx % 2 === 1 && mi < musicGroups.length) pushMusic();
  });
  while (mi < musicGroups.length) pushMusic();

  // Masonry: add each cell to the currently shorter column.
  const colHeights = [0, 0];
  const cols: Cell[][] = [[], []];
  for (const cell of cells) {
    const c = colHeights[0] <= colHeights[1] ? 0 : 1;
    cols[c].push(cell);
    colHeights[c] += cell.height + GAP;
  }

  const renderCell = (cell: Cell) => {
    if (cell.kind === 'music') {
      return (
        <View key={cell.key} style={[styles.musicCard, { height: cell.height }]}>
          <View style={styles.musicHeader}>
            <Ionicons name="flame" size={13} color={COLORS.primary} />
            <Text style={styles.musicHeaderText}>Trending Songs</Text>
          </View>
          {cell.songs.map((s, i) => (
            <TouchableOpacity
              key={s.id}
              style={[styles.songRow, { height: ROW_H }, i > 0 && styles.songRowBorder]}
              onPress={() => router.push(`/post/${s.id}`)}
            >
              <LinearGradient colors={GRADIENTS.primarySoft} style={styles.songIcon}>
                <Ionicons name="musical-notes" size={16} color={COLORS.primary} />
              </LinearGradient>
              <View style={styles.songInfo}>
                <Text style={styles.songTitle} numberOfLines={1}>{s.caption || 'Audio Track'}</Text>
                <Text style={styles.songArtist} numberOfLines={1}>@{s.profiles?.username}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      );
    }
    const p = cell.post;
    const img = p.type === 'image' ? p.media_url : p.thumbnail_url;
    return (
      <TouchableOpacity
        key={cell.key}
        style={[styles.mediaCard, { height: cell.height }]}
        onPress={() => router.push(`/post/${p.id}`)}
        activeOpacity={0.9}
      >
        {img ? (
          <Image source={{ uri: img }} style={styles.mediaImage} resizeMode="cover" />
        ) : (
          <LinearGradient colors={['#1C0E06', '#120A04']} style={styles.mediaImage}>
            <Ionicons name="videocam" size={28} color={COLORS.primary} />
          </LinearGradient>
        )}
        {p.type === 'video' && (
          <View style={styles.playBadge}><Ionicons name="play" size={12} color={COLORS.text} /></View>
        )}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={styles.mediaOverlay}>
          <Text style={styles.mediaUser} numberOfLines={1}>@{p.profiles?.username}</Text>
        </LinearGradient>
      </TouchableOpacity>
    );
  };

  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
      <View style={styles.row}>
        {cols.map((col, ci) => (
          <View key={ci} style={styles.col}>{col.map(renderCell)}</View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: H_PADDING, paddingBottom: SPACING.xxl },
  row: { flexDirection: 'row', gap: GAP },
  col: { width: COL_W, gap: GAP },

  mediaCard: { width: COL_W, borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: COLORS.surfaceLight },
  mediaImage: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  playBadge: {
    position: 'absolute', top: 8, left: 8, width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  mediaOverlay: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.lg, paddingBottom: 6,
  },
  mediaUser: { color: COLORS.text, fontSize: 11, fontWeight: '600' },

  musicCard: {
    width: COL_W, borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
  },
  musicHeader: {
    height: MUSIC_HEADER_H, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: SPACING.sm, backgroundColor: COLORS.primary + '14',
  },
  musicHeaderText: { color: COLORS.primary, fontSize: 11, fontWeight: '700' },
  songRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.sm },
  songRowBorder: { borderTopWidth: 0.5, borderTopColor: COLORS.border },
  songIcon: { width: 32, height: 32, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  songInfo: { flex: 1 },
  songTitle: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
  songArtist: { color: COLORS.textSecondary, fontSize: 11, marginTop: 1 },

  empty: { alignItems: 'center', paddingTop: SPACING.xxl },
  emptyText: { color: COLORS.textTertiary, fontSize: 14 },
});
