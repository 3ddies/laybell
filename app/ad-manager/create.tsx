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
import { GENRES, genreLabel } from '../../lib/genres';
import { useProfile } from '../../contexts/ProfileContext';
import SwipeBackPager from '../../components/SwipeBackPager';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Self-serve ad campaign creation: objective → placements → creative upload per
// placement → optional targeting → budget/schedule → review (with required ad
// policy acceptance) → simulated checkout. Reuses the app's media pickers and
// the progress uploader; on publish the creatives are uploaded to the `ads`
// bucket and the live campaign + payment rows are written (lib/ads).

type Step = 'basics' | 'placements' | 'creatives' | 'targeting' | 'budget' | 'review';
const STEPS: Step[] = ['basics', 'placements', 'creatives', 'targeting', 'budget', 'review'];

const OBJECTIVES: { key: AdObjective; icon: any }[] = [
  { key: 'awareness', icon: 'eye-outline' },
  { key: 'traffic', icon: 'open-outline' },
  { key: 'engagement', icon: 'flame-outline' },
];

const PLACEMENTS: { key: AdPlacement; icon: any }[] = [
  { key: 'feed', icon: 'home-outline' },
  { key: 'reels', icon: 'film-outline' },
  { key: 'audio', icon: 'musical-notes-outline' },
];

const GENDERS: { key: string; label: string }[] = [
  { key: 'Any', label: 'adCreate.genderAny' },
  { key: 'Male', label: 'adCreate.genderMale' },
  { key: 'Female', label: 'adCreate.genderFemale' },
  { key: 'Other', label: 'adCreate.genderOther' },
];

type Pick = { uri: string; width?: number; height?: number; kind: 'image' | 'video' | 'audio'; durationSec?: number | null; name?: string; mime?: string };
type CreativeDraft = { picks: Pick[]; headline: string; body: string; ctaLabel: string; ctaUrl: string };

