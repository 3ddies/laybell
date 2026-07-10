-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — ADMIN / MODERATION CONSOLE  ·  Phase 1a: schema + enforcement
-- Paste this WHOLE file into the Supabase Dashboard → SQL Editor and Run.
-- Run admin_console_rpcs.sql NEXT (it defines the functions the console calls).
--
-- Everything is IDEMPOTENT — safe to run more than once. It is ADDITIVE: it does
-- not change how the consumer app files reports, and every new enforcement rule is
-- keyed on a NEW table that starts EMPTY, so running this file changes NOTHING that
-- users see until a moderator actually acts. All OTA-safe (no app rebuild).
--
-- WHY THIS EXISTS
-- The schema was already built anticipating "a future admin tool" (see the note at
-- the bottom of moderation_preservation.sql): reports carry tamper-proof snapshots,
-- legal_hold preserves evidence, and report tables have NO client read policy on
-- purpose — they are meant to be read by a trusted, service-role / admin surface.
-- This migration turns laybell_admins into a real role system and adds the missing
-- moderation spine: an append-only audit log, a unified case/queue layer, first-class
-- account sanctions (warn/suspend/shadow-ban/ban) and a reversible content-takedown
-- primitive — all enforced server-side.
--
-- SEQUENCE
--   Prereqs: laybell_communities.sql (laybell_admins), post_reports.sql,
--   user_reports.sql, conversation_reports.sql, shop.sql, ad_ecosystem.sql,
--   link_safety.sql, group_chats.sql, moderation_preservation.sql, account_hidden.sql.
--   Section 0 checks ALL of them at once and raises a single list of what to run.
--   (account_deletion_sweep.sql is NOT required — we add its resolved_at columns here.)
--
-- ⚠ AFTER RUNNING BOTH SQL FILES: do the ONE manual step at the very bottom of this
--   file (promote your account to the 'owner' role). Then deploy the admin-actions
--   edge function (see docs/ADMIN_CONSOLE.md).
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- 0) PREREQUISITE GUARDS — checks EVERYTHING at once and raises a single list of
--    exactly what to run, so you don't discover missing pieces one error at a time.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_missing text := '';
begin
  -- report tables + their owning feature files
  if to_regclass('public.laybell_admins')       is null then v_missing := v_missing || E'\n  - laybell_communities.sql   (laybell_admins)'; end if;
  if to_regclass('public.post_reports')         is null then v_missing := v_missing || E'\n  - post_reports.sql          (post_reports)'; end if;
  if to_regclass('public.user_reports')         is null then v_missing := v_missing || E'\n  - user_reports.sql          (user_reports)'; end if;
  if to_regclass('public.conversation_reports') is null then v_missing := v_missing || E'\n  - conversation_reports.sql  (conversation_reports)'; end if;
  if to_regclass('public.shop_reports')         is null then v_missing := v_missing || E'\n  - shop.sql                  (shop_reports, shop_listings)'; end if;
  if to_regclass('public.shop_listings')        is null and to_regclass('public.shop_reports') is not null then v_missing := v_missing || E'\n  - shop.sql                  (shop_listings)'; end if;
  if to_regclass('public.ad_reports')           is null then v_missing := v_missing || E'\n  - ad_ecosystem.sql          (ad_reports, ad_campaigns)'; end if;
  if to_regclass('public.link_reports')         is null then v_missing := v_missing || E'\n  - link_safety.sql           (link_reports, blocked_link_domains)'; end if;
  if to_regclass('public.conversations')        is null then v_missing := v_missing || E'\n  - group_chats.sql           (conversations)'; end if;

  -- moderation_preservation.sql — the evidence spine (snapshots + legal_hold)
  if to_regclass('public.post_reports') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='post_reports' and column_name='content_snapshot')
  then v_missing := v_missing || E'\n  - moderation_preservation.sql (report snapshots + legal_hold)'; end if;

  -- account_hidden.sql — the app-wide invisibility flag we reuse
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='hidden')
  then v_missing := v_missing || E'\n  - account_hidden.sql        (profiles.hidden)'; end if;

  if v_missing <> '' then
    raise exception E'Admin console prerequisites are missing. Run these in the SQL editor first, then re-run this file:%', v_missing;
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 1) laybell_admins — UPGRADE to graded roles (do NOT replace)
--    reviewer < moderator < owner. Existing rows keep working; they default to the
--    LOWEST tier ('reviewer') until you promote them — so nobody silently gains
--    power. disabled_at soft-revokes an admin without losing the audit trail.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.laybell_admins
  add column if not exists role        text not null default 'reviewer'
    check (role in ('owner', 'moderator', 'reviewer')),
  add column if not exists scopes      jsonb,                 -- optional per-surface limits (future)
  add column if not exists added_by    uuid references auth.users(id) on delete set null,
  add column if not exists disabled_at timestamptz;           -- soft-revoke

