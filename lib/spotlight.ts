import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { bumpBadge } from './badges';
import { isPremium } from './entitlements';

// Spotlight (formerly "Ads") — pay-for-exposure promoted posts. Single source
// of truth for packages, the campaign lifecycle, the spotlight scoring model,
// feed merging, and impression/tap tracking. Schema + RLS + RPCs live in
// supabase/sql/spotlight.sql (DB objects keep their original ad_* names so an
// environment that already ran ads.sql needs nothing migrated). Everything
// degrades gracefully: if the SQL isn't applied yet every query/rpc rejects,
// we catch, and the app behaves exactly as before (no spotlights anywhere).
//
// Model
// ─────
// Pay first (simulated checkout → ad_payments) → campaign starts `pending`
// with no post → attaching a post (an existing public one, or one created
// fresh from the composer via the pending handoff below) activates it for the
// paid duration (1 / 3 / 7 days).
//
// Placement — multiplier on the post's own score, decaying, anchored
// ──────────────────────────────────────────────────────────────────
// A spotlighted post is scored like any regular post (scorePost), times a
// spotlight MULTIPLIER that only ever decreases:
//   • multiplier = FLOOR + (LAUNCH − FLOOR) × strength, where strength decays
//     EXPONENTIALLY with age — scaled by (1 − perf), the post's relative
//     engagement-per-time vs the feed's best. Strong engagement ⇒ decay ≈ 0
//     (the multiplier holds); weak engagement ⇒ full-speed decay. Strength is
//     also monotone-clamped per device (AsyncStorage), so the multiplier can
//     NEVER recover — exactly "stays the same or decreases".
//   • Default placement: while strength is still high, the top spotlight is
//     anchored as the feed's 3RD post (just under the #2 organic post) — it
//     may only claim a higher spot when it's on fire (perf ≥
//     SPOTLIGHT_TRENDING_PERF) — globally, OR for a specific viewer whose
//     tastes match the post (the affinity lift adds up to
//     SPOTLIGHT_AFFINITY_BONUS to perf AND narrows the climb band), so a
//     MODEST spotlight (≥ ~55% of the feed's best) can top the feed of
//     someone who loves that creator/genre. A true flop still can't reach #1
//     — its near-top exposure is the discovery lottery's #3 slot below.
//   • As the multiplier decays the post sinks toward an average post's rank,
//     floored just ABOVE the feed's average score — a flopped spotlight is
//     still seen, just much less, and always beats a bad regular post.
//   • Discovery lottery: every live spotlight, however decayed, reclaims its
//     launch placement on a small share of feed loads (3%–15%, scaled by
//     performance) — a bad spotlight still lands near the top of SOME feeds,
//     just rarely.
//   • Density cap: at least SPOTLIGHT_FEED_GAP regular posts between any two
//     spotlighted posts (≈ "1 in every 6").
// Spotlights never receive the seen-penalty (bought reach must not decay like
// scored reach) and serve only in the Home feed's "All" mode.

export type SpotlightPackageKey = '12h' | '1d' | '3d' | '7d';

export type SpotlightPackage = {
  key: SpotlightPackageKey;
  label: string;
  days: number;
  priceCents: number;
  weight: number; // package size 1–3; drives the ramp window length
  blurb: string;
};

export const SPOTLIGHT_PACKAGES: SpotlightPackage[] = [
  { key: '12h', label: '12 Hours', days: 0.5, priceCents: 599,  weight: 1, blurb: 'A same-day boost — take the top of the feed while the moment is hot.' },
  { key: '1d',  label: '1 Day',    days: 1,   priceCents: 1099, weight: 2, blurb: 'A quick burst — your post launches at the top of the feed for a day.' },
  { key: '3d',  label: '3 Days',   days: 3,   priceCents: 2499, weight: 3, blurb: 'Three days of reach, with a full day of guaranteed top placement.' },
  { key: '7d',  label: '7 Days',   days: 7,   priceCents: 4999, weight: 4, blurb: 'A full week in the spotlight, with the longest guaranteed placement.' },
];

// Duration as it reads MID-SENTENCE (e.g. "for the next ___"). "1 day" drops the
// "1" — "for the next day" is cleaner than "for the next 1 day" — while 3/7-day
// labels stay as-is. The package label itself ("1 Day") is unchanged everywhere.
export function spotlightDurationPhrase(label: string): string {
  const lower = label.toLowerCase();
  return lower === '1 day' ? 'day' : lower;
}

