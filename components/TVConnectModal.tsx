import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { castNativeAvailable, useCast } from '../contexts/CastContext';
import { selection } from '../lib/haptics';
import {
  TV_BRANDS, brandById, loadSavedBrandId, saveBrandId, transportsFor, type TVBrand, type TVTransport,
} from '../lib/tvSetup';
import { postToCastItem, type CastItem } from '../lib/cast';
import { fetchHorizontalVideos } from '../lib/tv';

// Laybell TV — the "Watch on TV" connect wizard. Three friendly screens:
//
//   1. Pick your TV (a brand grid — remembered, so this shows once)
//   2. Connect (three tiny steps + ONE big button; the right transport for the
//      phone is pre-chosen: iPhone → AirPlay, Android → Chromecast)
//   3. You're connected! (live success state for Cast sessions)
//
// The Connect buttons are styled pills with the REAL native button stretched
// invisibly across them: AirPlay pickers can only be opened by an actual
// AVRoutePickerView tap, and iOS 14+ ignores the programmatic Cast dialog until
// a genuine Cast button has been pressed once — so the pretty button IS the
// native button. Both native views are require-guarded (a binary without them
// just shows the "next update" note), matching AirPlayButton/CastButton.

let RNGC: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RNGC = require('react-native-google-cast');
} catch { /* native Cast module absent — cast path shows the update note */ }

let VideoAirPlayButton: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  VideoAirPlayButton = require('expo-video').VideoAirPlayButton;
} catch { /* expo-video without the AirPlay view — airplay path shows the note */ }

