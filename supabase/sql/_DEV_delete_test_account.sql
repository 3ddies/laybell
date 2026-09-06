-- Delete ONE test account, keyed on its email.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_delete_test_account.sql
--
-- The address is hardcoded on purpose: there is no parameter to mistype, so this
-- file cannot be pointed at a real account by accident. It runs against
-- PRODUCTION and the delete is not recoverable.
--
-- Account: ehall1@ncat.edu — the 1.0.2 walkthrough account, created 2026-09-06.
--
-- Safe to run when the account does not exist: it deletes nothing and says so.
--
-- REFUSES IF THE ACCOUNT HOLDS MONEY. A test account should never have ledger
-- entries; if it does, either the wrong account is about to go or something real
-- happened on it, and both are reasons to stop. Posts, stories, follows and
-- comments go without complaint — they are what a test run produces.

do $$
declare
  v_id    uuid;
  v_cents bigint;
begin
  select id into v_id from auth.users where lower(email) = 'ehall1@ncat.edu';
  if v_id is null then
    raise notice 'No account for ehall1@ncat.edu - nothing to delete.';
    return;
  end if;

  select coalesce(sum(e.amount_cents), 0) into v_cents
    from public.ledger_accounts a
    join public.ledger_entries  e on e.account_id = a.id
   where a.user_id = v_id;

  if v_cents <> 0 then
    raise exception
      'REFUSING: account % holds % cents in the ledger. Money on a test account means something is wrong - investigate before deleting.',
      v_id, v_cents;
  end if;
end $$;

-- What is about to go, for the record.
select
  u.id, u.email, p.username, p.display_name,
  to_char(u.created_at, 'YYYY-MM-DD HH24:MI') as created,
  (select count(*) from public.posts    where user_id = u.id) as posts,
  (select count(*) from public.stories  where user_id = u.id) as stories,
  (select count(*) from public.comments where user_id = u.id) as comments,
  (select count(*) from public.follows  where follower_id = u.id or following_id = u.id) as follows
  from auth.users u
  left join public.profiles p on p.id = u.id
 where lower(u.email) = 'ehall1@ncat.edu';

-- Storage is NOT deleted here and cannot be: Supabase's protect_delete trigger
-- raises 42501 on any direct DELETE from storage.objects. purge_profile_storage
-- already tries this inside the cascade and swallows the same failure on purpose
-- so it cannot block an account deletion — see supabase/sql/storage_cleanup.sql.
-- The files below outlive the row and are left for the Storage-API orphan
-- cleanup. Counted so the number is on the record rather than assumed.
select count(*) as files_that_will_be_orphaned
  from storage.objects
 where (storage.foldername(name))[1] = (
   select id::text from auth.users where lower(email) = 'ehall1@ncat.edu'
 );

-- Cascades to profiles, posts, comments, follows and the rest.
delete from auth.users where lower(email) = 'ehall1@ncat.edu';

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from auth.users where lower(email) = 'ehall1@ncat.edu')      as account_want_0,
  (select count(*) from auth.users)                                             as accounts_left,
  (select count(*) from public.marketing_email_list)                            as mailable_left,
  (select count(*) from public.ledger_verify())                                 as ledger_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries)             as global_sum_want_0;
