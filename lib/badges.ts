import { type ViewStyle } from 'react-native';
import { supabase } from './supabase';
import { COLORS, GRADIENTS } from '../constants/theme';

// Profile Badges / Gamification — single source of truth.
// Schema + RLS + RPCs live in supabase/sql/badges.sql. Everything here degrades
// gracefully: if the SQL isn't applied yet, the rpc/select calls reject, we catch,
// and the app behaves exactly as before (no emblem). See AGENTS-style notes in
// the SQL file for the model.
//
// Overall status (the emblem next to a username) is a POINT ROLLUP: within each
// category a user holds only the highest tier they currently qualify for; weight
// bronze=1 / silver=2 / gold=4 / diamond=8; sum across categories; the emblem tier
// is the highest the total funds (>=8 diamond, 4-7 gold, 2-3 silver, 1 bronze).
// This directly encodes the notes' tree (2 bronze = 1 silver, etc.).

export type Tier = 'bronze' | 'silver' | 'gold' | 'diamond';
export type BadgeCategory =
  | 'login' | 'daily_like' | 'posts' | 'music_streaming' | 'comments'
  | 'community' | 'ads' | 'app_sharing';

export type BadgeDef = {
  key: string;          // `${category}_${tier}`, e.g. 'login_gold'
  category: BadgeCategory;
  tier: Tier;
  title: string;        // short label for the Badges page
  criteria: string;     // human-readable requirement
  permanent: boolean;   // (Per) — never revoked once earned
  locked: boolean;      // stub — no underlying system yet ("coming soon")
};

export const TIER_WEIGHT: Record<Tier, number> = { bronze: 1, silver: 2, gold: 4, diamond: 8 };

export function tierRank(tier: Tier | null | undefined): number {
  switch (tier) {
    case 'bronze': return 1;
    case 'silver': return 2;
    case 'gold': return 3;
    case 'diamond': return 4;
    default: return 0;
  }
}

