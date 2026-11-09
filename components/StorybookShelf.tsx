import { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal, Pressable, Alert, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useThemedStyles } from '../contexts/ThemeContext';
import { SPACING, type ThemePalette } from '../constants/theme';
import { fetchStorybooks, fetchStorybookFull, updateStorybook, deleteStorybook, archiveStorybook, ensureAutoRecaps, type Storybook } from '../lib/storybooks';
import type { SourceRect } from '../lib/stories';

/**
 * The row of a user's storybooks under the profile hero — Instagram story-highlights
 * style: a circular cover per book with its title beneath. Your OWN profile always
 * shows a leading "New" bubble (so the feature is discoverable even with zero books);
 * someone else's profile shows the row only if they have a PUBLIC book (RLS already
 * filters to those, so an empty result just means nothing to show).
 *
 * Press-and-hold one of YOUR OWN books to open a quick menu: edit it, flip it
 * public/private, or delete it.
 */
export default function StorybookShelf({ userId, isOwn }: { userId: string; isOwn: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [books, setBooks] = useState<Storybook[]>([]);
  const [menu, setMenu] = useState<Storybook | null>(null); // the book whose long-press menu is open
  const [openingId, setOpeningId] = useState<string | null>(null); // pre-loading this book before we navigate
  const coverRefs = useRef<Map<string, View>>(new Map()); // ring nodes, for the shared-element rect

  const load = useCallback(() => {
    let alive = true;
    fetchStorybooks(userId).then((b) => { if (alive) setBooks(b); });
    return () => { alive = false; };
  }, [userId]);

  // Refetch on focus so a book created/edited elsewhere shows up on return.
  useFocusEffect(load);

  // Compile the owner's auto recaps (monthly "<Month Year> Recap" + yearly "<Year> Recap")
  // once per session, then refresh the shelf so any new ones appear. Best-effort — it
  // self-degrades to nothing if the tables aren't set up or there's nothing to compile.
  useEffect(() => {
    if (!isOwn || !userId) return;
    let alive = true;
    ensureAutoRecaps(userId).then((created) => {
      if (created && alive) fetchStorybooks(userId).then((b) => { if (alive) setBooks(b); });
    });
    return () => { alive = false; };
  }, [isOwn, userId]);

  const openMenu = useCallback((b: Storybook) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setMenu(b);
  }, []);

  // Load the book's content FIRST (spinner on the ring), then open the viewer already
  // loaded — so you never land on an empty/black screen. A genuine load failure stays
  // here with a message instead of opening a dead viewer.
  const openBook = useCallback(async (b: Storybook) => {
    if (openingId) return; // a tap is already loading
    setOpeningId(b.id);
    // Measure the tapped ring so the viewer can expand out of / shrink back into it (exactly
    // like a regular story), and pre-load the book — both before we navigate.
    const node = coverRefs.current.get(b.id);
    const rectP = new Promise<SourceRect | null>((resolve) => {
      if (node && (node as any).measureInWindow) (node as any).measureInWindow((x: number, y: number, width: number, height: number) => resolve({ x, y, width, height }));
      else resolve(null);
    });
    const [rect, full] = await Promise.all([rectP, fetchStorybookFull(b.id)]); // also warms the viewer's cache
    if (!full) { setOpeningId(null); Alert.alert("Couldn't load story", 'Please check your connection and try again.'); return; }
    // Pre-warm the first visible pixel (image frame / video poster) so the viewer opens
    // already-painted — we'd rather stall a touch longer on the ring than open to grey.
    // Capped so a slow network can't hang the tap.
    const first = full.chapters.flatMap((c) => c.items)[0];
    const firstUrl = first ? (first.media_type === 'video' ? first.thumbnail_url : first.media_url) : null;
    if (firstUrl) {
      await Promise.race([
        Image.prefetch(firstUrl).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }
    setOpeningId(null);
    router.push({ pathname: '/storybook/[id]', params: { id: b.id, ...(rect ? { src: JSON.stringify(rect) } : {}), books: JSON.stringify(books.map((x) => x.id)) } });
  }, [openingId, router]);

  const edit = useCallback((b: Storybook) => {
    setMenu(null);
    router.push(`/storybook/edit/${b.id}` as any);
  }, [router]);

  // Flip visibility optimistically (the lock badge updates at once); revert if the write fails.
  const togglePublic = useCallback(async (b: Storybook) => {
    const next = !b.is_public;
    setMenu(null);
    setBooks((prev) => prev.map((x) => (x.id === b.id ? { ...x, is_public: next } : x)));
    const ok = await updateStorybook(b.id, { is_public: next });
    if (!ok) setBooks((prev) => prev.map((x) => (x.id === b.id ? { ...x, is_public: b.is_public } : x)));
  }, []);

  // Archive: hide it from the shelf and force it private (the row + media stay, so it can be
  // restored later). Optimistically removes it; reverts if the write fails.
  const archiveBook = useCallback(async (b: Storybook) => {
    setMenu(null);
    setBooks((prev) => prev.filter((x) => x.id !== b.id));
    const ok = await archiveStorybook(b.id);
    if (!ok) { load(); Alert.alert("Couldn't archive", 'Please try again.'); }
  }, [load]);

  const confirmDelete = useCallback((b: Storybook) => {
    setMenu(null);
    Alert.alert(
      'Delete storybook?',
      `"${b.title}" and its chapters will be removed. Your original stories are untouched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBooks((prev) => prev.filter((x) => x.id !== b.id)); // optimistic remove
            const ok = await deleteStorybook(b.id);
            if (!ok) { load(); Alert.alert("Couldn't delete", 'Please try again.'); }
          },
        },
      ],
    );
  }, [load]);

  // Nothing to show for a visitor with no public books — and don't take up space.
  if (!isOwn && books.length === 0) return null;

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.wrap}
        contentContainerStyle={styles.content}
      >
        {isOwn && (
          <TouchableOpacity style={styles.item} activeOpacity={0.8} onPress={() => router.push('/storybook/edit/new' as any)}>
            <View style={[styles.cover, styles.newCover]}>
              <Ionicons name="add" size={26} color={styles.newGlyph.color} />
            </View>
            <Text style={styles.title} numberOfLines={1}>New</Text>
          </TouchableOpacity>
        )}

        {books.map((b) => (
          <TouchableOpacity
            key={b.id}
            style={styles.item}
            activeOpacity={0.85}
            onPress={() => openBook(b)}
            onLongPress={isOwn ? () => openMenu(b) : undefined}
            delayLongPress={250}
            disabled={!!openingId}
          >
            <View
              style={styles.coverWrap}
              collapsable={false}
              ref={(n) => { if (n) coverRefs.current.set(b.id, n as unknown as View); else coverRefs.current.delete(b.id); }}
            >
              {b.cover_url ? (
                <Image source={{ uri: b.cover_url }} style={styles.cover} contentFit="cover" transition={120} />
              ) : (
                <View style={[styles.cover, styles.emptyCover]}>
                  <Ionicons name="book" size={22} color={styles.newGlyph.color} />
                </View>
              )}
              {/* Pre-load spinner — the book's content loads here, before the viewer opens */}
              {openingId === b.id && (
                <View style={styles.coverLoading}>
                  <ActivityIndicator color="#fff" size="small" />
                </View>
              )}
              {/* A private book is only ever visible to its owner (RLS), so the lock
                  only appears on your own shelf — a quiet reminder it's unpublished. */}
              {isOwn && !b.is_public && (
                <View style={styles.lock}>
                  <Ionicons name="lock-closed" size={10} color="#FFFFFF" />
                </View>
              )}
            </View>
            <Text style={styles.title} numberOfLines={1}>{b.title}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Long-press menu (own books only) */}
      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={styles.backdrop} onPress={() => setMenu(null)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]} onPress={() => {}}>
            {menu && (
              <>
                <View style={styles.handle} />
                <Text style={styles.sheetTitle} numberOfLines={1}>{menu.title}</Text>

                <TouchableOpacity style={styles.action} onPress={() => edit(menu)}>
                  <Ionicons name="create-outline" size={22} color={styles.actionLabel.color} />
                  <Text style={styles.actionLabel}>Edit</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.action} onPress={() => togglePublic(menu)}>
                  <Ionicons name={menu.is_public ? 'lock-closed-outline' : 'globe-outline'} size={22} color={styles.actionLabel.color} />
                  <Text style={styles.actionLabel}>{menu.is_public ? 'Make private' : 'Make public'}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.action} onPress={() => archiveBook(menu)}>
                  <Ionicons name="archive-outline" size={22} color={styles.actionLabel.color} />
                  <Text style={styles.actionLabel}>Archive</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.action} onPress={() => confirmDelete(menu)}>
                  <Ionicons name="trash-outline" size={22} color={DANGER} />
                  <Text style={[styles.actionLabel, { color: DANGER }]}>Delete</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.cancel} onPress={() => setMenu(null)}>
                  <Text style={styles.cancelLabel}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const SIZE = 66;
const DANGER = '#FF3B30';

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: { marginTop: SPACING.md },
  content: { paddingHorizontal: SPACING.md, gap: SPACING.md, alignItems: 'flex-start' },
  item: { width: SIZE + 10, alignItems: 'center' },
  coverWrap: { width: SIZE, height: SIZE, position: 'relative' },
  cover: {
    width: SIZE, height: SIZE, borderRadius: SIZE / 2,
    borderWidth: 2, borderColor: c.border, backgroundColor: c.background,
  },
  newCover: {
    alignItems: 'center', justifyContent: 'center',
    borderStyle: 'dashed', borderColor: c.textTertiary, backgroundColor: 'transparent',
  },
  emptyCover: { alignItems: 'center', justifyContent: 'center' },
  coverLoading: {
    position: 'absolute', top: 0, left: 0, width: SIZE, height: SIZE,
    borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  newGlyph: { color: c.textSecondary },
  lock: {
    position: 'absolute', bottom: -1, right: -1,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: c.textSecondary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: c.background,
  },
  title: { marginTop: 6, width: SIZE + 8, textAlign: 'center', fontSize: 11, color: c.textSecondary },

  // Long-press action sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: c.background,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingTop: 8, paddingHorizontal: 16,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 10 },
  sheetTitle: { fontSize: 13, fontWeight: '700', color: c.textSecondary, textAlign: 'center', marginBottom: 4 },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 15,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
  },
  actionLabel: { fontSize: 16, fontWeight: '600', color: c.text },
  cancel: { marginTop: 8, paddingVertical: 15, alignItems: 'center' },
  cancelLabel: { fontSize: 16, fontWeight: '700', color: c.textSecondary },
});
