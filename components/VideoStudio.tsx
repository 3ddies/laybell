import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ScrollView, Switch, PanResponder,
  Dimensions, Platform, KeyboardAvoidingView, Pressable, Keyboard, ActivityIndicator,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '../contexts/LanguageContext';
import { usePostMusicActions, usePostMusicMuted } from '../contexts/PostMusicContext';
import AppVideo, { type AppVideoHandle } from './AppVideo';
import StickerTimeline, { TIMELINE_H } from './StickerTimeline';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type CaptionStyle, type Sticker, type StickerBg, type StickerFit, type StickerFont,
} from './StickerLayer';
import SongBrowser, { type PickedSong } from './SongBrowser';
import { SongPartStrip, VolumeSlider, SOUND_H_PAD } from './SoundControls';
import { supabase } from '../lib/supabase';
import { EDGE_SEC, MIN_SHOW_SEC, resolveWindow, timingForNew, visibleKey } from '../lib/stickerTiming';
import {
  bandAt, bandToScreenY, bandZones, captionZone, fitInZone, isBandSticker, nearestBand, screenToBand, type Band,
} from '../lib/bandCaptions';
import { getPlaybackPosition, setPlaybackPosition, subscribePlayback } from '../lib/playbackClock';
import { markInteraction } from '../lib/playbackPresence';
import { usePlayableClip } from '../hooks/usePlayableClip';
import { useFilmstrip } from '../hooks/useFilmstrip';
import { clampStart, DEFAULT_MIX, formatClock, type SongMix } from '../lib/songMix';
import { cfStreamFrameUrl, isCfStreamHls } from '../lib/cast';

// The video studio: everything that edits a VIDEO post, on one screen between
// picking (or trimming) the clip and the post details — the step Arrange is for a
// slideshow. Owner request, 2026-09-11: the caption editor, the music picker and
// the sound controls were separate screens reached from the details form, and
// they belong together.
//
//   Text   captions, placed and timed (lib/stickerTiming): anywhere over a vertical
//          clip; on a horizontal one, inside the black letterbox bands above and
//          below the picture, where the upright reel shows them (lib/bandCaptions).
//   Music  the song list itself (components/SongBrowser), and whether this is a
//          music video (its song a credit). Choosing a song opens Sound.
//   Sound  which part of the song plays, and the song's and the video's levels
//          (lib/songMix). Only while a song plays over the clip — with no song, or
//          a music video's, there is nothing to mix.
//   Cover  a frame from the clip, chosen with the whole screen as its preview, or a
//          photo from the camera roll.
//
// FULL SCREEN, as a Modal, although it is a composer step. The tab bar is an
// overlay that every tab screen is laid out above, so a step drawn inside the tab
// cannot reach the bottom of the screen — and captions are placed against the
// SCREEN, the way the reel viewer draws them, so the frame they are placed on has
// to be the whole screen.
//
// Captions and the sound mix stay here until Back or Next, so dragging a caption
// or a slider re-renders this screen and not the composer. The song, the music
// video switch and the cover go straight up.
//
// The clip plays from a copy in app storage (hooks/usePlayableClip: a camera-roll
// URI is a black screen), and the song through the ambient song player under HOST,
// lined up with the clip through lib/playbackClock.
//
// The same studio re-edits a POSTED video (app/edit-post): the clip is then its
// stream, played directly, and its frames — the timeline, the cover picker, the
// cover itself — are Cloudflare thumbnails rather than decodes of a local file.

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// Matches captionZone('screen', …) in lib/bandCaptions — the reel UI reserve.
const SAFE_TOP = 74;
const SAFE_BOTTOM = SCREEN_H - 240;
const BG_ORDER: StickerBg[] = ['none', 'soft', 'pill', 'boxy'];
// The studio's clock in lib/playbackClock, and its host id on the ambient song
// player: the clip writes its position there, and the song follows it.
const HOST = 'composer:studio';
// Far inside posts_timed_captions_shape (30), and plenty on one clip.
const MAX_STICKERS = 20;
const ACCENT = '#FAB525';
// The music menu: tall enough to browse, and it gives way to the keyboard.
const MUSIC_PANEL_H = Math.round(Math.min(SCREEN_H * 0.64, 560));
const NO_IDS: string[] = [];
// The cover picker's strip, and the frame-sized box that rides along it.
const COVER_FRAMES = 10;
const COVER_STRIP_H = 52;
const COVER_BOX_W = 44;
const COVER_BOX_H = 66;

type Panel = 'music' | 'sound' | 'cover' | null;
type IconName = ComponentProps<typeof Ionicons>['name'];
type Tool = {
  key: string; icon: IconName; label: string; onPress: () => void;
  active?: boolean; badge?: boolean; disabled?: boolean;
  /** Drawn in the button instead of the icon — the cover shows itself. */
  image?: string | null;
};

/** What the studio hands back on Back or Next. */
export type StudioResult = {
  /** As stored: a horizontal clip's are band captions (lib/bandCaptions). */
  captions: Sticker[];
  /** The sound mix, when it was set here for the song that plays; undefined leaves the post's as it was. */
  mix: SongMix | undefined;
};

