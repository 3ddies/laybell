import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, ActivityIndicator, Image, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import SwipeBackPager from '../../components/SwipeBackPager';
import { GRADIENTS, type ThemePalette } from '../../constants/theme';
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
    if (sessions.some((mine) => mine.id === s.id)) router.push(`/studio/${s.id}`);
    else router.push(`/studio/listen/${s.id}`);
  }

  async function onCreate() {
    if (busy) return;
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

  return (
    <SwipeBackPager>
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
                            <Image source={{ uri: s.host_avatar_url }} style={styles.liveAvatar} />
                          ) : (
                            <LinearGradient colors={GRADIENTS.primary} style={styles.liveAvatar}>
                              <Ionicons name="mic" size={16} color="#fff" />
                            </LinearGradient>
                          )}
                          <View style={styles.liveTag}>
                            <View style={styles.liveTagDot} />
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

              {/* New session */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('studio.newSession')}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={t('studio.sessionTitlePlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  value={title}
                  onChangeText={setTitle}
                  maxLength={80}
                />
                <TouchableOpacity onPress={onCreate} disabled={busy !== null} activeOpacity={0.85} style={styles.primaryBtn}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnBg}>
                    {busy === 'create' ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="mic-outline" size={17} color="#fff" />
                        <Text style={styles.primaryBtnText}>{t('studio.create')}</Text>
                      </>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
              </View>

              {/* Join with code */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('studio.joinCode')}</Text>
                <View style={styles.joinRow}>
                  <TextInput
                    style={[styles.input, styles.codeInput]}
                    placeholder={t('studio.codePlaceholder')}
                    placeholderTextColor={colors.textTertiary}
                    value={code}
                    onChangeText={(v) => setCode(v.toUpperCase())}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={8}
                    onSubmitEditing={onJoin}
                  />
                  <TouchableOpacity
                    onPress={onJoin}
                    disabled={busy !== null || !code.trim()}
                    style={[styles.joinBtn, (!code.trim() || busy !== null) && { opacity: 0.5 }]}
                  >
                    {busy === 'join'
                      ? <ActivityIndicator color={colors.text} />
                      : <Ionicons name="arrow-forward" size={20} color={colors.text} />}
                  </TouchableOpacity>
                </View>
              </View>

              {!!error && <Text style={styles.error}>{error}</Text>}
              {sessions.length > 0 && <Text style={styles.sectionLabel}>{t('studio.yourSessions')}</Text>}
              {loading && <ListRowsSkeleton />}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.sessionRow} onPress={() => router.push(`/studio/${item.id}`)} activeOpacity={0.8}>
              <View style={styles.sessionIcon}>
                <Ionicons name="headset-outline" size={19} color={colors.text} />
              </View>
              <View style={styles.sessionTextWrap}>
                <Text style={styles.sessionTitle} numberOfLines={1}>
                  {item.title || t('studio.untitled')}
                </Text>
                <Text style={styles.sessionSub}>{t('studio.codeLabel', { code: item.join_code })}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            loading ? null : (
              <Text style={styles.emptyText}>{t('studio.emptyList')}</Text>
            )
          }
        />
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: c.text, fontSize: 17, fontWeight: '700' },
  listContent: { padding: 16, gap: 10, paddingBottom: 40 },
  top: { gap: 12, marginBottom: 6 },
  card: { backgroundColor: c.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 14, gap: 10 },
  cardTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  input: { backgroundColor: c.surfaceLight, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, color: c.text, fontSize: 15 },
  primaryBtn: { borderRadius: 22, overflow: 'hidden' },
  primaryBtnBg: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12 },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  joinRow: { flexDirection: 'row', gap: 8 },
  codeInput: { flex: 1, letterSpacing: 3, fontWeight: '700' },
  joinBtn: { width: 46, borderRadius: 12, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { color: c.textTertiary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8 },
  liveWrap: { gap: 8 },
  liveRail: { gap: 10 },
  liveCard: {
    width: 150, backgroundColor: c.surface, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12, gap: 6,
  },
  liveCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  liveAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F43F5E', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  liveTagDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#fff' },
  liveTagText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
  liveTitle: { color: c.text, fontSize: 13, fontWeight: '700', marginTop: 2 },
  liveHost: { color: c.textTertiary, fontSize: 11 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, padding: 12 },
  sessionIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  sessionTextWrap: { flex: 1, gap: 2 },
  sessionTitle: { color: c.text, fontSize: 14, fontWeight: '600' },
  sessionSub: { color: c.textTertiary, fontSize: 12 },
  emptyText: { color: c.textTertiary, fontSize: 13, textAlign: 'center', marginTop: 18 },
  error: { color: c.error, fontSize: 13 },
});
