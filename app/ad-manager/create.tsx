import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Image, Switch, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../../lib/supabase';
import { uploadToStorageWithProgress, compressVideoIfPossible } from '../../lib/upload';
import {
  purchaseAdCampaign, estimatedImpressions, fmtPrice,
  AD_DEFAULT_CPM_CENTS, AD_CREATIVE_BUCKET,
  type AdPlacement, type AdObjective, type AdMediaType, type NewCreativeInput,
} from '../../lib/ads';
import { GENRES } from '../../lib/genres';
import { useProfile } from '../../contexts/ProfileContext';
import SwipeBackPager from '../../components/SwipeBackPager';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';

// Self-serve ad campaign creation: objective → placements → creative upload per
// placement → optional targeting → budget/schedule → review (with required ad
// policy acceptance) → simulated checkout. Reuses the app's media pickers and
// the progress uploader; on publish the creatives are uploaded to the `ads`
// bucket and the live campaign + payment rows are written (lib/ads).

type Step = 'basics' | 'placements' | 'creatives' | 'targeting' | 'budget' | 'review';
const STEPS: Step[] = ['basics', 'placements', 'creatives', 'targeting', 'budget', 'review'];

const OBJECTIVES: { key: AdObjective; label: string; blurb: string; icon: any }[] = [
  { key: 'awareness', label: 'Awareness', blurb: 'Get seen by as many people as possible.', icon: 'eye-outline' },
  { key: 'traffic', label: 'Traffic', blurb: 'Send people to your link.', icon: 'open-outline' },
  { key: 'engagement', label: 'Engagement', blurb: 'Drive taps and interest.', icon: 'flame-outline' },
];

const PLACEMENTS: { key: AdPlacement; label: string; blurb: string; icon: any; media: string }[] = [
  { key: 'feed', label: 'Home Feed', blurb: 'A sponsored post (photo, video, or slideshow).', icon: 'home-outline', media: 'Photos or a video' },
  { key: 'reels', label: 'Reels', blurb: 'A full-screen video between reels.', icon: 'film-outline', media: 'A video' },
  { key: 'audio', label: 'Music Breaks', blurb: 'An audio spot while people listen.', icon: 'musical-notes-outline', media: 'An audio clip' },
];

const GENDERS = ['Any', 'Male', 'Female', 'Other'];

type Pick = { uri: string; width?: number; height?: number; kind: 'image' | 'video' | 'audio'; durationSec?: number | null; name?: string; mime?: string };
type CreativeDraft = { picks: Pick[]; headline: string; body: string; ctaLabel: string; ctaUrl: string };

const emptyDraft = (): CreativeDraft => ({ picks: [], headline: '', body: '', ctaLabel: 'Learn more', ctaUrl: '' });

function extOf(uri: string, fallback: string): string {
  const m = uri.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : fallback;
}

function mediaTypeOf(placement: AdPlacement, picks: Pick[]): AdMediaType {
  if (placement === 'audio') return 'audio';
  if (picks[0]?.kind === 'video') return 'video';
  if (picks.length > 1) return 'slideshow';
  return 'image';
}

