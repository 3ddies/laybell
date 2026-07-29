-- ═══════════════════════════════════════════════════════════════════════════
-- LAYBELL — PENDING SQL, 2026-07-29
--
-- Paste this whole file into the Supabase Dashboard -> SQL Editor and run once.
-- Every statement is idempotent (create or replace / if not exists), so a re-run
-- is safe and a partial failure can be fixed and re-run from the top.
--
-- WHY THIS FILE EXISTS
-- These six migrations were written and committed on 2026-07-28/29 but were never
-- added to any _RUN_* bundle, so none of them has been applied. Four of the six
-- back a promise already published in the Terms or a licence Laybell already
-- holds, which makes them the most expensive kind of gap: a written policy with
-- no implementation behind it.
--
-- ORDER MATTERS for #1 only. payouts.sql is ALREADY APPLIED and its
-- request_payout() reads profiles.stripe_account_id; plpgsql does not resolve
-- column references at CREATE time, so that function exists today and throws at
-- runtime. Until stripe_connect runs, every payout fails.
--
--   1. stripe_connect     profiles.stripe_account_id — payouts.sql already depends on it
--   2. access_log         server-captured IPs for NCMEC reports + Stripe chargeback evidence
--   3. copyright_strikes  DMCA notice-and-takedown + repeat-infringer termination (Terms §8)
--   4. sound_optin        "use this sound" per-track consent + withdrawal
--   5. live_replay        opt-in livestream replay retention (BMI grants no reproduction right)
--   6. stream_hours       aggregate stream-hours meter for the BMI Tier-1 ceiling
--
-- Prerequisites, all already applied: post_reports / moderation_preservation
-- (copyright_strikes), post_song (sound_optin), live_features (live_replay).
--
-- AFTER RUNNING, verify — each should return without error:
--   select stripe_account_id from public.profiles limit 1;   -- column exists
--   select count(*) from public.access_log;                  -- table exists
--   select count(*) from public.copyright_notices;           -- DMCA machinery
--   select count(*) from public.copyright_strikes;
--   select public.add_business_days(now(), 10);              -- counter-notice clock
--   select count(*) from public.stream_hours_daily;          -- BMI meter
--   select * from public.bmi_license_usage(                  -- headroom vs the Tier-1 ceiling
--     (current_date - interval '365 days')::date, current_date);
-- ═══════════════════════════════════════════════════════════════════════════



-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/stripe_connect.sql
-- profiles.stripe_account_id — payouts.sql already depends on it
-- ═══════════════════════════════════════════════════════════════════════════

-- Stripe Connect — creator payout accounts.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THE COLUMN IS ALL THERE IS
-- Creators are paid through Stripe Connect EXPRESS accounts. Stripe collects the
-- bank details, runs identity verification, and owns the payout rails. Laybell
-- stores one thing: the id of the creator's Stripe account. No bank numbers, no
-- routing numbers, no tax identifiers — all of that lives with Stripe, which is
-- both the point and the reason this migration is three lines.
--
-- The rule that shapes the whole design: creator funds must NEVER pass through a
-- Laybell-controlled bank account. Doing so is unlicensed money transmission
-- (18 U.S.C. §1960). Stripe holds and moves the money; Laybell instructs it.

alter table public.profiles
  -- Stripe's account id (acct_…). Written only by the stripe-connect Edge
  -- Function using the service role. Not secret — it identifies an account but
  -- grants no access to it — though there is no reason for other users to read it.
  add column if not exists stripe_account_id text;

-- Two creators must never share a Stripe account: a collision would pay one
-- person's earnings to another. Partial so the many nulls don't collide.
create unique index if not exists profiles_stripe_account_uniq
  on public.profiles (stripe_account_id) where stripe_account_id is not null;

-- No new RLS policy is needed. profiles already restricts writes to the owner,
-- and the Edge Function bypasses RLS with the service role. Deliberately NOT
-- granting the client write access: a user who could set their own
-- stripe_account_id could point their payouts at someone else's account.


