-- Minor safety — server-enforced teen defaults.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires profile_fields.sql (profiles.dob / profiles.age) to have run.
--
-- The client already applies these rules (lib/minors.ts), but a client-side check
-- is a UX affordance, not a control — a modified client ignores it. Direct
-- messages to a minor are the one place where that distinction actually matters,
-- so the rule is enforced in the database.
--
-- Everything here is ADDITIVE and uses RESTRICTIVE policies, which AND with the
-- existing permissive policies rather than replacing them (same approach as
-- account_hidden.sql). No existing policy is dropped or rewritten.

-- ── is_minor(uuid) ───────────────────────────────────────────────────────────
-- dob is the source of truth; the denormalized `age` column is the fallback for
-- rows written before dob existed.
--
-- Note the default: an account with NO age information is treated as NOT a minor
-- here. That is deliberate and matches lib/minors.ts — the restriction applies to
-- people we affirmatively know are under 18, so an ageless legacy row does not
-- silently lose the ability to receive messages. Age is required at onboarding, so
-- this only affects pre-migration accounts.
create or replace function public.is_minor(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
       when p.dob is not null then (p.dob > (current_date - interval '18 years'))
       when p.age is not null then (p.age < 18)
       else false
     end
     from public.profiles p where p.id = p_id),
    false);
$$;

grant execute on function public.is_minor(uuid) to authenticated;

-- ── Followers-only DMs for minors ────────────────────────────────────────────
-- An adult stranger cannot open a DM with a minor. The minor must have followed
-- them first, which makes the contact something the minor chose rather than
-- something that arrived unbidden. Minor-to-anyone and adult-to-adult messaging
-- are untouched.
--
-- `follows` here means "the receiver follows the sender" — following is the
-- affirmative act that establishes consent to be contacted.
do $$
begin
  if to_regclass('public.messages') is null then
    raise notice 'public.messages not found — skipping the DM policy';
    return;
  end if;

  execute $p$
    drop policy if exists "Minors receive DMs only from people they follow" on public.messages;
  $p$;

  execute $p$
    create policy "Minors receive DMs only from people they follow"
      on public.messages as restrictive for insert
      with check (
        public.messages.sender_id = public.messages.receiver_id
        or not public.is_minor(public.messages.receiver_id)
        or exists (
          select 1 from public.follows f
          where f.follower_id = public.messages.receiver_id and f.following_id = public.messages.sender_id
        )
      );
  $p$;
end $$;

-- Group chats reuse public.messages via conversation_id, where receiver_id is
-- null. A null receiver_id makes `is_minor(receiver_id)` null and the whole check
-- null, which Postgres treats as a policy FAILURE — that would break group chat
-- entirely. Guard it explicitly.
do $$
begin
  if to_regclass('public.messages') is null then return; end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'conversation_id'
  ) then
    execute $p$
      drop policy if exists "Minors receive DMs only from people they follow" on public.messages;
    $p$;
    execute $p$
      create policy "Minors receive DMs only from people they follow"
        on public.messages as restrictive for insert
        with check (
          public.messages.receiver_id is null                       -- group message; not a 1:1 DM
          or public.messages.sender_id = public.messages.receiver_id
          or not public.is_minor(public.messages.receiver_id)
          or exists (
            select 1 from public.follows f
            where f.follower_id = public.messages.receiver_id and f.following_id = public.messages.sender_id
          )
        );
    $p$;
  end if;
end $$;

-- To verify after running:
--   select public.is_minor('<a minor uuid>');   -- expect true
--   select public.is_minor('<an adult uuid>');  -- expect false
--
-- To roll back:
--   drop policy if exists "Minors receive DMs only from people they follow" on public.messages;
--   drop function if exists public.is_minor(uuid);
