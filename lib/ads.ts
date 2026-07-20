import { supabase } from './supabase';
import { tg } from './i18n';
import { bumpBadge } from './badges';
import { fetchBlockedIds } from './blocks';
import { isAdPersonalizationEnabled } from './adPrefs';
import { adFree, adSpacingMultiplier } from './entitlements';
import type { UserAffinityProfile } from './feedScorer';

// Ad ecosystem — dedicated-creative ads across Feed, Reels and Audio + the
// self-serve Ad Manager's data layer. The SEPARATE sibling of lib/spotlight.ts
// (Spotlight promotes an existing post; ads serve uploaded creatives). Schema +
// RLS + the record_ad_event RPC live in supabase/sql/ad_ecosystem.sql. Like
// Spotlight, EVERYTHING degrades gracefully: if the SQL isn't applied yet every
// query/rpc rejects, we catch, and the app behaves exactly as before (no ads).
//
// Model: an advertiser creates a campaign (objective, placements, budget, CPM,
// schedule, optional lightweight targeting) with one uploaded creative per
// placement. Serving is CLIENT-SIDE and unranked — ads are injected at fixed
// cadences (feed: spaced; reels: 3rd then every 5th; audio: 1 min then every
// 6 min) AFTER the organic+spotlight feed is built, so the tuned ranking math
// is never touched. Billing is simulated: each genuinely-new impression accrues
// CPM spend via the RPC and the campaign auto-ends when the budget is spent.

// ─── Flags & constants ─────────────────────────────────────────────────────────

// Master kill switch — flip to false to disable all ad serving instantly.
export const ADS_ENABLED = true;

// Feed: the FIRST ad lands after this many items; every subsequent gap is
// RANDOMIZED between MIN and MAX (ads never sit next to a Spotlight). Random
// spacing keeps the feed from feeling metronomic. Injection runs once per
// fetch and is stored in state, so the placement is stable until a refresh.
export const AD_FEED_GAP = 9;
export const AD_FEED_GAP_MIN = 7;
export const AD_FEED_GAP_MAX = 13;

// Reels: the first ad is 2 reels into scrolling (output index 2), then a
// RANDOM 4-7 videos between each subsequent ad.
export const REEL_AD_FIRST = 2;
export const REEL_AD_EVERY_MIN = 4;
export const REEL_AD_EVERY_MAX = 7;

// Audio: first ad after 1 min of cumulative APP-SESSION listening, then each
// subsequent gate is RANDOMIZED between 3 and 5 min so breaks never feel
// metronomic (nextAudioGateMs()).
export const AUDIO_AD_FIRST_MS = 60_000;
export const AUDIO_AD_EVERY_MIN_MS = 180_000; // 3 min
export const AUDIO_AD_EVERY_MAX_MS = 300_000; // 5 min

// Inclusive integer in [min, max]. Placement uses plain Math.random — feed/
// reel weaving runs once per fetch (result stored in state), and the audio
// gate is a per-break scalar, so nothing re-randomizes on a re-render.
export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Randomized ms until the next audio ad break (3-5 min). Premium widens the gate
 *  (×2 → ~50% fewer music ads) via adSpacingMultiplier. */
export function nextAudioGateMs(): number {
  return randInt(AUDIO_AD_EVERY_MIN_MS, AUDIO_AD_EVERY_MAX_MS) * adSpacingMultiplier();
}

/** ms of listening before the FIRST audio ad of a session. Premium pushes it out
 *  (×2) so the first music-ad break also lands later. */
export function firstAudioGateMs(): number {
  return AUDIO_AD_FIRST_MS * adSpacingMultiplier();
}

// Reel ads become skippable after this much genuine ad playback.
export const AD_SKIP_MS = 5_000;

// Audio (song) ads are un-skippable for longer — they play as a song card
// between tracks and only become skippable after this much playback.
export const AUDIO_AD_SKIP_MS = 10_000;

// How many Laybell TV videos play between sponsors — used by BOTH the landscape
// interstitial cadence (reel/[id]) and the cast auto-advance injection
// (CastContext) so the on-phone and on-TV ad frequency stay identical.
export const TV_AD_EVERY_VIDEOS = 4;

// Advertiser-chosen skip mode (Laybell TV + music ads only): a short spot that
// plays FULLY through with no skip ('unskippable', creative must be ≤15s), or a
// longer spot that becomes skippable after 15s ('skip15', creative must be >15s).
// Named for the MODE ('skip15'), not the value: a skippable TV/music ad becomes
// skippable after this much play — 11s.
export const AD_SKIP15_MS = 11_000;
// Create-flow duration bounds. Unskippable creatives must be ≤16s (SHOWN as
// "15s" — the extra second absorbs clips that report a few hundred ms over 15);
// skippable creatives must be >15s.
export const AD_UNSKIPPABLE_MAX_SEC = 16;
export const AD_SKIP_LONG_MIN_SEC = 15;
export type AdSkipMode = 'unskippable' | 'skip15';

