import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ScrollView,
  Dimensions, Platform, KeyboardAvoidingView, Pressable, Keyboard, ActivityIndicator,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '../contexts/LanguageContext';
import AppVideo, { type AppVideoHandle } from './AppVideo';
import StickerTimeline, { TIMELINE_H } from './StickerTimeline';
import StickerLayer, {
  resolveSticker, STICKER_COLORS, STICKER_FONTS,
  type CaptionStyle, type Sticker, type StickerBg, type StickerFont,
} from './StickerLayer';
import { EDGE_SEC, MIN_SHOW_SEC, resolveWindow, timingForNew, visibleKey } from '../lib/stickerTiming';
import { getPlaybackPosition, setPlaybackPosition, subscribePlayback } from '../lib/playbackClock';
import { markInteraction } from '../lib/playbackPresence';
import { ensureLocalFile, insideAppSandbox } from '../lib/upload';

// Story-style caption editor for VERTICAL reels: the exact sticker mechanism
// stories use — tap open video to ADD a caption, tap a caption to edit it,
// drag to move, pinch to resize/rotate, drop on the trash to delete, and place
// as MANY as you like. Reuses the shared StickerLayer gesture engine so the
// feel is identical to stories. Placement is clamped to the safe band so a
// caption can never sit under the reel's own controls (back button up top; the
// meta block, action rail and scrub bar down low).
//
// 1.0.3 made it an editor rather than a placement screen: the clip itself plays
// behind the captions, emoji can be added, and every caption can be TIMED — the
// timeline at the bottom scrubs the posted window, and the selected caption's bar
// sets when it appears and leaves (lib/stickerTiming). A caption shows only while
// the playhead is inside its window, exactly as it will in the app. The overlays
// stay drawn by Laybell, not burned into the file (owner decision, 2026-09-10).
//
// The clip plays from a COPY in the app's own storage. A camera-roll pick is a
// file:// URL into the Photos store, and iOS gives the app only limited access
// to it: AVFoundation opens the container but finds no readable track. The first
// device test of this editor was exactly that — a black screen — and it is why
// PendingUploads never plays a local file (lib/upload.ts ensureLocalFile has the
// full story). The copy is the one the upload makes anyway, under the same stable
// name, so a clip is copied once for both.

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// Matches captionZone('screen', …) in TopCaption.ts — the reel UI reserve.
const SAFE_TOP = 74;
const SAFE_BOTTOM = SCREEN_H - 240;

// Background cycle now includes 'boxy' (the TikTok per-line pill look).
const BG_ORDER: StickerBg[] = ['none', 'soft', 'pill', 'boxy'];

// The editor's own clock in lib/playbackClock — its player writes, the timeline
// and the visible-caption set read.
const CLOCK_ID = 'composer:caption-editor';
// Far inside posts_timed_captions_shape (30), and plenty on one clip.
const MAX_STICKERS = 20;
const EMOJIS = [
  '🔥', '❤️', '😂', '😍', '🥺', '😭', '🤯', '😎',
  '🙌', '👏', '💯', '✨', '🎵', '🎶', '🎤', '🎧',
  '🎸', '🥁', '🎹', '💃', '🕺', '👀', '🙏', '💀',
  '😤', '🥳', '🎉', '⚡', '🌙', '☀️', '🌈', '💔',
];