export function packageFor(key: string | null | undefined): SpotlightPackage | null {
  return SPOTLIGHT_PACKAGES.find(p => p.key === key) ?? null;
}

export function fmtPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Scoring model ────────────────────────────────────────────────────────────

// Minimum number of regular posts between two spotlighted posts.
export const SPOTLIGHT_FEED_GAP = 6;

// The spotlight multiplier's launch value and its floor. The post's own
// organic score is multiplied by a value that decays from LAUNCH toward FLOOR
// and never recovers — at the floor the post ranks like a (slightly boosted)
// regular post.
export const SPOTLIGHT_LAUNCH_MULT = 4.0;
export const SPOTLIGHT_FLOOR_MULT = 1.25;

// Hard age ceiling: the launch boost decays LINEARLY from LAUNCH (4×) to
// SUSTAIN (2×) over HALVING_HOURS (24h) for EVERY spotlight no matter how well
// it performs, then holds flat at SUSTAIN. A great post rides right at this
// ceiling (≈2× after 24h, "as close to 2× as possible"); the engagement curve
// only ever pulls a WEAKER post below it. Applied as a min(), so the boost can
// never exceed this age schedule even for a viral post.
export const SPOTLIGHT_SUSTAIN_MULT = 2.0;
export const SPOTLIGHT_HALVING_HOURS = 24;

// The age-only multiplier ceiling at a given age (hours): linear 4×→2× over the
// first 24h, flat 2× thereafter. Monotonically non-increasing.
export function ageCeilingMult(ageH: number): number {
  const t = Math.min(Math.max(ageH, 0) / SPOTLIGHT_HALVING_HOURS, 1);
  return SPOTLIGHT_LAUNCH_MULT - (SPOTLIGHT_LAUNCH_MULT - SPOTLIGHT_SUSTAIN_MULT) * t;
}

// "On fire": the post's RAW engagement-per-time score rivals the feed's best
// (≥ 85% of the top organic score, before any spotlight boost). Only then may
// a spotlight rank above the default 3rd position — all the way to #1.
export const SPOTLIGHT_TRENDING_PERF = 0.85;

// Trending is a RAMP, not a cliff: from the threshold the score eases from the
// 3rd-post anchor up to the cap over this much additional perf (full #1 at
// perf ≥ 0.95), so a borderline post drifts smoothly instead of flapping
// between #1 and #3 across refreshes.
export const SPOTLIGHT_TRENDING_BAND = 0.1;

// A fully trending spotlight EDGES the top post (5% over the merge-space #1),
// it never dwarfs it — "scored very similar to a regular post" holds even on
// fire.
export const SPOTLIGHT_TRENDING_EDGE = 1.05;

// Personalization lift: a viewer whose tastes strongly match the spotlighted
// post (its creator, genre, or type) treats it as up to this much hotter than
// its global numbers. At full affinity, a post at ≥ ~55% of the feed's best
// crosses the trending bar AND (because the climb band narrows with affinity)
// rides essentially straight to #1 on that viewer's feed. Below that floor,
// affinity alone can't reach #1 — deliberate: flops get the rare lottery #3,
// not the top slot.
export const SPOTLIGHT_AFFINITY_BONUS = 0.3;

// The trending climb band never narrows past this (keeps a sliver of
// smoothstep even for perfectly-matched viewers, so the gate isn't a cliff).
export const SPOTLIGHT_TRENDING_BAND_MIN = 0.03;

// Discovery lottery: every live spotlight — no matter how badly it has
// decayed — takes its launch placement (the #3 anchor) for a small share of
// feed loads. Win rate scales with (affinity-adjusted) performance: a flop
// still surfaces near the top of ~3% of loads, a strong post ~15% (mostly
// moot, since it already ranks there on merit).
export const SPOTLIGHT_LOTTERY_MIN = 0.03;
export const SPOTLIGHT_LOTTERY_MAX = 0.15;

// While strength stays above this, the spotlight keeps its default anchored
// placement (3rd post). Below it, the multiplier era is over and the post
// competes mostly on its own merit (with the average-floor below).
export const SPOTLIGHT_STRONG = 0.6;

// A decayed spotlight never ranks below this multiple of the feed's AVERAGE
// score — "the status of an average post, just with a higher floor".
export const SPOTLIGHT_FLOOR_VS_AVG = 1.1;