-- The self-only SELECT policy from laybell_communities.sql stays as-is (a user can
-- see only their own admin row; the roster is never exposed to clients).

-- ── Authorization primitives — the single choke point every admin RPC, the admin
--    edge function, and any admin RLS policy reuses. SECURITY DEFINER so callers
--    don't need direct read access to laybell_admins.
create or replace function public.is_laybell_admin(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.laybell_admins
    where user_id = p_uid and disabled_at is null
  );
$$;

create or replace function public.has_admin_role(p_uid uuid, p_min_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.laybell_admins a
    where a.user_id = p_uid
      and a.disabled_at is null
      and (case a.role when 'owner' then 3 when 'moderator' then 2 when 'reviewer' then 1 else 0 end)
          >= (case p_min_role when 'owner' then 3 when 'moderator' then 2 when 'reviewer' then 1 else 99 end)
  );
$$;

-- These take an arbitrary uid — keep them OUT of clients (they run only inside the
-- SECURITY DEFINER admin RPCs / the edge function / the service role).
revoke execute on function public.is_laybell_admin(uuid) from public;
revoke execute on function public.has_admin_role(uuid, text) from public;

-- The ONE admin function the app/console may call directly: "what is MY role?"
-- (returns null for non-admins). Backs the console's login gate.
create or replace function public.current_admin_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.laybell_admins
  where user_id = auth.uid() and disabled_at is null;
$$;
revoke execute on function public.current_admin_role() from public;
grant  execute on function public.current_admin_role() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- 2) admin_audit_log — the append-only, actor-stamped record of every moderation
--    action. Fills the biggest gap: resolved_at says a report closed but not WHO
--    did WHAT or WHY, and community_mod_log covers communities only. Written ONLY
--    inside the admin RPCs / edge function, in the same transaction as the action.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.admin_audit_log (
  id             uuid primary key default gen_random_uuid(),
  -- actor_id is a PLAIN uuid with NO foreign key (like target_user_id). A FK with
  -- ON DELETE SET NULL would fire an UPDATE on this row during the delete cascade,
  -- which the append-only trigger below rejects — that would make deleting ANY
  -- account that ever acted as an admin fail, and could wedge the deletion sweep.
  actor_id       uuid,        -- admin who acted (denormalized; survives their deletion)
  actor_role     text,                                                -- role at action time
  action         text not null,                                       -- see the RPCs for the vocabulary
  target_type    text,        -- post|user|story|comment|conversation|shop_listing|ad|community|domain
  target_id      text,        -- text so it holds uuids AND domains
  target_user_id uuid,        -- denormalized subject account (survives target deletion)
  report_subject text,        -- 'type:id' of the case this action closed, if any
  reason         text,        -- moderator-entered rationale
  detail         jsonb,       -- before/after, minutes, ban duration, etc.
  created_at     timestamptz not null default now()
);
-- If a partial earlier run created the FK, drop it (idempotent).
alter table public.admin_audit_log drop constraint if exists admin_audit_log_actor_id_fkey;