export default function CreateAdScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { profile } = useProfile();

  const [step, setStep] = useState<Step>('basics');

  // Basics
  const [objective, setObjective] = useState<AdObjective>('awareness');
  const [advertiserName, setAdvertiserName] = useState('');
  const [isBusiness, setIsBusiness] = useState(false);

  // Placements + creatives
  const [placements, setPlacements] = useState<AdPlacement[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CreativeDraft>>({});

  // Targeting (all optional)
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [gender, setGender] = useState('Any');
  const [genres, setGenres] = useState<string[]>([]);
  const [useLocation, setUseLocation] = useState(false);
  const [radiusKm, setRadiusKm] = useState('50');

  // Budget / schedule
  const [budget, setBudget] = useState('20');
  const [dailyCap, setDailyCap] = useState('');
  const [cpm, setCpm] = useState(String(AD_DEFAULT_CPM_CENTS / 100));
  const [days, setDays] = useState('7');

  // Review
  const [terms, setTerms] = useState(false);

  const [publishing, setPublishing] = useState(false);
  const [uploadLabel, setUploadLabel] = useState('');
  const publishingRef = useRef(false);

  const hasLocation = profile?.latitude != null && profile?.longitude != null;

  function patchDraft(p: AdPlacement, patch: Partial<CreativeDraft>) {
    setDrafts((prev) => ({ ...prev, [p]: { ...(prev[p] ?? emptyDraft()), ...patch } }));
  }

  function togglePlacement(p: AdPlacement) {
    setPlacements((prev) => {
      const has = prev.includes(p);
      if (has) return prev.filter((x) => x !== p);
      setDrafts((d) => (d[p] ? d : { ...d, [p]: emptyDraft() }));
      return [...prev, p];
    });
  }

  function toggleGenre(g: string) {
    setGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  // ── Media picking ──────────────────────────────────────────────────────────
  async function pickPhotos(p: AdPlacement) {
    const ImagePicker = await import('expo-image-picker');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Photos needed', 'Enable photo access to add a creative.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 8,
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.length) return;
    const picks: Pick[] = res.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, kind: 'image' }));
    patchDraft(p, { picks });
  }

  async function pickVideo(p: AdPlacement) {
    const ImagePicker = await import('expo-image-picker');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Photos needed', 'Enable photo access to add a creative.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    patchDraft(p, {
      picks: [{ uri: a.uri, width: a.width, height: a.height, kind: 'video', durationSec: a.duration ? Math.round(a.duration / 1000) : null }],
    });
  }

  async function pickAudio(p: AdPlacement) {
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    let dur: number | null = null;
    try {
      const { Audio } = await import('expo-av');
      const { sound, status } = await Audio.Sound.createAsync({ uri: a.uri });
      if ((status as any).isLoaded && (status as any).durationMillis) dur = Math.floor((status as any).durationMillis / 1000);
      await sound.unloadAsync();
    } catch {}
    patchDraft(p, { picks: [{ uri: a.uri, kind: 'audio', name: a.name, mime: a.mimeType ?? undefined, durationSec: dur }] });
  }

  // ── Validation ───────────────────────────────────────────────────────────────
  function validateStep(s: Step): string | null {
    if (s === 'basics' && !advertiserName.trim()) return 'Add a brand or advertiser name.';
    if (s === 'placements' && placements.length === 0) return 'Pick at least one placement.';
    if (s === 'creatives') {
      for (const p of placements) {
        const d = drafts[p];
        if (!d || d.picks.length === 0) return `Add a creative for ${labelFor(p)}.`;
        if (!d.headline.trim()) return `Add a headline for ${labelFor(p)}.`;
        if (!d.ctaUrl.trim()) return `Add a destination link for ${labelFor(p)}.`;
      }
    }
    if (s === 'budget') {
      if (!(parseFloat(budget) > 0)) return 'Set a total budget.';
      if (!(parseFloat(cpm) > 0)) return 'Set a CPM bid.';
      if (!(parseInt(days, 10) > 0)) return 'Set a run length in days.';
    }
    return null;
  }

  function labelFor(p: AdPlacement) { return PLACEMENTS.find((x) => x.key === p)?.label ?? p; }

  function next() {
    const err = validateStep(step);
    if (err) { Alert.alert('Almost there', err); return; }
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
  }

  function back() {
    const i = STEPS.indexOf(step);
    if (i === 0) router.back();
    else setStep(STEPS[i - 1]);
  }

  // ── Upload + publish ──────────────────────────────────────────────────────────
  async function uploadOne(uid: string, pick: Pick): Promise<{ url: string; thumb?: string | null }> {
    if (pick.kind === 'video') {
      const compressed = await compressVideoIfPossible(pick.uri);
      const url = await uploadToStorageWithProgress(AD_CREATIVE_BUCKET, uid, compressed, 'mp4', 'video/mp4');
      let thumb: string | null = null;
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(pick.uri, { time: 1000 });
        thumb = await uploadToStorageWithProgress(AD_CREATIVE_BUCKET, uid, uri, 'jpg', 'image/jpeg');
      } catch {}
      return { url, thumb };
    }
    if (pick.kind === 'audio') {
      const ext = extOf(pick.name || pick.uri, 'm4a');
      const url = await uploadToStorageWithProgress(AD_CREATIVE_BUCKET, uid, pick.uri, ext, pick.mime || 'audio/mpeg');
      return { url };
    }
    const ext = extOf(pick.uri, 'jpg');
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    const url = await uploadToStorageWithProgress(AD_CREATIVE_BUCKET, uid, pick.uri, ext, mime);
    return { url };
  }

  function aspectOf(pick: Pick): string | null {
    if (pick.width && pick.height) return `${Math.round(pick.width)}:${Math.round(pick.height)}`;
    return null;
  }

  async function buildCreative(uid: string, p: AdPlacement, d: CreativeDraft): Promise<NewCreativeInput> {
    const mt = mediaTypeOf(p, d.picks);
    const base = {
      placement: p,
      media_type: mt,
      headline: d.headline.trim() || null,
      body: d.body.trim() || null,
      cta_label: d.ctaLabel.trim() || 'Learn more',
      cta_url: d.ctaUrl.trim() || null,
    };

    if (mt === 'slideshow') {
      const slides: any[] = [];
      for (let i = 0; i < d.picks.length; i++) {
        setUploadLabel(`Uploading ${labelFor(p)} photo ${i + 1}/${d.picks.length}…`);
        const { url } = await uploadOne(uid, d.picks[i]);
        slides.push({ type: 'image', url, aspect_ratio: aspectOf(d.picks[i]) });
      }
      return {
        ...base,
        media_url: slides[0]?.url ?? null,
        slides,
        thumbnail_url: slides[0]?.url ?? null,
        aspect_ratio: slides[0]?.aspect_ratio ?? null,
      };
    }

    setUploadLabel(`Uploading ${labelFor(p)} creative…`);
    const { url, thumb } = await uploadOne(uid, d.picks[0]);
    return {
      ...base,
      media_url: url,
      thumbnail_url: thumb ?? null,
      cover_url: mt === 'audio' ? null : thumb ?? null,
      aspect_ratio: aspectOf(d.picks[0]),
      duration_seconds: d.picks[0].durationSec ?? null,
    };
  }

  async function publish() {
    if (!terms) { Alert.alert('Accept the ad policy', 'Please confirm your ad meets the policy to continue.'); return; }
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    setUploadLabel('Preparing…');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { Alert.alert('Sign in required', 'Please sign in again.'); return; }

      const creatives: NewCreativeInput[] = [];
      for (const p of placements) {
        creatives.push(await buildCreative(user.id, p, drafts[p]));
      }

      setUploadLabel('Launching campaign…');
      const endsAt = new Date(Date.now() + Math.max(1, parseInt(days, 10) || 1) * 86_400_000).toISOString();
      const id = await purchaseAdCampaign({
        objective,
        advertiserName: advertiserName.trim(),
        isBusiness,
        placements,
        creatives,
        budgetCentsTotal: Math.round(parseFloat(budget) * 100),
        budgetCentsDaily: dailyCap ? Math.round(parseFloat(dailyCap) * 100) : null,
        bidCpmCents: Math.round(parseFloat(cpm) * 100),
        startsAt: null,
        endsAt,
        targeting: {
          ageMin: ageMin ? parseInt(ageMin, 10) : null,
          ageMax: ageMax ? parseInt(ageMax, 10) : null,
          gender: gender === 'Any' ? null : gender.toLowerCase(),
          genres: genres.length ? genres : null,
          lat: useLocation && hasLocation ? profile!.latitude : null,
          lng: useLocation && hasLocation ? profile!.longitude : null,
          radiusKm: useLocation && hasLocation ? (parseFloat(radiusKm) || 50) : null,
        },
      });

      if (!id) {
        Alert.alert('Could not launch', 'Something went wrong creating the campaign. Make sure the ad_ecosystem.sql migration has been run in Supabase, then try again.');
        return;
      }
      const r = router as any;
      if (typeof r.replace === 'function') r.replace(`/ad-manager/${id}`);
      else r.back();
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? 'Could not upload the creative. Please try again.');
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  // ── Renders ───────────────────────────────────────────────────────────────────
  const budgetCents = Math.round((parseFloat(budget) || 0) * 100);
  const cpmCents = Math.round((parseFloat(cpm) || 0) * 100);
  const estImps = estimatedImpressions(budgetCents, cpmCents);

  const stepTitle: Record<Step, string> = {
    basics: 'Campaign',
    placements: 'Placements',
    creatives: 'Creatives',
    targeting: 'Audience',
    budget: 'Budget & schedule',
    review: 'Review & launch',
  };

  function renderCreativeCard(p: AdPlacement) {
    const d = drafts[p] ?? emptyDraft();
    const cfg = PLACEMENTS.find((x) => x.key === p)!;
    const firstImg = d.picks.find((x) => x.kind === 'image');
    return (
      <View key={p} style={styles.card}>
        <View style={styles.creativeHead}>
          <Ionicons name={cfg.icon} size={16} color={colors.primary} />
          <Text style={styles.creativeTitle}>{cfg.label}</Text>
        </View>

        {/* Media */}
        {d.picks.length > 0 ? (
          <View style={styles.previewRow}>
            {d.picks[0].kind === 'audio' ? (
              <View style={styles.audioPreview}>
                <Ionicons name="musical-notes" size={22} color={colors.primary} />
                <Text style={styles.audioPreviewText} numberOfLines={1}>{d.picks[0].name || 'Audio clip'}</Text>
              </View>
            ) : firstImg ? (
              <>
                <Image source={{ uri: d.picks[0].uri }} style={styles.preview} />
                {d.picks.length > 1 && <Text style={styles.previewCount}>+{d.picks.length - 1} more (slideshow)</Text>}
              </>
            ) : (
              <View style={styles.preview}>
                <Ionicons name="videocam" size={26} color={colors.primary} style={{ alignSelf: 'center', marginTop: 24 }} />
              </View>
            )}
          </View>
        ) : null}

        <View style={styles.pickRow}>
          {p === 'feed' && (
            <>
              <TouchableOpacity style={styles.pickBtn} onPress={() => pickPhotos(p)}>
                <Ionicons name="images-outline" size={16} color={colors.text} />
                <Text style={styles.pickBtnText}>{d.picks.length ? 'Change photos' : 'Add photo(s)'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickBtn} onPress={() => pickVideo(p)}>
                <Ionicons name="videocam-outline" size={16} color={colors.text} />
                <Text style={styles.pickBtnText}>Video</Text>
              </TouchableOpacity>
            </>
          )}
          {p === 'reels' && (
            <TouchableOpacity style={styles.pickBtn} onPress={() => pickVideo(p)}>
              <Ionicons name="videocam-outline" size={16} color={colors.text} />
              <Text style={styles.pickBtnText}>{d.picks.length ? 'Change video' : 'Add video'}</Text>
            </TouchableOpacity>
          )}
          {p === 'audio' && (
            <TouchableOpacity style={styles.pickBtn} onPress={() => pickAudio(p)}>
              <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
              <Text style={styles.pickBtnText}>{d.picks.length ? 'Change audio' : 'Add audio'}</Text>
            </TouchableOpacity>
          )}
        </View>

        <TextInput
          style={styles.input}
          placeholder="Headline"
          placeholderTextColor={colors.textTertiary}
          value={d.headline}
          onChangeText={(t) => patchDraft(p, { headline: t })}
          maxLength={60}
        />
        <TextInput
          style={[styles.input, styles.inputMulti]}
          placeholder="Body text (optional)"
          placeholderTextColor={colors.textTertiary}
          value={d.body}
          onChangeText={(t) => patchDraft(p, { body: t })}
          multiline
          maxLength={140}
        />
        <View style={styles.ctaRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Button label"
            placeholderTextColor={colors.textTertiary}
            value={d.ctaLabel}
            onChangeText={(t) => patchDraft(p, { ctaLabel: t })}
            maxLength={20}
          />
        </View>
        <TextInput
          style={styles.input}
          placeholder="Destination link (https://…)"
          placeholderTextColor={colors.textTertiary}
          value={d.ctaUrl}
          onChangeText={(t) => patchDraft(p, { ctaUrl: t })}
          autoCapitalize="none"
          keyboardType="url"
        />
      </View>
    );
  }

  return (
    <SwipeBackPager>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={back}>
              <Ionicons name={step === 'basics' ? 'close' : 'chevron-back'} size={24} color={colors.primary} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{stepTitle[step]}</Text>
            <View style={{ width: 40 }} />
          </View>

          {/* Step progress */}
          <View style={styles.progress}>
            {STEPS.map((s) => (
              <View key={s} style={[styles.progressDot, STEPS.indexOf(s) <= STEPS.indexOf(step) && styles.progressDotOn]} />
            ))}
          </View>

          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {step === 'basics' && (
              <>
                <Text style={styles.lead}>What's the goal of this campaign?</Text>
                {OBJECTIVES.map((o) => {
                  const on = objective === o.key;
                  return (
                    <TouchableOpacity key={o.key} style={[styles.selectCard, on && styles.selectCardOn]} onPress={() => setObjective(o.key)} activeOpacity={0.8}>
                      <Ionicons name={o.icon} size={20} color={on ? colors.primary : colors.textSecondary} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.selectTitle, on && { color: colors.primary }]}>{o.label}</Text>
                        <Text style={styles.selectSub}>{o.blurb}</Text>
                      </View>
                      {on && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                })}
                <Text style={[styles.label, { marginTop: SPACING.md }]}>Brand / advertiser name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Shown on every ad as the advertiser"
                  placeholderTextColor={colors.textTertiary}
                  value={advertiserName}
                  onChangeText={setAdvertiserName}
                  maxLength={40}
                />
                <View style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.switchLabel}>This is a business</Text>
                    <Text style={styles.switchSub}>Advertising on behalf of a company or brand</Text>
                  </View>
                  <Switch
                    value={isBusiness}
                    onValueChange={setIsBusiness}
                    trackColor={{ false: colors.border, true: colors.primary + '88' }}
                    thumbColor={isBusiness ? colors.primary : colors.textTertiary}
                  />
                </View>
              </>
            )}

            {step === 'placements' && (
              <>
                <Text style={styles.lead}>Where should your ad appear? Pick one or more.</Text>
                {PLACEMENTS.map((p) => {
                  const on = placements.includes(p.key);
                  return (
                    <TouchableOpacity key={p.key} style={[styles.selectCard, on && styles.selectCardOn]} onPress={() => togglePlacement(p.key)} activeOpacity={0.8}>
                      <Ionicons name={p.icon} size={20} color={on ? colors.primary : colors.textSecondary} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.selectTitle, on && { color: colors.primary }]}>{p.label}</Text>
                        <Text style={styles.selectSub}>{p.blurb}</Text>
                        <Text style={styles.selectMeta}>Needs: {p.media}</Text>
                      </View>
                      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.primary : colors.textTertiary} />
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            {step === 'creatives' && (
              placements.length === 0
                ? <Text style={styles.lead}>Go back and pick a placement first.</Text>
                : (<>
                    <Text style={styles.lead}>Build a creative for each placement. Every ad shows a "Sponsored" label and your brand name.</Text>
                    {placements.map(renderCreativeCard)}
                  </>)
            )}

            {step === 'targeting' && (
              <>
                <Text style={styles.lead}>All optional — leave blank to reach everyone.</Text>

                <Text style={styles.label}>Age range</Text>
                <View style={styles.ageRow}>
                  <TextInput style={[styles.input, styles.ageInput]} placeholder="Min" placeholderTextColor={colors.textTertiary} value={ageMin} onChangeText={setAgeMin} keyboardType="number-pad" maxLength={2} />
                  <Text style={styles.ageDash}>–</Text>
                  <TextInput style={[styles.input, styles.ageInput]} placeholder="Max" placeholderTextColor={colors.textTertiary} value={ageMax} onChangeText={setAgeMax} keyboardType="number-pad" maxLength={2} />
                </View>

                <Text style={styles.label}>Gender</Text>
                <View style={styles.chipWrap}>
                  {GENDERS.map((g) => {
                    const on = gender === g;
                    return (
                      <TouchableOpacity key={g} style={[styles.chip, on && styles.chipOn]} onPress={() => setGender(g)}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{g}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.label}>Interests / genres</Text>
                <View style={styles.chipWrap}>
                  {GENRES.map((g) => {
                    const on = genres.includes(g);
                    return (
                      <TouchableOpacity key={g} style={[styles.chip, on && styles.chipOn]} onPress={() => toggleGenre(g)}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{g}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.label}>Location</Text>
                {hasLocation ? (
                  <>
                    <View style={styles.switchRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.switchLabel}>Target near my area</Text>
                        <Text style={styles.switchSub}>Reach people within a radius of your saved location</Text>
                      </View>
                      <Switch
                        value={useLocation}
                        onValueChange={setUseLocation}
                        trackColor={{ false: colors.border, true: colors.primary + '88' }}
                        thumbColor={useLocation ? colors.primary : colors.textTertiary}
                      />
                    </View>
                    {useLocation && (
                      <View style={styles.ageRow}>
                        <TextInput style={[styles.input, styles.ageInput]} placeholder="50" placeholderTextColor={colors.textTertiary} value={radiusKm} onChangeText={setRadiusKm} keyboardType="number-pad" maxLength={4} />
                        <Text style={styles.ageDash}>km radius</Text>
                      </View>
                    )}
                  </>
                ) : (
                  <Text style={styles.note}>Add your location in Settings → Permissions to target by area.</Text>
                )}
              </>
            )}

            {step === 'budget' && (
              <>
                <Text style={styles.lead}>Set how much to spend and how long to run. Payments are simulated for now.</Text>

                <Text style={styles.label}>Total budget (USD)</Text>
                <TextInput style={styles.input} placeholder="20" placeholderTextColor={colors.textTertiary} value={budget} onChangeText={setBudget} keyboardType="decimal-pad" />

                <Text style={styles.label}>Daily cap (optional)</Text>
                <TextInput style={styles.input} placeholder="No cap" placeholderTextColor={colors.textTertiary} value={dailyCap} onChangeText={setDailyCap} keyboardType="decimal-pad" />

                <Text style={styles.label}>CPM bid — cost per 1,000 views (USD)</Text>
                <TextInput style={styles.input} placeholder="5.00" placeholderTextColor={colors.textTertiary} value={cpm} onChangeText={setCpm} keyboardType="decimal-pad" />

                <Text style={styles.label}>Run length (days)</Text>
                <TextInput style={styles.input} placeholder="7" placeholderTextColor={colors.textTertiary} value={days} onChangeText={setDays} keyboardType="number-pad" maxLength={3} />

                <View style={styles.estimateCard}>
                  <Ionicons name="bar-chart-outline" size={18} color={colors.primary} />
                  <Text style={styles.estimateText}>
                    Est. ~{estImps.toLocaleString()} views over {parseInt(days, 10) || 0} day{(parseInt(days, 10) || 0) === 1 ? '' : 's'}
                  </Text>
                </View>
              </>
            )}

            {step === 'review' && (
              <>
                <View style={styles.card}>
                  <Text style={styles.reviewTitle}>{advertiserName || 'Untitled'}</Text>
                  <ReviewRow k="Objective" v={objective} styles={styles} />
                  <ReviewRow k="Placements" v={placements.map(labelFor).join(', ') || '—'} styles={styles} />
                  <ReviewRow k="Budget" v={fmtPrice(budgetCents)} styles={styles} />
                  {!!dailyCap && <ReviewRow k="Daily cap" v={fmtPrice(Math.round(parseFloat(dailyCap) * 100))} styles={styles} />}
                  <ReviewRow k="CPM" v={fmtPrice(cpmCents)} styles={styles} />
                  <ReviewRow k="Run length" v={`${parseInt(days, 10) || 0} days`} styles={styles} />
                  <ReviewRow k="Est. views" v={`~${estImps.toLocaleString()}`} styles={styles} />
                  {(ageMin || ageMax || gender !== 'Any' || genres.length > 0 || (useLocation && hasLocation)) ? (
                    <ReviewRow
                      k="Targeting"
                      v={[
                        (ageMin || ageMax) ? `Age ${ageMin || '0'}–${ageMax || '∞'}` : null,
                        gender !== 'Any' ? gender : null,
                        genres.length ? `${genres.length} genre${genres.length === 1 ? '' : 's'}` : null,
                        useLocation && hasLocation ? `${parseFloat(radiusKm) || 50}km` : null,
                      ].filter(Boolean).join(' · ')}
                      styles={styles}
                    />
                  ) : (
                    <ReviewRow k="Targeting" v="Everyone" styles={styles} />
                  )}
                </View>

                <TouchableOpacity style={styles.termsRow} onPress={() => setTerms((t) => !t)} activeOpacity={0.8}>
                  <Ionicons name={terms ? 'checkbox' : 'square-outline'} size={22} color={terms ? colors.primary : colors.textTertiary} />
                  <Text style={styles.termsText}>
                    I confirm this ad and its destination comply with Laybell's ad policy — no illegal,
                    deceptive, or age-inappropriate content — and I have the rights to the creative.
                  </Text>
                </TouchableOpacity>

                <Text style={styles.simNote}>
                  Simulated checkout — no real charge is made while Laybell payments are in preview.
                </Text>
              </>
            )}
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            {step === 'review' ? (
              <TouchableOpacity style={[styles.primaryBtn, (!terms || publishing) && styles.primaryBtnDisabled]} onPress={publish} disabled={!terms || publishing}>
                {publishing ? <ActivityIndicator color={colors.text} size="small" /> : <Text style={styles.primaryBtnText}>Launch campaign · {fmtPrice(budgetCents)}</Text>}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.primaryBtn} onPress={next}>
                <Text style={styles.primaryBtnText}>Continue</Text>
              </TouchableOpacity>
            )}
          </View>

          {publishing && (
            <View style={styles.uploadOverlay} pointerEvents="auto">
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.uploadText}>{uploadLabel}</Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SwipeBackPager>
  );
}

function ReviewRow({ k, v, styles }: { k: string; v: string; styles: any }) {
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewKey}>{k}</Text>
      <Text style={styles.reviewVal} numberOfLines={1}>{v}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.borderSubtle,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },

  progress: { flexDirection: 'row', gap: 6, justifyContent: 'center', paddingVertical: SPACING.sm },
  progressDot: { width: 22, height: 4, borderRadius: 2, backgroundColor: colors.surfaceElevated },
  progressDotOn: { backgroundColor: colors.primary },

  scroll: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.xxl },
  lead: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: SPACING.xs },
  label: { color: colors.textTertiary, fontSize: 12, fontWeight: '700', marginTop: SPACING.sm, marginBottom: 4 },
  note: { color: colors.textTertiary, fontSize: 12, lineHeight: 17 },

  selectCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1.5, borderColor: colors.border, padding: SPACING.md,
  },
  selectCardOn: { borderColor: colors.primary, backgroundColor: colors.primary + '11' },
  selectTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  selectSub: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  selectMeta: { color: colors.textTertiary, fontSize: 11, marginTop: 3, fontStyle: 'italic' },

  input: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
    color: colors.text, fontSize: 14,
  },
  inputMulti: { minHeight: 64, textAlignVertical: 'top' },

  switchRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, marginTop: SPACING.sm,
  },
  switchLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  switchSub: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },

  // Creative card
  card: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, gap: SPACING.sm,
  },
  creativeHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  creativeTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  previewRow: { gap: 4 },
  preview: { width: '100%', height: 150, borderRadius: RADIUS.md, backgroundColor: colors.surfaceElevated },
  previewCount: { color: colors.textTertiary, fontSize: 11 },
  audioPreview: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.md, padding: SPACING.md,
  },
  audioPreviewText: { color: colors.text, fontSize: 13, flex: 1 },
  pickRow: { flexDirection: 'row', gap: SPACING.sm },
  pickBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1,
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full, paddingVertical: SPACING.sm,
  },
  pickBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  ctaRow: { flexDirection: 'row', gap: SPACING.sm },

  // Targeting chips
  ageRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  ageInput: { width: 90, textAlign: 'center' },
  ageDash: { color: colors.textSecondary, fontSize: 14 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full,
    paddingHorizontal: SPACING.md, paddingVertical: 6, backgroundColor: colors.surfaceLight,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primary + '18' },
  chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: colors.primary },

  estimateCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.md,
    backgroundColor: colors.primary + '14', borderRadius: RADIUS.lg, padding: SPACING.md,
  },
  estimateText: { color: colors.text, fontSize: 13, fontWeight: '600' },

  // Review
  reviewTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: SPACING.xs },
  reviewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.md, paddingVertical: 3 },
  reviewKey: { color: colors.textSecondary, fontSize: 13 },
  reviewVal: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1, textTransform: 'capitalize' },

  termsRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm, marginTop: SPACING.md,
    paddingHorizontal: SPACING.xs,
  },
  termsText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, flex: 1 },
  simNote: { color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: SPACING.md },

  footer: {
    padding: SPACING.md, paddingBottom: SPACING.lg,
    borderTopWidth: 0.5, borderTopColor: colors.borderSubtle,
  },
  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.md,
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: colors.text, fontSize: 15, fontWeight: '800' },

  uploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.background + 'E6',
    alignItems: 'center', justifyContent: 'center', gap: SPACING.md,
  },
  uploadText: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
