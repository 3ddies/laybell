import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Alert, Image, Switch, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '../../lib/supabase';
import { uploadToStorageWithProgress, compressVideoIfPossible } from '../../lib/upload';
import { uploadVideoToStream, resolveStreamSubdomain, streamHlsUrl, streamPosterUrl, streamUidFromUrl, untrackStreamUpload } from '../../lib/streamUpload';
import { probeAudioDurationSec } from '../../lib/audioProbe';
import {
  purchaseAdCampaign, estimatedImpressions, fmtPrice, AD_MIN_BUDGET_CENTS,
  AD_DEFAULT_CPM_CENTS, AD_CREATIVE_BUCKET, AD_UNSKIPPABLE_MAX_SEC, AD_SKIP_LONG_MIN_SEC, AD_PREMIUM_RATE, isPremiumPlacement,
  adVolumeBonus, AD_VOLUME_BONUS_MAX_PCT,
  type AdPlacement, type AdObjective, type AdMediaType, type NewCreativeInput, type AdSkipMode,
} from '../../lib/ads';
import { analyzeUrl, scanText } from '../../lib/linkSafety';
import { saveAdDraft, loadAdDraft, clearAdDraft, isMeaningfulAdDraft, type AdDraft } from '../../lib/adDrafts';
import { GENRES, genreLabel } from '../../lib/genres';
import { fetchSellerListings, type ShopListing } from '../../lib/shop';
import { useProfile } from '../../contexts/ProfileContext';
import SwipeBackPager from '../../components/SwipeBackPager';
import TagPeopleModal from '../../components/TagPeopleModal';
import PhotoGrid, { type PickedMedia } from '../../components/PhotoGrid';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

type TFn = (key: string, vars?: Record<string, string | number>) => string;
type TargetProfile = { id: string; username: string | null; display_name: string | null; avatar_url: string | null };

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
  { key: 'tv', icon: 'tv-outline' },
  { key: 'audio', icon: 'musical-notes-outline' },
];

const GENDERS: { key: string; label: string }[] = [
  { key: 'Any', label: 'adCreate.genderAny' },
  { key: 'Male', label: 'adCreate.genderMale' },
  { key: 'Female', label: 'adCreate.genderFemale' },
  { key: 'Other', label: 'adCreate.genderOther' },
];

type Pick = { uri: string; width?: number; height?: number; kind: 'image' | 'video' | 'audio'; durationSec?: number | null; name?: string; mime?: string };
// `cover` is an optional image used as the audio ad's "album art" — it plays
// like a song in the player, so advertisers can upload cover art for it.
// `skipMode` is only meaningful for TV + music ads: 'unskippable' plays fully
// (creative ≤15s), 'skip15' is skippable after 15s (creative >15s).
type CreativeDraft = { picks: Pick[]; cover?: Pick | null; headline: string; body: string; ctaLabel: string; ctaUrl: string; skipMode: AdSkipMode };