/**
 * Ms of genuine playback before an ad may be skipped — Infinity means it plays
 * fully (no skip). 'unskippable' → Infinity; 'skip15' → 15s. With no mode set
 * (regular reels, or legacy ads) fall back to the placement default.
 */
export function adSkipAfterMs(placement: AdPlacement, skipMode?: string | null): number {
  if (skipMode === 'unskippable') return Infinity;
  if (skipMode === 'skip15') return AD_SKIP15_MS;
  if (placement === 'reels') return AD_SKIP_MS;
  if (placement === 'audio') return AUDIO_AD_SKIP_MS;
  return Infinity; // Laybell TV default: play fully
}

// Storage bucket the Ad Manager uploads creatives to. Reuses the existing
// public 'posts' bucket (same one the composer uploads to) so no extra bucket
// setup is needed — ad creatives are just media files under the user's folder.
export const AD_CREATIVE_BUCKET = 'posts';

// Flat platform CPM for the create flow — $10.00 per 1,000 impressions, i.e.
// $5 per 500 views. The bid is no longer advertiser-set (it confused people);
// every campaign uses this rate and amount-paid → views is budget ÷ this × 1,000.
export const AD_DEFAULT_CPM_CENTS = 1000;

// Music + Laybell TV are premium UNSKIPPABLE placements — they cost 20% more per
// view (the surcharge is Laybell's). Applied server-side in record_ad_event; the
// create flow surfaces it as a note. Keep in sync with the RPC in ad_ecosystem.sql.
export const AD_PREMIUM_RATE = 0.2;
export function isPremiumPlacement(p: AdPlacement): boolean {
  return p === 'tv' || p === 'audio';
}

