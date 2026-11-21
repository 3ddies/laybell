import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, ActivityIndicator,
  ScrollView, Animated, Easing,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import { GRADIENTS, RADIUS, SHADOWS, SPACING, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { ListRowsSkeleton } from '../../components/Skeleton';
import {
  createStudioSession, fetchLiveStudioSessions, fetchMySessions, joinByCode,
  type LiveStudioSession, type StudioSession,
} from '../../lib/studio';

// Studio hub: your open sessions, start a new one, or join with a code —
// Laybell as the connector for online studio sessions. Broadcasting sessions
// show up in a "Live now" rail anyone can tune into.

// The breathing dot on a LIVE pill. Native-driven opacity+scale loop so it keeps
// pulsing smoothly even while the live rail is being flicked sideways. Module
// scope (never defined in render) so the rail can mount one per card cheaply.
function LiveDot() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 720, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(a, { toValue: 0, duration: 720, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] });
  const opacity = a.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] });
  return (
    <View style={dot.wrap}>
      <Animated.View style={[dot.ping, { transform: [{ scale }], opacity }]} />
      <View style={dot.core} />
    </View>
  );
}

// The dot is always white on the red LIVE pill — theme-independent, so it owns a
// module-scope sheet (the themed `styles` below is created inside the screen and
// isn't visible from here).
const dot = StyleSheet.create({
  wrap: { width: 6, height: 6, alignItems: 'center', justifyContent: 'center' },
  ping: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  core: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
});

