import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Modal, Image, Alert, Keyboard, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import SwipeBackPager from '../../components/SwipeBackPager';
import BadgeEmblem from '../../components/BadgeEmblem';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useProfile } from '../../contexts/ProfileContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../../constants/theme';
import { supabase } from '../../lib/supabase';
import { GENRES, genreLabel } from '../../lib/genres';
import { fetchCommunity, updateCommunity, inviteMembers, type Community } from '../../lib/communities';
import { Skeleton, SkeletonLine, SkeletonCircle } from '../../components/Skeleton';

type Invitee = { id: string; username?: string | null; display_name?: string | null; avatar_url?: string | null; badge_tier?: string | null; badge_show?: boolean | null };

// Normalize a typed hashtag the same way the server does (alphanumeric, lowercase).
function normHashtag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export default function EditCommunityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { profile } = useProfile();
  const userId = profile?.id ?? null;

  const [community, setCommunity] = useState<Community | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [nameState, setNameState] = useState<'idle' | 'checking' | 'ok' | 'taken'>('idle');
  const [hashtag, setHashtag] = useState('');
  const [hashtagState, setHashtagState] = useState<'idle' | 'checking' | 'ok' | 'taken'>('idle');
  const [genre, setGenre] = useState('');
  const [showGenre, setShowGenre] = useState(false);
  const [guidelines, setGuidelines] = useState('');
  const [bannerUrl, setBannerUrl] = useState<string | null>(null); // saved banner
  const [localBanner, setLocalBanner] = useState<string | null>(null); // newly picked, not yet uploaded

  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  // Field refs (tap a label/element to edit it) + keyboard gating for the genre
  // picker so it never opens a modal over a live keyboard mid-typing.
  const nameRef = useRef<TextInput>(null);
  const hashtagRef = useRef<TextInput>(null);
  const guidelinesRef = useRef<TextInput>(null);
  const searchRef = useRef<TextInput>(null);
  // Scroll-into-view: record each scrollable field's y, and when the keyboard
  // shows, scroll the focused field so its WHOLE box sits above the keyboard.
  const scrollRef = useRef<ScrollView>(null);
  const fieldY = useRef<Record<string, number>>({});
  const pendingField = useRef<string | null>(null);
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const s = Keyboard.addListener('keyboardDidShow', () => {
      setKbVisible(true);
      const key = pendingField.current;
      if (key && fieldY.current[key] != null) {
        const to = () => scrollRef.current?.scrollTo({ y: Math.max(0, (fieldY.current[key] ?? 0) - 12), animated: true });
        to();
        setTimeout(to, 60); // re-assert after iOS's own keyboard-inset auto-scroll
      }
    });
    const h = Keyboard.addListener('keyboardDidHide', () => setKbVisible(false));
    return () => { s.remove(); h.remove(); };
  }, []);
  // Remember which field to reveal (null = a top field that needs no scroll). If
  // the keyboard is already up (switching fields), scroll right away.
  function focusField(key: string | null) {
    pendingField.current = key;
    if (key && kbVisible && fieldY.current[key] != null) {
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, (fieldY.current[key] ?? 0) - 12), animated: true }));
    }
  }
  function openGenre() {
    if (kbVisible) { Keyboard.dismiss(); return; }
    setShowGenre(true);
  }

  useEffect(() => {
    (async () => {
      const c = await fetchCommunity(id, userId);
      setCommunity(c);
      if (c) {
        setName(c.name);
        setHashtag(c.hashtag);
        setGenre(c.genre);
        setGuidelines(c.guidelines ?? '');
        setBannerUrl(c.banner_url ?? null);
      }
      setLoading(false);
    })();
  }, [id, userId]);

  // Name availability (excluding self).
  useEffect(() => {
    const n = name.trim();
    if (!community || n.length < 2) { setNameState('idle'); return; }
    if (n.toLowerCase() === community.name.toLowerCase()) { setNameState('idle'); return; }
    setNameState('checking');
    const h = setTimeout(async () => {
      try {
        const { data } = await supabase.from('communities').select('id').ilike('name', n).neq('id', id).maybeSingle();
        setNameState(data ? 'taken' : 'ok');
      } catch { setNameState('ok'); }
    }, 400);
    return () => clearTimeout(h);
  }, [name, community, id]);

  // Hashtag availability (excluding self).
  useEffect(() => {
    const hv = normHashtag(hashtag);
    if (!community || hv.length < 2) { setHashtagState('idle'); return; }
    if (hv === community.hashtag.toLowerCase()) { setHashtagState('idle'); return; }
    setHashtagState('checking');
    const h = setTimeout(async () => {
      try {
        const { data } = await supabase.from('communities').select('id').ilike('hashtag', hv).neq('id', id).maybeSingle();
        setHashtagState(data ? 'taken' : 'ok');
      } catch { setHashtagState('ok'); }
    }, 400);
    return () => clearTimeout(h);
  }, [hashtag, community, id]);

  // People search for the invite picker.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) { setResults([]); return; }
    const h = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, badge_tier, badge_show, hidden')
          .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
          .limit(15);
        const taken = new Set(invitees.map((i) => i.id));
        setResults(((data as any[]) ?? []).filter((p) => !p.hidden && p.id !== userId && !taken.has(p.id)));
      } catch { setResults([]); }
      setSearching(false);
    }, 400);
    return () => clearTimeout(h);
  }, [query, invitees, userId]);

  async function pickBanner() {
    const ImagePicker = await import('expo-image-picker');
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [16, 9], quality: 0.9,
    });
    if (!res.canceled && res.assets[0]) setLocalBanner(res.assets[0].uri);
  }

  async function uploadBanner(uri: string): Promise<string> {
    // Downscale to a reasonable banner width, then upload under the owner's
    // folder in the public `posts` bucket (its RLS keys uploads to your own uid).
    const out = await manipulateAsync(uri, [{ resize: { width: 1280 } }], { compress: 0.85, format: SaveFormat.JPEG });
    const path = `${userId}/community-${id}-${Date.now()}.jpg`;
    const form = new FormData();
    form.append('file', { uri: out.uri, name: 'banner.jpg', type: 'image/jpeg' } as any);
    const { error } = await supabase.storage.from('posts').upload(path, form, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    return supabase.storage.from('posts').getPublicUrl(path).data.publicUrl;
  }

  const canSave = name.trim().length >= 2 && nameState !== 'taken' && hashtagState !== 'taken'
    && normHashtag(hashtag).length >= 2 && !!genre && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    let finalBanner = bannerUrl;
    if (localBanner) {
      try { finalBanner = await uploadBanner(localBanner); }
      catch { setSaving(false); Alert.alert(t('communities.editTitle'), t('communities.bannerUploadFailed')); return; }
    }
    const res = await updateCommunity({
      id, name: name.trim(), hashtag: normHashtag(hashtag), genre, guidelines, bannerUrl: finalBanner,
    });
    if (res.error) { setSaving(false); Alert.alert(t('communities.editTitle'), t(res.error)); return; }
    if (invitees.length) await inviteMembers(id, invitees.map((i) => i.id));
    setSaving(false);
    router.back();
  }

  const previewBanner = localBanner ?? bannerUrl;

  if (loading) {
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <Ionicons name="chevron-back" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('communities.editTitle')}</Text>
            <View style={styles.headerBtn} />
          </View>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {/* Banner field */}
            <View style={styles.field}>
              <SkeletonLine w={70} h={10} />
              <Skeleton width="100%" height={130} radius={RADIUS.md} />
            </View>
            {/* Name field */}
            <View style={styles.field}>
              <SkeletonLine w={60} h={10} />
              <Skeleton width="100%" height={50} radius={RADIUS.md} />
            </View>
            {/* Hashtag field */}
            <View style={styles.field}>
              <SkeletonLine w={80} h={10} />
              <Skeleton width="100%" height={50} radius={RADIUS.md} />
            </View>
            {/* Genre field */}
            <View style={styles.field}>
              <SkeletonLine w={64} h={10} />
              <Skeleton width="100%" height={50} radius={RADIUS.md} />
            </View>
            {/* Guidelines field */}
            <View style={styles.field}>
              <SkeletonLine w={90} h={10} />
              <Skeleton width="100%" height={88} radius={RADIUS.md} />
            </View>
            {/* Invite field */}
            <View style={styles.field}>
              <SkeletonLine w={110} h={10} />
              <Skeleton width="100%" height={44} radius={RADIUS.full} />
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.resultRow}>
                  <SkeletonCircle size={40} />
                  <View style={styles.resultInfo}>
                    <SkeletonLine w="55%" h={12} />
                    <SkeletonLine w="35%" h={10} style={{ marginTop: 4 }} />
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      </SwipeBackPager>
    );
  }

  if (!community || community.myRole !== 'owner') {
    return (
      <SwipeBackPager>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <Ionicons name="chevron-back" size={26} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{t('communities.editTitle')}</Text>
            <View style={styles.headerBtn} />
          </View>
          <View style={styles.centered}>
            <Ionicons name="lock-closed-outline" size={44} color={colors.textTertiary} />
            <Text style={styles.gateSub}>{t('communities.errGeneric')}</Text>
          </View>
        </View>
      </SwipeBackPager>
    );
  }

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.back')} style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('communities.editTitle')}</Text>
          <TouchableOpacity style={styles.headerAction} onPress={save} disabled={!canSave}>
            {saving ? <ActivityIndicator color={colors.primary} size="small" />
              : <Text style={[styles.headerActionText, !canSave && { color: colors.textTertiary }]}>{t('communities.save')}</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          showsVerticalScrollIndicator={false}
        >
          {/* Banner */}
          <View style={styles.field}>
            <TouchableOpacity onPress={pickBanner} activeOpacity={0.6}>
              <Text style={styles.label}>{t('communities.banner')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.bannerBox} onPress={pickBanner} activeOpacity={0.85}>
              {previewBanner ? (
                <Image source={{ uri: previewBanner }} style={styles.bannerImg} />
              ) : (
                <LinearGradient colors={GRADIENTS.card as any} style={styles.bannerImg}>
                  <Ionicons name="image-outline" size={28} color={colors.textTertiary} />
                  <Text style={styles.bannerHint}>{t('communities.addBanner')}</Text>
                </LinearGradient>
              )}
              <View style={styles.bannerEditBadge}>
                <Ionicons name="camera" size={14} color="#fff" />
                <Text style={styles.bannerEditText}>{t('communities.changeBanner')}</Text>
              </View>
            </TouchableOpacity>
            {previewBanner && (
              <TouchableOpacity onPress={() => { setLocalBanner(null); setBannerUrl(null); }} hitSlop={6}>
                <Text style={styles.removeBannerText}>{t('communities.removeBanner')}</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Name */}
          <View style={styles.field}>
            <Text style={styles.label}>{t('communities.name')}</Text>
            <View style={styles.inputRow}>
              <TextInput
                ref={nameRef}
                style={styles.input}
                value={name}
                onChangeText={setName}
                onFocus={() => focusField(null)}
                placeholder={t('communities.namePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                maxLength={40}
                autoCapitalize="words"
              />
              {nameState === 'checking' && <ActivityIndicator size="small" color={colors.textTertiary} />}
              {nameState === 'ok' && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
              {nameState === 'taken' && <Ionicons name="close-circle" size={20} color={colors.error} />}
            </View>
            {nameState === 'taken' && <Text style={styles.errText}>{t('communities.nameTaken')}</Text>}
          </View>

          {/* Hashtag */}
          <View style={styles.field}>
            <Text style={styles.label}>{t('communities.hashtag')}</Text>
            <View style={styles.inputRow}>
              <Text style={styles.hashPrefix}>#</Text>
              <TextInput
                ref={hashtagRef}
                style={styles.input}
                value={hashtag}
                onChangeText={(v) => setHashtag(normHashtag(v))}
                onFocus={() => focusField(null)}
                placeholder="rapaddicts"
                placeholderTextColor={colors.textTertiary}
                maxLength={30}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {hashtagState === 'checking' && <ActivityIndicator size="small" color={colors.textTertiary} />}
              {hashtagState === 'ok' && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
              {hashtagState === 'taken' && <Ionicons name="close-circle" size={20} color={colors.error} />}
            </View>
            {hashtagState === 'taken'
              ? <Text style={styles.errText}>{t('communities.hashtagTaken')}</Text>
              : <Text style={styles.hint}>{t('communities.hashtagHint')}</Text>}
          </View>

          {/* Genre — only the dropdown control opens the picker (gated so it
              won't open over a live keyboard); the label/row aren't tappable. */}
          <View style={styles.field}>
            <Text style={styles.label}>{t('communities.genre')}</Text>
            <TouchableOpacity style={styles.dropdown} onPress={openGenre} activeOpacity={0.8}>
              <Text style={[styles.dropdownText, !genre && styles.dropdownPlaceholder]}>
                {genre ? genreLabel(genre) : t('communities.selectGenre')}
              </Text>
              <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {/* Guidelines */}
          <View style={styles.field} onLayout={(e) => { fieldY.current.guidelines = e.nativeEvent.layout.y; }}>
            <Text style={styles.label}>{t('communities.guidelines')}</Text>
            <TextInput
              ref={guidelinesRef}
              style={styles.textarea}
              value={guidelines}
              onChangeText={setGuidelines}
              onFocus={() => focusField('guidelines')}
              placeholder={t('communities.guidelinesPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              multiline
              maxLength={1000}
              textAlignVertical="top"
            />
          </View>

          {/* Invite more people */}
          <View style={styles.field} onLayout={(e) => { fieldY.current.invite = e.nativeEvent.layout.y; }}>
            <Text style={styles.label}>{t('communities.inviteMore')}</Text>
            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
              <TextInput
                ref={searchRef}
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                onFocus={() => focusField('invite')}
                placeholder={t('communities.inviteSearchPlaceholder')}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searching && <ActivityIndicator size="small" color={colors.textTertiary} />}
            </View>

            {results.map((p) => (
              <TouchableOpacity key={p.id} style={styles.resultRow} onPress={() => { setInvitees((prev) => [...prev, p]); setQuery(''); setResults([]); }} activeOpacity={0.8}>
                {p.avatar_url ? (
                  <Image source={{ uri: p.avatar_url }} style={styles.avatar} />
                ) : (
                  <LinearGradient colors={GRADIENTS.avatar} style={styles.avatar}>
                    <Text style={styles.avatarInitial}>{p.display_name?.charAt(0)?.toUpperCase() ?? '?'}</Text>
                  </LinearGradient>
                )}
                <View style={styles.resultInfo}>
                  <View style={styles.nameLine}>
                    <Text style={styles.resultName} numberOfLines={1}>{p.display_name ?? p.username}</Text>
                    <BadgeEmblem profile={p} size={12} />
                  </View>
                  <Text style={styles.resultUser} numberOfLines={1}>@{p.username}</Text>
                </View>
                <Ionicons name="add-circle" size={24} color={colors.primary} />
              </TouchableOpacity>
            ))}

            {invitees.length > 0 && (
              <View style={styles.inviteeList}>
                {invitees.map((i) => (
                  <View key={i.id} style={styles.inviteeRow}>
                    {i.avatar_url ? (
                      <Image source={{ uri: i.avatar_url }} style={styles.avatarSm} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.avatar} style={styles.avatarSm}>
                        <Text style={styles.avatarInitialSm}>{i.display_name?.charAt(0)?.toUpperCase() ?? '?'}</Text>
                      </LinearGradient>
                    )}
                    <View style={styles.resultInfo}>
                      <Text style={styles.resultName} numberOfLines={1}>{i.display_name ?? i.username}</Text>
                      <Text style={styles.resultUser} numberOfLines={1}>@{i.username}</Text>
                    </View>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} onPress={() => setInvitees((prev) => prev.filter((x) => x.id !== i.id))} hitSlop={8}>
                      <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View style={{ height: SPACING.xxl }} />
        </ScrollView>

        {/* Genre picker */}
        <Modal visible={showGenre} transparent animationType="fade" onRequestClose={() => setShowGenre(false)}>
          <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setShowGenre(false)}>
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>{t('communities.selectGenre')}</Text>
              <ScrollView contentContainerStyle={styles.chipWrap} keyboardShouldPersistTaps="handled">
                {GENRES.map((g) => {
                  const value = g.toLowerCase();
                  const active = genre === value;
                  return (
                    <TouchableOpacity key={g} style={[styles.chip, active && styles.chipActive]} onPress={() => { setGenre(value); setShowGenre(false); }}>
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{genreLabel(g)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.sm,
  },
  headerBtn: { width: 56, height: 36, justifyContent: 'center' },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  headerAction: { width: 56, alignItems: 'flex-end', paddingRight: SPACING.xs },
  headerActionText: { color: colors.primary, fontSize: 16, fontWeight: '700' },

  content: { padding: SPACING.md, gap: SPACING.lg, flexGrow: 1 },
  field: { gap: 8 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  hint: { color: colors.textTertiary, fontSize: 12 },

  bannerBox: { height: 130, borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border },
  bannerImg: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', gap: 6 },
  bannerHint: { color: colors.textTertiary, fontSize: 13, fontWeight: '600' },
  bannerEditBadge: {
    position: 'absolute', right: SPACING.sm, bottom: SPACING.sm,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: RADIUS.full, paddingHorizontal: SPACING.sm, paddingVertical: 5,
  },
  bannerEditText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  removeBannerText: { color: colors.error, fontSize: 13, fontWeight: '600' },

  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
  },
  hashPrefix: { color: colors.textSecondary, fontSize: 16, fontWeight: '800' },
  input: { flex: 1, paddingVertical: SPACING.md, color: colors.text, fontSize: 15 },
  errText: { color: colors.error, fontSize: 12 },

  dropdown: {
    flexDirection: 'row', alignItems: 'center', minHeight: 50,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
  },
  dropdownText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  dropdownPlaceholder: { color: colors.textTertiary, fontWeight: '500' },

  textarea: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.md, minHeight: 88, color: colors.text, fontSize: 15,
  },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: colors.borderStrong, paddingHorizontal: SPACING.md,
  },
  searchInput: { flex: 1, paddingVertical: SPACING.sm + 2, color: colors.text, fontSize: 15 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.xs },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarInitial: { color: '#fff', fontSize: 16, fontWeight: '700' },
  resultInfo: { flex: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  resultName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  resultUser: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  inviteeList: { gap: SPACING.xs, marginTop: SPACING.xs },
  inviteeRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  avatarSm: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarInitialSm: { color: '#fff', fontSize: 14, fontWeight: '700' },

  gateSub: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl, maxHeight: '70%' },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: SPACING.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, paddingBottom: SPACING.sm },
  chip: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADIUS.full, backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary + '22', borderColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.primary },
});
