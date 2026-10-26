import { supabase } from './supabase';
import { tierRank, type Tier } from './badges';

// Page Health — ONE 0–100 score, private to the owner, shown on their own profile.
// It blends the durable signals Laybell's feed algorithm actually rewards (earned
// status, engagement, reach, audience growth, and consistent posting) so a creator
// can see, directly, how well their page is doing instead of guessing.
//
// Computed CLIENT-SIDE from the user's own data: the denormalized counter columns on
// their posts, the follows graph, and their badge tier. No server round-trip beyond
// a couple of cheap reads, and nothing to game — only you ever see your own score.

export type HealthKey = 'status' | 'engagement' | 'consistency';
export type HealthComponent = { key: HealthKey; pct: number }; // pct 0–100
export type PageHealth = { score: number; components: HealthComponent[] };

// Weights sum to 100. Three main factors: Engagement leads (it folds in reach and
// follower growth — the whole "are people engaging with and spreading your content?"
// picture), with Status and Consistency as the other two pillars.
const WEIGHT: Record<HealthKey, number> = { status: 25, engagement: 50, consistency: 25 };
// Display order of the breakdown bars (independent of the weights above):
// Status on top, then Consistency, then Engagement.
const ORDER: HealthKey[] = ['status', 'consistency', 'engagement'];
// "Full marks" targets per signal (tunable — the score is private, so easy to retune).
const TARGET_ENGAGEMENT = 20;   // avg interactions per post
const TARGET_REACH = 100_000;   // lifetime plays + views (log-scaled)
const TARGET_GROWTH = 40;       // new followers in the last 30 days
const TARGET_POSTS = 10;        // posts in the last 30 days

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sat = (x: number, target: number) => clamp01(x / target);
const satLog = (x: number, target: number) => clamp01(Math.log10(1 + Math.max(0, x)) / Math.log10(1 + target));

function tierN(badgeTier?: string | null): number {
  const valid = ['bronze', 'silver', 'gold', 'diamond'];
  return badgeTier && valid.includes(badgeTier) ? tierRank(badgeTier as Tier) / 4 : 0;
}

/** Compute a user's Page Health from their own posts, follows and badge tier. */
export async function computePageHealth(userId: string, badgeTier?: string | null): Promise<PageHealth> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  try {
    const [postsRes, , growthRes] = await Promise.all([
      supabase
        .from('posts')
        .select('like_count, comment_count, save_count, repost_count, stream_count, view_count, created_at')
        .eq('user_id', userId)
        .is('archived_at', null)
        .is('publish_at', null),
      // (followers total isn't a score input, but the growth query below needs the table warm)
      Promise.resolve(null),
      supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', userId)
        .gte('created_at', since30),
    ]);

    const posts = (postsRes.data ?? []) as any[];
    const nPosts = posts.length;
    let interactions = 0, reach = 0, recentPosts = 0;
    for (const p of posts) {
      interactions += (p.like_count || 0) + (p.comment_count || 0) + (p.save_count || 0) + (p.repost_count || 0);
      reach += (p.stream_count || 0) + (p.view_count || 0);
      if (p.created_at && p.created_at >= since30) recentPosts++;
    }
    const avgEngagement = nPosts > 0 ? interactions / nPosts : 0;
    const growth30 = growthRes.count ?? 0;

    // Engagement folds interactions-per-post, reach and follower growth into one bar.
    const engagementN = clamp01(
      0.4 * sat(avgEngagement, TARGET_ENGAGEMENT) +
      0.3 * satLog(reach, TARGET_REACH) +
      0.3 * sat(growth30, TARGET_GROWTH),
    );
    const norm: Record<HealthKey, number> = {
      status: tierN(badgeTier),
      engagement: engagementN,
      consistency: sat(recentPosts, TARGET_POSTS),
    };
    const score = Math.round(
      (Object.keys(WEIGHT) as HealthKey[]).reduce((s, k) => s + WEIGHT[k] * norm[k], 0),
    );
    const components = ORDER.map((k) => ({ key: k, pct: Math.round(norm[k] * 100) }));
    return { score, components }; // weights sum to 100, norms are 0–1 → score is already 0–100
  } catch {
    return { score: 0, components: (Object.keys(WEIGHT) as HealthKey[]).map((k) => ({ key: k, pct: 0 })) };
  }
}

export type HealthLevelKey = 'thriving' | 'rising' | 'steady' | 'warming' | 'start';

/** The label band a score falls in. */
export function healthLevel(score: number): HealthLevelKey {
  if (score >= 80) return 'thriving';
  if (score >= 60) return 'rising';
  if (score >= 40) return 'steady';
  if (score >= 20) return 'warming';
  return 'start';
}

// Encouraging colour ramp: red ONLY when really low, green emerges early (~45 reads
// yellow-green) and deepens to vivid green by 80+, so improvement shows up fast.
const HEALTH_STOPS: Array<[number, [number, number, number]]> = [
  [0, [239, 68, 68]],     // red
  [25, [245, 158, 11]],   // amber
  [45, [190, 242, 100]],  // yellow-green (green starts to show here)
  [65, [74, 222, 128]],   // green
  [85, [34, 197, 94]],    // vivid green
  [100, [21, 163, 74]],   // deep green
];
/** Continuous bar colour for a score along the encouraging ramp above. */
export function healthColor(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  let lo = HEALTH_STOPS[0];
  let hi = HEALTH_STOPS[HEALTH_STOPS.length - 1];
  for (let i = 0; i < HEALTH_STOPS.length - 1; i++) {
    if (s >= HEALTH_STOPS[i][0] && s <= HEALTH_STOPS[i + 1][0]) { lo = HEALTH_STOPS[i]; hi = HEALTH_STOPS[i + 1]; break; }
  }
  const f = hi[0] === lo[0] ? 0 : (s - lo[0]) / (hi[0] - lo[0]);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(lo[1][0], hi[1][0]))}${hex(mix(lo[1][1], hi[1][1]))}${hex(mix(lo[1][2], hi[1][2]))}`;
}