export default function VideoStudio({
  videoUri, posterUri, aspect, windowStart, windowEnd,
  initialCaptions,
  song, onSong, musicVideo, onMusicVideo, songMix,
  coverUri, onCover, coverSec, onCoverSec, initialPanel = null,
  nextLabel, nextIcon = 'arrow-forward',
  onBack, onNext,
}: {
  /** The picked clip, however the picker returned it — a playable copy is made. */
  videoUri: string;
  posterUri: string | null;
  /** Width over height. Above 1 the clip is horizontal: its captions go in the letterbox bands. */
  aspect: number;
  /** The part of the clip that gets posted, in seconds on the source's clock. */
  windowStart: number;
  windowEnd: number;
  /** As stored: a horizontal clip's are band captions (lib/bandCaptions). */
  initialCaptions: Sticker[];
  song: PickedSong | null;
  onSong: (song: PickedSong | null) => void;
  musicVideo: boolean;
  onMusicVideo: (on: boolean) => void;
  /** The mix saved for `song`, if one was. */
  songMix: SongMix | null;
  coverUri: string | null;
  onCover: (uri: string) => void;
  /** Where the cover's frame was taken from, on the source's clock; null for a photo or the automatic frame. */
  coverSec: number | null;
  onCoverSec: (sec: number | null) => void;
  /** Open on a panel: the details page's cover square opens the cover picker. */
  initialPanel?: 'cover' | null;
  /** The forward button — "Next" in the composer, "Done" when re-editing a post. */
  nextLabel?: string;
  nextIcon?: IconName;
  onBack: (result: StudioResult) => void;
  onNext: (result: StudioResult) => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { playSong, stop: stopSong, toggleMuted } = usePostMusicActions();
  const songMuted = usePostMusicMuted();
  const videoRef = useRef<AppVideoHandle>(null);
  const horizontal = aspect > 1;
  // A horizontal clip's caption zones on this screen — the upright reel's own
  // letterbox geometry; null where a band has too little black.
  const zones = useMemo(() => (horizontal ? bandZones(aspect, SCREEN_W, SCREEN_H) : null), [horizontal, aspect]);

  // ── captions ───────────────────────────────────────────────────────────────
  // Edited in screen coordinates either way; a horizontal clip's are stored by
  // band, and turned back on the way out (result()). Each one that came in is
  // remembered with where it was shown, and one nobody moved goes back exactly as
  // it came: re-deriving it from the screen would round an old bubble's y, or move
  // a caption this phone could only show in its other band.
  const arrived = useRef<Map<string, { band: Band; y: number; shownY: number }> | null>(null);
  const [stickers, setStickers] = useState<Sticker[]>(() => {
    if (!horizontal) return initialCaptions.filter((s) => !isBandSticker(s));
    const seen = new Map<string, { band: Band; y: number; shownY: number }>();
    arrived.current = seen;
    return initialCaptions.filter(isBandSticker).map((s) => {
      const shownY = bandToScreenY(s.band, s.y, aspect, SCREEN_W, SCREEN_H);
      seen.set(s.id, { band: s.band, y: s.y, shownY });
      return { ...s, y: shownY };
    });
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  // The caption the timeline shows a bar for: the last one added, edited or moved.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [overTrash, setOverTrash] = useState(false);
  // The style the NEXT new caption inherits (last-used), and the live values
  // while the text overlay is open.
  const [font, setFont] = useState<StickerFont>('classic');
  const [color, setColor] = useState<string>('#FFFFFF');
  const [bg, setBg] = useState<StickerBg>('boxy');
  const [text, setText] = useState('');
  const idRef = useRef(0);

  // ── panels ─────────────────────────────────────────────────────────────────
  const [panel, setPanel] = useState<Panel>(initialPanel);
  const panelRef = useRef<Panel>(initialPanel);

  // ── playback ───────────────────────────────────────────────────────────────
  // Opened on the cover picker, the clip starts held on the cover's frame.
  const [playing, setPlaying] = useState(initialPanel !== 'cover');
  const resumeAfterScrub = useRef(false);
  // Set when the cover picker paused the clip, so closing it plays on.
  const resumeAfterCover = useRef(initialPanel === 'cover');
  // The video's own sound when no song plays over it. Over a song the one sound
  // button is the app-wide song mute, as it is in the feed.
  const [videoMutedHere, setVideoMutedHere] = useState(false);

  const { uri: playUri, failed: clipFailed, preparing, markFailed } = usePlayableClip(true, videoUri, 'studio');
  const canPlay = !!playUri && !clipFailed;
  const windowSec = Math.max(0, windowEnd - windowStart);
  // Scrubbing and timing need a known length; without one captions still place.
  const hasTimeline = windowSec >= MIN_SHOW_SEC * 2;
  const canTime = hasTimeline;

  // The studio's clock starts at the posted window's first second.
  useEffect(() => {
    setPlaybackPosition(HOST, windowStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Which captions show at the playhead. Changes only when one enters or leaves,
  // so the player's ticks do not re-render the studio.
  const subscribe = useCallback((cb: () => void) => subscribePlayback(HOST, cb), []);
  const visKey = useSyncExternalStore(subscribe, () => visibleKey(stickers, getPlaybackPosition(HOST)));
  // While the clip plays, captions come and go exactly as they will in the app.
  // Paused — to place, move or time one — the selected caption stays on screen
  // outside its window too, drawn faint there, so it can still be found. It used to
  // stay fully visible even while playing, which read as the timer not working.
  const shown = useMemo(
    () => (canTime
      ? stickers.filter((s, i) => visKey.includes(`|${i}|`) || (!playing && s.id === selectedId))
      : stickers),
    [canTime, stickers, selectedId, visKey, playing],
  );
  const faintIds = useMemo(() => {
    if (!canTime || playing || !selectedId) return NO_IDS;
    const i = stickers.findIndex((s) => s.id === selectedId);
    return i >= 0 && !visKey.includes(`|${i}|`) ? [selectedId] : NO_IDS;
  }, [canTime, playing, selectedId, stickers, visKey]);
  const selected = stickers.find((s) => s.id === selectedId) ?? null;
  const selectedWindow = selected && canTime ? resolveWindow(selected, windowStart, windowEnd) : null;
  const wholeVideo = !!selectedWindow && selectedWindow.start <= windowStart && selectedWindow.end >= windowEnd;
  const atMax = stickers.length >= MAX_STICKERS;

  // ── the song and the sound mix ─────────────────────────────────────────────
  // A music video's song is a credit and never plays, so it has nothing to mix.
  const songPlays = !!song && !musicVideo;
  const songId = song?.id ?? null;
  const [mix, setMix] = useState<SongMix>(songMix ?? DEFAULT_MIX);
  // Only a mix set here goes back to the post; untouched, the post keeps its own.
  const mixTouched = useRef(false);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const mixSong = useRef(songId);
  useEffect(() => {
    if (mixSong.current === songId) return;
    mixSong.current = songId;
    // Another song: its own saved mix, or a fresh one.
    setMix(songMix ?? DEFAULT_MIX);
    mixTouched.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

  // The song's audio and length. PickedSong carries neither; every song post has
  // duration_seconds.
  const [songInfo, setSongInfo] = useState<{ id: string; url: string | null; durationSec: number } | null>(null);
  useEffect(() => {
    if (!songId || songInfo?.id === songId) return;
    let cancelled = false;
    supabase.from('posts').select('media_url, duration_seconds').eq('id', songId).single()
      .then(({ data }) => {
        if (cancelled) return;
        const d: any = data;
        setSongInfo({ id: songId, url: d?.media_url ?? null, durationSec: Number(d?.duration_seconds) || 0 });
      }, () => { if (!cancelled) setSongInfo({ id: songId, url: null, durationSec: 0 }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);
  const info = songId && songInfo?.id === songId ? songInfo : null;
  const songSec = info?.durationSec ?? 0;
  const songUrl = info?.url ?? null;
  const startSec = clampStart(mix.startSec, songSec, windowSec);

  // The song plays with the clip, and only while the clip does — lined up with it
  // by the ambient player (PostMusicContext). Asked again with a new mix it adjusts
  // in place; stopped and asked again, it lines back up with wherever the clip is.
  // Held while the clip is still being copied, so the two start together, and
  // while the music menu is open, where the list plays its own previews.
  const songOn = songPlays && !!songUrl && !preparing && playing && panel !== 'music';
  useEffect(() => {
    if (!songOn || !songId || !songUrl) { stopSong(HOST); return; }
    playSong(HOST, songId, songUrl, { startSec, volume: mix.songVolume, videoStartSec: windowStart });
  }, [songOn, songId, songUrl, startSec, mix.songVolume, windowStart, playSong, stopSong]);
  useEffect(() => () => stopSong(HOST), [stopSong]);

  // Sound is only for a song that plays: removing the song, or making this a music
  // video, closes it.
  useEffect(() => {
    if (panel === 'sound' && !songPlays) setPanel(null);
  }, [panel, songPlays]);

  const soundOff = songPlays ? songMuted : videoMutedHere;
  const videoMuted = songPlays ? songMuted || mix.videoVolume <= 0 : videoMutedHere;
  const videoVolume = songPlays ? mix.videoVolume : 1;
  function toggleSound() {
    if (songPlays) toggleMuted();
    else setVideoMutedHere((m) => !m);
  }

  // A new part restarts the pair: the clip to its first second, then the song to
  // the new part — the player lines it up with the clip, which is now at its start.
  function commitStart(sec: number) {
    mixTouched.current = true;
    videoRef.current?.seek(windowStart);
    setPlaybackPosition(HOST, windowStart);
    setMix((m) => ({ ...m, startSec: clampStart(sec, songSec, windowSec) }));
    setPlaying(true);
  }
  // Choosing a song goes straight to its sound — the part that plays and the
  // levels — so the audio is set up in one pass. A music video's song never plays,
  // so there is nothing to set and the menu just closes.
  function pickSong(next: PickedSong) {
    onSong(next);
    setPanel(musicVideo ? null : 'sound');
    setPlaying(true);
  }
  function setLevel(key: 'songVolume' | 'videoVolume', v: number) {
    mixTouched.current = true;
    setMix((m) => ({ ...m, [key]: v }));
  }

  // ── the cover ──────────────────────────────────────────────────────────────
  const [coverBusy, setCoverBusy] = useState(false);
  // The latest cover asked for wins: a frame still being made must not replace a
  // later one, or a photo picked meanwhile.
  const coverToken = useRef(0);
  const coverAt = () => Math.min(windowEnd, Math.max(windowStart, coverSec ?? windowStart));

  // The cover picker holds the clip on the cover's frame, so the whole screen is
  // its preview; closing it plays on.
  function openCover() {
    setPanel('cover');
    if (playing) { resumeAfterCover.current = true; setPlaying(false); }
    const at = coverAt();
    videoRef.current?.seek(at);
    setPlaybackPosition(HOST, at);
  }
  useEffect(() => {
    const was = panelRef.current;
    panelRef.current = panel;
    if (was === 'cover' && panel !== 'cover' && resumeAfterCover.current) {
      resumeAfterCover.current = false;
      setPlaying(true);
    }
  }, [panel]);
  // Opened on the cover picker (from the details page), the clip loads after the
  // panel is up — show the cover's frame once it can.
  function onClipReady() {
    if (panelRef.current !== 'cover') return;
    const at = coverAt();
    videoRef.current?.seek(at);
    setPlaybackPosition(HOST, at);
  }
  function previewCover(sec: number) {
    videoRef.current?.seek(sec);
    setPlaybackPosition(HOST, sec);
  }
  // A frame from the clip becomes the cover, made from the app-storage copy — the
  // same file the clip plays from, so it decodes where the picked camera-roll URI
  // does not.
  async function coverFromFrame(sec: number) {
    onCoverSec(sec);
    if (!playUri) return;
    // A posted video's frame is already on its CDN: the cover is that frame's URL.
    if (isCfStreamHls(playUri)) {
      coverToken.current++;
      setCoverBusy(false);
      const url = cfStreamFrameUrl(playUri, sec, 1280);
      if (url) onCover(url);
      return;
    }
    const token = ++coverToken.current;
    setCoverBusy(true);
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(playUri, { time: Math.max(0, Math.round(sec * 1000)), quality: 0.85 });
      if (token === coverToken.current) onCover(uri);
    } catch {
      // The cover stays what it was.
    } finally {
      if (token === coverToken.current) setCoverBusy(false);
    }
  }
  async function coverFromLibrary() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 0.9 });
      if (res.canceled || !res.assets?.[0]) return;
      coverToken.current++;
      setCoverBusy(false);
      onCover(res.assets[0].uri);
      onCoverSec(null);
    } catch {
      // Picker unavailable or dismissed: the cover stays what it was.
    }
  }

  // ── caption editing ────────────────────────────────────────────────────────
  const clampY = (y: number) => Math.min(SAFE_BOTTOM / SCREEN_H, Math.max(SAFE_TOP / SCREEN_H, y));
  // A horizontal clip's captions stay whole inside the band on their side of the
  // picture — kept there live while one is dragged or pinched, shrunk if it won't fit.
  const keepInBand = useCallback((fit: StickerFit) => {
    const band = nearestBand(fit.y * SCREEN_H, aspect, SCREEN_W, SCREEN_H);
    if (!band) return fit;
    const p = fitInZone(
      { cx: fit.x * SCREEN_W, cy: fit.y * SCREEN_H, w: fit.w, h: fit.h, scale: fit.scale, rotation: fit.rotation },
      captionZone(band, aspect, SCREEN_W, SCREEN_H),
      SCREEN_W,
    );
    return { x: p.cx / SCREEN_W, y: p.cy / SCREEN_H, scale: p.scale };
  }, [aspect]);
  // Where the Text button starts a caption: a horizontal clip's top band (or its
  // bottom one), or nowhere when neither has room.
  const firstBandY = !zones
    ? 0.3
    : zones.top ? (zones.top.top + zones.top.usable / 2) / SCREEN_H
      : zones.bottom ? (zones.bottom.top + zones.bottom.usable / 2) / SCREEN_H
        : null;
  // Time-stamped: a draft restored in a later session brings back captions whose
  // ids a counter restarting at 0 would hand out again.
  const newId = () => `vc${Date.now().toString(36)}${idRef.current++}`;
  const timingHere = () => (canTime ? timingForNew(getPlaybackPosition(HOST), windowStart, windowEnd) : {});

  function addStickerAt(xNorm: number, yNorm: number) {
    if (atMax) return;
    let y = clampY(yNorm);
    if (horizontal) {
      // Into the band on that side of the picture; kept whole once it's measured.
      const band = nearestBand(yNorm * SCREEN_H, aspect, SCREEN_W, SCREEN_H);
      if (!band) return;
      const zone = captionZone(band, aspect, SCREEN_W, SCREEN_H);
      y = Math.min(zone.bottom, Math.max(zone.top, yNorm * SCREEN_H)) / SCREEN_H;
    }
    const id = newId();
    setStickers((prev) => [...prev, {
      id, text: '', x: Math.min(0.9, Math.max(0.1, xNorm)), y,
      scale: 1, rotation: 0, font, color, bg, size: 26, ...timingHere(),
    }]);
    setEditingId(id);
    setSelectedId(id);
    resumeAfterCover.current = false;
    setPanel(null);
    setText('');
    // Typing over a moving frame is hard; ▶ picks it back up.
    setPlaying(false);
  }

  function editSticker(id: string) {
    const s = stickers.find((k) => k.id === id);
    if (!s) return;
    setSelectedId(id);
    resumeAfterCover.current = false;
    setPanel(null);
    if (s.emoji) return; // emoji captions (from before the tray went) are placed and timed, not typed
    setFont(s.font ?? 'classic');
    setColor(s.color ?? '#FFFFFF');
    setBg(s.bg ?? 'none');
    setText(s.text);
    setEditingId(id);
    setPlaying(false);
  }

  function manipulateSticker(id: string, style: CaptionStyle) {
    // A horizontal clip's arrive already kept in their band (keepInBand).
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...style, y: horizontal ? style.y : clampY(style.y) } : s)));
    setSelectedId(id);
  }

  // Text overlay committed → write style + text back; drop if left empty.
  function commitEditing() {
    const committed = text.trim();
    setStickers((prev) => prev
      .map((s) => (s.id === editingId ? { ...s, text: committed, font, color, bg } : s))
      .filter((s) => s.text !== ''));
    if (!committed) setSelectedId(null);
    setEditingId(null);
    Keyboard.dismiss();
  }

  function onStickerRelease(id: string, xNorm: number, yNorm: number) {
    // Dropped on the trash → delete.
    if (inTrash(xNorm, yNorm)) {
      setStickers((prev) => prev.filter((s) => s.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    }
  }

  function inTrash(xNorm: number, yNorm: number) {
    return yNorm > (SCREEN_H - insets.bottom - 130) / SCREEN_H && Math.abs(xNorm - 0.5) < 0.18;
  }

  // Scrubbing pauses, and playback resumes on release if it was running.
  function scrub(sec: number) {
    if (playing) { resumeAfterScrub.current = true; setPlaying(false); }
    setPlaybackPosition(HOST, sec);
    videoRef.current?.seek(sec);
  }
  function scrubEnd() {
    if (resumeAfterScrub.current) { resumeAfterScrub.current = false; setPlaying(true); }
  }

  // An end dragged within EDGE_SEC of the window's edge is left OPEN, the same
  // rule publish applies — "from the start" stays from the start even if the
  // clip is re-trimmed later.
  function changeRange(start: number, end: number) {
    if (!selectedId) return;
    setStickers((prev) => prev.map((s) => (s.id === selectedId
      ? { ...s, start: start - windowStart <= EDGE_SEC ? undefined : start, end: windowEnd - end <= EDGE_SEC ? undefined : end }
      : s)));
  }

  // ── leaving ────────────────────────────────────────────────────────────────
  function result(): StudioResult {
    const kept = stickers.filter((s) => s.text.trim()).map((s) => ({ ...s, text: s.text.trim() }));
    return {
      captions: horizontal
        ? kept.map((s) => {
          const was = arrived.current?.get(s.id);
          return was && was.shownY === s.y
            ? { ...s, band: was.band, y: was.y }
            : { ...s, ...screenToBand(s.y, aspect, SCREEN_W, SCREEN_H) };
        })
        : kept,
      mix: songPlays && mixTouched.current
        ? { startSec, songVolume: mix.songVolume, videoVolume: mix.videoVolume }
        : undefined,
    };
  }
  // Android's back button steps out one layer at a time, as the screen's own
  // controls do.
  function onHardwareBack() {
    if (editingId) commitEditing();
    else if (panel) setPanel(null);
    else onBack(result());
  }

  function togglePanel(p: 'music' | 'sound') {
    setPanel((cur) => (cur === p ? null : p));
  }

  const tools: Tool[] = [
    {
      key: 'text', icon: 'text', label: t('topcap.textBtn'),
      onPress: () => { if (firstBandY != null) addStickerAt(0.5, firstBandY); },
      disabled: atMax || firstBandY == null,
    },
    { key: 'music', icon: 'musical-notes', label: t('post.musicLabel'), onPress: () => togglePanel('music'), active: panel === 'music', badge: !!song },
    // Only while a song plays over the clip: with no song there is nothing to mix,
    // and a music video's song is the clip's own soundtrack.
    ...(songPlays ? [{
      key: 'sound', icon: 'options' as IconName, label: t('post.soundLabel'),
      onPress: () => togglePanel('sound'), active: panel === 'sound', badge: mixTouched.current || !!songMix,
    }] : []),
    {
      key: 'cover', icon: 'image-outline', label: t('thumb.title'),
      onPress: () => (panel === 'cover' ? setPanel(null) : openCover()), active: panel === 'cover', image: coverUri,
    },
  ];

  const preview = resolveSticker({ font, color, bg, size: 26 });
  const showTimeline = hasTimeline && !editingId && !dragActive && panel === null;
  const bottomReserve = showTimeline ? TIMELINE_H + insets.bottom : insets.bottom + 8;

  return (
    <Modal visible animationType="none" onRequestClose={onHardwareBack} statusBarTranslucent>
      {/* A Modal is its own native root, so the app's root touch observer may not
          see these touches. Report them directly: an editing session is presence,
          and the clip must not stop repeating mid-edit. */}
      <View style={styles.root} onTouchStart={markInteraction}>
        {/* CONTAIN, so the whole clip is visible while it is edited. Captions are
            positioned against the SCREEN here and in the reel viewer alike, so
            each one lands on the same spot of the screen it was placed on. */}
        {canPlay ? (
          <AppVideo
            ref={videoRef}
            source={{ uri: playUri! }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            active={playing}
            loop
            muted={videoMuted}
            volume={videoVolume}
            ignoreSuspend
            poster={posterUri}
            posterContentFit="contain"
            trimStartSec={windowStart > 0 ? windowStart : null}
            trimEndSec={hasTimeline ? windowEnd : null}
            progressIntervalMs={100}
            onProgress={(ms) => setPlaybackPosition(HOST, ms / 1000)}
            onReady={onClipReady}
            // A local copy that fails will fail the same way on every retry; a
            // posted video's stream may just have hit a bad moment on the network.
            retryLoadErrors={/^https?:\/\//i.test(playUri!)}
            onLoadError={(message) => {
              // eslint-disable-next-line no-console
              if (__DEV__) console.log(`[studio] clip failed to load: ${message}`);
              markFailed();
            }}
          />
        ) : posterUri ? (
          <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="contain" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.videoGhost]}>
            <Ionicons name="videocam-outline" size={34} color="rgba(255,255,255,0.3)" />
          </View>
        )}
        {preparing && !canPlay && !clipFailed && (
          <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            <ActivityIndicator color="#fff" />
          </View>
        )}

        {/* Reserved-area ghosts so the safe band is tangible. */}
        <View style={[styles.reserveGhost, { top: 0, height: SAFE_TOP }]} pointerEvents="none" />
        {!horizontal && !canTime && (
          <View style={styles.reelGhost} pointerEvents="none">
            <View style={styles.ghostMeta}>
              <View style={[styles.ghostLine, { width: 84, height: 11 }]} />
              <View style={[styles.ghostLine, { width: 190 }]} />
            </View>
            <View style={styles.ghostRail}>
              {[0, 1, 2, 3].map((i) => <View key={i} style={styles.ghostDot} />)}
            </View>
            <View style={styles.ghostScrub} />
          </View>
        )}

        {/* A horizontal clip's letterbox bands, where its captions go — marked while
            there are none yet and while one is dragged. The rotate pill the reel
            parks above the picture is why the top band stops short of it. */}
        {zones && !editingId && (stickers.length === 0 || dragActive) && (
          <>
            {zones.top && <View style={[styles.bandZone, { top: zones.top.top, height: zones.top.usable }]} pointerEvents="none" />}
            {zones.bottom && <View style={[styles.bandZone, { top: zones.bottom.top, height: zones.bottom.usable }]} pointerEvents="none" />}
            {zones.top && (
              <View style={[styles.rotateGhost, { top: zones.top.band - 52 }]} pointerEvents="none">
                <Ionicons name="phone-landscape-outline" size={15} color="rgba(255,255,255,0.6)" />
                <Text style={styles.rotateGhostText}>{t('reel.rotateForFullscreen')}</Text>
              </View>
            )}
          </>
        )}

        {/* The story gesture engine — add / edit / move / pinch / delete. Only the
            captions showing at the playhead (plus the selected one) are here, so a
            caption that is not on screen cannot be grabbed by accident. */}
        <StickerLayer
          stickers={shown}
          frameW={SCREEN_W}
          frameH={SCREEN_H}
          editingId={editingId}
          onManipulate={manipulateSticker}
          onTapSticker={editSticker}
          onTapEmpty={(x, y) => {
            if (panel) setPanel(null);
            else if (!horizontal || bandAt(y * SCREEN_H, aspect, SCREEN_W, SCREEN_H)) addStickerAt(x, y);
            // On a horizontal clip, a tap on the picture itself plays and pauses.
            else setPlaying((p) => !p);
          }}
          onDragActive={(a) => { setDragActive(a); if (!a) setOverTrash(false); }}
          onDragMove={(x, y) => { const over = inTrash(x, y); setOverTrash((p) => (p === over ? p : over)); }}
          onRelease={onStickerRelease}
          faintIds={faintIds}
          constrain={horizontal ? keepInBand : undefined}
        />

        {/* Trash target (only while dragging — the timeline steps aside for it). */}
        {dragActive && (
          <View style={[styles.trashZone, { bottom: insets.bottom + 40 }]} pointerEvents="none">
            <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
              <Ionicons name="trash" size={22} color="#fff" />
            </View>
          </View>
        )}

        {/* Top bar and tools (hidden while typing so the overlay owns the screen). */}
        {!editingId && (
          <>
            <View style={[styles.topBar, { top: insets.top + 8 }]}>
              <TouchableOpacity style={styles.barBtn} onPress={() => onBack(result())} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
                <Ionicons name="chevron-back" size={24} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.title} numberOfLines={1}>{t('videoStudio.title')}</Text>
              <TouchableOpacity
                style={styles.barBtn}
                onPress={toggleSound}
                accessibilityRole="button"
                accessibilityLabel={soundOff ? t('a11y.unmute') : t('a11y.mute')}
              >
                <Ionicons name={soundOff ? 'volume-mute' : 'volume-high'} size={20} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.nextBtn} onPress={() => onNext(result())} accessibilityRole="button">
                <Text style={styles.nextText}>{nextLabel ?? t('videoStudio.next')}</Text>
                <Ionicons name={nextIcon} size={16} color="#111" />
              </TouchableOpacity>
            </View>

            <View style={[styles.rail, { top: insets.top + 64 }]} pointerEvents="box-none">
              {tools.map((tool) => (
                <TouchableOpacity
                  key={tool.key}
                  style={[styles.tool, tool.disabled && styles.disabled]}
                  disabled={tool.disabled}
                  onPress={tool.onPress}
                  accessibilityRole="button"
                  accessibilityLabel={tool.label}
                >
                  <View
                    style={[
                      styles.toolIcon,
                      tool.active && styles.toolIconActive,
                      !!tool.image && styles.toolIconImage,
                      !!tool.image && tool.active && styles.toolIconImageActive,
                    ]}
                  >
                    {tool.image
                      ? <ExpoImage source={{ uri: tool.image }} style={StyleSheet.absoluteFill} contentFit="cover" />
                      : <Ionicons name={tool.icon} size={22} color="#fff" />}
                    {tool.badge ? <View style={styles.toolBadge} /> : null}
                  </View>
                  <Text style={styles.toolLabel} numberOfLines={1}>{tool.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {stickers.length === 0 && !dragActive && panel === null && firstBandY != null && (
              <Text style={[styles.hint, { bottom: bottomReserve + 16 }]}>
                {horizontal ? t('videoStudio.bandHint') : t('topcap.tapHint')}
              </Text>
            )}
          </>
        )}

        {showTimeline && (
          <StickerTimeline
            clockId={HOST}
            uri={canPlay ? playUri : null}
            posterUri={posterUri}
            windowStart={windowStart}
            windowEnd={windowEnd}
            canPlay={canPlay}
            playing={playing}
            onTogglePlay={() => setPlaying((p) => !p)}
            onScrub={scrub}
            onScrubEnd={scrubEnd}
            selected={selectedWindow}
            wholeVideo={wholeVideo}
            onRangeChange={changeRange}
            bottomInset={insets.bottom}
          />
        )}

        {panel === 'music' && !editingId && (
          // The menu is the song list itself: All, Liked, Yours and Saved, with
          // search, preview and a like on every song. Lifted with the keyboard for
          // the search field — a flex child of the dock rather than absolutely
          // placed, so the keyboard's padding actually moves it.
          <KeyboardAvoidingView
            style={styles.panelDock}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            pointerEvents="box-none"
          >
            <View style={[styles.panel, styles.musicPanel, { paddingBottom: insets.bottom + 8 }]}>
              <PanelHeader title={t('post.musicLabel')} doneLabel={t('common.done')} onDone={() => setPanel(null)} />
              {song && (
                <View style={styles.songCard}>
                  <Ionicons name="musical-notes" size={16} color={ACCENT} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.songTitle} numberOfLines={1}>{song.title}</Text>
                    {!!song.artist && <Text style={styles.songArtist} numberOfLines={1}>{song.artist}</Text>}
                  </View>
                  {songPlays && (
                    <TouchableOpacity style={styles.smallBtn} onPress={() => setPanel('sound')} accessibilityRole="button">
                      <Text style={styles.smallBtnText}>{t('post.soundLabel')}</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('a11y.clear')}
                    onPress={() => onSong(null)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={22} color="rgba(255,255,255,0.7)" />
                  </TouchableOpacity>
                </View>
              )}
              {/* Flipping it clears the song on purpose: the two modes draw from
                  different catalogues (anyone's public audio vs. only your own), so a
                  song picked under one rule must not survive into the other. */}
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>{t('post.musicVideoLabel')}</Text>
                  <Text style={styles.switchSub} numberOfLines={2}>{t('post.musicVideoSub')}</Text>
                </View>
                <Switch
                  value={musicVideo}
                  onValueChange={(v) => { onMusicVideo(v); onSong(null); }}
                  trackColor={{ false: 'rgba(255,255,255,0.25)', true: ACCENT }}
                  thumbColor="#fff"
                />
              </View>
              <SongBrowser tone="dark" ownOnly={musicVideo} selectedId={song?.id ?? null} onPick={pickSong} />
            </View>
          </KeyboardAvoidingView>
        )}

        {panel === 'sound' && songPlays && song && !editingId && (
          <View style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
            <PanelHeader title={t('post.soundLabel')} doneLabel={t('common.done')} onDone={() => setPanel(null)} />
            <View style={styles.songRow}>
              <Ionicons name="musical-notes" size={15} color="#fff" />
              <Text style={styles.songRowTitle} numberOfLines={1}>{song.title}</Text>
              <Text style={styles.startLabel}>{t('sound.startsAt', { time: formatClock(dragStart ?? startSec) })}</Text>
            </View>
            {songSec > 0 ? (
              <SongPartStrip
                seed={song.id}
                songSec={songSec}
                windowSec={windowSec}
                startSec={startSec}
                onDrag={setDragStart}
                onCommit={commitStart}
              />
            ) : (
              <View style={[styles.stripPlaceholder, styles.center]}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
            <Text style={styles.panelHint}>
              {songSec > 0 && windowSec >= songSec ? t('sound.wholeSong') : t('sound.pickPart')}
            </Text>
            <VolumeSlider icon="musical-notes" label={t('sound.song')} value={mix.songVolume} onChange={(v) => setLevel('songVolume', v)} />
            <VolumeSlider icon="videocam" label={t('sound.original')} value={mix.videoVolume} onChange={(v) => setLevel('videoVolume', v)} />
          </View>
        )}

        {panel === 'cover' && !editingId && (
          <View style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
            <PanelHeader title={t('thumb.title')} doneLabel={t('common.done')} onDone={() => setPanel(null)} />
            <View style={styles.coverRow}>
              <View style={styles.coverThumb}>
                {coverUri ? (
                  <ExpoImage source={{ uri: coverUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                ) : (
                  <Ionicons name="image-outline" size={20} color="rgba(255,255,255,0.6)" />
                )}
                {coverBusy && (
                  <View style={[StyleSheet.absoluteFill, styles.center, styles.coverThumbBusy]}>
                    <ActivityIndicator color="#fff" size="small" />
                  </View>
                )}
              </View>
              <Text style={[styles.panelHint, styles.coverHint]}>{t('thumb.chooseFrame')}</Text>
            </View>
            {canPlay && hasTimeline ? (
              <CoverStrip
                uri={playUri}
                posterUri={posterUri}
                windowStart={windowStart}
                windowEnd={windowEnd}
                sec={coverAt()}
                onScrub={previewCover}
                onPick={coverFromFrame}
              />
            ) : preparing ? (
              <View style={[styles.coverStripPlaceholder, styles.center]}>
                <ActivityIndicator color="#fff" />
              </View>
            ) : null}
            <TouchableOpacity style={styles.libraryBtn} onPress={coverFromLibrary} accessibilityRole="button">
              <Ionicons name="images-outline" size={16} color="#fff" />
              <Text style={styles.libraryText}>{t('thumb.fromLibrary')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Text editing overlay (per caption). */}
        {editingId && (
          <KeyboardAvoidingView
            style={[StyleSheet.absoluteFill, styles.editScrim]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={StyleSheet.absoluteFill} onPress={commitEditing} />
            <View style={[styles.editDoneRow, { top: insets.top + 8 }]} pointerEvents="box-none">
              <TouchableOpacity style={styles.editDone} onPress={commitEditing} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={styles.editDoneText}>{t('storyCamera.done')}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.editCenter} pointerEvents="box-none">
              <View style={preview.boxStyle}>
                <TextInput
                  style={[preview.textStyle, styles.input]}
                  value={text}
                  onChangeText={setText}
                  placeholder={t('storyCamera.typeSomething')}
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  selectionColor={ACCENT}
                  cursorColor={ACCENT}
                  multiline
                  autoFocus
                  maxLength={200}
                  textAlign="center"
                />
              </View>
            </View>

            {/* Style toolbar — colors, then background toggle + font pills. */}
            <View style={[styles.styleBar, { bottom: insets.bottom + 10 }]}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatchRow} keyboardShouldPersistTaps="always">
                {STICKER_COLORS.map((c) => (
                  <TouchableOpacity key={c} style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchActive]} onPress={() => setColor(c)} />
                ))}
              </ScrollView>
              <View style={styles.fontRow}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.colour')}
                  style={[styles.bgToggle, bg !== 'none' && styles.bgToggleActive]}
                  onPress={() => setBg((b) => BG_ORDER[(BG_ORDER.indexOf(b) + 1) % BG_ORDER.length])}
                >
                  <Ionicons name="color-fill-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontPills} keyboardShouldPersistTaps="always">
                  {STICKER_FONTS.map((f) => (
                    <TouchableOpacity key={f.key} style={[styles.fontPill, font === f.key && styles.fontPillActive]} onPress={() => setFont(f.key)}>
                      <Text style={[styles.fontPillText, font === f.key && styles.fontPillTextActive]}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>
          </KeyboardAvoidingView>
        )}

      </View>
    </Modal>
  );
}

function PanelHeader({ title, doneLabel, onDone }: { title: string; doneLabel: string; onDone: () => void }) {
  return (
    <View style={styles.panelHeader}>
      <Text style={styles.panelTitle}>{title}</Text>
      <TouchableOpacity onPress={onDone} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} accessibilityRole="button">
        <Text style={styles.panelDone}>{doneLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

// The cover picker's strip: frames across the posted window, and a frame-sized box
// that drags along them. The clip behind follows the box, so the whole screen shows
// the exact frame; letting go — or a tap — makes it the cover.
function CoverStrip({ uri, posterUri, windowStart, windowEnd, sec, onScrub, onPick }: {
  uri: string | null;
  posterUri: string | null;
  windowStart: number;
  windowEnd: number;
  /** The cover's time, where the box rests. */
  sec: number;
  onScrub: (sec: number) => void;
  onPick: (sec: number) => void;
}) {
  const trackW = SCREEN_W - SOUND_H_PAD * 2;
  const frames = useFilmstrip(uri, windowStart, windowEnd, COVER_FRAMES);
  const span = Math.max(0.001, windowEnd - windowStart);
  const travel = Math.max(1, trackW - COVER_BOX_W);
  const secToX = (s: number) => Math.min(travel, Math.max(0, ((s - windowStart) / span) * travel));

  const [dragX, setDragX] = useState<number | null>(null);
  // Everything the once-created responder reads, refreshed each render.
  const live = useRef({ windowStart, span, travel, onScrub, onPick });
  live.current = { windowStart, span, travel, onScrub, onPick };
  // pageX against the measured track, because locationX is relative to whichever
  // child the finger lands on. The box is centred under the finger.
  const trackRef = useRef<View>(null);
  const trackX = useRef(SOUND_H_PAD);
  const measure = () => {
    trackRef.current?.measureInWindow((x) => { if (Number.isFinite(x)) trackX.current = x; });
  };
  const toX = (pageX: number) => Math.min(live.current.travel, Math.max(0, pageX - trackX.current - COVER_BOX_W / 2));
  const toSec = (x: number) => live.current.windowStart + (x / live.current.travel) * live.current.span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { const x = toX(e.nativeEvent.pageX); setDragX(x); live.current.onScrub(toSec(x)); },
    onPanResponderMove: (e) => { const x = toX(e.nativeEvent.pageX); setDragX(x); live.current.onScrub(toSec(x)); },
    onPanResponderRelease: (e) => { const x = toX(e.nativeEvent.pageX); setDragX(null); live.current.onPick(toSec(x)); },
    onPanResponderTerminate: () => setDragX(null),
  })).current;

  const x = dragX ?? secToX(sec);
  // The strip's frame nearest the box, shown inside it.
  const nearest = frames[Math.min(COVER_FRAMES - 1, Math.max(0, Math.round((x / travel) * (COVER_FRAMES - 1))))];
  return (
    <View ref={trackRef} onLayout={measure} style={[styles.coverTrack, { width: trackW }]} {...pan.panHandlers}>
      <View style={styles.coverStrip} pointerEvents="none">
        {frames.map((f, i) => (
          <View key={i} style={styles.coverCell}>
            {posterUri ? <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
            {f ? <ExpoImage source={{ uri: f }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
          </View>
        ))}
      </View>
      <View pointerEvents="none" style={[styles.coverBox, { left: x }]}>
        {nearest ? <ExpoImage source={{ uri: nearest }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  videoGhost: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#101010' },
  reserveGhost: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.18)' },
  bandZone: {
    position: 'absolute', left: 10, right: 10,
    borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', borderRadius: 12,
  },
  rotateGhost: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 7, opacity: 0.55,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  rotateGhostText: { color: '#fff', fontSize: 12.5, fontWeight: '700', letterSpacing: -0.1 },
  reelGhost: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, opacity: 0.4 },
  ghostMeta: { position: 'absolute', left: 16, bottom: 58, gap: 9 },
  ghostLine: { height: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.3)' },
  ghostRail: { position: 'absolute', right: 14, bottom: 96, gap: 22, alignItems: 'center' },
  ghostDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.25)' },
  ghostScrub: { position: 'absolute', left: 0, right: 0, bottom: 12, height: 3, backgroundColor: 'rgba(255,255,255,0.28)' },
  topBar: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  barBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center' },
  nextBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 },
  nextText: { color: '#111', fontSize: 14, fontWeight: '800' },
  rail: { position: 'absolute', right: 6, alignItems: 'center', gap: 12 },
  tool: { width: 60, alignItems: 'center' },
  toolIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  toolIconActive: { backgroundColor: 'rgba(255,255,255,0.32)' },
  // The cover button shows the cover itself, as a rounded frame.
  toolIconImage: { borderRadius: 10, overflow: 'hidden', borderWidth: 2, borderColor: '#fff' },
  toolIconImageActive: { borderColor: ACCENT },
  toolBadge: { position: 'absolute', top: 7, right: 7, width: 8, height: 8, borderRadius: 4, backgroundColor: ACCENT },
  toolLabel: {
    marginTop: 4, color: '#fff', fontSize: 11, fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 },
  },
  disabled: { opacity: 0.4 },
  hint: { position: 'absolute', left: 24, right: 24, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  trashCircleHot: { backgroundColor: '#F43F5E', transform: [{ scale: 1.2 }] },
  panel: {
    position: 'absolute', left: 0, right: 0, bottom: 0, gap: 10,
    paddingTop: 12, paddingHorizontal: SOUND_H_PAD,
    borderTopLeftRadius: 18, borderTopRightRadius: 18, backgroundColor: 'rgba(0,0,0,0.74)',
  },
  panelDock: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  // In the dock's flow rather than pinned, and allowed to shrink when the keyboard
  // leaves less room than its height.
  musicPanel: { position: 'relative', height: MUSIC_PANEL_H, flexShrink: 1 },
  panelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  panelDone: { color: ACCENT, fontSize: 14, fontWeight: '800' },
  panelHint: { color: 'rgba(255,255,255,0.72)', fontSize: 12, fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchLabel: { color: '#fff', fontSize: 14, fontWeight: '700' },
  switchSub: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 },
  songCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.1)' },
  songTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  songArtist: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 1 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)' },
  smallBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  songRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  songRowTitle: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '700' },
  startLabel: { color: ACCENT, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  stripPlaceholder: { height: 56 },
  coverRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  coverThumb: {
    width: 42, height: 56, borderRadius: 8, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.1)',
  },
  coverThumbBusy: { backgroundColor: 'rgba(0,0,0,0.45)' },
  coverHint: { flex: 1 },
  coverTrack: { height: COVER_BOX_H, justifyContent: 'center' },
  coverStrip: { height: COVER_STRIP_H, borderRadius: 8, overflow: 'hidden', flexDirection: 'row', backgroundColor: '#1a1a1a' },
  coverCell: { flex: 1, height: '100%' },
  coverBox: {
    position: 'absolute', top: 0, width: COVER_BOX_W, height: COVER_BOX_H,
    borderRadius: 8, borderWidth: 2.5, borderColor: '#fff', overflow: 'hidden', backgroundColor: '#000',
  },
  coverStripPlaceholder: { height: COVER_BOX_H },
  libraryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 11, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
  },
  libraryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  editScrim: { backgroundColor: 'rgba(0,0,0,0.72)' },
  editDoneRow: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', justifyContent: 'flex-end' },
  editDone: { paddingHorizontal: 10, paddingVertical: 6 },
  editDoneText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  editCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  input: { minWidth: 60, maxWidth: SCREEN_W * 0.8 },
  styleBar: { position: 'absolute', left: 0, right: 0, gap: 12 },
  swatchRow: { paddingHorizontal: 16, gap: 10, alignItems: 'center' },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.15 }] },
  fontRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  bgToggle: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.15)' },
  bgToggleActive: { backgroundColor: 'rgba(255,255,255,0.32)' },
  fontPills: { gap: 8, alignItems: 'center', paddingRight: 12 },
  fontPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.14)' },
  fontPillActive: { backgroundColor: '#fff' },
  fontPillText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  fontPillTextActive: { color: '#111' },
});