create index if not exists admin_audit_target_idx on public.admin_audit_log (target_type, target_id, created_at desc);
create index if not exists admin_audit_subject_idx on public.admin_audit_log (target_user_id, created_at desc);
create index if not exists admin_audit_actor_idx   on public.admin_audit_log (actor_id, created_at desc);

alter table public.admin_audit_log enable row level security;
-- No client policy at all: reads happen via admin_list_audit() (SECURITY DEFINER);
-- writes happen inside the admin RPCs / service role. RLS-locked to everyone else.

-- Append-only: block UPDATE/DELETE (row-level) and TRUNCATE (statement-level) so the
-- log can't be rewritten in the normal course of the app or by the admin RPCs. NOTE:
-- this guarantees immutability against RLS clients and the RPC/edge-fn code paths; a
-- holder of the raw service-role key / a DB superuser can still DROP the triggers or
-- the table, so treat those credentials as the ultimate trust boundary (and, for a
-- true legal record, stream the log to append-only external storage).
create or replace function public.admin_audit_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_audit_log is append-only (no % allowed)', tg_op;
end $$;

drop trigger if exists admin_audit_no_update on public.admin_audit_log;
create trigger admin_audit_no_update before update on public.admin_audit_log
  for each row execute function public.admin_audit_immutable();
drop trigger if exists admin_audit_no_delete on public.admin_audit_log;
create trigger admin_audit_no_delete before delete on public.admin_audit_log
  for each row execute function public.admin_audit_immutable();
drop trigger if exists admin_audit_no_truncate on public.admin_audit_log;
create trigger admin_audit_no_truncate before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_immutable();

-- Shared writer used by every admin RPC (owner-context; bypasses the RLS lock).
create or replace function public.admin_log(
  p_actor uuid, p_action text, p_target_type text, p_target_id text,
  p_target_user uuid, p_report_subject text, p_reason text, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.admin_audit_log
    (actor_id, actor_role, action, target_type, target_id, target_user_id, report_subject, reason, detail)
  values
    (p_actor, (select role from public.laybell_admins where user_id = p_actor),
     p_action, p_target_type, p_target_id, p_target_user, p_report_subject, p_reason, p_detail);
end $$;
revoke execute on function public.admin_log(uuid, text, text, text, uuid, text, text, jsonb) from public;


-- ════════════════════════════════════════════════════════════════════════════
-- 3) moderation_cases — workflow/dedup overlay. The QUEUE is derived live from the
--    raw report tables (source of truth for "what was reported"); this table holds
--    only the workflow STATE for one subject (N reports on one post = ONE case).
--    Keyed by (subject_type, subject_id-as-text) so it spans uuids and link hosts.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.moderation_cases (
  id               uuid primary key default gen_random_uuid(),
  subject_type     text not null,   -- post|user|story|conversation|shop_listing|ad|domain
  subject_id       text not null,
  subject_user_id  uuid,            -- the account behind the subject, if any
  status           text not null default 'open'
    check (status in ('open', 'investigating', 'actioned', 'dismissed', 'escalated')),
  severity         text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  assignee_id      uuid references auth.users(id) on delete set null,
  action_taken     text,
  notes            text,            -- private moderator notes
  escalated_to     text,            -- owner|legal|ncmec
  resolved_by      uuid references auth.users(id) on delete set null,
  resolved_at      timestamptz,
  first_reported_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (subject_type, subject_id)
);
create index if not exists moderation_cases_status_idx  on public.moderation_cases (status, severity, updated_at desc);
create index if not exists moderation_cases_subject_idx on public.moderation_cases (subject_user_id);

alter table public.moderation_cases enable row level security;
-- No client policy: cases are read/written only through the admin RPCs.


