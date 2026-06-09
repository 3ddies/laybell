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

  async function handleGenresContinue() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Find suggested accounts based on selected genres
    let query = supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, badge_tier')
      .neq('id', user.id)
      .limit(20);

    if (selectedGenres.size > 0) {
      // Find users who post in selected genres
      const genreList = Array.from(selectedGenres);
      const { data: tagData } = await supabase
        .from('post_tags')
        .select('posts!inner(user_id)')
        .in('genre', genreList)
        .limit(50);

      const userIds = [...new Set((tagData ?? []).map((t: any) => t.posts?.user_id).filter(Boolean))];

      if (userIds.length > 0) {
        const { data: genreUsers } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, badge_tier')
          .in('id', userIds)
          .neq('id', user.id)
          .limit(15);
        if (genreUsers && genreUsers.length >= 3) {
          setSuggestions(genreUsers);
          setLoading(false);
          setStep(3);
          return;
        }
      }
    }

    // Fallback: most active users
    const { data } = await query;
    setSuggestions(data ?? []);
    setLoading(false);
    setStep(3);
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
            {[0, 1, 2].map(i => (
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

  // Step 2: Genre selection
  if (step === 2) {
    return (
      <View style={styles.container}>
        <View style={styles.stepHeader}>
          <View style={styles.progressDots}>
            {[0, 1, 2].map(i => (
              <View key={i} style={[styles.dot, i === 1 && styles.dotActive]} />
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
          <TouchableOpacity onPress={() => { setSuggestions([]); setStep(3); }}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Step 2: Follow suggestions
  return (
    <View style={styles.container}>
      <View style={styles.stepHeader}>
        <View style={styles.progressDots}>
          {[0, 1, 2].map(i => (
            <View key={i} style={[styles.dot, i === 2 && styles.dotActive]} />
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