// How long a zero-engagement spotlight holds its default 3rd-post placement —
// strength hits SPOTLIGHT_STRONG at exactly this age when perf = 0. Engagement
// stretches it: at perf 0.5 the same drop takes twice as long; at perf ≈ 1 the
// multiplier effectively never decays. Bigger packages get a longer window.
// v2 packages: weight 1→4h (12 Hours), 2→8h (1 Day), 3→24h (3 Days),
// 4→36h (7 Days). Legacy campaigns (old weights 1–3 = 12/24/36h) decay a bit
// faster under this map, which only affects pre-v2 test campaigns.
const RAMP_HOURS: Record<number, number> = { 1: 4, 2: 8, 3: 24, 4: 36 };
export function rampHoursFor(weight: number): number {
  return RAMP_HOURS[Math.round(weight)] ?? 8;
}

// Merge-space anchors derived from the PENALIZED organic ranking — the same
// score space the final feed sort happens in. Callers must EXCLUDE the
// spotlights' own organic copies first (mergeSpotlights removes them, so an
// anchor that counted them would point one slot off).
export type SpotlightAnchors = {
  top: number;    // score of the #1-ranked organic post
  second: number; // score of the 2nd-ranked organic post
  third: number;  // score of the 3rd-ranked organic post
  avg: number;    // mean organic score
  count: number;  // organic post count
};

// Per-device monotone clamp for spotlight strength: the multiplier may NEVER
// increase, even when engagement picks up later (recovering engagement only
// SLOWS further decay). 10-day TTL comfortably outlives the longest campaign.
const STRENGTH_KEY = 'spotlight_strength_v1';
const STRENGTH_TTL_MS = 10 * 24 * 60 * 60 * 1000;
let strengthCache: Record<string, { s: number; ts: number }> | null = null;

async function loadStrengths(): Promise<Record<string, { s: number; ts: number }>> {
  if (strengthCache) return strengthCache;
  try {
    const raw = await AsyncStorage.getItem(STRENGTH_KEY);
    const map: Record<string, { s: number; ts: number }> = raw ? JSON.parse(raw) : {};
    const cutoff = Date.now() - STRENGTH_TTL_MS;
    for (const k of Object.keys(map)) {
      if (!map[k] || typeof map[k].s !== 'number' || map[k].ts < cutoff) delete map[k];
    }
    strengthCache = map;
  } catch {
    strengthCache = {};
  }
  return strengthCache!;
}