-- Verify:
--   select id, username, stripe_account_id from public.profiles
--    where stripe_account_id is not null;
--
-- Payout readiness is NOT stored here. `payouts_enabled` lives on the Stripe
-- account and is read live via the stripe-connect function, because a cached
-- copy goes stale the moment Stripe finishes (or reverses) a verification — and
-- a stale "yes" means attempting a payout that fails at the transfer.


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/access_log.sql
-- server-captured IPs for NCMEC reports + Stripe chargeback evidence
-- ═══════════════════════════════════════════════════════════════════════════

-- Access log — server-captured IP addresses for evidence.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell logged no IP addresses anywhere. That was discovered while completing
-- the NCMEC ESP registration, and it costs twice over:
--
--   1. After the media itself, the originating IP is the field investigators most
--      want. Without it a CyberTipline report is materially less actionable.
--   2. It is the field that WINS card chargebacks. Stripe's dispute evidence has a
--      dedicated `access_activity_log` slot asking for "server or activity logs
--      showing proof that the customer accessed or downloaded the purchased
--      digital product after they made the payment... including IP addresses,
--      corresponding timestamps". On instantly-delivered beat files that is the
--      difference between winning and conceding. See LAUNCH_CHECKLIST §6.5.
--
-- WHY IT IS SERVER-SIDE ONLY
-- A client cannot be trusted to report its own address — self-reported evidence is
-- worth nothing in a dispute and worse than nothing in an investigation. Rows here
-- are written ONLY by the log-access Edge Function, which reads the address from
-- the request itself. No client can insert.
--
-- PRIVACY
-- An IP address is personal data. Collection is disclosed in the Privacy Policy,
-- collection is limited to a small set of security-and-evidence events (not
-- general analytics), and rows are pruned on a schedule — see the bottom.

create table if not exists public.access_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete set null,
  -- What happened: 'upload', 'post', 'report', 'shop_download', 'live_start'.
  event        text not null,
  -- What it was about, so the row can be joined to the thing it evidences.
  subject_type text,
  subject_id   text,
  ip           inet,
  -- WHICH HEADER the address came from, because they are not equally trustworthy.
  -- 'cf-connecting-ip' is written by Cloudflare and cannot be forged by the
  -- client. 'x-forwarded-for' CAN be, if a proxy fails to overwrite it. Recording
  -- the source makes the evidence self-describing instead of falsely uniform.
  ip_source    text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists access_log_subject_idx on public.access_log (subject_type, subject_id);
create index if not exists access_log_user_idx    on public.access_log (user_id, created_at desc);
create index if not exists access_log_created_idx on public.access_log (created_at);

alter table public.access_log enable row level security;

-- Users may READ their own rows — this is deliberate. State privacy laws give
-- people a right of access to their own data, and a log they cannot see is harder
-- to defend than one they can. They cannot write, edit, or delete it.
drop policy if exists "Users read their own access log" on public.access_log;
create policy "Users read their own access log"
  on public.access_log for select using (user_id = auth.uid());

-- No insert/update/delete policy for anyone. Writes come from the Edge Function
-- via the service role, which bypasses RLS.

-- Append-only, like the ledger. Evidence you can quietly edit is not evidence.
create or replace function public.access_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'access_log is append-only (attempted %)', tg_op;
end $$;

drop trigger if exists access_log_no_update on public.access_log;
create trigger access_log_no_update
  before update on public.access_log
  for each row execute function public.access_log_immutable();
-- NOTE: DELETE is intentionally NOT blocked, unlike the ledger — retention
-- pruning below has to be able to remove old rows. Keeping IP addresses forever
-- would itself be a privacy problem.


-- ─── Retention ──────────────────────────────────────────────────────────────
-- 13 months: comfortably past the ~120-day card-dispute window and past the
-- 1-year CSAM preservation duty (18 U.S.C. §2258A(h)), without keeping personal
-- data indefinitely. Run monthly from the dashboard or a scheduled function.
--
--   delete from public.access_log where created_at < now() - interval '13 months';
--
-- ⚠️ Before pruning, preserve anything tied to an open matter. Rows referenced by
-- a report under legal_hold must be exported first — the retention clock for
-- those is set by the investigation, not by this schedule.


