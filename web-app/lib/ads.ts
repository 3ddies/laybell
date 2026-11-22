import type { SupabaseClient } from '@supabase/supabase-js';
import { streamIframeSrc } from './format';

// Web port of the app ad engine (lib/ads.ts) — the SUBSET the web needs today:
// Laybell TV PRE-ROLL serving. The app weaves TV ads *between* videos on a swipe
// pager; the web has no pager, so (owner, 2026-11-21) a Laybell TV video plays a
// YouTube-style pre-roll on click, but ONLY when it runs longer than 2 minutes.
// Full design + the money-review gate: docs/WEB_ADS_PLAN.md.
//
// Everything degrades gracefully: no inventory, un-migrated SQL, or a thrown
// query all resolve to "no ad" and the video just plays — exactly like the app,
// whose whole ad layer no-ops when fetchEligibleCampaigns returns [].
//
// This module is ISOMORPHIC: the server page imports the threshold constant; the
// client TvWatch component passes a browser supabase client into the fetch/record
// helpers. It pulls in no 'use client' code, so importing it from a Server
// Component is safe.

// Only videos longer than this (seconds) get a pre-roll — owner spec, mirrors the
// app treating Laybell TV as a premium placement without pre-rolling short clips.
export const TV_WEB_PREROLL_MIN_SEC = 120;

// Skip timing, ported verbatim from lib/ads.ts so web TV ads skip EXACTLY like
// app TV ads: 'unskippable' (and unset) plays fully, 'skip15' skippable after
// 11s, 'skip10' (simple shop ads) after 10s. Infinity → plays fully.
export const AD_SKIP15_MS = 11_000;
export const AD_SKIP10_MS = 10_000;
export function adSkipAfterMs(skipMode?: string | null): number {
  if (skipMode === 'skip15') return AD_SKIP15_MS;
  if (skipMode === 'skip10') return AD_SKIP10_MS;
  return Infinity; // Laybell TV default: play fully
}

// A single TV ad, shaped for the web pre-roll player.
export type WebTvAd = {
  campaignId: string;
  creativeId: string;
  ownerId: string;
  advertiserName: string;
  avatarUrl: string | null;
  headline: string;
  ctaLabel: string;
  ctaUrl: string | null;     // external website (traffic ads), https-normalized
  mediaUrl: string;          // Cloudflare Stream manifest of the ad video
  thumbUrl: string | null;
  aspectRatio: string | null;
  skipMode: string | null;
};

