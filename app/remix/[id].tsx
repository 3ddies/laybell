import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
  ScrollView, KeyboardAvoidingView, Platform, Alert, Dimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setAudioModeAsync } from 'expo-audio';
import CaptureCamera, { type CaptureCameraHandle, type CapturedMedia } from '../../components/CaptureCamera';
import AppVideo, { type AppVideoHandle } from '../../components/AppVideo';
import GifTrimBar from '../../components/GifTrimBar';
import { isCfStreamHls, cfStreamFrameUrl } from '../../lib/cast';
import { probeVideo } from '../../lib/videoProbe';
import {
  fetchSourcePost, REMIX_LAYOUTS,
  type SourcePost, type CompositionLayout, type CompositionMode,
} from '../../lib/composition';
import { useUploadActions } from '../../contexts/UploadQueueContext';
import { useProfile } from '../../contexts/ProfileContext';
import { useAudioControls } from '../../contexts/AudioContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

// React compose screen (lib/composition). You record your clip with the original
// as a reference that plays ONLY while you record (so the two line up), then pick
// how they go together:
//   • Commentary — your clip and the original play together, in a chosen layout.
//   • Add        — the original plays first (a slice you trim), then your clip.
// The result is an ordinary video post tagged with the source + layout/mode (+ the
// original's crop for add), and the player composes the two at playback. No baked
// file, and one reaction clip for now — the multi-take timeline is the native
// follow-up.
//
// AUDIO — STUDIO model (owner picked 2026-09-24): the original is heard from ONE
// place only, so it can never double/echo. While you record, the reference (video
// OR song) is MUTED — you WATCH the video to time your reaction (a song shows its
// cover), and your mic captures only your voice, with zero speaker bleed. The CLEAN
// original is then played, ducked under your voice, on the finished post (video via
// the source player, song via a hidden ducked audio player — see CompositionPlayer).
// Because nothing plays out loud here, no headphones are needed and there's no bleed
// to echo. Commentary layouts play the two together; Add plays the original's crop
// then your clip in turn (no overlap either way).

const REMIX_MAX_SEC = 60;          // your clip is short
const UPLOAD_CEILING_SEC = 180;    // the Cloudflare URL's cap; clips are well under it
const SOURCE_CROP_MAX = 60;        // add mode: longest slice of the original to play first
const SCREEN_W = Dimensions.get('window').width;

const LAYOUT_META: Record<CompositionLayout, { icon: keyof typeof MaterialCommunityIcons.glyphMap; labelKey: string }> = {
  // The two offered views. pip = you full-screen, original in the corner; pip_flip =
  // original full-screen, you in the corner.
  pip: { icon: 'crop-portrait', labelKey: 'remix.layoutPip' },
  pip_flip: { icon: 'picture-in-picture-top-right', labelKey: 'remix.layoutPipFlip' },
  // Retired / reserved — kept so the type/older posts still resolve; not offered.
  side_by_side: { icon: 'view-split-vertical', labelKey: 'remix.layoutSideBySide' },
  top_bottom: { icon: 'view-split-horizontal', labelKey: 'remix.layoutTopBottom' },
  green_screen: { icon: 'image-multiple-outline', labelKey: 'remix.layoutGreenScreen' },
};

