import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Image, TextInput, Dimensions, Pressable, KeyboardAvoidingView,
  Platform, Keyboard, PanResponder, ScrollView, Animated, Easing, Modal,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AppVideo from './AppVideo';
import FilteredVideoPreview from './FilteredVideoPreview';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, Feather } from '@expo/vector-icons';
import { type CapturedMedia } from './CaptureCamera';
import SongPickerModal, { type PickedSong } from './SongPickerModal';
import { SongPartStrip, SOUND_H_PAD } from './SoundControls';
import MentionSuggestions from './MentionSuggestions';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type Sticker, type CaptionStyle, type StickerBg, type StickerFont,
} from './StickerLayer';
import { LinkStickerContent } from './LinkSticker';
import { PollStickerContent } from './PollSticker';
import { MusicStickerContent } from './MusicSticker';
import { CommunityStickerContent } from './CommunitySticker';
import { ShopStickerContent } from './ShopSticker';
import { EmojiSliderContent } from './EmojiSlider';
import { EmojiReactionContent } from './EmojiReaction';
import { InfoStickerContent } from './InfoSticker';
import { CountdownStickerContent } from './CountdownSticker';
import GifPickerModal from './GifPickerModal';
import RepostPostMedia, { repostCardSize } from './RepostPostMedia';
import StoryCollage from './StoryCollage';
import StoryBoomerang from './StoryBoomerang';
import EffectsTray from './EffectsTray';
import { type FilterKey } from '../lib/filters';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { videoFilterAvailable } from '../modules/laybell-video-export';
import { useFilteredUri } from '../lib/useFilteredMedia';
import { fetchMyPostableCommunities, type PostableCommunity } from '../lib/communities';
import { fetchSellerListings, listingPriceLabel, type ShopListing } from '../lib/shop';
import { StoryDrawCanvas, StoryDrawRenderer, type DrawStroke } from './StoryDrawLayer';
import { StoryBackground, DEFAULT_BG, type StoryBg } from './StoryBackgroundLayer';
import { getActiveMentionQuery, applyMention } from '../lib/mentions';
import { aspectToNumber } from '../lib/aspectRatio';
import { supabase } from '../lib/supabase';
import { clampStart, formatClock } from '../lib/songMix';
import {
  STORY_MUSIC_MIN_SEC, STORY_MUSIC_MAX_SEC, STORY_MUSIC_DEFAULT_SEC,
  fetchSuggestedSong, type SuggestedSong, type StorySticker,
} from '../lib/stories';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useAudioControls } from '../contexts/AudioContext';
import { usePostMusicActions } from '../contexts/PostMusicContext';
import { selection } from '../lib/haptics';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// A single playback host — only one StoryEditor is ever mounted at a time (you are
// either on the camera tab OR on the pushed repost route, never both in edit mode).
const HOST = 'story-editor';

// Clip-length choices for the story-music duration menu (5s … 25s).
const DURATION_OPTIONS = Array.from(
  { length: STORY_MUSIC_MAX_SEC - STORY_MUSIC_MIN_SEC + 1 },
  (_, i) => STORY_MUSIC_MIN_SEC + i,
);

// Text-size slider range (editor): top of the track = biggest type.
const SLIDER_H = Math.round(Math.min(176, SCREEN_H * 0.21));
const SIZE_MIN = 14;
const SIZE_MAX = 56;
// Emoji choices offered for the slider + reaction stickers.
const STICKER_EMOJIS = ['😍', '🔥', '😂', '😮', '😢', '👏', '❤️', '💯'];

// The reshared post, when the editor is built around one instead of a fresh capture.
export type StoryEditorPost = {
  type: string;
  media_url: string | null;
  thumbnail_url: string | null;
  cover_url: string | null;
  aspect_ratio: string | null;
  duration_seconds: number | null;
  username: string | null;
  avatar_url: string | null;
};

// What the editor is built around: a fresh capture (story camera) or a reshared post
// (the "Add to story" repost flow). This is the ONLY thing that differs between the two.
export type StoryEditorMedia =
  | { kind: 'captured'; captured: CapturedMedia }
  | { kind: 'post'; post: StoryEditorPost }
  | { kind: 'collage'; layout: string; slots: string[] }
  | { kind: 'boomerang'; frames: string[] };

// Everything the editor produces on "Add to story" — the host (camera vs repost) adds
// its own media reference (the captured file, or the postId) and calls its backend.
export type StoryEditorResult = {
  caption: string | null;
  song: { id: string; title: string; artist: string; artistId: string } | null;
  songStartSec: number | null;
  songClipSec: number | null;
  aspectRatio: string;
  durationSeconds: number | null;
  filter: FilterKey; // the chosen color filter; the host bakes it into a captured photo
  stickers: StorySticker[]; // fully assembled layers (placed + media + draw + bg)
};

