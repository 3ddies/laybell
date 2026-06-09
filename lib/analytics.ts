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
