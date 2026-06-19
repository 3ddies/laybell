-- Moderation evidence preservation + legal holds — Supabase
-- Run in the Supabase Dashboard → SQL Editor (the anon key can't alter tables or
-- policies). Requires post_reports.sql, user_reports.sql and posts_delete_policy.sql
-- to have been run first.
--
-- WHY THIS EXISTS
-- post_reports.post_id and user_reports.reported_id were ON DELETE CASCADE, so
-- deleting a reported post (or the reported user's account) DESTROYED the report
-- and all of its evidence along with it. That let a bad actor post something
-- illegal, then delete the post / their account to erase the entire moderation +
-- legal trail. This migration makes deletion SAFE:
--   1. reports survive after the content/account is gone (FK -> SET NULL, nullable);
--   2. every report captures a tamper-proof CONTENT SNAPSHOT via a server-side
--      trigger (a client can neither fake nor omit it);
--   3. a legal_hold blocks a post from being deleted at all while an investigation
--      or preservation request is active.
--
-- ⚠ NOT legal advice. This is the engineering foundation only. Still required and
-- OUT OF SCOPE here: retention periods (set by counsel), the CSAM / NCMEC
-- CyberTipline reporting workflow, and preserving the actual MEDIA FILE — the
-- snapshot keeps the metadata + the (now-dead-after-delete) URL, not the bytes;
-- real preservation needs a copy into a locked retention bucket. Reported content
-- you must preserve in full should be put on legal_hold so it can't be deleted.

-- ── 1. post_reports: survive post deletion, carry an evidence snapshot ────────
alter table public.post_reports
  add column if not exists reported_user_id uuid,         -- post author (kept after the post is gone)
  add column if not exists content_snapshot jsonb,        -- full reported post at report time
  add column if not exists snapshot_at      timestamptz;

alter table public.post_reports alter column post_id drop not null;
alter table public.post_reports drop constraint if exists post_reports_post_id_fkey;
alter table public.post_reports
  add constraint post_reports_post_id_fkey
  foreign key (post_id) references public.posts(id) on delete set null;

-- Tamper-proof snapshot: the SERVER fills it from the real post, ignoring any
-- client-supplied values. SECURITY DEFINER so it reads the full row under RLS.
create or replace function public.snapshot_post_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select to_jsonb(p), p.user_id
    into new.content_snapshot, new.reported_user_id
    from public.posts p
   where p.id = new.post_id;
  new.snapshot_at := now();
  return new;
end $$;

drop trigger if exists post_reports_snapshot on public.post_reports;
create trigger post_reports_snapshot
  before insert on public.post_reports
  for each row execute function public.snapshot_post_report();

-- ── 2. user_reports: survive account deletion, carry an identity snapshot ─────
alter table public.user_reports
  add column if not exists reported_snapshot jsonb,
  add column if not exists snapshot_at       timestamptz;

alter table public.user_reports alter column reported_id drop not null;
alter table public.user_reports drop constraint if exists user_reports_reported_id_fkey;
alter table public.user_reports
  add constraint user_reports_reported_id_fkey
  foreign key (reported_id) references auth.users(id) on delete set null;

create or replace function public.snapshot_user_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select jsonb_build_object(
           'id', pr.id, 'username', pr.username,
           'display_name', pr.display_name, 'avatar_url', pr.avatar_url)
    into new.reported_snapshot
    from public.profiles pr
   where pr.id = new.reported_id;
  new.snapshot_at := now();
  return new;
end $$;

drop trigger if exists user_reports_snapshot on public.user_reports;
create trigger user_reports_snapshot
  before insert on public.user_reports
  for each row execute function public.snapshot_user_report();

-- ── 3. Legal hold — held content can't be deleted by its owner ────────────────
alter table public.posts    add column if not exists legal_hold boolean not null default false;
alter table public.profiles add column if not exists legal_hold boolean not null default false;

-- Re-create the owner DELETE policy (supersedes posts_delete_policy.sql) so a post
-- on legal hold can't be deleted from the app. NOTE: an admin hard-delete of the
-- AUTH user still cascades their posts via the auth.users FK — the future
-- delete-account job MUST skip held posts/accounts before it purges anything.
drop policy if exists "Users can delete own posts" on public.posts;
create policy "Users can delete own posts"
on public.posts for delete
using (auth.uid() = user_id and coalesce(legal_hold, false) = false);

-- Admin review: reports + their snapshots are readable via the SERVICE ROLE
-- (Supabase dashboard / a future admin tool). No broad client read policy is
-- granted on purpose — reporters still only see their own reports.
