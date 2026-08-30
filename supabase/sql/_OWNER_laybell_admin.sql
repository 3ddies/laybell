-- Give the @laybell account staff control of the 12 official communities.
-- Run once. Idempotent — safe to re-run.
--
-- WHY TWO STEPS, not one. laybell_admins is the STAFF FLAG: it is what
-- laybell_join_as_manager() checks before it will seat anyone on an official
-- community. But that RPC has no button anywhere in the app — nothing in app/,
-- lib/ or components/ references it or the admins table — so the flag on its
-- own is inert. Seating the account is the second half, and it does exactly
-- what the RPC would have done: role 'manager', status 'active'.
--
-- SIDE EFFECT, stated plainly: the membership trigger recomputes member_count
-- from active rows, so each official community goes from 0 members to 1. That
-- is true rather than cosmetic — the account really is a manager of each — and
-- it is the same number the in-app flow would have produced.
--
-- The official tabs stay OWNERLESS (owner_id null) on purpose. Ownership would
-- make them one user's communities; a manager seat is staff access to something
-- the platform owns, which is what they are.

do $$
declare
  v_uid uuid;
  v_seated int;
begin
  select id into v_uid from public.profiles where lower(username) = 'laybell';
  if v_uid is null then
    raise exception 'No profile with username @laybell — check the handle before running.';
  end if;

  insert into public.laybell_admins (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  insert into public.community_members (community_id, user_id, role, status, joined_at)
  select c.id, v_uid, 'manager', 'active', now()
    from public.communities c
   where c.is_official
  on conflict (community_id, user_id)
    do update set role = 'manager', status = 'active';

  get diagnostics v_seated = row_count;
  raise notice 'laybell admin granted; manager on % official communities', v_seated;
end $$;

-- Verify:
--   select p.username, (a.user_id is not null) as is_admin,
--          count(m.*) filter (where c.is_official) as official_manager_of
--     from public.profiles p
--     left join public.laybell_admins a on a.user_id = p.id
--     left join public.community_members m on m.user_id = p.id and m.role = 'manager'
--     left join public.communities c on c.id = m.community_id
--    where lower(p.username) = 'laybell'
--    group by p.username, a.user_id;