-- ─── Chargeback export ──────────────────────────────────────────────────────
-- Everything Stripe asks for in `access_activity_log`, for one disputed order:
--
--   select l.created_at, l.ip, l.ip_source, l.user_agent,
--          d.file_path, o.price_cents, o.created_at as ordered_at
--     from public.access_log l
--     join public.shop_orders o on o.id::text = l.subject_id
--     left join public.shop_downloads d on d.order_id = o.id
--    where l.event = 'shop_download' and l.subject_id = '<order uuid>'
--    order by l.created_at;


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/copyright_strikes.sql
-- DMCA notice-and-takedown + repeat-infringer termination (Terms §8)
-- ═══════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- DMCA notice-and-takedown + repeat-infringer machinery.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- Laybell's published Terms §8 already promise all of this:
--
--   "We maintain internal records of takedown notices and account-level
--    infringement counts. A user who accumulates multiple separate instances of
--    infringing activity (for example, three or more) may have their account
--    terminated, and this policy applies regardless of whether the user submits
--    a counter-notification."
--
-- Until now none of it existed. A published policy with no implementation behind
-- it is worse than no policy: §512(i) requires the policy be "reasonably
-- implemented", and a plaintiff will read your own Terms back to you.
--
-- THE CASE LAW THIS IS BUILT AGAINST
--   BMG v. Cox (4th Cir. 2018) — safe harbour LOST. The policy existed on paper
--   but was not followed: inconsistent enforcement, no coherent criteria, and
--   high-value accounts spared. The manual override is what killed it. So there
--   is deliberately NO override here — termination fires from a trigger, and no
--   function accepts a "skip" argument.
--
--   Ventura Content v. Motherless (9th Cir. 2018) — safe harbour KEPT, by a
--   ONE-PERSON site with an unwritten policy. He won because he could prove he
--   had terminated 1,320–1,980 users with only nine slipping through. The lesson
--   is not "be informal", it is "be able to prove the numbers." Hence the
--   append-only log.
--
-- Requires: post_reports.sql / moderation_preservation.sql (legal_hold),
--           post_song.sql (posts.song_id, for the attributed-use cascade).
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 1) Notices ─────────────────────────────────────────────────────────────
-- Every element below maps to a numbered requirement in Terms §8 / §512(c)(3).
-- `valid` is what makes a notice count toward a strike: §512(c)(3)(B) says a
-- notice that fails to substantially comply does not establish knowledge, and the
-- published policy counts only "valid" notices.
create table if not exists public.copyright_notices (
  id                 uuid primary key default gen_random_uuid(),

  -- Claimant contact (Terms §8, element 3)
  claimant_name      text not null,
  claimant_email     text not null,
  claimant_phone     text,
  claimant_address   text,
  claimant_org       text,

  -- The work (element 1)
  work_description   text not null,
  work_url           text,

  -- The material complained of (element 2)
  target_type        text not null check (target_type in ('post', 'listing', 'comment', 'profile')),
  target_id          text not null,
  -- Resolved uploader. Kept as plain uuid with ON DELETE SET NULL rather than a
  -- cascade: the strike must survive the content being deleted, which is exactly
  -- how a repeat infringer would otherwise reset their own count.
  target_user_id     uuid references auth.users(id) on delete set null,

  -- The two required statements (elements 4 and 5) and signature (element 6)
  good_faith_belief  boolean not null default false,
  accuracy_perjury   boolean not null default false,
  signature          text not null,

  -- Does it substantially comply? Only a valid notice yields a strike.
  valid              boolean not null default false,
  invalid_reason     text,

  status             text not null default 'received'
                     check (status in ('received','actioned','rejected','withdrawn','restored')),
  received_at        timestamptz not null default now(),
  actioned_at        timestamptz,

  -- Evidence, captured at action time so it survives deletion of the content.
  content_snapshot   jsonb,
  notes              text
);