-- ════════════════════════════════════════════════════════════════════════════
-- 4) REPORT-TABLE CONSISTENCY BACKFILL
--    Bring conversation/shop/link/ad reports up to the post/user preservation
--    standard: a resolved_at "mark handled" flag everywhere, tamper-proof snapshots
--    where missing, and CASCADE→SET NULL FK flips so deleting the campaign/
--    conversation no longer DESTROYS the report + its evidence.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 4·0) resolved_at on post/user/ad reports. account_deletion_sweep.sql also adds
--    these; we add them here (idempotent) so the console does NOT depend on the
--    deletion sweep being set up. A moderator marks a report handled via resolved_at.
alter table public.post_reports add column if not exists resolved_at timestamptz;
alter table public.user_reports add column if not exists resolved_at timestamptz;
alter table public.ad_reports   add column if not exists resolved_at timestamptz;

-- ── 4a) conversation_reports: mark-handled + metadata snapshot + FK flip ──────
alter table public.conversation_reports
  add column if not exists resolved_at          timestamptz,
  add column if not exists reported_user_id     uuid,     -- conversation creator (kept after delete)
  add column if not exists conversation_snapshot jsonb,   -- conversation METADATA only (never message bodies)
  add column if not exists snapshot_at          timestamptz;

alter table public.conversation_reports alter column conversation_id drop not null;
alter table public.conversation_reports drop constraint if exists conversation_reports_conversation_id_fkey;
alter table public.conversation_reports
  add constraint conversation_reports_conversation_id_fkey
  foreign key (conversation_id) references public.conversations(id) on delete set null;

-- Snapshot the conversation METADATA (id/creator/members) — deliberately NOT the
-- message bodies: 1:1 and group message contents are private (Privacy Policy) and
-- there is no admin read path into them today. Preserving who/what was reported is
-- enough for triage; full message preservation is a Phase 4 legal decision.
create or replace function public.snapshot_conversation_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select c.created_by,
         jsonb_build_object(
           'id', c.id, 'created_by', c.created_by, 'created_at', c.created_at,
           'member_count', (select count(*) from public.conversation_members m where m.conversation_id = c.id))
    into new.reported_user_id, new.conversation_snapshot
    from public.conversations c
   where c.id = new.conversation_id;
  new.snapshot_at := now();
  return new;
end $$;
drop trigger if exists conversation_reports_snapshot on public.conversation_reports;
create trigger conversation_reports_snapshot
  before insert on public.conversation_reports
  for each row execute function public.snapshot_conversation_report();

-- ── 4b) shop_reports: mark-handled + full listing snapshot ────────────────────
--    (listing_id + seller_id are already ON DELETE SET NULL — preservation-safe.)
alter table public.shop_reports
  add column if not exists resolved_at       timestamptz,
  add column if not exists reported_snapshot jsonb,       -- full listing at report time
  add column if not exists snapshot_at       timestamptz;

create or replace function public.snapshot_shop_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select to_jsonb(l), l.user_id
    into new.reported_snapshot, new.seller_id
    from public.shop_listings l
   where l.id = new.listing_id;
  new.snapshot_at := now();
  return new;
end $$;
drop trigger if exists shop_reports_snapshot on public.shop_reports;
create trigger shop_reports_snapshot
  before insert on public.shop_reports
  for each row execute function public.snapshot_shop_report();

-- ── 4c) link_reports: mark-handled ────────────────────────────────────────────
alter table public.link_reports
  add column if not exists resolved_at timestamptz;

-- ── 4d) ad_reports: capture the campaign owner + creative snapshot; FK flip so a
--        deleted campaign no longer CASCADE-destroys the report (it was the only
--        report table still on CASCADE). resolved_at already added by the sweep.
alter table public.ad_reports
  add column if not exists reported_user_id  uuid,        -- campaign owner (kept after delete)
  add column if not exists creative_snapshot jsonb,
  add column if not exists snapshot_at       timestamptz;

alter table public.ad_reports alter column campaign_id drop not null;
alter table public.ad_reports drop constraint if exists ad_reports_campaign_id_fkey;
alter table public.ad_reports
  add constraint ad_reports_campaign_id_fkey
  foreign key (campaign_id) references public.ad_campaigns(id) on delete set null;