// The button label pre-typed into a creative: the objective's default, which
// the advertiser can still edit.
function objectiveCta(obj: AdObjective, t: TFn): string {
  return obj === 'awareness' ? t('adCta.visitProfile')
    : obj === 'engagement' ? t('adCta.visitShop')
    : t('adCta.visitWebsite');
}
// Any of the built-in defaults (incl. the legacy 'Learn more') counts as
// "not customized", so switching objective re-fills it but a typed label stays.
function isDefaultCta(label: string, t: TFn): boolean {
  const s = label.trim();
  return !s || [t('adCreate.ctaDefault'), t('adCta.visitProfile'), t('adCta.visitShop'), t('adCta.visitWebsite')]
    .some((d) => d.trim() === s);
}
const emptyDraft = (t: TFn, obj: AdObjective): CreativeDraft => ({ picks: [], headline: '', body: '', ctaLabel: objectiveCta(obj, t), ctaUrl: '', skipMode: 'unskippable' });


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

  // ── Objective destinations ───────────────────────────────────────────────────
  // awareness → profile(s): the advertiser's own profile is included by default,
  // plus any others they add (a viewer tapping picks which to visit when >1).
  const [awarenessSelf, setAwarenessSelf] = useState(true);
  const [awarenessOthers, setAwarenessOthers] = useState<TargetProfile[]>([]);
  const [showProfilePicker, setShowProfilePicker] = useState(false);
  // Website → the link + button text are set right here in Basics (one per
  // campaign) rather than per creative.
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [websiteCta, setWebsiteCta] = useState(() => t('adCta.visitWebsite'));
  // engagement → the advertiser's shop, featuring one of their active listings.
  const [myListings, setMyListings] = useState<ShopListing[] | null>(null);
  const [shopListingId, setShopListingId] = useState<string | null>(null);
  const [showListingPicker, setShowListingPicker] = useState(false);

  const awarenessIds = [
    ...(awarenessSelf && profile?.id ? [profile.id] : []),
    ...awarenessOthers.map((p) => p.id),
  ];
  const chosenListing = (myListings ?? []).find((l) => l.id === shopListingId) ?? null;

  // Load the advertiser's own active listings once, when Shop traffic is picked.
  useEffect(() => {
    if (objective !== 'engagement' || myListings !== null || !profile?.id) return;
    fetchSellerListings(profile.id).then((ls) => setMyListings(ls)).catch(() => setMyListings([]));
  }, [objective, myListings, profile?.id]);
  // Business ads carry their own uploaded profile picture; regular-user ads reuse
  // the creator's own profile avatar (snapshotted at publish).
  const [businessAvatar, setBusinessAvatar] = useState<Pick | null>(null);

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

  // ── Draft resume + autosave ────────────────────────────────────────────────
  // `hydrated` gates autosave until we've decided whether to resume an existing
  // draft, so the first render can't overwrite it before the user chooses.
  const [hydrated, setHydrated] = useState(false);

  function applyDraft(d: AdDraft) {
    setStep((STEPS.includes(d.step as Step) ? d.step : 'basics') as Step);
    setObjective(d.objective as AdObjective);
    setAdvertiserName(d.advertiserName ?? '');
    setIsBusiness(!!d.isBusiness);
    setBusinessAvatar(d.businessAvatar ?? null);
    if (typeof d.awarenessSelf === 'boolean') setAwarenessSelf(d.awarenessSelf);
    setAwarenessOthers((d.awarenessOthers ?? []) as TargetProfile[]);
    setShopListingId(d.shopListingId ?? null);
    setWebsiteUrl(d.websiteUrl ?? '');
    setWebsiteCta(d.websiteCta ?? '');
    setPlacements((d.placements ?? []) as AdPlacement[]);
    setDrafts((d.drafts ?? {}) as Record<string, CreativeDraft>);
    setAgeMin(d.ageMin ?? ''); setAgeMax(d.ageMax ?? ''); setGender(d.gender ?? 'Any');
    setGenres(d.genres ?? []); setUseLocation(!!d.useLocation); setRadiusKm(d.radiusKm ?? '50');
    setBudget(d.budget ?? '20'); setDailyCap(d.dailyCap ?? ''); setCpm(d.cpm ?? String(AD_DEFAULT_CPM_CENTS / 100));
    setDays(d.days ?? '7');
  }

  // On open: offer to resume an unfinished ad (or start fresh).
  useEffect(() => {
    let alive = true;
    loadAdDraft().then((d) => {
      if (!alive) return;
      if (isMeaningfulAdDraft(d)) {
        Alert.alert(
          t('adDraft.resumeTitle'),
          t('adDraft.resumeBody'),
          [
            { text: t('adDraft.startOver'), style: 'destructive', onPress: () => { clearAdDraft(); setHydrated(true); } },
            { text: t('adDraft.resume'), onPress: () => { applyDraft(d as AdDraft); setHydrated(true); } },
          ],
          { cancelable: false },
        );
      } else {
        setHydrated(true);
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave the whole form (debounced) so leaving mid-build loses nothing.
  useEffect(() => {
    if (!hydrated) return;
    const id = setTimeout(() => {
      saveAdDraft({
        step, objective, advertiserName, isBusiness, businessAvatar,
        awarenessSelf, awarenessOthers, shopListingId, websiteUrl, websiteCta,
        placements, drafts, ageMin, ageMax, gender, genres, useLocation, radiusKm,
        budget, dailyCap, cpm, days,
      });
    }, 500);
    return () => clearTimeout(id);
  }, [hydrated, step, objective, advertiserName, isBusiness, businessAvatar,
      awarenessSelf, awarenessOthers, shopListingId, websiteUrl, websiteCta,
      placements, drafts, ageMin, ageMax, gender, genres, useLocation, radiusKm,
      budget, dailyCap, cpm, days]);

  // Keep the pre-typed button label matching the objective's default (Visit
  // profile / Visit shop / Visit website) — unless the advertiser typed their
  // own. Also upgrades a legacy "Learn more" left in a resumed draft.
  useEffect(() => {
    if (!hydrated) return;
    if (objective === 'traffic') {
      setWebsiteCta((cur) => (isDefaultCta(cur, t) ? t('adCta.visitWebsite') : cur));
    } else {
      const label = objectiveCta(objective, t);
      setDrafts((prev) => {
        let changed = false;
        const next: Record<string, CreativeDraft> = {};
        for (const k of Object.keys(prev)) {
          if (isDefaultCta(prev[k].ctaLabel, t)) { next[k] = { ...prev[k], ctaLabel: label }; changed = true; }
          else next[k] = prev[k];
        }
        return changed ? next : prev;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, objective]);

  // Which placement the library video grid is currently picking for.
  const [videoPickerFor, setVideoPickerFor] = useState<AdPlacement | null>(null);

  const hasLocation = profile?.latitude != null && profile?.longitude != null;

  function patchDraft(p: AdPlacement, patch: Partial<CreativeDraft>) {
    setDrafts((prev) => ({ ...prev, [p]: { ...(prev[p] ?? emptyDraft(t, objective)), ...patch } }));
  }

  function togglePlacement(p: AdPlacement) {
    setPlacements((prev) => {
      const has = prev.includes(p);
      if (has) return prev.filter((x) => x !== p);
      setDrafts((d) => (d[p] ? d : { ...d, [p]: emptyDraft(t, objective) }));
      return [...prev, p];
    });
  }

  function toggleGenre(g: string) {
    setGenres((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  // ── Media picking ──────────────────────────────────────────────────────────
  async function pickPhotos(p: AdPlacement) {
    const ImagePicker = await import('expo-image-picker');
    // No permission gate — the system PHPicker needs none (SDK 54 docs), and the
    // old request added an IPC round-trip + a needless full-library prompt.
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 8,
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.length) return;
    const picks: Pick[] = res.assets.map((a) => ({ uri: a.uri, width: a.width, height: a.height, kind: 'image' }));
    patchDraft(p, { picks });
  }

  // Videos come from the SAME library grid the composer uses for reels
  // (expo-media-library → getAssetInfoAsync localUri) — the system picker's
  // export step failed outright on some videos ("The operation could not be
  // completed"), so any video that posts as a reel now works here too.
  function pickVideo(p: AdPlacement) {
    setVideoPickerFor(p);
  }

  function onVideoPicked(m: PickedMedia) {
    const p = videoPickerFor;
    setVideoPickerFor(null);
    if (!p || m.type !== 'video') return;
    // Laybell TV is a landscape surface (watchable on a real TV), so a vertical
    // clip would sit in pillarboxes and defeat the placement. Reject a portrait
    // video and ask for a horizontal one — but only when we actually know the
    // dimensions (unknown dims fall through and default to 16:9 downstream).
    if (p === 'tv' && m.width && m.height && m.height > m.width) {
      Alert.alert(t('adCreate.tvVerticalTitle'), t('adCreate.tvVerticalBody'));
      return;
    }
    patchDraft(p, {
      picks: [{ uri: m.uri, width: m.width, height: m.height, kind: 'video', durationSec: m.duration ? Math.round(m.duration) : null }],
    });
  }

  async function pickAudio(p: AdPlacement) {
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const probed = await probeAudioDurationSec(a.uri);
    const dur: number | null = probed != null ? Math.floor(probed) : null;
    patchDraft(p, { picks: [{ uri: a.uri, kind: 'audio', name: a.name, mime: a.mimeType ?? undefined, durationSec: dur }] });
  }

  // Cover art for an audio ad (optional) — shown as the "album art" while the ad
  // plays like a song in the player.
  async function pickCover(p: AdPlacement) {
    const ImagePicker = await import('expo-image-picker');
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    patchDraft(p, { cover: { uri: a.uri, width: a.width, height: a.height, kind: 'image' } });
  }

  // Business profile picture (optional) — becomes the advertiser avatar shown on
  // every ad. Regular-user campaigns reuse the creator's own profile avatar, so
  // this picker only appears when "This is a business" is on.
  async function pickBusinessAvatar() {
    const ImagePicker = await import('expo-image-picker');
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setBusinessAvatar({ uri: a.uri, width: a.width, height: a.height, kind: 'image' });
  }

  // ── Validation ───────────────────────────────────────────────────────────────
  function validateStep(s: Step): string | null {
    if (s === 'basics' && isBusiness && !advertiserName.trim()) return t('adCreate.errAdvertiserName');
    if (s === 'basics' && objective === 'awareness' && awarenessIds.length === 0) return t('adCreate.errNoProfile');
    if (s === 'basics' && objective === 'traffic') {
      // Website link + safety are validated here now (set in Basics, not per creative).
      if (!websiteUrl.trim()) return t('adCreate.errLink', { placement: '' });
      if (analyzeUrl(websiteUrl).verdict === 'block') return t('adCreate.errUnsafeLink', { placement: '' });
    }
    if (s === 'basics' && objective === 'engagement') {
      if (myListings !== null && myListings.length === 0) return t('adCreate.errNoShop');
      if (!shopListingId) return t('adCreate.errNoListing');
    }
    if (s === 'placements' && placements.length === 0) return t('adCreate.errPlacement');
    if (s === 'creatives') {
      for (const p of placements) {
        const d = drafts[p];
        if (!d || d.picks.length === 0) return t('adCreate.errCreative', { placement: labelFor(p) });
        // Laybell TV is landscape-only — backstop the pick-time reject (e.g. a
        // resumed draft, or dims that weren't known when picked) so a vertical
        // clip can never launch as a TV ad.
        if (p === 'tv') {
          const v = d.picks[0];
          if (v?.width && v?.height && v.height > v.width) return t('adCreate.tvVerticalBody');
        }
        // Skip mode ↔ duration contract (TV + music ads): unskippable spots must
        // be ≤15s (they play fully), skippable-after-15s spots must be >15s.
        if (p === 'tv' || p === 'audio') {
          const dur = d.picks[0]?.durationSec ?? null;
          if (dur != null) {
            if (d.skipMode === 'unskippable' && dur > AD_UNSKIPPABLE_MAX_SEC) return t('adCreate.errSkipTooLong', { placement: labelFor(p) });
            if (d.skipMode === 'skip15' && dur <= AD_SKIP_LONG_MIN_SEC) return t('adCreate.errSkipTooShort', { placement: labelFor(p) });
          }
        }
        if (!d.headline.trim()) return t('adCreate.errHeadline', { placement: labelFor(p) });
        // The destination (link/profile/shop) is set once in Basics now — no
        // per-creative link. A blocked link hidden in the body is still rejected.
        if (scanText(d.body).verdict === 'block') return t('adCreate.errUnsafeLink', { placement: labelFor(p) });
      }
    }
    if (s === 'budget') {
      if (!(parseFloat(budget) > 0)) return t('adCreate.errBudget');
      // Checked here because the server minimum was otherwise discovered at the
      // very END of the flow — after uploading every creative, including a
      // Cloudflare Stream video transcode — and surfaced as a raw Postgres
      // string. Mirrors ad_min_budget_cents().
      if (Math.round(parseFloat(budget) * 100) < AD_MIN_BUDGET_CENTS) {
        return t('adCreate.errBudgetMin', { min: fmtPrice(AD_MIN_BUDGET_CENTS) });
      }
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
      // Route video creatives through Cloudflare Stream (transcoded to H.264 HLS)
      // — the SAME pipeline as regular video posts — so the ad CASTS to a real TV.
      // A raw MP4 in Supabase (often HEVC from an iPhone) loads on the Chromecast
      // but never plays. Falls back to a direct MP4 if Stream is unavailable
      // (still plays on the phone; just may not cast).
      try {
        const vuid = await uploadVideoToStream(compressed);
        const sub = await resolveStreamSubdomain(vuid);
        if (sub) return { url: streamHlsUrl(sub, vuid), thumb: streamPosterUrl(sub, vuid) };
      } catch { /* fall through to the direct upload */ }
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
    // Default CTA button text tracks the objective; a link is stored only for
    // Website traffic (Account/Shop traffic route internally, no URL).
    const ctaFallback = objectiveCta(objective, t);
    const base = {
      placement: p,
      media_type: mt,
      headline: d.headline.trim() || null,
      body: d.body.trim() || null,
      // Website's link + button are campaign-level (set in Basics); Account and
      // Shop use the per-creative button label with an objective default.
      cta_label: objective === 'traffic'
        ? (websiteCta.trim() || ctaFallback)
        : (d.ctaLabel.trim() || ctaFallback),
      cta_url: objective === 'traffic' ? (websiteUrl.trim() || null) : null,
      // Skip mode applies to Laybell TV + music ads only; null everywhere else.
      skip_mode: (p === 'tv' || p === 'audio') ? d.skipMode : null,
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

    // Audio ads carry an optional uploaded cover image (their "album art"). Upload
    // it if provided; it becomes both cover_url and thumbnail_url for the ad.
    let audioCover: string | null = null;
    if (mt === 'audio' && d.cover) {
      setUploadLabel(t('adCreate.uploadingCover', { placement: labelFor(p) }));
      const up = await uploadOne(uid, d.cover);
      audioCover = up.url;
    }

    return {
      ...base,
      media_url: url,
      thumbnail_url: mt === 'audio' ? audioCover : thumb ?? null,
      cover_url: mt === 'audio' ? audioCover : thumb ?? null,
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

      // Advertiser identity. A business supplies its own name + uploaded picture.
      // A regular user's ad runs under their normal profile (like a regular post):
      // name = their display name / username, avatar = their profile picture.
      let advertiserAvatarUrl: string | null = null;
      let advertiserDisplayName: string;
      if (isBusiness) {
        advertiserDisplayName = advertiserName.trim();
        if (businessAvatar) {
          setUploadLabel(t('adCreate.uploadingLogo'));
          const up = await uploadOne(user.id, businessAvatar);
          advertiserAvatarUrl = up.url;
        }
      } else {
        advertiserDisplayName = (profile?.display_name || profile?.username || '').trim();
        advertiserAvatarUrl = profile?.avatar_url ?? null;
      }

      setUploadLabel(t('adCreate.launchingCampaign'));
      const endsAt = new Date(Date.now() + Math.max(1, parseInt(days, 10) || 1) * 86_400_000).toISOString();
      const id = await purchaseAdCampaign({
        objective,
        advertiserName: advertiserDisplayName,
        isBusiness,
        advertiserAvatarUrl,
        placements,
        creatives,
        budgetCentsTotal: Math.round(parseFloat(budget) * 100),
        budgetCentsDaily: null,          // no manual daily cap — the run length paces it
        bidCpmCents: AD_DEFAULT_CPM_CENTS, // flat platform rate (no advertiser bid)
        startsAt: null,
        endsAt,
        // Objective destinations (traffic uses the creative link above).
        targetProfileIds: objective === 'awareness' ? awarenessIds : null,
        targetShopListingId: objective === 'engagement' ? shopListingId : null,
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
      // Launched — the draft is done; drop it so a fresh ad starts clean. Video
      // creatives now live on a saved campaign, so release them from the Stream
      // crash-recovery tracker (see lib/streamUpload).
      for (const c of creatives) {
        const vuid = streamUidFromUrl(c.media_url);
        if (vuid) untrackStreamUpload(vuid);
      }
      clearAdDraft();
      const r = router as any;
      if (typeof r.replace === 'function') r.replace(`/ad-manager/${id}`);
      else r.back();
    } catch (e: any) {
      // Funding failures are not upload failures. purchaseAdCampaign rethrows
      // the insufficient-funds error specifically so this can route the
      // advertiser to buy credits — presenting it as "Upload failed" with a raw
      // Postgres message underneath was how a paying customer got turned away.
      const msg = String(e?.message ?? '');
      if (msg.includes('insufficient funds')) {
        Alert.alert(t('adCreate.needCreditsTitle'), t('adCreate.needCreditsBody'));
        (router as any).push('/credits');
      } else if (msg.includes('below_minimum')) {
        Alert.alert(t('adCreate.uploadFailedTitle'), t('adCreate.errBudgetMin', { min: fmtPrice(AD_MIN_BUDGET_CENTS) }));
      } else {
        Alert.alert(t('adCreate.uploadFailedTitle'), e?.message ?? t('adCreate.uploadFailedBody'));
      }
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  // ── Renders ───────────────────────────────────────────────────────────────────
  // The name shown on the ad: a business's typed name, else the user's own
  // profile name (regular-user ads run like a normal post).
  const previewAdvertiserName = isBusiness
    ? advertiserName.trim()
    : (profile?.display_name || profile?.username || '').trim();

  const budgetCents = Math.round((parseFloat(budget) || 0) * 100);
  // Flat platform rate, stretched by the volume bonus (bigger budgets go further).
  const volumeBonus = adVolumeBonus(budgetCents);
  const estImps = Math.round(estimatedImpressions(budgetCents, AD_DEFAULT_CPM_CENTS) * volumeBonus);
  const bonusPct = Math.round((volumeBonus - 1) * 100);
  const hasPremiumPlacement = placements.some(isPremiumPlacement);

  const stepTitle: Record<Step, string> = {
    basics: t('adCreate.stepBasics'),
    placements: t('adCreate.stepPlacements'),
    creatives: t('adCreate.stepCreatives'),
    targeting: t('adCreate.stepTargeting'),
    budget: t('adCreate.stepBudget'),
    review: t('adCreate.stepReview'),
  };

  function renderCreativeCard(p: AdPlacement) {
    const d = drafts[p] ?? emptyDraft(t, objective);
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
                {d.cover ? (
                  <Image source={{ uri: d.cover.uri }} style={styles.audioCover} />
                ) : (
                  <View style={[styles.audioCover, styles.audioCoverEmpty]}>
                    <Ionicons name="musical-notes" size={20} color={colors.primary} />
                  </View>
                )}
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
          {(p === 'reels' || p === 'tv') && (
            <TouchableOpacity style={styles.pickBtn} onPress={() => pickVideo(p)}>
              <Ionicons name="videocam-outline" size={16} color={colors.text} />
              <Text style={styles.pickBtnText}>{d.picks.length ? t('adCreate.changeVideo') : t('adCreate.addVideo')}</Text>
            </TouchableOpacity>
          )}
          {p === 'audio' && (
            <>
              <TouchableOpacity style={styles.pickBtn} onPress={() => pickAudio(p)}>
                <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                <Text style={styles.pickBtnText}>{d.picks.length ? t('adCreate.changeAudio') : t('adCreate.addAudio')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickBtn} onPress={() => pickCover(p)}>
                <Ionicons name="image-outline" size={16} color={colors.text} />
                <Text style={styles.pickBtnText}>{d.cover ? t('adCreate.changeCover') : t('adCreate.addCover')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Skip behavior — Laybell TV + music ads only. */}
        {(p === 'tv' || p === 'audio') && (
          <View style={styles.skipModeWrap}>
            <Text style={styles.skipModeTitle}>{t('adCreate.skipMode.title')}</Text>
            {(['unskippable', 'skip15'] as AdSkipMode[]).map((mode) => {
              const on = d.skipMode === mode;
              return (
                <TouchableOpacity
                  key={mode}
                  style={[styles.skipModeOpt, on && styles.skipModeOptOn]}
                  onPress={() => patchDraft(p, { skipMode: mode })}
                  activeOpacity={0.8}
                >
                  <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={18} color={on ? colors.primary : colors.textTertiary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.skipModeOptTitle, on && { color: colors.primary }]}>{t(`adCreate.skipMode.${mode}.title`)}</Text>
                    <Text style={styles.skipModeOptSub}>{t(`adCreate.skipMode.${mode}.sub`)}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

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
        {/* The button label is per-creative for Account/Shop; Website's link +
            button are set once in Basics, so this creative just shows where it
            leads (no per-placement destination fields). */}
        {objective !== 'traffic' && (
          <View style={styles.ctaRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder={objective === 'awareness' ? t('adCta.visitProfile') : t('adCta.visitShop')}
              placeholderTextColor={colors.textTertiary}
              value={d.ctaLabel}
              onChangeText={(text) => patchDraft(p, { ctaLabel: text })}
              maxLength={20}
            />
          </View>
        )}
        <View style={styles.destNoteRow}>
          <Ionicons
            name={objective === 'awareness' ? 'person-circle-outline' : objective === 'engagement' ? 'storefront-outline' : 'link-outline'}
            size={15}
            color={colors.textSecondary}
          />
          <Text style={styles.destNoteText}>
            {objective === 'awareness' ? t('adCreate.dest.leadsProfile')
              : objective === 'engagement' ? t('adCreate.dest.leadsShop')
              : t('adCreate.dest.leadsWebsite')}
          </Text>
        </View>
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

                {/* Objective destination — where a tap on this ad leads. */}
                {objective === 'awareness' && (
                  <View style={styles.destCard}>
                    <Text style={styles.destTitle}>{t('adCreate.dest.awarenessTitle')}</Text>
                    <Text style={styles.destSub}>{t('adCreate.dest.awarenessSub')}</Text>
                    <View style={styles.destChipWrap}>
                      <TouchableOpacity
                        style={[styles.profileChip, awarenessSelf && styles.profileChipOn]}
                        onPress={() => setAwarenessSelf((v) => !v)}
                        activeOpacity={0.8}
                      >
                        {profile?.avatar_url
                          ? <Image source={{ uri: profile.avatar_url }} style={styles.chipAvatar} />
                          : <View style={[styles.chipAvatar, styles.chipAvatarEmpty]}><Ionicons name="person" size={12} color={colors.primary} /></View>}
                        <Text style={[styles.destChipText, awarenessSelf && { color: colors.primary }]}>{t('adCreate.dest.you')}</Text>
                        <Ionicons name={awarenessSelf ? 'checkmark-circle' : 'add-circle-outline'} size={15} color={awarenessSelf ? colors.primary : colors.textTertiary} />
                      </TouchableOpacity>
                      {awarenessOthers.map((p) => (
                        <View key={p.id} style={[styles.profileChip, styles.profileChipOn]}>
                          {p.avatar_url
                            ? <Image source={{ uri: p.avatar_url }} style={styles.chipAvatar} />
                            : <View style={[styles.chipAvatar, styles.chipAvatarEmpty]}><Ionicons name="person" size={12} color={colors.primary} /></View>}
                          <Text style={[styles.destChipText, { color: colors.primary }]} numberOfLines={1}>{p.display_name || p.username}</Text>
                          <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.clear')} onPress={() => setAwarenessOthers((o) => o.filter((x) => x.id !== p.id))} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                            <Ionicons name="close-circle" size={15} color={colors.textTertiary} />
                          </TouchableOpacity>
                        </View>
                      ))}
                      <TouchableOpacity style={styles.addProfileChip} onPress={() => setShowProfilePicker(true)} activeOpacity={0.8}>
                        <Ionicons name="person-add-outline" size={14} color={colors.text} />
                        <Text style={styles.destChipText}>{t('adCreate.dest.addProfiles')}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
                {objective === 'traffic' && (
                  <View style={styles.destCard}>
                    <Text style={styles.destTitle}>{t('adCreate.dest.trafficTitle')}</Text>
                    <Text style={styles.destSub}>{t('adCreate.dest.trafficSub')}</Text>
                    <TextInput
                      style={[styles.input, { marginTop: 4 }]}
                      placeholder={t('adCreate.linkPlaceholder')}
                      placeholderTextColor={colors.textTertiary}
                      value={websiteUrl}
                      onChangeText={setWebsiteUrl}
                      autoCapitalize="none"
                      keyboardType="url"
                    />
                    <TextInput
                      style={styles.input}
                      placeholder={t('adCta.visitWebsite')}
                      placeholderTextColor={colors.textTertiary}
                      value={websiteCta}
                      onChangeText={setWebsiteCta}
                      maxLength={20}
                    />
                  </View>
                )}
                {objective === 'engagement' && (
                  <View style={styles.destCard}>
                    <Text style={styles.destTitle}>{t('adCreate.dest.shopTitle')}</Text>
                    {myListings === null ? (
                      <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                    ) : myListings.length === 0 ? (
                      <>
                        <Text style={styles.destSub}>{t('adCreate.dest.noShop')}</Text>
                        <TouchableOpacity onPress={() => router.push('/shop')} activeOpacity={0.7}>
                          <Text style={styles.destLink}>{t('adCreate.dest.openShop')}</Text>
                        </TouchableOpacity>
                      </>
                    ) : chosenListing ? (
                      <TouchableOpacity style={styles.listingRow} onPress={() => setShowListingPicker(true)} activeOpacity={0.8}>
                        {chosenListing.cover_url
                          ? <Image source={{ uri: chosenListing.cover_url }} style={styles.listingCover} />
                          : <View style={[styles.listingCover, styles.chipAvatarEmpty]}><Ionicons name="musical-note" size={18} color={colors.textTertiary} /></View>}
                        <View style={{ flex: 1 }}>
                          <Text style={styles.listingTitle} numberOfLines={1}>{chosenListing.title}</Text>
                          <Text style={styles.destSub}>{t('adCreate.dest.changeListing')}</Text>
                        </View>
                        <Ionicons name="swap-horizontal" size={18} color={colors.textTertiary} />
                      </TouchableOpacity>
                    ) : (
                      <>
                        <Text style={styles.destSub}>{t('adCreate.dest.shopSub')}</Text>
                        <TouchableOpacity style={styles.pickListingBtn} onPress={() => setShowListingPicker(true)} activeOpacity={0.85}>
                          <Ionicons name="pricetag-outline" size={16} color={colors.primary} />
                          <Text style={[styles.destChipText, { color: colors.primary }]}>{t('adCreate.dest.chooseListing')}</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                )}

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

                {isBusiness ? (
                  <>
                    <Text style={[styles.label, { marginTop: SPACING.md }]}>{t('adCreate.advertiserNameLabel')}</Text>
                    <TextInput
                      style={styles.input}
                      placeholder={t('adCreate.advertiserNamePlaceholder')}
                      placeholderTextColor={colors.textTertiary}
                      value={advertiserName}
                      onChangeText={setAdvertiserName}
                      maxLength={40}
                    />
                    <Text style={[styles.label, { marginTop: SPACING.md }]}>{t('adCreate.businessLogoLabel')}</Text>
                    <TouchableOpacity style={styles.avatarPickRow} onPress={pickBusinessAvatar} activeOpacity={0.8}>
                      {businessAvatar ? (
                        <Image source={{ uri: businessAvatar.uri }} style={styles.avatarPreview} />
                      ) : (
                        <View style={[styles.avatarPreview, styles.avatarPreviewEmpty]}>
                          <Ionicons name="business-outline" size={22} color={colors.primary} />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.avatarPickText}>{businessAvatar ? t('adCreate.changeLogo') : t('adCreate.addLogo')}</Text>
                        <Text style={styles.switchSub}>{t('adCreate.businessLogoSub')}</Text>
                      </View>
                    </TouchableOpacity>
                  </>
                ) : (
                  <View style={styles.profileNoteRow}>
                    {profile?.avatar_url ? (
                      <Image source={{ uri: profile.avatar_url }} style={styles.avatarPreview} />
                    ) : (
                      <View style={[styles.avatarPreview, styles.avatarPreviewEmpty]}>
                        <Ionicons name="person-outline" size={22} color={colors.primary} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      {!!previewAdvertiserName && <Text style={styles.avatarPickText} numberOfLines={1}>{previewAdvertiserName}</Text>}
                      <Text style={styles.switchSub}>{t('adCreate.regularProfileNote')}</Text>
                    </View>
                  </View>
                )}
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

                {/* Just two clear knobs: how much you pay, and for how long. The
                    rate is fixed ($5 / 1,000 views) so the amount-paid → views
                    correlation is simple; no CPM bid or daily cap to puzzle over. */}
                <Text style={styles.label}>{t('adCreate.totalBudgetLabel')}</Text>
                <TextInput style={styles.input} placeholder="20" placeholderTextColor={colors.textTertiary} value={budget} onChangeText={setBudget} keyboardType="decimal-pad" />

                <Text style={styles.label}>{t('adCreate.runLengthLabel')}</Text>
                <TextInput style={styles.input} placeholder="7" placeholderTextColor={colors.textTertiary} value={days} onChangeText={setDays} keyboardType="number-pad" maxLength={3} />

                <View style={styles.estimateCard}>
                  <Ionicons name="eye-outline" size={20} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.estimateBig}>{t('adCreate.estViewsBig', { views: estImps.toLocaleString() })}</Text>
                    <Text style={styles.estimateSub}>
                      {t('adCreate.estExplain', { budget: fmtPrice(budgetCents), views: estImps.toLocaleString(), days: parseInt(days, 10) || 0, rate: fmtPrice(AD_DEFAULT_CPM_CENTS / 2) })}
                    </Text>
                    {bonusPct > 0 && (
                      <Text style={styles.estimateBonus}>{t('adCreate.volumeBonus', { pct: bonusPct })}</Text>
                    )}
                    {bonusPct < AD_VOLUME_BONUS_MAX_PCT && (
                      <Text style={styles.estimateHint}>{t('adCreate.volumeBonusHint', { max: AD_VOLUME_BONUS_MAX_PCT })}</Text>
                    )}
                    {hasPremiumPlacement && (
                      <Text style={styles.estimatePremium}>{t('adCreate.premiumNote', { pct: Math.round(AD_PREMIUM_RATE * 100) })}</Text>
                    )}
                  </View>
                </View>
              </>
            )}

            {step === 'review' && (
              <>
                <View style={styles.card}>
                  <Text style={styles.reviewTitle}>{previewAdvertiserName || t('adCreate.untitled')}</Text>
                  <ReviewRow k={t('adCreate.reviewObjective')} v={t(`adCreate.objective.${objective}.label`)} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewPlacements')} v={placements.map(labelFor).join(', ') || '—'} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewBudget')} v={fmtPrice(budgetCents)} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewRunLength')} v={`${parseInt(days, 10) || 0} ${t('adCreate.daysUnit')}`} styles={styles} />
                  <ReviewRow k={t('adCreate.reviewEstViews')} v={`~${estImps.toLocaleString()}`} styles={styles} />
                  {bonusPct > 0 && <ReviewRow k={t('adCreate.reviewBonus')} v={t('adCreate.bonusValue', { pct: bonusPct })} styles={styles} />}
                  {hasPremiumPlacement && <ReviewRow k={t('adCreate.reviewPremium')} v={t('adCreate.premiumValue', { pct: Math.round(AD_PREMIUM_RATE * 100) })} styles={styles} />}
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

          {/* Library video picker — the reels-proven media grid, videos only. */}
          <Modal
            visible={videoPickerFor !== null}
            animationType="slide"
            onRequestClose={() => setVideoPickerFor(null)}
          >
            <View style={styles.videoPickerContainer}>
              <View style={styles.videoPickerHeader}>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} style={styles.videoPickerClose} onPress={() => setVideoPickerFor(null)}>
                  <Ionicons name="close" size={24} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.videoPickerTitle}>{t('adCreate.addVideo')}</Text>
                <View style={styles.videoPickerClose} />
              </View>
              <PhotoGrid videosOnly onPick={onVideoPicked} />
            </View>
          </Modal>

          {/* Awareness → add other profiles this ad can lead to (reuses the
              app's account multi-select; own profile is handled separately). */}
          <TagPeopleModal
            visible={showProfilePicker}
            initial={awarenessOthers as never}
            onClose={() => setShowProfilePicker(false)}
            onDone={(people) => setAwarenessOthers(people as never as TargetProfile[])}
          />

          {/* Engagement → pick which of your active listings the ad features. */}
          <Modal
            visible={showListingPicker}
            animationType="slide"
            transparent
            onRequestClose={() => setShowListingPicker(false)}
          >
            <View style={styles.listingSheetBackdrop}>
              <View style={styles.listingSheet}>
                <View style={styles.listingSheetHead}>
                  <Text style={styles.listingSheetTitle}>{t('adCreate.dest.chooseListing')}</Text>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('a11y.close')} onPress={() => setShowListingPicker(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Ionicons name="close" size={24} color={colors.text} />
                  </TouchableOpacity>
                </View>
                <ScrollView contentContainerStyle={styles.listingGrid}>
                  {(myListings ?? []).map((l) => {
                    const on = l.id === shopListingId;
                    return (
                      <TouchableOpacity
                        key={l.id}
                        style={styles.listingCell}
                        onPress={() => { setShopListingId(l.id); setShowListingPicker(false); }}
                        activeOpacity={0.85}
                      >
                        {l.cover_url
                          ? <Image source={{ uri: l.cover_url }} style={styles.listingCellCover} />
                          : <View style={[styles.listingCellCover, styles.chipAvatarEmpty]}><Ionicons name="musical-note" size={26} color={colors.textTertiary} /></View>}
                        {on && <View style={styles.listingCellCheck}><Ionicons name="checkmark-circle" size={22} color={colors.primary} /></View>}
                        <Text style={styles.listingCellTitle} numberOfLines={1}>{l.title}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            </View>
          </Modal>
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
  videoPickerContainer: { flex: 1, backgroundColor: colors.background, paddingTop: SPACING.xxl },
  videoPickerHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.sm, paddingBottom: SPACING.sm },
  videoPickerClose: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  videoPickerTitle: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 16, fontWeight: '700' },
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

  // Objective destination (Basics)
  destCard: {
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md, gap: 6,
  },
  destTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  destSub: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  destLink: { color: colors.primary, fontSize: 13, fontWeight: '700', marginTop: 2 },
  destChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  profileChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
    paddingLeft: 4, paddingRight: 10, paddingVertical: 4, backgroundColor: colors.surfaceElevated, maxWidth: 200,
  },
  profileChipOn: { borderColor: colors.primary, backgroundColor: colors.primary + '11' },
  chipAvatar: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  chipAvatarEmpty: { backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center' },
  destChipText: { color: colors.text, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  addProfileChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: RADIUS.full, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  listingRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: 4,
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.md, padding: 8,
  },
  listingCover: { width: 44, height: 44, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceLight },
  listingTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  pickListingBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', marginTop: 4,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.primary,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  destNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  destNoteText: { color: colors.textSecondary, fontSize: 12, flex: 1 },
  // Listing picker sheet
  listingSheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  listingSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    paddingTop: SPACING.md, maxHeight: '80%',
  },
  listingSheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  listingSheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  listingGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, padding: SPACING.md },
  listingCell: { width: '30%', gap: 4 },
  listingCellCover: { width: '100%', aspectRatio: 1, borderRadius: RADIUS.md, backgroundColor: colors.surfaceLight },
  listingCellCheck: { position: 'absolute', top: 6, right: 6, backgroundColor: colors.background, borderRadius: 11 },
  listingCellTitle: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },

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

  // Advertiser avatar picker (business) / profile-reuse note (regular user)
  avatarPickRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border, padding: SPACING.md,
  },
  profileNoteRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.md, marginTop: SPACING.sm,
  },
  avatarPreview: { width: 48, height: 48, borderRadius: RADIUS.full, backgroundColor: colors.surfaceElevated },
  avatarPreviewEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  avatarPickText: { color: colors.text, fontSize: 14, fontWeight: '700' },

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
    backgroundColor: colors.surfaceElevated, borderRadius: RADIUS.md, padding: SPACING.sm,
  },
  audioCover: { width: 44, height: 44, borderRadius: RADIUS.sm, backgroundColor: colors.surfaceLight },
  audioCoverEmpty: { alignItems: 'center', justifyContent: 'center' },
  audioPreviewText: { color: colors.text, fontSize: 13, flex: 1 },
  pickRow: { flexDirection: 'row', gap: SPACING.sm },
  pickBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flex: 1,
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.full, paddingVertical: SPACING.sm,
  },
  pickBtnText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  skipModeWrap: { gap: SPACING.sm, marginTop: SPACING.xs },
  skipModeTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  skipModeOpt: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: RADIUS.md,
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm + 2,
  },
  skipModeOptOn: { borderColor: colors.primary, backgroundColor: colors.surfaceLight },
  skipModeOptTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  skipModeOptSub: { color: colors.textTertiary, fontSize: 12, marginTop: 1 },
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
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm, marginTop: SPACING.md,
    backgroundColor: colors.primary + '14', borderRadius: RADIUS.lg, padding: SPACING.md,
  },
  estimateText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  estimateBig: { color: colors.text, fontSize: 18, fontWeight: '800' },
  estimateSub: { color: colors.textSecondary, fontSize: 13, fontWeight: '500', marginTop: 2, lineHeight: 18 },
  estimateBonus: { color: colors.success, fontSize: 13, fontWeight: '800', marginTop: 6 },
  estimateHint: { color: colors.textTertiary, fontSize: 12, fontWeight: '600', marginTop: 3 },
  estimatePremium: { color: colors.primary, fontSize: 12.5, fontWeight: '700', marginTop: 6 },

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
