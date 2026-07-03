-- ============================================================================
-- Scale hardening #2 — PHASE A: denormalized like_count / comment_count.
--
-- Additive + kept in sync by triggers. SAFE and behavior-neutral: the app keeps
-- using likes(count)/comments(count) until we swap it (Phase B), so this changes
-- nothing on screen — it just starts maintaining accurate counter columns you can
-- switch to. Same pattern as your existing save_count / share_count / stream_count.
--
-- Fully reversible — the "undo" is at the bottom of this file (commented out).
--
-- After running, VERIFY the columns match the live aggregates (should be all zero
-- rows returned):
--   select id from public.posts p
--   where like_count    <> (select count(*) from public.likes    l where l.post_id = p.id)
--      or comment_count <> (select count(*) from public.comments c where c.post_id = p.id);
-- ============================================================================

-- 1) Columns (default 0, never null)
alter table public.posts add column if not exists like_count    integer not null default 0;
alter table public.posts add column if not exists comment_count integer not null default 0;

-- 2) One-time backfill from existing rows
update public.posts p set
  like_count    = coalesce((select count(*) from public.likes    l where l.post_id = p.id), 0),
  comment_count = coalesce((select count(*) from public.comments c where c.post_id = p.id), 0);

-- 3) Trigger functions. SECURITY DEFINER so the counter update isn't blocked by
--    RLS (someone liking a post they don't own must still bump its count).
--    greatest(..,0) guards against ever going negative.
create or replace function public.bump_like_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end; $$;

create or replace function public.bump_comment_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end; $$;

-- 4) Triggers (drop-then-create keeps this idempotent)
drop trigger if exists likes_count_trg on public.likes;
create trigger likes_count_trg
  after insert or delete on public.likes
  for each row execute function public.bump_like_count();

drop trigger if exists comments_count_trg on public.comments;
create trigger comments_count_trg
  after insert or delete on public.comments
  for each row execute function public.bump_comment_count();

-- ============================================================================
-- UNDO (only if you want to fully revert Phase A):
--   drop trigger if exists likes_count_trg on public.likes;
--   drop trigger if exists comments_count_trg on public.comments;
--   drop function if exists public.bump_like_count();
--   drop function if exists public.bump_comment_count();
--   alter table public.posts drop column if exists like_count;
--   alter table public.posts drop column if exists comment_count;
-- ============================================================================
