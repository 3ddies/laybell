import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import AppVideo, { type AppVideoHandle } from './AppVideo';
import { fetchSourcePost, type SourcePost, type CompositionKind } from '../lib/composition';
import { RADIUS, type ThemePalette } from '../constants/theme';
import { useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';

// AUDIO — STUDIO model: while recording, the original is MUTED (you watch it), so
// your clip carries only your voice — no speaker bleed. Here at playback we add the
// CLEAN original, ducked to SOURCE_DUCK under your voice, for both video and song
// (the song rides a hidden audio player). The original is therefore heard exactly
// once — no doubling/echo — with no headphones required. (Add mode is sequential —
// the crop then your clip — so it never overlaps and isn't ducked.)
const SOURCE_DUCK = 0.45;

// Longest the original crop can be (mirrors the composer's SOURCE_CROP_MAX): the
// fallback ceiling used when an add post carries no explicit crop end and we can't
// learn the source's real duration.
const ADD_CROP_FALLBACK_SEC = 60;

// Plays a Remix composed at PLAYBACK (lib/composition):
//   COMMENTARY layouts — your clip and the original play together:
//     side_by_side — beside each other.
//     top_bottom   — stacked.
//     pip          — the original as a small window over your full-screen clip.
//     green_screen — RESERVED (native); falls back to pip here as a safety net.
//   ADD ('add')   — the original plays FIRST (cropped via sourceTrim*), then your
//                   clip, in turn, looping — see AddCompositionPlayer.
//
// Your clip is always available (it's this post's media_url); the original is
// fetched. If it's gone/private, this degrades to just your clip.
//
// forwardRef exposes a `seek` (AppVideoHandle) so the reel's scrub bar can
// fast-forward/rewind a reaction. For commentary it drives YOUR clip (the master),
// and the original resyncs; for add it seeks along the single stitched timeline.
type CompositionPlayerProps = {
  clipUri: string;
  kind: CompositionKind;
  sourcePostId: string | null;
  sourceTrimStart?: number | null;
  sourceTrimEnd?: number | null;
  // Your clip's own length (posts.duration_seconds). Add mode uses it to know the
  // stitched timeline's total BEFORE your clip has played a frame, so the reel scrub
  // bar shows the right total from the first tick (no mid-play jump).
  clipDurationSec?: number | null;
  active: boolean;
  clipPoster?: string | null;
  style?: StyleProp<ViewStyle>;
  // Feed/reel: mute your clip for muted autoplay, 'pause' at idle so a composition
  // can't hold the screen awake, and report progress for view tracking. The post
  // viewer leaves these unset (your clip heard, finish-pass idle).
  muted?: boolean;
  idleBehavior?: 'pause' | 'finishPass';
  onProgress?: (positionMs: number, durationMs: number) => void;
  // The player's own overlays (the "Reacting to @x" credit). ON in the post viewer;
  // OFF in the feed/reel, which draw their own React badge — so nothing collides.
  chrome?: boolean;
  // Reposition the pip mini-window (default bottom-right). The reel passes a top
  // corner so it clears the action rail.
  pipStyle?: StyleProp<ViewStyle>;
};

const CompositionPlayer = forwardRef<AppVideoHandle, CompositionPlayerProps>(function CompositionPlayer({
  clipUri, kind, sourcePostId, sourceTrimStart, sourceTrimEnd, clipDurationSec, active, clipPoster, style,
  muted = false, idleBehavior, onProgress, chrome = true, pipStyle,
}, ref) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [source, setSource] = useState<SourcePost | null>(null);
  // Whether the source fetch has RESOLVED (so a null source means "gone/private",
  // not merely "still loading"). Used to keep the layout stable while loading.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    // Clear any prior source (FlashList recycles feed cards to new posts) so we never
    // flash the previous post's original, and mark unresolved until the fetch returns.
    setSource(null);
    setLoaded(false);
    if (!sourcePostId) { setLoaded(true); return; }
    fetchSourcePost(sourcePostId)
      .then((s) => { if (alive) { setSource(s); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [sourcePostId]);

  // The reaction (your clip) is the MASTER for the COMMENTARY layouts (they play
  // together); the original follows it. Crucially we realign it ONLY at two discrete
  // moments and let it run free in between:
  //   • when the original first becomes ready (it loads slower than your clip), jump
  //     it to where the reaction already is — kills the cold-start offset;
  //   • when the reaction LOOPS (its position jumps backward), snap the original back
  //     with it so the loop is seamless.
  // We do NOT re-seek every tick to "correct drift": both clips play at 1× and hold
  // sync on their own, and the two players report their positions ~a tick apart, so a
  // per-tick comparison almost always looked out of sync and re-seeked the original
  // constantly — which is exactly what made the video and audio choppy. One seek per
  // loop keeps it smooth AND keeps a long original from streaming past the reaction's
  // length (Cloudflare delivery stays proportional to the reaction).
  const sourceRef = useRef<AppVideoHandle>(null);
  const ownRef = useRef<AppVideoHandle>(null);
  // add mode owns its own stitched-timeline seek (both clips, one line).
  const addRef = useRef<AppVideoHandle>(null);
  const ownPosMs = useRef(0);
  const lastOwnPos = useRef(0);
  const resyncSource = useCallback((ownMs: number) => { sourceRef.current?.seek(Math.max(0, ownMs) / 1000); }, []);
  const onOwnProgress = useCallback((pos: number, dur: number) => {
    ownPosMs.current = pos;
    if (pos < lastOwnPos.current - 400) resyncSource(pos); // reaction looped → realign once
    lastOwnPos.current = pos;
    onProgress?.(pos, dur);
  }, [onProgress, resyncSource]);
  // Align the original to the reaction the moment it can play; after that they run
  // together untouched.
  const onSourceReady = useCallback(() => { resyncSource(ownPosMs.current); }, [resyncSource]);

  // One external seek handle: add seeks the stitched timeline, everything else
  // scrubs your clip (the master) and the original resyncs.
  useImperativeHandle(ref, () => ({
    seek: (sec: number) => {
      if (kind === 'add') addRef.current?.seek(sec);
      else ownRef.current?.seek(sec);
    },
  }), [kind]);

  // "Reacting to @creator" — shown once the source loads (post viewer only).
  const who = source ? (source.username ? `@${source.username}` : (source.displayName ?? t('remix.theCreator'))) : null;
  const credit = (chrome && who) ? (
    <View style={styles.credit} pointerEvents="none">
      <Text style={styles.creditText} numberOfLines={1}>{t('remix.credit', { user: who })}</Text>
    </View>
  ) : null;

  const ownClip = (fit: 'cover' | 'contain', s: StyleProp<ViewStyle>) => (
    <AppVideo ref={ownRef} source={{ uri: clipUri }} style={s} contentFit={fit} active={active} loop
      muted={muted} ownsAudio={!muted} idleBehavior={idleBehavior} onProgress={onOwnProgress} poster={clipPoster} />
  );
  // The original, ducked under your voice (recorded muted, so this is clean). It
  // FOLLOWS the reaction: aligned on load (onReady) and on the reaction's loop
  // (onOwnProgress). No onProgress here — it doesn't need per-tick events, and not
  // emitting them keeps this second player light so playback stays smooth.
  const sourceClip = (fit: 'cover' | 'contain', s: StyleProp<ViewStyle>) => (
    source?.mediaUrl ? (
      <AppVideo ref={sourceRef} source={{ uri: source.mediaUrl }} style={s} contentFit={fit} active={active} loop
        muted={muted} volume={muted ? 0 : SOURCE_DUCK} ownsAudio={!muted} idleBehavior={idleBehavior}
        onReady={onSourceReady} poster={source.thumbnailUrl} />
    ) : <View style={s} />
  );

  // Your clip on its own, full-screen — ONLY when the original is genuinely gone
  // (the fetch resolved with nothing: private/deleted), and while an ADD sequence
  // waits for the original it can't compose without. We deliberately do NOT fall
  // back here while merely LOADING a corner layout: those render their final shape
  // from the first frame (your clip already in its final spot), with the source slot
  // filling in when it arrives — so nothing rearranges or remounts when the original
  // loads. That remount was the "frozen still, then it snaps into the template" hitch.
  if ((loaded && !source?.mediaUrl) || (kind === 'add' && !source?.mediaUrl)) {
    return <View style={[styles.full, style]}>{ownClip('cover', StyleSheet.absoluteFill)}</View>;
  }

  // React to a SONG: your video full-screen + the CLEAN track ducked under your
  // voice (a song has no video frame, so it plays through a hidden audio player) +
  // its cover art. Same master-loop resync as video. (Null-safe: while loading, a
  // song post — stored as 'pip' — shows the pip layout, then swaps to this once the
  // source resolves as audio; your clip stays full-screen either way, so it doesn't
  // remount.)
  if (source?.isAudio) {
    return (
      <View style={[styles.full, style]}>
        {ownClip('cover', StyleSheet.absoluteFill)}
        <AppVideo
          ref={sourceRef}
          source={{ uri: source.mediaUrl }}
          style={styles.hiddenAudio}
          active={active}
          loop
          muted={muted}
          volume={muted ? 0 : SOURCE_DUCK}
          ownsAudio={!muted}
          idleBehavior={idleBehavior}
          onReady={onSourceReady}
        />
        {source.coverUrl ? (
          <View style={styles.songCard} pointerEvents="none">
            <ExpoImage source={{ uri: source.coverUrl }} style={styles.songCardArt} contentFit="cover" cachePolicy="memory-disk" />
            <Ionicons name="musical-notes" size={13} color="#fff" />
          </View>
        ) : null}
        {credit}
      </View>
    );
  }

  // ADD: the original crop, then your clip, on ONE stitched timeline that the reel
  // scrub bar can seek across. Delegated to a self-contained player.
  if (kind === 'add') {
    return (
      <AddCompositionPlayer
        ref={addRef}
        clipUri={clipUri}
        clipPoster={clipPoster}
        clipDurationSec={clipDurationSec}
        source={source!} /* guard above returns for add when source is missing */
        sourceTrimStart={sourceTrimStart}
        sourceTrimEnd={sourceTrimEnd}
        active={active}
        muted={muted}
        idleBehavior={idleBehavior}
        onProgress={onProgress}
        fullStyle={[styles.full, style]}
        credit={credit}
      />
    );
  }

  // pip_flip: the ORIGINAL full-screen, YOUR reaction in the small top-right window.
  // (Your reaction still carries the primary audio; the original is ducked under it.)
  if (kind === 'pip_flip') {
    return (
      <View style={[styles.full, style]}>
        {sourceClip('cover', StyleSheet.absoluteFill)}
        <View style={[styles.pip, pipStyle]}>{ownClip('cover', StyleSheet.absoluteFill)}</View>
        {credit}
      </View>
    );
  }

  // pip (default — also the fallback for green_screen and any retired layout):
  // YOUR reaction full-screen, the ORIGINAL in the small top-right window.
  return (
    <View style={[styles.full, style]}>
      {ownClip('cover', StyleSheet.absoluteFill)}
      <View style={[styles.pip, pipStyle]}>{sourceClip('cover', StyleSheet.absoluteFill)}</View>
      {credit}
    </View>
  );
});

export default CompositionPlayer;

// ── ADD mode: two clips, one stitched timeline ───────────────────────────────
// The original's selected crop plays first, then your clip, then it loops. Both
// clips stay MOUNTED (only the active phase plays and is visible), which is what
// lets a single scrub bar fast-forward/rewind ACROSS the boundary: a seek picks
// the phase and lands the playhead inside it. Progress is reported on the stitched
// line — [0 … cropLen] is the original, [cropLen … cropLen+ownLen] is your clip —
// so the reel's bar sees one continuous timeline with a real total duration.
type AddProps = {
  clipUri: string;
  clipPoster?: string | null;
  clipDurationSec?: number | null;
  source: SourcePost;
  sourceTrimStart?: number | null;
  sourceTrimEnd?: number | null;
  active: boolean;
  muted: boolean;
  idleBehavior?: 'pause' | 'finishPass';
  onProgress?: (positionMs: number, durationMs: number) => void;
  fullStyle: StyleProp<ViewStyle>;
  credit: React.ReactNode;
};

const AddCompositionPlayer = forwardRef<AppVideoHandle, AddProps>(function AddCompositionPlayer({
  clipUri, clipPoster, clipDurationSec, source, sourceTrimStart, sourceTrimEnd, active, muted, idleBehavior, onProgress, fullStyle, credit,
}, ref) {
  const styles = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<'source' | 'own'>('source');
  const sourceRef = useRef<AppVideoHandle>(null);
  const ownRef = useRef<AppVideoHandle>(null);

  const cropStart = Math.max(0, sourceTrimStart ?? 0);
  // The crop's end: the explicit trim, else the source's known length, else learned
  // live from the source's own progress (older posts with neither), capped so a
  // trimless add can't fall back to streaming an entire long original.
  const explicitEnd = sourceTrimEnd != null
    ? sourceTrimEnd
    : (source.durationSec && source.durationSec > 0 ? Math.min(source.durationSec, cropStart + ADD_CROP_FALLBACK_SEC) : null);
  const cropEndRef = useRef<number>(explicitEnd ?? cropStart + ADD_CROP_FALLBACK_SEC);
  cropEndRef.current = explicitEnd ?? cropEndRef.current;
  // Seed your clip's length from the stored duration so the stitched total is right
  // from the first tick (your clip is paused during the crop, so it can't report it
  // yet); the live value from playback refines it.
  const ownDurMsRef = useRef(clipDurationSec && clipDurationSec > 0 ? clipDurationSec * 1000 : 0);

  const cropLenMs = useCallback(() => Math.max(0, cropEndRef.current - cropStart) * 1000, [cropStart]);
  const totalDurMs = useCallback(() => cropLenMs() + ownDurMsRef.current, [cropLenMs]);

  // Advance the crop → your clip; loop your clip → the crop. Each seeks the target
  // to its start so a paused-and-reactivated clip resumes cleanly.
  const goOwn = useCallback(() => { setPhase('own'); ownRef.current?.seek(0); }, []);
  const goSource = useCallback(() => { setPhase('source'); sourceRef.current?.seek(cropStart); }, [cropStart]);

  const onSrcProgress = useCallback((posMs: number, durMs: number) => {
    // Learn the real length only when we had no explicit end AND no stored duration.
    if (explicitEnd == null && durMs > 0) cropEndRef.current = Math.min(durMs / 1000, cropStart + ADD_CROP_FALLBACK_SEC);
    onProgress?.(Math.max(0, posMs - cropStart * 1000), totalDurMs());
    if (posMs / 1000 >= cropEndRef.current - 0.05) goOwn();
  }, [explicitEnd, cropStart, onProgress, totalDurMs, goOwn]);

  const onOwnProgress = useCallback((posMs: number, durMs: number) => {
    if (durMs > 0) ownDurMsRef.current = durMs;
    onProgress?.(cropLenMs() + posMs, totalDurMs());
  }, [onProgress, cropLenMs, totalDurMs]);

  // Seek anywhere on the stitched line: before cropLen lands in the original crop,
  // after it lands in your clip.
  useImperativeHandle(ref, () => ({
    seek: (sec: number) => {
      const tMs = Math.max(0, sec * 1000);
      if (tMs < cropLenMs()) {
        setPhase('source');
        sourceRef.current?.seek(cropStart + tMs / 1000);
      } else {
        setPhase('own');
        ownRef.current?.seek((tMs - cropLenMs()) / 1000);
      }
    },
  }), [cropStart, cropLenMs]);

  // Leaving the screen restarts the sequence from the original's crop start.
  useEffect(() => {
    if (!active) { setPhase('source'); sourceRef.current?.seek(cropStart); ownRef.current?.seek(0); }
  }, [active, cropStart]);

  return (
    <View style={fullStyle}>
      <AppVideo
        ref={sourceRef}
        source={{ uri: source.mediaUrl }}
        style={[StyleSheet.absoluteFill, phase !== 'source' && styles.hiddenPane]}
        contentFit="cover"
        active={active && phase === 'source'}
        loop={false}
        muted={muted}
        ownsAudio={!muted}
        idleBehavior={idleBehavior}
        poster={source.thumbnailUrl}
        trimStartSec={cropStart > 0 ? cropStart : null}
        onProgress={onSrcProgress}
        onEnd={goOwn}
      />
      <AppVideo
        ref={ownRef}
        source={{ uri: clipUri }}
        style={[StyleSheet.absoluteFill, phase !== 'own' && styles.hiddenPane]}
        contentFit="cover"
        active={active && phase === 'own'}
        loop={false}
        muted={muted}
        ownsAudio={!muted}
        idleBehavior={idleBehavior}
        poster={clipPoster}
        onProgress={onOwnProgress}
        onEnd={goSource}
      />
      {credit}
    </View>
  );
});

const makeStyles = (_c: ThemePalette) => StyleSheet.create({
  full: { flex: 1, backgroundColor: '#000', borderRadius: RADIUS.md, overflow: 'hidden' },
  // The small corner window (the original in pip, your reaction in pip_flip). Sits in
  // the TOP-RIGHT, dropped below the video's top-right mute button so they don't
  // overlap. The reel overrides the exact top via `pipStyle` to clear its own chrome.
  pip: {
    position: 'absolute', right: 10, top: 48, width: '32%', aspectRatio: 9 / 16,
    borderRadius: 12, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.5)',
  },
  // The add clip that isn't the active phase: kept mounted (so a seek can cross into
  // it instantly) but hidden and paused.
  hiddenPane: { opacity: 0 },
  hiddenAudio: { position: 'absolute', width: 2, height: 2, opacity: 0, top: 0, left: 0 },
  songCard: {
    position: 'absolute', left: 10, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 5, paddingRight: 10,
  },
  songCardArt: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#333' },
  credit: {
    position: 'absolute', left: 10, top: 10,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 5, maxWidth: '70%',
  },
  creditText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