export function tierLabel(tier: Tier | null | undefined): string {
  if (!tier) return 'None';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Mirrors the user's notes. Community / Ads / App-sharing have no underlying
// system yet, so they're `locked: true` (shown as "coming soon", never auto-earned).
export const BADGES: BadgeDef[] = [
  // Login (streak; diamond is permanent)
  { key: 'login_bronze',  category: 'login', tier: 'bronze',  title: 'Bronze Login',  criteria: 'Log in 3 days in a row',  permanent: false, locked: false },
  { key: 'login_silver',  category: 'login', tier: 'silver',  title: 'Silver Login',  criteria: 'Log in 7 days in a row',  permanent: false, locked: false },
  { key: 'login_gold',    category: 'login', tier: 'gold',    title: 'Gold Login',    criteria: 'Log in 14 days in a row', permanent: false, locked: false },
  { key: 'login_diamond', category: 'login', tier: 'diamond', title: 'Diamond Login', criteria: 'Log in 30 days in a row', permanent: true,  locked: false },

  // Daily likes
  { key: 'daily_like_bronze', category: 'daily_like', tier: 'bronze', title: 'Bronze Likes', criteria: 'Like 15+ posts today',                permanent: false, locked: false },
  { key: 'daily_like_silver', category: 'daily_like', tier: 'silver', title: 'Silver Likes', criteria: 'Like 15+ posts each day for 3 days', permanent: false, locked: false },
  { key: 'daily_like_gold',   category: 'daily_like', tier: 'gold',   title: 'Gold Likes',   criteria: 'Like 15+ posts each day for 7 days', permanent: false, locked: false },

  // Posts (live grid count)
  { key: 'posts_bronze', category: 'posts', tier: 'bronze', title: 'Bronze Poster', criteria: 'Share a public post',            permanent: false, locked: false },
  { key: 'posts_silver', category: 'posts', tier: 'silver', title: 'Silver Poster', criteria: 'Have 5 public posts on your grid', permanent: false, locked: false },

  // Music streaming (today's listen time)
  { key: 'music_streaming_bronze', category: 'music_streaming', tier: 'bronze', title: 'Bronze Listener', criteria: 'Stream 10 min of audio today', permanent: false, locked: false },
  { key: 'music_streaming_silver', category: 'music_streaming', tier: 'silver', title: 'Silver Listener', criteria: 'Stream 20 min of audio today', permanent: false, locked: false },
  { key: 'music_streaming_gold',   category: 'music_streaming', tier: 'gold',   title: 'Gold Listener',   criteria: 'Stream 30 min of audio today', permanent: false, locked: false },

  // Comments (today)
  { key: 'comments_bronze', category: 'comments', tier: 'bronze', title: 'Bronze Voice', criteria: 'Leave a comment today',     permanent: false, locked: false },
  { key: 'comments_silver', category: 'comments', tier: 'silver', title: 'Silver Voice', criteria: 'Leave 2+ comments today',   permanent: false, locked: false },

  // ── Locked stubs (no underlying system yet) ──
  { key: 'community_bronze', category: 'community', tier: 'bronze', title: 'Bronze Member',  criteria: 'Join a community',                       permanent: false, locked: true },
  { key: 'community_silver', category: 'community', tier: 'silver', title: 'Silver Member',  criteria: 'Stay in good standing for a week',        permanent: false, locked: true },
  { key: 'community_gold',   category: 'community', tier: 'gold',   title: 'Gold Member',    criteria: 'Become a community manager',             permanent: false, locked: true },
  { key: 'ads_bronze',       category: 'ads',       tier: 'bronze', title: 'Bronze Patron',  criteria: 'Engage with an ad today',                permanent: false, locked: true },
  { key: 'ads_silver',       category: 'ads',       tier: 'silver', title: 'Silver Patron',  criteria: 'Engage with 2 ads today',                permanent: false, locked: true },
  { key: 'app_sharing_bronze',  category: 'app_sharing', tier: 'bronze',  title: 'Bronze Advocate',  criteria: 'Share the app',                  permanent: false, locked: true },
  { key: 'app_sharing_silver',  category: 'app_sharing', tier: 'silver',  title: 'Silver Advocate',  criteria: 'Share the app with 8 people',    permanent: false, locked: true },
  { key: 'app_sharing_gold',    category: 'app_sharing', tier: 'gold',    title: 'Gold Advocate',    criteria: 'Share the app with 15 people',   permanent: true,  locked: true },
  { key: 'app_sharing_diamond', category: 'app_sharing', tier: 'diamond', title: 'Diamond Advocate', criteria: 'Get 5 people to download the app', permanent: true,  locked: true },
];

export const BADGES_BY_KEY: Record<string, BadgeDef> = Object.fromEntries(BADGES.map(b => [b.key, b]));

export const CATEGORY_META: Record<BadgeCategory, { label: string; icon: string }> = {
  login:           { label: 'Login',           icon: 'log-in-outline' },
  daily_like:      { label: 'Daily Likes',      icon: 'heart-outline' },
  posts:           { label: 'Posts',            icon: 'images-outline' },
  music_streaming: { label: 'Music Streaming',  icon: 'musical-notes-outline' },
  comments:        { label: 'Comments',         icon: 'chatbubble-outline' },
  community:       { label: 'Community',         icon: 'people-outline' },
  ads:             { label: 'Ads',              icon: 'megaphone-outline' },
  app_sharing:     { label: 'App Sharing',      icon: 'share-social-outline' },
};

// Order the Badges page lists categories in.
export const CATEGORY_ORDER: BadgeCategory[] = [
  'login', 'daily_like', 'posts', 'music_streaming', 'comments', 'community', 'ads', 'app_sharing',
];

// ─── Colors / emblem ──────────────────────────────────────────────────────────
export function badgeRingColors(tier: Tier | null | undefined): readonly [string, string] {
  switch (tier) {
    case 'gold':    return GRADIENTS.gold;                 // ['#F59E0B', '#D97706']
    case 'diamond': return [COLORS.diamond, '#67E8F9'];
    case 'silver':  return [COLORS.silver, '#CBD5E1'];
    case 'bronze':  return [COLORS.bronze, '#92400E'];
    default:        return ['#333333', '#222222'];
  }
}

// Subtle outer glow for the "shine" tiers (notes: gold + diamond shine/glow).
// Diamond is the app's peak status, so it's the ONLY tier that carries a glow —
// applied everywhere it appears (emblem app-wide, avatar rings) so it always
// reads as special. Other tiers intentionally do not glow globally.
export function badgeGlow(tier: Tier | null | undefined): ViewStyle | null {
  if (tier === 'diamond') return { shadowColor: '#67E8F9', shadowOpacity: 0.7, shadowRadius: 9, shadowOffset: { width: 0, height: 0 }, elevation: 7 };
  return null;
}

// Emblem appeal scales with tier: the fill gets progressively richer (a flat
// 2-stop bronze → a 3-stop shimmering gold → an iridescent diamond), so a higher
// badge visibly looks more premium. Used by the app-wide BadgeEmblem.
export function emblemGradient(tier: Tier): readonly [string, string, ...string[]] {
  switch (tier) {
    case 'bronze':  return ['#D08B43', '#7C3A0E'] as const;
    case 'silver':  return ['#EDF2F7', '#9AA7B8', '#6B7687'] as const;
    case 'gold':    return ['#FDE68A', '#F59E0B', '#B45309'] as const;
    case 'diamond': return ['#FFFFFF', '#A5F3FC', '#22D3EE'] as const;
  }
}

// A rim highlight that brightens with tier — bronze has none, diamond gets a
// crisp luminous edge — reinforcing the appeal gradient on the emblem.
export function badgeRim(tier: Tier): ViewStyle | null {
  switch (tier) {
    case 'bronze':  return null;
    case 'silver':  return { borderWidth: 0.5,  borderColor: 'rgba(255,255,255,0.45)' };
    case 'gold':    return { borderWidth: 0.75, borderColor: 'rgba(255,243,205,0.7)' };
    case 'diamond': return { borderWidth: 1,    borderColor: 'rgba(224,251,255,0.9)' };
  }
}

export function computeEmblemTier(points: number): Tier | null {
  if (points >= 16) return 'diamond';
  if (points >= 8) return 'gold';
  if (points >= 4) return 'silver';
  if (points >= 2) return 'bronze';
  return null;
}

// A permissive profile shape: the badge-relevant fields are optional and an index
// signature lets any fetched profile object (which may also carry username, etc.)
// be passed without the local row types having to declare these fields.
export type ProfileBadgeFields = {
  badge_tier?: string | null;
  badge_show?: boolean | null;
  profile_theme?: string | null;
  story_ring_style?: string | null;
  [key: string]: any;
};

// The tier to actually render next to a username: nothing if the user hid their
// badge or has none. Used by <BadgeEmblem/> and the rings everywhere.
export function displayedTier(profile: ProfileBadgeFields | null | undefined): Tier | null {
  if (!profile || profile.badge_show === false) return null;
  return asTier(profile.badge_tier);
}

function asTier(v: any): Tier | null {
  return v === 'bronze' || v === 'silver' || v === 'gold' || v === 'diamond' ? v : null;
}

// The user's actual tier, ignoring the hide toggle. Used for the cosmetic ring +
// profile theme (opt-in customizations) — the hide toggle governs only the emblem.
export function rawTier(profile: ProfileBadgeFields | null | undefined): Tier | null {
  return asTier(profile?.badge_tier);
}

// Only silver and up earn a special profile-ring color. Bronze (like no badge)
// uses the default Laybell ring, so it maps to null here.
export function specialRingTier(tier: Tier | null | undefined): Tier | null {
  return tier && tier !== 'bronze' ? tier : null;
}

// ─── Customization (rewards) ─────────────────────────────────────────────────
// minTier null = always unlocked (e.g. Default). Otherwise the user's emblem tier
// must rank >= minTier. Gating is enforced on READ so a downgraded user falls back.
// Profile banner gradients escalate with tier: Default/Bronze are modest single-
// hue tints, while the higher tiers get richer, cooler, multi-stop schemes — so a
// higher-badge profile visibly reads as more premium to anyone who views it.
export type ThemeOption = { key: string; label: string; minTier: Tier | null; banner: readonly [string, string, ...string[]] };
export const THEME_OPTIONS: ThemeOption[] = [
  { key: 'default', label: 'Default', minTier: null,      banner: ['#1C0A04', COLORS.background] },
  { key: 'bronze',  label: 'Bronze',  minTier: 'bronze',  banner: ['#3B1F0B', '#1A0D05', COLORS.background] },
  { key: 'silver',  label: 'Silver',  minTier: 'silver',  banner: ['#26384A', '#101D27', COLORS.background] },
  { key: 'gold',    label: 'Gold',    minTier: 'gold',    banner: ['#4E3A0C', '#2A2008', COLORS.background] },
  { key: 'diamond', label: 'Diamond', minTier: 'diamond', banner: ['#0E4E5E', '#143158', COLORS.background] },
];

// The story-ring style is no longer a separate choice — it's bundled into the
// profile theme, escalating with tier: tier-gradient (Default/Bronze) → solid
// (Silver/Gold) → shine (Diamond). Picking a theme applies its ring too.
export type RingStyle = 'default' | 'solid' | 'shine';
export const THEME_RING_STYLE: Record<string, RingStyle> = {
  default: 'default',
  bronze:  'default',
  silver:  'solid',
  gold:    'solid',
  diamond: 'shine',
};

export function isUnlocked(minTier: Tier | null, emblemTier: Tier | null): boolean {
  if (!minTier) return true;
  return tierRank(emblemTier) >= tierRank(minTier);
}

const DEFAULT_BANNER: readonly [string, string, ...string[]] = ['#1C0A04', COLORS.background];

// Banner colors for a profile, honoring the owner's chosen theme but only if
// their current tier still unlocks it (else default). Visitors pass the owner's
// tier so they see the owner's unlocked choice.
export function resolveBannerColors(profile: ProfileBadgeFields | null | undefined, emblemTier: Tier | null): readonly [string, string, ...string[]] {
  const opt = THEME_OPTIONS.find(o => o.key === profile?.profile_theme);
  if (!opt || !isUnlocked(opt.minTier, emblemTier)) return DEFAULT_BANNER;
  return opt.banner;
}

// Ring colors for a profile. The ring style is derived from the chosen profile
// theme (gated by tier — a downgraded user falls back to the default ring).
export function resolveRingColors(
  profile: ProfileBadgeFields | null | undefined,
  emblemTier: Tier | null,
): readonly [string, string] {
  const base = badgeRingColors(emblemTier);
  const opt = THEME_OPTIONS.find(o => o.key === profile?.profile_theme);
  const themeKey = opt && isUnlocked(opt.minTier, emblemTier) ? opt.key : 'default';
  const style = THEME_RING_STYLE[themeKey] ?? 'default';
  if (style === 'solid') return [base[0], base[0]];
  if (style === 'shine') return [base[1], base[0]]; // flip → brighter stop leads
  return base;
}

// ─── State + evaluation ───────────────────────────────────────────────────────
export type DailyRow = { day: string; likes: number; comments: number; music_seconds: number; posts_created: number };
export type BadgeState = { today: string; daily: DailyRow[]; public_posts: number };

// Add `delta` UTC days to a 'YYYY-MM-DD' string. Pure UTC math anchored to the
// server-provided day — never the device clock — so timezones can't shift "today".
function addDaysUTC(dayStr: string, delta: number): string {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// Length of a consecutive run of days (ending today, with one day of grace at
// yesterday so the streak doesn't flicker off at 00:00 UTC before the user is
// active again) for which `has(day)` holds.
function streakLength(today: string, has: (day: string) => boolean): number {
  let cur = has(today) ? today : (has(addDaysUTC(today, -1)) ? addDaysUTC(today, -1) : null);
  let n = 0;
  while (cur && has(cur)) { n++; cur = addDaysUTC(cur, -1); }
  return n;
}

export type CategoryTiers = Partial<Record<BadgeCategory, Tier>>;

// The single highest tier the user currently QUALIFIES for in each (non-locked)
// category, from the raw state. This is the live "qualifying set".
export function qualifyingTiers(state: BadgeState): CategoryTiers {
  const byDay = new Map(state.daily.map(r => [r.day, r]));
  const today = state.today;
  const todayRow = byDay.get(today);

  const loginStreak = streakLength(today, d => byDay.has(d));
  const likeStreak = streakLength(today, d => (byDay.get(d)?.likes ?? 0) >= 15);

  const out: CategoryTiers = {};

  // login
  if (loginStreak >= 30) out.login = 'diamond';
  else if (loginStreak >= 14) out.login = 'gold';
  else if (loginStreak >= 7) out.login = 'silver';
  else if (loginStreak >= 3) out.login = 'bronze';

  // daily likes — bronze is "today" specifically; silver/gold are streaks.
  if (likeStreak >= 7) out.daily_like = 'gold';
  else if (likeStreak >= 3) out.daily_like = 'silver';
  else if ((todayRow?.likes ?? 0) >= 15) out.daily_like = 'bronze';

  // posts — live grid count
  if (state.public_posts >= 5) out.posts = 'silver';
  else if (state.public_posts >= 1) out.posts = 'bronze';

  // music — today's listen seconds
  const ms = todayRow?.music_seconds ?? 0;
  if (ms >= 1800) out.music_streaming = 'gold';
  else if (ms >= 1200) out.music_streaming = 'silver';
  else if (ms >= 600) out.music_streaming = 'bronze';

  // comments — today
  const cm = todayRow?.comments ?? 0;
  if (cm >= 2) out.comments = 'silver';
  else if (cm >= 1) out.comments = 'bronze';

  return out;
}

// Raw progress numbers for the Badges page hints (e.g. "12/15 likes today",
// "login streak 4/7"). Derived from the same state the evaluator uses.
export type BadgeMetrics = {
  loginStreak: number;
  likeStreak: number;
  todayLikes: number;
  todayComments: number;
  musicMinutesToday: number;
  publicPosts: number;
};
export function computeMetrics(state: BadgeState): BadgeMetrics {
  const byDay = new Map(state.daily.map(r => [r.day, r]));
  const today = state.today;
  const todayRow = byDay.get(today);
  return {
    loginStreak: streakLength(today, d => byDay.has(d)),
    likeStreak: streakLength(today, d => (byDay.get(d)?.likes ?? 0) >= 15),
    todayLikes: todayRow?.likes ?? 0,
    todayComments: todayRow?.comments ?? 0,
    musicMinutesToday: Math.floor((todayRow?.music_seconds ?? 0) / 60),
    publicPosts: state.public_posts,
  };
}

export async function fetchBadgeState(): Promise<BadgeState | null> {
  try {
    const { data, error } = await supabase.rpc('get_badge_state');
    if (error || !data) return null;
    const d: any = data;
    return {
      today: d.today,
      daily: Array.isArray(d.daily) ? d.daily : [],
      public_posts: d.public_posts ?? 0,
    };
  } catch {
    return null;
  }
}

export type EvalResult = { tier: Tier | null; points: number; newlyEarned: string[]; held: string[] };
const NOOP_RESULT: EvalResult = { tier: null, points: 0, newlyEarned: [], held: [] };

// Live listeners so the emblem updates app-wide the moment a user's tier changes
// (ProfileContext subscribes and pushes the new tier into the global profile).
type TierListener = (tier: Tier | null) => void;
let tierListeners: TierListener[] = [];
export function onBadgeTierChange(fn: TierListener): () => void {
  tierListeners.push(fn);
  return () => { tierListeners = tierListeners.filter(f => f !== fn); };
}
function emitTier(tier: Tier | null) {
  for (const f of tierListeners) { try { f(tier); } catch {} }
}

// Recompute which badges the user holds and their emblem tier, reconciling the
// DB. Idempotent — safe to run on every app open and after every event.
// Handles daily resets, streak breaks (reversion), and permanence automatically.
export async function evaluateBadges(opts: { silent?: boolean } = {}): Promise<EvalResult> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NOOP_RESULT;

    const [state, existingRes, profileRes] = await Promise.all([
      fetchBadgeState(),
      supabase.from('user_badges').select('badge_key, category, tier, is_permanent').eq('user_id', user.id),
      supabase.from('profiles').select('badge_tier').eq('id', user.id).maybeSingle(),
    ]);
    if (!state) return NOOP_RESULT; // SQL not applied yet → graceful no-op

    const qualifying = qualifyingTiers(state);
    const qKeys = new Set(
      (Object.entries(qualifying) as [BadgeCategory, Tier][]).map(([cat, tier]) => `${cat}_${tier}`),
    );

    const existing: { badge_key: string; category: string; tier: string; is_permanent: boolean }[] =
      existingRes.data ?? [];
    const existingByKey = new Map(existing.map(r => [r.badge_key, r]));

    // Reconcile: drop non-permanent badges no longer qualifying; insert new ones;
    // keep permanents and still-qualifying ones untouched (no churn).
    const toDelete = existing.filter(r => !r.is_permanent && !qKeys.has(r.badge_key)).map(r => r.badge_key);
    const toInsert = Array.from(qKeys).filter(k => !existingByKey.has(k));

    if (toDelete.length) {
      await supabase.from('user_badges').delete().eq('user_id', user.id).in('badge_key', toDelete);
    }
    if (toInsert.length) {
      await supabase.from('user_badges').upsert(
        toInsert.map(k => {
          const def = BADGES_BY_KEY[k];
          return { user_id: user.id, badge_key: k, category: def.category, tier: def.tier, is_permanent: def.permanent };
        }),
        { onConflict: 'user_id,badge_key' },
      );
    }

    // Final held set = kept existing (permanent OR still qualifying) + inserts.
    const heldKeys = new Set<string>([
      ...existing.filter(r => r.is_permanent || qKeys.has(r.badge_key)).map(r => r.badge_key),
      ...toInsert,
    ]);

    // Point rollup: max weight per category (this is both "highest tier per
    // category" and the "permanent floor" — a kept permanent badge keeps its
    // weight even after its streak lapses).
    const byCategory = new Map<string, number>();
    for (const key of heldKeys) {
      const def = BADGES_BY_KEY[key];
      if (!def) continue;
      const w = TIER_WEIGHT[def.tier];
      byCategory.set(def.category, Math.max(byCategory.get(def.category) ?? 0, w));
    }
    const points = Array.from(byCategory.values()).reduce((a, b) => a + b, 0);
    const tier = computeEmblemTier(points);

    const prevTier = asTier(profileRes.data?.badge_tier);
    if (tier !== prevTier) {
      await supabase.from('profiles').update({ badge_tier: tier }).eq('id', user.id);
      emitTier(tier);
    }

    return { tier, points, newlyEarned: toInsert, held: Array.from(heldKeys) };
  } catch {
    return NOOP_RESULT;
  }
}

// ─── Event helpers (called from activity sites) ──────────────────────────────
export async function recordActivity(category: string, count = 1): Promise<void> {
  try { await supabase.rpc('record_badge_activity', { p_category: category, p_count: count }); } catch {}
}

// Mark the user active today (ensures today's row exists) without changing a counter.
export async function touchLogin(): Promise<void> {
  await recordActivity('login', 0);
}

let evalTimer: ReturnType<typeof setTimeout> | null = null;
// Coalesce a burst of events (e.g. rapid likes) into a single evaluation.
export function evaluateBadgesDebounced(): void {
  if (evalTimer) clearTimeout(evalTimer);
  evalTimer = setTimeout(() => { evalTimer = null; evaluateBadges({ silent: false }).catch(() => {}); }, 4000);
}

// One-liner for activity sites: record the event, then schedule an evaluation.
export function bumpBadge(category: string, count = 1): void {
  recordActivity(category, count);
  evaluateBadgesDebounced();
}