create index if not exists copyright_notices_user_idx   on public.copyright_notices (target_user_id, received_at desc);
create index if not exists copyright_notices_target_idx on public.copyright_notices (target_type, target_id);
create index if not exists copyright_notices_status_idx on public.copyright_notices (status);


-- ─── 2) Strikes — account level, survives content deletion ──────────────────
create table if not exists public.copyright_strikes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  notice_id  uuid references public.copyright_notices(id) on delete set null,
  created_at timestamptz not null default now(),
  -- A strike is voided ONLY when the underlying notice turns out not to have been
  -- valid — withdrawn by the claimant, or a §512(f) misrepresentation. Note this
  -- is NOT the same as a counter-notification: the published policy states the
  -- repeat-infringer policy "applies regardless of whether the user submits a
  -- counter-notification", so a putback restores the content and leaves the
  -- strike standing.
  voided_at  timestamptz,
  void_reason text
);

create index if not exists copyright_strikes_user_idx on public.copyright_strikes (user_id) where voided_at is null;

-- No user_id foreign key on purpose. A terminated account that is later deleted
-- must not take its enforcement history with it — the record is the defence.


-- ─── 3) Counter-notices (§512(g)) ───────────────────────────────────────────
create table if not exists public.copyright_counter_notices (
  id                 uuid primary key default gen_random_uuid(),
  notice_id          uuid not null references public.copyright_notices(id) on delete restrict,
  user_id            uuid references auth.users(id) on delete set null,
  signature          text not null,
  material_and_location text not null,
  good_faith_perjury boolean not null default false,
  consent_jurisdiction boolean not null default false,
  accept_service     boolean not null default false,
  contact_name       text,
  contact_address    text,
  contact_phone      text,
  received_at        timestamptz not null default now(),
  -- Terms §8: restore "not less than 10 and not more than 14 business days".
  restore_earliest   timestamptz,
  restore_deadline   timestamptz,
  claimant_notified_at timestamptz,
  suit_filed         boolean not null default false,
  restored_at        timestamptz
);

create index if not exists copyright_cn_pending_idx
  on public.copyright_counter_notices (restore_earliest) where restored_at is null and suit_filed = false;


-- ─── 4) Terminations + re-registration block ────────────────────────────────
-- The email is stored HASHED. Blocking re-registration requires recognising the
-- address, not retaining it — and courts have accepted email-level blocking as
-- sufficient without requiring IP screening.
create table if not exists public.copyright_terminations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid,
  email_sha256   text,
  strike_count   int not null,
  terminated_at  timestamptz not null default now(),
  reason         text not null default 'repeat copyright infringement'
);

create index if not exists copyright_term_email_idx on public.copyright_terminations (email_sha256);


-- ─── 5) Append-only enforcement ─────────────────────────────────────────────
-- Strikes and terminations are the evidence. Notices and counter-notices still
-- need status updates, so only the enforcement record is frozen.
create or replace function public.copyright_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'copyright enforcement records are append-only (attempted %)', tg_op;
end $$;

drop trigger if exists copyright_strikes_frozen on public.copyright_strikes;
create trigger copyright_strikes_frozen
  before delete on public.copyright_strikes
  for each row execute function public.copyright_immutable();

drop trigger if exists copyright_terminations_frozen on public.copyright_terminations;
create trigger copyright_terminations_frozen
  before update or delete on public.copyright_terminations
  for each row execute function public.copyright_immutable();


-- ─── 6) Content removal ─────────────────────────────────────────────────────
alter table public.posts          add column if not exists copyright_removed_at timestamptz;
alter table public.shop_listings  add column if not exists copyright_removed_at timestamptz;

-- Restrictive policies: removed material is invisible to everyone, including its
-- author. "Disable access" in §512(c) means disabled, not merely unlisted. These
-- AND with existing policies rather than replacing them.
drop policy if exists "Copyright-removed posts are invisible" on public.posts;
create policy "Copyright-removed posts are invisible"
  on public.posts as restrictive for select
  using (copyright_removed_at is null);

