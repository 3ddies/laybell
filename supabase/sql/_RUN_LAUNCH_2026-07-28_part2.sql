-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — every pending migration, in dependency order. Generated 2026-07-28.
--
-- HOW TO RUN: paste a PART into the Supabase Dashboard → SQL Editor and Run.
-- Run the parts IN ORDER and let each finish before starting the next — later
-- files depend on objects earlier ones create.
--
-- Everything here is idempotent, so re-running a part you already applied is
-- safe. If you are unsure what has been applied, run all parts top to bottom.
--
-- Source of truth for the ordering: docs/LAUNCH_CHECKLIST.md §3.1
-- ════════════════════════════════════════════════════════════════════════════

-- ─── PART 2 of 3 ─────────────────────────────────────────────
-- Files in this part, in order:
--   1. admin_console_rpcs.sql  (AFTER admin_console)
--   2. originality.sql  (AFTER admin_console_rpcs)
--   3. donations.sql  (re-run — adds the message column)
--   4. studio_live.sql  (AFTER donations — rewrites donation_guard v3)
--   5. live_heartbeat.sql

-- ══════════════════════════════════════════════════════════════════════════
-- admin_console_rpcs.sql  ·  AFTER admin_console
-- ══════════════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- LAYBELL — ADMIN / MODERATION CONSOLE  ·  Phase 1b: the admin RPCs
-- Paste this WHOLE file into the Supabase Dashboard → SQL Editor and Run.
-- REQUIRES admin_console.sql (Phase 1a) to have been run first.
--
-- Every function here is SECURITY DEFINER and GRANTed to `authenticated`, but each
-- one GUARDS on the caller's role via has_admin_role(auth.uid(), …) and raises
-- 'not_admin' otherwise — the exact pattern community_moderate() uses. auth.uid()
-- is the CALLER (from their JWT), independent of SECURITY DEFINER, so the guard is
-- real. Reporter identity is NEVER returned to a moderator/reviewer — only an owner.
-- Every state-changing RPC writes an admin_audit_log row in the SAME transaction.
--
-- Role tiers:  reviewer  → read the queue + evidence + audit log
--              moderator → resolve, warn, suspend, shadow-ban, hide account/content,
--                          set legal-hold, escalate, manage the link blocklist
--              owner     → all of the above + RELEASE legal-hold + grant/revoke admins
--   (login-ban / unban / hard-delete + reading auth.users email live in the
--    admin-actions EDGE FUNCTION, which needs the Supabase Admin API.)
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from information_schema.routines
                 where routine_schema = 'public' and routine_name = 'has_admin_role') then
    raise exception 'Run admin_console.sql first (has_admin_role / the admin schema are missing).';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- READ  ·  admin_list_queue — the unified, de-duplicated moderation queue.