// ── Eligibility (the untargeted subset of the app's fetchEligibleCampaigns) ────
function hasTargeting(c: any): boolean {
  return (
    c.target_age_min != null ||
    c.target_age_max != null ||
    (!!c.target_gender && c.target_gender !== 'any') ||
    (Array.isArray(c.target_genres) && c.target_genres.length > 0) ||
    (c.target_lat != null && c.target_lng != null)
  );
}
function inSchedule(c: any): boolean {
  const now = Date.now();
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return false;
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return false;
  return true;
}
function inBudget(c: any): boolean {
  if (c.budget_cents_total == null) return true;
  return (c.spent_cents ?? 0) < c.budget_cents_total;
}
function normalizeUrl(u?: string | null): string | null {
  if (!u) return null;
  const t = u.trim();
  if (!t) return null;
  if (/^https:\/\//i.test(t)) return t;        // force https — never a plaintext CTA
  if (/^http:\/\//i.test(t)) return t.replace(/^http:\/\//i, 'https://');
  return `https://${t}`;
}

const CREATIVE_COLS =
  'id, campaign_id, placement, media_type, media_url, thumbnail_url, cover_url, aspect_ratio, headline, body, cta_label, cta_url, skip_mode';
const CAMPAIGN_COLS = `id, user_id, status, starts_at, ends_at, budget_cents_total, spent_cents, advertiser_name, advertiser_avatar_url, objective, target_age_min, target_age_max, target_gender, target_genres, target_lat, target_lng, ad_creatives ( ${CREATIVE_COLS} )`;
// skip_mode is the only newish column we read; if an older schema lacks it the
// select errors wholesale, so we retry once without it (web ads then fall back to
// the TV default = play fully). Mirrors lib/ads.ts's legacy-select resilience.
const CAMPAIGN_COLS_LEGACY = CAMPAIGN_COLS.replace(', skip_mode', '');

// One eligible, UNTARGETED Laybell TV ad for a web pre-roll, or null. Untargeted
// only (web v1): no viewer age/affinity on the anonymous web surface, and minors
// must never get targeted ads — the app's personalized=false path is exactly this
// set. Rotates randomly across eligible campaigns so one advertiser doesn't own
// every pre-roll. Never throws; any failure → null → the video just plays.
export async function fetchTvPrerollAd(db: SupabaseClient): Promise<WebTvAd | null> {
  try {
    const run = (cols: string) =>
      db
        .from('ad_campaigns')
        .select(cols)
        .eq('kind', 'ad')
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())
        .limit(50);
    let { data, error } = await run(CAMPAIGN_COLS);
    if (error && /skip_mode/i.test(error.message ?? '')) ({ data, error } = await run(CAMPAIGN_COLS_LEGACY));
    if (error || !data) return null;

    const pool: WebTvAd[] = [];
    for (const c of data as any[]) {
      if (!inSchedule(c) || !inBudget(c)) continue;
      if (hasTargeting(c)) continue; // untargeted only on the web (see above)
      const cr = (c.ad_creatives ?? []).find(
        (x: any) => x.placement === 'tv' && x.media_url && streamIframeSrc(x.media_url),
      );
      if (!cr) continue; // web v1 plays Stream VIDEO ad creatives only (image ads deferred)
      pool.push({
        campaignId: c.id,
        creativeId: cr.id,
        ownerId: c.user_id,
        advertiserName: c.advertiser_name ?? 'Sponsored',
        avatarUrl: c.advertiser_avatar_url ?? null,
        headline: cr.headline ?? '',
        ctaLabel: cr.cta_label ?? 'Learn more',
        // Web v1 CTA opens an external website only (traffic ads). Awareness →
        // profile and engagement → shop/listing need username/listing resolution
        // on the web and are a follow-up; those ads still play + name the sponsor.
        ctaUrl: c.objective === 'awareness' || c.objective === 'engagement' ? null : normalizeUrl(cr.cta_url),
        mediaUrl: cr.media_url,
        thumbUrl: cr.thumbnail_url ?? cr.cover_url ?? null,
        aspectRatio: cr.aspect_ratio ?? null,
        skipMode: cr.skip_mode ?? null,
      });
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  } catch {
    return null;
  }
}

// Record an ad event. PHASE 1 BILLING RULE (docs/WEB_ADS_PLAN.md §3): only
// LOGGED-IN web viewers bill, through the SAME money-reviewed record_ad_event RPC
// the app uses (it server-dedups per viewer+campaign+placement+hour and ignores
// the owner). Anonymous billing needs the Turnstile + device/IP anti-abuse layer
// and its own owner money-review — until that ships, anonymous viewers SEE ads
// but never bill. Never charge an advertiser for viewing their own ad. Billing
// degrades silently and never blocks playback.
export async function recordWebTvAdEvent(
  db: SupabaseClient,
  ad: WebTvAd,
  kind: 'impression' | 'click' | 'skip' | 'complete',
  viewerId: string | null,
): Promise<void> {
  if (!viewerId || viewerId === ad.ownerId) return; // anon = show-don't-bill; never self-bill
  try {
    await db.rpc('record_ad_event', {
      p_campaign: ad.campaignId,
      p_creative: ad.creativeId,
      p_placement: 'tv',
      p_kind: kind,
    });
  } catch {
    /* billing is best-effort — a failed RPC must never interrupt the viewer */
  }
}
