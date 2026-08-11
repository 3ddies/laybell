-- Mature content: a flag, and server-enforced age-gated visibility.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires minor_safety.sql (public.is_minor) and profile_fields.sql (profiles.dob).
--
-- WHY THIS EXISTS. The community guidelines promise three things that the app
-- had no mechanism to deliver:
--
--   "Mature, suggestive, and adult themes are allowed, and so is tasteful and
--    artistic nudity."
--   "Where the app gives you a control to mark or flag mature content or nudity,
--    you must use it."
--   "Laybell may label, age-gate, restrict, or remove mature content, and we do
--    not knowingly show sexual or adult content to users we know to be under 18."
--
-- There was no such control and no such gate. So the app permitted nudity by
-- policy, had no way to keep it from minors, and carries a 13+ App Store rating
-- — the one child-safety hole in a system that is otherwise careful. A guideline
-- that promises a protection which does not exist is worse than not promising it:
-- it is the sentence a regulator or a reviewer quotes back.
--
-- WHY `is_minor` AND NOT `is_adult`. lib/minors.ts draws a deliberate asymmetry:
-- restrictions apply to people we AFFIRMATIVELY KNOW are under 18, privileges
-- require positive proof of adulthood. Viewing mature content could be argued
-- either way — but the promise above is worded "users we KNOW to be under 18",
-- so the gate is written to match the promise exactly rather than to be
-- incidentally stricter than it. Age is mandatory at onboarding, so the residue
-- is pre-migration rows with no date of birth.
--
-- Everything here is ADDITIVE and uses RESTRICTIVE policies, which AND with the
-- existing permissive policies rather than replacing them (same approach as
-- minor_safety.sql and account_hidden.sql). No existing policy is dropped.
-- `posts` carries 14 policies and is the spine of the app; nothing below touches
-- any of them.

-- ── 1) The flag ─────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT false, so every existing row is unaffected and the gate below
-- is a no-op until someone actually marks something.
alter table public.posts   add column if not exists mature boolean not null default false;
alter table public.stories add column if not exists mature boolean not null default false;

comment on column public.posts.mature is
  'Marked by the author (or a moderator) as mature: artistic nudity, adult themes. Hidden from known minors by a restrictive RLS policy.';

-- Partial indexes: the flag is rare, so only index the rows that carry it.
create index if not exists posts_mature_idx   on public.posts (id)   where mature;
create index if not exists stories_mature_idx on public.stories (id) where mature;

-- ── 2) The gate ─────────────────────────────────────────────────────────────
-- Reads as: this row is visible UNLESS it is mature and you are a known minor.
--
-- Three NULL cases, all of which must fall open or the feed breaks:
--   · anon (auth.uid() is null) → is_minor(null) returns false by its own
--     coalesce, so `not false` = true and the row passes.
--   · mature null (shouldn't happen given NOT NULL, but a future ALTER could)
--     → coalesce pins it to false.
--   · the author sees their own post regardless, so marking your own content
--     never makes it vanish from your profile.
-- A policy expression that evaluates to NULL is treated by Postgres as a
-- FAILURE, which is how the group-chat policy in minor_safety.sql once broke
-- everything. Hence the coalesce rather than a bare comparison.
do $$
begin
  if to_regclass('public.posts') is not null then
    execute $p$ drop policy if exists "Minors do not see mature posts" on public.posts $p$;
    execute $p$
      create policy "Minors do not see mature posts"
        on public.posts as restrictive for select
        using (
          coalesce(public.posts.mature, false) = false
          or public.posts.user_id = auth.uid()
          or not public.is_minor(auth.uid())
        );
    $p$;
  end if;

  if to_regclass('public.stories') is not null then
    execute $p$ drop policy if exists "Minors do not see mature stories" on public.stories $p$;
    execute $p$
      create policy "Minors do not see mature stories"
        on public.stories as restrictive for select
        using (
          coalesce(public.stories.mature, false) = false
          or public.stories.user_id = auth.uid()
          or not public.is_minor(auth.uid())
        );
    $p$;
  end if;
end $$;

-- ── 3) Verify ───────────────────────────────────────────────────────────────
-- Both policies registered and restrictive:
--   select tablename, policyname, permissive from pg_policies
--    where policyname like 'Minors do not see mature%';
-- Nothing is hidden from anyone yet (no row is marked):
--   select count(*) from public.posts where mature;