// The spotlight score that competes in the (penalized) feed ranking.
//   strength = min(e^(−k·age·(1−perf)), lowest strength ever seen here)
//   multiplier = FLOOR + (LAUNCH − FLOOR) × strength      — never increases
//   raw = own organic score × multiplier
//   perfAdj = perf + AFFINITY_BONUS × viewer affinity      — per-viewer lift
// Placement:  trending (perfAdj) → eased up to TRENDING_EDGE × the #1 post
//             strong            → anchored just under #2 (the 3rd spot)
//             decayed           → raw, clamped to [avg × 1.1, the 3rd anchor]
// …then the discovery lottery may lift the result back to the 3rd anchor for
// a small, performance-scaled share of loads — every spotlight keeps a real
// (if rare) shot at near-top placement on someone's feed.
export async function rankSpotlight(opts: {
  campaignId: string;
  organicPf: number;   // spotlight's own penalty-free organic score
  topPf: number;       // penalty-free top organic score (fair perf baseline)
  anchors: SpotlightAnchors;
  startsAt: string | null;
  weight: number;
  now: number;
  affinity?: number;   // viewer's 0..1 taste match for this post (creator/genre/type)
  viewerId?: string | null; // stabilizes the lottery draw per viewer per hour
}): Promise<number> {
  const { campaignId, organicPf, topPf, anchors, startsAt, weight, now } = opts;
  const affinity = Math.min(Math.max(opts.affinity ?? 0, 0), 1);
  const perf = topPf > 0 ? Math.min(Math.max(organicPf / topPf, 0), 1) : 0;
  // The viewer-personalized read of the same performance — placement only.
  const perfAdj = Math.min(perf + SPOTLIGHT_AFFINITY_BONUS * affinity, 1);

  // Exponential, engagement-damped decay + the never-recover clamp. Decay uses
  // the GLOBAL perf (real engagement truth) — affinity lifts placement for a
  // matching viewer, it doesn't slow the campaign's decay.
  const ageH = startsAt ? Math.max(0, (now - new Date(startsAt).getTime()) / 3_600_000) : 0;
  const k = Math.log(1 / SPOTLIGHT_STRONG) / rampHoursFor(weight);
  let strength = Math.exp(-k * ageH * (1 - perf));
  try {
    const map = await loadStrengths();
    const prev = map[campaignId]?.s;
    if (prev != null) strength = Math.min(prev, strength);
    map[campaignId] = { s: strength, ts: now };
    AsyncStorage.setItem(STRENGTH_KEY, JSON.stringify(map)).catch(() => {});
  } catch {}

  // The engagement-driven multiplier, then capped by the age-only ceiling so
  // the boost halves 4×→2× over the first 24h no matter how well the post does
  // (a strong post sits at the ceiling; a weak one is already below it). min of
  // two monotone-non-increasing curves stays monotone — the boost never rises.
  const engagementMult = SPOTLIGHT_FLOOR_MULT + (SPOTLIGHT_LAUNCH_MULT - SPOTLIGHT_FLOOR_MULT) * strength;
  const mult = Math.min(engagementMult, ageCeilingMult(ageH));
  const raw = organicPf * mult;

  // The default 3rd-post anchor: strictly between the #2 and #3 organic posts.
  const ceiling = anchors.count >= 3
    ? (anchors.second + anchors.third) / 2
    : anchors.count === 2
      ? anchors.second * 0.999
      : raw; // a near-empty feed has no meaningful anchor

  let score: number;
  if (perfAdj >= SPOTLIGHT_TRENDING_PERF) {
    // On fire — globally, or for THIS viewer via the affinity lift. Climbs
    // smoothly (smoothstep, so a borderline post doesn't flap between #1 and
    // #3 across refreshes) toward a hair over the merge-space #1: a trending
    // spotlight edges the top post, never dwarfs it. The band NARROWS with
    // affinity: crossing the bar on the back of a perfect taste match should
    // deliver the top slot, not the bottom edge of the ramp — while global
    // (low-affinity) trending keeps the full anti-flap band.
    const target = anchors.top > 0
      ? Math.max(anchors.top * SPOTLIGHT_TRENDING_EDGE, ceiling)
      : Math.max(raw, ceiling);
    const band = Math.max(SPOTLIGHT_TRENDING_BAND * (1 - affinity), SPOTLIGHT_TRENDING_BAND_MIN);
    const t = Math.min((perfAdj - SPOTLIGHT_TRENDING_PERF) / band, 1);
    const ease = t * t * (3 - 2 * t);
    score = ceiling + (target - ceiling) * ease;
  } else if (strength >= SPOTLIGHT_STRONG) {
    score = ceiling;
  } else {
    // Multiplier era over: rank on merit, floored just above the feed's
    // average, never above the default anchor — and the floor is
    // authoritative when a flat feed would put the anchor beneath it.
    const floor = anchors.avg * SPOTLIGHT_FLOOR_VS_AVG;
    score = Math.min(Math.max(raw, floor), Math.max(floor, ceiling));
  }

  // Discovery lottery: occasionally restore the launch placement no matter how
  // far the spotlight has decayed — rarer the worse it performs, never zero.
  // The draw is DETERMINISTIC per (campaign, viewer, hour): a win holds for
  // the whole hour and consecutive pull-to-refreshes see a stable position
  // (no per-refresh teleporting), while outcomes still vary across viewers
  // and across hours. (No-op while the post already ranks at the anchor.)
  const pWin = SPOTLIGHT_LOTTERY_MIN + (SPOTLIGHT_LOTTERY_MAX - SPOTLIGHT_LOTTERY_MIN) * perfAdj;
  const seedStr = `${campaignId}|${opts.viewerId ?? ''}|${Math.floor(now / 3_600_000)}`;
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const draw = ((h >>> 0) % 100_000) / 100_000;
  if (draw < pWin) score = Math.max(score, ceiling);

  return score;
}

// ─── Campaign lifecycle ───────────────────────────────────────────────────────

export type SpotlightStatus = 'pending' | 'active' | 'ended' | 'canceled';