const emptyDraft = (t: TFn): CreativeDraft => ({ picks: [], headline: '', body: '', ctaLabel: t('adCreate.ctaDefault'), ctaUrl: '' });

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
  const { t } = useTranslation();

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
    setDrafts((prev) => ({ ...prev, [p]: { ...(prev[p] ?? emptyDraft(t)), ...patch } }));
  }

  function togglePlacement(p: AdPlacement) {
    setPlacements((prev) => {
      const has = prev.includes(p);
      if (has) return prev.filter((x) => x !== p);
      setDrafts((d) => (d[p] ? d : { ...d, [p]: emptyDraft(t) }));
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
    if (!perm.granted) { Alert.alert(t('adCreate.photosNeededTitle'), t('adCreate.photosNeededBody')); return; }
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
    if (!perm.granted) { Alert.alert(t('adCreate.photosNeededTitle'), t('adCreate.photosNeededBody')); return; }
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
    if (s === 'basics' && !advertiserName.trim()) return t('adCreate.errAdvertiserName');
    if (s === 'placements' && placements.length === 0) return t('adCreate.errPlacement');
    if (s === 'creatives') {
      for (const p of placements) {
        const d = drafts[p];
        if (!d || d.picks.length === 0) return t('adCreate.errCreative', { placement: labelFor(p) });
        if (!d.headline.trim()) return t('adCreate.errHeadline', { placement: labelFor(p) });
        if (!d.ctaUrl.trim()) return t('adCreate.errLink', { placement: labelFor(p) });
      }
    }
    if (s === 'budget') {
      if (!(parseFloat(budget) > 0)) return t('adCreate.errBudget');
      if (!(parseFloat(cpm) > 0)) return t('adCreate.errCpm');
      if (!(parseInt(days, 10) > 0)) return t('adCreate.errDays');
    }
    return null;
  }

  function labelFor(p: AdPlacement) { return t(`adCreate.placement.${p}.label`); }

  function next() {
    const err = validateStep(step);
    if (err) { Alert.alert(t('adCreate.almostTitle'), err); return; }
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
      cta_label: d.ctaLabel.trim() || t('adCreate.ctaDefault'),
      cta_url: d.ctaUrl.trim() || null,
    };

    if (mt === 'slideshow') {
      const slides: any[] = [];
      for (let i = 0; i < d.picks.length; i++) {
        setUploadLabel(t('adCreate.uploadingPhoto', { placement: labelFor(p), index: i + 1, total: d.picks.length }));
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

    setUploadLabel(t('adCreate.uploadingCreative', { placement: labelFor(p) }));
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
    if (!terms) { Alert.alert(t('adCreate.acceptPolicyTitle'), t('adCreate.acceptPolicyBody')); return; }
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    setUploadLabel(t('adCreate.preparing'));
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { Alert.alert(t('adCreate.signInTitle'), t('adCreate.signInBody')); return; }

      const creatives: NewCreativeInput[] = [];
      for (const p of placements) {
        creatives.push(await buildCreative(user.id, p, drafts[p]));
      }

      setUploadLabel(t('adCreate.launchingCampaign'));
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
        Alert.alert(t('adCreate.couldNotLaunchTitle'), t('adCreate.couldNotLaunchBody'));
        return;
      }
      const r = router as any;
      if (typeof r.replace === 'function') r.replace(`/ad-manager/${id}`);
      else r.back();
    } catch (e: any) {
      Alert.alert(t('adCreate.uploadFailedTitle'), e?.message ?? t('adCreate.uploadFailedBody'));
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
    basics: t('adCreate.stepBasics'),
    placements: t('adCreate.stepPlacements'),
    creatives: t('adCreate.stepCreatives'),
    targeting: t('adCreate.stepTargeting'),
    budget: t('adCreate.stepBudget'),
    review: t('adCreate.stepReview'),
  };

  function renderCreativeCard(p: AdPlacement) {
    const d = drafts[p] ?? emptyDraft(t);
    const cfg = PLACEMENTS.find((x) => x.key === p)!;
    const firstImg = d.picks.find((x) => x.kind === 'image');
    return (
      <View key={p} style={styles.card}>
        <View style={styles.creativeHead}>
          <Ionicons name={cfg.icon} size={16} color={colors.primary} />
          <Text style={styles.creativeTitle}>{t(`adCreate.placement.${p}.label`)}</Text>
        </View>

        {/* Media */}
        {d.picks.length > 0 ? (
          <View style={styles.previewRow}>
            {d.picks[0].kind === 'audio' ? (
              <View style={styles.audioPreview}>
                <Ionicons name="musical-notes" size={22} color={colors.primary} />
                <Text style={styles.audioPreviewText} numberOfLines={1}>{d.picks[0].name || t('adCreate.audioClip')}</Text>
              </View>
            ) : firstImg ? (
              <>
                <Image source={{ uri: d.picks[0].uri }} style={styles.preview} />
                {d.picks.length > 1 && <Text style={styles.previewCount}>{t('adCreate.moreSlideshow', { count: d.picks.length - 1 })}</Text>}
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
                <Text style={styles.pickBtnText}>{d.picks.length ? t('adCreate.changePhotos') : t('adCreate.addPhotos')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickBtn} onPress={() => pickVideo(p)}>
                <Ionicons name="videocam-outline" size={16} color={colors.text} />
                <Text style={styles.pickBtnText}>{t('adCreate.video')}</Text>
              </TouchableOpacity>
            </>
          )}
          {p === 'reels' && (
            <TouchableOpacity style={styles.pickBtn} onPress={() => pickVideo(p)}>
              <Ionicons name="videocam-outline" size={16} color={colors.text} />
              <Text style={styles.pickBtnText}>{d.picks.length ? t('adCreate.changeVideo') : t('adCreate.addVideo')}</Text>
            </TouchableOpacity>
          )}
          {p === 'audio' && (
            <TouchableOpacity style={styles.pickBtn} onPress={() => pickAudio(p)}>
              <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
              <Text style={styles.pickBtnText}>{d.picks.length ? t('adCreate.changeAudio') : t('adCreate.addAudio')}</Text>
            </TouchableOpacity>
          )}
        </View>

        <TextInput
          style={styles.input}
          placeholder={t('adCreate.headlinePlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={d.headline}
          onChangeText={(text) => patchDraft(p, { headline: text })}
          maxLength={60}
        />
        <TextInput
          style={[styles.input, styles.inputMulti]}
          placeholder={t('adCreate.bodyPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={d.body}
          onChangeText={(text) => patchDraft(p, { body: text })}
          multiline
          maxLength={140}
        />
        <View style={styles.ctaRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder={t('adCreate.buttonLabelPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={d.ctaLabel}
            onChangeText={(text) => patchDraft(p, { ctaLabel: text })}
            maxLength={20}
          />
        </View>
        <TextInput
          style={styles.input}
          placeholder={t('adCreate.linkPlaceholder')}
          placeholderTextColor={colors.textTertiary}
          value={d.ctaUrl}
          onChangeText={(text) => patchDraft(p, { ctaUrl: text })}
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
                <Text style={styles.lead}>{t('adCreate.basicsLead')}</Text>
                {OBJECTIVES.map((o) => {
                  const on = objective === o.key;
                  return (
                    <TouchableOpacity key={o.key} style={[styles.selectCard, on && styles.selectCardOn]} onPress={() => setObjective(o.key)} activeOpacity={0.8}>
                      <Ionicons name={o.icon} size={20} color={on ? colors.primary : colors.textSecondary} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.selectTitle, on && { color: colors.primary }]}>{t(`adCreate.objective.${o.key}.label`)}</Text>
                        <Text style={styles.selectSub}>{t(`adCreate.objective.${o.key}.blurb`)}</Text>
                      </View>
                      {on && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                })}
                <Text style={[styles.label, { marginTop: SPACING.md }]}>{t('adCreate.advertiserNameLabel')}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={t('adCreate.advertiserNamePlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  value={advertiserName}
                  onChangeText={setAdvertiserName}
                  maxLength={40}
                />
                <View style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.switchLabel}>{t('adCreate.isBusinessLabel')}</Text>
                    <Text style={styles.switchSub}>{t('adCreate.isBusinessSub')}</Text>
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
                <Text style={styles.lead}>{t('adCreate.placementsLead')}</Text>
                {PLACEMENTS.map((p) => {
                  const on = placements.includes(p.key);
                  return (
                    <TouchableOpacity key={p.key} style={[styles.selectCard, on && styles.selectCardOn]} onPress={() => togglePlacement(p.key)} activeOpacity={0.8}>
                      <Ionicons name={p.icon} size={20} color={on ? colors.primary : colors.textSecondary} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.selectTitle, on && { color: colors.primary }]}>{t(`adCreate.placement.${p.key}.label`)}</Text>
                        <Text style={styles.selectSub}>{t(`adCreate.placement.${p.key}.blurb`)}</Text>
                        <Text style={styles.selectMeta}>{t('adCreate.needs', { media: t(`adCreate.placement.${p.key}.media`) })}</Text>
                      </View>
                      <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.primary : colors.textTertiary} />
                    </TouchableOpacity>
                  );
                })}
              </>
            )}

            {step === 'creatives' && (
              placements.length === 0
                ? <Text style={styles.lead}>{t('adCreate.creativesEmpty')}</Text>
                : (<>
                    <Text style={styles.lead}>{t('adCreate.creativesLead')}</Text>
                    {placements.map(renderCreativeCard)}
                  </>)
            )}

            {step === 'targeting' && (
              <>
                <Text style={styles.lead}>{t('adCreate.targetingLead')}</Text>

                <Text style={styles.label}>{t('adCreate.ageRange')}</Text>
                <View style={styles.ageRow}>
                  <TextInput style={[styles.input, styles.ageInput]} placeholder={t('adCreate.min')} placeholderTextColor={colors.textTertiary} value={ageMin} onChangeText={setAgeMin} keyboardType="number-pad" maxLength={2} />
                  <Text style={styles.ageDash}>–</Text>
                  <TextInput style={[styles.input, styles.ageInput]} placeholder={t('adCreate.max')} placeholderTextColor={colors.textTertiary} value={ageMax} onChangeText={setAgeMax} keyboardType="number-pad" maxLength={2} />
                </View>

                <Text style={styles.label}>{t('adCreate.gender')}</Text>
                <View style={styles.chipWrap}>
                  {GENDERS.map((g) => {
                    const on = gender === g.key;
                    return (
                      <TouchableOpacity key={g.key} style={[styles.chip, on && styles.chipOn]} onPress={() => setGender(g.key)}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{t(g.label)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.label}>{t('adCreate.interests')}</Text>
                <View style={styles.chipWrap}>
                  {GENRES.map((g) => {
                    const on = genres.includes(g);
                    return (
                      <TouchableOpacity key={g} style={[styles.chip, on && styles.chipOn]} onPress={() => toggleGenre(g)}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{genreLabel(g)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.label}>{t('adCreate.location')}</Text>
                {hasLocation ? (
                  <>
                    <View style={styles.switchRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.switchLabel}>{t('adCreate.targetNearLabel')}</Text>
                        <Text style={styles.switchSub}>{t('adCreate.targetNearSub')}</Text>
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
                        <Text style={styles.ageDash}>{t('adCreate.kmRadius')}</Text>
                      </View>
                    )}
                  </>
                ) : (
                  <Text style={styles.note}>{t('adCreate.locationNote')}</Text>
                )}
              </>
            )}

            {step === 'budget' && (
              <>
                <Text style={styles.lead}>{t('adCreate.budgetLead')}</Text>

                <Text style={styles.label}>{t('adCreate.totalBudgetLabel')}</Text>
                <TextInput style={styles.input} placeholder="20" placeholderTextColor={colors.textTertiary} value={budget} onChangeText={setBudget} keyboardType="decimal-pad" />

                <Text style={styles.label}>{t('adCreate.dailyCapLabel')}</Text>
                <TextInput style={styles.input} placeholder={t('adCreate.noCap')} placeholderTextColor={colors.textTertiary} value={dailyCap} onChangeText={setDailyCap} keyboardType="decimal-pad" />

                <Text style={styles.label}>{t('adCreate.cpmLabel')}</Text>
                <TextInput style={styles.input} placeholder="5.00" placeholderTextColor={colors.textTertiary} value={cpm} onChangeText={setCpm} keyboardType="decimal-pad" />

                <Text style={styles.label}>{t('adCreate.runLengthLabel')}</Text>
                <TextInput style={styles.input} placeholder="7" placeholderTextColor={colors.textTertiary} value={days} onChangeText={setDays} keyboardType="number-pad" maxLength={3} />

                <View style={styles.estimateCard}>
                  <Ionicons name="bar-chart-outline" size={18} color={colors.primary} />
                  <Text style={styles.estimateText}>
                    {t('adCreate.estimate', { views: estImps.toLocaleString(), days: parseInt(days, 10) || 0 })}
                  </Text>
                </View>
              </>
            )}

            {step === 'review' && (
              <>
                <View style={styles.card}>
                  <Text style={styles.reviewTitle}>{advertiserName || t('adCreate.untitled')}</Text>
                  <ReviewRow k={t('adCreate.reviewObjective')} v={t(`adCreate.objective.${objective}.label`)} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewPlacements')} v={placements.map(labelFor).join(', ') || '—'} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewBudget')} v={fmtPrice(budgetCents)} styles={styles} />
                  {!!dailyCap && <ReviewRow k={t('adCreate.reviewDailyCap')} v={fmtPrice(Math.round(parseFloat(dailyCap) * 100))} styles={styles} />}
                  <ReviewRow k={t('adCreate.reviewCpm')} v={fmtPrice(cpmCents)} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewRunLength')} v={`${parseInt(days, 10) || 0} ${t('adCreate.daysUnit')}`} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewEstViews')} v={`~${estImps.toLocaleString()}`} styles={styles} />
                  {(ageMin || ageMax || gender !== 'Any' || genres.length > 0 || (useLocation && hasLocation)) ? (
                    <ReviewRow
                      k={t('adCreate.reviewTargeting')}
                      v={[
                        (ageMin || ageMax) ? t('adCreate.ageValue', { min: ageMin || '0', max: ageMax || '∞' }) : null,
                        gender !== 'Any' ? t(GENDERS.find((x) => x.key === gender)?.label ?? 'adCreate.genderAny') : null,
                        genres.length ? t('adCreate.genresValue', { count: genres.length }) : null,
                        useLocation && hasLocation ? `${parseFloat(radiusKm) || 50}km` : null,
                      ].filter(Boolean).join(' · ')}
                      styles={styles}
                    />
                  ) : (
                    <ReviewRow k={t('adCreate.reviewTargeting')} v={t('adCreate.everyone')} styles={styles} />
                  )}
                </View>

                <TouchableOpacity style={styles.termsRow} onPress={() => setTerms((prev) => !prev)} activeOpacity={0.8}>
                  <Ionicons name={terms ? 'checkbox' : 'square-outline'} size={22} color={terms ? colors.primary : colors.textTertiary} />
                  <Text style={styles.termsText}>
                    {t('adCreate.termsText')}
                  </Text>
                </TouchableOpacity>
                <Text
                  onPress={() => router.push('/advertiser-terms')}
                  style={{ color: colors.primary, fontWeight: '700', fontSize: 12, marginTop: 6, marginLeft: 34 }}
                >
                  {t('adCreate.readTerms')}
                </Text>

                <Text style={styles.simNote}>
                  {t('adCreate.simNote')}
                </Text>
              </>
            )}
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            {step === 'review' ? (
              <TouchableOpacity style={[styles.primaryBtn, (!terms || publishing) && styles.primaryBtnDisabled]} onPress={publish} disabled={!terms || publishing}>
                {publishing ? <ActivityIndicator color={colors.text} size="small" /> : <Text style={styles.primaryBtnText}>{t('adCreate.launchBtn', { price: fmtPrice(budgetCents) })}</Text>}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.primaryBtn} onPress={next}>
                <Text style={styles.primaryBtnText}>{t('adCreate.continue')}</Text>
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