// Volume bonus: bigger budgets stretch FURTHER (more views per dollar) to reward
// higher spend. Applied as an effective-CPM discount server-side in
// record_ad_event, mirrored here for the create-flow estimate. Tiered + hard-
// capped at +25% so it's noticeable but can't be abused (a $10k budget gets the
// same 25% as a $1k one). KEEP THESE TIERS IN SYNC with the RPC in ad_ecosystem.sql.
export const AD_VOLUME_BONUS_MAX_PCT = 25;
export function adVolumeBonus(budgetCents: number): number {
  if (budgetCents >= 100_000) return 1.25; // $1,000+
  if (budgetCents >=  50_000) return 1.20; // $500+
  if (budgetCents >=  25_000) return 1.15; // $250+
  if (budgetCents >=  10_000) return 1.10; // $100+
  if (budgetCents >=   5_000) return 1.05; // $50+
  return 1.0;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type AdPlacement = 'feed' | 'reels' | 'audio' | 'tv';
export type AdMediaType = 'image' | 'video' | 'slideshow' | 'audio';
export type AdObjective = 'awareness' | 'traffic' | 'engagement';
export type AdStatus = 'pending' | 'active' | 'paused' | 'ended' | 'canceled';

export type AdCreative = {
  id: string;
  campaign_id: string;
  placement: AdPlacement;
  media_type: AdMediaType;
  media_url: string | null;
  slides?: any;
  thumbnail_url?: string | null;
  cover_url?: string | null;
  aspect_ratio?: string | null;
  duration_seconds?: number | null;
  headline?: string | null;
  body?: string | null;
  cta_label?: string | null;
  cta_url?: string | null;
  // Laybell TV + music ads only: 'unskippable' (plays fully, ≤15s) or 'skip15'
  // (skippable after 15s, >15s). Null on reels (fixed 5s) and legacy creatives.
  skip_mode?: string | null;
};

export type AdCampaign = {
  id: string;
  user_id: string;
  kind: 'ad';
  objective?: AdObjective | null;
  placements?: AdPlacement[] | null;
  status: AdStatus;
  starts_at: string | null;
  ends_at: string | null;
  budget_cents_total?: number | null;
  budget_cents_daily?: number | null;
  spent_cents?: number;
  bid_cpm_cents?: number | null;
  impression_count?: number;
  click_count?: number;
  advertiser_name?: string | null;
  advertiser_avatar_url?: string | null;
  is_business?: boolean;
  target_age_min?: number | null;
  target_age_max?: number | null;
  target_gender?: string | null;
  target_genres?: string[] | null;
  target_lat?: number | null;
  target_lng?: number | null;
  target_radius_km?: number | null;
  created_at: string;
  ad_creatives?: AdCreative[];
};

// Marker attached to a served ad item (feed/reel) so the renderer/recorders can
// identify it without confusing it for a real post.
export type AdMeta = {
  campaignId: string;
  creativeId: string;
  ownerId: string;
  advertiserName: string;
  avatarUrl: string | null;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string | null;
  placement: AdPlacement;
  // Advertiser skip mode for TV/music ads ('unskippable' | 'skip15'); null else.
  skipMode?: string | null;
};

// What the audio scheduler needs to play and bill an audio ad.
export type AudioAd = {
  campaignId: string;
  creativeId: string;
  ownerId: string;
  advertiserName: string;
  avatarUrl: string | null;
  headline: string;
  ctaLabel: string;
  ctaUrl: string | null;
  uri: string;
  cover?: string | null;
  durationSeconds?: number | null;
  // 'unskippable' (plays fully) | 'skip15' (skippable after 15s) | null (10s).
  skipMode?: string | null;
};

// A {campaign, creative} pair the reel weaver turns into full-screen ad items.
export type AdSource = { c: AdCampaign; cr: AdCreative };

export type AdViewer = {
  id: string | null;
  profile: {
    age?: number | null;
    gender?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  affinity: UserAffinityProfile;
};

// ─── Eligibility helpers ──────────────────────────────────────────────────────

export function isInBudget(c: AdCampaign): boolean {
  if (c.budget_cents_total == null) return true;
  return (c.spent_cents ?? 0) < c.budget_cents_total;
}

export function isInSchedule(c: AdCampaign): boolean {
  const now = Date.now();
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return false;
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return false;
  return true;
}

// Daily-budget pacing hook. Real pacing needs server-side per-day spend (which
// the simulated model doesn't track yet), so this is a no-op today — total
// budget still hard-caps delivery via isInBudget + the RPC's auto-end. Kept so
// every serving call site is already wired for pacing when it lands.
export function pacingPasses(_c: AdCampaign): boolean {
  return true;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function topGenres(aff: UserAffinityProfile, n: number): string[] {
  return Object.entries(aff?.genreScores ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([g]) => g.toLowerCase());
}

// Does this campaign's targeting match the viewer? Unset dimensions never
// constrain (blank = everyone). When personalization is OFF, only campaigns
// with NO targeting at all are eligible. A campaign that targets a dimension the
// viewer hasn't supplied (e.g. age targeting but the viewer has no age) does NOT
// match — standard targeting semantics.
export function targetingMatch(c: AdCampaign, viewer: AdViewer, personalized: boolean): boolean {
  const hasTargeting =
    c.target_age_min != null ||
    c.target_age_max != null ||
    (!!c.target_gender && c.target_gender !== 'any') ||
    (!!c.target_genres && c.target_genres.length > 0) ||
    (c.target_lat != null && c.target_lng != null);

  if (!personalized) return !hasTargeting;
  if (!hasTargeting) return true;

  const p = viewer.profile;

  if (c.target_age_min != null || c.target_age_max != null) {
    const age = p?.age;
    if (age == null) return false;
    if (c.target_age_min != null && age < c.target_age_min) return false;
    if (c.target_age_max != null && age > c.target_age_max) return false;
  }

  if (c.target_gender && c.target_gender !== 'any') {
    if (!p?.gender || p.gender.toLowerCase() !== c.target_gender.toLowerCase()) return false;
  }

  if (c.target_genres && c.target_genres.length) {
    const top = topGenres(viewer.affinity, 5);
    const want = c.target_genres.map((g) => g.toLowerCase());
    if (!want.some((g) => top.includes(g))) return false;
  }

  if (c.target_lat != null && c.target_lng != null) {
    if (p?.latitude == null || p?.longitude == null) return false;
    const radius = c.target_radius_km ?? 50; // a lat/lng without a radius defaults to ~50km
    if (haversineKm(p.latitude, p.longitude, c.target_lat, c.target_lng) > radius) return false;
  }

  return true;
}

// ─── Item shaping ─────────────────────────────────────────────────────────────

function metaFor(c: AdCampaign, cr: AdCreative, placement: AdPlacement): AdMeta {
  return {
    campaignId: c.id,
    creativeId: cr.id,
    ownerId: c.user_id,
    advertiserName: c.advertiser_name ?? tg('ad.sponsored'),
    avatarUrl: c.advertiser_avatar_url ?? null,
    headline: cr.headline ?? '',
    body: cr.body ?? '',
    ctaLabel: cr.cta_label ?? tg('sponsoredCard.learnMore'),
    ctaUrl: normalizeUrl(cr.cta_url),
    placement,
    skipMode: cr.skip_mode ?? null,
  };
}

// Shape a feed ad like a post (so the FlatList/keyExtractor/viewability code can
// handle it) plus the __ad marker the SponsoredCard renders from.
function feedItemFor(c: AdCampaign, cr: AdCreative): any {
  return {
    id: `ad:${c.id}`,
    type: cr.media_type, // 'image' | 'video' | 'slideshow'
    media_url: cr.media_url,
    caption: cr.body ?? '',
    created_at: c.starts_at ?? c.created_at,
    user_id: c.user_id,
    aspect_ratio: cr.aspect_ratio ?? null,
    thumbnail_url: cr.thumbnail_url ?? null,
    cover_url: cr.cover_url ?? null,
    slides: cr.slides ?? null,
    profiles: {
      username: c.advertiser_name ?? tg('ad.sponsored'),
      display_name: c.advertiser_name ?? tg('ad.sponsored'),
      avatar_url: c.advertiser_avatar_url ?? null,
    },
    likes: [{ count: 0 }],
    comments: [{ count: 0 }],
    __ad: metaFor(c, cr, 'feed'),
  };
}

// Shape a reel ad like a full-screen video post (one entry per slot so the same
// campaign can fill multiple slots without key collisions).
export function reelItemFor(src: AdSource, slot: number): any {
  const { c, cr } = src;
  return {
    id: `ad:${c.id}:${slot}`,
    type: 'video',
    media_url: cr.media_url,
    aspect_ratio: cr.aspect_ratio ?? null,
    thumbnail_url: cr.thumbnail_url ?? null,
    cover_url: cr.cover_url ?? null,
    user_id: c.user_id,
    trim_start: null,
    trim_end: null,
    __ad: metaFor(c, cr, 'reels'),
  };
}

// Shape a Laybell TV ad like a LANDSCAPE video post so it drops into the TV
// video grid alongside real horizontal videos (aspect > 1 keeps it in the TV
// surface). One entry per slot to avoid key collisions.
export function tvItemFor(src: AdSource, slot: number): any {
  const { c, cr } = src;
  return {
    id: `ad:${c.id}:tv:${slot}`,
    type: 'video',
    media_url: cr.media_url,
    // Horizontal by contract; fall back to 16:9 if the creative didn't record it.
    aspect_ratio: cr.aspect_ratio ?? '1.7777777777777777',
    thumbnail_url: cr.thumbnail_url ?? null,
    cover_url: cr.cover_url ?? null,
    caption: cr.headline ?? '',
    user_id: c.user_id,
    profiles: {
      username: c.advertiser_name ?? tg('ad.sponsored'),
      display_name: c.advertiser_name ?? tg('ad.sponsored'),
      avatar_url: c.advertiser_avatar_url ?? null,
    },
    __ad: metaFor(c, cr, 'tv'),
  };
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const t = url.trim();
  if (!t) return null;
  // Force https — never open a sponsored CTA over plaintext http.
  if (/^https:\/\//i.test(t)) return t;
  if (/^http:\/\//i.test(t)) return t.replace(/^http:\/\//i, 'https://');
  return `https://${t}`;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

const CAMPAIGN_SELECT = `
  id, user_id, kind, status, starts_at, ends_at,
  budget_cents_total, budget_cents_daily, spent_cents, bid_cpm_cents,
  impression_count, click_count, advertiser_name, advertiser_avatar_url, is_business, objective, placements,
  target_age_min, target_age_max, target_gender, target_genres,
  target_lat, target_lng, target_radius_km, created_at,
  ad_creatives ( id, campaign_id, placement, media_type, media_url, slides, thumbnail_url, cover_url, aspect_ratio, duration_seconds, headline, body, cta_label, cta_url, skip_mode )
`;

// Live, eligible ad campaigns for this viewer — applies budget, schedule,
// targeting, personalization, blocked-author and pacing filters in JS (so the
// rules live in one place and degrade gracefully). Returns the raw campaigns;
// callers project to the placement they need.
async function fetchEligibleCampaigns(viewer: AdViewer): Promise<AdCampaign[]> {
  if (!ADS_ENABLED) return [];
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select(CAMPAIGN_SELECT)
      .eq('kind', 'ad')
      .eq('status', 'active')
      .gt('ends_at', new Date().toISOString())
      .limit(50);
    if (error || !data) return [];
    const personalized = await isAdPersonalizationEnabled();
    const blocked = await fetchBlockedIds();
    return (data as any[]).filter((c) => {
      if (c.user_id === viewer.id) return false; // never serve your own ad
      if (blocked.has(c.user_id)) return false;
      if (!isInSchedule(c)) return false;
      if (!isInBudget(c)) return false;
      if (!targetingMatch(c, viewer, personalized)) return false;
      if (!pacingPasses(c)) return false;
      return true;
    }) as AdCampaign[];
  } catch {
    return [];
  }
}

function creativeFor(c: AdCampaign, placement: AdPlacement): AdCreative | null {
  const cr = (c.ad_creatives ?? []).find((x) => x.placement === placement);
  if (!cr) return null;
  if (!cr.media_url && !cr.slides) return null;
  return cr;
}

// Feed ads as post-shaped __ad items (one per campaign).
export async function fetchFeedAds(viewer: AdViewer): Promise<any[]> {
  if (adFree()) return [];   // Premium: ad-free feed
  const campaigns = await fetchEligibleCampaigns(viewer);
  const out: any[] = [];
  for (const c of campaigns) {
    const cr = creativeFor(c, 'feed');
    if (cr) out.push(feedItemFor(c, cr));
  }
  return out;
}

// A pool of reel ad sources the weaver rotates through across slots.
export async function fetchReelAds(viewer: AdViewer): Promise<AdSource[]> {
  // Premium is NOT ad-free in reels — it gets ~50% fewer via wider weave spacing
  // (weaveReelAds reads adSpacingMultiplier). So the pool is fetched for everyone.
  const campaigns = await fetchEligibleCampaigns(viewer);
  const out: AdSource[] = [];
  for (const c of campaigns) {
    const cr = creativeFor(c, 'reels');
    if (cr) out.push({ c, cr });
  }
  return out;
}

// Laybell TV ad pool — landscape video ads to weave into the TV video grid.
export async function fetchTvAds(viewer: AdViewer): Promise<AdSource[]> {
  const campaigns = await fetchEligibleCampaigns(viewer);
  const out: AdSource[] = [];
  for (const c of campaigns) {
    const cr = creativeFor(c, 'tv');
    if (cr) out.push({ c, cr });
  }
  return out;
}

// Pick one audio ad for the next break (rotates across calls so the same break
// doesn't always serve the same advertiser).
let audioRotation = 0;
export async function pickAudioAd(viewer: AdViewer): Promise<AudioAd | null> {
  // Premium is NOT ad-free in Music — it gets ~50% fewer via a wider gate between
  // breaks (nextAudioGateMs / firstAudioGateMs read adSpacingMultiplier).
  const campaigns = await fetchEligibleCampaigns(viewer);
  const pool: AudioAd[] = [];
  for (const c of campaigns) {
    const cr = creativeFor(c, 'audio');
    if (cr && cr.media_url) {
      pool.push({
        campaignId: c.id,
        creativeId: cr.id,
        ownerId: c.user_id,
        advertiserName: c.advertiser_name ?? tg('ad.sponsored'),
        avatarUrl: c.advertiser_avatar_url ?? null,
        headline: cr.headline ?? '',
        ctaLabel: cr.cta_label ?? tg('sponsoredCard.learnMore'),
        ctaUrl: normalizeUrl(cr.cta_url),
        uri: cr.media_url,
        cover: cr.cover_url ?? cr.thumbnail_url ?? null,
        durationSeconds: cr.duration_seconds ?? null,
        skipMode: cr.skip_mode ?? null,
      });
    }
  }
  if (!pool.length) return null;
  const pick = pool[audioRotation % pool.length];
  audioRotation++;
  return pick;
}

// ─── Pure injection helpers ───────────────────────────────────────────────────

// Inject feed ads into the already-ranked organic+spotlight list, spaced by
// `gap` and never adjacent to a Spotlight or at the very top/bottom. Leftover
// ads are dropped (held for the next load). Ranking is untouched.
export function injectFeedAds(list: any[], ads: any[], firstGap: number = AD_FEED_GAP): any[] {
  if (!ads.length || list.length < 2) return list;
  const out: any[] = [];
  let since = 0;
  let ai = 0;
  // First ad uses firstGap; each subsequent gap is a fresh random 7-13.
  let nextGap = firstGap;
  for (let i = 0; i < list.length; i++) {
    out.push(list[i]);
    since++;
    const isSpot = !!list[i].__spotlight || !!list[i].__ad;
    const nextIsSpot = i + 1 < list.length && (!!list[i + 1].__spotlight || !!list[i + 1].__ad);
    const notEdge = i < list.length - 1;
    if (ai < ads.length && since >= nextGap && !isSpot && !nextIsSpot && notEdge) {
      out.push(ads[ai++]);
      since = 0;
      nextGap = randInt(AD_FEED_GAP_MIN, AD_FEED_GAP_MAX);
    }
  }
  return out;
}

// Weave reel ads into the ordered reel list: the first at output index 2 (the
// 3rd reel), then a RANDOM 4-7 videos between each subsequent ad. No trailing
// ad; the same campaign can repeat across slots when the pool is small.
// `spacing` widens both the first slot and the between-gaps — premium passes ×2
// (via adSpacingMultiplier) for ~50% fewer reel ads; free users get ×1.
export function weaveReelAds(organic: any[], pool: AdSource[], spacing = adSpacingMultiplier()): any[] {
  if (!pool.length || !organic.length) return organic;
  const out: any[] = [];
  let oi = 0;
  let slot = 0;
  let nextAdAt = Math.round(REEL_AD_FIRST * spacing);
  while (oi < organic.length) {
    const idx = out.length;
    if (idx === nextAdAt) {
      out.push(reelItemFor(pool[slot % pool.length], slot));
      slot++;
      // Skip the ad's own slot, then (4-7)×spacing organic reels before the next.
      nextAdAt = idx + 1 + randInt(Math.round(REEL_AD_EVERY_MIN * spacing), Math.round(REEL_AD_EVERY_MAX * spacing));
    } else {
      out.push(organic[oi]);
      oi++;
    }
  }
  return out;
}

// ─── Impressions, clicks, skips ───────────────────────────────────────────────
// Server-side record_ad_event dedupes impressions per (viewer, campaign,
// placement, hour) and ignores the owner; client-side we also dedupe per app
// session so a scroll-past doesn't even round-trip twice.

const impressedKeys = new Set<string>();
const clickedKeys = new Set<string>();
const skippedKeys = new Set<string>();
const completedKeys = new Set<string>();
const engagedCampaigns = new Set<string>();

function metaOf(item: any): { campaignId: string; creativeId?: string | null; ownerId?: string | null } | null {
  if (!item) return null;
  if (item.__ad) return { campaignId: item.__ad.campaignId, creativeId: item.__ad.creativeId, ownerId: item.__ad.ownerId };
  if (item.campaignId) return { campaignId: item.campaignId, creativeId: item.creativeId, ownerId: item.ownerId };
  return null;
}

// Session-dedup key. Feed/reels show a campaign once per session, so a plain
// campaign:placement key is right. Audio breaks RECUR (every 6 min) and the
// server dedupes per (viewer, campaign, placement, HOUR) — so the audio key
// includes the hour bucket, otherwise only the first break per session would
// ever round-trip and later hours would under-count / under-bill.
function dedupKey(campaignId: string, placement: AdPlacement): string {
  if (placement === 'audio') return `${campaignId}:audio:${Math.floor(Date.now() / 3_600_000)}`;
  return `${campaignId}:${placement}`;
}

function emit(m: { campaignId: string; creativeId?: string | null }, placement: AdPlacement, kind: 'impression' | 'click' | 'skip' | 'complete') {
  supabase
    .rpc('record_ad_event', {
      p_campaign: m.campaignId,
      p_creative: m.creativeId ?? null,
      p_placement: placement,
      p_kind: kind,
    })
    .then(undefined, () => {});
}

export function recordAdImpression(item: any, placement: AdPlacement, uid?: string | null): void {
  const m = metaOf(item);
  if (!m || (m.ownerId && m.ownerId === uid)) return;
  const key = dedupKey(m.campaignId, placement);
  if (impressedKeys.has(key)) return;
  impressedKeys.add(key);
  emit(m, placement, 'impression');
}

export function recordAdClick(item: any, placement: AdPlacement, uid?: string | null): void {
  const m = metaOf(item);
  if (!m || (m.ownerId && m.ownerId === uid)) return;
  const key = dedupKey(m.campaignId, placement);
  if (!clickedKeys.has(key)) {
    clickedKeys.add(key);
    emit(m, placement, 'click');
  }
  // Patron badges count DISTINCT ads engaged with today — one bump per campaign.
  if (!engagedCampaigns.has(m.campaignId)) {
    engagedCampaigns.add(m.campaignId);
    bumpBadge('ad_engagements');
  }
}

export function recordAdSkip(item: any, placement: AdPlacement, uid?: string | null): void {
  const m = metaOf(item);
  if (!m || (m.ownerId && m.ownerId === uid)) return;
  const key = dedupKey(m.campaignId, placement);
  if (skippedKeys.has(key)) return;
  skippedKeys.add(key);
  emit(m, placement, 'skip');
}

export function recordAdComplete(item: any, placement: AdPlacement, uid?: string | null): void {
  const m = metaOf(item);
  if (!m || (m.ownerId && m.ownerId === uid)) return;
  const key = dedupKey(m.campaignId, placement);
  if (completedKeys.has(key)) return;
  completedKeys.add(key);
  emit(m, placement, 'complete');
}

export function resetAdSession(): void {
  impressedKeys.clear();
  clickedKeys.clear();
  skippedKeys.clear();
  completedKeys.clear();
  engagedCampaigns.clear();
  audioRotation = 0;
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') resetAdSession();
});

// ─── Campaign lifecycle (Ad Manager) ──────────────────────────────────────────

export type AdEffectiveStatus = AdStatus;

// An `active` row whose ends_at has passed reads as ended even before the lazy
// DB settle catches up (mirrors spotlight's effectiveStatus).
export function effectiveAdStatus(c: AdCampaign): AdEffectiveStatus {
  if (c.status === 'active' && c.ends_at && new Date(c.ends_at).getTime() <= Date.now()) return 'ended';
  return c.status;
}

export function fmtPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Rough delivery estimate for the budget step (impressions a budget buys at CPM).
export function estimatedImpressions(budgetCents: number, cpmCents: number): number {
  if (!cpmCents) return 0;
  return Math.round((budgetCents / cpmCents) * 1000);
}

export type NewCreativeInput = {
  placement: AdPlacement;
  media_type: AdMediaType;
  media_url: string | null;
  slides?: any;
  thumbnail_url?: string | null;
  cover_url?: string | null;
  aspect_ratio?: string | null;
  duration_seconds?: number | null;
  headline?: string | null;
  body?: string | null;
  cta_label?: string | null;
  cta_url?: string | null;
  skip_mode?: string | null;
};

export type NewCampaignInput = {
  objective: AdObjective;
  advertiserName: string;
  isBusiness: boolean;
  // Display avatar for the ad: an uploaded business logo, or the creator's own
  // profile avatar for a regular-user campaign. Null = fall back to an initial.
  advertiserAvatarUrl?: string | null;
  placements: AdPlacement[];
  creatives: NewCreativeInput[];
  budgetCentsTotal: number;
  budgetCentsDaily?: number | null;
  bidCpmCents: number;
  startsAt: string | null; // ISO, or null = now
  endsAt: string; // ISO
  targeting: {
    ageMin?: number | null;
    ageMax?: number | null;
    gender?: string | null;
    genres?: string[] | null;
    lat?: number | null;
    lng?: number | null;
    radiusKm?: number | null;
  };
};

// Create a live campaign + its creatives + the (simulated) payment record. The
// creatives are already uploaded by the time this runs, so the campaign goes
// straight to `active` (gated by schedule/budget at serve time). When a real
// provider lands, only this function + ad_ecosystem.sql change.
export async function purchaseAdCampaign(input: NewCampaignInput): Promise<string | null> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const nowIso = new Date().toISOString();
    // Create as `pending` first; flip to `active` only once creatives land, so a
    // failed/half-failed creative insert can never leave a live-but-empty
    // campaign serving (a pending campaign is excluded from serving by RLS).
    const insertRow: Record<string, any> = {
      user_id: user.id,
      kind: 'ad',
      status: 'pending',
      objective: input.objective,
      advertiser_name: input.advertiserName,
      advertiser_avatar_url: input.advertiserAvatarUrl ?? null,
      is_business: input.isBusiness,
      placements: input.placements,
      budget_cents_total: input.budgetCentsTotal,
      budget_cents_daily: input.budgetCentsDaily ?? null,
      bid_cpm_cents: input.bidCpmCents,
      price_cents: 0,
      spent_cents: 0,
      starts_at: input.startsAt ?? nowIso,
      ends_at: input.endsAt,
      policy_accepted_at: nowIso,
      target_age_min: input.targeting.ageMin ?? null,
      target_age_max: input.targeting.ageMax ?? null,
      target_gender: input.targeting.gender ?? null,
      target_genres: input.targeting.genres?.length ? input.targeting.genres.map((g) => g.toLowerCase()) : null,
      target_lat: input.targeting.lat ?? null,
      target_lng: input.targeting.lng ?? null,
      target_radius_km: input.targeting.radiusKm ?? null,
    };
    let { data: campaign, error } = await supabase
      .from('ad_campaigns').insert(insertRow).select('id').single();
    // Resilience: an older ad_ecosystem.sql may lack the (cosmetic, nullable)
    // advertiser_avatar_url column — rather than hard-block the whole launch on
    // one missing column, drop it and retry. Re-running ad_ecosystem.sql adds it
    // back and future ads carry the avatar again.
    if (error && /advertiser_avatar_url/i.test(error.message ?? '')) {
      delete insertRow.advertiser_avatar_url;
      ({ data: campaign, error } = await supabase
        .from('ad_campaigns').insert(insertRow).select('id').single());
    }
    if (error || !campaign) return null;

    const rows = input.creatives.map((cr) => ({ ...cr, campaign_id: campaign.id }));
    if (rows.length) {
      let { error: crErr } = await supabase.from('ad_creatives').insert(rows);
      // Resilience: an older ad_ecosystem.sql lacks the (nullable) skip_mode
      // column — strip it and retry so a launch never hard-blocks on the pending
      // migration (the ad just falls back to its placement-default skip timing).
      if (crErr && /skip_mode/i.test(crErr.message ?? '')) {
        const stripped = rows.map(({ skip_mode, ...rest }) => rest);
        ({ error: crErr } = await supabase.from('ad_creatives').insert(stripped));
      }
      if (crErr) {
        // Roll back the pending campaign; if even this fails the row stays
        // `pending` and never serves, so nothing broken goes live.
        await supabase.from('ad_campaigns').update({ status: 'canceled' }).eq('id', campaign.id);
        return null;
      }
    }

    // Creatives are in — go live.
    const { data: activated, error: actErr } = await supabase
      .from('ad_campaigns')
      .update({ status: 'active' })
      .eq('id', campaign.id)
      .eq('status', 'pending')
      .select('id');
    if (actErr || !activated?.length) return null; // stays pending (non-serving) on failure

    await supabase.from('ad_payments').insert({
      user_id: user.id,
      campaign_id: campaign.id,
      amount_cents: input.budgetCentsTotal,
      provider: 'simulated',
      status: 'succeeded',
    });
    return campaign.id as string;
  } catch {
    return null;
  }
}

// All of the caller's ad campaigns (newest first) with their creatives. Expired
// actives are lazily settled to `ended` first so the list agrees with serving.
export async function fetchMyAdCampaigns(): Promise<AdCampaign[]> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    await supabase
      .from('ad_campaigns')
      .update({ status: 'ended' })
      .eq('user_id', user.id)
      .eq('kind', 'ad')
      .eq('status', 'active')
      .lt('ends_at', new Date().toISOString());
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select(CAMPAIGN_SELECT)
      .eq('user_id', user.id)
      .eq('kind', 'ad')
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return data as AdCampaign[];
  } catch {
    return [];
  }
}