export type SpotlightCampaign = {
  id: string;
  user_id: string;
  post_id: string | null;
  package_key: SpotlightPackageKey;
  duration_days: number;
  price_cents: number;
  weight: number;
  status: SpotlightStatus;
  starts_at: string | null;
  ends_at: string | null;
  impression_count: number;
  tap_count: number;
  created_at: string;
  posts?: any | null; // embedded promoted post (Spotlight screen / feed queries)
};

export type SpotlightMeta = {
  campaignId: string;
  ownerId: string;
  weight: number;
  startsAt: string | null;
};

// What the Spotlight screen should display: an `active` row whose ends_at has
// passed reads as ended even before the lazy DB settle catches up.
export function effectiveStatus(c: SpotlightCampaign): SpotlightStatus {
  if (c.status === 'active' && c.ends_at && new Date(c.ends_at).getTime() <= Date.now()) return 'ended';
  return c.status;
}

export function timeLeftLabel(endsAt: string | null): string {
  if (!endsAt) return '';
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'Ended';
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `${Math.round(h / 24)} days left`;
  if (h >= 24) return `1d ${h - 24}h left`;
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

/**
 * Buy a Spotlight with credits.
 *
 * This used to insert the campaign and its payment row straight from the client,
 * after a hardcoded 900ms fake "processing" delay. Nothing was charged, and
 * nothing stopped a crafted insert minting a live 365-day campaign at weight 10
 * for $0 — the INSERT policy checked only that the row belonged to you.
 *
 * Now the server owns all of it: the price comes from `spotlight_package()`
 * rather than from whatever the client sends, and a trigger rejects any
 * client-side insert of a spotlight row at all. The two-step shape (pay, then
 * choose the post) is unchanged.
 *
 * Throws on failure so callers can distinguish "no credits" from "offline" —
 * the old version swallowed everything into null.
 */
export async function purchaseCampaign(pkg: SpotlightPackage): Promise<SpotlightCampaign | null> {
  const { data: campaignId, error } = await supabase
    .rpc('spotlight_buy_with_credits', { p_package_key: pkg.key });
  if (error) throw error;
  if (!campaignId) return null;
  const { data } = await supabase.from('ad_campaigns').select('*').eq('id', campaignId).single();
  return (data as SpotlightCampaign) ?? null;
}

// Attach a post to a paid pending campaign — the moment the spotlight goes live.
// `days` is no longer passed: the server reads the duration off the campaign it
// already sold, so the end date can't be stretched from the client.
export async function activateCampaign(campaignId: string, postId: string, _days?: number): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('spotlight_activate', {
      p_campaign_id: campaignId,
      p_post_id: postId,
    });
    return !error;
  } catch {
    return false;
  }
}

// ─── Free monthly Spotlight (Premium perk) ─────────────────────────────────────
// One free 1-day Spotlight per calendar month. Eligibility + the atomic claim
// live in supabase/sql/spotlight_credit.sql; here we just check status and call
// the RPC. Resets automatically each month; an unused credit doesn't carry over.

/** Current month as 'YYYY-MM' (UTC, matching the server's to_char(now())). */
export function currentSpotlightMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** True if the Premium user still has this month's free Spotlight to claim. */
export async function fetchFreeSpotlightAvailable(): Promise<boolean> {
  try {
    if (!isPremium()) return false;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data, error } = await supabase
      .from('profiles')
      .select('spotlight_credit_used_month')
      .eq('id', user.id)
      .single();
    if (error) return false;
    return (data?.spotlight_credit_used_month ?? null) !== currentSpotlightMonth();
  } catch {
    return false;
  }
}

export type ClaimFreeResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'already_claimed' | 'not_premium' | 'invalid_post' | 'unavailable' };

/** Spend the free monthly credit on one of the caller's public posts (1-day boost). */
export async function claimFreeSpotlight(postId: string): Promise<ClaimFreeResult> {
  try {
    const { data, error } = await supabase.rpc('claim_free_spotlight', { p_post_id: postId });
    if (error) {
      const m = `${error.message ?? ''}`.toLowerCase();
      if (m.includes('already_claimed')) return { ok: false, reason: 'already_claimed' };
      if (m.includes('not_premium')) return { ok: false, reason: 'not_premium' };
      if (m.includes('invalid_post')) return { ok: false, reason: 'invalid_post' };
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, id: data as string };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

// Cancel a paid-but-unattached campaign and get the credits back.
//
// This was two separate client UPDATEs — campaign, then payment — so a failure
// between them left a cancelled campaign carrying a 'succeeded' payment. One
// transaction now, and the refund is a real ledger entry rather than a status
// flag on a row nobody was reading.
export async function cancelPendingCampaign(campaignId: string): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('spotlight_cancel_pending', { p_campaign_id: campaignId });
    return !error;
  } catch {
    return false;
  }
}