-- A DEDICATED COLUMN, NOT status = 'removed'. shop_listing_takedown_guard
-- (shop_multi.sql) RAISES 'has_purchases' when a listing with delivered orders is
-- moved to 'removed'. That guard is correct — it stops a seller yanking a listing
-- buyers have paid for — but a DMCA takedown is not a seller decision, it is a
-- legal obligation to disable access, and buyer protection cannot override it.
-- Writing to status would make takedown fail on precisely the listings that have
-- sold. This column sidesteps the guard without weakening it.
drop policy if exists "Copyright-removed listings are invisible" on public.shop_listings;
create policy "Copyright-removed listings are invisible"
  on public.shop_listings as restrictive for select
  using (copyright_removed_at is null);


-- ─── 7) Business-day arithmetic for the putback window ──────────────────────
create or replace function public.add_business_days(p_from timestamptz, p_days int)
returns timestamptz
language plpgsql
immutable
as $$
declare v_d timestamptz := p_from; v_n int := 0;
begin
  while v_n < p_days loop
    v_d := v_d + interval '1 day';
    if extract(isodow from v_d) < 6 then v_n := v_n + 1; end if;
  end loop;
  return v_d;
end $$;


-- ─── 8) Action a notice ─────────────────────────────────────────────────────
-- Removes the material, cascades to attributed uses, records a strike, and lets
-- the trigger decide about termination. There is no argument that skips any of it.
create or replace function public.copyright_action_notice(p_notice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n           public.copyright_notices;
  v_user      uuid;
  v_cascaded  int := 0;
  v_snapshot  jsonb;
begin
  select * into n from public.copyright_notices where id = p_notice_id;
  if not found then raise exception 'notice % not found', p_notice_id; end if;
  if n.status <> 'received' then
    return jsonb_build_object('ok', false, 'reason', 'already ' || n.status);
  end if;

  -- §512(c)(3)(B): a notice that does not substantially comply cannot establish
  -- knowledge, so it must not produce a strike either.
  if not n.valid then
    return jsonb_build_object('ok', false, 'reason', 'notice not marked valid');
  end if;

  if n.target_type = 'post' then
    select user_id, to_jsonb(p) into v_user, v_snapshot
      from public.posts p where p.id = n.target_id::uuid;

    update public.posts set copyright_removed_at = now() where id = n.target_id::uuid;

    -- Terms §8: removal "may include removing the Audio Content and any Attributed
    -- Uses that incorporate it." One takedown therefore has to reach every video
    -- that attached this audio — otherwise the recording stays live across
    -- thousands of posts and the removal was not expeditious in any real sense.
    update public.posts
       set copyright_removed_at = now()
     where song_id = n.target_id::uuid and copyright_removed_at is null;
    get diagnostics v_cascaded = row_count;

  elsif n.target_type = 'listing' then
    select user_id, to_jsonb(l) into v_user, v_snapshot
      from public.shop_listings l where l.id = n.target_id::uuid;
    update public.shop_listings set copyright_removed_at = now() where id = n.target_id::uuid;

  elsif n.target_type = 'comment' then
    select user_id, to_jsonb(c) into v_user, v_snapshot
      from public.comments c where c.id = n.target_id::uuid;
    delete from public.comments where id = n.target_id::uuid;

  else
    v_user := n.target_user_id;
  end if;

  v_user := coalesce(v_user, n.target_user_id);

  update public.copyright_notices
     set status = 'actioned',
         actioned_at = now(),
         target_user_id = coalesce(target_user_id, v_user),
         content_snapshot = coalesce(content_snapshot, v_snapshot)
   where id = p_notice_id;

  if v_user is not null then
    insert into public.copyright_strikes (user_id, notice_id) values (v_user, p_notice_id);
  end if;

  return jsonb_build_object(
    'ok', true, 'user_id', v_user, 'attributed_uses_removed', v_cascaded,
    'strikes', (select count(*) from public.copyright_strikes
                 where user_id = v_user and voided_at is null));
end $$;


-- ─── 9) Termination — automatic, no override ────────────────────────────────
-- Fires from the strike insert itself. Nothing calls this with a flag; there is
-- no code path that reaches three valid strikes and declines to terminate. That
-- is the entire lesson of BMG v. Cox.
create or replace function public.copyright_enforce_repeat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  select count(*) into v_count
    from public.copyright_strikes
   where user_id = new.user_id and voided_at is null;

  -- Three, as published in Terms §8.
  if v_count >= 3 and not exists (
       select 1 from public.copyright_terminations where user_id = new.user_id) then

    insert into public.copyright_terminations (user_id, email_sha256, strike_count)
    select new.user_id,
           encode(sha256(convert_to(lower(trim(u.email)), 'UTF8')), 'hex'),
           v_count
      from auth.users u where u.id = new.user_id;

    -- Remove them from circulation immediately. The auth-plane ban needs the
    -- Admin API and is completed by the admin-actions Edge Function.
    update public.profiles set hidden = true where id = new.user_id;
    update public.posts set copyright_removed_at = now()
     where user_id = new.user_id and copyright_removed_at is null;
    update public.shop_listings set copyright_removed_at = now()
     where user_id = new.user_id and copyright_removed_at is null;
  end if;

  return new;