-- Derived LIVE from the six report tables (UNION-normalized, grouped by subject),
-- left-joined onto moderation_cases for workflow state. reporter_id is never
-- selected. By default only subjects with at least one OPEN (unresolved) report
-- show; pass p_include_resolved => true to see closed ones too.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_list_queue(
  p_include_resolved boolean default false,
  p_limit            integer default 100,
  p_offset           integer default 0
) returns table (
  subject_type      text,
  subject_id        text,
  subject_user_id   uuid,
  report_count      bigint,
  open_count        bigint,
  first_reported_at timestamptz,
  last_reported_at  timestamptz,
  reasons           text[],
  case_id           uuid,
  case_status       text,
  severity          text,
  assignee_id       uuid,
  has_notes         boolean
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then
    raise exception 'not_admin';
  end if;

  return query
  with raw as (
    select 'post'::text as st,
           coalesce(pr.post_id::text, 'report:' || pr.id::text) as sid,
           pr.reported_user_id as suid, pr.reason, pr.created_at, pr.resolved_at
      from public.post_reports pr
    union all
    select 'user',
           coalesce(ur.reported_id::text, 'report:' || ur.id::text),
           ur.reported_id, ur.reason, ur.created_at, ur.resolved_at
      from public.user_reports ur
    union all
    select 'conversation',
           coalesce(cr.conversation_id::text, 'report:' || cr.id::text),
           cr.reported_user_id, cr.reason, cr.created_at, cr.resolved_at
      from public.conversation_reports cr
    union all
    select 'shop_listing',
           coalesce(sr.listing_id::text, 'report:' || sr.id::text),
           sr.seller_id, sr.reason, sr.created_at, sr.resolved_at
      from public.shop_reports sr
    union all
    select 'ad',
           coalesce(ar.campaign_id::text, 'report:' || ar.id::text),
           ar.reported_user_id, ar.reason, ar.created_at, ar.resolved_at
      from public.ad_reports ar
    union all
    select 'domain',
           coalesce(lr.host, 'report:' || lr.id::text),
           null::uuid, array_to_string(lr.reasons, ', '), lr.created_at, lr.resolved_at
      from public.link_reports lr
  ),
  agg as (
    select r.st as subject_type,
           r.sid as subject_id,
           (array_agg(r.suid) filter (where r.suid is not null))[1] as subject_user_id,
           count(*) as report_count,
           count(*) filter (where r.resolved_at is null) as open_count,
           min(r.created_at) as first_reported_at,
           max(r.created_at) as last_reported_at,
           array_agg(distinct r.reason) filter (where r.reason is not null) as reasons
      from raw r
     group by r.st, r.sid
  )
  select a.subject_type, a.subject_id, a.subject_user_id,
         a.report_count, a.open_count, a.first_reported_at, a.last_reported_at, a.reasons,
         c.id, c.status, c.severity, c.assignee_id, (c.notes is not null and c.notes <> '')
    from agg a
    left join public.moderation_cases c
      on c.subject_type = a.subject_type and c.subject_id = a.subject_id
   where p_include_resolved or a.open_count > 0
   order by a.open_count desc, a.last_reported_at desc
   limit greatest(0, coalesce(p_limit, 100))
  offset greatest(0, coalesce(p_offset, 0));
end $$;
revoke execute on function public.admin_list_queue(boolean, integer, integer) from public;
grant  execute on function public.admin_list_queue(boolean, integer, integer) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ  ·  admin_get_case — every report about one subject, with tamper-proof
-- snapshots, plus its workflow row. reporter_id is redacted unless the caller is
-- an OWNER (de-anonymizing a reporter is an owner-only, audited step).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_get_case(
  p_subject_type text,
  p_subject_id   text
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_can_deanon boolean := public.has_admin_role(auth.uid(), 'owner');
  v_reports    jsonb;
  v_case       jsonb;
  -- A subject whose content was DELETED is keyed 'report:<uuid>' by admin_list_queue
  -- (its content FK went null but the report + snapshot survive). Match those by the
  -- report's own id so preserved evidence stays viewable and resolvable.
  v_by_report  boolean := p_subject_id like 'report:%';
  v_rid        uuid;
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then
    raise exception 'not_admin';
  end if;
  -- parse input AFTER the auth guard (a malformed 'report:x' must 401, not 22P02)
  if v_by_report then v_rid := substring(p_subject_id from 8)::uuid; end if;

  if p_subject_type = 'post' then
    select jsonb_agg(jsonb_build_object(
             'id', pr.id, 'reason', pr.reason, 'created_at', pr.created_at,
             'resolved_at', pr.resolved_at, 'snapshot', pr.content_snapshot,
             'reporter_id', case when v_can_deanon then pr.reporter_id else null end))
      into v_reports from public.post_reports pr
     where (v_by_report and pr.id = v_rid) or (not v_by_report and pr.post_id::text = p_subject_id);
  elsif p_subject_type = 'user' then
    select jsonb_agg(jsonb_build_object(
             'id', ur.id, 'reason', ur.reason, 'created_at', ur.created_at,
             'resolved_at', ur.resolved_at, 'snapshot', ur.reported_snapshot,
             'reporter_id', case when v_can_deanon then ur.reporter_id else null end))
      into v_reports from public.user_reports ur
     where (v_by_report and ur.id = v_rid) or (not v_by_report and ur.reported_id::text = p_subject_id);
  elsif p_subject_type = 'conversation' then
    select jsonb_agg(jsonb_build_object(
             'id', cr.id, 'reason', cr.reason, 'created_at', cr.created_at,
             'resolved_at', cr.resolved_at, 'snapshot', cr.conversation_snapshot,
             'reporter_id', case when v_can_deanon then cr.reporter_id else null end))
      into v_reports from public.conversation_reports cr
     where (v_by_report and cr.id = v_rid) or (not v_by_report and cr.conversation_id::text = p_subject_id);
  elsif p_subject_type = 'shop_listing' then
    select jsonb_agg(jsonb_build_object(
             'id', sr.id, 'reason', sr.reason, 'created_at', sr.created_at,
             'resolved_at', sr.resolved_at, 'snapshot', sr.reported_snapshot,
             'reporter_id', case when v_can_deanon then sr.reporter_id else null end))
      into v_reports from public.shop_reports sr
     where (v_by_report and sr.id = v_rid) or (not v_by_report and sr.listing_id::text = p_subject_id);
  elsif p_subject_type = 'ad' then
    select jsonb_agg(jsonb_build_object(
             'id', ar.id, 'reason', ar.reason, 'created_at', ar.created_at,
             'resolved_at', ar.resolved_at, 'snapshot', ar.creative_snapshot,
             'reporter_id', case when v_can_deanon then ar.reporter_id else null end))
      into v_reports from public.ad_reports ar
     where (v_by_report and ar.id = v_rid) or (not v_by_report and ar.campaign_id::text = p_subject_id);
  elsif p_subject_type = 'domain' then
    select jsonb_agg(jsonb_build_object(
             'id', lr.id, 'reason', array_to_string(lr.reasons, ', '), 'created_at', lr.created_at,
             'resolved_at', lr.resolved_at,
             'snapshot', jsonb_build_object('url', lr.url, 'host', lr.host, 'context', lr.context, 'verdict', lr.verdict, 'reasons', lr.reasons),
             'reporter_id', case when v_can_deanon then lr.reporter_id else null end))
      into v_reports from public.link_reports lr
     where (v_by_report and lr.id = v_rid) or (not v_by_report and lr.host = p_subject_id);
  else
    raise exception 'unknown subject_type: %', p_subject_type;
  end if;

  select to_jsonb(c) into v_case from public.moderation_cases c
   where c.subject_type = p_subject_type and c.subject_id = p_subject_id;

  return jsonb_build_object(
    'subject_type', p_subject_type,
    'subject_id',   p_subject_id,
    'can_deanonymize', v_can_deanon,
    'reports',      coalesce(v_reports, '[]'::jsonb),
    'case',         v_case
  );
end $$;
revoke execute on function public.admin_get_case(text, text) from public;
grant  execute on function public.admin_get_case(text, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ  ·  admin_user_detail — investigator view of one account. profile + sanction
-- state + open-report counts + content tallies for any reviewer; email / last sign-in
-- / auth-ban status ONLY for owners (least privilege). Logs the evidence access.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_user_detail(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_owner boolean := public.has_admin_role(auth.uid(), 'owner');
  v_out   jsonb;
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then
    raise exception 'not_admin';
  end if;

  select jsonb_build_object(
    'profile', (select jsonb_build_object(
        'id', p.id, 'username', p.username, 'display_name', p.display_name,
        'avatar_url', p.avatar_url, 'bio', p.bio, 'link', p.link,
        'badge_tier', p.badge_tier, 'is_minor', p.is_minor, 'age', p.age,
        'hidden', p.hidden, 'legal_hold', p.legal_hold,
        'delete_requested_at', p.delete_requested_at, 'last_seen_at', p.last_seen_at)
      from public.profiles p where p.id = p_user),
    'sanction', (select to_jsonb(s) from public.user_sanctions s where s.user_id = p_user),
    'open_reports', jsonb_build_object(
        'user', (select count(*) from public.user_reports ur where ur.reported_id = p_user and ur.resolved_at is null),
        'post', (select count(*) from public.post_reports pr where pr.reported_user_id = p_user and pr.resolved_at is null)),
    'content', jsonb_build_object(
        'posts',   (select count(*) from public.posts   x where x.user_id = p_user),
        'stories', (select count(*) from public.stories x where x.user_id = p_user)),
    'legal_hold_posts', (select count(*) from public.posts x where x.user_id = p_user and coalesce(x.legal_hold,false)),
    -- owner-only auth-plane fields (email / sign-in / ban) — null for reviewers/moderators
    'auth', case when v_owner then (
        select jsonb_build_object('email', u.email, 'created_at', u.created_at,
               'last_sign_in_at', u.last_sign_in_at, 'banned_until', u.banned_until)
        from auth.users u where u.id = p_user)
      else null end
  ) into v_out;

  perform public.admin_log(auth.uid(), 'view_evidence', 'user', p_user::text, p_user, null,
                           null, jsonb_build_object('owner_view', v_owner));
  return v_out;
end $$;
revoke execute on function public.admin_user_detail(uuid) from public;
grant  execute on function public.admin_user_detail(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE  ·  case workflow
-- ════════════════════════════════════════════════════════════════════════════

-- Resolve every report on a subject (action taken OR dismissed) + close the case.
create or replace function public.admin_resolve_report(
  p_subject_type text, p_subject_id text,
  p_action_taken text default null, p_dismiss boolean default false, p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_status text := case when p_dismiss then 'dismissed' else 'actioned' end;
  -- orphaned (deleted-content) subjects are keyed 'report:<uuid>' — resolve them by
  -- the report's own id so they can actually be closed and stop blocking deletion.
  v_by_report boolean := p_subject_id like 'report:%';
  v_rid uuid;
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  -- parse input AFTER the auth guard (a malformed 'report:x' must 401, not 22P02)
  if v_by_report then v_rid := substring(p_subject_id from 8)::uuid; end if;

  if    p_subject_type = 'post'         then update public.post_reports         set resolved_at = now() where resolved_at is null and ((v_by_report and id = v_rid) or (not v_by_report and post_id::text = p_subject_id));
  elsif p_subject_type = 'user'         then update public.user_reports         set resolved_at = now() where resolved_at is null and ((v_by_report and id = v_rid) or (not v_by_report and reported_id::text = p_subject_id));
  elsif p_subject_type = 'conversation' then update public.conversation_reports set resolved_at = now() where resolved_at is null and ((v_by_report and id = v_rid) or (not v_by_report and conversation_id::text = p_subject_id));
  elsif p_subject_type = 'shop_listing' then update public.shop_reports         set resolved_at = now() where resolved_at is null and ((v_by_report and id = v_rid) or (not v_by_report and listing_id::text = p_subject_id));
  elsif p_subject_type = 'ad'           then update public.ad_reports           set resolved_at = now() where resolved_at is null and ((v_by_report and id = v_rid) or (not v_by_report and campaign_id::text = p_subject_id));
  elsif p_subject_type = 'domain'       then update public.link_reports         set resolved_at = now() where resolved_at is null and ((v_by_report and id = v_rid) or (not v_by_report and host = p_subject_id));
  else raise exception 'unknown subject_type: %', p_subject_type; end if;

  insert into public.moderation_cases (subject_type, subject_id, status, action_taken, notes, resolved_by, resolved_at, first_reported_at)
  values (p_subject_type, p_subject_id, v_status, p_action_taken, p_note, v_uid, now(), now())
  on conflict (subject_type, subject_id) do update
    set status = v_status, action_taken = coalesce(p_action_taken, moderation_cases.action_taken),
        notes = coalesce(p_note, moderation_cases.notes),
        resolved_by = v_uid, resolved_at = now(), updated_at = now();

  perform public.admin_log(v_uid, 'resolve_report', p_subject_type, p_subject_id, null,
                           p_subject_type || ':' || p_subject_id, p_note,
                           jsonb_build_object('status', v_status, 'action_taken', p_action_taken));
end $$;
revoke execute on function public.admin_resolve_report(text, text, text, boolean, text) from public;
grant  execute on function public.admin_resolve_report(text, text, text, boolean, text) to authenticated;

-- Assign / re-open / set severity / add private notes on a case (upsert).
create or replace function public.admin_update_case(
  p_subject_type text, p_subject_id text, p_subject_user uuid default null,
  p_status text default null, p_severity text default null,
  p_assignee uuid default null, p_notes text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;

  insert into public.moderation_cases (subject_type, subject_id, subject_user_id, status, severity, assignee_id, notes, first_reported_at)
  values (p_subject_type, p_subject_id, p_subject_user,
          coalesce(p_status, 'investigating'), coalesce(p_severity, 'medium'),
          coalesce(p_assignee, v_uid), p_notes, now())
  on conflict (subject_type, subject_id) do update
    set subject_user_id = coalesce(p_subject_user, moderation_cases.subject_user_id),
        status   = coalesce(p_status,  moderation_cases.status),
        severity = coalesce(p_severity, moderation_cases.severity),
        assignee_id = coalesce(p_assignee, moderation_cases.assignee_id),
        notes    = coalesce(p_notes,   moderation_cases.notes),
        updated_at = now();

  perform public.admin_log(v_uid, 'update_case', p_subject_type, p_subject_id, p_subject_user,
                           p_subject_type || ':' || p_subject_id, p_notes,
                           jsonb_build_object('status', p_status, 'severity', p_severity, 'assignee', p_assignee));
end $$;
revoke execute on function public.admin_update_case(text, text, uuid, text, text, uuid, text) from public;
grant  execute on function public.admin_update_case(text, text, uuid, text, text, uuid, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE  ·  account sanctions (warn / suspend / shadow-ban / hide / lift)
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.admin_warn_user(p_user uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  insert into public.user_sanctions (user_id, state, strike_count, reason, actor_id)
  values (p_user, 'warned', 1, p_reason, v_uid)
  on conflict (user_id) do update
    set strike_count = user_sanctions.strike_count + 1, reason = p_reason, actor_id = v_uid, updated_at = now(),
        state = case when user_sanctions.state = 'active' then 'warned' else user_sanctions.state end;
  perform public.admin_log(v_uid, 'warn', 'user', p_user::text, p_user, null, p_reason, null);
end $$;
revoke execute on function public.admin_warn_user(uuid, text) from public;
grant  execute on function public.admin_warn_user(uuid, text) to authenticated;

create or replace function public.admin_suspend_user(p_user uuid, p_minutes integer, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_until timestamptz := now() + make_interval(mins => greatest(1, p_minutes));
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  insert into public.user_sanctions (user_id, state, suspended_until, reason, actor_id)
  values (p_user, 'suspended', v_until, p_reason, v_uid)
  on conflict (user_id) do update
    set state = 'suspended', suspended_until = v_until, reason = p_reason, actor_id = v_uid, updated_at = now();
  perform public.admin_log(v_uid, 'suspend', 'user', p_user::text, p_user, null, p_reason,
                           jsonb_build_object('minutes', p_minutes, 'until', v_until));
end $$;
revoke execute on function public.admin_suspend_user(uuid, integer, text) from public;
grant  execute on function public.admin_suspend_user(uuid, integer, text) to authenticated;

create or replace function public.admin_shadowban_user(p_user uuid, p_on boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  insert into public.user_sanctions (user_id, state, reason, actor_id)
  values (p_user, case when p_on then 'shadow_banned' else 'active' end, p_reason, v_uid)
  on conflict (user_id) do update
    set state = case when p_on then 'shadow_banned' else 'active' end,
        suspended_until = case when p_on then user_sanctions.suspended_until else null end,
        reason = p_reason, actor_id = v_uid, updated_at = now();
  perform public.admin_log(v_uid, case when p_on then 'shadow_ban' else 'restore' end,
                           'user', p_user::text, p_user, null, p_reason, null);
end $$;
revoke execute on function public.admin_shadowban_user(uuid, boolean, text) from public;
grant  execute on function public.admin_shadowban_user(uuid, boolean, text) to authenticated;

-- Lift a warn / suspend / shadow-ban back to 'active'. (An auth login-ban is lifted
-- by the admin-actions edge function, which also clears auth.users.ban_duration.)
create or replace function public.admin_lift_sanction(p_user uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  update public.user_sanctions
     set state = 'active', suspended_until = null, reason = p_reason, actor_id = v_uid, updated_at = now()
   where user_id = p_user;
  perform public.admin_log(v_uid, 'restore', 'user', p_user::text, p_user, null, p_reason,
                           jsonb_build_object('sanction', 'lifted'));
end $$;
revoke execute on function public.admin_lift_sanction(uuid, text) from public;
grant  execute on function public.admin_lift_sanction(uuid, text) to authenticated;

-- Hide / unhide a whole account app-wide (reuses account_hidden.sql's invisibility).
create or replace function public.admin_hide_account(p_user uuid, p_on boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  update public.profiles set hidden = p_on where id = p_user;
  perform public.admin_log(v_uid, case when p_on then 'hide_account' else 'restore' end,
                           'user', p_user::text, p_user, null, p_reason, null);
end $$;
revoke execute on function public.admin_hide_account(uuid, boolean, text) from public;
grant  execute on function public.admin_hide_account(uuid, boolean, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE  ·  content takedown / restore  (reversible soft-remove)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_hide_content(p_type text, p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_owner uuid;
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  if    p_type = 'post'         then select user_id into v_owner from public.posts         where id = p_id;
  elsif p_type = 'story'        then select user_id into v_owner from public.stories       where id = p_id;
  elsif p_type = 'comment'      then select user_id into v_owner from public.comments      where id = p_id;
  elsif p_type = 'shop_listing' then select user_id into v_owner from public.shop_listings where id = p_id;
  else raise exception 'unsupported content_type: %', p_type; end if;

  insert into public.content_takedowns (content_type, content_id, owner_id, active, reason, actor_id)
  values (p_type, p_id, v_owner, true, p_reason, v_uid)
  on conflict (content_type, content_id) do update
    set active = true, reason = p_reason, actor_id = v_uid, restored_at = null, restored_by = null;

  perform public.admin_log(v_uid, 'hide_content', p_type, p_id::text, v_owner, null, p_reason, null);
end $$;
revoke execute on function public.admin_hide_content(text, uuid, text) from public;
grant  execute on function public.admin_hide_content(text, uuid, text) to authenticated;

create or replace function public.admin_restore_content(p_type text, p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  update public.content_takedowns
     set active = false, restored_at = now(), restored_by = v_uid
   where content_type = p_type and content_id = p_id;
  perform public.admin_log(v_uid, 'restore', p_type, p_id::text, null, null, p_reason, null);
end $$;
revoke execute on function public.admin_restore_content(text, uuid, text) from public;
grant  execute on function public.admin_restore_content(text, uuid, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE  ·  legal hold (preserve evidence)  &  escalation
-- Setting a hold = moderator+ (preserving is always safe). RELEASING a hold =
-- owner-only (letting evidence be deleted again is the dangerous direction).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_set_legal_hold(p_type text, p_id uuid, p_on boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if p_on then
    if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  else
    if not public.has_admin_role(v_uid, 'owner') then raise exception 'owner_only'; end if;
  end if;

  if    p_type = 'post' then update public.posts    set legal_hold = p_on where id = p_id;
  elsif p_type = 'user' then update public.profiles set legal_hold = p_on where id = p_id;
  else raise exception 'legal hold supports post | user, not %', p_type; end if;

  perform public.admin_log(v_uid, case when p_on then 'legal_hold_set' else 'legal_hold_release' end,
                           p_type, p_id::text, case when p_type='user' then p_id else null end, null, p_reason, null);
end $$;
revoke execute on function public.admin_set_legal_hold(text, uuid, boolean, text) from public;
grant  execute on function public.admin_set_legal_hold(text, uuid, boolean, text) to authenticated;

-- Escalate a case (severity→critical, route to owner/legal/ncmec) and auto-freeze
-- the subject as evidence via legal_hold when it is a post or a user.
create or replace function public.admin_escalate_case(
  p_subject_type text, p_subject_id text, p_to text, p_reason text
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;

  insert into public.moderation_cases (subject_type, subject_id, status, severity, escalated_to, notes, first_reported_at)
  values (p_subject_type, p_subject_id, 'escalated', 'critical', p_to, p_reason, now())
  on conflict (subject_type, subject_id) do update
    set status = 'escalated', severity = 'critical', escalated_to = p_to,
        notes = coalesce(p_reason, moderation_cases.notes), updated_at = now();

  -- auto legal-hold the subject so escalated evidence can't be deleted away
  begin
    if p_subject_type = 'post' then
      update public.posts set legal_hold = true where id = p_subject_id::uuid;
    elsif p_subject_type = 'user' then
      update public.profiles set legal_hold = true where id = p_subject_id::uuid;
    end if;
  exception when invalid_text_representation then
    null;  -- non-uuid subject (e.g. a domain) — nothing to hold
  end;

  perform public.admin_log(v_uid, 'escalate', p_subject_type, p_subject_id, null,
                           p_subject_type || ':' || p_subject_id, p_reason,
                           jsonb_build_object('escalated_to', p_to));
end $$;
revoke execute on function public.admin_escalate_case(text, text, text, text) from public;
grant  execute on function public.admin_escalate_case(text, text, text, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE  ·  link blocklist (outbound-domain enforcement)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_blocklist_add(p_domain text, p_severity text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  insert into public.blocked_link_domains (domain, reason, severity, added_by)
  values (lower(trim(p_domain)), p_reason, coalesce(p_severity, 'block'), v_uid)
  on conflict (domain) do update set reason = p_reason, severity = coalesce(p_severity, 'block'), added_by = v_uid;
  perform public.admin_log(v_uid, 'blocklist_add', 'domain', lower(trim(p_domain)), null, null, p_reason,
                           jsonb_build_object('severity', coalesce(p_severity, 'block')));
end $$;
revoke execute on function public.admin_blocklist_add(text, text, text) from public;
grant  execute on function public.admin_blocklist_add(text, text, text) to authenticated;

create or replace function public.admin_blocklist_remove(p_domain text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;
  delete from public.blocked_link_domains where domain = lower(trim(p_domain));
  perform public.admin_log(v_uid, 'blocklist_remove', 'domain', lower(trim(p_domain)), null, null, null, null);
end $$;
revoke execute on function public.admin_blocklist_remove(text) from public;
grant  execute on function public.admin_blocklist_remove(text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ  ·  admin_list_audit — the moderation audit trail (reviewer+). Filter by a
-- target account, or pass null for the global feed.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_list_audit(
  p_target_user uuid default null, p_limit integer default 100, p_offset integer default 0
) returns setof public.admin_audit_log language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then raise exception 'not_admin'; end if;
  return query
    select * from public.admin_audit_log
     where p_target_user is null or target_user_id = p_target_user
     order by created_at desc
     limit greatest(0, coalesce(p_limit, 100)) offset greatest(0, coalesce(p_offset, 0));
end $$;
revoke execute on function public.admin_list_audit(uuid, integer, integer) from public;
grant  execute on function public.admin_list_audit(uuid, integer, integer) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE  ·  admin roster management (OWNER ONLY)
-- Grant/adjust a role or soft-revoke an admin. You cannot change your OWN row here
-- (prevents an owner from accidentally locking themselves out); manage your own
-- role via the manual SQL step in admin_console.sql.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_grant_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'owner') then raise exception 'owner_only'; end if;
  if p_user = v_uid then raise exception 'cannot change your own role here'; end if;
  if p_role not in ('owner', 'moderator', 'reviewer') then raise exception 'invalid role'; end if;
  insert into public.laybell_admins (user_id, role, added_by)
  values (p_user, p_role, v_uid)
  on conflict (user_id) do update set role = p_role, disabled_at = null, added_by = v_uid;
  perform public.admin_log(v_uid, 'grant_role', 'user', p_user::text, p_user, null, null,
                           jsonb_build_object('role', p_role));
end $$;
revoke execute on function public.admin_grant_role(uuid, text) from public;
grant  execute on function public.admin_grant_role(uuid, text) to authenticated;

create or replace function public.admin_revoke_admin(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.has_admin_role(v_uid, 'owner') then raise exception 'owner_only'; end if;
  if p_user = v_uid then raise exception 'cannot revoke yourself'; end if;
  update public.laybell_admins set disabled_at = now() where user_id = p_user;
  perform public.admin_log(v_uid, 'revoke_admin', 'user', p_user::text, p_user, null, null, null);
end $$;
revoke execute on function public.admin_revoke_admin(uuid) from public;
grant  execute on function public.admin_revoke_admin(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- Done with Phase 1b. The privileged BACKEND is now complete except for the auth-
-- plane actions (login-ban / unban / hard-delete / read email) — those live in the
-- admin-actions EDGE FUNCTION. See docs/ADMIN_CONSOLE.md to deploy it, then build
-- the console UI (Phase 2).
-- ════════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- originality.sql  ·  AFTER admin_console_rpcs
-- ══════════════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- ORIGINALITY DEMOTION  ·  Community Guidelines §7 "Originality and reposting"
--
-- The Guidelines deliberately make originality a DISTRIBUTION question, not a
-- removal one: "our normal response is to limit reach, which means the post
-- stays up but is not recommended as widely." This file is that mechanism.
--
-- Run AFTER admin_console.sql + admin_console_rpcs.sql (it uses has_admin_role
-- and admin_log from those). Idempotent and additive: with no post flagged, the
-- multiplier is 1.0 everywhere and ranking is bit-for-bit unchanged.
--
-- WHY THE FLAG IS CLIENT-READABLE (a deliberate choice, unlike shadow-bans):
-- feed ranking runs in the APP (lib/feedScorer.ts), so the client must be able
-- to read the flag to apply it. Shadow-ban state is hidden behind private.*
-- helpers precisely so clients can't probe it; this is the opposite case on
-- purpose. A limited post is a published, appealable moderation decision under
-- §12/§13 of the Guidelines, not a secret one — so being able to see it is
-- consistent, not a leak. Do NOT "fix" this by hiding it without also moving
-- ranking server-side.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.posts
  add column if not exists originality_limited boolean not null default false,
  add column if not exists originality_reason  text,
  add column if not exists originality_note    text,
  add column if not exists originality_by      uuid,
  add column if not exists originality_at      timestamptz;

comment on column public.posts.originality_limited is
  'Moderator-set. Post stays visible; lib/feedScorer applies ORIGINALITY_LIMIT_MUL so it is recommended less. Client-readable on purpose (ranking runs in the app).';
comment on column public.posts.originality_reason is
  'One of the three enforceable tiers in Guidelines §7: watermark | duplicate | reupload | other.';

-- Partial index: the console lists currently-limited posts, and the set is small.
create index if not exists posts_originality_limited_idx
  on public.posts (originality_at desc) where originality_limited;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE · flag / unflag a post for originality
-- moderator+ (same bar as hide_content). A reason is REQUIRED when limiting and
-- constrained to the published tiers, so the audit log stays consistent enough
-- to review decisions against each other later.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_set_originality(
  p_post_id uuid, p_limited boolean, p_reason text, p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_owner uuid;
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;

  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then raise exception 'post_not_found'; end if;

  if p_limited and coalesce(p_reason, '') not in ('watermark', 'duplicate', 'reupload', 'other') then
    raise exception 'reason must be one of: watermark, duplicate, reupload, other';
  end if;

  update public.posts
     set originality_limited = p_limited,
         originality_reason  = case when p_limited then p_reason else null end,
         originality_note    = case when p_limited then nullif(btrim(coalesce(p_note, '')), '') else null end,
         originality_by      = case when p_limited then v_uid else null end,
         originality_at      = case when p_limited then now()  else null end
   where id = p_post_id;

  perform public.admin_log(
    v_uid,
    case when p_limited then 'originality_limit' else 'originality_clear' end,
    'post', p_post_id::text, v_owner, null, p_reason,
    case when p_note is null then null else jsonb_build_object('note', p_note) end);
end $$;
revoke execute on function public.admin_set_originality(uuid, boolean, text, text) from public;
grant  execute on function public.admin_set_originality(uuid, boolean, text, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ · one post, everything a moderator needs to decide, in ONE round-trip
--
-- Returns the post itself, its author, live engagement counts, every moderation
-- state that applies to it, and the RANKING COMPONENTS.
--
-- On ranking: there is NO single "score" for a post. lib/feedScorer.scorePost is
-- VIEWER-SPECIFIC — creator/type/genre affinity, whether the viewer follows the
-- author, and whether they've already seen it all multiply in. So this returns
-- the viewer-INDEPENDENT components only (engagement, age, badge tier,
-- originality). The console renders those plus a "base score" and labels the
-- per-viewer multipliers as varying. Anything presented as one absolute score
-- would be a fiction.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_post_detail(p_post_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then raise exception 'not_admin'; end if;

  select jsonb_build_object(
    'post', (select jsonb_build_object(
        'id', p.id, 'user_id', p.user_id, 'type', p.type, 'caption', p.caption,
        'media_url', p.media_url, 'thumbnail_url', p.thumbnail_url, 'cover_url', p.cover_url,
        'genre', p.genre, 'is_public', p.is_public, 'created_at', p.created_at,
        'aspect_ratio', p.aspect_ratio, 'duration_seconds', p.duration_seconds,
        'video_status', p.video_status, 'legal_hold', coalesce(p.legal_hold, false),
        'song_title', p.song_title, 'song_artist', p.song_artist)
      from public.posts p where p.id = p_post_id),

    'author', (select jsonb_build_object(
        'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
        'avatar_url', pr.avatar_url, 'badge_tier', pr.badge_tier,
        'hidden', pr.hidden, 'is_minor', pr.is_minor)
      from public.profiles pr
      join public.posts p2 on p2.user_id = pr.id
      where p2.id = p_post_id),

    'originality', (select jsonb_build_object(
        'limited', coalesce(p.originality_limited, false),
        'reason',  p.originality_reason,
        'note',    p.originality_note,
        'at',      p.originality_at,
        'by',      (select a.username from public.profiles a where a.id = p.originality_by))
      from public.posts p where p.id = p_post_id),

    'taken_down', (select jsonb_build_object('active', t.active, 'reason', t.reason, 'at', t.created_at)
      from public.content_takedowns t
      where t.content_type = 'post' and t.content_id = p_post_id),

    'open_reports', (select count(*) from public.post_reports r
      where r.post_id = p_post_id and r.resolved_at is null),

    -- Viewer-INDEPENDENT ranking inputs. Names mirror lib/feedScorer.ScoredPost
    -- so the console can feed them straight into its mirrored formula.
    'ranking', (select jsonb_build_object(
        'likes',        (select count(*) from public.likes    l where l.post_id = p.id),
        'comments',     (select count(*) from public.comments c where c.post_id = p.id),
        'saves',        coalesce(p.save_count, 0),
        'reposts',      coalesce(p.repost_count, 0),
        'streams',      coalesce(p.stream_count, 0),
        'hours_old',    round(extract(epoch from (now() - p.created_at)) / 3600.0, 2),
        'badge_tier',   (select pr.badge_tier from public.profiles pr where pr.id = p.user_id),
        'originality_limited', coalesce(p.originality_limited, false))
      from public.posts p where p.id = p_post_id)
  ) into v_out;

  if v_out->'post' is null or v_out->'post' = 'null'::jsonb then raise exception 'post_not_found'; end if;
  return v_out;
end $$;
revoke execute on function public.admin_post_detail(uuid) from public;
grant  execute on function public.admin_post_detail(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ · currently-limited posts, newest decision first (the review-your-own-
-- work list: originality calls are judgment calls, so they need to be re-readable
-- side by side).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_list_originality(p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then raise exception 'not_admin'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'at' desc)
    from (
      select jsonb_build_object(
        'post_id', p.id, 'caption', left(coalesce(p.caption, ''), 120), 'type', p.type,
        'thumbnail_url', coalesce(p.thumbnail_url, p.cover_url),
        'reason', p.originality_reason, 'note', p.originality_note, 'at', p.originality_at,
        'username', pr.username,
        'by', (select a.username from public.profiles a where a.id = p.originality_by)) as x
      from public.posts p
      join public.profiles pr on pr.id = p.user_id
      where p.originality_limited
      order by p.originality_at desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) s
  ), '[]'::jsonb);
end $$;
revoke execute on function public.admin_list_originality(int) from public;
grant  execute on function public.admin_list_originality(int) to authenticated;


-- ══════════════════════════════════════════════════════════════════════════
-- donations.sql  ·  re-run — adds the message column
-- ══════════════════════════════════════════════════════════════════════════
-- Laybell Live donations — viewers tip a live host; PREMIUM hosts get paid.
-- Run in the Supabase Dashboard → SQL Editor (after premium.sql + live_features.sql).
--
-- Modeled on shop_orders (see shop.sql): Laybell takes a 15% platform fee, and an
-- estimated tax is added ON TOP (the donor's cost, Poshmark-style) so it never
-- reduces the host's take-home. The money split + the PREMIUM LOCK are computed
-- and enforced SERVER-SIDE by a BEFORE INSERT trigger, so the client can neither
-- fake the split nor donate to a non-premium host. Payments are SIMULATED for now
-- (provider='simulated'), matching ads/spotlight — a real processor swaps in later.
--
-- Degrades gracefully: until this file is applied, lib/donations calls just fail
-- and the Donate button reports "not available", never crashing the live viewer.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'live_streams') then
    raise exception 'Run live_features.sql before donations.sql (public.live_streams is missing).';
  end if;
  if not exists (select 1 from information_schema.routines
                 where routine_schema = 'public' and routine_name = 'is_premium') then
    raise exception 'Run premium.sql before donations.sql (public.is_premium is missing).';
  end if;
end $$;

create table if not exists public.donations (
  id                    uuid primary key default gen_random_uuid(),
  donor_id              uuid not null references auth.users(id) on delete cascade,
  streamer_id           uuid not null references auth.users(id) on delete cascade,
  stream_id             uuid not null references public.live_streams(id) on delete cascade,
  amount_cents          integer not null check (amount_cents > 0),   -- the tip itself
  currency              text not null default 'usd',
  laybell_fee_cents     integer not null default 0,                  -- Laybell's 15% cut of the tip
  tax_cents             integer not null default 0,                  -- estimated tax, added on top (donor pays)
  streamer_payout_cents integer not null default 0,                  -- amount_cents - laybell_fee_cents
  provider              text not null default 'simulated',           -- 'simulated' until a real processor
  provider_ref          text,
  status                text not null default 'succeeded' check (status in ('succeeded', 'refunded', 'failed', 'pending')),
  created_at            timestamptz not null default now(),
  processed_at          timestamptz
);

create index if not exists donations_streamer_idx on public.donations (streamer_id, created_at desc);
create index if not exists donations_stream_idx   on public.donations (stream_id, created_at desc);
create index if not exists donations_donor_idx     on public.donations (donor_id, created_at desc);

alter table public.donations enable row level security;

-- SELECT: only the donor and the host can see a donation.
drop policy if exists "Parties can view donations" on public.donations;
create policy "Parties can view donations" on public.donations for select
  using (auth.uid() = donor_id or auth.uid() = streamer_id);

-- INSERT: a signed-in donor records their own donation of a positive amount. The
-- trigger below fills/overrides streamer_id, the money split, provider and status,
-- and REJECTS the insert if the host isn't Premium — so this check stays minimal.
drop policy if exists "Donors can donate" on public.donations;
create policy "Donors can donate" on public.donations for insert
  with check (auth.uid() = donor_id and amount_cents > 0);

-- No client UPDATE/DELETE — donations are immutable from the app (refunds happen
-- server-side via the service role when a real processor lands).

-- Server-side guard: resolve the host from the stream (can't be spoofed), enforce
-- the PREMIUM LOCK, block self-donations, and stamp the 15% fee + estimated tax +
-- payout. Rates mirror lib/donations (DONATION_FEE_RATE 0.15, DONATION_TAX_RATE 0.06).
create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = new.stream_id;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  -- The host is the stream owner, whatever the client sent.
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  -- PREMIUM LOCK: only Premium hosts can receive donations.
  if not public.is_premium(v_host) then
    raise exception 'streamer_not_premium';
  end if;

  new.laybell_fee_cents     := round(new.amount_cents * 0.15);
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  return new;
end; $$;

drop trigger if exists donations_guard on public.donations;
create trigger donations_guard
  before insert on public.donations
  for each row execute function public.donation_guard();

-- Host earnings rollup (take-home total + count of succeeded donations) for the
-- CALLER only — keyed on auth.uid() so no one can snoop another host's earnings.
create or replace function public.donation_earnings()
returns table (total_cents bigint, donation_count bigint) language sql stable security definer set search_path = public as $$
  select coalesce(sum(streamer_payout_cents), 0)::bigint, count(*)::bigint
  from public.donations
  where streamer_id = auth.uid() and status = 'succeeded';
$$;
grant execute on function public.donation_earnings() to authenticated;

-- ── v2 (2026-07-19): donor message + tiered "Earn More" fee ───────────────────
-- Supersedes the guard above (re-run this whole file to apply). Two changes:
--   1. `message` column — the donor's note; rides the live broadcast channel for
--      the real-time alert, recorded here and clamped to 200 chars.
--   2. NO MORE PREMIUM LOCK. Every host can now receive tips; the Premium perk is
--      "Earn More" — Laybell takes 8% from Premium hosts vs 35% from everyone
--      else (tax still added on top, donor-paid). Rates mirror lib/donations.
alter table public.donations add column if not exists message text;

create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  select user_id into v_host from public.live_streams where id = new.stream_id;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  -- Tiered platform fee — the Premium "Earn More" perk (8% Premium, 35% standard).
  new.laybell_fee_cents     := round(new.amount_cents * (case when public.is_premium(v_host) then 0.08 else 0.35 end));
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  new.message               := nullif(left(trim(coalesce(new.message, '')), 200), '');
  return new;
end; $$;


-- ══════════════════════════════════════════════════════════════════════════
-- studio_live.sql  ·  AFTER donations — rewrites donation_guard v3
-- ══════════════════════════════════════════════════════════════════════════
-- Studio live broadcasts — a studio session can be broadcast to a listener
-- audience ("modern radio"): listeners tune in (subscribe-only LiveKit),
-- comment + donate over the audience channel, and can REQUEST TO JOIN the
-- session itself. Run AFTER live_features.sql and donations.sql.
--
-- Design notes:
--   * Discovery is RPC-ONLY (fetch_live_studio_sessions / fetch_studio_listen).
--     There is deliberately NO public SELECT policy on studio_sessions: the
--     join_code column is the room credential and must stay members-only.
--   * Join requests are written exclusively through SECURITY DEFINER RPCs so
--     the seat cap + host checks can't be bypassed; RLS on the table is
--     read-only (it exists for realtime + polling).
--   * Donations grow a second, mutually-exclusive target: studio_session_id.
--     donation_guard v3 resolves the host from whichever target is set.

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'studio_sessions') then
    raise exception 'Run live_features.sql before studio_live.sql (public.studio_sessions is missing).';
  end if;
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'donations') then
    raise exception 'Run donations.sql before studio_live.sql (public.donations is missing).';
  end if;
end $$;

-- ── 1. Broadcast state on the session ─────────────────────────────────────────

alter table public.studio_sessions add column if not exists live boolean not null default false;
alter table public.studio_sessions add column if not exists live_started_at timestamptz;
alter table public.studio_sessions add column if not exists listener_peak integer not null default 0;

-- ── 2. Join requests (listener → session member) ──────────────────────────────

create table if not exists public.studio_join_requests (
  session_id uuid not null references public.studio_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table public.studio_join_requests enable row level security;

-- Requester sees their own request; the host sees all of their session's.
drop policy if exists "Own or hosted join requests" on public.studio_join_requests;
create policy "Own or hosted join requests" on public.studio_join_requests for select
  using (
    auth.uid() = user_id
    or exists (select 1 from public.studio_sessions s
               where s.id = session_id and s.host_id = auth.uid())
  );

-- A requester may withdraw their own pending request. All other writes happen
-- through the RPCs below (security definer), never directly.
drop policy if exists "Withdraw own join request" on public.studio_join_requests;
create policy "Withdraw own join request" on public.studio_join_requests for delete
  using (auth.uid() = user_id and status = 'pending');

alter table public.studio_join_requests replica identity full;

-- Listener asks to join a LIVE session. Returns the request's current status
-- ('pending' | 'accepted' | 'declined' | 'member' when already in).
create or replace function public.request_studio_join(p_session uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'not_signed_in';
  end if;
  if not exists (select 1 from studio_sessions
                 where id = p_session and status = 'open' and live) then
    raise exception 'not_live';
  end if;
  if exists (select 1 from studio_session_members
             where session_id = p_session and user_id = v_uid) then
    return 'member';
  end if;

  insert into studio_join_requests (session_id, user_id)
  values (p_session, v_uid)
  on conflict (session_id, user_id) do nothing;

  select status into v_status from studio_join_requests
  where session_id = p_session and user_id = v_uid;
  return coalesce(v_status, 'pending');
end; $$;
grant execute on function public.request_studio_join(uuid) to authenticated;

-- Host accepts/declines. Accepting seats the user (honoring the 12-seat cap,
-- same limit as join_studio_session).
create or replace function public.respond_studio_join(p_session uuid, p_user uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_seats int;
begin
  if v_uid is null or not exists (select 1 from studio_sessions
                                  where id = p_session and host_id = v_uid) then
    raise exception 'not_host';
  end if;

  if p_accept then
    select count(*) into v_seats from studio_session_members where session_id = p_session;
    if v_seats >= 12 then
      raise exception 'session_full';
    end if;
    insert into studio_session_members (session_id, user_id, role)
    values (p_session, p_user, 'member')
    on conflict do nothing;
  end if;

  update studio_join_requests
  set status = case when p_accept then 'accepted' else 'declined' end
  where session_id = p_session and user_id = p_user;
end; $$;
grant execute on function public.respond_studio_join(uuid, uuid, boolean) to authenticated;

-- ── 3. RPC-only discovery (safe columns — join_code NEVER leaves) ─────────────

create or replace function public.fetch_live_studio_sessions()
returns table (
  id uuid, title text, host_id uuid, live_started_at timestamptz,
  host_username text, host_display_name text, host_avatar_url text,
  member_count bigint
) language sql stable security definer set search_path = public as $$
  select s.id, s.title, s.host_id, s.live_started_at,
         p.username, p.display_name, p.avatar_url,
         (select count(*) from studio_session_members m where m.session_id = s.id)
  from studio_sessions s
  join profiles p on p.id = s.host_id
  where s.status = 'open' and s.live
  order by s.live_started_at desc nulls last
  limit 50;
$$;
grant execute on function public.fetch_live_studio_sessions() to authenticated;

-- Everything the listen screen needs in one call; null once the broadcast ends
-- (the listener screen treats null as "ended").
create or replace function public.fetch_studio_listen(p_session uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not exists (
    select 1 from studio_sessions where id = p_session and status = 'open' and live
  ) then null else jsonb_build_object(
    'session', (
      select jsonb_build_object(
        'id', s.id, 'title', s.title, 'host_id', s.host_id,
        'live_started_at', s.live_started_at)
      from studio_sessions s where s.id = p_session
    ),
    'roster', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'role', m.role,
        'username', p.username, 'display_name', p.display_name,
        'avatar_url', p.avatar_url)), '[]'::jsonb)
      from studio_session_members m
      join profiles p on p.id = m.user_id
      where m.session_id = p_session
    )
  ) end;
$$;
grant execute on function public.fetch_studio_listen(uuid) to authenticated;

-- ── 4. Donations can target a studio broadcast ────────────────────────────────

alter table public.donations alter column stream_id drop not null;
alter table public.donations add column if not exists studio_session_id uuid references public.studio_sessions(id) on delete cascade;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'donations_one_target') then
    alter table public.donations add constraint donations_one_target
      check ((stream_id is null) <> (studio_session_id is null));
  end if;
end $$;

create index if not exists donations_studio_idx on public.donations (studio_session_id, created_at desc);

-- donation_guard v3: resolve the host from the live stream OR the studio
-- session. Same tiered fee ("Earn More": 8% Premium / 35% standard), tax on
-- top, 200-char message clamp — rates mirror lib/donations.
create or replace function public.donation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_host uuid;
begin
  if new.stream_id is not null then
    select user_id into v_host from public.live_streams where id = new.stream_id;
  elsif new.studio_session_id is not null then
    select host_id into v_host from public.studio_sessions where id = new.studio_session_id;
  end if;
  if v_host is null then
    raise exception 'stream_not_found';
  end if;
  new.streamer_id := v_host;

  if new.donor_id = v_host then
    raise exception 'cannot_donate_to_self';
  end if;

  new.laybell_fee_cents     := round(new.amount_cents * (case when public.is_premium(v_host) then 0.08 else 0.35 end));
  new.tax_cents             := round(new.amount_cents * 0.06);
  new.streamer_payout_cents := new.amount_cents - new.laybell_fee_cents;
  new.provider              := coalesce(new.provider, 'simulated');
  new.status                := coalesce(new.status, 'succeeded');
  new.processed_at          := now();
  new.message               := nullif(left(trim(coalesce(new.message, '')), 200), '');
  return new;
end; $$;


-- ══════════════════════════════════════════════════════════════════════════
-- live_heartbeat.sql
-- ══════════════════════════════════════════════════════════════════════════
-- Cross-user "ghost livestream" fix.
--
-- A live_streams row is flipped to status='live' when a broadcast starts and back
-- to 'ended' when the host taps End (or the Go Live screen unmounts). If the host's
-- app is force-killed or crashes mid-broadcast that cleanup never runs, so the row
-- stays 'live' forever with no media behind it — every viewer's Live feed then shows
-- it as an un-playable black screen.
--
-- The own-account case is handled purely client-side (endMyStaleLiveStreams reaps
-- your own leftovers at cold start / Go Live / feed open). This column covers the
-- OTHER-user case: while live, the broadcaster pings last_heartbeat_at ~every 15s
-- (lib/live.beatLiveStream). fetchLiveStreams hides any 'live' row whose newest ping
-- is older than 45s (dropStaleLives), so a killed broadcast disappears from everyone
-- else's feed within ~45s.
--
-- Fully backward compatible: the column is nullable and NULL is treated as
-- "always fresh" (never hidden), so old clients that don't ping and rows created
-- before this migration keep showing exactly as before. Safe to run more than once.

alter table public.live_streams
  add column if not exists last_heartbeat_at timestamptz;

-- The feed filters heartbeat staleness in JS after the status='live' fetch (which
-- already uses live_streams_live_idx), so no extra index is required here.


