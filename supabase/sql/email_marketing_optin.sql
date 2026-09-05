-- Laybell's email list: a per-account marketing opt-in.
--
--   npx supabase db query --linked -f supabase/sql/email_marketing_optin.sql
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE DEFAULT IS TRUE, AND WHERE THAT STOPS BEING TRUE
--
-- Laybell is United States only (App Store and Play are both set to US), and
-- US commercial email is governed by CAN-SPAM, which is an OPT-OUT regime: prior
-- consent is not required. What IS required is an accurate sender, a physical
-- postal address in every message, and a working unsubscribe honoured promptly.
-- A pre-ticked box is lawful here.
--
-- ⚠️ IT IS NOT LAWFUL EVERYWHERE, and the day Laybell opens another country this
-- has to change rather than be discovered. Under GDPR (EU/EEA/UK) a pre-ticked
-- box is expressly NOT consent — the CJEU settled that in Planet49 — and Canada's
-- CASL wants express consent too. Both need this defaulting to FALSE and the
-- box unticked. The column carries the timestamp precisely so that switch can be
-- made without losing who agreed when.
--
-- MINORS DEFAULT TO FALSE regardless. 13-17s are on Laybell with parental
-- consent, age is captured at onboarding rather than signup, and marketing mail
-- to a fifteen-year-old is a fight nobody needs. The app turns this off the
-- moment a date of birth says minor; see lib/minors.ts and app/onboarding.tsx.

-- 1) The columns ─────────────────────────────────────────────────────────────
-- opted_at is null for an account that never made a choice (a social sign-in,
-- which never sees the signup screen, takes the default). That distinction is
-- the record of HOW consent arrived, and it is the thing a regulator asks for.
alter table public.profiles
  add column if not exists marketing_opt_in    boolean not null default true;
alter table public.profiles
  add column if not exists marketing_opt_in_at timestamptz;

comment on column public.profiles.marketing_opt_in is
  'Receives Laybell marketing email. Default true under CAN-SPAM (US-only). MUST default false if Laybell ships to the EU/UK/Canada.';
comment on column public.profiles.marketing_opt_in_at is
  'When the account explicitly chose. Null = took the default (social sign-in never sees the checkbox).';

-- 2) Honour the signup checkbox ──────────────────────────────────────────────
-- The signup screen passes marketing_opt_in in options.data, which lands in
-- raw_user_meta_data. Absent (social sign-in) falls back to the column default.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base text;
  uname text;
  dname text;
  n int := 0;
  want_mail boolean;
begin
  dname := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Artist'
  );

  base := lower(coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'artist'
  ));
  base := regexp_replace(base, '[^a-z0-9_]', '', 'g');
  if length(base) < 5 then
    base := rpad(base || 'artist', 5, '0');
  end if;
  base := left(base, 24);

  uname := base;
  while exists (select 1 from public.profiles where username = uname) and n < 20 loop
    n := n + 1;
    uname := left(base, 24) || (1000 + floor(random() * 9000))::int;
  end loop;

  -- Explicit choice from the signup screen, or null when there was no screen.
  begin
    want_mail := (new.raw_user_meta_data->>'marketing_opt_in')::boolean;
  exception when others then
    want_mail := null;
  end;

  begin
    insert into public.profiles (id, username, display_name, onboarded, marketing_opt_in, marketing_opt_in_at)
    values (
      new.id, uname, left(dname, 40), false,
      coalesce(want_mail, true),
      case when want_mail is null then null else now() end
    )
    on conflict (id) do nothing;
  exception when others then
    -- NEVER block account creation over the profile row — the app rebuilds a
    -- missing row on first login.
    raise warning 'handle_new_user: profile insert failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- 3) The list itself ─────────────────────────────────────────────────────────
-- Everyone currently mailable, for the sender to read. A VIEW rather than a
-- query someone retypes: the eligibility rules live in one place, so nobody
-- emails a suspended account or a minor by writing a slightly different WHERE.
create or replace view public.marketing_email_list as
select
  p.id,
  u.email,
  p.username,
  p.display_name,
  p.marketing_opt_in_at
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.marketing_opt_in = true
   and coalesce(p.hidden, false) = false
   and u.email is not null
   and u.email_confirmed_at is not null;   -- never mail an unverified address

comment on view public.marketing_email_list is
  'Mailable accounts. Excludes opt-outs, hidden accounts and unconfirmed addresses. Minors are excluded by their opt_in being set false at onboarding.';

-- The view reads auth.users, so it must not be reachable with the anon key.
revoke all on public.marketing_email_list from anon, authenticated;

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from public.profiles where marketing_opt_in)        as opted_in,
  (select count(*) from public.profiles where not marketing_opt_in)    as opted_out,
  (select count(*) from public.marketing_email_list)                   as mailable_now;