end $$;

drop trigger if exists copyright_strikes_enforce on public.copyright_strikes;
create trigger copyright_strikes_enforce
  after insert on public.copyright_strikes
  for each row execute function public.copyright_enforce_repeat();

-- No pgcrypto dependency: sha256() is built into Postgres 11+ and needs no
-- extension. Supabase installs pgcrypto into the `extensions` schema, which a
-- function pinned to `search_path = public` cannot see — so digest() failed here
-- even when the extension was present.


-- ─── 10) Counter-notice intake ──────────────────────────────────────────────
create or replace function public.copyright_record_counter_notice(
  p_notice_id uuid, p_user uuid, p_signature text, p_material text,
  p_perjury boolean, p_jurisdiction boolean, p_service boolean,
  p_name text default null, p_address text default null, p_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  -- All three statements are mandatory under §512(g)(3). A counter-notice missing
  -- any of them is not a counter-notice and must not start the putback clock.
  if not (p_perjury and p_jurisdiction and p_service) then
    raise exception 'counter-notice requires the perjury statement, consent to jurisdiction, and acceptance of service';
  end if;

  insert into public.copyright_counter_notices (
    notice_id, user_id, signature, material_and_location,
    good_faith_perjury, consent_jurisdiction, accept_service,
    contact_name, contact_address, contact_phone,
    restore_earliest, restore_deadline)
  values (
    p_notice_id, p_user, p_signature, p_material,
    true, true, true, p_name, p_address, p_phone,
    public.add_business_days(now(), 10),
    public.add_business_days(now(), 14))
  returning id into v_id;
  return v_id;
end $$;

-- What is due for restoration today: past 10 business days, inside 14, and the
-- claimant has not filed suit. Check this on the same cadence as the moderation
-- queue — the window is a legal obligation, not a nicety.
create or replace function public.copyright_restores_due()
returns table (counter_notice_id uuid, notice_id uuid, user_id uuid,
               restore_earliest timestamptz, restore_deadline timestamptz)
language sql stable security definer set search_path = public as $$
  select id, notice_id, user_id, restore_earliest, restore_deadline
    from public.copyright_counter_notices
   where restored_at is null and suit_filed = false and now() >= restore_earliest
   order by restore_earliest;
$$;


-- ─── 11) Re-registration block ──────────────────────────────────────────────
-- Call at signup. Courts have accepted blocking a known address as a reasonable
-- implementation without demanding IP-level screening.
create or replace function public.is_terminated_email(p_email text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.copyright_terminations
     where email_sha256 = encode(sha256(convert_to(lower(trim(p_email)), 'UTF8')), 'hex'));
$$;

grant execute on function public.is_terminated_email(text) to anon, authenticated;


-- ─── 12) RLS + grants ───────────────────────────────────────────────────────
alter table public.copyright_notices         enable row level security;
alter table public.copyright_strikes         enable row level security;
alter table public.copyright_counter_notices enable row level security;
alter table public.copyright_terminations    enable row level security;

