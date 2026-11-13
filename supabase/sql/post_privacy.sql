-- Per-post + account-wide engagement privacy (IG-style) — Supabase.
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Three creator controls, each resolvable at two levels:
--   • hide like count   — hide the like number from viewers (the heart still works)
--   • disable comments  — hide the thread + block new comments/replies (ENFORCED here)
--   • hide save count   — hide the save number from viewers
--
-- Level 1 — ACCOUNT DEFAULT on profiles (applies to ALL of a user's posts).
-- Level 2 — PER-POST OVERRIDE on posts, a NULLABLE boolean where NULL = "inherit
--           the account default" and a non-null value diverges from it.
--
-- To keep every read surface trivial (and correct for the separate web app, and
-- for queries that only select specific columns), the resolved value is
-- DENORMALIZED onto each post row as a plain non-null `*_eff` boolean, kept in
-- sync by triggers — exactly like posts.save_count. Surfaces read `*_eff`; they
-- never need the profiles join or any resolution logic.
--
-- Everything defaults to false / NULL, so existing posts and anyone who never
-- touches a toggle keep today's behaviour (counts shown, comments on).

-- ── 1) Account-wide defaults (profiles) ──────────────────────────────────────
alter table public.profiles
  add column if not exists hide_like_count_default    boolean not null default false,
  add column if not exists comments_disabled_default  boolean not null default false,
  add column if not exists hide_save_count_default     boolean not null default false;

-- ── 2) Per-post overrides (posts). NULL = inherit the author's account default ─
alter table public.posts
  add column if not exists hide_like_count   boolean,
  add column if not exists comments_disabled boolean,
  add column if not exists hide_save_count    boolean;

-- ── 3) Denormalized effective values (posts). What every surface reads. ───────
alter table public.posts
  add column if not exists hide_like_count_eff   boolean not null default false,
  add column if not exists comments_disabled_eff boolean not null default false,
  add column if not exists hide_save_count_eff    boolean not null default false;

-- ── 4) Resolve override-else-default on a post row (BEFORE INSERT/UPDATE) ──────
-- SECURITY DEFINER so it can read the author's profile defaults regardless of the
-- caller. Writes straight into NEW so the row lands already resolved.
create or replace function public.sync_post_privacy_eff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d_like boolean := false;
  d_comm boolean := false;
  d_save boolean := false;
begin
  select pr.hide_like_count_default, pr.comments_disabled_default, pr.hide_save_count_default
    into d_like, d_comm, d_save
  from public.profiles pr
  where pr.id = new.user_id;

  new.hide_like_count_eff   := coalesce(new.hide_like_count,   d_like, false);
  new.comments_disabled_eff := coalesce(new.comments_disabled, d_comm, false);
  new.hide_save_count_eff    := coalesce(new.hide_save_count,    d_save, false);
  return new;
end;
$$;

drop trigger if exists trg_sync_post_privacy_eff on public.posts;
create trigger trg_sync_post_privacy_eff
  before insert or update of hide_like_count, comments_disabled, hide_save_count, user_id
  on public.posts
  for each row execute function public.sync_post_privacy_eff();

-- ── 5) Propagate an account-default change to all of that user's posts ────────
-- Fires only when one of the three defaults actually changes; one UPDATE covers
-- the user's whole catalogue (posts whose override is NULL follow the new value;
-- posts that explicitly diverged keep theirs, via coalesce).
create or replace function public.sync_user_posts_privacy_eff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts p set
    hide_like_count_eff   = coalesce(p.hide_like_count,   new.hide_like_count_default,   false),
    comments_disabled_eff = coalesce(p.comments_disabled, new.comments_disabled_default, false),
    hide_save_count_eff    = coalesce(p.hide_save_count,    new.hide_save_count_default,    false)
  where p.user_id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_sync_user_posts_privacy_eff on public.profiles;
create trigger trg_sync_user_posts_privacy_eff
  after update of hide_like_count_default, comments_disabled_default, hide_save_count_default
  on public.profiles
  for each row
  when (
    old.hide_like_count_default   is distinct from new.hide_like_count_default
    or old.comments_disabled_default is distinct from new.comments_disabled_default
    or old.hide_save_count_default  is distinct from new.hide_save_count_default
  )
  execute function public.sync_user_posts_privacy_eff();

-- ── 6) Backfill effective values for every existing post ──────────────────────
update public.posts p set
  hide_like_count_eff   = coalesce(p.hide_like_count,   pr.hide_like_count_default,   false),
  comments_disabled_eff = coalesce(p.comments_disabled, pr.comments_disabled_default, false),
  hide_save_count_eff    = coalesce(p.hide_save_count,    pr.hide_save_count_default,    false)
from public.profiles pr
where pr.id = p.user_id;

-- ── 7) ENFORCE "disable comments" server-side ────────────────────────────────
-- public.comments does NOT have RLS enabled in production (see admin_console.sql),
-- so a restrictive RLS policy would not fire. A BEFORE INSERT trigger enforces it
-- regardless of RLS and is fully additive. Covers top-level comments AND replies
-- (both are rows in public.comments). SECURITY DEFINER to read posts under any RLS.
create or replace function public.enforce_comments_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select comments_disabled_eff from public.posts where id = new.post_id) then
    raise exception 'Comments are turned off for this post'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_comments_enabled on public.comments;
create trigger trg_enforce_comments_enabled
  before insert on public.comments
  for each row execute function public.enforce_comments_enabled();

-- After this runs:
--   • posts.{hide_like_count_eff, comments_disabled_eff, hide_save_count_eff} are
--     the single booleans the app/web read to decide what to hide.
--   • New comments/replies on a comments-off post are rejected at the DB, so the
--     control is real even for old app builds and direct API calls.
--   • Feed/post-detail queries that select '*' pick the new columns up for free.