create or replace function public.snapshot_ad_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select c.user_id,
         to_jsonb(cr)
    into new.reported_user_id, new.creative_snapshot
    from public.ad_campaigns c
    left join public.ad_creatives cr on cr.id = new.creative_id
   where c.id = new.campaign_id;
  new.snapshot_at := now();
  return new;
end $$;
drop trigger if exists ad_reports_snapshot on public.ad_reports;
create trigger ad_reports_snapshot
  before insert on public.ad_reports
  for each row execute function public.snapshot_ad_report();

-- ── 4e) backfill reported_user_id on EXISTING ad/conversation reports (the trigger
--    only fills new rows). Keeps the queue attributing historical reports to the right
--    account, and makes the open-report gate robust if the campaign/conversation is
--    ever hard-deleted (its FK is now SET NULL). Snapshots for old rows can't be
--    reconstructed, but the owner link can. Idempotent (only touches null rows).
update public.ad_reports ar
   set reported_user_id = c.user_id
  from public.ad_campaigns c
 where c.id = ar.campaign_id and ar.reported_user_id is null;

update public.conversation_reports cr
   set reported_user_id = c.created_by
  from public.conversations c
 where c.id = cr.conversation_id and cr.reported_user_id is null;


-- ════════════════════════════════════════════════════════════════════════════
-- 5) user_sanctions — first-class account moderation state the app side lacks
--    entirely today (ban lived ONLY as auth.users.ban_duration, no unban path, no
--    strike count). One CURRENT-state row per user; the full history lives in
--    admin_audit_log. Enforced server-side by restrictive RLS (Section 7) so a
--    suspend / shadow-ban / ban actually DOES something without deleting data.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.user_sanctions (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  state           text not null default 'active'
    check (state in ('active', 'warned', 'suspended', 'shadow_banned', 'banned')),
  suspended_until timestamptz,             -- when a 'suspended' state auto-lifts
  strike_count    integer not null default 0,
  reason          text,
  actor_id        uuid references auth.users(id) on delete set null,
  auth_ban_synced boolean not null default false,  -- true once the edge fn set auth.users ban_duration
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists user_sanctions_state_idx on public.user_sanctions (state);

alter table public.user_sanctions enable row level security;
-- No client policy: a user must NOT be able to read whether they are shadow-banned,
-- nor see others' sanction state. All access is through the admin RPCs / helpers.

-- Enforcement helpers (SECURITY DEFINER so they see the RLS-locked table).
--  * hidden   → shadow_banned or banned: their content is invisible to others.
--  * blocked  → banned, or an ACTIVE suspension: they cannot create new content.
-- Shadow-banned users can still POST (so it looks normal to them) — their content
-- is just hidden — so shadow_ban does NOT block posting.
--
-- ⚠ These live in a PRIVATE schema, NOT public. Because they are SECURITY DEFINER
-- and bypass the RLS lock on user_sanctions, exposing them as PostgREST RPCs would
-- let ANY client probe "is user X shadow-banned/suspended/banned?" — which defeats
-- shadow-ban (its whole point is secrecy). PostgREST only exposes public/graphql_public,
-- so putting them in `private` makes them unreachable as RPCs while the RLS policies
-- (which reference them fully-qualified) can still call them. authenticated/anon get
-- USAGE + EXECUTE so policy evaluation during a normal query is permitted.
create schema if not exists private;
grant usage on schema private to authenticated, anon;

-- Drop any public.* versions a partial earlier run may have created (they'd be
-- RPC-exposed — remove them so the leak can't exist).
drop function if exists public.user_content_hidden(uuid);
drop function if exists public.user_posting_blocked(uuid);

create or replace function private.user_content_hidden(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_sanctions s
    where s.user_id = p_uid and s.state in ('shadow_banned', 'banned')
  );
$$;

create or replace function private.user_posting_blocked(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_sanctions s
    where s.user_id = p_uid
      and (s.state = 'banned'
        or (s.state = 'suspended' and coalesce(s.suspended_until, 'infinity'::timestamptz) > now()))
  );
$$;
grant execute on function private.user_content_hidden(uuid)  to authenticated, anon;
grant execute on function private.user_posting_blocked(uuid) to authenticated, anon;


-- ════════════════════════════════════════════════════════════════════════════
-- 6) content_takedowns — the missing NON-DESTRUCTIVE moderator takedown. Posts had
--    only the owner's archived_at; stories/comments/listings had nothing but hard
--    delete. A polymorphic row HIDES a single item app-wide (evidence preserved,
--    reversible, appealable) — the complement to legal_hold ("preserve") with a
--    "take down but keep" state.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.content_takedowns (
  id                uuid primary key default gen_random_uuid(),
  content_type      text not null,     -- post|story|comment|shop_listing (enforced below); playlist|ad_creative|message (stored, enforce later)
  content_id        uuid not null,
  owner_id          uuid,              -- author of the content (for the queue / audit)
  active            boolean not null default true,
  reason            text,
  actor_id          uuid references auth.users(id) on delete set null,
  legal_hold_linked boolean not null default false,
  created_at        timestamptz not null default now(),
  restored_at       timestamptz,
  restored_by       uuid references auth.users(id) on delete set null,
  unique (content_type, content_id)
);
create index if not exists content_takedowns_active_idx on public.content_takedowns (content_type, content_id) where active;

alter table public.content_takedowns enable row level security;
-- No client policy: managed only through the admin RPCs.

-- Private (non-RPC-exposed) helper, same reasoning as the sanction helpers above.
drop function if exists public.content_taken_down(text, uuid);
create or replace function private.content_taken_down(p_type text, p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.content_takedowns t
    where t.content_type = p_type and t.content_id = p_id and t.active
  );
$$;
grant execute on function private.content_taken_down(text, uuid) to authenticated, anon;


-- ════════════════════════════════════════════════════════════════════════════
-- 7) SERVER-SIDE ENFORCEMENT (restrictive RLS)
--    These AND with the existing permissive policies — mirroring the account_hidden
--    pattern. Every rule is keyed on a NEW table that starts EMPTY, so applying this
--    section changes NOTHING until a moderator sanctions a user or takes content
--    down. Owners always keep their own SELECT (except for taken-down items, which
--    vanish for everyone — a takedown is a full removal, preserved only for review).
--
--    ⚠ These touch the live app's read AND write path. After running, smoke-test as
--    a NORMAL (non-sanctioned) user: viewing feeds, and creating a post / comment /
--    DM should all still work exactly as before (the helpers return false for
--    everyone while the tables are empty).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 7a) Hide a shadow-banned / banned author's content (SELECT) ───────────────
drop policy if exists "Sanctioned authors' posts are invisible" on public.posts;
create policy "Sanctioned authors' posts are invisible"
  on public.posts as restrictive for select
  using (user_id = auth.uid() or not private.user_content_hidden(user_id));