-- A user may see their own strikes — §512(i) requires informing account holders,
-- and someone approaching termination should be able to see that.
drop policy if exists "Users see their own strikes" on public.copyright_strikes;
create policy "Users see their own strikes"
  on public.copyright_strikes for select using (user_id = auth.uid());

-- Everything else is staff-only via the service role. Notices contain claimant
-- contact details and must not be readable by the accused.
revoke all on function public.copyright_action_notice(uuid) from public, authenticated;
revoke all on function public.copyright_restores_due() from public, authenticated;
revoke all on function public.add_business_days(timestamptz, int) from public;

-- Staff-only, and this one matters. Postgres grants EXECUTE to PUBLIC by default,
-- and the function is SECURITY DEFINER taking the user id as an argument — left
-- open, anyone could file a counter-notice in someone else's name and start a
-- putback clock on content that is not theirs. Terms §8 routes counter-notices to
-- the designated agent by email or mail, not through an in-app form, so nothing
-- client-side needs to reach it.
revoke all on function public.copyright_record_counter_notice(
  uuid, uuid, text, text, boolean, boolean, boolean, text, text, text
) from public, authenticated;


-- ─── Operating it ───────────────────────────────────────────────────────────
-- 1. A notice arrives at dmca@laybell.app. Record it, marking `valid` only if it
--    substantially contains all six elements from Terms §8:
--
--    insert into public.copyright_notices
--      (claimant_name, claimant_email, claimant_address, work_description,
--       target_type, target_id, good_faith_belief, accuracy_perjury, signature, valid)
--    values ('...','...','...','...', 'post', '<post uuid>', true, true, '/s/ Name', true);
--
-- 2. Action it — removes the material, cascades to attributed uses, strikes the
--    account, and terminates automatically at the third strike:
--
--    select public.copyright_action_notice('<notice uuid>');
--
-- 3. DAILY, alongside the moderation queue:
--
--    select * from public.copyright_restores_due();
--
-- 4. Prove the policy is reasonably implemented (this is the Motherless defence):
--
--    select count(*) from public.copyright_notices where status = 'actioned';
--    select count(*) from public.copyright_terminations;
--    select user_id, count(*) from public.copyright_strikes
--     where voided_at is null group by user_id order by 2 desc;


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/sound_optin.sql
-- "use this sound" per-track consent + withdrawal
-- ═══════════════════════════════════════════════════════════════════════════

-- "Use this sound" — per-track consent + a global kill switch.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires post_song.sql (posts.song_id and the song_* attribution columns).
--
-- WHY THIS EXISTS
-- Attaching someone else's audio to a video is SYNCHRONISATION. No performing-
-- rights licence covers sync — not the BMI agreement, not ASCAP, not any PRO
-- licence that will ever be issued. The only basis Laybell has for the feature is
-- the licence users grant in the Terms, which creates two problems:
--
--   1. A blanket clause buried in the Terms is the weakest form of that grant. A
--      specific, per-track choice the uploader actively made is materially more
--      defensible, and costs one toggle.
--
--   2. Without a withdrawal mechanism there is no way to undo a sound that has
--      already spread. Terms §8 promises removal reaches "any Attributed Uses
--      that incorporate it" — unachievable at scale by hand.
--
-- WHY WITHDRAWAL WORKS CLEANLY HERE
-- The attached song is NOT baked into the video file. Playback mutes the video and
-- plays the song alongside it (app/(tabs)/index.tsx: `muted={item.song_id ? true
-- : videoMuted}`). So clearing the attribution is enough — the video reverts to
-- its own audio, nothing needs re-encoding, and no one's video is destroyed.

-- ─── 1) Columns ─────────────────────────────────────────────────────────────
alter table public.posts
  -- The affirmative grant. See DEFAULT_SOUND_OPT_IN in lib/sounds.ts for the
  -- product/legal tradeoff on what this should default to — that is a policy
  -- decision, not a technical one.
  add column if not exists sound_opt_in       boolean not null default true,
  -- The kill switch. Set = the sound is withdrawn from the picker and stripped
  -- from every post that used it.
  add column if not exists sound_withdrawn_at timestamptz,
  -- Records WHEN consent was given, so the grant has a timestamp rather than
  -- being inferred from a column's current value.
  add column if not exists sound_opt_in_at    timestamptz;

