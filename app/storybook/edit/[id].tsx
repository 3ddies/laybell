import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Switch, Modal, FlatList, Alert, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../../lib/supabase';
import { useThemedStyles } from '../../../contexts/ThemeContext';
import { SPACING, RADIUS, type ThemePalette } from '../../../constants/theme';
import StorybookBackdrop, { type BackdropItem } from '../../../components/StorybookBackdrop';
import { type Story } from '../../../lib/stories';
import {
  createStorybook, addChapter, fetchStorybookFull, updateStorybook, updateChapter,
  deleteChapter, addStoryToChapter, deleteItem, deleteStorybook, type StorybookFull,
} from '../../../lib/storybooks';

// Create / edit a storybook. For 'new' the book is created on mount (so chapters +
// items have something to attach to) and auto-removed on exit if it stayed empty, so
// an abandoned "+ New" tap never litters the shelf. Every edit persists immediately.
const storyThumb = (s: Story) => s.thumbnail_url ?? s.media_url;

export default function StorybookEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);

  const [userId, setUserId] = useState<string | null>(null);
  const [bookId, setBookId] = useState<string | null>(isNew ? null : String(id));
  const [full, setFull] = useState<StorybookFull | null>(null);
  const [title, setTitle] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [backdropItems, setBackdropItems] = useState<BackdropItem[]>([]);

  const [picker, setPicker] = useState<{ chapterId: string } | null>(null);
  const [archive, setArchive] = useState<Story[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // For auto-cleanup of an empty book we created this session.
  const createdNew = useRef(isNew);
  const bookIdRef = useRef<string | null>(bookId);
  const itemCountRef = useRef(0);
  useEffect(() => { bookIdRef.current = bookId; }, [bookId]);

  const reload = useCallback(async (bid: string) => {
    const f = await fetchStorybookFull(bid);
    setFull(f);
    if (f) { setTitle(f.title); setIsPublic(f.is_public); }
    itemCountRef.current = f ? f.chapters.reduce((n, c) => n + c.items.length, 0) : 0;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!alive) return;
      setUserId(user?.id ?? null);
      if (user) {
        // Up to 3 stories for the blurred slideshow behind the sheet. A video story
        // plays live (muted) behind the blur with its thumbnail as the poster; an
        // image story shows its still. Stories without a usable URL are skipped.
        const { data: sts } = await supabase
          .from('stories').select('media_url, thumbnail_url, media_type')
          .eq('user_id', user.id).order('created_at', { ascending: false }).limit(12);
        const picked = (sts ?? [])
          .map((s: any): BackdropItem | null => {
            if (!s.media_url) return null;
            return s.media_type === 'video'
              ? { url: s.media_url, type: 'video', poster: s.thumbnail_url ?? null }
              : { url: s.media_url, type: 'image' };
          })
          .filter((x: BackdropItem | null): x is BackdropItem => !!x)
          .slice(0, 3);
        if (alive) setBackdropItems(picked);
      }
      let bid = bookId;
      if (isNew && user) {
        bid = await createStorybook({ userId: user.id, title: 'Untitled', isPublic: false });
        if (!bid) { if (alive) { setFailed(true); setLoading(false); } return; }  // insert blocked → don't hang
        bookIdRef.current = bid;                        // record ASAP so an exit can clean up the orphan
        if (!alive) { deleteStorybook(bid); return; }   // exited mid-create → delete the orphan, don't litter the shelf
        await addChapter(bid, null);                    // a default chapter to drop items into
        if (!alive) { deleteStorybook(bid); return; }   // exited during chapter add → delete the orphan
        setBookId(bid);
      }
      if (bid) await reload(bid);
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remove a book we created this session if it's left completely empty.
  useEffect(() => {
    return () => {
      if (createdNew.current && itemCountRef.current === 0 && bookIdRef.current) {
        deleteStorybook(bookIdRef.current);
      }
    };
  }, []);

  const openPicker = useCallback(async (chapterId: string) => {
    if (!userId) return;
    setSelected(new Set());
    setPicker({ chapterId });
    // ALL of your own stories — active and expired (RLS lets the owner read both) —
    // so you can collect a story you just posted or one from months ago.
    const { data } = await supabase
      .from('stories').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    setArchive((data ?? []) as Story[]);
  }, [userId]);

  const addSelected = useCallback(async () => {
    if (!picker || !bookId) return;
    const toAdd = archive.filter((s) => selected.has(s.id));
    for (const s of toAdd) await addStoryToChapter(bookId, picker.chapterId, s);
    setPicker(null);
    await reload(bookId);
  }, [picker, bookId, archive, selected, reload]);

  const onDeleteBook = useCallback(() => {
    if (!bookId) return;
    Alert.alert('Delete storybook?', 'This removes the book and its chapters. Your original stories are untouched.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { createdNew.current = false; await deleteStorybook(bookId); router.back(); } },
    ]);
  }, [bookId, router]);

  // Leave the editor; if this was a brand-new book left with NO stories, remove it first so an
  // abandoned "+ New" tap never leaves an empty "Untitled" on the shelf. Awaited so the profile's
  // refetch-on-focus sees it already gone.
  const leaveEditor = useCallback(async () => {
    if (createdNew.current && itemCountRef.current === 0 && bookIdRef.current) {
      const orphan = bookIdRef.current;
      createdNew.current = false;
      bookIdRef.current = null; // so the unmount cleanup can't double-delete
      await deleteStorybook(orphan);
    }
    router.back();
  }, [router]);

  if (loading) {
    return <View style={[styles.screen, styles.center]}><ActivityIndicator color={styles.saveText.color} /></View>;
  }
  if (failed || !bookId) {
    return (
      <View style={[styles.screen, styles.center, { padding: 32 }]}>
        <Text style={[styles.subtle, { textAlign: 'center' }]}>Couldn't open the storybook editor. Please try again.</Text>
        <TouchableOpacity onPress={leaveEditor} style={{ marginTop: 16 }}><Text style={styles.saveText}>Close</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StorybookBackdrop items={backdropItems} />
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity hitSlop={10} onPress={leaveEditor}><Ionicons name="chevron-back" size={26} color={styles.title.color} /></TouchableOpacity>
        <Text style={styles.headerTitle}>{isNew ? 'New storybook' : 'Edit storybook'}</Text>
        <TouchableOpacity hitSlop={10} onPress={leaveEditor}><Text style={styles.saveText}>Done</Text></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}>
        {/* Title + public/private on one row */}
        <View style={styles.titleRow}>
          <TextInput
            style={styles.titleInput}
            value={title}
            onChangeText={setTitle}
            onEndEditing={() => bookId && updateStorybook(bookId, { title: title.trim() || 'Untitled' })}
            placeholder="Storybook title"
            placeholderTextColor={styles.subtle.color}
            maxLength={60}
          />
          <View style={styles.pubToggle}>
            <Ionicons name={isPublic ? 'globe-outline' : 'lock-closed-outline'} size={16} color={styles.subtle.color} />
            <Switch
              value={isPublic}
              onValueChange={async (v) => { setIsPublic(v); if (bookId) await updateStorybook(bookId, { is_public: v }); }}
            />
          </View>
        </View>

        {/* Chapters */}
        {full?.chapters.map((ch, ci) => (
          <View key={ch.id} style={styles.chapter}>
            <View style={styles.chapterHead}>
              <TextInput
                style={styles.chapterTitle}
                defaultValue={ch.title ?? ''}
                placeholder={`Chapter ${ci + 1} title`}
                placeholderTextColor={styles.subtle.color}
                onEndEditing={(e) => updateChapter(ch.id, { title: e.nativeEvent.text.trim() || null })}
                maxLength={40}
              />
              {full.chapters.length > 1 && (
                <TouchableOpacity hitSlop={8} onPress={() => bookId && deleteChapter(ch.id).then(() => reload(bookId))}>
                  <Ionicons name="trash-outline" size={18} color={styles.subtle.color} />
                </TouchableOpacity>
              )}
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.itemRow}>
              {ch.items.map((item) => (
                <View key={item.id} style={styles.thumbWrap}>
                  <Image source={{ uri: item.thumbnail_url ?? item.media_url }} style={styles.thumb} contentFit="cover" />
                  {item.media_type === 'video' && <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>}
                  <TouchableOpacity style={styles.removeItem} hitSlop={6} onPress={() => bookId && deleteItem(item.id).then(() => reload(bookId))}>
                    <Ionicons name="close" size={12} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={[styles.thumb, styles.addTile]} onPress={() => openPicker(ch.id)}>
                <Ionicons name="add" size={28} color={styles.subtle.color} />
              </TouchableOpacity>
            </ScrollView>
          </View>
        ))}

        {/* Add chapter */}
        <TouchableOpacity style={styles.addChapter} onPress={() => bookId && addChapter(bookId, null).then(() => reload(bookId))}>
          <Ionicons name="add-circle-outline" size={20} color={styles.saveText.color} />
          <Text style={styles.addChapterText}>Add chapter</Text>
        </TouchableOpacity>

      </ScrollView>

      {/* Delete — pinned to the bottom middle of the screen */}
      <View style={[styles.deleteWrap, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.deleteBook} onPress={onDeleteBook}>
          <Text style={styles.deleteBookText}>Delete storybook</Text>
        </TouchableOpacity>
      </View>

      {/* Archive picker */}
      <Modal visible={!!picker} animationType="slide" onRequestClose={() => setPicker(null)}>
        <View style={[styles.screen, { paddingTop: insets.top }]}>
          <View style={styles.header}>
            <TouchableOpacity hitSlop={10} onPress={() => setPicker(null)}><Ionicons name="close" size={26} color={styles.title.color} /></TouchableOpacity>
            <Text style={styles.headerTitle}>Add from your stories</Text>
            <TouchableOpacity hitSlop={10} onPress={addSelected} disabled={selected.size === 0}>
              <Text style={[styles.saveText, selected.size === 0 && styles.saveDisabled]}>Add{selected.size ? ` (${selected.size})` : ''}</Text>
            </TouchableOpacity>
          </View>
          {archive.length === 0 ? (
            <View style={[styles.center, { flex: 1, paddingHorizontal: 32 }]}>
              <Text style={styles.subtle}>No stories yet. Post a story and it'll show up here to collect into a storybook.</Text>
            </View>
          ) : (
            <FlatList
              data={archive}
              keyExtractor={(s) => s.id}
              numColumns={3}
              contentContainerStyle={{ padding: 2 }}
              renderItem={({ item }) => {
                const on = selected.has(item.id);
                return (
                  <TouchableOpacity
                    style={styles.gridCell}
                    activeOpacity={0.8}
                    onPress={() => setSelected((prev) => { const n = new Set(prev); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; })}
                  >
                    <Image source={{ uri: storyThumb(item) }} style={styles.gridImg} contentFit="cover" />
                    {item.media_type === 'video' && <View style={styles.playBadge}><Ionicons name="play" size={12} color="#fff" /></View>}
                    {on && (
                      <View style={styles.selOverlay}>
                        <View style={styles.selDot}><Ionicons name="checkmark" size={16} color="#fff" /></View>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

// Fixed dark-glass look (independent of the app theme): the creation sheet now sits
// over a blurred story slideshow, so it has its own aesthetic — white text on
// translucent panels, like a story-composer. `_c` is unused on purpose.
const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0E0E12' },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, height: 52 },
  headerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  title: { color: '#FFFFFF' },
  saveText: { color: '#FFB27A', fontSize: 16, fontWeight: '700' },
  saveDisabled: { opacity: 0.4 },
  subtle: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md },
  titleInput: { flex: 1, color: '#FFFFFF', fontSize: 24, fontWeight: '800', paddingVertical: SPACING.md },
  pubToggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, marginHorizontal: SPACING.md, marginTop: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)' },
  rowLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  chapter: { marginTop: SPACING.md, marginHorizontal: SPACING.md, padding: SPACING.md, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.12)' },
  chapterHead: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  chapterTitle: { flex: 1, color: '#FFFFFF', fontSize: 16, fontWeight: '600', paddingVertical: 6 },
  itemRow: { gap: SPACING.sm, paddingVertical: SPACING.sm, alignItems: 'center' },
  thumbWrap: { position: 'relative' },
  thumb: { width: 78, height: 104, borderRadius: RADIUS.sm, backgroundColor: 'rgba(255,255,255,0.1)' },
  addTile: { alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.3)', borderStyle: 'dashed', backgroundColor: 'rgba(255,255,255,0.04)' },
  playBadge: { position: 'absolute', top: 6, right: 6, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  removeItem: { position: 'absolute', top: 4, left: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  addChapter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: SPACING.md, paddingVertical: SPACING.md, marginTop: SPACING.sm },
  addChapterText: { color: '#FFB27A', fontSize: 15, fontWeight: '600' },
  deleteWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  deleteBook: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.lg },
  deleteBookText: { color: '#FF6B6E', fontSize: 15, fontWeight: '600' },
  gridCell: { flex: 1 / 3, aspectRatio: 0.75, margin: 2, position: 'relative' },
  gridImg: { width: '100%', height: '100%', borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.1)' },
  selOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 4, alignItems: 'flex-end' },
  selDot: { margin: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: '#F26522', alignItems: 'center', justifyContent: 'center' },
});
