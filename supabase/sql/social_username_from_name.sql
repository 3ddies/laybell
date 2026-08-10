-- ───────────────────────────────────────────────────────────────────────────
-- Social sign-in usernames should look like the PERSON, not like a hash.
--
-- THE PROBLEM: handle_new_user() derived the username from the email local
-- part. That is fine for Google (josh.rodney@gmail.com → joshrodney) but Apple's
-- Hide My Email issues addresses like shyrtei78@privaterelay.appleid.com — so
-- "Josh Rodney" signed in and became **shyrtei78**. First impression of the app,
-- and nothing about it says Josh.
--
-- THE ORDER NOW: explicit metadata → the provider's NAME → the email local part
-- (only when the address isn't a private relay) → 'artist'. Apple only shares
-- the name on the very FIRST authorization, and lib/socialAuth.ts stashes it in
-- auth metadata immediately, so it is present here for new sign-ups.
--
-- Usernames stay lowercase and [a-z0-9_], matching the app's existing rule —
-- "Josh Rodney" becomes joshrodney; the DISPLAY name keeps its real casing.
--
-- Idempotent; safe to re-run. Email signups are byte-identical to before.
-- ───────────────────────────────────────────────────────────────────────────

-- Fold common accents to ASCII so "José Muñoz" yields josemunoz rather than
-- josmuoz. (Deliberately not the unaccent extension — it isn't installed here.)
create or replace function public.slug_from_name(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(
    lower(translate(coalesce(p_text, ''),
      'àáâãäåāăąèéêëēĕėęěìíîïĩīĭįıòóôõöøōŏőùúûüũūŭůűųñńņňçćĉċčýÿŷßÆæŒœ',
      'aaaaaaaaaeeeeeeeeeiiiiiiiiiooooooooouuuuuuuuuunnnncccccyyyssAaOo')),
    '[^a-z0-9_]', '', 'g');
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base text;
  uname text;
  dname text;
  email_local text;
  is_relay boolean;
  n int := 0;
begin
  -- Display name: explicit metadata → provider full name → given+family →
  -- email local part. Keeps its real capitalisation.
  dname := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(trim(concat_ws(' ',
      nullif(trim(new.raw_user_meta_data->>'given_name'), ''),
      nullif(trim(new.raw_user_meta_data->>'family_name'), ''))), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Artist'
  );

  email_local := nullif(split_part(coalesce(new.email, ''), '@', 1), '');
  -- Apple's Hide My Email local parts are opaque tokens. Never wear one as a name.
  is_relay := coalesce(new.email, '') ilike '%@privaterelay.appleid.com';

  -- Username base: explicit metadata → the person's NAME → email local part
  -- (unless relayed) → 'artist'.
  base := coalesce(
    nullif(public.slug_from_name(new.raw_user_meta_data->>'username'), ''),
    nullif(public.slug_from_name(new.raw_user_meta_data->>'full_name'), ''),
    nullif(public.slug_from_name(new.raw_user_meta_data->>'name'), ''),
    nullif(public.slug_from_name(concat_ws(' ',
      new.raw_user_meta_data->>'given_name',
      new.raw_user_meta_data->>'family_name')), ''),
    case when is_relay then null else nullif(public.slug_from_name(email_local), '') end,
    'artist'
  );

  if length(base) < 5 then
    base := rpad(base || 'artist', 5, '0');
  end if;
  base := left(base, 20);   -- room for a numeric suffix inside the 24 cap

  -- Prefer the clean name, then SMALL numbers (joshrodney2), and only fall back
  -- to a 4-digit suffix once the short ones are taken. A human-looking name
  -- with a 2 after it still reads as the person.
  uname := base;
  while exists (select 1 from public.profiles where username = uname) and n < 30 loop
    n := n + 1;
    uname := base || case when n <= 9 then n::text
                          else (100 + floor(random() * 9900))::int::text end;
  end loop;

  begin
    insert into public.profiles (id, username, display_name, onboarded)
    values (new.id, uname, left(dname, 40), false)
    on conflict (id) do nothing;
  exception when others then
    -- NEVER block account creation over the profile row — the app rebuilds a
    -- missing row on first login (lib/socialAuth.ts ensureProfileForSession).
    raise warning 'handle_new_user: profile insert failed for %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;