-- The picker only ever wants opted-in, non-withdrawn audio.
create index if not exists posts_sound_available_idx
  on public.posts (type, created_at desc)
  where sound_opt_in = true and sound_withdrawn_at is null;

-- Finding derivatives fast matters — withdrawal has to be expeditious.
create index if not exists posts_song_id_idx on public.posts (song_id) where song_id is not null;


-- ─── 2) Withdraw a sound ────────────────────────────────────────────────────
-- Owner-only. Pulls the sound from the picker AND strips it from every post and
-- story that attached it, in one transaction. Returns how many were affected so
-- the UI can tell the user what just happened.
create or replace function public.withdraw_sound(p_post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_posts  int := 0;
  v_stories int := 0;
begin
  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then raise exception 'post not found'; end if;
  if v_owner <> auth.uid() then raise exception 'not_owner'; end if;

  update public.posts
     set sound_withdrawn_at = now(), sound_opt_in = false
   where id = p_post_id;

  -- Strip the attribution from every derivative. Clearing song_id is what makes
  -- the borrowed audio actually stop playing: the player mutes a video only while
  -- a song is attached, so removing it hands the video back its own sound. The
  -- other user's post survives intact — this withdraws the audio, not their work.
  update public.posts
     set song_id = null, song_title = null, song_artist = null, song_artist_id = null
   where song_id = p_post_id;
  get diagnostics v_posts = row_count;

  begin
    update public.stories
       set song_id = null, song_title = null, song_artist = null, song_artist_id = null
     where song_id = p_post_id;
    get diagnostics v_stories = row_count;
  exception when undefined_table or undefined_column then
    v_stories := 0;   -- stories or its song columns not migrated; nothing to strip
  end;

  return jsonb_build_object('ok', true, 'posts_updated', v_posts, 'stories_updated', v_stories);
end $$;

grant execute on function public.withdraw_sound(uuid) to authenticated;


-- ─── 3) Re-allow ────────────────────────────────────────────────────────────
-- Withdrawal does not restore the posts that already lost the attribution —
-- that would mean silently re-attaching audio to other people's content without
-- asking them. It only puts the sound back in the picker for future use.
create or replace function public.allow_sound(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then
    raise exception 'not_owner';
  end if;
  update public.posts
     set sound_opt_in = true, sound_withdrawn_at = null, sound_opt_in_at = now()
   where id = p_post_id;
end $$;

grant execute on function public.allow_sound(uuid) to authenticated;


-- ─── 4) Backfill ────────────────────────────────────────────────────────────
-- Existing audio predates the toggle, so it has no recorded consent. The column
-- default makes it available; stamping the timestamp records that this was a
-- migration default rather than a choice anyone actually made. If you would
-- rather require existing creators to opt in explicitly, run this instead:
--
--   update public.posts set sound_opt_in = false
--    where type in ('audio','podcast','audiobook') and sound_opt_in_at is null;
--
update public.posts
   set sound_opt_in_at = coalesce(sound_opt_in_at, created_at)
 where type in ('audio', 'podcast', 'audiobook') and sound_opt_in_at is null;


-- Verify:
--   select id, caption, sound_opt_in, sound_withdrawn_at from public.posts
--    where type = 'audio' order by created_at desc limit 10;
--
-- Withdraw (as the owner):
--   select public.withdraw_sound('<audio post uuid>');


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/live_replay.sql
-- opt-in livestream replay retention (BMI grants no reproduction right)
-- ═══════════════════════════════════════════════════════════════════════════

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


-- ═══════════════════════════════════════════════════════════════════════════
-- FILE: supabase/sql/stream_hours.sql
-- aggregate stream-hours meter for the BMI Tier-1 ceiling
-- ═══════════════════════════════════════════════════════════════════════════

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
