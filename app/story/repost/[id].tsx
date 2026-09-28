import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  Dimensions, Keyboard, TextInput, Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import RepostPostMedia, { repostCardSize } from '../../../components/RepostPostMedia';
import StickerLayer, { type Sticker, type CaptionStyle, type StickerBg, type StickerFont } from '../../../components/StickerLayer';
import RepostTextEditor from '../../../components/RepostTextEditor';
import { StoryBackground, StoryBackgroundPicker, DEFAULT_BG, type StoryBg } from '../../../components/StoryBackgroundLayer';
import { StoryDrawRenderer, StoryDrawCanvas, type DrawStroke } from '../../../components/StoryDrawLayer';
import SongPickerModal, { type PickedSong } from '../../../components/SongPickerModal';
import MentionSuggestions from '../../../components/MentionSuggestions';
import { getActiveMentionQuery, applyMention } from '../../../lib/mentions';
import { supabase } from '../../../lib/supabase';
import { createStoryRepost, type StorySticker } from '../../../lib/stories';
import { aspectToNumber } from '../../../lib/aspectRatio';
import { useProfile } from '../../../contexts/ProfileContext';
import { useStories } from '../../../contexts/StoriesContext';
import { useAudioControls } from '../../../contexts/AudioContext';
import { usePostMusicActions, useSongHostActive } from '../../../contexts/PostMusicContext';
import { useTranslation } from '../../../contexts/LanguageContext';
import { SPACING, RADIUS, type ThemePalette } from '../../../constants/theme';
import { useTheme, useThemedStyles } from '../../../contexts/ThemeContext';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const HOST = 'repost-editor';

type PostRow = {
  type: string;
  media_url: string | null;
  thumbnail_url: string | null;
  cover_url: string | null;
  aspect_ratio: string | null;
  duration_seconds: number | null;
  username: string | null;
  avatar_url: string | null;
};

