import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, FlatList, Image, ActivityIndicator,
  Dimensions, TextInput,
} from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { GENDER_OPTIONS, MIN_AGE } from '../lib/profileOptions';
import { captureAndSaveLocation } from '../lib/location';
import { requestContactsPermission, readContactHashes } from '../lib/contacts';
import { saveOwnPhone, upsertOwnIdentifiers } from '../lib/identifiers';
import { fetchSuggestedAccounts, REASON_LABEL } from '../lib/suggestions';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const GENRES = [
  { id: 'rap', label: 'Rap', icon: '🎤' },
  { id: 'rnb', label: 'R&B', icon: '🎶' },
  { id: 'pop', label: 'Pop', icon: '⭐' },
  { id: 'rock', label: 'Rock', icon: '🎸' },
  { id: 'jazz', label: 'Jazz', icon: '🎷' },
  { id: 'electronic', label: 'Electronic', icon: '🎛️' },
  { id: 'gospel', label: 'Gospel', icon: '🙏' },
  { id: 'afrobeats', label: 'Afrobeats', icon: '🥁' },
  { id: 'lofi', label: 'Lo-Fi', icon: '☁️' },
  { id: 'soul', label: 'Soul', icon: '✨' },
  { id: 'hiphop', label: 'Hip-Hop', icon: '🧢' },
  { id: 'country', label: 'Country', icon: '🤠' },
  { id: 'classical', label: 'Classical', icon: '🎻' },
  { id: 'reggae', label: 'Reggae', icon: '🌿' },
  { id: 'latin', label: 'Latin', icon: '💃' },
  { id: 'drill', label: 'Drill', icon: '🔥' },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [gender, setGender] = useState<string | null>(null);
  const [age, setAge] = useState('');
  const [savingAbout, setSavingAbout] = useState(false);
  // Permissions step (location / contacts / optional phone) — all optional.
  const [locEnabled, setLocEnabled] = useState(false);
  const [contactsEnabled, setContactsEnabled] = useState(false);
  const [obPhone, setObPhone] = useState('');
  const [contactHashes, setContactHashes] = useState<string[]>([]);
  const [permBusy, setPermBusy] = useState<string | null>(null);
  const [selectedGenres, setSelectedGenres] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [finishing, setFinishing] = useState(false);

  function toggleGenre(id: string) {
    setSelectedGenres(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleAboutContinue() {
    const ageNum = parseInt(age, 10);
    if (!gender || isNaN(ageNum) || ageNum < MIN_AGE || ageNum > 120) return;
    setSavingAbout(true);
    const { data: { user } } = await supabase.auth.getUser();
    // Save privately on the profile (no-ops gracefully if the columns aren't
    // migrated yet — the user still proceeds through onboarding).
    if (user) await supabase.from('profiles').update({ gender, age: ageNum }).eq('id', user.id);
    setSavingAbout(false);
    setStep(2);
  }

  async function enableLocationOb() {
    setPermBusy('location');
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const saved = await captureAndSaveLocation(user.id);
      if (saved) setLocEnabled(true);
    }
    setPermBusy(null);
  }

  async function enableContactsOb() {
    setPermBusy('contacts');
    const { data: { user } } = await supabase.auth.getUser();
    const perm = await requestContactsPermission();
    if (perm.granted && user) {
      await supabase.from('profiles').update({ contacts_enabled: true }).eq('id', user.id);
      setContactHashes(await readContactHashes());
      setContactsEnabled(true);
    }
    setPermBusy(null);
  }

  async function handlePermissionsContinue() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user && obPhone.trim()) {
      await saveOwnPhone(obPhone);
      upsertOwnIdentifiers(user.id, user.email, obPhone);
    }
    setStep(3);
  }

  async function handleGenresContinue() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    // 1) Personalized signals: contacts + nearby + mutual follows (empty if none on).
    let personalized: any[] = [];
    try { personalized = await fetchSuggestedAccounts(user.id, { contactHashes, max: 20 }); } catch {}

    // 2) Genre-based accounts (users who post in the chosen genres).
    let genreUsers: any[] = [];
    if (selectedGenres.size > 0) {
      const genreList = Array.from(selectedGenres);
      const { data: tagData } = await supabase
        .from('post_tags').select('posts!inner(user_id)').in('genre', genreList).limit(50);
      const userIds = [...new Set((tagData ?? []).map((t: any) => t.posts?.user_id).filter(Boolean))];
      if (userIds.length > 0) {
        const { data } = await supabase
          .from('profiles').select('id, username, display_name, avatar_url, badge_tier')
          .in('id', userIds).neq('id', user.id).limit(15);
        genreUsers = data ?? [];
      }
    }

    // 3) Fallback to recent accounts if we still have too few.
    let fallback: any[] = [];
    if (personalized.length + genreUsers.length < 3) {
      const { data } = await supabase
        .from('profiles').select('id, username, display_name, avatar_url, badge_tier')
        .neq('id', user.id).limit(20);
      fallback = data ?? [];
    }

    // Merge, de-duped: personalized → genre → fallback.
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const list of [personalized, genreUsers, fallback]) {
      for (const u of list) { if (u && !seen.has(u.id)) { seen.add(u.id); merged.push(u); } }
    }
    setSuggestions(merged);
    setLoading(false);
    setStep(4);
  }

  async function handleFollow(userId: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    setFollowed(prev => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });

    if (followed.has(userId)) {
      await supabase.from('follows').delete()
        .eq('follower_id', user.id).eq('following_id', userId);
    } else {
      await supabase.from('follows').insert({ follower_id: user.id, following_id: userId });
    }
  }

  async function handleFinish() {
    setFinishing(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from('profiles').update({ onboarded: true }).eq('id', user.id);
    }
    router.replace('/(tabs)');
  }

  // Step 0: Welcome
  if (step === 0) {
    return (
      <View style={styles.container}>
        <LinearGradient colors={['#1C0A04', COLORS.background, COLORS.background]} style={styles.welcomeBg}>
          <View style={styles.welcomeContent}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.logoMark}>
              <Ionicons name="musical-notes" size={48} color={COLORS.text} />
            </LinearGradient>
            <Text style={styles.welcomeTitle}>Welcome to{'\n'}Laybell</Text>
            <Text style={styles.welcomeSub}>
              The social platform built for artists, fans, and everyone in between.
            </Text>

            <View style={styles.featureList}>
              {[
                { icon: 'musical-notes-outline', text: 'Share your music and videos' },
                { icon: 'people-outline', text: 'Discover artists in your genre' },
                { icon: 'heart-outline', text: 'Connect with fans worldwide' },
              ].map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <View style={styles.featureIcon}>
                    <Ionicons name={f.icon as any} size={20} color={COLORS.primary} />
                  </View>
                  <Text style={styles.featureText}>{f.text}</Text>
                </View>
              ))}
            </View>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep(1)}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnInner}>
              <Text style={styles.primaryBtnText}>Get Started</Text>
              <Ionicons name="arrow-forward" size={20} color={COLORS.text} />
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>
      </View>
    );
  }

  // Step 1: About you (gender + age) — both required
  if (step === 1) {
    const ageNum = parseInt(age, 10);
    const valid = !!gender && !isNaN(ageNum) && ageNum >= MIN_AGE && ageNum <= 120;
    return (
      <View style={styles.container}>
        <View style={styles.stepHeader}>
          <View style={styles.progressDots}>
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={[styles.dot, i === 0 && styles.dotActive]} />
            ))}
          </View>
          <Text style={styles.stepTitle}>A bit about you</Text>
          <Text style={styles.stepSub}>This helps tailor Laybell. Your gender and age stay private.</Text>
        </View>

        <ScrollView contentContainerStyle={styles.aboutContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Text style={styles.aboutLabel}>Gender</Text>
          <View style={styles.genderGrid}>
            {GENDER_OPTIONS.map(opt => {
              const active = gender === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[styles.genderChip, active && styles.genderChipActive]}
                  onPress={() => setGender(opt)}
                >
                  <Text style={[styles.genderText, active && styles.genderTextActive]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.aboutLabel, { marginTop: SPACING.lg }]}>Age</Text>
          <TextInput
            style={styles.ageInput}
            value={age}
            onChangeText={(t) => setAge(t.replace(/[^0-9]/g, '').slice(0, 3))}
            placeholder="Your age"
            placeholderTextColor={COLORS.textTertiary}
            keyboardType="number-pad"
            maxLength={3}
          />
          <Text style={styles.aboutHint}>You must be at least {MIN_AGE} to use Laybell.</Text>
        </ScrollView>

        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={[styles.primaryBtn, !valid && styles.btnDisabled]}
            onPress={handleAboutContinue}
            disabled={!valid || savingAbout}
          >
            <LinearGradient colors={valid ? GRADIENTS.primary : ['#333', '#222']} style={styles.primaryBtnInner}>
              {savingAbout ? (
                <ActivityIndicator color={COLORS.text} />
              ) : (
                <>
                  <Text style={styles.primaryBtnText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={20} color={COLORS.text} />
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Step 2: Permissions — location + contacts + optional phone (all optional)
  if (step === 2) {
    return (
      <View style={styles.container}>
        <View style={styles.stepHeader}>
          <View style={styles.progressDots}>
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={[styles.dot, i === 1 && styles.dotActive]} />
            ))}
          </View>
          <Text style={styles.stepTitle}>Find your people</Text>
          <Text style={styles.stepSub}>Help Laybell suggest accounts you may know. Optional — change it anytime in Settings → Permissions.</Text>
        </View>

        <ScrollView contentContainerStyle={styles.aboutContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={styles.permCard}>
            <View style={styles.permIcon}><Ionicons name="location-outline" size={22} color={COLORS.primary} /></View>
            <View style={styles.permInfo}>
              <Text style={styles.permTitle}>Location</Text>
              <Text style={styles.permSub}>Suggest people in your area (approximate only)</Text>
            </View>
            <TouchableOpacity
              style={[styles.permBtn, locEnabled && styles.permBtnDone]}
              onPress={enableLocationOb}
              disabled={locEnabled || permBusy === 'location'}
            >
              {permBusy === 'location'
                ? <ActivityIndicator color={COLORS.text} size="small" />
                : <Text style={[styles.permBtnText, locEnabled && styles.permBtnTextDone]}>{locEnabled ? 'Enabled' : 'Enable'}</Text>}
            </TouchableOpacity>
          </View>

          <View style={styles.permCard}>
            <View style={styles.permIcon}><Ionicons name="people-outline" size={22} color={COLORS.primary} /></View>
            <View style={styles.permInfo}>
              <Text style={styles.permTitle}>Contacts</Text>
              <Text style={styles.permSub}>Find contacts who are already on Laybell</Text>
            </View>
            <TouchableOpacity
              style={[styles.permBtn, contactsEnabled && styles.permBtnDone]}
              onPress={enableContactsOb}
              disabled={contactsEnabled || permBusy === 'contacts'}
            >
              {permBusy === 'contacts'
                ? <ActivityIndicator color={COLORS.text} size="small" />
                : <Text style={[styles.permBtnText, contactsEnabled && styles.permBtnTextDone]}>{contactsEnabled ? 'Enabled' : 'Enable'}</Text>}
            </TouchableOpacity>
          </View>

          <Text style={[styles.aboutLabel, { marginTop: SPACING.lg }]}>Phone (optional)</Text>
          <TextInput
            style={styles.ageInput}
            value={obPhone}
            onChangeText={setObPhone}
            placeholder="Your number"
            placeholderTextColor={COLORS.textTertiary}
            keyboardType="phone-pad"
            autoCorrect={false}
          />
          <Text style={styles.aboutHint}>Private — never shown publicly. Lets contacts who have your number find you.</Text>
        </ScrollView>

        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.primaryBtn} onPress={handlePermissionsContinue}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnInner}>
              <Text style={styles.primaryBtnText}>Continue</Text>
              <Ionicons name="arrow-forward" size={20} color={COLORS.text} />
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity onPress={handlePermissionsContinue}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Step 3: Genre selection
  if (step === 3) {
    return (
      <View style={styles.container}>
        <View style={styles.stepHeader}>
          <View style={styles.progressDots}>
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={[styles.dot, i === 2 && styles.dotActive]} />
            ))}
          </View>
          <Text style={styles.stepTitle}>What's your sound?</Text>
          <Text style={styles.stepSub}>Pick the genres you love. We'll find your people.</Text>
        </View>

        <ScrollView contentContainerStyle={styles.genreGrid} showsVerticalScrollIndicator={false}>
          {GENRES.map(genre => {
            const active = selectedGenres.has(genre.id);
            return (
              <TouchableOpacity
                key={genre.id}
                style={[styles.genreChip, active && styles.genreChipActive]}
                onPress={() => toggleGenre(genre.id)}
              >
                {active && (
                  <LinearGradient colors={GRADIENTS.primaryWarm} style={[StyleSheet.absoluteFillObject, { borderRadius: RADIUS.lg }]} />
                )}
                <Text style={styles.genreEmoji}>{genre.icon}</Text>
                <Text style={[styles.genreLabel, active && styles.genreLabelActive]}>
                  {genre.label}
                </Text>
                {active && (
                  <View style={styles.genreCheck}>
                    <Ionicons name="checkmark" size={12} color={COLORS.text} />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={[styles.primaryBtn, selectedGenres.size === 0 && styles.btnDisabled]}
            onPress={handleGenresContinue}
            disabled={selectedGenres.size === 0 || loading}
          >
            <LinearGradient
              colors={selectedGenres.size > 0 ? GRADIENTS.primary : ['#333', '#222']}
              style={styles.primaryBtnInner}
            >
              {loading ? (
                <ActivityIndicator color={COLORS.text} />
              ) : (
                <>
                  <Text style={styles.primaryBtnText}>
                    Continue {selectedGenres.size > 0 ? `(${selectedGenres.size})` : ''}
                  </Text>
                  <Ionicons name="arrow-forward" size={20} color={COLORS.text} />
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleGenresContinue}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Step 4: Follow suggestions
  return (
    <View style={styles.container}>
      <View style={styles.stepHeader}>
        <View style={styles.progressDots}>
          {[0, 1, 2, 3].map(i => (
            <View key={i} style={[styles.dot, i === 3 && styles.dotActive]} />
          ))}
        </View>
        <Text style={styles.stepTitle}>Follow some artists</Text>
        <Text style={styles.stepSub}>
          {suggestions.length > 0
            ? 'Based on your taste — follow anyone that catches your eye.'
            : 'Some artists to get you started.'}
        </Text>
      </View>

      <FlatList
        data={suggestions}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.suggestionList}
        ListEmptyComponent={
          <View style={styles.emptySuggestions}>
            <Ionicons name="people-outline" size={40} color={COLORS.textTertiary} />
            <Text style={styles.emptySuggestionsText}>No suggestions yet — you'll discover people in the feed!</Text>
          </View>
        }
        renderItem={({ item }) => {
          const isFollowed = followed.has(item.id);
          return (
            <View style={styles.suggestionRow}>
              {item.avatar_url ? (
                <Image source={{ uri: item.avatar_url }} style={styles.suggestionAvatar} />
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.suggestionAvatar}>
                  <Text style={styles.suggestionAvatarText}>
                    {item.display_name?.charAt(0).toUpperCase()}
                  </Text>
                </LinearGradient>
              )}
              <View style={styles.suggestionInfo}>
                <Text style={styles.suggestionName}>{item.display_name}</Text>
                <Text style={styles.suggestionUsername}>@{item.username}</Text>
                {item.reason ? <Text style={styles.suggestionReason}>{REASON_LABEL[item.reason as keyof typeof REASON_LABEL]}</Text> : null}
              </View>
              <TouchableOpacity
                style={[styles.followBtn, isFollowed && styles.followBtnActive]}
                onPress={() => handleFollow(item.id)}
              >
                <Text style={[styles.followBtnText, isFollowed && styles.followBtnTextActive]}>
                  {isFollowed ? 'Following' : 'Follow'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        }}
      />

      <View style={styles.bottomBar}>
        <TouchableOpacity style={styles.primaryBtn} onPress={handleFinish} disabled={finishing}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnInner}>
            {finishing ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <>
                <Text style={styles.primaryBtnText}>Take me to Laybell</Text>
                <Ionicons name="musical-notes" size={20} color={COLORS.text} />
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },

  // Welcome
  welcomeBg: { flex: 1, paddingHorizontal: SPACING.lg },
  welcomeContent: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: SPACING.lg },
  logoMark: {
    width: 100, height: 100, borderRadius: RADIUS.xl + 8,
    alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.sm,
  },
  welcomeTitle: {
    color: COLORS.text, fontSize: 40, fontWeight: '800',
    textAlign: 'center', lineHeight: 48,
  },
  welcomeSub: {
    color: COLORS.textSecondary, fontSize: 16,
    textAlign: 'center', lineHeight: 24, paddingHorizontal: SPACING.md,
  },
  featureList: { width: '100%', gap: SPACING.md, marginTop: SPACING.sm },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  featureIcon: {
    width: 40, height: 40, borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary + '1A',
    alignItems: 'center', justifyContent: 'center',
  },
  featureText: { color: COLORS.textSecondary, fontSize: 15, flex: 1 },

  // Steps
  stepHeader: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.xxl + SPACING.md, paddingBottom: SPACING.md, gap: SPACING.sm },
  progressDots: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.border },
  dotActive: { width: 24, backgroundColor: COLORS.primary },
  stepTitle: { color: COLORS.text, fontSize: 28, fontWeight: '800' },
  stepSub: { color: COLORS.textSecondary, fontSize: 15, lineHeight: 22 },

  // About you (gender + age)
  aboutContent: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md, paddingBottom: 160 },
  aboutLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: SPACING.sm },
  genderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genderChip: {
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceLight,
  },
  genderChipActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '1A' },
  genderText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '500' },
  genderTextActive: { color: COLORS.primaryLight, fontWeight: '700' },
  ageInput: {
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    color: COLORS.text, fontSize: 15,
  },
  aboutHint: { color: COLORS.textTertiary, fontSize: 12, marginTop: SPACING.sm },

  // Genre grid
  genreGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: SPACING.lg, gap: SPACING.sm,
    paddingBottom: 160,
  },
  genreChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceLight, gap: SPACING.sm,
    overflow: 'hidden', position: 'relative',
  },
  genreChipActive: { borderColor: COLORS.primary },
  genreEmoji: { fontSize: 18 },
  genreLabel: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '500' },
  genreLabelActive: { color: COLORS.text, fontWeight: '700' },
  genreCheck: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Suggestions
  suggestionList: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: 140 },
  suggestionRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border, gap: SPACING.md,
  },
  suggestionAvatar: {
    width: 50, height: 50, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
  },
  suggestionAvatarText: { color: COLORS.text, fontSize: 20, fontWeight: '700' },
  suggestionInfo: { flex: 1 },
  suggestionName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  suggestionUsername: { color: COLORS.textSecondary, fontSize: 13, marginTop: 2 },
  suggestionReason: { color: COLORS.primaryLight, fontSize: 11, fontWeight: '600', marginTop: 2 },

  // Permissions step cards (location / contacts)
  permCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border, padding: SPACING.md, marginBottom: SPACING.sm,
  },
  permIcon: {
    width: 44, height: 44, borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary + '18', alignItems: 'center', justifyContent: 'center',
  },
  permInfo: { flex: 1 },
  permTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  permSub: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  permBtn: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, backgroundColor: COLORS.primary, minWidth: 78, alignItems: 'center',
  },
  permBtnDone: { backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.success },
  permBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  permBtnTextDone: { color: COLORS.success },
  followBtn: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, backgroundColor: COLORS.primary,
  },
  followBtnActive: { backgroundColor: COLORS.surfaceElevated, borderWidth: 1, borderColor: COLORS.border },
  followBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  followBtnTextActive: { color: COLORS.textSecondary },

  emptySuggestions: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptySuggestionsText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 22 },

  // Shared
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: SPACING.lg, paddingBottom: SPACING.xl,
    backgroundColor: COLORS.background,
    borderTopWidth: 0.5, borderTopColor: COLORS.border,
    gap: SPACING.sm,
  },
  primaryBtn: { borderRadius: RADIUS.md, overflow: 'hidden' },
  primaryBtnInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: SPACING.md + 2, gap: SPACING.sm,
  },
  primaryBtnText: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
  skipText: { color: COLORS.textTertiary, fontSize: 14, textAlign: 'center' },
});
