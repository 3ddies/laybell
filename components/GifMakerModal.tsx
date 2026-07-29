import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Alert, Platform, useWindowDimensions, Animated, Easing, Image as RNImage } from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView, PinchGestureHandler, PanGestureHandler, State } from 'react-native-gesture-handler';
import * as FileSystem from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useMediaSuspend } from '../contexts/MediaSuspendContext';
import { usePostMusicActions } from '../contexts/PostMusicContext';
import { uploadToStorageWithProgress } from '../lib/upload';
import { makeGifFromVideo, type GifResult, type GifCrop } from '../lib/makeGif';
import { isCfStreamHls, cfStreamFrameUrl } from '../lib/cast';
import { addUserGif } from '../lib/userGifs';
import AppVideo from './AppVideo';
import GifTrimBar from './GifTrimBar';
import GifProgressRing from './GifProgressRing';

// "Make GIF" — TikTok-style, from an existing Laybell video. Live-loops the
// selected window inside a SQUARE crop frame; pinch-zoom + drag to reframe;
// drag the trim bar's edges to set duration; renders a smooth square GIF, then
// Post / add to My GIFs / Save.
const GIF_MAX_SEC = 3;
const GIF_MIN_SEC = 0.5;

export default function GifMakerModal({
  visible, videoUrl, durationSec, userId, sourcePostId, onClose, inOverlay,
}: {
  visible: boolean;
  videoUrl: string | null;
  durationSec: number | null;
  userId: string | null;
  sourcePostId?: string | null;
  onClose: () => void;
  inOverlay?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width: SCREEN_W } = useWindowDimensions();
  const { suspend, resume } = useMediaSuspend();
  const { stop: stopPostMusic } = usePostMusicActions();

  // While the maker is open, pause the post's video/audio playing behind it (and
  // the ambient attached song), so nothing bleeds through. Resume on close.
  useEffect(() => {
    if (!visible) return;
    stopPostMusic();
    suspend();
    return () => resume();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const [localUri, setLocalUri] = useState<string | null>(null);
  const [vidW, setVidW] = useState(1);
  const [vidH, setVidH] = useState(1);
  const [loadingVideo, setLoadingVideo] = useState(true);
  const [start, setStart] = useState(0);
  const [loopStart, setLoopStart] = useState(0);
  const [gifDur, setGifDur] = useState(GIF_MAX_SEC);
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<GifResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'lib' | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  // Themed in-modal toast (replaces the system Alert for Export / Save results).
  const [flash, setFlash] = useState<{ tone: 'success' | 'error'; title: string; body?: string } | null>(null);
  const flashA = useRef(new Animated.Value(0)).current;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showFlash(f: { tone: 'success' | 'error'; title: string; body?: string }) {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(f);
    flashA.setValue(0);
    Animated.timing(flashA, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    flashTimer.current = setTimeout(() => {
      Animated.timing(flashA, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setFlash(null));
    }, f.tone === 'error' ? 2600 : 1900);
  }
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const dur = durationSec && durationSec > 0 ? durationSec : 15;
  // Cloudflare Stream source → frames come from CF's thumbnail endpoint (HLS
  // can't be frame-grabbed on-device). Height 640 for render frames; a smaller
  // one drives the trim strip.
  const isCf = !!videoUrl && isCfStreamHls(videoUrl);
  // Memoized (stable identity) — the render frame provider (height 640) and a
  // smaller one for the trim strip (160). Stable so the trim bar's frame effect
  // doesn't re-run every render.
  const cfFrameAt = useMemo(
    () => (isCf && videoUrl ? (timeSec: number) => cfStreamFrameUrl(videoUrl, timeSec, 640) : null),
    [isCf, videoUrl],
  );
  const cfStripAt = useMemo(
    () => (isCf && videoUrl ? (timeSec: number) => cfStreamFrameUrl(videoUrl, timeSec, 160) : undefined),
    [isCf, videoUrl],
  );

  // Square crop frame; the video is sized to its natural aspect so its short side
  // fills the frame and the long side overflows (pannable). See computeCrop.
  const FS = Math.min(SCREEN_W - SPACING.md * 2, 300);
  const minSide = Math.min(vidW, vidH) || 1;
  const c = FS / minSide;               // source→screen scale for cover-on-short-axis
  const VW = vidW * c;
  const VH = vidH * c;

  // ── Crop / zoom transform ───────────────────────────────────────────────────
  // Driven DIRECTLY from the gesture events (each event sets the absolute value)
  // rather than via Animated.event/multiply — that binding felt unresponsive
  // ("had to pinch really hard"). Committed values live in refs; the gesture
  // computes from the value captured at its start (startScale/startTx/startTy).
  const scaleV = useRef(new Animated.Value(1)).current;
  const txV = useRef(new Animated.Value(0)).current;
  const tyV = useRef(new Animated.Value(0)).current;
  const scaleNum = useRef(1);
  const txNum = useRef(0);
  const tyNum = useRef(0);
  const startScale = useRef(1);
  const startTx = useRef(0);
  const startTy = useRef(0);
  // Render progress 0→1, animated on the NATIVE driver so the border ring stays
  // smooth even while the JS thread is busy encoding frames.
  const progressA = useRef(new Animated.Value(0)).current;
  const lastProgAt = useRef(0); // timestamp of the last progress tick (for pacing)
  const dims = useRef({ FS, VW, VH });
  dims.current = { FS, VW, VH };
  const pinchRef = useRef<any>(null);
  const panRef = useRef<any>(null);

  function maxOffset(s: number) {
    const { FS: f, VW: vw, VH: vh } = dims.current;
    return { x: Math.max(0, (vw * s - f) / 2), y: Math.max(0, (vh * s - f) / 2) };
  }
  function applyTranslate(nx: number, ny: number, s: number) {
    const m = maxOffset(s);
    txNum.current = Math.max(-m.x, Math.min(m.x, nx));
    tyNum.current = Math.max(-m.y, Math.min(m.y, ny));
    txV.setValue(txNum.current); tyV.setValue(tyNum.current);
  }
  function resetTransform() {
    scaleNum.current = 1; txNum.current = 0; tyNum.current = 0;
    scaleV.setValue(1); txV.setValue(0); tyV.setValue(0);
  }
  function onPinchEvent(e: any) {
    const s = Math.max(1, Math.min(3, startScale.current * e.nativeEvent.scale));
    scaleNum.current = s;
    scaleV.setValue(s);
    applyTranslate(txNum.current, tyNum.current, s); // re-clamp as we zoom out
  }
  function onPinchState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) startScale.current = scaleNum.current;
  }
  function onPanEvent(e: any) {
    applyTranslate(startTx.current + e.nativeEvent.translationX, startTy.current + e.nativeEvent.translationY, scaleNum.current);
  }
  function onPanState(e: any) {
    if (e.nativeEvent.state === State.BEGAN) { startTx.current = txNum.current; startTy.current = tyNum.current; }
  }

  // Map the on-screen transform to a SQUARE source-pixel crop.
  function computeCrop(): GifCrop {
    const s = scaleNum.current;
    const { FS: f } = dims.current;
    const cropSide = minSide / s;
    let originX = vidW / 2 - minSide / (2 * s) - (txNum.current * minSide) / (f * s);
    let originY = vidH / 2 - minSide / (2 * s) - (tyNum.current * minSide) / (f * s);
    originX = Math.max(0, Math.min(vidW - cropSide, originX));
    originY = Math.max(0, Math.min(vidH - cropSide, originY));
    return { originX, originY, width: cropSide, height: cropSide };
  }

  useEffect(() => { const id = setTimeout(() => setLoopStart(start), 90); return () => clearTimeout(id); }, [start]);

  useEffect(() => {
    if (!visible || !videoUrl) return;
    let active = true;
    (async () => {
      setLoadingVideo(true); setLocalUri(null); setResult(null); setUploadedUrl(null); setStart(0); setLoopStart(0); setGifDur(GIF_MAX_SEC);
      resetTransform();
      try {
        // Cloudflare Stream (and any HLS) media_url is a .m3u8 MANIFEST — downloading
        // it just saves the playlist text, not the video, so the preview + every
        // frame extraction end up on a broken local file (black screen). expo-video
        // and expo-video-thumbnails both handle HLS URLs directly (the feed plays
        // these exact URLs), so use the URL as-is for HLS. Only DIRECT mp4s (legacy
        // posts) get downloaded, for faster local frame seeking.
        const isHls = /\.m3u8(\?|$)/i.test(videoUrl) || videoUrl.includes('cloudflarestream.com');
        const src = isHls
          ? videoUrl
          : (await FileSystem.downloadAsync(videoUrl, `${FileSystem.cacheDirectory}gifsrc_${Date.now()}.mp4`)).uri;
        if (!active) return;
        try {
          // Dimensions drive the crop math, so they must match the frames we
          // extract. CF: measure a CF thumbnail (same source as the render
          // frames). Local mp4: probe the file.
          const cf0 = isCf && videoUrl ? cfStreamFrameUrl(videoUrl, 0, 640) : null;
          if (cf0) {
            const size = await new Promise<{ w: number; h: number }>((res, rej) =>
              RNImage.getSize(cf0, (w, h) => res({ w, h }), rej));
            if (active && size.w && size.h) { setVidW(size.w); setVidH(size.h); }
          } else {
            const probe = await VideoThumbnails.getThumbnailAsync(src, { time: 0, quality: 0.3 });
            if (active && probe.width && probe.height) { setVidW(probe.width); setVidH(probe.height); }
          }
        } catch { /* keep defaults */ }
        if (active) setLocalUri(src);
      } catch {
        if (active) { Alert.alert(t('gif.make.loadFailed')); onClose(); }
      }
      if (active) setLoadingVideo(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, videoUrl]);

  async function render() {
    if (!localUri || rendering) return;
    setRendering(true); setProgress(0); setUploadedUrl(null);
    progressA.setValue(0);
    lastProgAt.current = 0;
    // Keep the ring CONTINUOUSLY flowing: animate to each frame's progress over a
    // duration a bit LONGER than the last frame took, so the animation is still
    // moving when the next tick arrives (no finish-then-wait stutter). It only
    // pauses if a frame genuinely stalls longer than expected.
    const onProg = (f: number) => {
      setProgress(f);
      const now = Date.now();
      const dt = lastProgAt.current ? now - lastProgAt.current : 300;
      lastProgAt.current = now;
      Animated.timing(progressA, { toValue: f, duration: Math.max(140, dt * 1.6), easing: Easing.linear, useNativeDriver: true }).start();
    };
    try {
      const gif = await makeGifFromVideo(
        localUri,
        { startMs: Math.round(start * 1000), durationMs: Math.round(Math.min(gifDur, dur) * 1000), fps: 12, width: 288, crop: computeCrop(), cfFrameUrl: cfFrameAt },
        onProg,
      );
      // Ensure the ring visibly completes before revealing the result.
      Animated.timing(progressA, { toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
      setResult(gif);
    } catch {
      Alert.alert(t('gif.make.failedTitle'), t('gif.make.failedBody'));
    }
    setRendering(false);
  }

  // Upload the rendered GIF once; Post + Add-to-library reuse the same URL.
  async function ensureUploaded(): Promise<string | null> {
    if (uploadedUrl) return uploadedUrl;
    if (!result || !userId) return null;
    const url = await uploadToStorageWithProgress('posts', userId, result.uri, 'gif', 'image/gif');
    setUploadedUrl(url);
    return url;
  }

  async function addToLibrary() {
    if (!result || !userId || busy) return;
    setBusy('lib');
    try {
      const url = await ensureUploaded();
      if (!url) throw new Error('upload failed');
      const err = await addUserGif(userId, { url, w: result.width, h: result.height, kind: 'created', sourcePostId: sourcePostId || undefined });
      if (err) { showFlash({ tone: 'error', title: t('gif.make.addFailed'), body: err }); setBusy(null); return; }
      showFlash({ tone: 'success', title: t('gif.make.addedTitle'), body: t('gif.make.addedBody') });
    } catch (e: any) {
      showFlash({ tone: 'error', title: t('gif.make.addFailed'), body: e?.message || undefined });
    }
    setBusy(null);
  }

  async function saveToDevice() {
    if (!result || busy) return;
    setBusy('save');
    try {
      const MediaLibrary = await import('expo-media-library');
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) { setBusy(null); return; }
      await MediaLibrary.saveToLibraryAsync(result.uri);
      showFlash({ tone: 'success', title: t('gif.make.savedTitle'), body: t('gif.make.savedBody') });
    } catch {
      showFlash({ tone: 'error', title: t('gif.make.saveFailed') });
    }
    setBusy(null);
  }

  // NOTE: deliberately no `if (!visible) return null` here. The <Modal> below
  // plays its own dismissal animation and needs to stay mounted through it;
  // bailing on `visible` would tear the window down instantly instead.
  const content = (
    <GestureHandlerRootView style={styles.container}>
      <View style={{ paddingTop: insets.top + SPACING.sm }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={t('a11y.back')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('gif.make.title')}</Text>
          <View style={{ width: 26 }} />
        </View>
      </View>

      {loadingVideo || !localUri ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.hint}>{t('gif.make.loadingVideo')}</Text>
        </View>
      ) : result ? (
        <View style={styles.center}>
          <Image source={{ uri: result.uri }} style={{ width: Math.min(SCREEN_W - SPACING.md * 2, 300), height: Math.min(SCREEN_W - SPACING.md * 2, 300), borderRadius: RADIUS.lg, backgroundColor: colors.surfaceLight }} contentFit="cover" />
          <View style={styles.resultBtns}>
            <TouchableOpacity style={styles.exportBtn} onPress={addToLibrary} activeOpacity={0.85} disabled={!!busy}>
              {busy === 'lib' ? <ActivityIndicator color="#000" size="small" /> : <><Ionicons name="arrow-up-circle-outline" size={18} color="#000" /><Text style={styles.exportBtnText}>{t('gif.make.export')}</Text></>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={saveToDevice} activeOpacity={0.85} disabled={!!busy}>
              {busy === 'save' ? <ActivityIndicator color={colors.text} size="small" /> : <><Ionicons name="download-outline" size={18} color={colors.text} /><Text style={styles.secondaryBtnText}>{t('gif.make.saveToDevice')}</Text></>}
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => { setResult(null); setUploadedUrl(null); }} disabled={!!busy}>
            <Text style={styles.link}>{t('gif.make.redo')}</Text>
          </TouchableOpacity>
        </View>
      ) : rendering ? (
        // paddingBottom compensates for the header above so the preview lands on
        // the TRUE vertical centre of the screen, not the centre of the space
        // below the header.
        <View style={[styles.renderCenter, { paddingBottom: insets.top + 96 }]}>
          <View style={{ width: FS, height: FS }}>
            <View style={[styles.cropFrame, { width: FS, height: FS, marginTop: 0 }]}>
              <Animated.View pointerEvents="none" style={{ width: VW, height: VH, transform: [{ translateX: txV }, { translateY: tyV }, { scale: scaleV }] }}>
                <AppVideo source={{ uri: localUri }} style={{ width: VW, height: VH }} contentFit="cover" active={false} muted trimStartSec={loopStart} />
              </Animated.View>
            </View>
            {/* Progress ring drawn over the preview — traces its rounded border. */}
            <GifProgressRing progress={progressA} size={FS} radius={RADIUS.lg} thickness={4} />
          </View>
          <Text style={styles.title}>{t('gif.make.creating')}</Text>
        </View>
      ) : (
        <View style={styles.editor}>
          <PinchGestureHandler ref={pinchRef} simultaneousHandlers={panRef} onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchState}>
            <PanGestureHandler ref={panRef} simultaneousHandlers={pinchRef} avgTouches onGestureEvent={onPanEvent} onHandlerStateChange={onPanState}>
              <Animated.View style={[styles.cropFrame, { width: FS, height: FS }]}>
                {/* pointerEvents none so the native video never eats touches —
                    the gesture recognizer on the frame then gets them everywhere. */}
                <Animated.View pointerEvents="none" style={{ width: VW, height: VH, transform: [{ translateX: txV }, { translateY: tyV }, { scale: scaleV }] }}>
                  <AppVideo
                    source={{ uri: localUri }}
                    style={{ width: VW, height: VH }}
                    contentFit="cover"
                    active
                    muted
                    ignoreSuspend
                    trimStartSec={loopStart}
                    trimEndSec={loopStart + Math.min(gifDur, dur)}
                    progressIntervalMs={80}
                  />
                </Animated.View>
                {/* Transparent full-frame surface that reliably carries the
                    pinch/pan touches across the entire rendered video. */}
                <View style={StyleSheet.absoluteFill} />
                <TouchableOpacity style={styles.resetBtn} onPress={resetTransform} hitSlop={8}>
                  <Ionicons name="scan-outline" size={15} color="#fff" />
                  <Text style={styles.resetText}>{t('gif.make.reset')}</Text>
                </TouchableOpacity>
              </Animated.View>
            </PanGestureHandler>
          </PinchGestureHandler>
          <Text style={styles.hint}>{t('gif.make.editHint')}</Text>

          <GifTrimBar
            uri={localUri}
            frameUrlAt={cfStripAt}
            duration={dur}
            minDur={GIF_MIN_SEC}
            maxDur={Math.min(GIF_MAX_SEC, dur)}
            width={SCREEN_W - SPACING.md * 2}
            initialStart={0}
            initialDur={Math.min(GIF_MAX_SEC, dur)}
            onChange={(s, d) => { setStart(s); setGifDur(d); }}
          />
          <Text style={styles.durLabel}>{t('gif.make.clipLength', { sec: gifDur.toFixed(1) })}</Text>

          <TouchableOpacity style={[styles.primaryBtn, styles.createBtn]} onPress={render} activeOpacity={0.85} disabled={rendering}>
            {rendering
              ? <><ActivityIndicator color={colors.background} size="small" /><Text style={styles.primaryBtnText}>{t('gif.make.rendering', { pct: Math.round(progress * 100) })}</Text></>
              : <><Ionicons name="sparkles-outline" size={18} color={colors.background} /><Text style={styles.primaryBtnText}>{t('gif.make.create')}</Text></>}
          </TouchableOpacity>
        </View>
      )}

      {/* Themed result toast (Export / Save) — slides down from under the header. */}
      {flash ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.flash,
            { top: insets.top + 52, opacity: flashA, transform: [{ translateY: flashA.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }] },
          ]}
        >
          <View style={[styles.flashIcon, flash.tone === 'error' && styles.flashIconErr]}>
            <Ionicons name={flash.tone === 'error' ? 'close' : 'checkmark'} size={17} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.flashTitle}>{flash.title}</Text>
            {flash.body ? <Text style={styles.flashBody}>{flash.body}</Text> : null}
          </View>
        </Animated.View>
      ) : null}
    </GestureHandlerRootView>
  );

  if (inOverlay && Platform.OS === 'ios') {
    return visible ? <View style={StyleSheet.absoluteFill}>{content}</View> : null;
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.md, padding: SPACING.lg },
  renderCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.lg, padding: SPACING.lg },
  hint: { color: colors.textTertiary, fontSize: 13, textAlign: 'center' },
  editor: { flex: 1, paddingHorizontal: SPACING.md, gap: SPACING.md, alignItems: 'center' },
  cropFrame: { overflow: 'hidden', borderRadius: RADIUS.lg, backgroundColor: '#000', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginTop: SPACING.sm },
  resetBtn: {
    position: 'absolute', bottom: 8, right: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 5,
  },
  resetText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  durLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  resultBtns: { alignSelf: 'stretch', gap: SPACING.sm, paddingHorizontal: SPACING.lg },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: colors.text, borderRadius: RADIUS.full, paddingVertical: SPACING.md, paddingHorizontal: SPACING.md,
  },
  primaryBtnText: { color: colors.background, fontSize: 15, fontWeight: '800' },
  createBtn: { alignSelf: 'stretch' },
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    backgroundColor: '#fff', borderRadius: RADIUS.full, paddingVertical: SPACING.md, paddingHorizontal: SPACING.md,
  },
  exportBtnText: { color: '#000', fontSize: 15, fontWeight: '800' },
  flash: {
    position: 'absolute', left: SPACING.md, right: SPACING.md,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.lg, paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  flashIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  flashIconErr: { backgroundColor: colors.error },
  flashTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  flashBody: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
    borderRadius: RADIUS.full, paddingVertical: SPACING.md, paddingHorizontal: SPACING.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  secondaryBtnText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  link: { color: colors.primary, fontSize: 14, fontWeight: '700', paddingVertical: SPACING.sm },
});
