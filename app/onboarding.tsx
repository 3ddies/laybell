import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, FlatList, Image, ActivityIndicator,
  Dimensions, TextInput, Keyboard,
} from 'react-native';
import { useState, useRef } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { GENDER_OPTIONS, MIN_AGE, parseDob, ageFromDob, dobToISO } from '../lib/profileOptions';
import { captureAndSaveLocation } from '../lib/location';
import { requestContactsPermission, readContactHashes } from '../lib/contacts';
import { saveOwnPhone, upsertOwnIdentifiers } from '../lib/identifiers';
import { fetchSuggestedAccounts, REASON_LABEL } from '../lib/suggestions';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { GENRES as APP_GENRES } from '../lib/genres';
import WelcomeTour from '../components/WelcomeTour';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Genre chips derive from the canonical app-wide genre list (lib/genres.ts) so
// onboarding always offers the SAME categories the user later sees on Explore
// and Music — no orphan genres that exist in one place but not another. Each
// chip's id is the genre's lowercased canonical value (what posts are tagged
// with). Rap is presented as "Rap/Hip-Hop": rap, hip-hop and drill are treated
// as one scene, so they collapse into this single tab.
const GENRE_EMOJI: Record<string, string> = {
  'Rap': '🎤', 'R&B': '🎶', 'Pop': '⭐', 'Rock': '🎸', 'Jazz': '🎷',
  'Electronic': '🎛️', 'Gospel': '🙏', 'Afrobeats': '🥁', 'Lo-Fi': '☁️',
  'Soul': '✨', 'Country': '🤠', 'Classical': '🎻', 'Reggae': '🌿',
  'Latin': '💃', 'Life': '🌍', 'Meme': '😂',
};
const GENRE_LABEL: Record<string, string> = { 'Rap': 'Rap/Hip-Hop' };
const GENRES = APP_GENRES.map(g => ({
  id: g.toLowerCase(),
  label: GENRE_LABEL[g] ?? g,
  icon: GENRE_EMOJI[g] ?? '🎵',
}));