drop policy if exists "Sanctioned authors' stories are invisible" on public.stories;
create policy "Sanctioned authors' stories are invisible"
  on public.stories as restrictive for select
  using (user_id = auth.uid() or not private.user_content_hidden(user_id));

drop policy if exists "Sanctioned authors' playlists are invisible" on public.playlists;
create policy "Sanctioned authors' playlists are invisible"
  on public.playlists as restrictive for select
  using (user_id = auth.uid() or not private.user_content_hidden(user_id));

-- ── 7b) Hide individually taken-down items (SELECT) from OTHERS ───────────────
--    The author keeps seeing their own item (`user_id = auth.uid() or …`), same as
--    account_hidden. Without that exception a taken-down row is invisible to its
--    owner, so the app's `delete().eq('id',…)` matches 0 rows (RLS SELECT is checked
--    on delete's WHERE) — the owner "deletes" it, nothing happens, and a later
--    admin_restore_content resurrects content the owner thought was gone. Keeping it
--    owner-visible lets them still delete it; evidence that must survive deletion is
--    frozen with legal_hold, not a takedown.
drop policy if exists "Taken-down posts are invisible" on public.posts;
create policy "Taken-down posts are invisible"
  on public.posts as restrictive for select
  using (user_id = auth.uid() or not private.content_taken_down('post', id));