export default function StudioHubScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [sessions, setSessions] = useState<StudioSession[]>([]);
  const [liveNow, setLiveNow] = useState<LiveStudioSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mine, live] = await Promise.all([fetchMySessions(), fetchLiveStudioSessions()]);
      setSessions(mine);
      setLiveNow(live);
    } catch { /* pre-migration */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // A live broadcast I'm already a member of opens the session room; everyone
  // else tunes in as a listener.
  function openLive(s: LiveStudioSession) {
    Haptics.selectionAsync().catch(() => {});
    if (sessions.some((mine) => mine.id === s.id)) router.push(`/studio/${s.id}`);
    else router.push(`/studio/listen/${s.id}`);
  }

  async function onCreate() {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setBusy('create');
    setError(null);
    try {
      const session = await createStudioSession(title.trim());
      router.push(`/studio/${session.id}`);
    } catch {
      setError(t('studio.error'));
    }
    setBusy(null);
  }

  async function onJoin() {
    if (busy || !code.trim()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setBusy('join');
    setError(null);
    try {
      const sessionId = await joinByCode(code.trim());
      setCode('');
      router.push(`/studio/${sessionId}`);
    } catch (e) {
      setError((e as Error).message === 'invalid_code' ? t('studio.invalidCode') : t('studio.error'));
    }
    setBusy(null);
  }

  const canJoin = !!code.trim() && busy !== 'join';

  return (
    <SwipeBackPager
      // Horizontal swipe-back is OFF here. Mid-way through creating a session, a stray swipe throws the setup away.
      // The header back button and the hardware/gesture back still work, and
      // both route through this screen's own confirm — so leaving stays a
      // decision rather than a twitch.
      swipeBackEnabled={false}
    >
      <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('studio.title')}</Text>
          <View style={styles.headerBtn} />
        </View>

        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <View style={styles.top}>
              {/* Live studio broadcasts — modern radio, tap to tune in */}
              {liveNow.length > 0 && (
                <View style={styles.liveWrap}>
                  <Text style={styles.sectionLabel}>{t('studio.liveNow')}</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.liveRail}>
                    {liveNow.map((s) => (
                      <TouchableOpacity key={s.id} style={styles.liveCard} onPress={() => openLive(s)} activeOpacity={0.85}>
                        <View style={styles.liveCardTop}>
                          {s.host_avatar_url ? (
                            <ExpoImage source={{ uri: s.host_avatar_url }} style={styles.liveAvatar} contentFit="cover" cachePolicy="memory-disk" />
                          ) : (
                            <LinearGradient colors={GRADIENTS.avatar} style={styles.liveAvatar}>
                              <Ionicons name="mic" size={16} color="#fff" />
                            </LinearGradient>
                          )}
                          <View style={styles.liveTag}>
                            <LiveDot />
                            <Text style={styles.liveTagText}>{t('studio.liveTag')}</Text>
                          </View>
                        </View>
                        <Text style={styles.liveTitle} numberOfLines={1}>{s.title || t('studio.untitled')}</Text>
                        <Text style={styles.liveHost} numberOfLines={1}>
                          {s.host_display_name || s.host_username || ''}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* New session — the primary action, dressed as the hero card */}
              <View style={[styles.card, styles.primaryCard]}>
                <Text style={styles.primaryCardTitle}>{t('studio.newSession')}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={t('studio.sessionTitlePlaceholder')}
                  placeholderTextColor={colors.textMeta}
                  value={title}
                  onChangeText={setTitle}
                  maxLength={80}
                  returnKeyType="go"
                  onSubmitEditing={onCreate}
                />
                <TouchableOpacity onPress={onCreate} disabled={busy !== null} activeOpacity={0.85} style={styles.primaryBtn}>
                  <LinearGradient colors={GRADIENTS.logo} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryBtnBg}>
                    {busy === 'create' ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="mic-outline" size={18} color="#fff" />
                        <Text style={styles.primaryBtnText}>{t('studio.create')}</Text>
                      </>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
              </View>

              {/* or */}
              <View style={styles.orRow}>
                <Text style={styles.orText}>{t('auth.or')}</Text>
              </View>

              {/* Join with a code — lighter secondary card */}
              <View style={styles.card}>
                <View style={styles.cardHead}>
                  <View style={styles.cardIconMuted}>
                    <Ionicons name="enter-outline" size={19} color={colors.text} />
                  </View>
                  <View style={styles.cardHeadText}>
                    <Text style={styles.cardTitle}>{t('studio.joinCode')}</Text>
                  </View>
                </View>
                <View style={styles.joinRow}>
                  <TextInput
                    style={[styles.input, styles.codeInput]}
                    placeholder={t('studio.codePlaceholder')}
                    placeholderTextColor={colors.textMeta}
                    value={code}
                    onChangeText={(v) => setCode(v.toUpperCase())}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={8}
                    returnKeyType="go"
                    onSubmitEditing={onJoin}
                  />
                  <TouchableOpacity onPress={onJoin} disabled={!canJoin} activeOpacity={0.85} style={styles.joinBtn}>
                    {canJoin ? (
                      <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.joinBtnFill}>
                        <Ionicons name="arrow-forward" size={20} color="#fff" />
                      </LinearGradient>
                    ) : (
                      <View style={[styles.joinBtnFill, { backgroundColor: colors.surfaceLight }]}>
                        {busy === 'join'
                          ? <ActivityIndicator color={colors.text} />
                          : <Ionicons name="arrow-forward" size={20} color={colors.textMeta} />}
                      </View>
                    )}
                  </TouchableOpacity>
                </View>
              </View>

              {!!error && (
                <View style={styles.errorRow}>
                  <Ionicons name="alert-circle" size={15} color={colors.error} />
                  <Text style={styles.error}>{error}</Text>
                </View>
              )}
              {sessions.length > 0 && <Text style={styles.sectionLabel}>{t('studio.yourSessions')}</Text>}
              {loading && <ListRowsSkeleton />}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.sessionRow} onPress={() => router.push(`/studio/${item.id}`)} activeOpacity={0.75}>
              <View style={styles.sessionIcon}>
                <Ionicons name="headset-outline" size={19} color={colors.text} />
              </View>
              <View style={styles.sessionTextWrap}>
                <Text style={styles.sessionTitle} numberOfLines={1}>
                  {item.title || t('studio.untitled')}
                </Text>
                <Text style={styles.sessionSub}>{t('studio.codeLabel', { code: item.join_code })}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMeta} />
            </TouchableOpacity>
          )}
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.sm, height: 44 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  listContent: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: 48 },
  top: { gap: SPACING.md, marginBottom: SPACING.xs },

  // Cards
  card: {
    backgroundColor: c.surface, borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    padding: SPACING.md, gap: SPACING.md,
  },
  primaryCard: { ...SHADOWS.sm },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardHeadText: { flex: 1, gap: 2 },
  cardIconMuted: {
    width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.surfaceLight,
  },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  primaryCardTitle: { color: c.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },

  input: {
    backgroundColor: c.surfaceLight, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, minHeight: 50, color: c.text, fontSize: 16,
  },

  // New session CTA
  primaryBtn: { borderRadius: RADIUS.full, overflow: 'hidden', ...SHADOWS.sm },
  primaryBtnBg: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },

  // "or" divider between the two actions — just the word, centered
  orRow: { alignItems: 'center', justifyContent: 'center' },
  orText: { color: c.textMeta, fontSize: 16, fontWeight: '700' },

  // Join with a code
  joinRow: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'stretch' },
  codeInput: { flex: 1, textAlign: 'center', letterSpacing: 6, fontSize: 20, fontWeight: '800' },
  joinBtn: { width: 54, height: 54, borderRadius: RADIUS.md, overflow: 'hidden' },
  joinBtnFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Live now rail
  sectionLabel: { color: c.textMeta, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },
  liveWrap: { gap: SPACING.sm },
  liveRail: { gap: SPACING.sm, paddingRight: SPACING.xs },
  liveCard: {
    width: 166, backgroundColor: c.surface, borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12, gap: 6,
    ...SHADOWS.sm,
  },
  liveCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  liveAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.surfaceLight },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.error, borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 4 },
  liveTagText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  liveTitle: { color: c.text, fontSize: 13, fontWeight: '700', marginTop: 2 },
  liveHost: { color: c.textMeta, fontSize: 11 },

  // Your sessions
  sessionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface,
    borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12,
  },
  sessionIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  sessionTextWrap: { flex: 1, gap: 2 },
  sessionTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  sessionSub: { color: c.textMeta, fontSize: 12 },

  // States
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  error: { color: c.error, fontSize: 13, flex: 1 },
});
