-- Delete the sandbox TEST account so it can be signed up again.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_delete_sandbox_account.sql
--
-- Keyed on the EMAIL, which is stable, rather than the user id, which is new
-- every time the account is recreated. The address is hardcoded on purpose:
-- there is no parameter to mistype, so this file cannot be pointed at a real
-- account by accident. That matters because it runs against PRODUCTION.
--
-- Safe to run when the account does not exist - it deletes nothing and says so.
--
-- REFUSES IF THE ACCOUNT HOLDS MONEY. A test account should never have ledger
-- entries; if it does, either the wrong account is about to be deleted or
-- something real happened on it, and both are reasons to stop rather than to
-- proceed. Posts, stories and follows are deleted without complaint - they are
-- what a test run produces.

do $$
declare
  v_id    uuid;
  v_cents bigint;
begin
  select id into v_id from auth.users where email = '3ddiehall+sandbox@gmail.com';
  if v_id is null then
    raise notice 'No sandbox account - nothing to delete.';
    return;
  end if;

  select coalesce(sum(e.amount_cents), 0) into v_cents
    from ledger_accounts a
    join ledger_entries e on e.account_id = a.id
   where a.user_id = v_id;

  if v_cents <> 0 then
    raise exception
      'REFUSING: sandbox account % holds % cents in the ledger. Money on a test account means something is wrong - investigate before deleting.',
      v_id, v_cents;
  end if;
end $$;

-- What is about to go, for the record.
select
  u.id,
  p.username,
  u.created_at,
  (select count(*) from public.posts   where user_id = u.id) as posts,
  (select count(*) from public.stories where user_id = u.id) as stories,
  (select count(*) from public.follows where follower_id = u.id or following_id = u.id) as follows
  from auth.users u
  left join public.profiles p on p.id = u.id
 where u.email = '3ddiehall+sandbox@gmail.com';

delete from auth.users where email = '3ddiehall+sandbox@gmail.com';

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- accounts_left is 3 in production today (@3ddie, @laybell, @laybellreview).
-- It is reported rather than asserted, so this file does not start failing the
-- day a real account is added.
select
  (select count(*) from auth.users where email = '3ddiehall+sandbox@gmail.com') as sandbox_want_0,
  (select count(*) from auth.users)                                             as accounts_left,
  (select count(*) from public.ledger_verify())                                 as ledger_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries)             as global_sum_want_0;