drop policy if exists "Taken-down stories are invisible" on public.stories;
create policy "Taken-down stories are invisible"
  on public.stories as restrictive for select
  using (user_id = auth.uid() or not private.content_taken_down('story', id));

drop policy if exists "Taken-down listings are invisible" on public.shop_listings;
create policy "Taken-down listings are invisible"
  on public.shop_listings as restrictive for select
  using (user_id = auth.uid() or not private.content_taken_down('shop_listing', id));

-- ── 7c) Block a suspended / banned user from creating new content (INSERT) ─────
drop policy if exists "Blocked users cannot post" on public.posts;
create policy "Blocked users cannot post"
  on public.posts as restrictive for insert
  with check (not private.user_posting_blocked(auth.uid()));

drop policy if exists "Blocked users cannot post stories" on public.stories;
create policy "Blocked users cannot post stories"
  on public.stories as restrictive for insert
  with check (not private.user_posting_blocked(auth.uid()));

drop policy if exists "Blocked users cannot message" on public.messages;
create policy "Blocked users cannot message"
  on public.messages as restrictive for insert
  with check (not private.user_posting_blocked(auth.uid()));

-- ── 7d) comments — the base `comments` table is NOT defined in supabase/sql (it
--    predates this file / was made in the dashboard), so we don't know if RLS is
--    on. `create policy` never errors when RLS is off, it just does NOTHING — which
--    would make comment takedown / comment-blocking SILENTLY not enforce. So we
--    create the two comment policies ONLY when RLS is actually enabled on comments,
--    and print a NOTICE telling you how to turn it on otherwise.
do $$
begin
  if exists (select 1 from pg_class where oid = 'public.comments'::regclass and relrowsecurity) then
    -- shadow-ban: hide a sanctioned author's comments from others. Shadow-banned
    -- users are deliberately still allowed to comment (user_posting_blocked excludes
    -- them), so WITHOUT this their comments would stay visible to everyone — the exact
    -- abuse the shadow-ban is meant to silence.
    drop policy if exists "Sanctioned authors' comments are invisible" on public.comments;
    create policy "Sanctioned authors' comments are invisible"
      on public.comments as restrictive for select
      using (user_id = auth.uid() or not private.user_content_hidden(user_id));

    -- individual comment takedown (owner still sees their own; see 7b rationale)
    drop policy if exists "Taken-down comments are invisible" on public.comments;
    create policy "Taken-down comments are invisible"
      on public.comments as restrictive for select
      using (user_id = auth.uid() or not private.content_taken_down('comment', id));

    drop policy if exists "Blocked users cannot comment" on public.comments;
    create policy "Blocked users cannot comment"
      on public.comments as restrictive for insert
      with check (not private.user_posting_blocked(auth.uid()));
  else
    raise notice 'comments RLS is OFF — comment takedown + comment shadow-ban/blocking are NOT enforced. Enable RLS on public.comments (with its existing read/write policies) then re-run this file to activate them.';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- Done with Phase 1a. NEXT: run supabase/sql/admin_console_rpcs.sql.
--
-- Then come back and do this ONE manual step — promote your account to 'owner'
-- (find your id first). Everyone in laybell_admins is a 'reviewer' until promoted:
--
--   select id, email from auth.users where email = 'you@example.com';
--
--   insert into public.laybell_admins (user_id, role)
--     values ('<YOUR-AUTH-USER-ID>', 'owner')
--     on conflict (user_id) do update set role = 'owner', disabled_at = null;
-- ════════════════════════════════════════════════════════════════════════════