export async function fetchAdCampaign(id: string): Promise<AdCampaign | null> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select(CAMPAIGN_SELECT)
      .eq('id', id)
      .eq('kind', 'ad')
      .single();
    if (error || !data) return null;
    return data as AdCampaign;
  } catch {
    return null;
  }
}

export async function pauseAdCampaign(id: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .update({ status: 'paused' })
      .eq('id', id)
      .eq('status', 'active')
      .select('id');
    return !error && !!data?.length;
  } catch {
    return false;
  }
}

export async function resumeAdCampaign(id: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .update({ status: 'active' })
      .eq('id', id)
      .eq('status', 'paused')
      .select('id');
    return !error && !!data?.length;
  } catch {
    return false;
  }
}

export async function endAdCampaign(id: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .update({ status: 'ended' })
      .eq('id', id)
      .in('status', ['active', 'paused'])
      .select('id');
    return !error && !!data?.length;
  } catch {
    return false;
  }
}

export async function reportAd(campaignId: string, creativeId?: string | null, reason: string = 'other'): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { error } = await supabase.from('ad_reports').insert({
      campaign_id: campaignId,
      creative_id: creativeId ?? null,
      reporter_id: user.id,
      reason,
    });
    return !error;
  } catch {
    return false;
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export type AdAnalytics = {
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  skips: number;
  completes: number;
  spentCents: number;
  byPlacement: { placement: AdPlacement; impressions: number; clicks: number }[];
  series: { label: string; impressions: number; clicks: number }[]; // per-day
};

// Per-campaign analytics from ad_events (owner-readable) + campaign counters.
export async function fetchAdAnalytics(campaignId: string): Promise<AdAnalytics | null> {
  try {
    const { data: events, error } = await supabase
      .from('ad_events')
      .select('viewer_id, placement, kind, created_at')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true })
      .limit(5000);
    if (error) return null;
    const rows = (events ?? []) as any[];

    const camp = await fetchAdCampaign(campaignId);

    let impressions = 0, clicks = 0, skips = 0, completes = 0;
    const reachSet = new Set<string>();
    const placeMap: Record<string, { impressions: number; clicks: number }> = {};
    const dayMap: Record<string, { impressions: number; clicks: number }> = {};

    for (const e of rows) {
      const pm = (placeMap[e.placement] ??= { impressions: 0, clicks: 0 });
      const day = (e.created_at || '').slice(0, 10);
      const dm = (dayMap[day] ??= { impressions: 0, clicks: 0 });
      if (e.kind === 'impression') {
        impressions++;
        pm.impressions++;
        dm.impressions++;
        if (e.viewer_id) reachSet.add(e.viewer_id);
      } else if (e.kind === 'click') {
        clicks++;
        pm.clicks++;
        dm.clicks++;
      } else if (e.kind === 'skip') {
        skips++;
      } else if (e.kind === 'complete') {
        completes++;
      }
    }

    // Prefer the authoritative counters when present (events may be capped).
    const impTotal = Math.max(impressions, camp?.impression_count ?? 0);
    const clkTotal = Math.max(clicks, camp?.click_count ?? 0);

    return {
      impressions: impTotal,
      reach: reachSet.size,
      clicks: clkTotal,
      ctr: impTotal > 0 ? clkTotal / impTotal : 0,
      skips,
      completes,
      spentCents: camp?.spent_cents ?? 0,
      byPlacement: (['feed', 'reels', 'audio'] as AdPlacement[])
        .filter((p) => placeMap[p])
        .map((p) => ({ placement: p, impressions: placeMap[p].impressions, clicks: placeMap[p].clicks })),
      series: Object.entries(dayMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, v]) => ({ label, impressions: v.impressions, clicks: v.clicks })),
    };
  } catch {
    return null;
  }
}
