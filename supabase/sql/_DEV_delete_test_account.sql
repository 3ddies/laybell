-- Delete ONE test account, id and email pinned together.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_delete_test_account.sql
--
-- Both the id AND the email are hardcoded, and the script refuses unless they
-- name the SAME row. Either alone would be enough to identify an account; the
-- point of requiring both is that a copy-paste slip cannot land on a real one.
-- This runs against PRODUCTION and the delete is not recoverable.
--
-- Account: @artist / "shpwkvr7jg", created 2026-09-04 17:55, the 1.0.2
-- walkthrough account. NOT @plagiarists, which was created the same day and is
-- an ordinary signup.
--
-- REFUSES IF THE ACCOUNT HOLDS MONEY. A test account should never have ledger
-- entries; if it does, either the wrong account is about to go or something real
-- happened on it, and both are reasons to stop. Posts, stories and follows go
-- without complaint — they are what a test run produces.

do $$
declare
  v_id    uuid := '270d5032-aff9-4e7b-a195-d491061bdb19';
  v_email text := 'shpwkvr7jg@privaterelay.appleid.com';
  v_found text;
  v_cents bigint;
begin
  select email into v_found from auth.users where id = v_id;

  if v_found is null then
    raise notice 'No account with that id — nothing to delete.';
    return;
  end if;

  -- The id and the email must agree. If they do not, the id is pointing at
  -- somebody else and this must not proceed.
  if v_found <> v_email then
    raise exception
      'REFUSING: id % belongs to %, not %. Identify the account again before deleting anything.',
      v_id, v_found, v_email;
  end if;

  select coalesce(sum(e.amount_cents), 0) into v_cents
    from public.ledger_accounts a
    join public.ledger_entries  e on e.account_id = a.id
   where a.user_id = v_id;

  if v_cents <> 0 then
    raise exception
      'REFUSING: account % holds % cents in the ledger. Money on a test account means something is wrong — investigate before deleting.',
      v_id, v_cents;
  end if;
end $$;

-- What is about to go, for the record.
select
  u.id, u.email, p.username, p.display_name,
  to_char(u.created_at, 'YYYY-MM-DD HH24:MI') as created,
  (select count(*) from public.posts   where user_id = u.id) as posts,
  (select count(*) from public.stories where user_id = u.id) as stories,
  (select count(*) from public.follows where follower_id = u.id or following_id = u.id) as follows
  from auth.users u
  left join public.profiles p on p.id = u.id
 where u.id = '270d5032-aff9-4e7b-a195-d491061bdb19';

-- Storage is NOT deleted here, and cannot be: Supabase's protect_delete trigger
-- raises 42501 on any direct DELETE from storage.objects ("use the Storage API
-- instead"). purge_profile_storage already tries this inside the cascade and
-- swallows the same failure on purpose, precisely so it cannot block an account
-- deletion — see supabase/sql/storage_cleanup.sql. So the files below outlive
-- the row and are left for the Storage-API orphan cleanup. Counted before and
-- after so the number is on the record rather than assumed.
select count(*) as files_that_will_be_orphaned
  from storage.objects
 where (storage.foldername(name))[1] = '270d5032-aff9-4e7b-a195-d491061bdb19';

-- Cascades to profiles, posts, follows and the rest.
delete from auth.users where id = '270d5032-aff9-4e7b-a195-d491061bdb19';

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  (select count(*) from auth.users where id = '270d5032-aff9-4e7b-a195-d491061bdb19') as account_want_0,
  (select count(*) from public.profiles where id = '270d5032-aff9-4e7b-a195-d491061bdb19') as profile_want_0,
  (select count(*) from public.posts where user_id = '270d5032-aff9-4e7b-a195-d491061bdb19') as posts_want_0,
  -- NOT expected to be 0 — see the note above. Reported so the orphans are known.
  (select count(*) from storage.objects
     where (storage.foldername(name))[1] = '270d5032-aff9-4e7b-a195-d491061bdb19')        as files_orphaned,
  (select count(*) from auth.users)                                    as accounts_left,
  (select count(*) from public.ledger_verify())                        as ledger_violations_want_0,
  (select coalesce(sum(amount_cents), 0) from public.ledger_entries)   as global_sum_want_0;
