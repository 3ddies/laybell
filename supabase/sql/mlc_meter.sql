-- Mechanical-licensing decision meter.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell does not hold a blanket mechanical licence from the Mechanical
-- Licensing Collective. It operates on a direct-licence posture: every recording
-- is uploaded by a user who warrants under Terms §7 that they control the
-- composition, the master, the samples and the performances. That is the same
-- posture SoundCloud and Bandcamp launched on, and it is defensible for a
-- user-generated-content service that licenses no commercial catalogue.
--
-- It stops being defensible at scale, and the cost of being wrong is a cliff
-- rather than a slope. The MLC's administrative assessment is tiered by the
-- number of unique sound recordings a service makes available per month, and
-- the jump between tiers is roughly 24x:
--
--     under ~10,000/month     ~$2,500/year
--     above ~25,000/month    ~$60,000/year
--
-- So this is NOT a compliance meter like stream_hours.sql — nothing
-- auto-terminates, no notice is owed to anyone. It is a DECISION TRIGGER. It
-- answers one question: "is Laybell still small enough for the direct-licence
-- posture to be the obviously correct call?" Crossing 10,000 is the signal to
-- get an actual lawyer on the question while the answer is still cheap.
--
-- ⚠️ VERIFY THE THRESHOLDS before acting on them. The assessment is set by
-- Copyright Royalty Board determination and is periodically revised. The two
-- numbers above were researched on 2026-07-28 and are wired in as DEFAULTS you
-- pass over, not as constants — see the p_small_tier / p_large_tier arguments.
--
-- WHAT COUNTS AS A "SOUND RECORDING" HERE
-- Musical works only. Podcasts and audiobooks are spoken word, not musical
-- compositions, and carry no mechanical-licensing exposure — so `type = 'audio'`
-- and nothing else. Counting them would inflate the figure and could push a
-- premature and expensive decision.


-- ─── Reporting ──────────────────────────────────────────────────────────────
-- Two readings of the same month, for the same reason stream_hours.sql gives
-- two: one number alone invites you to believe it.
--
-- `recordings_streamed`  — distinct musical recordings that were actually played.
--                          The NARROW reading. Under-counts slightly: public.streams
--                          deduplicates (a listener replaying a track inside 24h
--                          adds no row), so a recording played only by people who
--                          had already heard it can be missed.
-- `recordings_available` — every public musical recording in the catalogue at
--                          month end. The CONSERVATIVE reading, and the closer
--                          match to "makes available", which is the language the
--                          assessment actually uses.
--
--   select * from public.mlc_usage('2026-07-01');
create or replace function public.mlc_usage(
  p_month        date,
  p_small_tier   bigint default 10000,
  p_large_tier   bigint default 25000
)
returns table (
  month                 date,
  recordings_streamed   bigint,
  recordings_available  bigint,
  pct_of_small_tier     numeric,
  status                text
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select date_trunc('month', p_month)::date                      as m_start,
           (date_trunc('month', p_month) + interval '1 month')::date as m_end
  ),
  streamed as (
    select count(distinct s.post_id) as n
      from public.streams s
      join public.posts p on p.id = s.post_id
     cross join bounds b
     where s.created_at >= b.m_start
       and s.created_at <  b.m_end
       and p.type = 'audio'
  ),
  available as (
    select count(*) as n
      from public.posts p
     cross join bounds b
     where p.type = 'audio'
       and p.is_public
       and p.archived_at is null
       and p.created_at < b.m_end
  )
  select
    b.m_start,
    streamed.n,
    available.n,
    round((greatest(streamed.n, available.n)::numeric / nullif(p_small_tier, 0)) * 100, 1),
    case
      when greatest(streamed.n, available.n) >= p_large_tier
        then 'ACT NOW — past the large-tier line. The assessment jump is roughly 24x. Get licensing counsel before the next reporting period.'
      when greatest(streamed.n, available.n) >= p_small_tier
        then 'REVIEW — past the small-tier line. Time to have the blanket-licence conversation with a lawyer while it is still cheap.'
      when greatest(streamed.n, available.n) >= p_small_tier * 0.5
        then 'WATCH — halfway. Check monthly from here.'
      else 'OK — direct-licence posture remains the obviously correct call.'
    end
  from bounds b, streamed, available;
$$;

-- Owner/dashboard only. Postgres grants EXECUTE to PUBLIC by default, and
-- catalogue size is commercially sensitive.
revoke all on function public.mlc_usage(date, bigint, bigint) from public;
revoke all on function public.mlc_usage(date, bigint, bigint) from authenticated;


-- ─── Trend ──────────────────────────────────────────────────────────────────
-- A single month tells you where you are; twelve tell you when you will arrive.
-- Growth is what matters here — the decision needs lead time, because finding
-- and briefing a lawyer is not a same-week activity.
--
--   select * from public.mlc_usage_trend(12);
create or replace function public.mlc_usage_trend(p_months int default 12)
returns table (
  month                 date,
  recordings_streamed   bigint,
  recordings_available  bigint,
  pct_of_small_tier     numeric,
  status                text
)
language sql
stable
security definer
set search_path = public
as $$
  select u.*
    from generate_series(
           date_trunc('month', current_date) - ((p_months - 1) || ' months')::interval,
           date_trunc('month', current_date),
           interval '1 month'
         ) as g(m)
   cross join lateral public.mlc_usage(g.m::date) as u
   order by u.month desc;
$$;

revoke all on function public.mlc_usage_trend(int) from public;
revoke all on function public.mlc_usage_trend(int) from authenticated;


-- ─── Use it ─────────────────────────────────────────────────────────────────
-- CHECK THIS QUARTERLY. It moves slower than the BMI meter and needs less
-- attention, but it needs more lead time when it does move.
--
--   select * from public.mlc_usage_trend(12);
--
-- If the trend line is heading for 10,000/month within two quarters, that is the
-- moment to act — not the moment you cross it.
--
-- FREE ROUTE TO ADVICE: Maryland Volunteer Lawyers for the Arts does pro bono
-- work for Maryland creatives. Mechanical licensing for a UGC platform is the
-- single most genuinely ambiguous legal question Laybell has, and it is the one
-- most worth spending a free consultation on.
--
-- See docs/LAUNCH_CHECKLIST.md and docs/PRO_LICENSING_PACK.md for the wider
-- licensing picture (BMI is metered separately by stream_hours.sql, and that one
-- IS a compliance meter — the licence auto-terminates).