export default function RemixComposeScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { profile } = useProfile();
  const { enqueueVideo } = useUploadActions();
  const { pause: pauseMusic } = useAudioControls();

  const camRef = useRef<CaptureCameraHandle>(null);
  const [source, setSource] = useState<SourcePost | null>(null);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<'record' | 'details'>('record');
  const [mode, setMode] = useState<CompositionMode>('commentary');
  // The two offered views, chosen on the details/share page: 'pip' (you full-screen,
  // original in the corner) or 'pip_flip' (original full-screen, you in the corner).
  const [layout, setLayout] = useState<CompositionLayout>('pip');
  const [clip, setClip] = useState<{ uri: string; poster: string | null; aspect: number; durationSec: number } | null>(null);
  const [caption, setCaption] = useState('');
  const [sharing, setSharing] = useState(false);
  // add mode: the slice of the original to play first (null = uncropped).
  const [sourceCrop, setSourceCrop] = useState<{ start: number; end: number } | null>(null);

  // Sync: the original reference stays MOUNTED (pre-loaded) and plays only while you
  // record; each take we seek it back to the top the instant recording starts (via
  // the ref, not a remount) so it begins in lock-step with the recording — that's
  // what makes your reaction line up with the original at playback.
  const [recording, setRecording] = useState(false);
  const refVideoRef = useRef<AppVideoHandle>(null);

  // Reacting to a SONG (not a video): the track plays under your commentary, there's
  // no spatial layout, and the reference is the cover art rather than a video window.
  const isAudio = !!source?.isAudio;

  // Opening the composer stops the user's music: the mic is about to be live and
  // the previews here are judged on their own sound (audio-session-hazard: pause,
  // never stop).
  useEffect(() => { pauseMusic(); }, [pauseMusic]);

  // Studio audio: the reference is muted while you film, so this just puts the app
  // in the record session for the mic (your voice). The clean original is added,
  // ducked, at playback — never played out loud here, so nothing bleeds into your
  // take. Reset on the way out. (Same call the composer's audio recorder uses.)
  useEffect(() => {
    setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
    return () => { setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {}); };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!id) { setLoading(false); return; }
      const s = await fetchSourcePost(id).catch(() => null);
      if (alive) { setSource(s); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [id]);

  const onRecordingChange = useCallback((rec: boolean) => {
    setRecording(rec);
    // Restart the (already-loaded) reference from the top the moment recording starts,
    // so the original and your reaction share t=0 — no reload lag to knock them out of
    // sync. active={recording} then plays it.
    if (rec) refVideoRef.current?.seek(0);
  }, []);

  // Add mode needs a concrete crop. Default to the first slice as soon as we know
  // the original's length — without clobbering a crop the user set on the trim bar
  // — so an add post ALWAYS stores a real [start, end]. That's what makes playback
  // show the SELECTED section (not the whole original) and gives the stitched
  // timeline a known length for the scrub bar.
  useEffect(() => {
    const dur = source?.durationSec ?? 0;
    if (dur > 0) setSourceCrop((c) => c ?? { start: 0, end: Math.min(dur, SOURCE_CROP_MAX) });
  }, [source?.durationSec]);

  const onCapture = useCallback(async (media: CapturedMedia) => {
    if (media.type !== 'video') return; // remix is video only
    let aspect = media.width && media.height ? media.width / media.height : 9 / 16;
    let durationSec = media.durationSec ?? 0;
    let poster: string | null = null;
    try {
      const p = await probeVideo(media.uri);
      if (p.width && p.height) aspect = p.width / p.height;
      if (p.durationSec) durationSec = p.durationSec;
      poster = p.posterUri ?? null;
    } catch { /* keep the capture's own dims */ }
    setClip({ uri: media.uri, poster, aspect, durationSec });
    setStage('details');
  }, []);

  const onLibrary = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'], quality: 1, videoMaxDuration: REMIX_MAX_SEC,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    onCapture({ uri: a.uri, type: 'video', width: a.width, height: a.height, durationSec: a.duration ? a.duration / 1000 : undefined });
  }, [onCapture]);

  const share = useCallback(async () => {
    if (!clip || !profile?.id || sharing) return;
    setSharing(true);
    try {
      // Reacting to a song is always "talk over the track" (the player ducks it);
      // it has no spatial layout, so it rides as 'pip' and the player keys off the
      // source being audio.
      const compositionKind = isAudio ? 'pip' : mode === 'add' ? 'add' : layout;
      enqueueVideo({
        userId: profile.id,
        localUri: clip.uri,
        thumbnailUri: clip.poster,
        posterUri: clip.poster,
        aspectRatio: String(clip.aspect),
        caption: caption.trim(),
        isPublic: true,
        hasCommunity: false,
        durationSeconds: clip.durationSec > 0 ? clip.durationSec : null,
        // Reacting to someone ELSE's post auto-tags the original creator, so they
        // get notified (tag notification + push, via the upload queue).
        taggedIds: source?.userId && source.userId !== profile.id ? [source.userId] : [],
        communityIds: [],
        allowGifs: true,
        maxDurationSeconds: UPLOAD_CEILING_SEC,
        sourceSeconds: clip.durationSec,
        sourcePostId: id,
        compositionKind,
        // Add always stores a concrete start (the default effect fills the crop the
        // moment we know the duration); a null end is fine — the player learns the
        // original's length and caps the crop itself.
        sourceTrimStart: mode === 'add' ? sourceCrop?.start ?? 0 : null,
        sourceTrimEnd: mode === 'add' ? sourceCrop?.end ?? null : null,
      });
      router.replace('/(tabs)'); // Home shows the pending upload card at the top.
    } catch (e: any) {
      setSharing(false);
      Alert.alert(t('common.error'), e?.message ?? '');
    }
  }, [clip, profile?.id, sharing, enqueueVideo, caption, id, mode, layout, sourceCrop, isAudio, source?.userId, router, t]);

  const creator = source?.username ? `@${source.username}` : (source?.displayName ?? t('remix.theCreator'));
  const cropDur = source?.durationSec && source.durationSec > 0 ? source.durationSec : 0;

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // ── Details: mode + preview + layout/crop + caption + share ──────────────────
  if (stage === 'details' && clip) {
    return (
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { paddingTop: insets.top + SPACING.sm }]}>
          <TouchableOpacity onPress={() => setStage('record')} hitSlop={12} accessibilityLabel={t('a11y.back')}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('remix.title')}</Text>
          <View style={{ width: 26 }} />
        </View>

        <ScrollView contentContainerStyle={styles.detailScroll} keyboardShouldPersistTaps="handled">
          {/* Commentary ↔ Add (video only; a song reaction is always "talk over"). */}
          {!isAudio && (
            <View style={styles.modeSwitch}>
              {(['commentary', 'add'] as CompositionMode[]).map((m) => {
                const on = mode === m;
                return (
                  <TouchableOpacity key={m} style={[styles.modeBtn, on && styles.modeBtnOn]} onPress={() => setMode(m)} activeOpacity={0.85}>
                    <Text style={[styles.modeText, on && styles.modeTextOn]}>
                      {m === 'commentary' ? t('remix.modeCommentary') : t('remix.modeAdd')}
                    </Text>
                    <Text style={[styles.modeHint, on && styles.modeHintOn]} numberOfLines={1}>
                      {m === 'commentary' ? t('remix.modeCommentaryHint') : t('remix.modeAddHint')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Preview of how the two will play. */}
          <View style={styles.previewCard}>
            <CompositionPreview mode={mode} layout={layout} clipUri={clip.uri} clipPoster={clip.poster} source={source} sourceCrop={mode === 'add' ? sourceCrop : null} />
          </View>

          {isAudio ? (
            <Text style={styles.cropHint}>{t('remix.songUnder')}</Text>
          ) : mode === 'commentary' ? (
            <>
              <Text style={styles.pickerLabel}>{t('remix.chooseLayout')}</Text>
              <View style={styles.layoutRow}>
                {REMIX_LAYOUTS.map((l) => {
                  const on = layout === l;
                  return (
                    <TouchableOpacity key={l} style={[styles.layoutChip, on && styles.layoutChipOn]} onPress={() => setLayout(l)} activeOpacity={0.85}>
                      <MaterialCommunityIcons name={LAYOUT_META[l].icon} size={22} color={on ? '#fff' : colors.text} />
                      <Text style={[styles.layoutChipText, on && styles.layoutChipTextOn]}>{t(LAYOUT_META[l].labelKey)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          ) : (
            <>
              <Text style={styles.pickerLabel}>{t('remix.cropOriginal')}</Text>
              {cropDur > 0 && source?.mediaUrl ? (
                // GifTrimBar (the GIF maker's bar): a zoom slider makes long videos
                // easy to trim, and real Cloudflare Stream frames fill the strip
                // (HLS can't be frame-grabbed on-device — lib/cast cfStreamFrameUrl).
                <GifTrimBar
                  uri={source.mediaUrl}
                  frameUrlAt={isCfStreamHls(source.mediaUrl) ? (ts) => cfStreamFrameUrl(source!.mediaUrl, ts, 160) : undefined}
                  duration={cropDur}
                  minDur={1}
                  maxDur={Math.min(cropDur, SOURCE_CROP_MAX)}
                  width={SCREEN_W - SPACING.md * 2}
                  initialStart={0}
                  initialDur={Math.min(cropDur, SOURCE_CROP_MAX)}
                  onChange={(s, d) => setSourceCrop({ start: s, end: s + d })}
                />
              ) : (
                <Text style={styles.cropHint}>{t('remix.cropWhole')}</Text>
              )}
            </>
          )}

          <View style={styles.attributionRow}>
            {source?.avatarUrl ? (
              <ExpoImage source={{ uri: source.avatarUrl }} style={styles.attrAvatar} contentFit="cover" cachePolicy="memory-disk" />
            ) : (
              <LinearGradient colors={GRADIENTS.avatar} style={styles.attrAvatar} />
            )}
            <Text style={styles.attrText}>{t('remix.credit', { user: creator })}</Text>
          </View>

          <TextInput
            style={styles.caption}
            placeholder={t('remix.captionPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={caption}
            onChangeText={setCaption}
            multiline
            maxLength={2200}
          />
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + SPACING.md }]}>
          <TouchableOpacity style={styles.shareBtn} onPress={share} disabled={sharing} activeOpacity={0.85}>
            <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.shareFill}>
              {sharing ? <ActivityIndicator color="#fff" /> : <Text style={styles.shareText}>{t('remix.share')}</Text>}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ── Record: the camera, with the original as a sync reference ─────────────────
  const during = mode === 'commentary';
  return (
    <View style={styles.container}>
      <CaptureCamera
        ref={camRef}
        active={isFocused && stage === 'record'}
        focused={isFocused}
        maxVideoSec={REMIX_MAX_SEC}
        onCapture={onCapture}
        onRecordingChange={onRecordingChange}
        onClose={() => router.back()}
        onLibrary={onLibrary}
        closeLabel={t('a11y.back')}
        videoOnly
      />

      {/* PHASE: plain, bold During / After (video only — a song reaction is always
          "talk over the track"). Hidden while recording — no changing settings mid-take. */}
      {!isAudio && !recording && (
        <View style={[styles.recPhaseRow, { top: insets.top + 10 }]} pointerEvents="box-none">
          {(['commentary', 'add'] as CompositionMode[]).map((m) => {
            const on = mode === m;
            return (
              <TouchableOpacity key={m} onPress={() => setMode(m)} hitSlop={10} activeOpacity={0.8}>
                <Text style={[styles.recPhaseText, on ? styles.recPhaseOn : styles.recPhaseOff]}>
                  {m === 'commentary' ? t('remix.modeCommentary') : t('remix.modeAdd')}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* The two views (pip / pip_flip) are chosen on the details page; the record
          screen just shows the original as a muted timing reference. Green screen is
          deferred (native) — when it lands it becomes an effect on those two views. */}

      {/* Studio-audio note — the original is muted while you film (so your take is
          clean and the post doesn't echo); the post adds its clean sound under your
          voice. Sets the expectation that the silent reference is intentional.
          Hidden once recording starts. */}
      {!recording && (
        <View style={[styles.recHeadphonesWrap, { top: insets.top + (isAudio ? 12 : 46) }]} pointerEvents="none">
          <View style={styles.recHeadphones}>
            <Ionicons name="volume-mute-outline" size={13} color="#fff" />
            <Text style={styles.recHeadphonesText}>{t('remix.recordAudioNote')}</Text>
          </View>
        </View>
      )}

      {isAudio ? (
        // SONG reference: cover art + the track, paused until you record, then it
        // plays OUT LOUD so you can talk over it (it's ducked under your voice on
        // the finished post).
        source?.mediaUrl ? (
          <View style={[styles.refWindow, { top: insets.top + 124, right: SPACING.md, width: 116, height: 116 }]} pointerEvents="none">
            {source.coverUrl
              ? <ExpoImage source={{ uri: source.coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
              : <View style={[StyleSheet.absoluteFill, { backgroundColor: '#222', alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="musical-notes" size={30} color="rgba(255,255,255,0.6)" /></View>}
            {/* Studio audio: the track is NOT played while you film (that would bleed
                into your mic and echo the post). The CLEAN track plays ducked under
                your voice on the finished post — heard once, there. */}
            <View style={styles.refTag}>
              <Ionicons name="musical-notes" size={11} color="#fff" />
              <Text style={styles.refTagText}>{t('remix.original')}</Text>
            </View>
          </View>
        ) : null
      ) : during ? (
        // DURING: the original, top-right — a MUTED reference you WATCH to time your
        // reaction (studio audio: your mic records only your voice; the clean original
        // is added ducked at playback). Pre-loaded and, the instant you press record,
        // restarted from the top (via the ref) so the two share t=0 and stay in sync.
        source?.mediaUrl ? (
          // Below the camera's top-right tool rail (close + flash/torch + timer,
          // ~108pt tall) so the preview never collides with those buttons.
          <View style={[styles.refWindow, { top: insets.top + 124, right: SPACING.md, width: 116, height: 155 }]} pointerEvents="none">
            <AppVideo
              ref={refVideoRef}
              source={{ uri: source.mediaUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              active={recording}
              loop
              muted
              poster={source.thumbnailUrl}
            />
            <View style={styles.refTag}>
              <Ionicons name={recording ? 'volume-mute' : 'albums-outline'} size={11} color="#fff" />
              <Text style={styles.refTagText}>{recording ? t('remix.original') : t('remix.tapToSync')}</Text>
            </View>
          </View>
        ) : null
      ) : (
        // AFTER: just record a plain clip; the original section is picked on details.
        <View style={[styles.recHint, { top: insets.top + 96 }]} pointerEvents="none">
          <Text style={styles.recHintText}>{t('remix.afterHint')}</Text>
        </View>
      )}
    </View>
  );
}

// The preview: commentary layouts, or the add sequence (original, then you).
function CompositionPreview({ mode, layout, clipUri, clipPoster, source, sourceCrop }: {
  mode: CompositionMode; layout: CompositionLayout; clipUri: string; clipPoster: string | null;
  source: SourcePost | null; sourceCrop: { start: number; end: number } | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const own = <AppVideo source={{ uri: clipUri }} style={StyleSheet.absoluteFill} contentFit="cover" active loop muted poster={clipPoster} />;
  const src = source?.mediaUrl
    ? <AppVideo source={{ uri: source.mediaUrl }} style={StyleSheet.absoluteFill} contentFit="cover" active loop muted poster={source.thumbnailUrl} />
    : <View style={StyleSheet.absoluteFill} />;
  // Add mode: preview the SELECTED section of the original (trim), looping, so the
  // preview matches what actually plays first on the post.
  const srcCropped = source?.mediaUrl
    ? <AppVideo source={{ uri: source.mediaUrl }} style={StyleSheet.absoluteFill} contentFit="cover" active loop muted
        poster={source.thumbnailUrl} trimStartSec={sourceCrop?.start ?? null} trimEndSec={sourceCrop?.end ?? null} />
    : <View style={StyleSheet.absoluteFill} />;

  // Song reaction: your clip full, the cover in a card (the track rides under it).
  if (source?.isAudio) {
    return (
      <View style={styles.prevFull}>
        {own}
        {source.coverUrl ? (
          <View style={styles.prevSongCard}>
            <ExpoImage source={{ uri: source.coverUrl }} style={styles.prevSongArt} contentFit="cover" cachePolicy="memory-disk" />
            <Ionicons name="musical-notes" size={13} color="#fff" />
          </View>
        ) : null}
      </View>
    );
  }

  if (mode === 'add') {
    // Order: the original's SELECTED section (1) plays first, then your clip (2).
    return (
      <View style={styles.prevStack}>
        <View style={styles.prevPaneH}>{srcCropped}<View style={styles.orderTag}><Text style={styles.orderTagText}>1 · {t('remix.original')}</Text></View></View>
        <View style={styles.prevDividerH} />
        <View style={styles.prevPaneH}>{own}<View style={styles.orderTag}><Text style={styles.orderTagText}>2 · {t('remix.yourClip')}</Text></View></View>
      </View>
    );
  }
  // pip_flip: the ORIGINAL full-screen, YOU in the small top-right window.
  if (layout === 'pip_flip') {
    return (
      <View style={styles.prevFull}>
        {src}
        <View style={styles.prevPip}>{own}</View>
      </View>
    );
  }
  // pip (default): YOU full-screen, the original in the small top-right window.
  return (
    <View style={styles.prevFull}>
      {own}
      <View style={styles.prevPip}>{src}</View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm,
  },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },

  detailScroll: { padding: SPACING.md, gap: SPACING.md },

  modeSwitch: { flexDirection: 'row', gap: SPACING.sm },
  modeBtn: {
    flex: 1, alignItems: 'center', gap: 2, paddingVertical: SPACING.sm + 2,
    borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight, borderWidth: 1.5, borderColor: 'transparent',
  },
  modeBtnOn: { backgroundColor: colors.surfaceElevated, borderColor: colors.primary },
  modeText: { color: colors.text, fontSize: 15, fontWeight: '800' },
  modeTextOn: { color: colors.primary },
  modeHint: { color: colors.textTertiary, fontSize: 11, fontWeight: '600' },
  modeHintOn: { color: colors.textSecondary },

  previewCard: { borderRadius: RADIUS.lg, overflow: 'hidden', backgroundColor: '#000' },

  prevStack: { aspectRatio: 3 / 4, backgroundColor: '#000' },
  prevPaneH: { flex: 1, backgroundColor: '#000' },
  prevDividerH: { height: 2, backgroundColor: colors.background },
  prevFull: { aspectRatio: 9 / 16, backgroundColor: '#000', maxHeight: 420, alignSelf: 'center', width: '100%' },
  prevPip: {
    position: 'absolute', right: 8, top: 8, width: '32%', aspectRatio: 9 / 16,
    borderRadius: 10, overflow: 'hidden', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.5)', backgroundColor: '#000',
  },
  prevSongCard: {
    position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 5, paddingRight: 10,
  },
  prevSongArt: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#333' },
  orderTag: {
    position: 'absolute', left: 8, top: 8, backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
  },
  orderTagText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  pickerLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  layoutRow: { flexDirection: 'row', gap: SPACING.sm },
  layoutChip: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight, borderWidth: 1.5, borderColor: 'transparent',
  },
  layoutChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  layoutChipText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  layoutChipTextOn: { color: '#fff' },
  cropHint: { color: colors.textTertiary, fontSize: 13 },

  attributionRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  attrAvatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceElevated },
  attrText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', flex: 1 },

  caption: {
    color: colors.text, fontSize: 15, minHeight: 80, textAlignVertical: 'top',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md, padding: SPACING.md,
  },

  footer: { paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  shareBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  shareFill: { paddingVertical: SPACING.md, alignItems: 'center', justifyContent: 'center' },
  shareText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  refWindow: {
    position: 'absolute',
    borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.45)',
  },
  // Plain, bold phase toggle — two words, no pill, active bright / inactive dimmed.
  recPhaseRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: SPACING.xl },
  recPhaseText: {
    fontSize: 18, fontWeight: '900', letterSpacing: 0.3,
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
  recPhaseOn: { color: '#fff' },
  recPhaseOff: { color: 'rgba(255,255,255,0.5)' },
  recHint: {
    position: 'absolute', left: SPACING.xl, right: SPACING.xl, alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: RADIUS.md, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
  },
  recHintText: { color: '#fff', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  recHeadphonesWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  recHeadphones: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: RADIUS.full,
    paddingHorizontal: 12, paddingVertical: 6,
    // Narrow enough to sit BETWEEN the camera's close button (top-left) and the
    // flash/timer rail (top-right) — each ~60pt wide — so it never runs under them.
    maxWidth: SCREEN_W - 150,
  },
  recHeadphonesText: { color: '#fff', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  refTag: {
    position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 3, paddingVertical: 3, backgroundColor: 'rgba(0,0,0,0.5)',
  },
  refTagText: { color: '#fff', fontSize: 9, fontWeight: '700' },
});
