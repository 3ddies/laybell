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
