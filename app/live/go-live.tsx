import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Share, ActivityIndicator, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import ConfirmDialog from '../../components/ConfirmDialog';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import {
  createLiveStream, discardLiveStream, endLiveStream, isInputConnected, joinLiveChannel,
  markLive, type LiveStream, type LiveStreamKeys,
} from '../../lib/live';
import { WhipPublisher, getRTCView, webrtcAvailable } from '../../lib/whip';

// Go Live: two broadcast paths off one Cloudflare live input.
//  • Phone — camera+mic published straight from the device over WHIP; viewers
//    get sub-second WHEP playback in the Live tab.
//  • Studio encoder — we surface the RTMPS url + key for OBS/etc.; the stream
//    goes live once Cloudflare reports the encoder connected, and viewers play
//    the live HLS manifest (recorded automatically).

type Phase = 'setup' | 'preview' | 'waiting' | 'live';
type Mode = 'webrtc' | 'rtmp';

export default function GoLiveScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile } = useProfile();

  const [phase, setPhaseState] = useState<Phase>('setup');
  // Mirrored in a ref so the unmount cleanup sees the CURRENT phase, not the
  // one captured at mount — a live unmount must END the stream, not discard it.
  const phaseRef = useRef<Phase>('setup');
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const [mode, setMode] = useState<Mode>(webrtcAvailable() ? 'webrtc' : 'rtmp');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [viewers, setViewers] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const streamRef = useRef<LiveStream | null>(null);
  const keysRef = useRef<LiveStreamKeys | null>(null);
  const publisherRef = useRef<WhipPublisher | null>(null);
  const channelRef = useRef<ReturnType<typeof joinLiveChannel> | null>(null);
  const viewerPeak = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const RTCView = getRTCView();

  useEffect(() => () => { cleanup(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function cleanup(ended: boolean) {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    channelRef.current?.leave();
    channelRef.current = null;
    await publisherRef.current?.stop().catch(() => {});
    publisherRef.current = null;
    const stream = streamRef.current;
    if (stream && !ended) {
      // Backing out before/without going live — remove the input + row.
      if (phaseRef.current === 'live') {
        await endLiveStream(stream.id, stream.cf_input_uid, viewerPeak.current).catch(() => {});
      } else {
        await discardLiveStream(stream.id, stream.cf_input_uid).catch(() => {});
      }
      streamRef.current = null;
    }
  }

  async function prepare() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { stream, keys } = await createLiveStream(title.trim(), mode);
      streamRef.current = stream;
      keysRef.current = keys;
      if (mode === 'webrtc') {
        const pub = new WhipPublisher();
        publisherRef.current = pub;
        const media = await pub.openMedia('front');
        setPreviewUrl(media.toURL());
        setPhase('preview');
      } else {
        setPhase('waiting');
        // Poll until the encoder connects, then flip live automatically.
        pollRef.current = setInterval(async () => {
          const s = streamRef.current;
          if (!s) return;
          if (await isInputConnected(s.cf_input_uid).catch(() => false)) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            await goLiveNow();
          }
        }, 4000);
      }
    } catch (e) {
      setError((e as Error)?.message ?? 'failed');
    }
    setBusy(false);
  }

  async function goLiveNow() {
    const stream = streamRef.current;
    if (!stream || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (stream.mode === 'webrtc') {
        await publisherRef.current?.publish(keysRef.current?.whipUrl ?? '');
      }
      await markLive(stream.id);
      setPhase('live');
      if (profile?.id) {
        channelRef.current = joinLiveChannel({
          streamId: stream.id,
          userId: profile.id,
          name: profile.display_name || profile.username || '',
          avatarUrl: profile.avatar_url ?? null,
          isHost: true,
          onViewers: (n) => { viewerPeak.current = Math.max(viewerPeak.current, n); setViewers(n); },
          onChat: () => {},
        });
      }
    } catch (e) {
      setError((e as Error)?.message ?? 'failed');
    }
    setBusy(false);
  }

  async function endNow() {
    const stream = streamRef.current;
    setConfirmEnd(false);
    if (stream) {
      await endLiveStream(stream.id, stream.cf_input_uid, viewerPeak.current).catch(() => {});
      streamRef.current = null;
    }
    await cleanup(true);
    router.back();
  }

  const live = phase === 'live';

  return (
    <SwipeBackPager scrollEnabled={!live}>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Camera preview behind everything in phone mode */}
        {mode === 'webrtc' && previewUrl && RTCView && (
          <RTCView streamURL={previewUrl} objectFit="cover" mirror style={StyleSheet.absoluteFill} />
        )}

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => (live ? setConfirmEnd(true) : router.back())}
            style={styles.headerBtn}
          >
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('live.newTitle')}</Text>
          {live ? (
            <View style={styles.liveBadgeRow}>
              <View style={styles.livePill}><Text style={styles.livePillText}>{t('live.live')}</Text></View>
              <View style={styles.viewerPill}>
                <Ionicons name="eye-outline" size={13} color="#fff" />
                <Text style={styles.viewerText}>{viewers}</Text>
              </View>
            </View>
          ) : <View style={styles.headerBtn} />}
        </View>

        <View style={styles.body}>
          {phase === 'setup' && (
            <View style={styles.card}>
              <TextInput
                style={styles.titleInput}
                placeholder={t('live.titlePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                value={title}
                onChangeText={setTitle}
                maxLength={120}
              />
              {/* Mode picker */}
              <TouchableOpacity
                style={[styles.modeRow, mode === 'webrtc' && styles.modeRowActive, !webrtcAvailable() && { opacity: 0.45 }]}
                disabled={!webrtcAvailable()}
                onPress={() => setMode('webrtc')}
              >
                <Ionicons name="phone-portrait-outline" size={20} color={colors.text} />
                <View style={styles.modeTextWrap}>
                  <Text style={styles.modeTitle}>{t('live.phone')}</Text>
                  <Text style={styles.modeSub}>{webrtcAvailable() ? t('live.phoneSub') : t('live.rebuildNeeded')}</Text>
                </View>
                {mode === 'webrtc' && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeRow, mode === 'rtmp' && styles.modeRowActive]}
                onPress={() => setMode('rtmp')}
              >
                <Ionicons name="desktop-outline" size={20} color={colors.text} />
                <View style={styles.modeTextWrap}>
                  <Text style={styles.modeTitle}>{t('live.encoder')}</Text>
                  <Text style={styles.modeSub}>{t('live.encoderSub')}</Text>
                </View>
                {mode === 'rtmp' && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
              </TouchableOpacity>

              {!!error && <Text style={styles.error}>{error}</Text>}
              <TouchableOpacity onPress={prepare} disabled={busy} activeOpacity={0.85} style={styles.primaryBtn}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnBg}>
                  {busy ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Ionicons name="radio-outline" size={18} color="#fff" />
                      <Text style={styles.primaryBtnText}>{t('live.prepare')}</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'preview' && (
            <View style={styles.previewControls}>
              <TouchableOpacity style={styles.roundBtn} onPress={() => publisherRef.current?.switchCamera()}>
                <Ionicons name="camera-reverse-outline" size={22} color="#fff" />
              </TouchableOpacity>
              {!!error && <Text style={styles.error}>{error}</Text>}
              <TouchableOpacity onPress={goLiveNow} disabled={busy} activeOpacity={0.85} style={styles.primaryBtn}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnBg}>
                  {busy ? <ActivityIndicator color="#fff" /> : (
                    <Text style={styles.primaryBtnText}>{t('live.goLiveNow')}</Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'waiting' && (
            <View style={styles.card}>
              <Text style={styles.waitTitle}>{t('live.waitingEncoder')}</Text>
              <Text style={styles.credLabel}>{t('live.rtmpsUrl')}</Text>
              <Text style={styles.credValue} selectable>{keysRef.current?.rtmpsUrl}</Text>
              <Text style={styles.credLabel}>{t('live.rtmpsKey')}</Text>
              <Text style={styles.credValue} selectable numberOfLines={2}>{keysRef.current?.rtmpsStreamKey}</Text>
              <TouchableOpacity
                style={styles.shareBtn}
                onPress={() => Share.share({ message: `${keysRef.current?.rtmpsUrl}\n${keysRef.current?.rtmpsStreamKey}` })}
              >
                <Ionicons name="share-outline" size={16} color={colors.text} />
                <Text style={styles.shareBtnText}>{t('live.shareCreds')}</Text>
              </TouchableOpacity>
              <View style={styles.waitRow}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.modeSub}>{t('live.autoStart')}</Text>
              </View>
            </View>
          )}

          {live && (
            <View style={styles.previewControls}>
              {mode === 'webrtc' && (
                <TouchableOpacity style={styles.roundBtn} onPress={() => publisherRef.current?.switchCamera()}>
                  <Ionicons name="camera-reverse-outline" size={22} color="#fff" />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setConfirmEnd(true)} activeOpacity={0.85} style={styles.endBtn}>
                <Text style={styles.endBtnText}>{t('live.end')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <ConfirmDialog
          visible={confirmEnd}
          title={t('live.confirmEndTitle')}
          message={t('live.confirmEndMsg')}
          confirmLabel={t('live.end')}
          cancelLabel={t('common.cancel')}
          destructive
          onConfirm={endNow}
          onCancel={() => setConfirmEnd(false)}
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '700' },
  liveBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  livePill: { backgroundColor: '#F43F5E', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  livePillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  viewerPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  viewerText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  body: { flex: 1, justifyContent: 'flex-end', padding: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 22 },
  card: { backgroundColor: c.surfaceElevated, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 16, gap: 12 },
  titleInput: { backgroundColor: c.surfaceLight, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 15 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12 },
  modeRowActive: { borderColor: c.primary },
  modeTextWrap: { flex: 1, gap: 2 },
  modeTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  modeSub: { color: c.textTertiary, fontSize: 12, lineHeight: 17 },
  primaryBtn: { borderRadius: 24, overflow: 'hidden' },
  primaryBtnBg: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13 },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  previewControls: { alignItems: 'center', gap: 14 },
  roundBtn: { width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)' },
  endBtn: { alignSelf: 'stretch', borderRadius: 24, backgroundColor: '#F43F5E', alignItems: 'center', paddingVertical: 13 },
  endBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  waitTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  credLabel: { color: c.textTertiary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  credValue: { color: c.text, fontSize: 13, backgroundColor: c.surfaceLight, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingVertical: 10 },
  shareBtnText: { color: c.text, fontSize: 13, fontWeight: '600' },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  error: { color: c.error, fontSize: 13 },
});
