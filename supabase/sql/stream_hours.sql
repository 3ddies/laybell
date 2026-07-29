-- Aggregate Stream Hours meter — BMI licence compliance.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- The BMI Digital Multi-Use Performance License (§8) TERMINATES AUTOMATICALLY if
-- the service exceeds its tier ceiling by 20%. Tier 1 ($385) allows:
--
--     $18,500 gross revenue        59,000 aggregate stream hours
--     ── auto-termination at ──
--     $22,200                      70,800 hours
--
-- Nobody sends a warning. The licence just ends, and every subsequent performance
-- of a BMI work is unlicensed. §8 also puts an affirmative duty on Laybell to tell
-- BMI *before* crossing. So this has to be measured, not estimated.
--
-- WHY NOT REUSE public.streams
-- That table is a CREATOR-CREDIT ledger, not a transmission log. It deliberately
-- caps and dedupes: a creator streaming their own track earns exactly one stream
-- ever, repeat plays inside a 24h window are collapsed, and a play only counts
-- after crossing a duration threshold. Every one of those rules makes it
-- UNDER-count what BMI measures — and under-counting is the direction that ends
-- with a terminated licence and no warning.
--
-- BMI's definition (Agreement §2.A): "the total number of hours of LICENSEE's
-- Service that LICENSEE has transmitted... to all consumers within the Territory."
-- Transmission. Uncapped. Regardless of who was listening or how often.
--
-- WHAT THIS STORES
-- One row per day with two counters. No user ids, no post ids, nothing personal —
-- an aggregate is all the licence needs, so an aggregate is all that is kept.

create table if not exists public.stream_hours_daily (
  day           date primary key default current_date,
  -- Music playback through the audio player.
  audio_seconds bigint not null default 0,
  -- Video playback (reels, feed). Video carrying music is arguably also a
  -- performance under §2.F, which defines the Service by delivery channel rather
  -- than by audio vs video. Counted separately so both a conservative figure
  -- (audio + video) and a narrow one (audio only) are available on demand.
  video_seconds bigint not null default 0,
  updated_at    timestamptz not null default now()
);

alter table public.stream_hours_daily enable row level security;
-- No policies at all: clients write only through the SECURITY DEFINER function
-- below, and only the dashboard/service role reads. Nothing here is per-user, so
-- there is nothing a user would need to see.


-- ─── Recording ──────────────────────────────────────────────────────────────
-- Called periodically by the app with accumulated listening time. Idempotent by
-- addition rather than by key: every call adds to today's running total.
create or replace function public.record_listen_seconds(
  p_seconds int,
  p_kind    text default 'audio'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secs int;
begin
  if auth.uid() is null then return; end if;
  if p_seconds is null or p_seconds <= 0 then return; end if;

  -- Sanity cap per call. The client batches roughly once a minute, so anything
  -- past an hour is a bug or an attempt to inflate the figure. Note the failure
  -- direction: an inflated meter makes Laybell upgrade tier EARLY, which is
  -- harmless. A suppressed meter is what gets the licence terminated — so the cap
  -- is generous rather than tight.
  v_secs := least(p_seconds, 3600);

  insert into public.stream_hours_daily (day, audio_seconds, video_seconds, updated_at)
  values (
    current_date,
    case when p_kind = 'video' then 0 else v_secs end,
    case when p_kind = 'video' then v_secs else 0 end,
    now()
  )
  on conflict (day) do update set
    audio_seconds = public.stream_hours_daily.audio_seconds
                    + case when p_kind = 'video' then 0 else v_secs end,
    video_seconds = public.stream_hours_daily.video_seconds
                    + case when p_kind = 'video' then v_secs else 0 end,
    updated_at    = now();
end $$;

grant execute on function public.record_listen_seconds(int, text) to authenticated;


-- ─── Reporting ──────────────────────────────────────────────────────────────
-- Where Laybell stands against the BMI ceiling. Pass the licence term dates from
-- the signature page.
--
--   select * from public.bmi_license_usage('2026-07-28', '2027-07-27');
--
-- `audio_hours`      — the narrow reading (music playback only)
-- `total_hours`      — the conservative reading (audio + video)
-- `pct_of_ceiling`   — total against the tier's 59,000-hour limit
-- `hours_remaining`  — until the 20% auto-termination line at 70,800
-- `status`           — plain-English verdict
create or replace function public.bmi_license_usage(
  p_start date,
  p_end   date,
  p_tier_hours bigint default 59000
)
returns table (
  audio_hours     numeric,
  video_hours     numeric,
  total_hours     numeric,
  pct_of_ceiling  numeric,
  hours_remaining numeric,
  status          text
)
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select
      round(coalesce(sum(audio_seconds), 0) / 3600.0, 1) as a,
      round(coalesce(sum(video_seconds), 0) / 3600.0, 1) as v
    from public.stream_hours_daily
    where day >= p_start and day <= p_end
  )
  select
    t.a,
    t.v,
    t.a + t.v,
    round(((t.a + t.v) / nullif(p_tier_hours, 0)) * 100, 1),
    round((p_tier_hours * 1.2) - (t.a + t.v), 1),
    case
      when (t.a + t.v) >= p_tier_hours * 1.2
        then 'TERMINATED — over the 20% line. The licence has auto-ended (§8).'
      when (t.a + t.v) >= p_tier_hours
        then 'OVER TIER — notify BMI now and move up a tier (§8 duty to inform).'
      when (t.a + t.v) >= p_tier_hours * 0.8
        then 'APPROACHING — past 80%. Plan the tier upgrade.'
      when (t.a + t.v) >= p_tier_hours * 0.5
        then 'HALFWAY — monitor monthly.'
      else 'OK'
    end
  from t;
$$;

-- Owner/dashboard only. Postgres grants EXECUTE to PUBLIC by default, and this
-- exposes commercially sensitive usage totals.
revoke all on function public.bmi_license_usage(date, date, bigint) from public;
revoke all on function public.bmi_license_usage(date, date, bigint) from authenticated;


-- ─── Use it ─────────────────────────────────────────────────────────────────
-- CHECK THIS MONTHLY. Substitute your actual licence Start and End dates:
--
--   select * from public.bmi_license_usage('2026-07-28', '2027-07-27');
--
-- Raw daily figures, for spotting a growth curve before it becomes a problem:
--
--   select day,
--          round(audio_seconds/3600.0, 2) as audio_hours,
--          round(video_seconds/3600.0, 2) as video_hours
--     from public.stream_hours_daily
--    order by day desc limit 60;
--
-- Tier ceilings, for deciding what to renew or upgrade into:
--   Tier 1  $385    $18,500 revenue    59,000 hours
--   Tier 2  $770    $37,000 revenue   118,000 hours
--   Tier 3  $1,540  $74,000 revenue   236,000 hours
