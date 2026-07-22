-- Fix "Database error saving new user" on Apple/Google sign-ins.
--
-- The auth.users trigger builds the profiles row from signup metadata
-- (username / display_name) that EMAIL signups always carry. Social sign-ins
-- carry none of it (Apple Hide-My-Email carries barely anything), so the
-- profile insert failed and rolled back the whole account creation — GoTrue
-- surfaces that as "Database error saving new user".
--
-- This tolerant replacement:
--   • keeps the email flow byte-identical (metadata still wins when present),
--   • derives a username for social users (email local part → sanitized →
--     padded to the app's 5-char minimum → random-suffixed on collision),
--   • and NEVER blocks the signup: if the profile insert still fails, the
--     account is created without a row and the app repairs it on first login
--     (lib/socialAuth.ts ensureProfileForSession).
--
-- Run in the Supabase SQL editor. No app rebuild needed.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base text;
  uname text;
  dname text;
  n int := 0;
begin
  -- Display name: explicit metadata → provider full name → email local part.
  dname := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Artist'
  );

  -- Username: explicit metadata → sanitized email local part.
  base := lower(coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'artist'
  ));
  base := regexp_replace(base, '[^a-z0-9_]', '', 'g');
  if length(base) < 5 then
    base := rpad(base || 'artist', 5, '0');
  end if;
  base := left(base, 24);

  uname := base;
  while exists (select 1 from public.profiles where username = uname) and n < 20 loop
    n := n + 1;
    uname := left(base, 24) || (1000 + floor(random() * 9000))::int;
  end loop;

  begin
    insert into public.profiles (id, username, display_name, onboarded)
    values (new.id, uname, left(dname, 40), false)
    on conflict (id) do nothing;
  exception when others then
    -- NEVER block account creation over the profile row — the app rebuilds a
    -- missing row on first login.
    raise warning 'handle_new_user: profile insert failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- Point the conventional trigger at the (re)placed function — idempotent.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Diagnostics: every user-defined trigger on auth.users. If social signup
-- STILL errors after this, the original trigger has a non-conventional name —
-- paste this output back and it can be targeted precisely.
select t.tgname as trigger_name, p.proname as function_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;
