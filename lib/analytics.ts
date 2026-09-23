import { supabase } from './supabase';

// Creator analytics — all derived from REAL data already in the schema (posts,
// follows, likes, comments, saves/streams/views counters). No demographic data
// (age/gender/location) exists, so we don't fabricate it; we surface growth,
// engagement, timing and content-performance insights instead.

export type RangeMode = '7d' | '30d' | '90d' | 'all';

export type Totals = {
  followers: number;
  following: number;
  posts: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  views: number; // video views + audio plays
};

export type TopPost = {
  id: string;
  type: string;
  caption: string;
  thumb: string | null;
  likes: number;
  comments: number;
  saves: number;
  views: number;
  engagement: number;
  created_at: string;
};

export type ContentTypeStat = {
  type: string;
  count: number;
  engagement: number;     // total likes+comments+saves for this type
  avgEngagement: number;  // per post
};

export type CreatorAnalytics = {
  totals: Totals;
  engagementRate: number;        // avg (likes+comments+saves) per post
  // Raw event timestamps (ms) within the last year — the screen buckets these per
  // selected range so toggling ranges needs no refetch.
  followerTs: number[];
  engagementTs: number[];        // like + comment timestamps
  byHour: number[];              // 24 — engagement count per hour of day
  byDay: number[];               // 7  — engagement count per weekday (0=Sun)
  peakHour: number | null;       // 0..23
  peakDay: number | null;        // 0..6
  contentMix: ContentTypeStat[];
  topPosts: TopPost[];
};

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RANGE_CFG: Record<RangeMode, { days: number; count: number; fmt: (d: Date) => string }> = {
  '7d':  { days: 7,   count: 7,  fmt: (d) => WD[d.getDay()] },
  '30d': { days: 30,  count: 10, fmt: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
  '90d': { days: 90,  count: 12, fmt: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
  'all': { days: 365, count: 12, fmt: (d) => MO[d.getMonth()] },
};

// Bucket event timestamps into a {label,value}[] series for the chosen range.
export function buildSeries(timestamps: number[], mode: RangeMode): { label: string; value: number }[] {
  const { days, count, fmt } = RANGE_CFG[mode];
  const now = Date.now();
  const sizeMs = (days * 86_400_000) / count;
  const start = now - days * 86_400_000;
  const buckets = new Array(count).fill(0);
  for (const t of timestamps) {
    if (t < start) continue;
    let idx = Math.floor((t - start) / sizeMs);
    if (idx < 0) idx = 0;
    if (idx >= count) idx = count - 1;
    buckets[idx] += 1;
  }
  return buckets.map((v, i) => ({ label: fmt(new Date(start + i * sizeMs)), value: v }));
}

// New followers within the range (sum of the series).
export function countInRange(timestamps: number[], mode: RangeMode): number {
  const { days } = RANGE_CFG[mode];
  const start = Date.now() - days * 86_400_000;
  return timestamps.reduce((n, t) => (t >= start ? n + 1 : n), 0);
}

export function hourLabel(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}
export function dayLabel(d: number): string { return WD_FULL[d] ?? ''; }

export async function fetchCreatorAnalytics(userId: string): Promise<CreatorAnalytics> {
  const sinceIso = new Date(Date.now() - 365 * 86_400_000).toISOString();

  const [postsRes, followersRes, followingRes] = await Promise.all([
    supabase
      .from('posts')
      .select('id, type, caption, created_at, view_count, stream_count, save_count, share_count, cover_url, thumbnail_url, media_url, likes(count), comments(count)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase.from('follows').select('created_at').eq('following_id', userId).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(5000),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
  ]);

  const posts = (postsRes.data ?? []) as any[];
  const followerRows = followersRes.data ?? [];

  // Total followers (head count — full lifetime, not just the windowed rows above).
  const { count: followerTotal } = await supabase
    .from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId);

  // Per-post engagement from the embedded counts.
  let likes = 0, comments = 0, saves = 0, shares = 0, views = 0;
  const enriched = posts.map((p) => {
    const l = p.likes?.[0]?.count || 0;
    const c = p.comments?.[0]?.count || 0;
    const s = p.save_count || 0;
    const v = (p.view_count || 0) + (p.stream_count || 0);
    likes += l; comments += c; saves += s; shares += p.share_count || 0; views += v;
    return {
      id: p.id, type: p.type, caption: p.caption || '', created_at: p.created_at,
      thumb: p.cover_url ?? p.thumbnail_url ?? (p.type === 'image' ? p.media_url : null),
      likes: l, comments: c, saves: s, views: v, engagement: l + c + s,
    } as TopPost;
  });

  const totals: Totals = {
    followers: followerTotal ?? 0,
    following: followingRes.count ?? 0,
    posts: posts.length,
    likes, comments, saves, shares, views,
  };

  // Engagement-event timestamps (recent year, capped) for the time charts + timing.
  // Cap the post-id list so the `in()` URL stays a sane length on prolific accounts.
  const recentPostIds = posts.slice(0, 150).map((p) => p.id);
  let likeTs: number[] = [], commentTs: number[] = [];
  if (recentPostIds.length) {
    const [likeRows, commentRows] = await Promise.all([
      supabase.from('likes').select('created_at').in('post_id', recentPostIds).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(5000),
      supabase.from('comments').select('created_at').in('post_id', recentPostIds).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(3000),
    ]);
    likeTs = (likeRows.data ?? []).map((r: any) => new Date(r.created_at).getTime());
    commentTs = (commentRows.data ?? []).map((r: any) => new Date(r.created_at).getTime());
  }
  const engagementTs = [...likeTs, ...commentTs];
  const followerTs = followerRows.map((r: any) => new Date(r.created_at).getTime());

  // When is the audience most active?
  const byHour = new Array(24).fill(0);
  const byDay = new Array(7).fill(0);
  for (const t of engagementTs) {
    const d = new Date(t);
    byHour[d.getHours()] += 1;
    byDay[d.getDay()] += 1;
  }
  const peakHour = engagementTs.length ? byHour.indexOf(Math.max(...byHour)) : null;
  const peakDay = engagementTs.length ? byDay.indexOf(Math.max(...byDay)) : null;

  // Content mix + which format performs best.
  const mixMap = new Map<string, { count: number; engagement: number }>();
  for (const p of enriched) {
    const m = mixMap.get(p.type) ?? { count: 0, engagement: 0 };
    m.count += 1; m.engagement += p.engagement;
    mixMap.set(p.type, m);
  }
  const contentMix: ContentTypeStat[] = Array.from(mixMap.entries())
    .map(([type, m]) => ({ type, count: m.count, engagement: m.engagement, avgEngagement: m.count ? m.engagement / m.count : 0 }))
    .sort((a, b) => b.count - a.count);

  const topPosts = [...enriched].sort((a, b) => b.engagement - a.engagement).slice(0, 5);
  const engagementRate = posts.length ? (likes + comments + saves) / posts.length : 0;

  return {
    totals, engagementRate, followerTs, engagementTs,
    byHour, byDay, peakHour, peakDay, contentMix, topPosts,
  };
}

// ── Per-post analytics (TikTok-style "Video analysis", but only from REAL data) ──
// Reached from the post's 3-dot menu, owner-only. Everything here is a genuine
// count or a genuine event timeline — no fabricated demographics, retention,
// geography or traffic sources, none of which the app collects.

export type SeriesPoint = { label: string; value: number };
export type SeriesUnit = 'hour' | 'day' | 'week';

export type PostAnalytics = {
  id: string;
  type: string;
  caption: string;
  thumb: string | null;
  createdAt: string;
  durationSec: number | null;
  isOwner: boolean;
  // Raw counts.
  views: number;   // video/photo views
  plays: number;   // audio plays (stream_count)
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  reach: number;   // views + plays — the closest thing to "how many saw it"
  engagements: number;   // likes + comments + saves + shares
  engagementRate: number; // engagements / reach, as a percentage
  // Views + plays over time, from the owner-gated RPC (continuous, zero-filled).
  series: SeriesPoint[];
  seriesUnit: SeriesUnit;
  seriesTotal: number;
  // Likes + comments over time (public data), same axis.
  engagementSeries: SeriesPoint[];
  // How this post sits among the creator's own posts.
  vsAverage: number | null;  // engagements ÷ their average post (e.g. 1.4×)
  percentile: number | null; // 0..100, higher is better
  rank: number | null;       // 1 = best
  totalPosts: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Truncate a timestamp to the start of its bucket, in UTC — matching Postgres
// date_trunc(), which runs in the database's UTC session. If the client bucketed
// in local time the keys wouldn't line up with the RPC's and counts would land
// in the wrong bar.
function utcTrunc(ms: number, unit: SeriesUnit): number {
  const d = new Date(ms);
  if (unit === 'hour') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (unit === 'day') return midnight;
  // week: Postgres date_trunc('week') is the Monday. getUTCDay(): 0=Sun.
  const backToMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - backToMonday * DAY_MS;
}
function stepMs(unit: SeriesUnit): number {
  return unit === 'hour' ? HOUR_MS : unit === 'day' ? DAY_MS : WEEK_MS;
}
// The continuous bucket axis from the post's creation to now (capped so a very
// old post can't produce a runaway array).
function axisFor(createdMs: number, unit: SeriesUnit): number[] {
  const start = utcTrunc(createdMs, unit);
  const end = utcTrunc(Date.now(), unit);
  const step = stepMs(unit);
  const out: number[] = [];
  for (let t = start; t <= end && out.length < 400; t += step) out.push(t);
  return out.length ? out : [start];
}
function labelFor(bucketMs: number, firstMs: number, unit: SeriesUnit): string {
  if (unit === 'hour') return `${Math.round((bucketMs - firstMs) / HOUR_MS)}h`;
  const d = new Date(bucketMs);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
// Pick a bucket size from the post's age: fresh posts read best by the hour, and
// older ones would be an unreadable forest of hourly bars.
function unitForAge(createdMs: number): SeriesUnit {
  const days = (Date.now() - createdMs) / DAY_MS;
  return days < 2 ? 'hour' : days <= 90 ? 'day' : 'week';
}

export async function fetchPostAnalytics(postId: string): Promise<PostAnalytics | null> {
  const { data: { user } } = await supabase.auth.getUser();
  const uid = user?.id ?? null;

  const { data: post } = await supabase
    .from('posts')
    .select('id, user_id, type, caption, created_at, view_count, stream_count, save_count, share_count, duration_seconds, cover_url, thumbnail_url, media_url, likes(count), comments(count)')
    .eq('id', postId)
    .maybeSingle();
  if (!post) return null;
  const p = post as any;
  const isOwner = !!uid && p.user_id === uid;

  const likes = p.likes?.[0]?.count || 0;
  const comments = p.comments?.[0]?.count || 0;
  const saves = p.save_count || 0;
  const shares = p.share_count || 0;
  const views = p.view_count || 0;
  const plays = p.stream_count || 0;
  const reach = views + plays;
  const engagements = likes + comments + saves + shares;
  const engagementRate = reach > 0 ? (engagements / reach) * 100 : 0;

  const createdMs = new Date(p.created_at).getTime();
  const unit = unitForAge(createdMs);

  // Views/plays over time come from the owner-gated RPC (the raw rows are not
  // client-readable). Likes/comments over time are public and read directly.
  const [seriesRes, likeRows, commentRows] = await Promise.all([
    isOwner
      ? supabase.rpc('post_view_series', { p_post_id: postId, p_unit: unit })
      : Promise.resolve({ data: [] as any[] }),
    supabase.from('likes').select('created_at').eq('post_id', postId).order('created_at', { ascending: true }).limit(5000),
    supabase.from('comments').select('created_at').eq('post_id', postId).order('created_at', { ascending: true }).limit(3000),
  ]);

  const axis = axisFor(createdMs, unit);
  const first = axis[0];

  const rpcRows = ((seriesRes as any).data ?? []) as { bucket: string; views: number; plays: number }[];
  const reachByBucket = new Map<number, number>();
  for (const r of rpcRows) {
    const ms = new Date(r.bucket).getTime();
    reachByBucket.set(ms, (reachByBucket.get(ms) || 0) + (r.views || 0) + (r.plays || 0));
  }
  let seriesTotal = 0;
  const series: SeriesPoint[] = axis.map((ms) => {
    const v = reachByBucket.get(ms) || 0;
    seriesTotal += v;
    return { label: labelFor(ms, first, unit), value: v };
  });

  const engByBucket = new Map<number, number>();
  for (const row of [...(likeRows.data ?? []), ...(commentRows.data ?? [])] as any[]) {
    const ms = utcTrunc(new Date(row.created_at).getTime(), unit);
    engByBucket.set(ms, (engByBucket.get(ms) || 0) + 1);
  }
  const engagementSeries: SeriesPoint[] = axis.map((ms) => ({
    label: labelFor(ms, first, unit),
    value: engByBucket.get(ms) || 0,
  }));

  // Where this post ranks among the creator's own posts (engagement).
  let vsAverage: number | null = null, percentile: number | null = null, rank: number | null = null, totalPosts = 0;
  if (isOwner && uid) {
    const { data: mine } = await supabase
      .from('posts')
      .select('id, save_count, share_count, likes(count), comments(count)')
      .eq('user_id', uid)
      .limit(1000);
    const rows = (mine ?? []) as any[];
    totalPosts = rows.length;
    if (totalPosts > 1) {
      const engOf = (r: any) => (r.likes?.[0]?.count || 0) + (r.comments?.[0]?.count || 0) + (r.save_count || 0) + (r.share_count || 0);
      const engs = rows.map(engOf);
      const avg = engs.reduce((a, b) => a + b, 0) / totalPosts;
      vsAverage = avg > 0 ? engagements / avg : null;
      const higher = engs.filter((e) => e > engagements).length;
      rank = higher + 1;
      percentile = Math.round(((totalPosts - rank) / (totalPosts - 1)) * 100);
    }
  }

  return {
    id: p.id,
    type: p.type,
    caption: p.caption || '',
    thumb: p.cover_url ?? p.thumbnail_url ?? (p.type === 'image' ? p.media_url : null),
    createdAt: p.created_at,
    durationSec: p.duration_seconds ?? null,
    isOwner,
    views, plays, likes, comments, saves, shares, reach, engagements, engagementRate,
    series, seriesUnit: unit, seriesTotal, engagementSeries,
    vsAverage, percentile, rank, totalPosts,
  };
}