// THE story editor — the single, shared edit surface used by BOTH the live story camera
// (app/(tabs)/story-camera.tsx) and the "Add to story" repost screen
// (app/story/repost/[id].tsx). The camera keeps only its capture stage + lifecycle and
// renders this once a capture exists; the repost screen renders this directly over the
// reshared post. Because there is exactly ONE implementation, the two can never drift.
export default function StoryEditor({
  media, onClose, onShare, sharing, shareLabel, initialFilter,
}: {
  media: StoryEditorMedia;
  onClose: () => void;
  onShare: (result: StoryEditorResult) => void;
  sharing?: boolean;
  shareLabel?: string;
  initialFilter?: FilterKey;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { pause: pauseMusic } = useAudioControls();
  const { playSong, stop: stopSong } = usePostMusicActions();

  const captured = media.kind === 'captured' ? media.captured : null;
  const post = media.kind === 'post' ? media.post : null;
  const collage = media.kind === 'collage' ? media : null;
  const boomerang = media.kind === 'boomerang' ? media : null;
  const isPost = media.kind === 'post';
  // A reshared video keeps its OWN audio, so music is offered for captures + image
  // reposts only (otherwise the viewer would play a song over the video's sound).
  const allowMusic = media.kind === 'captured' || post?.type !== 'video';

  // Arriving pauses the user's music — PAUSE never stop (audio-session-hazard).
  useEffect(() => { pauseMusic(); }, [pauseMusic]);
  useEffect(() => () => { stopSong(HOST); }, [stopSong]);

  // Smoothly animated bottom offset for the caption bar.
  const kbAnim = useRef(new Animated.Value(insets.bottom)).current;
  const editingRef = useRef(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const s = Keyboard.addListener(showEvt, (e) => {
      if (editingRef.current) return; // the text-sticker editor's own keyboard — leave the caption bar at rest
      const kh = e.endCoordinates?.height ?? 0;
      setKbHeight(kh);
      Animated.timing(kbAnim, { toValue: kh, duration: e.duration || 250, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    });
    const h = Keyboard.addListener(hideEvt, (e) => {
      if (editingRef.current) return;
      setKbHeight(0);
      Animated.timing(kbAnim, { toValue: insets.bottom, duration: e?.duration || 220, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    });
    return () => { s.remove(); h.remove(); };
  }, [insets.bottom, kbAnim]);

  // ── Editor state ────────────────────────────────────────────────────────────
  const [caption, setCaption] = useState('');
  // The reshared post (if any) is the FIRST sticker (kind:'post'); captures start empty.
  const [stickers, setStickers] = useState<Sticker[]>(
    isPost ? [{ id: 'post', kind: 'post', text: '', x: 0.5, y: 0.5, scale: 1, rotation: 0 }] : [],
  );
  const [stickerSheet, setStickerSheet] = useState(false);
  const [linkDraft, setLinkDraft] = useState<{ id: string | null; url: string; title: string } | null>(null);
  const [pollDraft, setPollDraft] = useState<{ id: string | null; pollId: string; question: string; options: string[] } | null>(null);
  const [strokes, setStrokes] = useState<DrawStroke[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [bg, setBg] = useState<StoryBg>(DEFAULT_BG);
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => { editingRef.current = !!editingId; }, [editingId]);
  const [editingText, setEditingText] = useState('');
  const [editingFont, setEditingFont] = useState<StickerFont>('classic');
  const [editingColor, setEditingColor] = useState('#FFFFFF');
  const [editingBg, setEditingBg] = useState<StickerBg>('none');
  const [editingSize, setEditingSize] = useState(26);
  const [kbHeight, setKbHeight] = useState(0);
  const stickerIdRef = useRef(0);
  const [song, setSong] = useState<PickedSong | null>(null);
  const [suggested, setSuggested] = useState<SuggestedSong | null>(null);
  useEffect(() => {
    if (!allowMusic) return;
    let alive = true;
    fetchSuggestedSong().then((s) => { if (alive) setSuggested(s); }).catch(() => {});
    return () => { alive = false; };
  }, [allowMusic]);
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [songPickerMode, setSongPickerMode] = useState<'background' | 'sticker'>('background');
  const openSongPicker = (mode: 'background' | 'sticker') => { setSongPickerMode(mode); setShowSongPicker(true); };
  const [communityPickerOpen, setCommunityPickerOpen] = useState(false);
  const [communities, setCommunities] = useState<PostableCommunity[]>([]);
  const [shopPickerOpen, setShopPickerOpen] = useState(false);
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [sliderEdit, setSliderEdit] = useState<string | null>(null);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [countdownDraft, setCountdownDraft] = useState<{ title: string; dayIdx: number; hour: number } | null>(null);
  useEffect(() => {
    if (!communityPickerOpen) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const list = await fetchMyPostableCommunities(data.user?.id ?? null).catch(() => []);
      if (alive) setCommunities(list);
    })();
    return () => { alive = false; };
  }, [communityPickerOpen]);
  useEffect(() => {
    if (!shopPickerOpen) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const list = data.user?.id ? await fetchSellerListings(data.user.id).catch(() => []) : [];
      if (alive) setListings(list);
    })();
    return () => { alive = false; };
  }, [shopPickerOpen]);
  const [songStartSec, setSongStartSec] = useState(0);
  const [songClipSec, setSongClipSec] = useState(STORY_MUSIC_DEFAULT_SEC);
  const [songDragStart, setSongDragStart] = useState<number | null>(null);
  const [songInfo, setSongInfo] = useState<{ id: string; url: string | null; durationSec: number } | null>(null);
  const [songDone, setSongDone] = useState(false);
  const [showDurationPicker, setShowDurationPicker] = useState(false);
  useEffect(() => {
    const sid = song?.id;
    if (!sid || songInfo?.id === sid) return;
    let cancelled = false;
    supabase.from('posts').select('media_url, duration_seconds').eq('id', sid).single()
      .then(({ data }) => {
        if (cancelled) return;
        const d: any = data;
        setSongInfo({ id: sid, url: d?.media_url ?? null, durationSec: Number(d?.duration_seconds) || 0 });
      }, () => { if (!cancelled) setSongInfo({ id: sid, url: null, durationSec: 0 }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);
  const songSec = song && songInfo?.id === song.id ? (songInfo?.durationSec ?? 0) : 0;
  const songUrl = song && songInfo?.id === song.id ? (songInfo?.url ?? null) : null;
  const clipSec = Math.min(STORY_MUSIC_MAX_SEC, Math.max(STORY_MUSIC_MIN_SEC, songClipSec));
  const songStart = clampStart(songStartSec, songSec, clipSec);
  // A shop sticker whose listing has a preview becomes the story's audio (where music is
  // allowed). One audio source only, so the music sticker is blocked while one is placed.
  const shopSticker = stickers.find((s) => s.kind === 'shop' && !!s.preview);
  const shopAudioId = shopSticker?.listingId ?? null;
  const shopAudioUrl = allowMusic ? (shopSticker?.preview ?? null) : null;
  const hasShopAudio = !!shopAudioUrl;
  useEffect(() => {
    if (showSongPicker) { stopSong(HOST); return; }
    if (song) playSong(HOST, song.id, songUrl, { startSec: songStart, volume: 1, videoStartSec: 0, clipSec });
    else if (shopAudioId && shopAudioUrl) playSong(HOST, shopAudioId, shopAudioUrl, { startSec: 0, volume: 1, videoStartSec: 0, clipSec: STORY_MUSIC_MAX_SEC });
    else stopSong(HOST);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id, songStart, clipSec, songUrl, showSongPicker, shopAudioId, shopAudioUrl]);
  const [showCaption, setShowCaption] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [dragIsPost, setDragIsPost] = useState(false);
  const [overTrash, setOverTrash] = useState(false);

  // ── Reshared-post geometry (post mode) ────────────────────────────────────────
  const isVideoPost = post?.type === 'video';
  const postAspect = aspectToNumber(post?.aspect_ratio, isVideoPost ? 9 / 16 : 1);
  // A "still" story (photo / image repost / collage / boomerang-capture) can trim the song
  // + choose how long it stays up; a video keeps its own length. Drives the song trim +
  // clip-length UI AND the serialized offsets, so they behave identically across all four.
  const isStill = captured?.type === 'image' || (isPost && !isVideoPost) || !!collage || !!boomerang;

  // ── Effects (color filters) ───────────────────────────────────────────────────
  // A GPU `filter` style on the media only (lib/filters). Stills only — videos keep their
  // own look (and `filter` on a live video texture is unreliable). Stored as a 'filter'
  // layer so the viewer applies the exact same css.
  const [filterKey, setFilterKey] = useState<FilterKey>(initialFilter ?? 'original');
  const [effectsOpen, setEffectsOpen] = useState(false);
  // Color filters are BAKED into the pixels (RN's `filter` style doesn't apply color effects
  // on iOS). Scoped to a single captured PHOTO so the on-the-fly bake stays snappy
  // (collage/boomerang = many frames = too slow; reposts/video excluded).
  // Photos always; videos too when this build's exporter can bake a filter into a clip
  // (older builds can't — no OTA). A video bakes on share in the host; here it previews with
  // a live tint + the chips. A collage/boomerang/repost still can't be filtered.
  const canFilterVideo = captured?.type === 'video' && videoFilterAvailable();
  const canEffects = captured?.type === 'image' || canFilterVideo;
  // A small baked preview of the PHOTO for the chosen filter; the original otherwise. (The
  // chips bake their own thumbnails; the upload re-bakes at full size.) A video doesn't bake
  // a still here — Skia can't read a video file — it uses a thumbnail + a live tint.
  const { uri: filteredCapUri } = useFilteredUri(captured?.type === 'image' ? (captured?.uri ?? null) : null, filterKey, 720);
  const shownCapUri = (captured?.type === 'image' && filterKey !== 'original' ? filteredCapUri : null) ?? captured?.uri ?? null;
  // A still frame of a captured VIDEO, so the Effects chips can show each filter on the
  // user's own footage (the chooser bakes from an image; a video file can't be baked).
  const [videoThumb, setVideoThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (captured?.type !== 'video') { setVideoThumb(null); return; }
    VideoThumbnails.getThumbnailAsync(captured.uri, { time: 0, quality: 0.6 })
      .then((r) => { if (alive) setVideoThumb(r.uri); })
      .catch(() => { if (alive) setVideoThumb(null); });
    return () => { alive = false; };
  }, [captured?.type, captured?.uri]);

  const { cardW, cardH } = useMemo(
    () => repostCardSize(SCREEN_W, SCREEN_H, insets.top, insets.bottom, postAspect),
    [insets.top, insets.bottom, postAspect],
  );

  // ── Photo drag/pinch crop (captured images only) ──────────────────────────────
  const cropAnim = useRef({ pan: new Animated.ValueXY({ x: 0, y: 0 }), scale: new Animated.Value(1), rot: new Animated.Value(0) }).current;
  const cropSaved = useRef({ tx: 0, ty: 0, scale: 1, rotation: 0 });
  const [photoGuide, setPhotoGuide] = useState({ v: false, h: false });
  const photoSnapPrev = useRef({ x: false, y: false, flat: false });

  const imgW = captured?.width ?? 0;
  const imgH = captured?.height ?? 0;
  const canAdjust = captured?.type === 'image' && imgW > 0 && imgH > 0;
  const coverScale = canAdjust ? Math.max(SCREEN_W / imgW, SCREEN_H / imgH) : 1;
  const baseW = imgW * coverScale;
  const baseH = imgH * coverScale;

  const MIN_IMG_SCALE = 0.2;
  const MAX_IMG_SCALE = 8;
  const PHOTO_SNAP_PX = 9;
  const PHOTO_ROT_SNAP = 7;
  const onPhotoGesture = useCallback((e: { phase: 'move' | 'end'; dx: number; dy: number; scale: number; rotation: number }) => {
    const s = Math.min(Math.max(cropSaved.current.scale * e.scale, MIN_IMG_SCALE), MAX_IMG_SCALE);
    const mx = (baseW * s) / 2 + SCREEN_W / 2;
    const my = (baseH * s) / 2 + SCREEN_H / 2;
    let tx = Math.min(Math.max(cropSaved.current.tx + e.dx, -mx), mx);
    let ty = Math.min(Math.max(cropSaved.current.ty + e.dy, -my), my);
    let rot = cropSaved.current.rotation + e.rotation;
    const rotTarget = Math.round(rot / 90) * 90;
    const nearFlat = Math.abs(rot - rotTarget) <= PHOTO_ROT_SNAP;
    if (nearFlat) rot = rotTarget;
    const nearX = Math.abs(tx) <= PHOTO_SNAP_PX;
    const nearY = Math.abs(ty) <= PHOTO_SNAP_PX;
    if (nearX) tx = 0;
    if (nearY) ty = 0;
    const entered = (nearX && !photoSnapPrev.current.x) || (nearY && !photoSnapPrev.current.y) || (nearFlat && !photoSnapPrev.current.flat);
    if (entered) selection();
    if (photoSnapPrev.current.x !== nearX || photoSnapPrev.current.y !== nearY) setPhotoGuide({ v: nearX, h: nearY });
    photoSnapPrev.current = { x: nearX, y: nearY, flat: nearFlat };
    cropAnim.pan.setValue({ x: tx, y: ty });
    cropAnim.scale.setValue(s);
    cropAnim.rot.setValue(rot);
    if (e.phase === 'end') {
      cropSaved.current = { tx, ty, scale: s, rotation: rot };
      photoSnapPrev.current = { x: false, y: false, flat: false };
      setPhotoGuide({ v: false, h: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseW, baseH]);

  function resetSongTrim() {
    setSongStartSec(0);
    setSongClipSec(STORY_MUSIC_DEFAULT_SEC);
    setSongDragStart(null);
    setSongInfo(null);
    setSongDone(false);
  }

  // ── Text / emoji / tray stickers ──────────────────────────────────────────────
  function addStickerAt(xNorm: number, yNorm: number) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, {
      id, text: '', x: xNorm, y: yNorm, scale: 1, rotation: 0,
      font: editingFont, color: editingColor, bg: editingBg, size: editingSize,
    }]);
    editingRef.current = true;
    setEditingId(id);
    setEditingText('');
  }
  function addMusicSticker(s: PickedSong) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [
      ...prev.filter((x) => x.kind !== 'music'),
      { id, kind: 'music', songId: s.id, text: s.title, artist: s.artist, cover: s.cover ?? null, musicStyle: 'square', x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    ]);
  }
  function addCommunitySticker(c: PostableCommunity) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, { id, kind: 'community', communityId: c.id, text: c.name, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
  }
  function addShopSticker(l: ShopListing) {
    const id = `st${stickerIdRef.current++}`;
    const preview = allowMusic ? (l.preview_url ?? null) : null;
    if (preview) { stopSong(HOST); setSong(null); resetSongTrim(); }
    setStickers((prev) => [
      ...(preview ? prev.filter((s) => s.kind !== 'music') : prev),
      { id, kind: 'shop', listingId: l.id, text: l.title, cover: l.cover_url ?? null, price: listingPriceLabel(l, t('shop.free')), preview, x: 0.5, y: 0.5, scale: 1, rotation: 0 },
    ]);
  }
  function addSliderSticker(prompt: string, emoji: string) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, { id, kind: 'slider', text: prompt.trim(), emojiChar: emoji, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
  }
  function addReactionSticker(emoji: string) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, { id, kind: 'reaction', text: '', emojiChar: emoji, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
  }
  function placeInfoSticker(kind: 'time' | 'temperature' | 'location', text: string) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, { id, kind, text, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
  }
  async function getDeviceLocation(): Promise<{ lat: number; lng: number; city: string | null } | null> {
    try {
      const Location = await import('expo-location');
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return null;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      let city: string | null = null;
      try {
        const p = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        city = p?.[0]?.city ?? p?.[0]?.region ?? p?.[0]?.subregion ?? null;
      } catch {}
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, city };
    } catch { return null; }
  }
  function addTimeSticker() {
    placeInfoSticker('time', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  }
  async function addLocationSticker() {
    const loc = await getDeviceLocation();
    if (!loc?.city) { Alert.alert(t('storyCamera.locationFail')); return; }
    placeInfoSticker('location', loc.city);
  }
  async function addTemperatureSticker() {
    const loc = await getDeviceLocation();
    if (!loc) { Alert.alert(t('storyCamera.locationFail')); return; }
    try {
      const { data, error } = await supabase.functions.invoke('weather', { body: { lat: loc.lat, lng: loc.lng } });
      const temp = (data as any)?.temp;
      if (error || !Number.isFinite(temp)) throw new Error('no temp');
      placeInfoSticker('temperature', `${temp}°F`);
    } catch { Alert.alert(t('storyCamera.tempFail')); }
  }
  function addGifSticker(g: { url: string; w?: number; h?: number }) {
    const ratio = g.w && g.h ? g.w / g.h : 1;
    const max = 170;
    const w = Math.round(ratio >= 1 ? max : max * ratio);
    const h = Math.round(ratio >= 1 ? max / ratio : max);
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, { id, kind: 'gif', text: '', uri: g.url, w, h, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
  }
  function addCountdownSticker(title: string, target: string) {
    const id = `st${stickerIdRef.current++}`;
    setStickers((prev) => [...prev, { id, kind: 'countdown', text: title.trim(), target, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
  }
  function editSticker(id: string, offset?: { dx: number; dy: number }) {
    if (id === 'post') {
      // Tapping the reshared post adds a text sticker where you tapped — same as tapping
      // the media in capture mode. Dragging the post still moves it.
      const ps = stickers.find((x) => x.kind === 'post');
      const px = ps?.x ?? 0.5, py = ps?.y ?? 0.5;
      addStickerAt(
        Math.min(1, Math.max(0, px + (offset?.dx ?? 0) / SCREEN_W)),
        Math.min(1, Math.max(0, py + (offset?.dy ?? 0) / SCREEN_H)),
      );
      return;
    }
    bringToFront(id);
    const s = stickers.find((x) => x.id === id);
    if (s?.kind === 'link') { setLinkDraft({ id, url: s.url ?? '', title: s.text ?? '' }); return; }
    if (s?.kind === 'photo') return;
    if (s?.kind === 'community' || s?.kind === 'shop') return;
    if (s?.kind === 'reaction') return;
    if (s?.kind === 'slider') {
      if (offset && offset.dy < 0) {
        setSliderEdit(id);
      } else {
        setStickers((prev) => prev.map((x) => {
          if (x.id !== id) return x;
          const i = STICKER_EMOJIS.indexOf(x.emojiChar || STICKER_EMOJIS[0]);
          return { ...x, emojiChar: STICKER_EMOJIS[(i + 1) % STICKER_EMOJIS.length] };
        }));
      }
      return;
    }
    if (s?.kind === 'gif' || s?.kind === 'time' || s?.kind === 'temperature' || s?.kind === 'location') return;
    if (s?.kind === 'countdown') {
      const ms = s.target ? Date.parse(s.target) : Date.now() + 86_400_000;
      const d = new Date(ms);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const tgt = new Date(ms); tgt.setHours(0, 0, 0, 0);
      setCountdownDraft({ title: s.text ?? '', dayIdx: Math.max(0, Math.round((tgt.getTime() - today.getTime()) / 86_400_000)), hour: d.getHours() });
      return;
    }
    if (s?.kind === 'music') {
      setStickers((prev) => prev.map((x) => (x.id === id ? { ...x, musicStyle: x.musicStyle === 'square' ? 'card' : 'square' } : x)));
      return;
    }
    if (s?.kind === 'poll') { setPollDraft({ id, pollId: s.pollId ?? '', question: s.question ?? '', options: s.options && s.options.length >= 2 ? s.options : ['', ''] }); return; }
    if (s?.emoji) return;
    editingRef.current = true;
    setEditingId(id);
    setEditingText(s?.text ?? '');
    setEditingFont(s?.font ?? 'classic');
    setEditingColor(s?.color ?? '#FFFFFF');
    setEditingBg(s?.bg ?? 'none');
    setEditingSize(s?.size ?? 26);
  }
  function manipulateSticker(id: string, style: CaptionStyle) {
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...style } : s)));
  }
  function bringToFront(id: string) {
    if (id === 'post') return; // the reshared post stays behind everything you add
    setStickers((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const next = prev.slice();
      next.push(next.splice(i, 1)[0]);
      return next;
    });
  }
  const commitEditing = useCallback((vals: { text: string; font: StickerFont; color: string; bg: StickerBg; size: number }) => {
    setStickers((prev) =>
      prev
        .map((s) => (s.id === editingId
          ? { ...s, text: vals.text.trim(), font: vals.font, color: vals.color, bg: vals.bg, size: vals.size }
          : s))
        .filter((s) => (!!s.kind && s.kind !== 'text') || s.text !== ''),
    );
    setEditingFont(vals.font);
    setEditingColor(vals.color);
    setEditingBg(vals.bg);
    setEditingSize(vals.size);
    setEditingId(null);
    setEditingText('');
  }, [editingId]);
  const commitLink = useCallback(() => {
    if (!linkDraft) return;
    const url = linkDraft.url.trim();
    const title = linkDraft.title.trim();
    if (!url) { setLinkDraft(null); return; }
    if (linkDraft.id) {
      setStickers((prev) => prev.map((s) => (s.id === linkDraft.id ? { ...s, url, text: title } : s)));
    } else {
      const id = `st${stickerIdRef.current++}`;
      setStickers((prev) => [...prev, { id, kind: 'link', url, text: title, x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
    }
    setLinkDraft(null);
  }, [linkDraft]);
  const pickPhotoSticker = useCallback(async () => {
    setStickerSheet(false);
    try {
      const ImagePicker = await import('expo-image-picker');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.9 });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      const long = 190;
      const ratio = a.width && a.height ? a.width / a.height : 1;
      const w = ratio >= 1 ? long : Math.round(long * ratio);
      const h = ratio >= 1 ? Math.round(long / ratio) : long;
      const id = `st${stickerIdRef.current++}`;
      setStickers((prev) => [...prev, { id, kind: 'photo', uri: a.uri, w, h, text: '', x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
    } catch { /* picker unavailable — no-op */ }
  }, []);
  const openPollDraft = useCallback(() => {
    setPollDraft({ id: null, pollId: `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, question: '', options: ['', ''] });
  }, []);
  const commitPoll = useCallback(() => {
    if (!pollDraft) return;
    const question = pollDraft.question.trim();
    const options = pollDraft.options.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) { setPollDraft(null); return; }
    if (pollDraft.id) {
      setStickers((prev) => prev.map((s) => (s.id === pollDraft.id ? { ...s, question, options } : s)));
    } else {
      const id = `st${stickerIdRef.current++}`;
      setStickers((prev) => [...prev, { id, kind: 'poll', pollId: pollDraft.pollId, question, options, text: '', x: 0.5, y: 0.5, scale: 1, rotation: 0 }]);
    }
    setPollDraft(null);
  }, [pollDraft]);
  function inTrashZone(xNorm: number, yNorm: number) {
    const x = xNorm * SCREEN_W, y = yNorm * SCREEN_H;
    return y > SCREEN_H - insets.bottom - 150 && Math.abs(x - SCREEN_W / 2) < 80;
  }
  function onStickerRelease(id: string, xNorm: number, yNorm: number) {
    setOverTrash(false);
    if (id !== 'post' && inTrashZone(xNorm, yNorm)) {
      setStickers((prev) => prev.filter((s) => s.id !== id));
    }
  }

  const backdrop = captured
    ? captured.uri
    : collage
    ? (collage.slots[0] ?? null)
    : boomerang
    ? (boomerang.frames[0] ?? null)
    : (post?.thumbnail_url ?? post?.cover_url ?? (post?.type === 'image' ? post?.media_url : null) ?? null);

  function buildResult(): StoryEditorResult {
    const placed = stickers.map((s) => {
      if (s.kind === 'post') return { kind: 'post' as const, id: 'post', x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'link') return { kind: 'link' as const, url: s.url, text: s.text, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'photo') return { kind: 'photo' as const, uri: s.uri, w: s.w, h: s.h, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'poll') return { kind: 'poll' as const, pollId: s.pollId, question: s.question, options: s.options, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'music') return { kind: 'music' as const, songId: s.songId, text: s.text, artist: s.artist, cover: s.cover, musicStyle: s.musicStyle, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'community') return { kind: 'community' as const, communityId: s.communityId, text: s.text, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'shop') return { kind: 'shop' as const, listingId: s.listingId, text: s.text, cover: s.cover, price: s.price, preview: s.preview, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'slider') return { kind: 'slider' as const, text: s.text, emojiChar: s.emojiChar, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'reaction') return { kind: 'reaction' as const, emojiChar: s.emojiChar, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'countdown') return { kind: 'countdown' as const, text: s.text, target: s.target, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'gif') return { kind: 'gif' as const, uri: s.uri, w: s.w, h: s.h, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      if (s.kind === 'time' || s.kind === 'temperature' || s.kind === 'location') return { kind: s.kind, text: s.text, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
      return { text: s.text, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation, font: s.font, color: s.color, bg: s.bg, size: s.size, emoji: s.emoji };
    }) as StorySticker[];
    // Captured-image framing (drag/pinch/zoom), stored as a 'frame' layer the viewer
    // recomposes over a blurred backdrop. Post mode has no frame (the post is a layer).
    const framed = !!captured && canAdjust && (cropSaved.current.scale !== 1 || cropSaved.current.tx !== 0 || cropSaved.current.ty !== 0 || cropSaved.current.rotation !== 0);
    const frameLayer: StorySticker | null = framed
      ? { kind: 'frame', scale: cropSaved.current.scale, x: cropSaved.current.tx / SCREEN_W, y: cropSaved.current.ty / SCREEN_H, rotation: cropSaved.current.rotation, w: imgW, h: imgH }
      : null;
    const drawLayer: StorySticker | null = strokes.length ? { kind: 'draw', strokes } : null;
    const bgLayer: StorySticker | null = bg.type !== 'blur' ? { kind: 'bg', background: bg } : null;
    const collageLayer: StorySticker | null = collage ? { kind: 'collage', layout: collage.layout, slots: collage.slots } : null;
    const boomerangLayer: StorySticker | null = boomerang ? { kind: 'boomerang', frames: boomerang.frames } : null;
    const all: StorySticker[] = [
      ...placed,
      ...(collageLayer ? [collageLayer] : []),
      ...(boomerangLayer ? [boomerangLayer] : []),
      ...(frameLayer ? [frameLayer] : []),
      ...(drawLayer ? [drawLayer] : []),
      ...(bgLayer ? [bgLayer] : []),
    ];
    return {
      caption: caption.trim() || null,
      song: allowMusic && song ? { id: song.id, title: song.title, artist: song.artist, artistId: song.artistId } : null,
      songStartSec: allowMusic && song && isStill ? songStart : null,
      songClipSec: allowMusic && song && isStill ? clipSec : null,
      aspectRatio: captured || collage || boomerang ? '9:16' : (post?.aspect_ratio ?? (isVideoPost ? '9:16' : '1:1')),
      durationSeconds: captured?.type === 'video' ? captured.durationSec ?? null : null,
      // The chosen color filter — the HOST bakes it into the captured photo before upload
      // (RN's `filter` style can't render it live on iOS). 'original' when none/not applicable.
      filter: canEffects ? filterKey : 'original',
      stickers: all,
    };
  }
  function share() {
    if (sharing) return;
    onShare(buildResult());
  }

  // Everything StickerLayer draws for a non-text sticker — the reshared post frame
  // (post mode) plus the full story sticker set.
  const renderKind = useCallback((s: Sticker): ReactNode => {
    if (s.kind === 'post') {
      if (!post) return null;
      // The author handle sits BELOW the card, outside it, bottom-left — plain bold white
      // text (no avatar, no pill). The whole unit (card + handle) is the draggable sticker.
      return (
        <View style={styles.postWrap}>
          <View style={[styles.card, { width: cardW, height: cardH }]}>
            <RepostPostMedia post={post} active={isFocused} loop />
          </View>
          <Text style={[styles.chipName, { maxWidth: cardW }]} numberOfLines={1} pointerEvents="none">@{post.username ?? 'laybell'}</Text>
        </View>
      );
    }
    if (s.kind === 'link') return <LinkStickerContent url={s.url ?? ''} title={s.text} />;
    if (s.kind === 'photo' && s.uri) return <ExpoImage source={{ uri: s.uri }} style={{ width: s.w ?? 160, height: s.h ?? 160, borderRadius: 16 }} contentFit="cover" />;
    if (s.kind === 'poll') return <PollStickerContent question={s.question ?? ''} options={s.options ?? []} />;
    if (s.kind === 'music') return <MusicStickerContent title={s.text} artist={s.artist} cover={s.cover} variant={s.musicStyle} />;
    if (s.kind === 'community') return <CommunityStickerContent name={s.text} />;
    if (s.kind === 'shop') return <ShopStickerContent title={s.text} price={s.price} cover={s.cover} />;
    if (s.kind === 'slider') return <EmojiSliderContent prompt={s.text} emoji={s.emojiChar} />;
    if (s.kind === 'reaction') return <EmojiReactionContent emoji={s.emojiChar} />;
    if (s.kind === 'countdown') return <CountdownStickerContent title={s.text} target={s.target} />;
    if (s.kind === 'gif' && s.uri) return <ExpoImage source={{ uri: s.uri }} style={{ width: s.w ?? 160, height: s.h ?? 160, borderRadius: 16 }} contentFit="cover" />;
    if (s.kind === 'time') return <InfoStickerContent icon="time-outline" text={s.text} />;
    if (s.kind === 'temperature') return <InfoStickerContent icon="thermometer-outline" text={s.text} />;
    if (s.kind === 'location') return <InfoStickerContent icon="location-outline" text={s.text} />;
    return null;
  }, [post, cardW, cardH, isFocused, styles]);

  const pollReady = !!pollDraft && !!pollDraft.question.trim() && pollDraft.options.filter((o) => o.trim()).length >= 2;

  return (
    <View style={styles.container}>
      {/* Media background — the capture (with crop) or the repost's background. A captured
          photo shows the BAKED (filtered) version once an effect is chosen (shownCapUri). */}
      {captured ? (
        captured.type === 'image' ? (
          canAdjust ? (
            <View style={StyleSheet.absoluteFill}>
              {bg.type === 'blur' ? (
                <ExpoImage source={{ uri: shownCapUri ?? captured.uri }} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={30} cachePolicy="memory-disk" />
              ) : (
                <StoryBackground bg={bg} backdropUri={shownCapUri ?? captured.uri} />
              )}
              <Animated.Image
                source={{ uri: shownCapUri ?? captured.uri }}
                resizeMode="cover"
                style={{
                  position: 'absolute', width: baseW, height: baseH, borderRadius: RADIUS.xl,
                  left: (SCREEN_W - baseW) / 2, top: (SCREEN_H - baseH) / 2,
                  transform: [
                    { translateX: cropAnim.pan.x },
                    { translateY: cropAnim.pan.y },
                    { scale: cropAnim.scale },
                    { rotate: cropAnim.rot.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
                  ],
                }}
              />
            </View>
          ) : (
            <Image source={{ uri: shownCapUri ?? captured.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          )
        ) : filterKey !== 'original' ? (
          // A colour filter is on: play the clip THROUGH Skia so the filter shows live on the
          // moving video (expo-video can't recolour playback). Muted preview; the shared clip
          // keeps its sound. 'original' uses <AppVideo> below (normal playback + audio).
          <FilteredVideoPreview uri={captured.uri} filterKey={filterKey} width={SCREEN_W} height={SCREEN_H} />
        ) : (
          <AppVideo source={{ uri: captured.uri }} style={StyleSheet.absoluteFill} contentFit="cover" active loop ownsAudio muted={false} />
        )
      ) : collage ? (
        <StoryCollage layout={collage.layout} slots={collage.slots} frameW={SCREEN_W} frameH={SCREEN_H} />
      ) : boomerang ? (
        <StoryBoomerang frames={boomerang.frames} frameW={SCREEN_W} frameH={SCREEN_H} active={isFocused} />
      ) : (
        <StoryBackground bg={bg} backdropUri={backdrop} />
      )}

      {/* Photo center guides — faint lines while the photo is dragged near centre. */}
      {(photoGuide.v || photoGuide.h) && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {photoGuide.v && <View style={[styles.guideLineV, { left: SCREEN_W / 2 - 0.5 }]} />}
          {photoGuide.h && <View style={[styles.guideLineH, { top: SCREEN_H / 2 - 0.5 }]} />}
        </View>
      )}

      {/* Stickers + (capture mode) the photo gesture. */}
      <StickerLayer
        stickers={stickers}
        frameW={SCREEN_W}
        frameH={SCREEN_H}
        editingId={editingId}
        onManipulate={manipulateSticker}
        onTapSticker={editSticker}
        onTapEmpty={(x, y) => {
          if (kbHeight > 0) { Keyboard.dismiss(); return; }
          addStickerAt(x, y);
        }}
        onDragActive={(a, id) => { setDragActive(a); setDragIsPost(a ? id === 'post' : false); if (!a) setOverTrash(false); else if (id && id !== 'post') bringToFront(id); }}
        onDragMove={(x, y) => { const over = inTrashZone(x, y); setOverTrash((prev) => (prev === over ? prev : over)); }}
        onRelease={onStickerRelease}
        onPhotoGesture={canAdjust ? onPhotoGesture : undefined}
        renderKind={renderKind}
      />

      {/* Committed doodle — over the media + stickers (matches the viewer's order). */}
      {!drawing && strokes.length > 0 && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <StoryDrawRenderer strokes={strokes} frameW={SCREEN_W} frameH={SCREEN_H} />
        </View>
      )}

      {/* Drop-to-delete target (never the reshared post). */}
      {dragActive && !dragIsPost && (
        <View style={[styles.trashZone, { bottom: insets.bottom + 56 }]} pointerEvents="none">
          <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
            <Ionicons name="trash-outline" size={overTrash ? 30 : 24} color="#fff" />
          </View>
        </View>
      )}

      {!drawing && !effectsOpen && (
        <TouchableOpacity style={[styles.roundBtn, { position: 'absolute', top: insets.top + 8, left: SPACING.md }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
          <Ionicons name="arrow-back" size={26} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Top music slot: suggested / chosen / add-music. */}
      {!dragActive && !drawing && !editingId && allowMusic && !hasShopAudio && !effectsOpen && (
        <View style={[styles.addMusicWrap, { top: insets.top + 8 }]} pointerEvents="box-none">
          {!song && suggested ? (
            <TouchableOpacity
              style={styles.suggestPillGrey}
              activeOpacity={0.85}
              onPress={() => { stopSong(HOST); resetSongTrim(); setSong(suggested); }}
              accessibilityRole="button"
              accessibilityLabel={`${t('storyCamera.suggestedAudio')}: ${suggested.title}`}
            >
              {suggested.cover ? (
                <ExpoImage source={{ uri: suggested.cover }} style={styles.suggestCover} contentFit="cover" />
              ) : (
                <View style={[styles.suggestCover, styles.suggestCoverFallback]}><Ionicons name="musical-notes" size={14} color="#fff" /></View>
              )}
              <View style={styles.suggestTextWrap}>
                <Text style={styles.suggestLabelLight}>{t('storyCamera.suggestedAudio')}</Text>
                <Text style={styles.suggestTitleLight} numberOfLines={1}>{suggested.title} · {suggested.artist}</Text>
              </View>
              <View style={styles.suggestAddLight}><Ionicons name="add" size={16} color="#111" /></View>
            </TouchableOpacity>
          ) : song ? (
            <TouchableOpacity
              style={styles.suggestPill}
              onPress={() => setSongDone(false)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={song.title}
            >
              {song.cover ? (
                <ExpoImage source={{ uri: song.cover }} style={styles.suggestCover} contentFit="cover" />
              ) : (
                <View style={[styles.suggestCover, styles.suggestCoverFallback]}><Ionicons name="musical-notes" size={14} color="#fff" /></View>
              )}
              <View style={styles.suggestTextWrap}>
                <Text style={styles.suggestTitle} numberOfLines={1}>{song.title}</Text>
                {!!song.artist && <Text style={styles.suggestSub} numberOfLines={1}>{song.artist}</Text>}
              </View>
              <Ionicons name="musical-notes" size={15} color="#111" style={{ marginRight: 3 }} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.addMusicBtn}
              onPress={() => openSongPicker('background')}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('post.addMusic')}
            >
              <Ionicons name="musical-notes" size={16} color="#111" />
              <Text style={styles.addMusicText} numberOfLines={1}>{t('post.addMusic')}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Edit tool rail — stickers, draw/background, effects (stills only). */}
      {!dragActive && !drawing && !effectsOpen && (
        <View style={[styles.toolRail, { top: insets.top + 8 }]}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setStickerSheet(true)}>
            <Feather name="smile" size={27} color={stickers.some((s) => s.kind === 'link') ? colors.primaryLight : '#fff'} style={styles.iconGlyph} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setDrawing(true)}>
            <Feather name="edit-3" size={25} color={strokes.length || bg.type !== 'blur' ? colors.primaryLight : '#fff'} style={styles.iconGlyph} />
          </TouchableOpacity>
          {canEffects && !!backdrop && (
            <TouchableOpacity style={styles.iconBtn} onPress={() => setEffectsOpen(true)} accessibilityRole="button" accessibilityLabel={t('storyCamera.effects')}>
              <Ionicons name="color-filter-outline" size={25} color={filterKey !== 'original' ? colors.primaryLight : '#fff'} style={styles.iconGlyph} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Effects (filter) chooser — a bottom strip; selecting updates the media live. */}
      {effectsOpen && canEffects && (
        <EffectsTray
          mediaUri={captured?.type === 'video' ? videoThumb : backdrop}
          activeKey={filterKey}
          onSelect={setFilterKey}
          onClose={() => setEffectsOpen(false)}
          bottomInset={insets.bottom}
        />
      )}

      {/* Bottom bar — song card (while trimming) + caption + "Add to story". */}
      {!dragActive && !editingId && !drawing && !effectsOpen && (
        <Animated.View style={[styles.previewBottom, { bottom: kbAnim, paddingBottom: SPACING.md }]}>
          {song && !songDone && (
            <View style={styles.songCard}>
              <View style={styles.songCardRow}>
                {song.cover ? (
                  <Image source={{ uri: song.cover }} style={styles.songCardCover} />
                ) : (
                  <View style={[styles.songCardCover, styles.songCardCoverEmpty]}>
                    <Ionicons name="musical-notes" size={18} color="#fff" />
                  </View>
                )}
                <View style={styles.songCardInfo}>
                  <Text style={styles.songCardTitle} numberOfLines={1}>{song.title}</Text>
                  <Text style={styles.songCardArtist} numberOfLines={1}>{song.artist}</Text>
                </View>
                <TouchableOpacity style={styles.songDoneBtn} onPress={() => setSongDone(true)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('common.done')} hitSlop={6}>
                  <Ionicons name="checkmark" size={20} color="#111" />
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')}
                  style={styles.songCardBtn}
                  onPress={() => { stopSong(HOST); setSong(null); resetSongTrim(); setStickers((prev) => prev.filter((s) => s.kind !== 'music')); }}
                  hitSlop={6}
                >
                  <Ionicons name="close" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
              {/* Trim (stills only): WHERE the song starts. Length sets how long the still stays up. */}
              {!!backdrop && isStill && (
                <>
                  <View style={styles.songDivider} />
                  <Text style={[styles.songTrimStart, styles.songTrimPad]}>{t('sound.startsAt', { time: formatClock(songDragStart ?? songStart) })}</Text>
                  {songSec > 0 ? (
                    <SongPartStrip
                      seed={song.id}
                      songSec={songSec}
                      windowSec={clipSec}
                      startSec={songStart}
                      hPad={SPACING.md + SOUND_H_PAD}
                      onDrag={setSongDragStart}
                      onCommit={(sec) => setSongStartSec(clampStart(sec, songSec, clipSec))}
                    />
                  ) : (
                    <Text style={[styles.songTrimHint, styles.songTrimPad]}>{t('storyCamera.musicPreparing')}</Text>
                  )}
                </>
              )}
              <View style={styles.songControlsRow}>
                {isStill && (
                  <TouchableOpacity style={styles.songChip} onPress={() => setShowDurationPicker(true)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('storyCamera.clipLength')}>
                    <Ionicons name="timer-outline" size={15} color="#fff" />
                    <Text style={styles.songChipText}>{t('storyCamera.clipSeconds', { n: clipSec })}</Text>
                    <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.8)" />
                  </TouchableOpacity>
                )}
                <View style={{ flex: 1 }} />
                <TouchableOpacity style={styles.songChip} onPress={() => openSongPicker('background')} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={t('storyCamera.changeSong')}>
                  <Ionicons name="musical-notes" size={15} color="#fff" />
                  <Text style={styles.songChipText}>{t('storyCamera.changeSong')}</Text>
                </TouchableOpacity>
              </View>
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
                selectionColor="#0A84FF"
                cursorColor="#0A84FF"
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
          ) : (
            <TouchableOpacity style={styles.addCaptionRow} onPress={() => setShowCaption(true)} activeOpacity={0.7}>
              <Text style={styles.addCaptionText}>{t('storyCamera.captionPlaceholder')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.shareBtn} onPress={share} disabled={sharing} activeOpacity={0.85}>
            {sharing ? <ActivityIndicator color="#000" /> : (
              <>
                <Text style={styles.shareBtnText}>{shareLabel ?? t('storyCamera.addToStory')}</Text>
                <Ionicons name="arrow-forward-circle" size={22} color="#000" />
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Full-screen text editor. */}
      {editingId && (
        <StickerTextEditor
          key={editingId}
          initialText={editingText}
          initialFont={editingFont}
          initialColor={editingColor}
          initialBg={editingBg}
          initialSize={editingSize}
          onCommit={commitEditing}
        />
      )}

      <SongPickerModal
        visible={showSongPicker}
        onClose={() => setShowSongPicker(false)}
        onSelect={(s) => {
          const sameAsCurrent = !!song && song.id === s.id;
          if (!sameAsCurrent) { stopSong(HOST); resetSongTrim(); setSong(s); }
          if (songPickerMode === 'sticker') addMusicSticker(s);
        }}
      />

      {/* Clip-length scroll menu. */}
      <Modal visible={showDurationPicker} transparent animationType="slide" onRequestClose={() => setShowDurationPicker(false)}>
        <TouchableOpacity style={styles.durationOverlay} activeOpacity={1} onPress={() => setShowDurationPicker(false)}>
          <TouchableOpacity style={[styles.durationSheet, { paddingBottom: insets.bottom + SPACING.md }]} activeOpacity={1}>
            <View style={styles.durationHandle} />
            <Text style={styles.durationTitle}>{t('storyCamera.clipLength')}</Text>
            <ScrollView style={styles.durationList} contentContainerStyle={{ paddingVertical: SPACING.xs }} showsVerticalScrollIndicator={false}>
              {DURATION_OPTIONS.map((n) => {
                const sel = n === clipSec;
                return (
                  <TouchableOpacity
                    key={n}
                    style={[styles.durationRow, sel && styles.durationRowSel]}
                    onPress={() => { setSongClipSec(n); selection(); setShowDurationPicker(false); }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.durationRowText, sel && styles.durationRowTextSel]}>{t('storyCamera.clipSeconds', { n })}</Text>
                    {sel && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Sticker tray. */}
      <Modal visible={stickerSheet} transparent animationType="slide" onRequestClose={() => setStickerSheet(false)}>
        <TouchableOpacity style={styles.durationOverlay} activeOpacity={1} onPress={() => setStickerSheet(false)}>
          <TouchableOpacity style={[styles.stickerTraySheet, { paddingBottom: insets.bottom + SPACING.md }]} activeOpacity={1}>
            <View style={styles.stickerTrayHandle} />
            <Text style={styles.stickerTrayTitle}>{t('storyCamera.stickers')}</Text>
            <ScrollView style={styles.trayScroll} contentContainerStyle={styles.trayRow} showsVerticalScrollIndicator={false}>
              {([
                { icon: 'link', c: '#0A84FF', label: 'storyCamera.stickerLink', onPress: () => { setStickerSheet(false); setLinkDraft({ id: null, url: '', title: '' }); } },
                { icon: 'image', c: '#30B36B', label: 'storyCamera.stickerPhoto', onPress: pickPhotoSticker },
                { icon: 'stats-chart', c: '#F97316', label: 'storyCamera.stickerPoll', onPress: () => { setStickerSheet(false); openPollDraft(); } },
                { icon: 'musical-notes', c: '#C026D3', label: 'storyCamera.stickerMusic', onPress: () => { if (hasShopAudio) { Alert.alert(t('storyCamera.audioInUseTitle'), t('storyCamera.audioInUseBody')); return; } setStickerSheet(false); openSongPicker('sticker'); } },
                { icon: 'people', c: '#6366F1', label: 'storyCamera.stickerCommunity', onPress: () => { setStickerSheet(false); setCommunityPickerOpen(true); } },
                { icon: 'bag-handle', c: '#F26522', label: 'storyCamera.stickerShop', onPress: () => { setStickerSheet(false); setShopPickerOpen(true); } },
                { icon: 'timer', c: '#EF4444', label: 'storyCamera.stickerCountdown', onPress: () => { setStickerSheet(false); setCountdownDraft({ title: '', dayIdx: 1, hour: 12 }); } },
                { icon: 'images', c: '#14B8A6', label: 'storyCamera.stickerGif', onPress: () => { setStickerSheet(false); setGifPickerOpen(true); } },
                { icon: 'time', c: '#64748B', label: 'storyCamera.stickerTime', onPress: () => { setStickerSheet(false); addTimeSticker(); } },
                { icon: 'thermometer', c: '#F59E0B', label: 'storyCamera.stickerTemperature', onPress: () => { setStickerSheet(false); addTemperatureSticker(); } },
                { icon: 'location', c: '#22C55E', label: 'storyCamera.stickerLocation', onPress: () => { setStickerSheet(false); addLocationSticker(); } },
              ] as const)
                .filter((it) => it.label !== 'storyCamera.stickerMusic' || allowMusic)
                .map((it) => (
                  <TouchableOpacity key={it.label} style={styles.trayPill} activeOpacity={0.85} onPress={it.onPress}>
                    <Ionicons name={it.icon} size={18} color={it.c} />
                    <Text style={styles.trayPillText}>{t(it.label)}</Text>
                  </TouchableOpacity>
                ))}
              <TouchableOpacity style={styles.trayPreview} activeOpacity={0.85} onPress={() => { setStickerSheet(false); addSliderSticker(t('storyCamera.sliderDefaultPrompt'), STICKER_EMOJIS[0]); }}>
                <EmojiSliderContent compact prompt={t('storyCamera.sliderDefaultPrompt')} emoji={STICKER_EMOJIS[0]} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.trayPreview} activeOpacity={0.85} onPress={() => { setStickerSheet(false); setReactionPickerOpen(true); }}>
                <EmojiReactionContent compact emoji="❤️" />
              </TouchableOpacity>
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Community picker. */}
      <Modal visible={communityPickerOpen} transparent animationType="slide" onRequestClose={() => setCommunityPickerOpen(false)}>
        <TouchableOpacity style={styles.durationOverlay} activeOpacity={1} onPress={() => setCommunityPickerOpen(false)}>
          <TouchableOpacity style={[styles.stickerTraySheet, { paddingBottom: insets.bottom + SPACING.md }]} activeOpacity={1}>
            <View style={styles.stickerTrayHandle} />
            <Text style={styles.stickerTrayTitle}>{t('storyCamera.pickCommunity')}</Text>
            <ScrollView style={styles.pickerList} contentContainerStyle={{ paddingBottom: SPACING.sm }} showsVerticalScrollIndicator={false}>
              {communities.length === 0 ? (
                <Text style={styles.pickerEmpty}>{t('storyCamera.noCommunities')}</Text>
              ) : communities.map((c) => (
                <TouchableOpacity key={c.id} style={styles.pickerRow} activeOpacity={0.7} onPress={() => { setCommunityPickerOpen(false); addCommunitySticker(c); }}>
                  <View style={styles.pickerIcon}><Ionicons name="people" size={20} color="#fff" /></View>
                  <View style={styles.pickerInfo}>
                    <Text style={styles.pickerTitle} numberOfLines={1}>{c.name}</Text>
                    {!!c.hashtag && <Text style={styles.pickerSub} numberOfLines={1}>#{c.hashtag}</Text>}
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Shop picker. */}
      <Modal visible={shopPickerOpen} transparent animationType="slide" onRequestClose={() => setShopPickerOpen(false)}>
        <TouchableOpacity style={styles.durationOverlay} activeOpacity={1} onPress={() => setShopPickerOpen(false)}>
          <TouchableOpacity style={[styles.stickerTraySheet, { paddingBottom: insets.bottom + SPACING.md }]} activeOpacity={1}>
            <View style={styles.stickerTrayHandle} />
            <Text style={styles.stickerTrayTitle}>{t('storyCamera.pickShopItem')}</Text>
            <ScrollView style={styles.pickerList} contentContainerStyle={{ paddingBottom: SPACING.sm }} showsVerticalScrollIndicator={false}>
              {listings.length === 0 ? (
                <Text style={styles.pickerEmpty}>{t('storyCamera.noListings')}</Text>
              ) : listings.map((l) => (
                <TouchableOpacity key={l.id} style={styles.pickerRow} activeOpacity={0.7} onPress={() => { setShopPickerOpen(false); addShopSticker(l); }}>
                  {l.cover_url ? (
                    <ExpoImage source={{ uri: l.cover_url }} style={styles.pickerCover} contentFit="cover" />
                  ) : (
                    <View style={[styles.pickerCover, styles.pickerIcon]}><Ionicons name="bag-handle" size={20} color="#fff" /></View>
                  )}
                  <View style={styles.pickerInfo}>
                    <Text style={styles.pickerTitle} numberOfLines={1}>{l.title}</Text>
                    <Text style={styles.pickerSub} numberOfLines={1}>{listingPriceLabel(l, t('shop.free'))}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Inline slider caption editor. */}
      <Modal visible={!!sliderEdit} transparent animationType="fade" onRequestClose={() => setSliderEdit(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.linkEditorOverlay} onPress={() => setSliderEdit(null)}>
            <Pressable style={[styles.linkEditorCard, { backgroundColor: colors.surfaceElevated }]} onPress={() => {}}>
              <Text style={[styles.linkEditorTitle, { color: colors.text }]}>{t('storyCamera.sliderTitle')}</Text>
              <TextInput
                value={stickers.find((x) => x.id === sliderEdit)?.text ?? ''}
                onChangeText={(v) => setStickers((prev) => prev.map((x) => (x.id === sliderEdit ? { ...x, text: v } : x)))}
                placeholder={t('storyCamera.sliderDefaultPrompt')}
                placeholderTextColor={colors.textSecondary}
                autoFocus
                maxLength={60}
                style={[styles.linkEditorInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              />
              <View style={{ flexDirection: 'row' }}>
                <TouchableOpacity style={[styles.linkEditorBtn, { backgroundColor: colors.primary }]} onPress={() => setSliderEdit(null)}>
                  <Text style={{ color: '#fff', fontWeight: '800' }}>{t('storyCamera.done')}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Emoji reaction picker. */}
      <Modal visible={reactionPickerOpen} transparent animationType="fade" onRequestClose={() => setReactionPickerOpen(false)}>
        <Pressable style={styles.linkEditorOverlay} onPress={() => setReactionPickerOpen(false)}>
          <Pressable style={[styles.linkEditorCard, { backgroundColor: colors.surfaceElevated }]} onPress={() => {}}>
            <Text style={[styles.linkEditorTitle, { color: colors.text }]}>{t('storyCamera.reactionTitle')}</Text>
            <View style={styles.emojiRow}>
              {STICKER_EMOJIS.map((em) => (
                <TouchableOpacity key={em} onPress={() => { setReactionPickerOpen(false); addReactionSticker(em); }} style={styles.emojiChoice}>
                  <Text style={styles.emojiChoiceText}>{em}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* GIF picker. */}
      <GifPickerModal visible={gifPickerOpen} userId={null} onClose={() => setGifPickerOpen(false)} onSelect={(g) => { setGifPickerOpen(false); addGifSticker({ url: g.url, w: g.w, h: g.h }); }} />

      {/* Countdown editor. */}
      <Modal visible={!!countdownDraft} transparent animationType="fade" onRequestClose={() => setCountdownDraft(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.linkEditorOverlay} onPress={() => setCountdownDraft(null)}>
            <Pressable style={[styles.linkEditorCard, { backgroundColor: colors.surfaceElevated }]} onPress={() => {}}>
              <Text style={[styles.linkEditorTitle, { color: colors.text }]}>{t('storyCamera.countdownTitle')}</Text>
              <TextInput
                value={countdownDraft?.title ?? ''}
                onChangeText={(v) => setCountdownDraft((d) => (d ? { ...d, title: v } : d))}
                placeholder={t('storyCamera.countdownNameHint')}
                placeholderTextColor={colors.textSecondary}
                maxLength={40}
                style={[styles.linkEditorInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cdChipRow}>
                {Array.from({ length: 60 }, (_, i) => i).map((i) => {
                  const dd = new Date(); dd.setHours(0, 0, 0, 0); dd.setDate(dd.getDate() + i);
                  const label = i === 0 ? t('storyCamera.cdToday') : i === 1 ? t('storyCamera.cdTomorrow') : dd.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                  const active = countdownDraft?.dayIdx === i;
                  return (
                    <TouchableOpacity key={i} onPress={() => setCountdownDraft((d) => (d ? { ...d, dayIdx: i } : d))} style={[styles.cdChip, { backgroundColor: active ? colors.primary : colors.background }]}>
                      <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cdChipRow}>
                {Array.from({ length: 24 }, (_, i) => i).map((h) => {
                  const active = countdownDraft?.hour === h;
                  return (
                    <TouchableOpacity key={h} onPress={() => setCountdownDraft((d) => (d ? { ...d, hour: h } : d))} style={[styles.cdChip, { backgroundColor: active ? colors.primary : colors.background }]}>
                      <Text style={{ color: active ? '#fff' : colors.text, fontWeight: '700', fontSize: 13 }}>{`${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}`}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                <TouchableOpacity style={[styles.linkEditorBtn, { backgroundColor: colors.background }]} onPress={() => setCountdownDraft(null)}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{t('storyCamera.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.linkEditorBtn, { backgroundColor: colors.primary }]}
                  onPress={() => {
                    if (!countdownDraft) return;
                    const target = new Date(); target.setHours(0, 0, 0, 0);
                    target.setDate(target.getDate() + countdownDraft.dayIdx);
                    target.setHours(countdownDraft.hour, 0, 0, 0);
                    addCountdownSticker(countdownDraft.title, target.toISOString());
                    setCountdownDraft(null);
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '800' }}>{t('storyCamera.done')}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Link editor. */}
      <Modal visible={!!linkDraft} transparent animationType="fade" onRequestClose={() => setLinkDraft(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.linkEditorOverlay} onPress={() => setLinkDraft(null)}>
            <Pressable style={[styles.linkEditorCard, { backgroundColor: colors.surfaceElevated }]} onPress={() => {}}>
              <Text style={[styles.linkEditorTitle, { color: colors.text }]}>{t('storyCamera.linkTitle')}</Text>
              <TextInput
                value={linkDraft?.url ?? ''}
                onChangeText={(v) => setLinkDraft((d) => (d ? { ...d, url: v } : d))}
                placeholder={t('storyCamera.linkUrlHint')}
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                autoFocus
                style={[styles.linkEditorInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              />
              <TextInput
                value={linkDraft?.title ?? ''}
                onChangeText={(v) => setLinkDraft((d) => (d ? { ...d, title: v } : d))}
                placeholder={t('storyCamera.linkTextHint')}
                placeholderTextColor={colors.textSecondary}
                style={[styles.linkEditorInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              />
              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                <TouchableOpacity style={[styles.linkEditorBtn, { backgroundColor: colors.background }]} onPress={() => setLinkDraft(null)}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{t('storyCamera.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.linkEditorBtn, { backgroundColor: linkDraft?.url.trim() ? colors.primary : colors.border }]}
                  disabled={!linkDraft?.url.trim()}
                  onPress={commitLink}
                >
                  <Text style={{ color: '#fff', fontWeight: '800' }}>{linkDraft?.id ? t('storyCamera.linkSave') : t('storyCamera.linkAdd')}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Poll editor. */}
      <Modal visible={!!pollDraft} transparent animationType="fade" onRequestClose={() => setPollDraft(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.linkEditorOverlay} onPress={() => setPollDraft(null)}>
            <Pressable style={[styles.linkEditorCard, { backgroundColor: colors.surfaceElevated }]} onPress={() => {}}>
              <Text style={[styles.linkEditorTitle, { color: colors.text }]}>{t('storyCamera.pollTitle')}</Text>
              <TextInput
                value={pollDraft?.question ?? ''}
                onChangeText={(v) => setPollDraft((d) => (d ? { ...d, question: v } : d))}
                placeholder={t('storyCamera.pollQuestionHint')}
                placeholderTextColor={colors.textSecondary}
                autoFocus
                style={[styles.linkEditorInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
              />
              {(pollDraft?.options ?? []).map((opt, i) => (
                <TextInput
                  key={i}
                  value={opt}
                  onChangeText={(v) => setPollDraft((d) => (d ? { ...d, options: d.options.map((o, k) => (k === i ? v : o)) } : d))}
                  placeholder={`${t('storyCamera.pollOption')} ${i + 1}`}
                  placeholderTextColor={colors.textSecondary}
                  style={[styles.linkEditorInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
                />
              ))}
              {(pollDraft?.options.length ?? 0) < 4 && (
                <TouchableOpacity onPress={() => setPollDraft((d) => (d ? { ...d, options: [...d.options, ''] } : d))} hitSlop={8}>
                  <Text style={{ color: colors.primary, fontWeight: '700', textAlign: 'center', paddingVertical: 4 }}>{t('storyCamera.pollAddOption')}</Text>
                </TouchableOpacity>
              )}
              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                <TouchableOpacity style={[styles.linkEditorBtn, { backgroundColor: colors.background }]} onPress={() => setPollDraft(null)}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{t('storyCamera.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.linkEditorBtn, { backgroundColor: pollReady ? colors.primary : colors.border }]}
                  disabled={!pollReady}
                  onPress={commitPoll}
                >
                  <Text style={{ color: '#fff', fontWeight: '800' }}>{pollDraft?.id ? t('storyCamera.linkSave') : t('storyCamera.linkAdd')}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Draw & background — one full-screen overlay with Draw / Background tabs. */}
      {drawing && (
        <StoryDrawCanvas
          strokes={strokes}
          onChange={setStrokes}
          onClose={() => setDrawing(false)}
          frameW={SCREEN_W}
          frameH={SCREEN_H}
          insetsTop={insets.top}
          insetsBottom={insets.bottom}
          bg={bg}
          onChangeBg={setBg}
          backdropUri={backdrop ?? undefined}
          canBg={captured ? canAdjust : true}
        />
      )}
    </View>
  );
}

// ─── Sticker text editor overlay (shared) ─────────────────────────────────────
const StickerTextEditor = memo(function StickerTextEditor({
  initialText, initialFont, initialColor, initialBg, initialSize, onCommit,
}: {
  initialText: string;
  initialFont: StickerFont;
  initialColor: string;
  initialBg: StickerBg;
  initialSize: number;
  onCommit: (vals: { text: string; font: StickerFont; color: string; bg: StickerBg; size: number }) => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const [text, setText] = useState(initialText);
  const [font, setFont] = useState<StickerFont>(initialFont);
  const [color, setColor] = useState(initialColor);
  const [bg, setBg] = useState<StickerBg>(initialBg);
  const [size, setSize] = useState(initialSize);
  const [textH, setTextH] = useState(0);

  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [appear]);

  const sizeSliderPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setSize(sizeFromTrackY(e.nativeEvent.locationY)),
      onPanResponderMove: (e) => setSize(sizeFromTrackY(e.nativeEvent.locationY)),
    }),
  ).current;

  const preview = resolveSticker({ font, color, bg, size });
  const sliderKnobTop = ((SIZE_MAX - size) / (SIZE_MAX - SIZE_MIN)) * SLIDER_H - 13;
  const knobTop = Math.max(0, Math.min(SLIDER_H - 26, sliderKnobTop));
  const finish = () => {
    Animated.timing(appear, { toValue: 0, duration: 190, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => { Keyboard.dismiss(); onCommit({ text, font, color, bg, size }); });
  };

  return (
    <KeyboardAvoidingView
      style={StyleSheet.absoluteFill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.stickerEditor, { opacity: appear }]} />
      <Pressable style={StyleSheet.absoluteFill} onPress={finish} />
      <Animated.View style={[styles.stickerDoneRow, { top: insets.top + 8, opacity: appear }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.stickerDoneBtn} onPress={finish} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.stickerDoneText}>{t('storyCamera.done')}</Text>
        </TouchableOpacity>
      </Animated.View>

      <Animated.View style={[styles.sizeSlider, { top: SCREEN_H * 0.19, opacity: appear }]} {...sizeSliderPan.panHandlers}>
        <View style={styles.sizeTrackWrap} pointerEvents="none">
          <View style={styles.sizeWedge} />
        </View>
        <View style={[styles.sizeKnob, { top: knobTop }]} pointerEvents="none" />
        <View style={[styles.sizeValue, { top: knobTop }]} pointerEvents="none">
          <Text style={styles.sizeValueText}>{Math.round(size)}</Text>
        </View>
      </Animated.View>
      <View style={styles.stickerInputWrap} pointerEvents="box-none">
        <Animated.View style={[preview.boxStyle, styles.editorBox, { opacity: appear }]}>
          <TextInput
            style={[styles.stickerInput, preview.textStyle, {
              height: (textH > 0 ? textH : ((preview.textStyle.lineHeight as number) ?? 34)) + 8,
              maxHeight: SCREEN_H * 0.45,
            }]}
            value={text}
            onChangeText={setText}
            selectionColor="#0A84FF"
            cursorColor="#0A84FF"
            multiline
            scrollEnabled={false}
            autoFocus
            maxLength={200}
            textAlign="center"
          />
          <Text
            style={[styles.stickerInput, preview.textStyle, styles.measureGhost]}
            onLayout={(e) => {
              const h = Math.ceil(e.nativeEvent.layout.height);
              setTextH((prev) => (prev === h ? prev : h));
            }}
          >
            {text.length === 0 ? ' ' : text.endsWith('\n') ? `${text} ` : text}
          </Text>
        </Animated.View>
        <MentionSuggestions
          query={getActiveMentionQuery(text, text.length)}
          onPick={(u) => setText(applyMention(text, text.length, u).text)}
          style={{ marginTop: SPACING.md, alignSelf: 'center', minWidth: 240 }}
          maxHeight={160}
        />
      </View>

      <Animated.View style={[styles.styleBar, { opacity: appear }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatchRow} keyboardShouldPersistTaps="always">
          {STICKER_COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]}
              onPress={() => setColor(c)}
            />
          ))}
        </ScrollView>
        <View style={styles.fontRow}>
          <TouchableOpacity
            style={[styles.bgToggle, bg !== 'none' && styles.bgToggleActive]}
            onPress={() => setBg((b) => (b === 'none' ? 'soft' : b === 'soft' ? 'pill' : b === 'pill' ? 'boxy' : 'none'))}
          >
            <Ionicons name="color-fill-outline" size={18} color="#fff" />
          </TouchableOpacity>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontPills} keyboardShouldPersistTaps="always">
            {STICKER_FONTS.map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.fontPill, font === f.key && styles.fontPillActive]}
                onPress={() => setFont(f.key)}
              >
                <Text style={[styles.fontPillText, resolveStickerFontPreview(f.key), font === f.key && styles.fontPillTextActive]}>{f.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
});

function resolveStickerFontPreview(font: StickerFont) {
  switch (font) {
    case 'bold': return { fontWeight: '900' as const };
    case 'typewriter': return { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' };
    case 'serif': return { fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' };
    case 'neon': return { textShadowColor: '#fff', textShadowRadius: 8 };
    default: return { fontWeight: '700' as const };
  }
}

function sizeFromTrackY(y: number) {
  const clamped = Math.max(0, Math.min(SLIDER_H, y));
  return Math.round(SIZE_MAX - (clamped / SLIDER_H) * (SIZE_MAX - SIZE_MIN));
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  roundBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { textShadowColor: 'rgba(0,0,0,0.45)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 5 },

  // Reshared post card + its author handle (below the card, outside, bottom-left).
  postWrap: { alignItems: 'flex-start' },
  card: {
    borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  // Author handle below the card: plain bold white text, no avatar/pill, with a soft
  // shadow so it stays legible over a light background.
  chipName: {
    color: '#fff', fontSize: 16, fontWeight: '700', marginTop: SPACING.xs, marginLeft: 2,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },

  addMusicWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  addMusicBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 9, maxWidth: SCREEN_W * 0.62,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  addMusicText: { color: '#111', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  suggestPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', borderRadius: RADIUS.full,
    paddingLeft: 5, paddingRight: 5, paddingVertical: 5, maxWidth: SCREEN_W * 0.82,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  suggestPillGrey: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(58,58,64,0.6)', borderRadius: RADIUS.full,
    paddingLeft: 5, paddingRight: 5, paddingVertical: 5, maxWidth: SCREEN_W * 0.82,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
  },
  suggestLabelLight: { color: 'rgba(255,255,255,0.75)', fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  suggestTitleLight: { color: '#fff', fontSize: 13, fontWeight: '700' },
  suggestAddLight: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  suggestCover: { width: 30, height: 30, borderRadius: 7 },
  suggestCoverFallback: { backgroundColor: '#9A9A9F', alignItems: 'center', justifyContent: 'center' },
  suggestTextWrap: { flexShrink: 1 },
  suggestTitle: { color: '#111', fontSize: 13, fontWeight: '700' },
  suggestSub: { color: '#8A8A8E', fontSize: 11, fontWeight: '600', marginTop: 1 },

  stickerTraySheet: { backgroundColor: '#1C1C1E', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: SPACING.sm },
  stickerTrayHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', alignSelf: 'center', marginBottom: SPACING.sm },
  stickerTrayTitle: { color: '#fff', fontSize: 17, fontWeight: '800', paddingHorizontal: SPACING.lg, marginBottom: SPACING.md },
  trayScroll: { maxHeight: SCREEN_H * 0.46 },
  trayRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: SPACING.sm + 2, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  trayPill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingHorizontal: 15, paddingVertical: 10,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  trayPillText: { color: '#111', fontSize: 15, fontWeight: '800' },
  trayPreview: { alignItems: 'center', justifyContent: 'center' },
  pickerList: { maxHeight: SCREEN_H * 0.5, paddingHorizontal: SPACING.lg },
  pickerEmpty: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center', paddingVertical: SPACING.xl },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, paddingVertical: SPACING.sm },
  pickerIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  pickerCover: { width: 44, height: 44, borderRadius: 12 },
  pickerInfo: { flex: 1 },
  pickerTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  pickerSub: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 1 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACING.sm },
  emojiChoice: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1.5, borderColor: 'transparent' },
  emojiChoiceText: { fontSize: 24 },
  cdChipRow: { flexDirection: 'row', gap: SPACING.sm, paddingVertical: 2 },
  cdChip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999 },

  toolRail: { position: 'absolute', right: SPACING.md, gap: SPACING.sm },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)',
  },
  trashCircleHot: { backgroundColor: colors.error, borderColor: '#fff', transform: [{ scale: 1.15 }] },

  guideLineV: {
    position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 1.5, shadowOffset: { width: 0, height: 0 },
  },
  guideLineH: {
    position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 1.5, shadowOffset: { width: 0, height: 0 },
  },

  previewBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: SPACING.md, gap: SPACING.sm },
  captionInput: {
    color: '#fff', fontSize: 15, paddingHorizontal: 0, paddingVertical: SPACING.sm,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  stickerEditor: { backgroundColor: 'rgba(0,0,0,0.55)' },
  stickerDoneRow: { position: 'absolute', right: SPACING.md, flexDirection: 'row', justifyContent: 'flex-end', zIndex: 2 },
  stickerDoneBtn: { backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.md, paddingVertical: 7 },
  stickerDoneText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sizeSlider: { position: 'absolute', left: 4, width: 44, height: SLIDER_H, alignItems: 'center', zIndex: 2 },
  sizeTrackWrap: { width: 18, height: '100%', overflow: 'hidden', alignItems: 'center' },
  sizeWedge: {
    width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderTopWidth: SLIDER_H + 90,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: 'rgba(255,255,255,0.32)',
  },
  sizeKnob: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    backgroundColor: '#fff', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
  sizeValue: {
    position: 'absolute', left: 38, minWidth: 34, height: 26, borderRadius: 13,
    paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
  },
  sizeValueText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stickerInputWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACING.lg },
  stickerInput: { width: 300, paddingVertical: 0, paddingHorizontal: 0, textAlignVertical: 'center' },
  editorBox: { alignSelf: 'center' },
  measureGhost: { position: 'absolute', opacity: 0, width: 286, left: 7 },
  styleBar: { paddingBottom: SPACING.sm, gap: SPACING.sm },
  swatchRow: { paddingHorizontal: SPACING.md, paddingVertical: 8, gap: SPACING.sm, alignItems: 'center' },
  swatch: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
  },
  swatchActive: { borderColor: '#fff', borderWidth: 3, transform: [{ scale: 1.2 }] },
  fontRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, gap: SPACING.sm },
  bgToggle: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.28)',
  },
  bgToggleActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  fontPills: { gap: SPACING.sm, alignItems: 'center' },
  fontPill: {
    paddingHorizontal: SPACING.md, paddingVertical: 8, borderRadius: RADIUS.full,
    backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.28)',
  },
  fontPillActive: { backgroundColor: '#fff', borderColor: '#fff' },
  fontPillText: { color: '#fff', fontSize: 14 },
  fontPillTextActive: { color: '#111' },

  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: SPACING.md,
  },
  shareBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },
  captionPreview: { paddingVertical: SPACING.sm, alignSelf: 'flex-start', maxWidth: '100%' },
  captionPreviewText: {
    color: '#fff', fontSize: 15, lineHeight: 20,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  addCaptionRow: { paddingVertical: SPACING.sm },
  addCaptionText: {
    color: 'rgba(255,255,255,0.7)', fontSize: 15,
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  songCard: {
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)',
    paddingVertical: SPACING.sm + 2, overflow: 'hidden',
  },
  songCardRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm + 2, paddingHorizontal: SOUND_H_PAD },
  songDivider: {
    height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.16)',
    marginHorizontal: SOUND_H_PAD, marginTop: SPACING.sm, marginBottom: SPACING.xs,
  },
  songTrimPad: { paddingHorizontal: SOUND_H_PAD },
  songTrimStart: { color: '#fff', fontSize: 12.5, fontWeight: '700', textAlign: 'center', marginBottom: 2 },
  songTrimHint: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, textAlign: 'center', paddingVertical: SPACING.md },
  songCardCover: { width: 46, height: 46, borderRadius: RADIUS.sm, overflow: 'hidden' },
  songCardCoverEmpty: { backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  songCardInfo: { flex: 1 },
  songCardTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  songCardArtist: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 1 },
  songCardBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  songControlsRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SOUND_H_PAD, marginTop: SPACING.sm, gap: SPACING.sm },
  songChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm + 4, paddingVertical: 7,
  },
  songChipText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  songDoneBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },

  durationOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  durationSheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.sm, paddingHorizontal: SPACING.md, maxHeight: '60%',
  },
  durationHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  durationTitle: { color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: SPACING.xs },
  durationList: { alignSelf: 'stretch' },
  durationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: RADIUS.md },
  durationRowSel: { backgroundColor: 'rgba(127,127,127,0.14)' },
  durationRowText: { color: colors.textSecondary, fontSize: 17, fontWeight: '600' },
  durationRowTextSel: { color: colors.text, fontWeight: '800' },
  linkEditorOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: SPACING.lg },
  linkEditorCard: { width: '100%', maxWidth: 420, borderRadius: RADIUS.xl, padding: SPACING.lg, gap: SPACING.md },
  linkEditorTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center' },
  linkEditorInput: { borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: 12, fontSize: 16, borderWidth: 1 },
  linkEditorBtn: { flex: 1, paddingVertical: 13, borderRadius: RADIUS.md, alignItems: 'center' },
});
