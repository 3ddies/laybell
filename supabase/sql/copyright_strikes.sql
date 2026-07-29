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