export default function TVConnectModal({ visible, onClose, pendingItem }: {
  visible: boolean;
  onClose: () => void;
  /** A video queued behind the wizard (the 3-dot "Laybell TV" path): it's cast
      automatically the moment a session connects, so connect = it starts playing. */
  pendingItem?: CastItem | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const cast = useCast();

  const [brand, setBrand] = useState<TVBrand | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);

  // "Browse videos" from the connected screen: start playing on the TV right
  // away (top of the Laybell TV feed, whole feed queued for up-next) so the TV
  // is never sitting idle, then close the wizard — cast() expands the
  // full-screen remote, so the user lands straight on the playing video's
  // controls. If a video is ALREADY on the TV (the 3-dot pending item), don't
  // replace it — just close.
  async function browseAndPlay() {
    if (cast.current) { onClose(); return; }
    setStarting(true);
    try {
      const vids = await fetchHorizontalVideos(20);
      const items = vids.map(postToCastItem).filter(Boolean) as CastItem[];
      if (items.length) cast.cast(items[0], items);
    } catch { /* offline — just close */ }
    setStarting(false);
    onClose();
  }

  // Remembered TV: skip the brand grid on every open after the first.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    loadSavedBrandId().then((id) => {
      if (!alive) return;
      setBrand(brandById(id));
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [visible]);

  const transports: TVTransport[] = brand ? transportsFor(brand, Platform.OS) : [];

  // The moment a Cast-capable path is on screen, start discovery (iOS never
  // autostarts it — see CastContext.startDiscovery). Android ignores this.
  const wantsCast = visible && transports.includes('cast') && castNativeAvailable;
  useEffect(() => {
    if (wantsCast) cast.startDiscovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsCast]);

  // Queued video (3-dot "Laybell TV"): fire it once per open when the session
  // comes up, so the success screen doubles as "and your video is playing".
  const castedRef = useRef(false);
  useEffect(() => { if (!visible) castedRef.current = false; }, [visible]);
  useEffect(() => {
    if (visible && cast.connected && pendingItem && !castedRef.current) {
      castedRef.current = true;
      cast.cast(pendingItem);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, cast.connected, pendingItem]);

  const pickBrand = (b: TVBrand) => {
    setBrand(b);
    saveBrandId(b.id);
  };

  // "Connecting…" screen pulse — the beat between picking a device in the
  // native dialog and the session coming up is SECONDS long; without this the
  // wizard just sits on screen 2 and the tap feels like it did nothing.
  const pulse = useRef(new Animated.Value(0)).current;
  const connecting = visible && cast.connecting && !cast.connected;
  useEffect(() => {
    if (!connecting) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [connecting, pulse]);

  const airplaySupported = Platform.OS === 'ios' && !!VideoAirPlayButton;
  const CastNativeButton = castNativeAvailable ? RNGC?.CastButton : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
    >
      <View style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.titleWrap}>
            <Ionicons name="tv" size={18} color={colors.primary} />
            <Text style={styles.headerTitle}>{t('tv.setup.title')}</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t('a11y.close')}>
            <Ionicons name="close" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {cast.connected ? (
            /* ── Screen 3: connected (Cast sessions report live state) ─────── */
            <View style={styles.doneWrap}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.doneCircle}>
                <Ionicons name="checkmark" size={44} color="#fff" />
              </LinearGradient>
              <Text style={styles.doneTitle}>{t('tv.setup.connectedTitle')}</Text>
              <Text style={styles.doneBody}>
                {t('tv.setup.connectedBody', { device: cast.deviceName || t('tv.cast.yourTv') })}
              </Text>
              <TouchableOpacity onPress={browseAndPlay} disabled={starting} activeOpacity={0.9} style={styles.primaryWrap}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                  {starting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="play" size={18} color="#fff" />
                      <Text style={styles.primaryText}>{t('tv.setup.browse')}</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity onPress={cast.disconnect} style={styles.linkBtn}>
                <Text style={styles.linkText}>{t('tv.setup.disconnect')}</Text>
              </TouchableOpacity>
            </View>
          ) : connecting ? (
            /* ── Screen 2.5: connecting — the device is picked, the session is
                coming up. A pulsing TV + excited copy so the seconds-long
                handshake reads as "it's happening!" instead of a dead app. */
            <View style={styles.doneWrap}>
              <Animated.View
                style={{ transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }] }}
              >
                <LinearGradient colors={GRADIENTS.primary} style={styles.doneCircle}>
                  <Ionicons name="tv" size={40} color="#fff" />
                </LinearGradient>
              </Animated.View>
              <Text style={styles.doneTitle}>{t('tv.setup.connectingTitle')}</Text>
              <Text style={styles.doneBody}>{t('tv.setup.connectingBody')}</Text>
              <ActivityIndicator size="small" color={colors.primary} style={styles.connectingSpinner} />
            </View>
          ) : !brand ? (
            /* ── Screen 1: which TV? ───────────────────────────────────────── */
            loaded && (
              <>
                <Text style={styles.subtitle}>{t('tv.setup.subtitle')}</Text>
                <Text style={styles.sectionTitle}>{t('tv.setup.whichTv')}</Text>
                <View style={styles.brandGrid}>
                  {TV_BRANDS.map((b) => (
                    <TouchableOpacity key={b.id} style={styles.brandCard} activeOpacity={0.85} onPress={() => pickBrand(b)}>
                      <View style={styles.brandIcon}>
                        <Ionicons name={b.icon as any} size={22} color={colors.primary} />
                      </View>
                      <Text style={styles.brandLabel} numberOfLines={2}>
                        {b.label ?? t('tv.setup.notSure')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )
          ) : (
            /* ── Screen 2: connect ─────────────────────────────────────────── */
            <>
              {/* Selected TV + change */}
              <View style={styles.tvChip}>
                <Ionicons name={brand.icon as any} size={18} color={colors.primary} />
                <View style={styles.tvChipInfo}>
                  <Text style={styles.tvChipLabel}>{t('tv.setup.yourTv')}</Text>
                  <Text style={styles.tvChipName}>{brand.label ?? t('tv.setup.notSure')}</Text>
                </View>
                <TouchableOpacity onPress={() => setBrand(null)} style={styles.changeBtn}>
                  <Text style={styles.changeText}>{t('tv.setup.change')}</Text>
                </TouchableOpacity>
              </View>

              {/* Three tiny steps */}
              {([
                ['power', t('tv.setup.stepOn')],
                ['wifi', t('tv.setup.stepWifi')],
                ['radio-button-on', t('tv.setup.stepPick')],
              ] as const).map(([icon, label], i) => (
                <View key={icon} style={styles.stepRow}>
                  <View style={styles.stepNum}><Text style={styles.stepNumText}>{i + 1}</Text></View>
                  <Ionicons name={icon as any} size={16} color={colors.textSecondary} />
                  <Text style={styles.stepText}>{label}</Text>
                </View>
              ))}

              {/* Connect buttons — best transport first */}
              <View style={styles.connectArea}>
                {transports.length === 0 && (
                  <View style={styles.noteCard}>
                    <Ionicons name="information-circle" size={18} color={colors.primary} />
                    <Text style={styles.noteText}>{t('tv.setup.needsCast')}</Text>
                  </View>
                )}

                {transports.map((tr) => {
                  if (tr === 'airplay') {
                    return airplaySupported ? (
                      /* onTouchStart: the tap lands on the INVISIBLE native
                         button, so nothing in our JS acknowledges it — a
                         haptic tick is the instant "got it" while the system
                         picker spins up. */
                      <View key="airplay" style={styles.primaryWrap} onTouchStart={() => selection()}>
                        <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                          <Ionicons name="tv-outline" size={18} color="#fff" />
                          <Text style={styles.primaryText}>{t('tv.setup.connectAirplay')}</Text>
                        </LinearGradient>
                        {/* The REAL AirPlay picker button, invisible, across the
                            pill. Invisibility comes from opacity, NOT tint —
                            iOS ignores a "transparent" tint and draws the glyph
                            black. 0.02 stays above UIKit's 0.01 hit-test cutoff,
                            so taps still land. */}
                        <VideoAirPlayButton
                          tint="transparent"
                          activeTint="transparent"
                          style={[StyleSheet.absoluteFill, { opacity: 0.02 }]}
                        />
                        <Text style={styles.hintText}>{t('tv.setup.airplayAfter')}</Text>
                      </View>
                    ) : (
                      <View key="airplay" style={styles.noteCard}>
                        <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />
                        <Text style={styles.noteText}>{t('tv.setup.updateSoon')}</Text>
                      </View>
                    );
                  }
                  // tr === 'cast'
                  return CastNativeButton ? (
                    /* onTouchStart: same instant haptic ack as the AirPlay
                       pill — the native Cast dialog can take a beat to show. */
                    <View key="cast" style={styles.primaryWrap} onTouchStart={() => selection()}>
                      <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                        <Ionicons name="logo-google" size={18} color="#fff" />
                        <Text style={styles.primaryText}>{t('tv.setup.connectCast')}</Text>
                      </LinearGradient>
                      {/* The REAL Cast button, invisible, across the pill (iOS 14+
                          only honors taps on a genuine Cast button). Hidden via
                          opacity — iOS ignores a "transparent" tint and draws
                          the glyph black; 0.02 stays above UIKit's 0.01
                          hit-test cutoff, so taps still land. */}
                      <CastNativeButton
                        tintColor="transparent"
                        style={[StyleSheet.absoluteFill, { opacity: 0.02 }]}
                      />
                      <View style={styles.statusRow}>
                        {cast.available ? (
                          <>
                            <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                            <Text style={styles.statusText}>{t('tv.setup.found')}</Text>
                          </>
                        ) : (
                          <>
                            <ActivityIndicator size="small" color={colors.textTertiary} />
                            <Text style={styles.statusText}>{t('tv.setup.searching')}</Text>
                          </>
                        )}
                      </View>
                    </View>
                  ) : (
                    <View key="cast" style={styles.noteCard}>
                      <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />
                      <Text style={styles.noteText}>{t('tv.setup.updateSoon')}</Text>
                    </View>
                  );
                })}
              </View>

              {/* Trouble footer */}
              <View style={styles.trouble}>
                <Text style={styles.troubleTitle}>{t('tv.setup.troubleTitle')}</Text>
                <Text style={styles.troubleBody}>{t('tv.setup.troubleBody')}</Text>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingTop: 14, paddingBottom: 8,
  },
  titleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.2 },
  closeBtn: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: c.surfaceLight,
    alignItems: 'center', justifyContent: 'center',
  },
  content: { paddingHorizontal: SPACING.md, paddingBottom: 40 },
  subtitle: { color: c.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 4 },
  sectionTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginTop: SPACING.lg, marginBottom: SPACING.sm },

  // Brand grid
  brandGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  brandCard: {
    width: '48%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: RADIUS.md, padding: 12,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
  },
  brandIcon: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: c.surfaceLight,
    alignItems: 'center', justifyContent: 'center',
  },
  brandLabel: { flex: 1, color: c.text, fontSize: 13, fontWeight: '600' },

  // Selected TV chip
  tvChip: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: RADIUS.md, padding: 12, marginTop: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, marginBottom: SPACING.md,
  },
  tvChipInfo: { flex: 1 },
  tvChipLabel: { color: c.textTertiary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  tvChipName: { color: c.text, fontSize: 15, fontWeight: '700', marginTop: 1 },
  changeBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADIUS.full, backgroundColor: c.surfaceLight },
  changeText: { color: c.primary, fontSize: 12, fontWeight: '700' },

  // Steps
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  stepNum: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: c.surfaceLight,
    alignItems: 'center', justifyContent: 'center',
  },
  stepNumText: { color: c.primary, fontSize: 12, fontWeight: '800' },
  stepText: { flex: 1, color: c.textSecondary, fontSize: 13.5, lineHeight: 19 },

  // Connect buttons
  connectArea: { marginTop: SPACING.md, gap: SPACING.sm },
  primaryWrap: { marginTop: 4, alignSelf: 'stretch' },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: RADIUS.full, paddingVertical: 15,
  },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  hintText: { color: c.textTertiary, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 },
  statusText: { color: c.textTertiary, fontSize: 12, fontWeight: '600' },
  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, padding: 12,
  },
  noteText: { flex: 1, color: c.textSecondary, fontSize: 13, lineHeight: 18 },

  // Trouble footer
  trouble: { marginTop: SPACING.xl, gap: 4 },
  troubleTitle: { color: c.text, fontSize: 13, fontWeight: '700' },
  troubleBody: { color: c.textTertiary, fontSize: 12.5, lineHeight: 18 },

  // Done + connecting screens
  doneWrap: { alignItems: 'center', paddingTop: 40, gap: 10 },
  connectingSpinner: { marginTop: 6 },
  doneCircle: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  doneTitle: { color: c.text, fontSize: 20, fontWeight: '800' },
  doneBody: { color: c.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 20 },
  linkBtn: { paddingVertical: 10 },
  linkText: { color: c.textTertiary, fontSize: 13, fontWeight: '600' },
});
