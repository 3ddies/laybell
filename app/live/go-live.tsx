import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Share, ActivityIndicator, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ScreenOrientation from 'expo-screen-orientation';
import SwipeBackPager from '../../components/SwipeBackPager';
import ConfirmDialog from '../../components/ConfirmDialog';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import {
  beatLiveStream, createLiveStream, discardLiveStream, endLiveStream, endMyStaleLiveStreams,
  isInputConnected, joinLiveChannel, markLive, type LiveOrientation, type LiveStream,
  type LiveStreamKeys, type LiveDonationEvent, type LiveChatMessage,
} from '../../lib/live';
import { WhipPublisher, getRTCView, webrtcAvailable } from '../../lib/whip';
import { rtmpAvailable, getRtmpView, type RtmpPublisherHandle } from '../../lib/rtmp';
import { displayedTier } from '../../lib/badges';
import LiveChatOverlay, { useBufferedChat } from '../../components/LiveChatOverlay';
import LiveDonationAlerts from '../../components/LiveDonationAlerts';
import LiveEarnedOverlay from '../../components/LiveEarnedOverlay';
import { fetchDonationEarnings, fetchStreamEarnings, fmtCents } from '../../lib/donations';

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
  // Phone broadcast orientation — horizontal/both also land in Laybell TV.
  const [orientation, setOrientation] = useState<LiveOrientation>('vertical');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [viewers, setViewers] = useState(0);
  // Viewer comments, shown over the broadcast so the host can follow the room.
  // Burst-buffered (see LiveChatOverlay) so a busy chat stays smooth on-camera.
  const { messages: chat, push: pushChat } = useBufferedChat();
  // Live donation alerts land on the host's own broadcast screen too.
  const [donationEvent, setDonationEvent] = useState<LiveDonationEvent | null>(null);
  // A horizontal phone broadcast is set up and filmed in landscape: once the
  // camera preview starts, rotate the screen so the host frames the shot the
  // way viewers (and Laybell TV) will see it — and back to portrait on exit.
  // 'vertical' broadcasts keep the normal portrait setup.
  const wantLandscape =
    mode === 'webrtc' && orientation === 'horizontal' && (phase === 'preview' || phase === 'live');
  useEffect(() => {
    ScreenOrientation.lockAsync(
      wantLandscape
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => { /* simulator / missing native module */ });
  }, [wantLandscape]);
  // Never leave the app stuck in landscape if the screen unmounts mid-broadcast.
  useEffect(() => () => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);
  // Mount the RTMP camera view only AFTER the landscape rotation has settled.
  // The api.video engine (HaishinKit on iOS) spins up an AVCaptureSession the
  // instant its view mounts; doing that WHILE the interface is mid-rotation
  // races the capture/preview-layer setup and hard-crashes the app. A short
  // settle after the orientation lock avoids the collision. Reset when leaving
  // landscape so the next horizontal go-live delays again.
  const [rtmpCamReady, setRtmpCamReady] = useState(false);
  useEffect(() => {
    if (!wantLandscape) { setRtmpCamReady(false); return; }
    const timer = setTimeout(() => setRtmpCamReady(true), 550);
    return () => clearTimeout(timer);
  }, [wantLandscape]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // True when this phone broadcast publishes RTMPS (horizontal + native lib
  // present): Cloudflare then serves live HLS, so the stream can cast to real
  // TVs and gets recorded. Vertical lives keep WHIP (sub-second, feed-only);
  // pre-rebuild binaries fall back to WHIP for horizontal too. Decided once in
  // prepare() so a mid-flow orientation change can't split the pipeline.
  const [phoneRtmpActive, setPhoneRtmpActive] = useState(false);
  // EVERY host earns donations now (Premium just lowers the fee — the "Earn More"
  // perk); take-home total, polled while live.
  const [earnedCents, setEarnedCents] = useState(0);
  const canEarn = true;
  // After End: if the stream made money, this holds the total and shows the
  // celebratory "You Earned $X" overlay (with a cash-out shortcut) before exit.
  const [endedEarnings, setEndedEarnings] = useState<number | null>(null);

  // While live, poll the donation take-home so the host sees tips roll in. Cheap
  // RPC every 15s; stops the moment the broadcast ends.
  useEffect(() => {
    if (phase !== 'live' || !canEarn || !profile?.id) return;
    let alive = true;
    const pull = () => fetchDonationEarnings().then((e) => { if (alive) setEarnedCents(e.totalCents); });
    pull();
    const iv = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [phase, canEarn, profile?.id]);

  // Heartbeat while live: prove to viewers' feeds this broadcast is still alive so
  // that if THIS app is killed the stream drops out within ~45s instead of
  // lingering as a ghost black screen (see dropStaleLives / STALE_LIVE_MS in
  // lib/live). Best-effort — a pre-migration DB just no-ops. iOS suspends this
  // timer in the background, which is the point: a backgrounded broadcast has
  // stopped sending video anyway, so letting it go stale is correct.
  useEffect(() => {
    if (phase !== 'live') return;
    const id = streamRef.current?.id;
    if (!id) return;
    beatLiveStream(id).catch(() => {});
    const iv = setInterval(() => beatLiveStream(id).catch(() => {}), 15_000);
    return () => clearInterval(iv);
  }, [phase]);

  const streamRef = useRef<LiveStream | null>(null);
  const keysRef = useRef<LiveStreamKeys | null>(null);
  const publisherRef = useRef<WhipPublisher | null>(null);
  const rtmpRef = useRef<RtmpPublisherHandle | null>(null);
  const channelRef = useRef<ReturnType<typeof joinLiveChannel> | null>(null);
  const viewerPeak = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const RTCView = getRTCView();
  const RtmpView = getRtmpView();

  useEffect(() => () => { cleanup(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening Go Live means I'm not currently broadcasting, so reap any leftover
  // ghost "live" rows from a previous session BEFORE I start a new one. Safe: it
  // only ends rows that already exist, so the stream prepare() creates next is
  // never caught by it. Runs once, when my id is first known.
  const reapedRef = useRef(false);
  useEffect(() => {
    if (reapedRef.current || !profile?.id) return;
    reapedRef.current = true;
    endMyStaleLiveStreams(profile.id).catch(() => {});
  }, [profile?.id]);

  async function cleanup(ended: boolean) {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    channelRef.current?.leave();
    channelRef.current = null;
    try { rtmpRef.current?.stopStreaming(); } catch { /* not streaming */ }
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
      // Horizontal phone lives publish RTMPS when the native engine is in this
      // binary — the row becomes mode 'rtmp' (live HLS: TV-castable, recorded,
      // played by the feed's existing AppVideo path).
      const usePhoneRtmp = mode === 'webrtc' && orientation === 'horizontal' && rtmpAvailable();
      const ingest: Mode = mode === 'rtmp' || usePhoneRtmp ? 'rtmp' : 'webrtc';
      // Orientation only applies to phone broadcasts; encoders set their own
      // framing, so those default to vertical bookkeeping.
      const { stream, keys } = await createLiveStream(title.trim(), ingest, mode === 'webrtc' ? orientation : 'vertical');
      streamRef.current = stream;
      keysRef.current = keys;
      if (mode === 'webrtc') {
        setPhoneRtmpActive(usePhoneRtmp);
        if (!usePhoneRtmp) {
          const pub = new WhipPublisher();
          publisherRef.current = pub;
          const media = await pub.openMedia('front');
          setPreviewUrl(media.toURL());
        }
        // RTMP path: the RtmpView renders its own camera preview once mounted.
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
      if (phoneRtmpActive) {
        // Publish RTMPS straight from the phone; resolves once connected.
        const ok = await rtmpRef.current?.startStreaming(
          keysRef.current?.rtmpsStreamKey ?? '',
          keysRef.current?.rtmpsUrl,
        );
        if (!ok) throw new Error(t('live.connectionLost'));
      } else if (stream.mode === 'webrtc') {
        await publisherRef.current?.publish(keysRef.current?.whipUrl ?? '');
      }
      await markLive(stream.id);
      setPhase('live');
      if (profile?.id) {
        channelRef.current = joinLiveChannel({
          streamId: stream.id,
          userId: profile.id,
          name: profile.display_name || profile.username || '',
          username: profile.username ?? null,
          avatarUrl: profile.avatar_url ?? null,
          tier: displayedTier(profile),
          isHost: true,
          onViewers: (n) => { viewerPeak.current = Math.max(viewerPeak.current, n); setViewers(n); },
          onChat: pushChat,
          onDonation: setDonationEvent,
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
    // Total THIS stream earned (freshest read, before we tear the row down).
    const earned = stream ? await fetchStreamEarnings(stream.id).catch(() => 0) : 0;
    if (stream) {
      await endLiveStream(stream.id, stream.cf_input_uid, viewerPeak.current).catch(() => {});
      streamRef.current = null;
    }
    await cleanup(true);
    // Made money → celebrate + offer a cash-out shortcut; otherwise just exit.
    if (earned > 0) setEndedEarnings(earned);
    else router.back();
  }

  const live = phase === 'live';

  // Host can tap a viewer's name/comment to view their profile. It's pushed on
  // top of the broadcast, which keeps running underneath (cleanup only ends the
  // stream on unmount), so hosting isn't interrupted. There's no reply bar on
  // this screen, so a comment tap opens the profile too.
  const openChatProfile = useCallback((m: LiveChatMessage) => router.push(`/profile/${m.userId}`), [router]);

  return (
    <SwipeBackPager scrollEnabled={!live}>
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        {/* Camera preview behind everything in phone mode. WHIP path shows the
            local WebRTC stream; the RTMP path's view IS the camera preview and
            the publisher in one (mounted through preview + live so the outgoing
            stream never loses its surface). */}
        {mode === 'webrtc' && !phoneRtmpActive && previewUrl && RTCView && (
          <RTCView streamURL={previewUrl} objectFit="cover" mirror style={StyleSheet.absoluteFill} />
        )}
        {mode === 'webrtc' && phoneRtmpActive && rtmpCamReady && RtmpView && (phase === 'preview' || phase === 'live') && (
          <RtmpView
            ref={rtmpRef}
            style={StyleSheet.absoluteFill}
            camera="front"
            video={{ fps: 30, resolution: '720p' }}
            audio={{ bitrate: 128000, sampleRate: 44100, isStereo: true }}
            enablePinchedZoom
            onConnectionFailed={(code: string) => { setError(String(code || t('live.connectionLost'))); setPhase('preview'); }}
            onDisconnect={() => {
              if (phaseRef.current === 'live') { setError(t('live.connectionLost')); setPhase('preview'); }
            }}
            onPermissionsDenied={() => setError(t('live.permissionsNeeded'))}
          />
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
              {canEarn && (
                <View style={styles.earnPill}>
                  <Ionicons name="gift" size={12} color="#fff" />
                  <Text style={styles.viewerText}>{fmtCents(earnedCents)}</Text>
                </View>
              )}
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

              {/* Orientation (phone only) — horizontal/both also land in Laybell TV. */}
              {mode === 'webrtc' && (
                <View style={styles.orientWrap}>
                  <Text style={styles.orientLabel}>{t('live.orientationLabel')}</Text>
                  <View style={styles.orientRow}>
                    {/* 'both' was retired as a choice — horizontal IS the TV-bound
                        option (legacy 'both' rows still play everywhere). */}
                    {([
                      { key: 'vertical' as const, icon: 'phone-portrait-outline', label: t('live.orientVertical') },
                      { key: 'horizontal' as const, icon: 'phone-landscape-outline', label: t('live.orientHorizontal') },
                    ]).map((o) => (
                      <TouchableOpacity
                        key={o.key}
                        style={[styles.orientBtn, orientation === o.key && styles.orientBtnActive]}
                        onPress={() => setOrientation(o.key)}
                      >
                        <Ionicons name={o.icon as never} size={18} color={orientation === o.key ? colors.primary : colors.textSecondary} />
                        <Text style={[styles.orientText, orientation === o.key && { color: colors.primary }]}>{o.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {orientation !== 'vertical' && (
                    <View style={styles.tvNote}>
                      <Ionicons name="tv-outline" size={13} color={colors.textTertiary} />
                      {/* With the RTMP engine in this binary, horizontal phone
                          lives ARE TV-castable; without it (pre-rebuild), be
                          honest that a real TV needs the Studio encoder. */}
                      <Text style={styles.tvNoteText}>
                        {t('live.tvNote')}{rtmpAvailable() ? '' : ` ${t('live.tvPhoneNote')}`}
                      </Text>
                    </View>
                  )}
                </View>
              )}

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
              {/* Camera-flip button removed: switching cameras mid-session upset
                  the capture orientation on-device, so broadcasts stay on the
                  front camera and the picture stays regular. */}
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

          {/* Host mounts this inside `body` (already below the header + safe area),
              so a small offset keeps the alert up near the top instead of the
              double-inset middle. The viewer keeps the default full-screen offset. */}
          {live && <LiveDonationAlerts event={donationEvent} topOffset={8} />}
          {live && (
            <View style={styles.previewControls}>
              <LiveChatOverlay
                messages={chat}
                style={styles.hostChat}
                onPressName={openChatProfile}
                onPressComment={openChatProfile}
              />
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

        {endedEarnings != null && (
          <LiveEarnedOverlay
            amountCents={endedEarnings}
            onCashOut={() => { setEndedEarnings(null); router.replace('/wallet'); }}
            onDone={() => { setEndedEarnings(null); router.back(); }}
          />
        )}
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
  earnPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.primary, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  body: { flex: 1, justifyContent: 'flex-end', padding: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 22 },
  card: { backgroundColor: c.surfaceElevated, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 16, gap: 12 },
  titleInput: { backgroundColor: c.surfaceLight, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 15 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12 },
  modeRowActive: { borderColor: c.primary },
  orientWrap: { gap: 8, marginTop: 2 },
  orientLabel: { color: c.textTertiary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  orientRow: { flexDirection: 'row', gap: 8 },
  orientBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4,
    borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingVertical: 10,
  },
  orientBtnActive: { borderColor: c.primary, backgroundColor: c.primary + '12' },
  orientText: { color: c.textSecondary, fontSize: 11, fontWeight: '600' },
  tvNote: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tvNoteText: { flex: 1, color: c.textTertiary, fontSize: 11.5, lineHeight: 16 },
  modeTextWrap: { flex: 1, gap: 2 },
  modeTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  modeSub: { color: c.textTertiary, fontSize: 12, lineHeight: 17 },
  primaryBtn: { borderRadius: 24, overflow: 'hidden' },
  primaryBtnBg: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13 },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  previewControls: { alignItems: 'center', gap: 14 },
  // previewControls centers its children, so the chat strip must stretch back
  // to full width to read like the viewer-side overlay.
  hostChat: { alignSelf: 'stretch' },
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