// Stop a live campaign early (no refund — the exposure was already served).
export async function endCampaign(campaignId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .update({ status: 'ended' })
      .eq('id', campaignId)
      .eq('status', 'active')
      .select('id');
    return !error && !!data?.length;
  } catch {
    return false;
  }
}

// True when the post has a LIVE spotlight right now (active + unexpired). Used
// to warn before deleting it. The FK used to be ON DELETE CASCADE, so deleting
// the post silently destroyed the paid campaign — promo_credits.sql re-points it
// to ON DELETE SET NULL, but the warning stays: the promotion stops either way.
// Degrades to false on any error (missing migration / RLS) so it never blocks a
// normal delete — it only ever ADDS a warning.
export async function isPostSpotlighted(postId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('id')
      .eq('post_id', postId)
      .eq('status', 'active')
      .gt('ends_at', new Date().toISOString())
      .limit(1);
    return !error && !!data?.length;
  } catch {
    return false;
  }
}

// Which of these posts have a LIVE spotlight right now (active + unexpired),
// returned as a Set for O(1) lookup while rendering a grid. One query for the
// whole batch; degrades to an empty Set on any error (missing migration / RLS)
// so a grid never fails to render just because the spotlight check did.
export async function fetchSpotlightedPostIds(postIds: string[]): Promise<Set<string>> {
  try {
    if (!postIds.length) return new Set();
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('post_id')
      .in('post_id', postIds)
      .eq('status', 'active')
      .gt('ends_at', new Date().toISOString());
    if (error || !data) return new Set();
    return new Set((data as any[]).map((r) => r.post_id).filter(Boolean));
  } catch {
    return new Set();
  }
}

