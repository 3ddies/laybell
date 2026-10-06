import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, TextInput, Modal, ScrollView,
  KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard, Platform,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { coverFade } from '../../lib/coverFade';
import { useAudio } from '../../contexts/AudioContext';
import SwipeBackPager from '../../components/SwipeBackPager';
import { formatCount } from '../../lib/format';
import { titleWithoutTrailingArtist } from '../../lib/postSong';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { countLabel } from '../../lib/i18n';
import { SPACING, RADIUS, GRADIENTS, quietText, type ThemePalette } from '../../constants/theme';
import { Skeleton, SkeletonLine, TrackListSkeleton } from '../../components/Skeleton';
import ReorderableList from '../../components/ReorderableList';
import {
  type Album, type AlbumTrack, albumCover, trackTitle,
  fetchAlbum, fetchAddableTracks, addTrack, removeTrack, renameTrack,
  renameAlbum, reorderTracks, deleteAlbum,
} from '../../lib/albums';

// Album runtime in whole minutes. Deliberately coarse: "38 min" is what anyone
// wants to know about a record, where "38:14" invites a precision the number
// does not have — several of these durations are decoded estimates.
const fmtRuntime = (sec: number) => `${Math.max(1, Math.round(sec / 60))} min`;

// mm:ss for a single track's length in the list (null when unknown).
const formatDuration = (sec?: number | null): string | null => {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Fixed height of an edit-mode row — the reorder list positions rows by this, so
// the row's content (cover 46 + vertical breathing room) must sit inside it.
const DRAG_ROW_H = 64;

// The album screen: a listener's view, and the artist's workshop behind an Edit
// toggle. Both live here rather than in two screens, because the thing being
// edited IS the thing being looked at — a separate editor would mean judging
// the running order somewhere it does not look like a running order.
//
// REORDERING IS HOLD-AND-DRAG (owner's call, superseding the earlier buttons).
// The old note here warned off drag-inside-scrollers after the slideshow arranger
// / reel-pager / pinch-to-zoom fights, and that lesson is why this does NOT drag
// inside a virtualised FlatList: edit mode swaps to `ReorderableList`, a
// non-recycling list where each row holds a known Y and only the one lifted row
// is driven by the finger (see that component). The listener view keeps the plain
// FlatList. Drag is initiated from a dedicated ≡ handle, so a hold anywhere else
// never hijacks a scroll.

export default function AlbumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  // MEASURED, not a constant. The first version padded a fixed 40pt from the
  // top, which is fine on a phone with a notch and squashes Back and Edit up
  // against the clock on one with a Dynamic Island. Math.max keeps a floor for
  // devices reporting no inset at all.
  const insets = useSafeAreaInsets();
  const { playQueue, expand, currentTrack, isPlaying } = useAudio();

  const [album, setAlbum] = useState<Album | null>(null);
  const [artist, setArtist] = useState<any | null>(null);
  const [tracks, setTracks] = useState<AlbumTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState<any[] | null>(null);   // non-null = the add sheet is open
  const [renaming, setRenaming] = useState<{ postId: string | null; value: string } | null>(null);

  const load = useCallback(async () => {
    const [{ data: { user } }, a] = await Promise.all([supabase.auth.getUser(), fetchAlbum(String(id))]);
    setUid(user?.id ?? null);
    setAlbum(a);
    setTracks(a?.tracks ?? []);
    if (a) {
      const { data } = await supabase.from('profiles')
        .select('id, username, display_name, avatar_url, badge_tier, badge_show, profile_theme')
        .eq('id', a.user_id).maybeSingle();
      setArtist(data ?? null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const isOwn = !!album && album.user_id === uid;
  const cover = album ? albumCover({ ...album, tracks }) : null;
  const runtime = tracks.reduce((n, t) => n + (t.post?.duration_seconds ?? 0), 0);

  const queue = () => tracks
    .filter((t) => t.post?.media_url)
    .map((t) => ({
      id: t.post!.id, uri: t.post!.media_url,
      caption: trackTitle(t), artist: artist?.display_name ?? '', cover: t.post!.cover_url,
    }));

  const isActiveTrack = (item: AlbumTrack) => !!item.post?.id && currentTrack?.id === item.post?.id;

  // The shared middle of a track row — cover (with the now-playing mark) + title
  // and meta. Both the listener FlatList and the edit reorder list wrap this; the
  // number, the edit tools and the drag handle are added by each wrapper.
  const renderRowBody = (item: AlbumTrack, active: boolean) => {
    const rawTitle = trackTitle(item);
    const title = titleWithoutTrailingArtist(rawTitle, artist?.display_name ?? artist?.username ?? '') || rawTitle;
    const dur = formatDuration(item.post?.duration_seconds);
    return (
      <>
        <View style={styles.trackCoverWrap}>
          {item.post?.cover_url ? (
            <ExpoImage source={{ uri: item.post.cover_url }} style={styles.trackCover} contentFit="cover" cachePolicy="memory-disk" transition={coverFade(item.post.cover_url)} />
          ) : (
            <View style={[styles.trackCover, styles.trackCoverEmpty]}>
              <Ionicons name="musical-note" size={16} color={colors.textTertiary} />
            </View>
          )}
          {active && (
            <View style={styles.trackCoverOverlay}>
              <Ionicons name={isPlaying ? 'musical-notes' : 'pause'} size={16} color={colors.text} />
            </View>
          )}
        </View>
        <View style={styles.trackMain}>
          <Text style={[styles.trackTitle, active && styles.trackTitleActive]} numberOfLines={1}>
            {title || t('album.untitled')}
          </Text>
          <View style={styles.trackMeta}>
            <Ionicons name="play" size={9} color={colors.textTertiary} />
            <Text style={styles.trackMetaText}>{formatCount(item.post?.stream_count ?? 0)}</Text>
            {dur && <Text style={styles.trackMetaText}>· {dur}</Text>}
          </View>
        </View>
      </>
    );
  };

  // ── Edits. Every one of them writes THROUGH the local list rather than
  // reloading: the order is the thing being judged, and a round trip that
  // repaints from scratch loses the reading position mid-decision.
  // Commit a dragged reorder: the reorder list hands back the full id order, we
  // rebuild the row list in that order and persist it.
  async function persistOrder(orderedIds: string[]) {
    const byId = new Map(tracks.map((t) => [t.post_id, t]));
    const next = orderedIds.map((pid) => byId.get(pid)).filter(Boolean) as AlbumTrack[];
    if (next.length !== tracks.length) return; // stale order — ignore rather than corrupt
    setTracks(next);
    try { await reorderTracks(String(id), next.map((r) => r.post_id)); } catch { load(); }
  }

  async function drop(postId: string) {
    const keep = tracks.filter((r) => r.post_id !== postId);
    setTracks(keep);
    try {
      await removeTrack(String(id), postId);
      // Positions are only meaningful relative to each other, so closing the gap
      // matters — otherwise a later insert lands on a number already in use.
      await reorderTracks(String(id), keep.map((r) => r.post_id));
    } catch { load(); }
  }

  // The red "-" asks first — taking a song off an album is easy to fat-finger and
  // (unlike the song itself) there's no undo once the row is gone.
  function confirmDrop(postId: string) {
    Alert.alert(t('album.removeTrackTitle'), t('album.removeTrackBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('album.removeTrackConfirm'), style: 'destructive', onPress: () => drop(postId) },
    ]);
  }

  async function commitRename() {
    if (!renaming) return;
    const { postId, value } = renaming;
    setRenaming(null);
    try {
      if (postId === null) {
        await renameAlbum(String(id), value);
        setAlbum((a) => (a ? { ...a, title: value.trim() } : a));
      } else {
        const clean = value.trim() || null;
        await renameTrack(String(id), postId, clean);
        setTracks((prev) => prev.map((r) => (r.post_id === postId ? { ...r, title: clean } : r)));
      }
    } catch { load(); }
  }

  async function openPicker() {
    if (!album) return;
    try { setPicker(await fetchAddableTracks(album.user_id, album.id)); } catch { setPicker([]); }
  }

  async function pick(post: any) {
    setPicker((p) => (p ?? []).filter((r) => r.id !== post.id));
    try {
      await addTrack(String(id), post.id);
      setTracks((prev) => [...prev, {
        post_id: post.id, position: prev.length, title: null,
        post: { ...post, media_url: post.media_url ?? '', stream_count: post.stream_count ?? 0 },
      }]);
      // The picker's rows carry only what the list needed; re-reading gives the
      // new row its media_url so it is playable without leaving the screen.
      load();
    } catch { load(); }
  }

  function confirmDelete() {
    Alert.alert(t('album.deleteTitle'), t('album.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('album.delete'),
        style: 'destructive',
        onPress: async () => {
          try { await deleteAlbum(String(id)); router.back(); } catch { /* stay put */ }
        },
      },
    ]);
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={[styles.topBar, { paddingTop: Math.max(insets.top, SPACING.md) + SPACING.xs }]}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={22} color={colors.primaryLight} />
            <Text style={styles.backText}>{t('common.back')}</Text>
          </TouchableOpacity>
          {isOwn && !loading && !!album && (
            <TouchableOpacity onPress={() => setEditing((e) => !e)} hitSlop={8}>
              <Text style={styles.editBtn}>{editing ? t('common.done') : t('common.edit')}</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.divider} />

        {loading ? (
          <View style={styles.skeletonBody}>
            <View style={styles.header}>
              <Skeleton width={96} height={96} radius={RADIUS.md} />
              <View style={styles.headerInfo}>
                <SkeletonLine w="80%" h={22} />
                <SkeletonLine w="55%" h={12} style={{ marginTop: 9 }} />
              </View>
            </View>
            <View style={styles.divider} />
            <TrackListSkeleton rows={6} />
          </View>
        ) : !album ? (
          <View style={styles.center}>
            <Ionicons name="disc-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.unavailable}>{t('album.unavailable')}</Text>
          </View>
        ) : (
          <>
            <View style={styles.header}>
              {cover ? (
                <ExpoImage source={{ uri: cover }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" transition={coverFade(cover)} />
              ) : (
                <LinearGradient colors={GRADIENTS.primarySoft as any} style={styles.cover}>
                  <Ionicons name="disc" size={30} color={colors.primary} />
                </LinearGradient>
              )}
              <View style={styles.headerInfo}>
                <TouchableOpacity
                  disabled={!editing}
                  onPress={() => setRenaming({ postId: null, value: album.title })}
                  activeOpacity={0.7}
                >
                  <Text style={styles.title} numberOfLines={2}>
                    {album.title}
                    {editing ? <Text style={styles.titlePencil}>{'  '}✎</Text> : null}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => router.push(`/profile/${album.user_id}`)} hitSlop={6} disabled={isOwn}>
                  <Text style={styles.meta} numberOfLines={1}>
                    {isOwn ? t('album.yours') : <Text style={styles.metaAccent}>@{artist?.username ?? ''}</Text>}
                    {` · ${countLabel('track', tracks.length)}`}
                    {runtime > 0 ? ` · ${fmtRuntime(runtime)}` : ''}
                  </Text>
                </TouchableOpacity>
                {tracks.length > 0 && !editing && (
                  <TouchableOpacity style={styles.playAll} onPress={() => { playQueue(queue(), 0); expand(); }} activeOpacity={0.85}>
                    <Ionicons name="play" size={14} color={colors.background} style={{ marginLeft: 2 }} />
                    <Text style={styles.playAllText}>{t('album.play')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            <View style={styles.divider} />

            {editing ? (
              <>
                {/* Edit view — hold the ≡ handle and drag to reorder. A separate
                    non-virtualised list (ReorderableList) because a recycling
                    FlatList fights a drag that needs rows to hold a known Y. */}
                <ReorderableList
                  data={tracks}
                  keyExtractor={(it) => it.post_id}
                  rowHeight={DRAG_ROW_H}
                  rowBackground={colors.background}
                  onReorder={persistOrder}
                  renderItem={(item, index) => {
                    const active = isActiveTrack(item);
                    // The body (number + cover + title) is the drag target — hold
                    // anywhere on it and drag. The active cue rides the cover + title.
                    return (
                      <View style={styles.editRow}>
                        <View style={styles.trackNumCol}>
                          <Text style={styles.trackNum}>{index + 1}</Text>
                        </View>
                        {renderRowBody(item, active)}
                      </View>
                    );
                  }}
                  renderActions={(item) => (
                    <>
                      <TouchableOpacity onPress={() => setRenaming({ postId: item.post_id, value: trackTitle(item) })} hitSlop={6} style={styles.tool}>
                        <Ionicons name="pencil" size={16} color={colors.text} />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => confirmDrop(item.post_id)} hitSlop={6} style={styles.tool}>
                        <Ionicons name="remove-circle-outline" size={18} color={colors.error} />
                      </TouchableOpacity>
                    </>
                  )}
                />
                {isOwn && (
                  <View style={[styles.footer, { paddingBottom: SPACING.lg + insets.bottom }]}>
                    <Text style={styles.dragHint}>{t('album.dragHint')}</Text>
                    <TouchableOpacity style={styles.addBtn} onPress={openPicker} activeOpacity={0.85}>
                      <Ionicons name="add" size={19} color={colors.background} />
                      <Text style={styles.addBtnText}>{t('album.addTracks')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={confirmDelete} hitSlop={8} style={styles.deleteBtn}>
                      <Text style={styles.deleteText}>{t('album.delete')}</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </>
            ) : (
              <FlatList
                data={tracks}
                keyExtractor={(item) => item.post_id}
                // Home-indicator inset added to the list's own tail, so Add tracks
                // clears the gesture bar instead of sitting on it.
                contentContainerStyle={[styles.listContent, { paddingBottom: SPACING.xxl + insets.bottom }]}
                ListEmptyComponent={
                  <View style={styles.center}>
                    <Ionicons name="musical-notes-outline" size={40} color={colors.textTertiary} />
                    <Text style={styles.unavailable}>{t('album.empty')}</Text>
                    {isOwn && <Text style={styles.emptyHint}>{t('album.emptyHint')}</Text>}
                  </View>
                }
                ListFooterComponent={isOwn ? (
                  <View style={styles.footer}>
                    <TouchableOpacity style={styles.addBtn} onPress={openPicker} activeOpacity={0.85}>
                      <Ionicons name="add" size={19} color={colors.background} />
                      <Text style={styles.addBtnText}>{t('album.addTracks')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                ItemSeparatorComponent={() => <View style={styles.trackSep} />}
                renderItem={({ item, index }) => {
                  const active = isActiveTrack(item);
                  return (
                    <TouchableOpacity
                      style={[styles.trackRow, active && styles.trackRowActive]}
                      activeOpacity={0.6}
                      onPress={() => playQueue(queue(), index)}
                    >
                      {renderRowBody(item, active)}
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </>
        )}

        {/* Add tracks — the owner's own songs that are not already on it. */}
        <Modal visible={picker !== null} animationType="slide" transparent onRequestClose={() => setPicker(null)}>
          <View style={styles.sheetBackdrop}>
            <View style={styles.sheet}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{t('album.addTracks')}</Text>
                <TouchableOpacity onPress={() => setPicker(null)} hitSlop={10}>
                  <Ionicons name="close" size={22} color={colors.text} />
                </TouchableOpacity>
              </View>
              {picker && picker.length === 0 ? (
                <View style={styles.center}>
                  <Text style={styles.unavailable}>{t('album.addNone')}</Text>
                </View>
              ) : (
                <ScrollView contentContainerStyle={styles.sheetList}>
                  {(picker ?? []).map((p) => (
                    <TouchableOpacity key={p.id} style={styles.pickRow} onPress={() => pick(p)} activeOpacity={0.75}>
                      {p.cover_url ? (
                        <ExpoImage source={{ uri: p.cover_url }} style={styles.pickCover} contentFit="cover" cachePolicy="memory-disk" />
                      ) : (
                        <View style={[styles.pickCover, styles.pickCoverEmpty]}>
                          <Ionicons name="musical-note" size={16} color={colors.textTertiary} />
                        </View>
                      )}
                      <Text style={styles.pickTitle} numberOfLines={1}>{p.caption || t('album.untitled')}</Text>
                      <Ionicons name="add-circle" size={22} color={colors.text} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>

        {/* Rename — the album, or one track's name inside it. The dialog sits at
            the bottom, so it rides a KeyboardAvoidingView up above the keyboard
            (otherwise the keyboard covers the very field you're typing in), and a
            tap on the dimmed area dismisses the keyboard. */}
        <Modal visible={renaming !== null} animationType="fade" transparent onRequestClose={() => setRenaming(null)}>
          <KeyboardAvoidingView style={styles.kav} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableWithoutFeedback
              onPress={() => {
                // First tap with the keyboard up just lowers it; once it's down, a
                // tap outside closes the dialog — fading back to the album menu.
                if (Keyboard.isVisible()) Keyboard.dismiss();
                else setRenaming(null);
              }}
              accessible={false}
            >
              <View style={styles.sheetBackdrop}>
                {/* Absorbs taps so pressing the dialog itself never dismisses the
                    keyboard or closes it — only the dimmed area outside does. */}
                <TouchableWithoutFeedback onPress={() => {}} accessible={false}>
                  <View style={styles.dialog}>
                    <Text style={styles.sheetTitle}>
                      {renaming?.postId === null ? t('album.renameAlbum') : t('album.renameTrack')}
                    </Text>
                    {/* The note that makes the override understandable: this is the
                        name HERE, and the published song keeps its own. */}
                    {renaming?.postId !== null && <Text style={styles.dialogHint}>{t('album.renameTrackHint')}</Text>}
                    <TextInput
                      style={styles.input}
                      value={renaming?.value ?? ''}
                      onChangeText={(v) => setRenaming((r) => (r ? { ...r, value: v } : r))}
                      placeholder={t('album.namePlaceholder')}
                      placeholderTextColor={colors.textTertiary}
                      maxLength={120}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={commitRename}
                    />
                    <View style={styles.dialogBtns}>
                      <TouchableOpacity onPress={() => setRenaming(null)} style={[styles.dialogBtn, styles.dialogBtnGhost]}>
                        <Text style={styles.dialogBtnGhostText}>{t('common.cancel')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={commitRename} style={[styles.dialogBtn, styles.dialogBtnSolid]}>
                        <Text style={styles.dialogBtnSolidText}>{t('common.save')}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </TouchableWithoutFeedback>
              </View>
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // paddingTop is supplied at the call site from the safe-area inset.
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center' },
  backText: { color: colors.primaryLight, fontSize: 16, marginLeft: 2 },
  editBtn: { color: colors.primaryLight, fontSize: 16, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  skeletonBody: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xl, gap: SPACING.sm },
  unavailable: { color: colors.textSecondary, fontSize: 15, textAlign: 'center' },
  emptyHint: { color: quietText(colors), fontSize: 13, textAlign: 'center', maxWidth: 280 },

  // More air above the sleeve than below it: the cover is the first thing the
  // eye lands on after the bar, and sitting it tight under a hairline made the
  // whole screen feel like it started before it was ready to.
  header: {
    flexDirection: 'row', gap: SPACING.md,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.lg, paddingBottom: SPACING.md,
  },
  cover: { width: 96, height: 96, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceLight },
  headerInfo: { flex: 1, justifyContent: 'center' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  titlePencil: { color: colors.textTertiary, fontSize: 15 },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
  metaAccent: { color: colors.text, fontWeight: '700' },
  playAll: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    marginTop: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: 7,
    borderRadius: RADIUS.full, backgroundColor: colors.text,
  },
  playAllText: { color: colors.background, fontSize: 13.5, fontWeight: '800' },

  listContent: { paddingBottom: SPACING.xxl },
  // A flat, tight album row — number (or a now-playing mark) · cover · title ·
  // plays/length. No per-row card, border or repeated artist/handle: the album
  // art and the one artist already live in the header, so the list stays about
  // the songs and the numbers line up in a clean column.
  trackRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    paddingVertical: 9, paddingHorizontal: SPACING.md,
  },
  trackRowActive: { backgroundColor: colors.text + '0D' },
  // Tabular so the column does not shuffle sideways as it passes 9 to 10.
  trackNumCol: { width: 22, alignItems: 'center', justifyContent: 'center' },
  trackNum: { color: quietText(colors), fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  trackCoverWrap: { width: 46, height: 46, borderRadius: RADIUS.md, overflow: 'hidden' },
  trackCover: { width: 46, height: 46, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight },
  trackCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  // Scrim + mark over the artwork of the loaded row — the page colour, so the
  // text-colour glyph on top contrasts in every theme (same idea as TrackRow).
  trackCoverOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background + '8C',
  },
  trackMain: { flex: 1, justifyContent: 'center' },
  trackTitle: { color: colors.text, fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2 },
  trackTitleActive: { color: colors.primary },
  trackMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  trackMetaText: { color: colors.textTertiary, fontSize: 12 },
  // Hairline between rows, inset to begin at the title (past the number + cover),
  // so the list reads as grouped songs rather than detached cards.
  trackSep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: SPACING.md * 2 + 46, marginRight: SPACING.md },
  // Edit-mode row body (the drag target): centred, horizontal padding only. The
  // opaque background now lives on the reorder row itself, and the pencil/remove
  // actions are rendered beside this by ReorderableList, outside the drag gesture.
  editRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingLeft: SPACING.md },
  dragHint: { color: quietText(colors), fontSize: 12.5, textAlign: 'center' },
  rowTools: { flexDirection: 'row', alignItems: 'center', paddingRight: SPACING.sm },
  tool: { paddingHorizontal: 5, paddingVertical: 6 },

  footer: { padding: SPACING.md, gap: SPACING.md, alignItems: 'center' },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.full, backgroundColor: colors.text, alignSelf: 'stretch',
  },
  addBtnText: { color: colors.background, fontSize: 15, fontWeight: '700' },
  deleteBtn: { paddingVertical: SPACING.sm },
  deleteText: { color: colors.error, fontSize: 14, fontWeight: '700' },

  kav: { flex: 1 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.background, borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg,
    maxHeight: '80%', paddingBottom: SPACING.xl,
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: SPACING.md,
  },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  sheetList: { paddingHorizontal: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.md },
  pickRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.sm, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight,
  },
  pickCover: { width: 44, height: 44, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceElevated },
  pickCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  pickTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },

  dialog: {
    // marginBottom 0: the KeyboardAvoidingView already lifts this to the keyboard's
    // top edge, so ANY bottom margin just reopens the gap. Sit flush on the keys.
    margin: SPACING.md, marginBottom: 0, padding: SPACING.md, gap: SPACING.sm,
    backgroundColor: colors.background, borderRadius: RADIUS.lg,
  },
  dialogHint: { color: quietText(colors), fontSize: 12.5, lineHeight: 17 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: 11,
    color: colors.text, fontSize: 15, backgroundColor: colors.surfaceLight,
  },
  dialogBtns: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xs },
  dialogBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: RADIUS.full },
  dialogBtnGhost: { backgroundColor: colors.surfaceLight },
  dialogBtnGhostText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dialogBtnSolid: { backgroundColor: colors.text },
  dialogBtnSolidText: { color: colors.background, fontSize: 15, fontWeight: '700' },
});
