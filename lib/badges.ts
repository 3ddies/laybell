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
  | 'login' | 'daily_like' | 'posts' | 'music_streaming' | 'comments' | 'curator'
  | 'community' | 'ads' | 'app_sharing';

export type BadgeDef = {
  key: string;          // `${category}_${tier}`, e.g. 'login_gold'
  category: BadgeCategory;
  tier: Tier;
  title: string;        // short label for the Badges page
  criteria: string;     // human-readable requirement
  permanent: boolean;   // (Per) — never revoked once earned
  locked: boolean;      // reserved: renders "coming soon" and never auto-earns.
                        // Every badge in the catalog is now `false` — kept so a
                        // future category can ship its UI before its backing system.
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
// Mirrors the user's notes. Community / Ads / App-sharing were once `locked: true`
// stubs; all three now have backing systems and every badge here is earnable.
export const BADGES: BadgeDef[] = [
  // Login (streak; TWO diamonds — temporary at 30 days, permanent at 90. The only
  // category with two badges of the same tier; see qualifyingKeys for the special
  // handling. Both weigh diamond=8, so holding one or both rolls up identically.)
  { key: 'login_bronze',       category: 'login', tier: 'bronze',  title: 'Bronze Login',            criteria: 'Log in 3+ days in a row',  permanent: false, locked: false },
  { key: 'login_silver',       category: 'login', tier: 'silver',  title: 'Silver Login',            criteria: 'Log in 7+ days in a row',  permanent: false, locked: false },
  { key: 'login_gold',         category: 'login', tier: 'gold',    title: 'Gold Login',              criteria: 'Log in 14+ days in a row', permanent: false, locked: false },
  { key: 'login_diamond',      category: 'login', tier: 'diamond', title: 'Diamond Login',           criteria: 'Log in 30+ days in a row', permanent: false, locked: false },
  { key: 'login_diamond_perm', category: 'login', tier: 'diamond', title: 'Permanent Diamond Login', criteria: 'Log in 90 days in a row', permanent: true,  locked: false },

  // Daily likes
  { key: 'daily_like_bronze', category: 'daily_like', tier: 'bronze', title: 'Bronze Likes', criteria: 'Like 10+ posts today',                permanent: false, locked: false },
  { key: 'daily_like_silver', category: 'daily_like', tier: 'silver', title: 'Silver Likes', criteria: 'Like 10+ posts each day for 3+ days', permanent: false, locked: false },
  { key: 'daily_like_gold',   category: 'daily_like', tier: 'gold',   title: 'Gold Likes',   criteria: 'Like 10+ posts each day for 7+ days', permanent: false, locked: false },

  // Posts (live grid count)
  { key: 'posts_bronze', category: 'posts', tier: 'bronze', title: 'Bronze Poster', criteria: 'Share a public post',            permanent: false, locked: false },
  { key: 'posts_silver', category: 'posts', tier: 'silver', title: 'Silver Poster', criteria: 'Have 5+ public posts on your grid', permanent: false, locked: false },

  // Music streaming (today's listen time)
  { key: 'music_streaming_bronze', category: 'music_streaming', tier: 'bronze', title: 'Bronze Listener', criteria: 'Stream 10+ min of audio today', permanent: false, locked: false },
  { key: 'music_streaming_silver', category: 'music_streaming', tier: 'silver', title: 'Silver Listener', criteria: 'Stream 20+ min of audio today', permanent: false, locked: false },
  { key: 'music_streaming_gold',   category: 'music_streaming', tier: 'gold',   title: 'Gold Listener',   criteria: 'Stream 30+ min of audio today', permanent: false, locked: false },

  // Comments (today)
  { key: 'comments_bronze', category: 'comments', tier: 'bronze', title: 'Bronze Voice', criteria: 'Leave a comment today',     permanent: false, locked: false },
  { key: 'comments_silver', category: 'comments', tier: 'silver', title: 'Silver Voice', criteria: 'Leave 2+ comments today',   permanent: false, locked: false },

  // Curator (listens by OTHERS on the user's single most-listened PUBLIC playlist —
  // a live count, so privating or deleting that playlist drops the badge, and making
  // it public again re-awards it on the next evaluation; caps at gold)
  { key: 'curator_bronze',  category: 'curator', tier: 'bronze',  title: 'Bronze Curator',  criteria: 'Have 100+ listens on a public playlist',    permanent: false, locked: false },
  { key: 'curator_silver',  category: 'curator', tier: 'silver',  title: 'Silver Curator',  criteria: 'Have 500+ listens on a public playlist',    permanent: false, locked: false },
  { key: 'curator_gold',    category: 'curator', tier: 'gold',    title: 'Gold Curator',    criteria: 'Have 2,500+ listens on a public playlist',  permanent: false, locked: false },

  // Spotlight (distinct spotlighted posts engaged with today — like/comment/
  // save/share on a served spotlight. Counted through ad_engagements; requires
  // spotlight.sql. Keys keep the ads_ prefix — they're stored in the DB.)
  { key: 'ads_bronze',       category: 'ads',       tier: 'bronze', title: 'Bronze Patron',  criteria: 'Engage with a spotlighted post today',   permanent: false, locked: false },
  { key: 'ads_silver',       category: 'ads',       tier: 'silver', title: 'Silver Patron',  criteria: 'Engage with 2+ spotlighted posts today', permanent: false, locked: false },

  // Community — live membership/ownership (from lib/communities). Bronze: be an
  // active member of any community; Silver: own (created) a community. No gold.
  { key: 'community_bronze', category: 'community', tier: 'bronze', title: 'Bronze Member',  criteria: 'Join a community',  permanent: false, locked: false },
  { key: 'community_silver', category: 'community', tier: 'silver', title: 'Silver Member',  criteria: 'Own a community',   permanent: false, locked: false },

  // App sharing — lifetime count of app shares/invites (profiles.app_shares,
  // bumped by record_app_share). Gold is permanent (a milestone you keep).
  { key: 'app_sharing_bronze',  category: 'app_sharing', tier: 'bronze',  title: 'Bronze Advocate',  criteria: 'Share the app',                  permanent: false, locked: false },
  { key: 'app_sharing_silver',  category: 'app_sharing', tier: 'silver',  title: 'Silver Advocate',  criteria: 'Share the app with 8+ people',   permanent: false, locked: false },
  { key: 'app_sharing_gold',    category: 'app_sharing', tier: 'gold',    title: 'Gold Advocate',    criteria: 'Share the app with 15 people',   permanent: true,  locked: false },
];

export const BADGES_BY_KEY: Record<string, BadgeDef> = Object.fromEntries(BADGES.map(b => [b.key, b]));

export const CATEGORY_META: Record<BadgeCategory, { label: string; icon: string }> = {
  login:           { label: 'Login',           icon: 'log-in-outline' },
  daily_like:      { label: 'Daily Likes',      icon: 'heart-outline' },
  posts:           { label: 'Posts',            icon: 'images-outline' },
  music_streaming: { label: 'Music Streaming',  icon: 'musical-notes-outline' },
  comments:        { label: 'Comments',         icon: 'chatbubble-outline' },
  curator:         { label: 'Playlists',        icon: 'albums-outline' },
  community:       { label: 'Community',         icon: 'people-outline' },
  ads:             { label: 'Spotlight',        icon: 'sparkles-outline' },
  app_sharing:     { label: 'App Sharing',      icon: 'share-social-outline' },
};

// Order the Badges page lists categories in.
export const CATEGORY_ORDER: BadgeCategory[] = [
  'login', 'daily_like', 'posts', 'music_streaming', 'comments', 'curator', 'community', 'ads', 'app_sharing',
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
// badge or has none. Used by <BadgeEmblem/> and the rings everywhere. Reflects the
// badge the user has CHOSEN to display (see chosenTier), which may be lower than
// their earned tier.
export function displayedTier(profile: ProfileBadgeFields | null | undefined): Tier | null {
  if (!profile || profile.badge_show === false) return null;
  return chosenTier(profile);
}

function asTier(v: any): Tier | null {
  return v === 'bronze' || v === 'silver' || v === 'gold' || v === 'diamond' ? v : null;
}

// The user's actual EARNED tier, ignoring both the hide toggle and the display
// choice. Used for gating (which themes/badges they can pick) — never for display.
export function rawTier(profile: ProfileBadgeFields | null | undefined): Tier | null {
  return asTier(profile?.badge_tier);
}

// How many PUBLIC playlists each earned tier may have at once (checked at
// creation time; deleting one frees the slot). No badge → none. Private
// playlists are unlimited for everyone.
export const PUBLIC_PLAYLIST_LIMIT: Record<Tier, number> = { bronze: 1, silver: 2, gold: 3, diamond: 6 };
export function publicPlaylistLimit(tier: Tier | null): number {
  return tier ? PUBLIC_PLAYLIST_LIMIT[tier] : 0;
}

// How many PUBLIC posts each earned tier may have live at once (checked at
// post time; deleting or archiving one frees its slot). No badge shares the
// bronze allowance; diamond is unlimited. Friends-only posts are never gated.
export const PUBLIC_POST_LIMIT: Record<Tier, number> = { bronze: 6, silver: 12, gold: 24, diamond: Infinity };
export function publicPostLimit(tier: Tier | null): number {
  return tier ? PUBLIC_POST_LIMIT[tier] : 6;
}

// How many tracks each tier may keep DOWNLOADED for offline at once (checked at
// download time; removing one frees a slot). Offline is a quality-of-life feature,
// not a heavily-gated reward — so everyone gets a baseline even without a badge, and
// tiers escalate generously. The real scalability guard is the device byte cap in
// lib/offline.ts (OFFLINE_BYTE_CAP), which overrides the count. A demoted user's
// over-limit downloads are LOCKED (kept on disk, re-enabled when re-earned), never
// auto-deleted — see docs/OFFLINE_STREAMING_PLAN.md §3.6.
export const OFFLINE_PIN_BASELINE = 10;
export const OFFLINE_PIN_LIMIT: Record<Tier, number> = { bronze: 30, silver: 75, gold: 150, diamond: 300 };
export function offlinePinLimit(tier: Tier | null): number {
  return tier ? OFFLINE_PIN_LIMIT[tier] : OFFLINE_PIN_BASELINE;
}

// The tier the user has CHOSEN to present. Their profile theme doubles as the
// badge they display: a tier-specific theme shows that tier (so a higher-tier user
// can deliberately display a lower badge), while Default shows NO badge at all
// (clean look). Always capped at what they've actually earned. This is the single
// source of truth for the displayed emblem, ring color, and accents app-wide.
export function chosenTier(profile: ProfileBadgeFields | null | undefined): Tier | null {
  const earned = asTier(profile?.badge_tier);
  const opt = THEME_OPTIONS.find(o => o.key === profile?.profile_theme);
  if (!opt || !opt.minTier) return null;               // Default theme → no displayed badge
  if (!isUnlocked(opt.minTier, earned)) return null;   // safety: never show unearned
  return opt.minTier;
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

// Profile banner: fades from the user's DISPLAYED badge color into the active
// theme background (so it reads as "badge color → white" on Light, "→ black" on
// Dark, etc.). No displayed badge → a flat themed background. `displayTier` is the
// chosen/displayed tier; `background` is the current theme's background color.
export function resolveBannerColors(displayTier: Tier | null, background: string): readonly [string, string] {
  if (!displayTier) return [background, background];
  return [badgeRingColors(displayTier)[0], background];
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
// `ad_engagements` arrives only after the updated badges.sql is applied — absent reads as 0.
export type DailyRow = { day: string; likes: number; comments: number; music_seconds: number; posts_created: number; ad_engagements?: number };
// `top_playlist_listens` = play count of the user's single most-listened PUBLIC
// playlist (not a sum across playlists) — the curator badge requires one playlist
// to hit the threshold on its own.
export type BadgeState = {
  today: string; daily: DailyRow[]; public_posts: number; top_playlist_listens: number;
  // Live community standing (from lib/communities): count of active memberships
  // and of communities the user owns. Day-independent, like public_posts.
  communities_joined: number; communities_owned: number;
  // Lifetime app-share count (profiles.app_shares) — drives the App-sharing badges.
  app_shares: number;
};

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

// How many likes count as a qualifying "daily likes" day.
const DAILY_LIKES_TARGET = 10;

// SECRET grace period (deliberately not surfaced anywhere in the UI): for the
// first 6 hours of each UTC day, yesterday's qualifications still count. Daily
// badges and streaks therefore don't vanish the instant the day flips — a user
// who met the requirements but is asleep/busy/offline at midnight keeps their
// badges and has a real window to re-qualify. Anchored to the server-provided
// day; the device clock only supplies the current instant (hour-level accuracy
// is plenty for a 6h window).
const GRACE_HOURS = 6;

function withinGrace(today: string): boolean {
  const [y, m, d] = today.split('-').map(Number);
  return Date.now() < Date.UTC(y, m - 1, d) + GRACE_HOURS * 3600_000;
}

// PREMIUM perk — a longer grace window for time-sensitive badges. The premium
// status is injected by lib/entitlements (setBadgePremiumGetter) rather than
// imported, because entitlements.ts already imports THIS module (the reverse
// import would be a cycle). Read at evaluation time so it tracks live status.
let _isPremiumGetter: () => boolean = () => false;
export function setBadgePremiumGetter(fn: () => boolean): void { _isPremiumGetter = fn; }
const PREMIUM_GRACE_DAYS = 3;

// How many PRIOR days still count toward today's badges/streaks. Premium users
// get a 3-day cushion (a busy day never breaks a streak); free users keep the
// existing behavior — 1 day (yesterday) during the 6h midnight window, else 0.
function graceDaysNow(today: string): number {
  if (_isPremiumGetter()) return PREMIUM_GRACE_DAYS;
  return withinGrace(today) ? 1 : 0;
}

// Per-category max of two qualifying sets.
function mergeTiers(a: CategoryTiers, b: CategoryTiers): CategoryTiers {
  const out: CategoryTiers = { ...a };
  for (const [cat, tier] of Object.entries(b) as [BadgeCategory, Tier][]) {
    if (tierRank(tier) > tierRank(out[cat])) out[cat] = tier;
  }
  return out;
}

// The single highest tier the user currently QUALIFIES for in each (non-locked)
// category, from the raw state. This is the live "qualifying set". During the
// grace window the evaluation also runs anchored to YESTERDAY and the better
// tier per category wins, so nothing reverts at the stroke of midnight.
export function qualifyingTiers(state: BadgeState): CategoryTiers {
  let tiers = qualifyingTiersAt(state, state.today);
  // Merge in each grace day (premium: 3, free: yesterday during the 6h window),
  // taking the best tier per category — so a badge earned within the grace window
  // is retained even if today doesn't qualify.
  const grace = graceDaysNow(state.today);
  for (let i = 1; i <= grace; i++) {
    tiers = mergeTiers(tiers, qualifyingTiersAt(state, addDaysUTC(state.today, -i)));
  }
  return tiers;
}

// Login streak with the same grace the tier evaluation gets. Anchoring the streak
// at an earlier day bridges a recent lapse: a run that ended within the grace
// window still counts, so the streak (and its badge) survives up to `grace` days.
function loginStreakWithGrace(state: BadgeState): number {
  const byDay = new Map(state.daily.map(r => [r.day, r]));
  let best = streakLength(state.today, d => byDay.has(d));
  const grace = graceDaysNow(state.today);
  for (let i = 1; i <= grace; i++) {
    best = Math.max(best, streakLength(addDaysUTC(state.today, -i), d => byDay.has(d)));
  }
  return best;
}

// The badge KEYS the user currently qualifies for: one per category from the tier
// rollup, plus dual-tier specials — the 90-day PERMANENT login diamond coexists
// with the 30-day temporary one (a 90-day streak holds both).
export function qualifyingKeys(state: BadgeState): Set<string> {
  const keys = new Set(
    (Object.entries(qualifyingTiers(state)) as [BadgeCategory, Tier][]).map(([cat, tier]) => `${cat}_${tier}`),
  );
  if (loginStreakWithGrace(state) >= 90) keys.add('login_diamond_perm');
  return keys;
}

// Qualifying set as of `today` (the anchor day for "today" counters + streaks).
function qualifyingTiersAt(state: BadgeState, today: string): CategoryTiers {
  const byDay = new Map(state.daily.map(r => [r.day, r]));
  const todayRow = byDay.get(today);

  const loginStreak = streakLength(today, d => byDay.has(d));
  const likeStreak = streakLength(today, d => (byDay.get(d)?.likes ?? 0) >= DAILY_LIKES_TARGET);

  const out: CategoryTiers = {};

  // login
  if (loginStreak >= 30) out.login = 'diamond';
  else if (loginStreak >= 14) out.login = 'gold';
  else if (loginStreak >= 7) out.login = 'silver';
  else if (loginStreak >= 3) out.login = 'bronze';

  // daily likes — bronze is "today" specifically; silver/gold are streaks.
  if (likeStreak >= 7) out.daily_like = 'gold';
  else if (likeStreak >= 3) out.daily_like = 'silver';
  else if ((todayRow?.likes ?? 0) >= DAILY_LIKES_TARGET) out.daily_like = 'bronze';

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

  // spotlight — distinct spotlighted posts engaged with today (0 until
  // spotlight.sql lands)
  const ad = todayRow?.ad_engagements ?? 0;
  if (ad >= 2) out.ads = 'silver';
  else if (ad >= 1) out.ads = 'bronze';

  // curator — listens on the user's single best PUBLIC playlist (caps at gold).
  // Live: privating/deleting the playlist drops this to the next-best (or 0), and
  // re-publicizing restores it, so the badge revokes and re-awards automatically.
  const pl = state.top_playlist_listens;
  if (pl >= 2500) out.curator = 'gold';
  else if (pl >= 500) out.curator = 'silver';
  else if (pl >= 100) out.curator = 'bronze';

  // community — live membership/ownership. Own a community → silver; be an active
  // member of any → bronze (owning implies membership, so an owner gets silver).
  // Live: leaving your last community drops bronze; the community being archived
  // drops silver — both re-award automatically on the next evaluation.
  if (state.communities_owned >= 1) out.community = 'silver';
  else if (state.communities_joined >= 1) out.community = 'bronze';

  // app sharing — lifetime count of app shares/invites (cumulative, only grows).
  // Gold is permanent (see catalog), so once hit it's held even if the number
  // somehow changed. Bronze 1 / Silver 8 / Gold 15.
  const shares = state.app_shares;
  if (shares >= 15) out.app_sharing = 'gold';
  else if (shares >= 8) out.app_sharing = 'silver';
  else if (shares >= 1) out.app_sharing = 'bronze';

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
  topPlaylistListens: number;
  todayAdEngagements: number;
  communitiesJoined: number;
  communitiesOwned: number;
  appShares: number;
};
export function computeMetrics(state: BadgeState): BadgeMetrics {
  const byDay = new Map(state.daily.map(r => [r.day, r]));
  const today = state.today;
  const todayRow = byDay.get(today);
  return {
    loginStreak: streakLength(today, d => byDay.has(d)),
    likeStreak: streakLength(today, d => (byDay.get(d)?.likes ?? 0) >= DAILY_LIKES_TARGET),
    todayLikes: todayRow?.likes ?? 0,
    todayComments: todayRow?.comments ?? 0,
    musicMinutesToday: Math.floor((todayRow?.music_seconds ?? 0) / 60),
    publicPosts: state.public_posts,
    topPlaylistListens: state.top_playlist_listens,
    todayAdEngagements: todayRow?.ad_engagements ?? 0,
    communitiesJoined: state.communities_joined,
    communitiesOwned: state.communities_owned,
    appShares: state.app_shares,
  };
}

export async function fetchBadgeState(): Promise<BadgeState | null> {
  try {
    // Playlist listens are read client-side from playlists.play_count (added by
    // public_playlists.sql) rather than baked into get_badge_state — if that
    // migration isn't applied yet the select fails and the count is just 0.
    // Only PUBLIC playlists count and only the single best one (max, not sum):
    // a privated playlist drops out of this query immediately, so the curator
    // badge revokes on the next evaluation and re-awards if it goes public again.
    const [stateRes, playsRes, commRes] = await Promise.all([
      supabase.rpc('get_badge_state'),
      (async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return 0;
          const { data, error } = await supabase
            .from('playlists').select('play_count').eq('user_id', user.id).eq('is_public', true);
          if (error || !data) return 0;
          return data.reduce((max, r: any) => Math.max(max, r.play_count ?? 0), 0);
        } catch { return 0; }
      })(),
      // Community standing + lifetime app-shares, read client-side (same graceful
      // pattern as playlist listens): active memberships → "joined", owned
      // non-archived communities → "owned", profiles.app_shares → "shares". If a
      // migration isn't applied the corresponding select fails and reads as 0.
      (async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return { joined: 0, owned: 0, shares: 0 };
          const [joinedRes, ownedRes, shareRes] = await Promise.all([
            supabase.from('community_members').select('community_id', { count: 'exact', head: true })
              .eq('user_id', user.id).eq('status', 'active'),
            supabase.from('communities').select('id', { count: 'exact', head: true })
              .eq('owner_id', user.id).neq('status', 'archived'),
            supabase.from('profiles').select('app_shares').eq('id', user.id).maybeSingle(),
          ]);
          return {
            joined: joinedRes.count ?? 0,
            owned: ownedRes.count ?? 0,
            shares: (shareRes.data as any)?.app_shares ?? 0,
          };
        } catch { return { joined: 0, owned: 0, shares: 0 }; }
      })(),
    ]);
    if (stateRes.error || !stateRes.data) return null;
    const d: any = stateRes.data;
    return {
      today: d.today,
      daily: Array.isArray(d.daily) ? d.daily : [],
      public_posts: d.public_posts ?? 0,
      top_playlist_listens: playsRes,
      communities_joined: commRes.joined,
      communities_owned: commRes.owned,
      app_shares: commRes.shares,
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

// Separate listeners fired ONLY when the tier goes UP (a real achievement), so a
// celebratory in-app toast can notify the user mid-session.
type TierUpgradeListener = (tier: Tier) => void;
let tierUpgradeListeners: TierUpgradeListener[] = [];
export function onBadgeTierUpgrade(fn: TierUpgradeListener): () => void {
  tierUpgradeListeners.push(fn);
  return () => { tierUpgradeListeners = tierUpgradeListeners.filter(f => f !== fn); };
}
function emitTierUpgrade(tier: Tier) {
  for (const f of tierUpgradeListeners) { try { f(tier); } catch {} }
}

// ── TEMP TESTING OVERRIDE — REMOVE BEFORE RELEASE ────────────────────────────
// Each listed username is forced to the given tier and skips the normal
// recompute, so the badge-gated Communities flows (Diamond creates / Gold
// manages) can be tested on throwaway accounts. To restore normal fairness:
// empty this map (and run, once, in the SQL editor:
//   update public.profiles set badge_tier=null, profile_theme='default'
//   where lower(username) in ('observer','rachaelhall');).
const TEST_FORCE_TIER: Record<string, Tier> = {
  observer: 'diamond',
  rachaelhall: 'gold',
};

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
      supabase.from('profiles').select('badge_tier, username').eq('id', user.id).maybeSingle(),
    ]);

    // TEMP TESTING OVERRIDE (see TEST_FORCE_TIER above): force the listed
    // account(s) to a fixed tier and skip recompute. Only writes/notifies when
    // the row isn't already that tier, so it can't loop with the ProfileContext
    // tier-change refresh. Runs before the !state guard so it works even if the
    // badges SQL is missing.
    const forcedTier = TEST_FORCE_TIER[(profileRes.data?.username ?? '').toLowerCase()];
    if (forcedTier) {
      if (asTier(profileRes.data?.badge_tier) !== forcedTier) {
        await supabase.from('profiles').update({ badge_tier: forcedTier, profile_theme: forcedTier }).eq('id', user.id);
        emitTier(forcedTier);
      }
      return { tier: forcedTier, points: 999, newlyEarned: [], held: [] };
    }

    if (!state) return NOOP_RESULT; // SQL not applied yet → graceful no-op

    const qKeys = qualifyingKeys(state);

    const existing: { badge_key: string; category: string; tier: string; is_permanent: boolean }[] =
      existingRes.data ?? [];
    const existingByKey = new Map(existing.map(r => [r.badge_key, r]));

    // Permanence comes from the CATALOG, not the stored row, so a rule change is
    // retroactive (e.g. login_diamond was permanent when it meant 30 days; it's
    // temporary now that the permanent one requires 90 — old holders revert too).
    const isPerm = (r: { badge_key: string }) => !!BADGES_BY_KEY[r.badge_key]?.permanent;

    // Reconcile: drop non-permanent badges no longer qualifying; insert new ones;
    // keep permanents and still-qualifying ones untouched (no churn). Rows whose
    // key was retired from the catalog (e.g. the old curator/app-sharing diamonds)
    // are purged even if permanent — they no longer exist to be held.
    const toDelete = existing
      .filter(r => !BADGES_BY_KEY[r.badge_key] || (!isPerm(r) && !qKeys.has(r.badge_key)))
      .map(r => r.badge_key);
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
      ...existing
        .filter(r => BADGES_BY_KEY[r.badge_key] && (isPerm(r) || qKeys.has(r.badge_key)))
        .map(r => r.badge_key),
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
      // The DISPLAYED badge tracks the earned tier: on any upgrade/downgrade, snap
      // the profile theme (which doubles as the shown emblem — see chosenTier) to
      // the tier they just earned/lost, so a user always presents their CURRENT
      // status rather than a stale choice. `default` = no badge (tier dropped to
      // none). Between tier changes the theme is left alone, so a deliberate
      // lower-badge pick still sticks until the next real change.
      await supabase
        .from('profiles')
        .update({ badge_tier: tier, profile_theme: tier ?? 'default' })
        .eq('id', user.id);
      emitTier(tier);
      // Only fire the upgrade notification when the tier actually went UP.
      if (tier && tierRank(tier) > tierRank(prevTier)) emitTierUpgrade(tier);
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

// Record ONE completed app share/invite (bumps the lifetime profiles.app_shares
// counter), then re-evaluate so the App-sharing (Advocate) badge updates. Called
// from share surfaces after the native share sheet reports an actual share.
// Awaits the increment so the debounced evaluation reads the new total.
export async function recordAppShare(): Promise<void> {
  try { await supabase.rpc('record_app_share'); } catch {}
  evaluateBadgesDebounced();
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
