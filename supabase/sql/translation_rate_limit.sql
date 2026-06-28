-- ─────────────────────────────────────────────────────────────────────────────
-- Translation spend guardrail (run once in the Supabase SQL editor)
-- ─────────────────────────────────────────────────────────────────────────────
-- Caps how many characters the `translate` Edge Function will send to the paid
-- provider (Google), so a single user spamming translations — or aggregate
-- traffic early in the app's life — can't run up a surprise bill. Cost math:
-- Google Cloud Translation v2 bills ~$20 per 1,000,000 characters
-- (= $0.00002/char), so 500,000 chars ≈ $10.
--
-- Two layers, both enforced server-side (the client cache can be bypassed by
-- calling the function directly, so the limit lives here, not in the app):
--   • per-user  — a rolling window (launch default 250k chars / 48h ≈ $5 per user)
--   • global    — a daily backstop across ALL users (launch default 1M chars / day ≈ $20)
-- The actual numbers are passed in by the Edge Function (env-configurable); the
-- tables/function here just track usage and decide allow/deny atomically.
--
-- Idempotent: safe to re-run.

-- Per-user usage, one row per user, a single rolling window that resets
-- window_hours after it started (from the user's first request in the window).
create table if not exists public.translation_usage (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null default now(),
  chars        bigint      not null default 0
);

-- Global usage, one row per UTC day (auto-resets at midnight UTC).
create table if not exists public.translation_usage_global (
  bucket date primary key,
  chars  bigint not null default 0
);

-- Locked down: only the SECURITY DEFINER function below (called by the Edge
-- Function via the service role) ever touches these. No user-facing policies, so
-- a user can't read or reset their own counter.
alter table public.translation_usage        enable row level security;
alter table public.translation_usage_global enable row level security;

-- Atomically: check the per-user rolling window AND the global daily cap, and —
-- only if BOTH allow it — add p_chars to each. Returns the decision so the Edge
-- Function can translate or return a 429. Passing a cap of 0 disables that layer.
create or replace function public.record_translation_usage(
  p_user_id      uuid,
  p_chars        int,
  p_user_cap     bigint,
  p_window_hours int,
  p_global_cap   bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now         timestamptz := now();
  v_today       date        := (now() at time zone 'utc')::date;
  v_user_used   bigint := 0;
  v_user_start  timestamptz := v_now;
  v_global_used bigint := 0;
  v_allowed     boolean := true;
  v_reason      text := null;
begin
  if p_chars is null or p_chars <= 0 then
    return jsonb_build_object('allowed', true, 'reason', null);
  end if;

  -- Global daily backstop (lock first, always the same order → no deadlock).
  if p_global_cap > 0 then
    insert into translation_usage_global (bucket, chars) values (v_today, 0)
      on conflict (bucket) do nothing;
    select chars into v_global_used from translation_usage_global where bucket = v_today for update;
    if v_global_used + p_chars > p_global_cap then
      v_allowed := false; v_reason := 'global';
    end if;
  end if;

  -- Per-user rolling window.
  if v_allowed and p_user_id is not null and p_user_cap > 0 then
    insert into translation_usage (user_id, window_start, chars) values (p_user_id, v_now, 0)
      on conflict (user_id) do nothing;
    select chars, window_start into v_user_used, v_user_start
      from translation_usage where user_id = p_user_id for update;
    -- Expire and reset the window if it has elapsed.
    if v_user_start + make_interval(hours => p_window_hours) <= v_now then
      v_user_used := 0; v_user_start := v_now;
      update translation_usage set window_start = v_now, chars = 0 where user_id = p_user_id;
    end if;
    if v_user_used + p_chars > p_user_cap then
      v_allowed := false; v_reason := 'user';
    end if;
  end if;

  -- Record the spend only when it's actually going through (a blocked request
  -- costs nothing, so it must not count toward the cap).
  if v_allowed then
    if p_global_cap > 0 then
      update translation_usage_global set chars = chars + p_chars where bucket = v_today;
    end if;
    if p_user_id is not null and p_user_cap > 0 then
      update translation_usage set chars = chars + p_chars where user_id = p_user_id;
    end if;
  end if;

  return jsonb_build_object(
    'allowed',       v_allowed,
    'reason',        v_reason,
    'user_used',     v_user_used,
    'user_cap',      p_user_cap,
    'user_reset_at', v_user_start + make_interval(hours => p_window_hours),
    'global_used',   v_global_used,
    'global_cap',    p_global_cap
  );
end;
$$;

-- Only the Edge Function (service role) may call this. Crucially this stops a
-- signed-in user from calling it directly with someone else's p_user_id to grief
-- their counter, or with their own to probe the limits.
revoke all on function public.record_translation_usage(uuid, int, bigint, int, bigint) from public, anon, authenticated;
grant execute on function public.record_translation_usage(uuid, int, bigint, int, bigint) to service_role;
