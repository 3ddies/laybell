import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { GRADIENTS } from '../constants/theme';

// The "@username" pill on a reshared post — tapping it opens the original. Author
// is fetched once and cached per post id, so it's cheap to render on every story.

type Author = { username: string | null; avatar_url: string | null };
const cache = new Map<string, Author>();

export default function RepostAuthorChip({ postId, onPress }: { postId: string; onPress?: () => void }) {
  const [author, setAuthor] = useState<Author | null>(cache.get(postId) ?? null);

  useEffect(() => {
    let alive = true;
    if (cache.has(postId)) { setAuthor(cache.get(postId)!); return; }
    supabase
      .from('posts')
      .select('profiles!posts_user_id_fkey(username, avatar_url)')
      .eq('id', postId)
      .single()
      .then(({ data }) => {
        const d = data as any;
        const prof = d ? (Array.isArray(d.profiles) ? d.profiles[0] : d.profiles) : null;
        const a: Author = { username: prof?.username ?? null, avatar_url: prof?.avatar_url ?? null };
        cache.set(postId, a);
        if (alive) setAuthor(a);
      }, () => {});
    return () => { alive = false; };
  }, [postId]);

  return (
    <TouchableOpacity style={styles.chip} activeOpacity={0.85} hitSlop={8} onPress={onPress} disabled={!onPress}>
      {author?.avatar_url ? (
        <ExpoImage source={{ uri: author.avatar_url }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" />
      ) : (
        <LinearGradient colors={GRADIENTS.avatar} style={styles.avatar} />
      )}
      <Text style={styles.name} numberOfLines={1}>@{author?.username ?? 'laybell'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 4, paddingRight: 10,
  },
  avatar: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#333' },
  name: { color: '#fff', fontSize: 13, fontWeight: '700', maxWidth: 160 },
});
