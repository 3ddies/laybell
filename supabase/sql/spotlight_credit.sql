-- Premium perk: one FREE 1-day Spotlight per calendar month.
-- Run in the Supabase Dashboard → SQL Editor (after premium.sql + spotlight.sql).
--
-- Model: a single column records the month (YYYY-MM) in which the user last
-- claimed their free Spotlight. Eligible = Premium AND that month isn't the
-- current one. This makes "resets monthly" and "expires if unused" automatic —
-- each month is independent, an unused credit simply doesn't carry over.
--
-- The claim is an ATOMIC security-definer RPC so the credit can't be double-spent
-- by racing, and it mints a real 1-day Spotlight (price 0) attached to the chosen
-- post. Degrades gracefully: without this applied, lib/spotlight's free helpers
-- report "unavailable" and the paid flow is unchanged.

do $$
begin
  if not exists (select 1 from information_schema.routines
                 where routine_schema = 'public' and routine_name = 'is_premium') then
    raise exception 'Run premium.sql before spotlight_credit.sql (public.is_premium is missing).';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'ad_campaigns') then
    raise exception 'Run spotlight.sql before spotlight_credit.sql (public.ad_campaigns is missing).';
  end if;
end $$;

alter table public.profiles
  add column if not exists spotlight_credit_used_month text;  -- 'YYYY-MM' of last free claim

-- Guard: a normal client UPDATE can't touch spotlight_credit_used_month (that
-- would let anyone refresh their own free credit). Only the claim RPC may — it
-- sets app.claiming_spotlight for its transaction, which this trigger honors.
create or replace function public.protect_spotlight_credit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.spotlight_credit_used_month is distinct from old.spotlight_credit_used_month
     and coalesce(current_setting('app.claiming_spotlight', true), '') <> '1' then
    new.spotlight_credit_used_month := old.spotlight_credit_used_month;
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_spotlight_credit on public.profiles;
create trigger profiles_protect_spotlight_credit
  before update on public.profiles
  for each row execute function public.protect_spotlight_credit();

-- Claim the free monthly Spotlight for one of the caller's public posts. Atomic:
-- locks the profile row, checks Premium + not-already-claimed-this-month, mints an
-- active 1-day (price 0) Spotlight, and stamps the month. Returns the campaign id.
create or replace function public.claim_free_spotlight(p_post_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_month text := to_char(now(), 'YYYY-MM');
  v_used  text;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  if not public.is_premium(v_uid) then raise exception 'not_premium'; end if;

  select spotlight_credit_used_month into v_used
    from public.profiles where id = v_uid for update;
  if v_used = v_month then raise exception 'already_claimed'; end if;

  if not exists (
    select 1 from public.posts
     where id = p_post_id and user_id = v_uid and is_public = true
  ) then
    raise exception 'invalid_post';
  end if;

  insert into public.ad_campaigns
    (user_id, post_id, package_key, duration_days, price_cents, weight, status, starts_at, ends_at)
  values
    (v_uid, p_post_id, '1d', 1, 0, 2, 'active', now(), now() + interval '1 day')
  returning id into v_id;

  perform set_config('app.claiming_spotlight', '1', true);
  update public.profiles set spotlight_credit_used_month = v_month where id = v_uid;

  return v_id;
end; $$;
grant execute on function public.claim_free_spotlight(uuid) to authenticated;