// All of the caller's campaigns with their promoted post + live like count,
// newest first. Expired actives are lazily settled to `ended` first so the
// list always agrees with what the feed is actually serving.
export async function fetchMyCampaigns(): Promise<SpotlightCampaign[]> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    await supabase
      .from('ad_campaigns')
      .update({ status: 'ended' })
      .eq('user_id', user.id)
      .eq('status', 'active')
      .lt('ends_at', new Date().toISOString());
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select(`
        *,
        posts!ad_campaigns_post_id_fkey (id, type, media_url, thumbnail_url, cover_url, caption, likes(count))
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return data as SpotlightCampaign[];
  } catch {
    return [];
  }
}

// ─── Feed serving ─────────────────────────────────────────────────────────────

// Live spotlights for the Home feed: each is the promoted post in the exact
// shape the feed's organic query returns (profiles join + like/comment counts)
// plus the `__spotlight` marker. Posts that came back null (hidden author via
// RLS, deleted) or archived are dropped here; the caller filters blocked
// authors like it does for organic posts.
export async function fetchFeedSpotlights(): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select(`
        id, user_id, weight, starts_at,
        posts!ad_campaigns_post_id_fkey (
          *,
          profiles!posts_user_id_fkey (username, display_name, avatar_url, badge_tier, badge_show, profile_theme),
          likes(count),
          comments(count)
        )
      `)
      .eq('status', 'active')
      .gt('ends_at', new Date().toISOString())
      .limit(30);
    if (error || !data) return [];
    return (data as any[])
      .filter(c => c.posts && !c.posts.archived_at)
      .map(c => ({
        ...c.posts,
        __spotlight: {
          campaignId: c.id,
          ownerId: c.user_id,
          weight: c.weight ?? 1,
          startsAt: c.starts_at ?? null,
        } as SpotlightMeta,
      }));
  } catch {
    return [];
  }
}

export type ScoredItem = { item: any; score: number };

// Merge scored spotlights into the scored organic feed: one ranked list,
// sorted purely by score, then a spacing pass guarantees at least `gap`
// regular posts between any two spotlights. A spotlight whose score earns a
// too-close slot is deferred to the next valid one. The density cap is strict:
// a load can carry at most one spotlight per `gap` organic posts, so any
// spotlights left over when the organic supply runs out are HELD for the next
// feed load rather than dumped back-to-back at the tail (their campaigns stay
// live; nothing is lost but this load's slot). The organic copy of a
// spotlighted post is removed: the spotlight slot IS that post's exposure.
export function mergeSpotlights(
  organic: ScoredItem[],
  spotlights: ScoredItem[],
  gap: number = SPOTLIGHT_FEED_GAP,
): any[] {
  const byScore = (a: ScoredItem, b: ScoredItem) => b.score - a.score;
  if (!spotlights.length) return [...organic].sort(byScore).map(x => x.item);
  const spotPostIds = new Set(spotlights.map(s => s.item.id));
  const merged = [
    ...organic.filter(o => !spotPostIds.has(o.item.id)),
    ...spotlights,
  ].sort(byScore);

  const out: any[] = [];
  const deferred: any[] = [];
  let sinceSpot = gap; // a top-scoring spotlight may open the feed
  for (const m of merged) {
    if (m.item.__spotlight) {
      if (sinceSpot >= gap) { out.push(m.item); sinceSpot = 0; }
      else deferred.push(m.item);
    } else {
      out.push(m.item);
      sinceSpot++;
      if (deferred.length && sinceSpot >= gap) {
        out.push(deferred.shift());
        sinceSpot = 0;
      }
    }
  }
  // Whatever is still deferred had no valid slot this load — held, not dumped.
  return out;
}

// ─── Impressions & taps ───────────────────────────────────────────────────────
// Server-side the RPCs ledger-dedupe per (viewer, campaign, kind) and ignore
// the owner; client-side we also dedupe per app session so one scroll-past
// doesn't even round-trip twice.

const impressedCampaigns = new Set<string>();
const tappedKeys = new Set<string>();
const engagedCampaigns = new Set<string>();

export function recordSpotlightImpression(item: any, currentUserId?: string | null): void {
  const meta: SpotlightMeta | undefined = item?.__spotlight;
  if (!meta || meta.ownerId === currentUserId) return;
  if (impressedCampaigns.has(meta.campaignId)) return;
  impressedCampaigns.add(meta.campaignId);
  supabase.rpc('record_ad_impression', { p_campaign: meta.campaignId }).then(undefined, () => {});
}

export type SpotlightTapKind = 'like' | 'comment' | 'save' | 'share';

export function recordSpotlightTap(item: any, kind: SpotlightTapKind, currentUserId?: string | null): void {
  const meta: SpotlightMeta | undefined = item?.__spotlight;
  if (!meta || meta.ownerId === currentUserId) return;
  const key = `${meta.campaignId}:${kind}`;
  if (!tappedKeys.has(key)) {
    tappedKeys.add(key);
    supabase.rpc('record_ad_tap', { p_campaign: meta.campaignId, p_kind: kind }).then(undefined, () => {});
  }
  // Patron badges count DISTINCT spotlights engaged with today — one bump per
  // campaign per session, whatever the engagement type.
  if (!engagedCampaigns.has(meta.campaignId)) {
    engagedCampaigns.add(meta.campaignId);
    bumpBadge('ad_engagements');
  }
}

// ─── Pending handoff (the "create a brand new post" path) ─────────────────────
// The Spotlight screen parks the paid campaign here, sends the user to the
// composer, and post.tsx attaches it to the post it just created. In-memory
// only: if the app dies first, the campaign is still safe in the DB as
// `pending` and can be resumed from the Spotlight screen.

export type PendingSpotlight = { campaignId: string; days: number; label: string };

let pendingSpotlight: PendingSpotlight | null = null;

export function setPendingSpotlight(p: PendingSpotlight): void {
  pendingSpotlight = p;
}

export function peekPendingSpotlight(): PendingSpotlight | null {
  return pendingSpotlight;
}

export function clearPendingSpotlight(): void {
  pendingSpotlight = null;
}

// ─── Session hygiene ──────────────────────────────────────────────────────────
// The dedup Sets and the pending handoff are per-USER session state — an
// in-app account switch must not carry them over (the next account would get
// suppressed impressions/taps, undercounted Patron badges, and could inherit a
// parked campaign handoff). Cleared on sign-out, which always fires between a
// logout and the next login.
export function resetSpotlightSession(): void {
  impressedCampaigns.clear();
  tappedKeys.clear();
  engagedCampaigns.clear();
  pendingSpotlight = null;
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') resetSpotlightSession();
});