// "Post to story" EDITOR (Instagram-style): the post sits as a movable/resizable
// frame on a chosen background, and you get the full story toolset — text, emoji,
// music (image reposts), a background picker and a pen. The post + background +
// strokes + text all ride in the stories.stickers jsonb and the viewer composes
// them live, so what you build here is what watchers see.
export default function RepostEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); // the post being reshared
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { profile } = useProfile();
  const { refresh } = useStories();
  const { pause: pauseMusic } = useAudioControls();
  const { playSong, stop: stopSong } = usePostMusicActions();
  const previewing = useSongHostActive(HOST);

  const [post, setPost] = useState<PostRow | null | undefined>(undefined);
  const [sharing, setSharing] = useState(false);

  // ── Editor state ────────────────────────────────────────────────────────────
  const stickerIdRef = useRef(0);
  // The reshared post is the FIRST sticker (kind:'post'), centred at scale 1; the
  // rest are text/emoji. The same gesture layer moves them all.
  const [stickers, setStickers] = useState<Sticker[]>([
    { id: 'post', kind: 'post', text: '', x: 0.5, y: 0.5, scale: 1, rotation: 0 },
  ]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [editingFont, setEditingFont] = useState<StickerFont>('classic');
  const [editingColor, setEditingColor] = useState('#FFFFFF');
  const [editingBg, setEditingBg] = useState<StickerBg>('none');
  const [editingSize, setEditingSize] = useState(26);
  const [bg, setBg] = useState<StoryBg>(DEFAULT_BG);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [caption, setCaption] = useState('');
  const [song, setSong] = useState<PickedSong | null>(null);
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [showCaption, setShowCaption] = useState(false);
  const [tool, setTool] = useState<'none' | 'bg' | 'draw'>('none');
  const [dragActive, setDragActive] = useState(false);
  const [dragIsPost, setDragIsPost] = useState(false); // the post can't be deleted → no trash
  const [overTrash, setOverTrash] = useState(false);

  // Stop the user's music so a reshared video's own audio (or a chosen song) is
  // what plays — pause, never stop (audio-session-hazard).
  useEffect(() => { pauseMusic(); }, [pauseMusic]);
  useEffect(() => () => { stopSong(HOST); }, [stopSong]);

  useEffect(() => {
    let alive = true;
    supabase
      .from('posts')
      .select('type, media_url, thumbnail_url, cover_url, aspect_ratio, duration_seconds, profiles!posts_user_id_fkey(username, avatar_url)')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        if (!alive) return;
        const d = data as any;
        if (!d) { setPost(null); return; }
        const prof = Array.isArray(d.profiles) ? d.profiles[0] : d.profiles;
        setPost({ ...d, username: prof?.username ?? null, avatar_url: prof?.avatar_url ?? null });
      }, () => { if (alive) setPost(null); });
    return () => { alive = false; };
  }, [id]);

  const isVideo = post?.type === 'video';
  // Fallback MUST match what createStoryRepost stores (video → 9:16, else 1:1), or a
  // post with no aspect_ratio (audio / legacy) previews at one shape and posts at
  // another.
  const aspect = aspectToNumber(post?.aspect_ratio, isVideo ? 9 / 16 : 1);
  const { cardW, cardH } = useMemo(
    () => repostCardSize(SCREEN_W, SCREEN_H, insets.top, insets.bottom, aspect),
    [insets.top, insets.bottom, aspect],
  );
  const backdrop = post?.thumbnail_url ?? post?.cover_url ?? (post?.type === 'image' ? post?.media_url : null);

  // ── Text / emoji stickers ─────────────────────────────────────────────────
  function addStickerAt(xNorm: number, yNorm: number) {
    const sid = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, {
      id: sid, text: '', x: xNorm, y: yNorm, scale: 1, rotation: 0,
      font: editingFont, color: editingColor, bg: editingBg, size: editingSize,
    }]);
    setEditingId(sid);
    setEditingText('');
  }
  function editSticker(sid: string) {
    if (sid === 'post') return; // the post is placed, not text-edited
    const s = stickers.find((x) => x.id === sid);
    if (s?.emoji) return;
    setEditingId(sid);
    setEditingText(s?.text ?? '');
    setEditingFont((s?.font as StickerFont) ?? 'classic');
    setEditingColor(s?.color ?? '#FFFFFF');
    setEditingBg((s?.bg as StickerBg) ?? 'none');
    setEditingSize(s?.size ?? 26);
  }
  function manipulateSticker(sid: string, style: CaptionStyle) {
    setStickers((prev) => prev.map((s) => (s.id === sid ? { ...s, ...style } : s)));
  }
  const commitEditing = useCallback((vals: { text: string; font: StickerFont; color: string; bg: StickerBg; size: number }) => {
    setStickers((prev) =>
      prev
        .map((s) => (s.id === editingId
          ? { ...s, text: vals.text.trim(), font: vals.font, color: vals.color, bg: vals.bg, size: vals.size }
          : s))
        .filter((s) => s.kind === 'post' || s.text !== ''),
    );
    setEditingFont(vals.font); setEditingColor(vals.color); setEditingBg(vals.bg); setEditingSize(vals.size);
    setEditingId(null); setEditingText('');
  }, [editingId]);

  function inTrashZone(xNorm: number, yNorm: number) {
    const x = xNorm * SCREEN_W, y = yNorm * SCREEN_H;
    return y > SCREEN_H - insets.bottom - 150 && Math.abs(x - SCREEN_W / 2) < 80;
  }
  function onStickerRelease(sid: string, xNorm: number, yNorm: number) {
    setOverTrash(false);
    if (sid !== 'post' && inTrashZone(xNorm, yNorm)) {
      setStickers((prev) => prev.filter((s) => s.id !== sid));
    }
  }

  // The post frame drawn inside the gesture layer (StickerLayer measures + moves it).
  const renderPost = useCallback((_s: Sticker): ReactNode => {
    if (!post) return null;
    return (
      <View style={[styles.card, { width: cardW, height: cardH }]}>
        <RepostPostMedia post={post} active={isFocused} loop />
        <View style={styles.chip} pointerEvents="none">
          <Text style={styles.chipName} numberOfLines={1}>@{post.username ?? 'laybell'}</Text>
        </View>
      </View>
    );
  }, [post, cardW, cardH, isFocused, styles]);

  async function share() {
    if (!profile?.id || sharing || !post) return;
    setSharing(true);
    try {
      const layers: StorySticker[] = [];
      if (bg.type !== 'blur') layers.push({ kind: 'bg', background: bg });
      const ps = stickers.find((s) => s.kind === 'post');
      layers.push({ kind: 'post', id: 'post', x: ps?.x ?? 0.5, y: ps?.y ?? 0.5, scale: ps?.scale ?? 1, rotation: ps?.rotation ?? 0 });
      if (strokes.length) layers.push({ kind: 'draw', strokes });
      for (const s of stickers) {
        if (s.kind === 'post' || !s.text) continue;
        layers.push({ text: s.text, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation, font: s.font, color: s.color, bg: s.bg, size: s.size, emoji: s.emoji });
      }
      await createStoryRepost({
        userId: profile.id,
        postId: id,
        post,
        layers,
        caption: caption.trim() || null,
        song: !isVideo && song ? { id: song.id, title: song.title, artist: song.artist, artistId: song.artistId } : null,
      });
      refresh();
      router.back();
    } catch {
      setSharing(false);
      Alert.alert(t('common.error'), t('postOptions.postToStoryFailed'));
    }
  }

  // ── Loading / gone ──────────────────────────────────────────────────────────
  if (post === undefined) {
    return <View style={styles.container}><View style={styles.center}><ActivityIndicator color="#fff" /></View></View>;
  }
  if (post === null) {
    return (
      <View style={styles.container}>
        <View style={styles.center}><Text style={styles.err}>{t('sharedCard.unavailable')}</Text></View>
        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  const drawing = tool === 'draw';

  return (
    <View style={styles.container}>
      {/* Background (blurred still / solid / gradient) */}
      <StoryBackground bg={bg} backdropUri={backdrop} />

      {/* Post + text/emoji stickers — one gesture layer routes to the nearest. */}
      <StickerLayer
        stickers={stickers}
        frameW={SCREEN_W}
        frameH={SCREEN_H}
        editingId={editingId}
        renderKind={renderPost}
        onManipulate={manipulateSticker}
        onTapSticker={editSticker}
        onTapEmpty={(x, y) => {
          if (showCaption) { Keyboard.dismiss(); setShowCaption(false); return; }
          addStickerAt(x, y);
        }}
        onDragActive={(a, sid) => { setDragActive(a); setDragIsPost(a ? sid === 'post' : false); if (!a) setOverTrash(false); }}
        onDragMove={(x, y) => { const over = inTrashZone(x, y); setOverTrash((prev) => (prev === over ? prev : over)); }}
        onRelease={onStickerRelease}
      />

      {/* Committed pen strokes sit above the post + text (drawing is the top layer). */}
      {!drawing && strokes.length > 0 && <StoryDrawRenderer strokes={strokes} frameW={SCREEN_W} frameH={SCREEN_H} />}

      {/* Drop-to-delete target (text/emoji stickers only — never the post) */}
      {dragActive && !dragIsPost && (
        <View style={[styles.trashZone, { bottom: insets.bottom + 56 }]} pointerEvents="none">
          <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
            <Ionicons name="trash-outline" size={overTrash ? 30 : 24} color="#fff" />
          </View>
        </View>
      )}

      {/* Back */}
      {!drawing && !editingId && (
        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={() => router.back()} hitSlop={12} accessibilityLabel={t('a11y.back')}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Tool rail — text, draw, background, music (image reposts), caption */}
      {!drawing && !dragActive && !editingId && (
        <View style={[styles.toolRail, { top: insets.top + 8 }]}>
          <TouchableOpacity style={styles.roundBtn} onPress={() => addStickerAt(0.5, 0.3)} accessibilityLabel={t('storyCamera.done')}>
            <Text style={styles.aaBtnText}>Aa</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.roundBtn} onPress={() => setTool('draw')}>
            <Ionicons name="brush-outline" size={22} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.roundBtn, tool === 'bg' && styles.roundBtnActive]} onPress={() => setTool((tt) => (tt === 'bg' ? 'none' : 'bg'))}>
            <Ionicons name="color-palette-outline" size={22} color="#fff" />
          </TouchableOpacity>
          {!isVideo && (
            <TouchableOpacity style={styles.roundBtn} onPress={() => setShowSongPicker(true)}>
              <Ionicons name={song ? 'musical-notes' : 'musical-notes-outline'} size={22} color={song ? colors.primaryLight : '#fff'} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.roundBtn} onPress={() => setShowCaption(true)}>
            <Ionicons name={caption.trim() ? 'chatbox-ellipses' : 'chatbox-ellipses-outline'} size={22} color={caption.trim() ? colors.primaryLight : '#fff'} />
          </TouchableOpacity>
        </View>
      )}

      {/* Background picker rail */}
      {tool === 'bg' && !drawing && (
        <View style={[styles.bgRail, { bottom: insets.bottom + 92 }]}>
          <StoryBackgroundPicker value={bg} onChange={setBg} backdropUri={backdrop} />
        </View>
      )}

      {/* Bottom: song card + caption + Share */}
      {!drawing && !dragActive && !editingId && (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + SPACING.md }]} pointerEvents="box-none">
          {!isVideo && song && (
            <View style={styles.songCard}>
              {song.cover ? (
                <Image source={{ uri: song.cover }} style={styles.songCover} />
              ) : (
                <View style={[styles.songCover, styles.songCoverEmpty]}><Ionicons name="musical-notes" size={18} color="#fff" /></View>
              )}
              <View style={styles.songInfo}>
                <Text style={styles.songTitle} numberOfLines={1}>{song.title}</Text>
                <Text style={styles.songArtist} numberOfLines={1}>{song.artist}</Text>
              </View>
              <TouchableOpacity onPress={() => (previewing ? stopSong(HOST) : playSong(HOST, song.id))} hitSlop={6} accessibilityLabel={previewing ? t('a11y.pause') : t('a11y.play')}>
                <Ionicons name={previewing ? 'pause-circle' : 'play-circle'} size={42} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.songBtn} onPress={() => { stopSong(HOST); setSong(null); }} hitSlop={6} accessibilityLabel={t('a11y.close')}>
                <Ionicons name="close" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          )}
          {showCaption ? (
            <>
              <MentionSuggestions
                query={getActiveMentionQuery(caption, caption.length)}
                onPick={(u) => setCaption(applyMention(caption, caption.length, u).text)}
                style={{ marginBottom: SPACING.xs }}
                maxHeight={150}
              />
              <TextInput
                style={styles.captionInput}
                placeholder={t('storyCamera.captionPlaceholder')}
                placeholderTextColor="rgba(255,255,255,0.7)"
                value={caption}
                onChangeText={setCaption}
                onBlur={() => setShowCaption(false)}
                autoFocus
                maxLength={200}
              />
            </>
          ) : caption.trim() ? (
            <TouchableOpacity style={styles.captionPreview} onPress={() => setShowCaption(true)}>
              <Text style={styles.captionPreviewText} numberOfLines={2}>{caption}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.shareBtn} onPress={share} disabled={sharing} activeOpacity={0.85}>
            {sharing ? <ActivityIndicator color="#000" /> : (
              <>
                <Text style={styles.shareText}>{t('repost.shareToStory')}</Text>
                <Ionicons name="arrow-forward-circle" size={22} color="#000" />
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Full-screen text editor */}
      {editingId && (
        <RepostTextEditor
          key={editingId}
          initialText={editingText}
          initialFont={editingFont}
          initialColor={editingColor}
          initialBg={editingBg}
          initialSize={editingSize}
          onCommit={commitEditing}
        />
      )}

      {/* Draw mode (top layer, captures the pen) */}
      {drawing && (
        <StoryDrawCanvas
          strokes={strokes}
          onChange={setStrokes}
          onClose={() => setTool('none')}
          frameW={SCREEN_W}
          frameH={SCREEN_H}
          insetsTop={insets.top}
          insetsBottom={insets.bottom}
        />
      )}

      <SongPickerModal
        visible={showSongPicker}
        onClose={() => setShowSongPicker(false)}
        onSelect={(s) => { stopSong(HOST); setSong(s); }}
      />
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  err: { color: 'rgba(255,255,255,0.7)', fontSize: 15 },
  card: {
    borderRadius: RADIUS.xl, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  chip: {
    position: 'absolute', top: SPACING.sm, left: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
  },
  chipName: { color: '#fff', fontSize: 13, fontWeight: '700', maxWidth: 180 },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  roundBtnActive: { backgroundColor: colors.primary, borderColor: '#fff' },
  aaBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  toolRail: { position: 'absolute', right: SPACING.md, gap: SPACING.sm },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)',
  },
  trashCircleHot: { backgroundColor: colors.error, borderColor: '#fff', transform: [{ scale: 1.15 }] },
  bgRail: { position: 'absolute', left: 0, right: 0 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: SPACING.md, gap: SPACING.sm },
  captionInput: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md, color: '#fff', fontSize: 15,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
  },
  captionPreview: {
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, alignSelf: 'flex-start', maxWidth: '100%',
  },
  captionPreviewText: { color: '#fff', fontSize: 14, lineHeight: 19 },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: SPACING.md,
  },
  shareText: { color: '#000', fontSize: 16, fontWeight: '800' },
  songCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)', padding: SPACING.sm + 4,
  },
  songCover: { width: 46, height: 46, borderRadius: RADIUS.sm, overflow: 'hidden' },
  songCoverEmpty: { backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  songInfo: { flex: 1 },
  songTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  songArtist: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 1 },
  songBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
});
