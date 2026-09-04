-- READ ONLY. Who exists, newest first, so a test account can be identified by
-- sight before anything is deleted.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_list_accounts.sql
--
-- Deleting the wrong row here is unrecoverable, so identification is a separate
-- step from removal on purpose. Ledger cents are shown because money on an
-- account is the single clearest signal that it is NOT a throwaway.

select
  u.id,
  u.email,
  p.username,
  p.display_name,
  to_char(u.created_at, 'YYYY-MM-DD HH24:MI') as created,
  (select count(*) from public.posts    where user_id = u.id) as posts,
  (select count(*) from public.stories  where user_id = u.id) as stories,
  (select count(*) from public.follows  where follower_id = u.id or following_id = u.id) as follows,
  coalesce((
    select sum(e.amount_cents)
      from public.ledger_accounts a
      join public.ledger_entries  e on e.account_id = a.id
     where a.user_id = u.id
  ), 0) as ledger_cents
  from auth.users u
  left join public.profiles p on p.id = u.id
 order by u.created_at desc;
