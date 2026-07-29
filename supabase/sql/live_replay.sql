-- Livestream replay retention — opt-in, with a recorded attestation.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires live_features.sql (public.live_streams).
--
-- WHY THIS EXISTS
-- Broadcasting music live is a PUBLIC PERFORMANCE, which the BMI Digital
-- Multi-Use licence covers. Saving that broadcast is a REPRODUCTION — a new
-- fixation — and BMI §3.B is explicit that the agreement grants "only public
-- performing rights in musical works... and does not grant any reproduction,
-- distribution, or any other intellectual property right(s)". No performing-rights
-- licence covers it, from any PRO, ever.
--
-- So a live broadcast sits inside Laybell's licences and a saved replay of the
-- same broadcast sits outside them. Retention therefore has to be a deliberate
-- choice by the host, recorded, rather than a platform default.
--
-- Twitch is the cautionary version: PRO agreements, no reproduction rights, VODs
-- retained by default — then mass DMCA notices from 2020 and thousands of videos
-- removed with almost no warning to the creators who made them.

alter table public.live_streams
  -- Off by default, deliberately. Cloudflare recording is set from this at input
  -- creation time (supabase/functions/live-input).
  add column if not exists save_replay boolean not null default false,
  -- The host's attestation, captured at the moment they opted in. What makes this
  -- worth storing is that it converts "the platform kept a recording" into "the
  -- broadcaster asked us to keep it and confirmed they had the rights" — which is
  -- the difference between Laybell's exposure and the host's.
  add column if not exists replay_attested_at timestamptz;

-- Turning replay on is a rights declaration, not a preference, so it goes through
-- a function that records the attestation rather than a bare column update. Only
-- meaningful before the broadcast starts: Cloudflare's recording mode is fixed at
-- input creation, so flipping this mid-stream would change the record without
-- changing what is actually being recorded.
create or replace function public.set_live_replay(p_stream_id uuid, p_save boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.live_streams
     where id = p_stream_id and user_id = auth.uid()
  ) then
    raise exception 'not_owner';
  end if;

  update public.live_streams
     set save_replay = p_save,
         replay_attested_at = case when p_save then now() else null end
   where id = p_stream_id;
end $$;

grant execute on function public.set_live_replay(uuid, boolean) to authenticated;


-- Existing rows predate the toggle and were recorded automatically under the old
-- default. Mark them explicitly rather than leaving the new column's `false` to
-- imply a choice nobody made — these recordings exist, and the record should say
-- so honestly.
update public.live_streams
   set save_replay = true
 where mode = 'rtmp' and replay_attested_at is null and created_at < now();

-- ⚠️ Those pre-existing recordings sit outside every licence Laybell holds, for
-- the reason at the top of this file. Review and delete them:
--
--   select id, title, user_id, created_at from public.live_streams
--    where mode = 'rtmp' and replay_attested_at is null
--    order by created_at desc;
--
-- Cloudflare stores each one as a Stream video with `liveInput` set. Note that
-- scripts/stream-sweep.mjs deliberately SKIPS those, so it will not remove them —
-- delete them from the Cloudflare dashboard, or extend the sweeper if this becomes
-- routine.