export default function OnboardingScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [gender, setGender] = useState<string | null>(null);
  // Parental consent for users aged 13–17 (captured in the About-you step).
  const [parentEmail, setParentEmail] = useState('');
  const [minorConsent, setMinorConsent] = useState(false);
  const [dobMonth, setDobMonth] = useState('');
  const [dobDay, setDobDay] = useState('');
  const [dobYear, setDobYear] = useState('');
  // DOB auto-advance (first pass only): completing a box jumps to the next and
  // finishing the year dismisses the keyboard. Turned off once the date has been
  // entered in full, so going back to fix one field types normally after that.
  const dobDayRef = useRef<TextInput>(null);
  const dobYearRef = useRef<TextInput>(null);
  const dobAutoAdvance = useRef(true);
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

  function handleDobMonth(t: string) {
    const v = t.replace(/[^0-9]/g, '').slice(0, 2);
    setDobMonth(v);
    if (dobAutoAdvance.current && v.length === 2) dobDayRef.current?.focus();
  }
  function handleDobDay(t: string) {
    const v = t.replace(/[^0-9]/g, '').slice(0, 2);
    setDobDay(v);
    if (dobAutoAdvance.current && v.length === 2) dobYearRef.current?.focus();
  }
  function handleDobYear(t: string) {
    const v = t.replace(/[^0-9]/g, '').slice(0, 4);
    setDobYear(v);
    if (dobAutoAdvance.current && v.length === 4) {
      dobAutoAdvance.current = false; // first full entry done — stop auto-advancing
      Keyboard.dismiss();
    }
  }

  async function handleAboutContinue() {
    const dob = parseDob(dobYear, dobMonth, dobDay);
    if (!gender || !dob) return;
    const ageNum = ageFromDob(dob);
    if (ageNum < MIN_AGE || ageNum > 120) return;
    // Users 13–17 must supply a parent/guardian email + attest to consent before
    // continuing (see the minor-consent block in step 1).
    const isMinor = ageNum < 18;
    if (isMinor && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail.trim()) || !minorConsent)) return;
    setSavingAbout(true);
    const { data: { user } } = await supabase.auth.getUser();
    // Save privately on the profile (no-ops gracefully if the columns aren't
    // migrated yet — the user still proceeds through onboarding). dob is written
    // separately so a pre-migration gap on that column can't drop gender + age.
    if (user) {
      await supabase.from('profiles').update({ gender, age: ageNum }).eq('id', user.id);
      await supabase.from('profiles').update({ dob: dobToISO(dob) }).eq('id', user.id);
      if (isMinor) {
        // Record parental-consent intent in its own update so a pre-migration
        // gap on these columns can't drop the gender/age/dob writes above.
        await supabase.from('profiles').update({
          is_minor: true,
          parent_email: parentEmail.trim().toLowerCase(),
          minor_consent_at: new Date().toISOString(),
          parent_consent_method: 'onboarding_attestation',
        }).eq('id', user.id);
        // Email the parent/guardian a one-time confirmation link. No-ops
        // gracefully until the parent-consent Edge Function + email secret are
        // configured; the attestation above already gates the account.
        supabase.functions.invoke('parent-consent', {
          body: { userId: user.id, parentEmail: parentEmail.trim().toLowerCase() },
        }).catch(() => {});
      }
    }
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

    // 2) Genre-based accounts: people who've posted in the chosen genres. Matches
    // against posts.genre — the exact lowercase tab category the composer writes —
    // so onboarding interests line up with how content is tagged everywhere else.
    let genreUsers: any[] = [];
    if (selectedGenres.size > 0) {
      const genreList = Array.from(selectedGenres);
      const { data: tagData } = await supabase
        .from('posts').select('user_id').in('genre', genreList).eq('is_public', true).limit(50);
      const userIds = [...new Set((tagData ?? []).map((t: any) => t.user_id).filter(Boolean))];
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
      // Commit onboarding now (data is saved) THEN show the one-time feature
      // tour. Because `onboarded` is already true, closing the app mid-tour just
      // drops the user into the app next launch — they never re-do setup, and
      // the tour (gated by this flag) never reappears.
      await supabase.from('profiles').update({ onboarded: true }).eq('id', user.id);
    }
    setFinishing(false);
    setStep(5);
  }

  // Step 5: one-time "what you can do on Laybell" tour, shown once setup is
  // complete (onboarded already committed in handleFinish), then into the app.
  if (step === 5) {
    return <WelcomeTour onDone={() => router.replace('/(tabs)')} />;
  }

  // Step 0: Welcome
  if (step === 0) {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={['#1C0A04', colors.background, colors.background]}
          style={[styles.welcomeBg, { paddingTop: insets.top + SPACING.md, paddingBottom: insets.bottom + SPACING.lg }]}
        >
          <View style={styles.welcomeContent}>
            <Image source={require('../assets/icon.png')} style={styles.logoMark} resizeMode="cover" />
            <Text style={styles.welcomeTitle}>Welcome to{'\n'}Laybell™</Text>
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
                    <Ionicons name={f.icon as any} size={20} color={colors.primary} />
                  </View>
                  <Text style={styles.featureText}>{f.text}</Text>
                </View>
              ))}
            </View>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => setStep(1)}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnInner}>
              <Text style={styles.primaryBtnText}>Get Started</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.text} />
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>
      </View>
    );
  }

  // Step 1: About you (gender + age) — both required
  if (step === 1) {
    const dob = parseDob(dobYear, dobMonth, dobDay);
    const ageNum = dob ? ageFromDob(dob) : NaN;
    const isMinor = Number.isFinite(ageNum) && ageNum >= MIN_AGE && ageNum < 18;
    const parentEmailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail.trim());
    const valid = !!gender && dob != null && ageNum >= MIN_AGE && ageNum <= 120
      && (!isMinor || (parentEmailOk && minorConsent));
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

          <Text style={[styles.aboutLabel, { marginTop: SPACING.lg }]}>Date of birth</Text>
          <View style={styles.dobRow}>
            <TextInput
              style={[styles.dobInput, { flex: 1 }]}
              value={dobMonth}
              onChangeText={handleDobMonth}
              placeholder="MM"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              maxLength={2}
            />
            <TextInput
              ref={dobDayRef}
              style={[styles.dobInput, { flex: 1 }]}
              value={dobDay}
              onChangeText={handleDobDay}
              placeholder="DD"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              maxLength={2}
            />
            <TextInput
              ref={dobYearRef}
              style={[styles.dobInput, { flex: 1.4 }]}
              value={dobYear}
              onChangeText={handleDobYear}
              placeholder="YYYY"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              maxLength={4}
            />
          </View>
          <Text style={styles.aboutHint}>You must be at least {MIN_AGE} to use Laybell.</Text>

          {isMinor && (
            <View style={styles.minorBox}>
              <View style={styles.minorHeader}>
                <Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} />
                <Text style={styles.minorTitle}>Parent or guardian consent</Text>
              </View>
              <Text style={styles.minorSub}>
                Because you're under 18, a parent or guardian must agree to Laybell's terms for you. Enter their email and confirm below — we'll email them a link to verify.
              </Text>
              <TextInput
                style={[styles.ageInput, { marginTop: SPACING.xs }]}
                value={parentEmail}
                onChangeText={setParentEmail}
                placeholder="Parent or guardian email"
                placeholderTextColor={colors.textTertiary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity style={styles.consentRow} onPress={() => setMinorConsent(v => !v)} activeOpacity={0.7}>
                <View style={[styles.checkbox, minorConsent && styles.checkboxOn]}>
                  {minorConsent && <Ionicons name="checkmark" size={14} color={colors.text} />}
                </View>
                <Text style={styles.consentText}>
                  My parent or guardian has reviewed and agrees to Laybell's terms on my behalf.
                </Text>
              </TouchableOpacity>
              <Text style={styles.minorLinks}>
                Read the{' '}
                <Text style={styles.consentLink} onPress={() => router.push('/terms-of-service')}>Terms of Service</Text>
                {' '}and{' '}
                <Text style={styles.consentLink} onPress={() => router.push('/privacy-policy')}>Privacy Policy</Text>.
              </Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={[styles.primaryBtn, !valid && styles.btnDisabled]}
            onPress={handleAboutContinue}
            disabled={!valid || savingAbout}
          >
            <LinearGradient colors={valid ? GRADIENTS.primary : ['#333', '#222']} style={styles.primaryBtnInner}>
              {savingAbout ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <>
                  <Text style={styles.primaryBtnText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={20} color={colors.text} />
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
            <View style={styles.permIcon}><Ionicons name="location-outline" size={22} color={colors.primary} /></View>
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
                ? <ActivityIndicator color={colors.text} size="small" />
                : <Text style={[styles.permBtnText, locEnabled && styles.permBtnTextDone]}>{locEnabled ? 'Enabled' : 'Enable'}</Text>}
            </TouchableOpacity>
          </View>

          <View style={styles.permCard}>
            <View style={styles.permIcon}><Ionicons name="people-outline" size={22} color={colors.primary} /></View>
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
                ? <ActivityIndicator color={colors.text} size="small" />
                : <Text style={[styles.permBtnText, contactsEnabled && styles.permBtnTextDone]}>{contactsEnabled ? 'Enabled' : 'Enable'}</Text>}
            </TouchableOpacity>
          </View>

          <Text style={[styles.aboutLabel, { marginTop: SPACING.lg }]}>Phone (optional)</Text>
          <TextInput
            style={styles.ageInput}
            value={obPhone}
            onChangeText={setObPhone}
            placeholder="Your number"
            placeholderTextColor={colors.textTertiary}
            keyboardType="phone-pad"
            autoCorrect={false}
          />
          <Text style={styles.aboutHint}>Private — never shown publicly. Lets contacts who have your number find you.</Text>
        </ScrollView>

        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.primaryBtn} onPress={handlePermissionsContinue}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnInner}>
              <Text style={styles.primaryBtnText}>Continue</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.text} />
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
          <Text style={styles.stepTitle}>What interests you?</Text>
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
                    <Ionicons name="checkmark" size={12} color={colors.text} />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={handleGenresContinue}
            disabled={loading}
          >
            <LinearGradient
              colors={GRADIENTS.primary}
              style={styles.primaryBtnInner}
            >
              {loading ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <>
                  <Text style={styles.primaryBtnText}>
                    Continue {selectedGenres.size > 0 ? `(${selectedGenres.size})` : ''}
                  </Text>
                  <Ionicons name="arrow-forward" size={20} color={colors.text} />
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
            <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
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
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Text style={styles.primaryBtnText}>Take me to Laybell</Text>
                <Ionicons name="musical-notes" size={20} color={colors.text} />
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Welcome
  welcomeBg: { flex: 1, paddingHorizontal: SPACING.lg },
  welcomeContent: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: SPACING.lg },
  logoMark: {
    width: 100, height: 100, borderRadius: RADIUS.xl + 8,
    alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.sm,
  },
  welcomeTitle: {
    color: colors.text, fontSize: 40, fontWeight: '800',
    textAlign: 'center', lineHeight: 48,
  },
  welcomeSub: {
    color: colors.textSecondary, fontSize: 16,
    textAlign: 'center', lineHeight: 24, paddingHorizontal: SPACING.md,
  },
  featureList: { width: '100%', gap: SPACING.md, marginTop: SPACING.sm },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  featureIcon: {
    width: 40, height: 40, borderRadius: RADIUS.md,
    backgroundColor: colors.primary + '1A',
    alignItems: 'center', justifyContent: 'center',
  },
  featureText: { color: colors.textSecondary, fontSize: 15, flex: 1 },

  // Steps
  stepHeader: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.xxl + SPACING.md, paddingBottom: SPACING.md, gap: SPACING.sm },
  progressDots: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotActive: { width: 24, backgroundColor: colors.primary },
  stepTitle: { color: colors.text, fontSize: 28, fontWeight: '800' },
  stepSub: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },

  // About you (gender + age)
  aboutContent: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md, paddingBottom: 160 },
  aboutLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: SPACING.sm },
  genderGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genderChip: {
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceLight,
  },
  genderChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '1A' },
  genderText: { color: colors.textSecondary, fontSize: 14, fontWeight: '500' },
  genderTextActive: { color: colors.primaryLight, fontWeight: '700' },
  ageInput: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    color: colors.text, fontSize: 15,
  },
  aboutHint: { color: colors.textTertiary, fontSize: 12, marginTop: SPACING.sm },
  // Minor (13–17) parental-consent block on the About-you step.
  minorBox: {
    marginTop: SPACING.lg, backgroundColor: colors.surfaceLight,
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.md,
    padding: SPACING.md, gap: SPACING.sm,
  },
  minorHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  minorTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  minorSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm, marginTop: SPACING.xs },
  checkbox: {
    width: 22, height: 22, borderRadius: RADIUS.xs + 2, borderWidth: 1.5,
    borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  consentText: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  minorLinks: { color: colors.textTertiary, fontSize: 12, lineHeight: 18 },
  consentLink: { color: colors.primaryLight, fontWeight: '700' },
  dobRow: { flexDirection: 'row', gap: SPACING.sm },
  dobInput: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    color: colors.text, fontSize: 15, textAlign: 'center',
  },

  // Genre grid
  genreGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: SPACING.lg, gap: SPACING.sm,
    paddingBottom: 160,
  },
  genreChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SPACING.sm + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceLight, gap: SPACING.sm,
    overflow: 'hidden', position: 'relative',
  },
  genreChipActive: { borderColor: colors.primary },
  genreEmoji: { fontSize: 18 },
  genreLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '500' },
  genreLabelActive: { color: colors.text, fontWeight: '700' },
  genreCheck: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Suggestions
  suggestionList: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: 140 },
  suggestionRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    padding: SPACING.md, borderWidth: 1, borderColor: colors.border, gap: SPACING.md,
  },
  suggestionAvatar: {
    width: 50, height: 50, borderRadius: RADIUS.full,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  suggestionAvatarText: { color: colors.text, fontSize: 20, fontWeight: '700' },
  suggestionInfo: { flex: 1 },
  suggestionName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  suggestionUsername: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  suggestionReason: { color: colors.primaryLight, fontSize: 11, fontWeight: '600', marginTop: 2 },

  // Permissions step cards (location / contacts)
  permCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, marginBottom: SPACING.sm,
  },
  permIcon: {
    width: 44, height: 44, borderRadius: RADIUS.md,
    backgroundColor: colors.primary + '18', alignItems: 'center', justifyContent: 'center',
  },
  permInfo: { flex: 1 },
  permTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  permSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  permBtn: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, backgroundColor: colors.primary, minWidth: 78, alignItems: 'center',
  },
  permBtnDone: { backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.success },
  permBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  permBtnTextDone: { color: colors.success },
  followBtn: {
    paddingVertical: SPACING.xs + 2, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, backgroundColor: colors.primary,
  },
  followBtnActive: { backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border },
  followBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  followBtnTextActive: { color: colors.textSecondary },

  emptySuggestions: { alignItems: 'center', paddingTop: SPACING.xxl, gap: SPACING.md, paddingHorizontal: SPACING.xl },
  emptySuggestionsText: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 22 },

  // Shared
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: SPACING.lg, paddingBottom: SPACING.xl,
    backgroundColor: colors.background,
    borderTopWidth: 0.5, borderTopColor: colors.border,
    gap: SPACING.sm,
  },
  primaryBtn: { borderRadius: RADIUS.md, overflow: 'hidden' },
  primaryBtnInner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: SPACING.md + 2, gap: SPACING.sm,
  },
  primaryBtnText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
  skipText: { color: colors.textTertiary, fontSize: 14, textAlign: 'center' },
});