export default function VideoStickerEditor({
  visible, posterUri, videoUri, windowStart, windowEnd, initial, onSave, onClose,
}: {
  visible: boolean;
  posterUri: string | null;
  /** The picked clip, however the picker returned it — the editor makes a playable copy. */
  videoUri: string | null;
  /** The part of the clip that gets posted, in seconds on the source's clock. */
  windowStart: number;
  windowEnd: number;
  initial: Sticker[];
  onSave: (stickers: Sticker[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [stickers, setStickers] = useState<Sticker[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The caption the timeline is showing a bar for: the last one added, edited
  // or moved.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [overTrash, setOverTrash] = useState(false);
  // The style the NEXT new caption inherits (last-used), and the live values
  // while the text overlay is open.
  const [font, setFont] = useState<StickerFont>('classic');
  const [color, setColor] = useState<string>('#FFFFFF');
  const [bg, setBg] = useState<StickerBg>('boxy');
  const [text, setText] = useState('');
  const idRef = useRef(0);
  const videoRef = useRef<AppVideoHandle>(null);
  const resumeAfterScrub = useRef(false);

  // The playable copy (see the header). Kept per source, so reopening the editor
  // on the same clip plays at once.
  const [clip, setClip] = useState<{ source: string; local: string } | null>(null);
  const [clipFailed, setClipFailed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  useEffect(() => {
    if (!visible || !videoUri || clip?.source === videoUri) return;
    let cancelled = false;
    const began = Date.now();
    setClipFailed(false);
    setPreparing(true);
    ensureLocalFile(videoUri)
      .then((local) => {
        if (cancelled) return;
        if (insideAppSandbox(local)) {
          setClip({ source: videoUri, local });
          // eslint-disable-next-line no-console
          if (__DEV__) console.log(`[caption-editor] playing a copy in app storage (${Date.now() - began} ms)`);
        } else {
          setClipFailed(true);
          // eslint-disable-next-line no-console
          if (__DEV__) console.log('[caption-editor] could not copy the clip into app storage — showing the poster');
        }
      })
      .catch(() => { if (!cancelled) setClipFailed(true); })
      .finally(() => { if (!cancelled) setPreparing(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, videoUri]);
  const playUri = clip && clip.source === videoUri ? clip.local : null;
  const canPlay = !!playUri && !clipFailed;
  // Timing needs a known length; without one the editor still places captions.
  const canTime = windowEnd - windowStart >= MIN_SHOW_SEC * 2;

  useEffect(() => {
    if (!visible) { setPlaying(false); return; }
    setStickers(initial);
    setEditingId(null);
    setSelectedId(null);
    setEmojiOpen(false);
    setText('');
    setPlaybackPosition(CLOCK_ID, windowStart);
    // Starts as soon as the copy is ready — AppVideo autoplays when it mounts.
    setPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Which captions show at the playhead. Changes only when one enters or leaves,
  // so the player's ticks do not re-render the editor.
  const subscribe = useCallback((cb: () => void) => subscribePlayback(CLOCK_ID, cb), []);
  const visKey = useSyncExternalStore(subscribe, () => visibleKey(stickers, getPlaybackPosition(CLOCK_ID)));
  // The selected caption stays on screen outside its window, so it can still be
  // found and moved while its timing is being set.
  const shown = useMemo(
    () => (canTime ? stickers.filter((s, i) => s.id === selectedId || visKey.includes(`|${i}|`)) : stickers),
    [canTime, stickers, selectedId, visKey],
  );

  const selected = stickers.find((s) => s.id === selectedId) ?? null;
  const selectedWindow = selected && canTime ? resolveWindow(selected, windowStart, windowEnd) : null;
  const wholeVideo = !!selectedWindow && selectedWindow.start <= windowStart && selectedWindow.end >= windowEnd;
  const atMax = stickers.length >= MAX_STICKERS;

  const clampY = (y: number) => Math.min(SAFE_BOTTOM / SCREEN_H, Math.max(SAFE_TOP / SCREEN_H, y));
  // Time-stamped: a draft restored in a later session brings back captions whose
  // ids a counter restarting at 0 would hand out again.
  const newId = () => `vc${Date.now().toString(36)}${idRef.current++}`;
  const timingHere = () => (canTime ? timingForNew(getPlaybackPosition(CLOCK_ID), windowStart, windowEnd) : {});

  function addStickerAt(xNorm: number, yNorm: number) {
    if (atMax) return;
    const id = newId();
    setStickers((prev) => [...prev, {
      id, text: '', x: Math.min(0.9, Math.max(0.1, xNorm)), y: clampY(yNorm),
      scale: 1, rotation: 0, font, color, bg, size: 26, ...timingHere(),
    }]);
    setEditingId(id);
    setSelectedId(id);
    setEmojiOpen(false);
    setText('');
    // Typing over a moving frame is hard; ▶ picks it back up.
    setPlaying(false);
  }

  function addEmoji(emoji: string) {
    if (atMax) return;
    const id = newId();
    setStickers((prev) => [...prev, {
      id, text: emoji, emoji: true, x: 0.5, y: clampY(0.42), scale: 1, rotation: 0, ...timingHere(),
    }]);
    setSelectedId(id);
    setEmojiOpen(false);
  }

  function editSticker(id: string) {
    const s = stickers.find((k) => k.id === id);
    if (!s) return;
    setSelectedId(id);
    setEmojiOpen(false);
    if (s.emoji) return; // emoji are placed and timed, not typed
    setFont(s.font ?? 'classic');
    setColor(s.color ?? '#FFFFFF');
    setBg(s.bg ?? 'none');
    setText(s.text);
    setEditingId(id);
    setPlaying(false);
  }

  function manipulateSticker(id: string, style: CaptionStyle) {
    setStickers((prev) => prev.map((s) => (s.id === id ? { ...s, ...style, y: clampY(style.y) } : s)));
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
    setPlaybackPosition(CLOCK_ID, sec);
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

  function done() {
    onSave(stickers.filter((s) => s.text.trim()).map((s) => ({ ...s, text: s.text.trim() })));
  }

  const preview = resolveSticker({ font, color, bg, size: 26 });
  const bottomReserve = canTime ? TIMELINE_H + insets.bottom : insets.bottom + 8;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal is its own native root, so the app's root touch observer may not
          see these touches. Report them directly: an editing session is presence,
          and the clip behind the captions must not stop repeating mid-edit. */}
      <View style={styles.root} onTouchStart={markInteraction}>
        {canPlay ? (
          <AppVideo
            ref={videoRef}
            source={{ uri: playUri! }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            active={visible && playing}
            loop
            muted={false}
            ignoreSuspend
            poster={posterUri}
            posterContentFit="cover"
            trimStartSec={windowStart > 0 ? windowStart : null}
            trimEndSec={canTime ? windowEnd : null}
            progressIntervalMs={100}
            onProgress={(ms) => setPlaybackPosition(CLOCK_ID, ms / 1000)}
            // A local copy that fails will fail the same way on every retry.
            retryLoadErrors={false}
            onLoadError={(message) => {
              // eslint-disable-next-line no-console
              if (__DEV__) console.log(`[caption-editor] clip failed to load: ${message}`);
              setClipFailed(true);
            }}
          />
        ) : posterUri ? (
          <ExpoImage source={{ uri: posterUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.videoGhost]}>
            <Ionicons name="videocam-outline" size={34} color="rgba(255,255,255,0.3)" />
          </View>
        )}
        {preparing && !canPlay && !clipFailed && (
          <View style={[StyleSheet.absoluteFill, styles.preparing]} pointerEvents="none">
            <ActivityIndicator color="#fff" />
          </View>
        )}

        {/* Reserved-area ghosts so the safe band is tangible. */}
        <View style={[styles.reserveGhost, { top: 0, height: SAFE_TOP }]} pointerEvents="none" />
        {!canTime && (
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
          onTapEmpty={(x, y) => { if (emojiOpen) setEmojiOpen(false); else addStickerAt(x, y); }}
          onDragActive={(a) => { setDragActive(a); if (!a) setOverTrash(false); }}
          onDragMove={(x, y) => { const over = inTrash(x, y); setOverTrash((p) => (p === over ? p : over)); }}
          onRelease={onStickerRelease}
        />

        {/* Trash target (only while dragging — the timeline steps aside for it). */}
        {dragActive && (
          <View style={[styles.trashZone, { bottom: insets.bottom + 40 }]} pointerEvents="none">
            <View style={[styles.trashCircle, overTrash && styles.trashCircleHot]}>
              <Ionicons name="trash" size={22} color="#fff" />
            </View>
          </View>
        )}

        {/* Top bar (hidden while typing so the overlay owns the screen). */}
        {!editingId && (
          <>
            <View style={[styles.topBar, { top: insets.top + 8 }]}>
              <TouchableOpacity style={styles.barBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                style={[styles.addBtn, atMax && styles.disabled]}
                disabled={atMax}
                onPress={() => addStickerAt(0.5, 0.3)}
              >
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.addText}>{t('topcap.textBtn')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.barBtn, emojiOpen && styles.barBtnActive, atMax && styles.disabled]}
                disabled={atMax}
                onPress={() => setEmojiOpen((o) => !o)}
                accessibilityRole="button"
                accessibilityLabel={t('a11y.addEmoji')}
              >
                <Ionicons name="happy-outline" size={22} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={done}>
                <Text style={styles.saveText}>{t('topcap.save')}</Text>
              </TouchableOpacity>
            </View>
            {stickers.length === 0 && !emojiOpen && !dragActive && (
              <Text style={[styles.hint, { bottom: bottomReserve + 16 }]}>{t('topcap.tapHint')}</Text>
            )}
          </>
        )}

        {emojiOpen && !editingId && !dragActive && (
          <View style={[styles.emojiTray, { bottom: bottomReserve + 10 }]}>
            {EMOJIS.map((e) => (
              <TouchableOpacity key={e} style={styles.emojiCell} onPress={() => addEmoji(e)} accessibilityRole="button" accessibilityLabel={e}>
                <Text style={styles.emojiText}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {canTime && !editingId && !dragActive && (
          <StickerTimeline
            clockId={CLOCK_ID}
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
                  selectionColor="#FAB525"
                  cursorColor="#FAB525"
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

const EMOJI_CELL = Math.floor((SCREEN_W - 24 - 16) / 8);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  videoGhost: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#101010' },
  preparing: { alignItems: 'center', justifyContent: 'center' },
  reserveGhost: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.18)' },
  reelGhost: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, opacity: 0.4 },
  ghostMeta: { position: 'absolute', left: 16, bottom: 58, gap: 9 },
  ghostLine: { height: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.3)' },
  ghostRail: { position: 'absolute', right: 14, bottom: 96, gap: 22, alignItems: 'center' },
  ghostDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.25)' },
  ghostScrub: { position: 'absolute', left: 0, right: 0, bottom: 12, height: 3, backgroundColor: 'rgba(255,255,255,0.28)' },
  topBar: { position: 'absolute', left: 10, right: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  barBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  barBtnActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  addText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  saveBtn: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9 },
  saveText: { color: '#111', fontSize: 14, fontWeight: '800' },
  hint: { position: 'absolute', left: 24, right: 24, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  emojiTray: {
    position: 'absolute', left: 12, right: 12, flexDirection: 'row', flexWrap: 'wrap',
    padding: 8, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.72)',
  },
  emojiCell: { width: EMOJI_CELL, height: EMOJI_CELL, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 28 },
  trashZone: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  trashCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  trashCircleHot: { backgroundColor: '#F43F5E', transform: [{ scale: 1.2 }] },
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
