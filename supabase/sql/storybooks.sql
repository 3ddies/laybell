-- Storybooks — persistent, chaptered collections of a user's stories (like IG
-- story highlights, but organized into TITLED CHAPTERS). Shown on the profile;
-- public or private (private by default — "a private and fun gallery").
--
--   npx supabase db query --remote --yes -f supabase/sql/storybooks.sql
--
-- v1 is MANUAL books built from stories you've already posted. The kind/period
-- columns are seeded now for a later AUTO monthly/yearly "yearbook" (kind='yearbook').
--
-- MEDIA: items SNAPSHOT the story's media_url from the PUBLIC 'stories' bucket
-- (getPublicUrl). That URL keeps resolving after the source story expires or is
-- purged (purge_expired_stories deletes only rows, never the public file), so a
-- book never rots on its own. (A later pass can copy the file into a storybook-
-- owned path to also survive the user explicitly deleting the source story.)

-- ── storybooks (a book) ──────────────────────────────────────────────────────
create table if not exists public.storybooks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  cover_url   text,                               -- app defaults to the first item's media
  is_public   boolean not null default false,     -- private by default; publishing is opt-in
  kind        text not null default 'manual' check (kind in ('manual', 'yearbook')),
  period      text,                               -- yearbooks only: 'YYYY-MM' or 'YYYY'
  position    integer not null default 0,         -- order on the profile shelf
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists storybooks_user_idx on public.storybooks(user_id, position);
-- One auto-yearbook per (user, period), so recompiling updates instead of duplicating.
create unique index if not exists storybooks_yearbook_uq
  on public.storybooks(user_id, period) where kind = 'yearbook';

-- ── storybook_chapters (titled chapters within a book) ───────────────────────
create table if not exists public.storybook_chapters (
  id            uuid primary key default gen_random_uuid(),
  storybook_id  uuid not null references public.storybooks(id) on delete cascade,
  title         text,                             -- optional chapter title
  position      integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists storybook_chapters_book_idx
  on public.storybook_chapters(storybook_id, position);

-- ── storybook_items (a snapshot of one story inside a chapter) ───────────────
create table if not exists public.storybook_items (
  id               uuid primary key default gen_random_uuid(),
  chapter_id       uuid not null references public.storybook_chapters(id) on delete cascade,
  story_id         uuid references public.stories(id) on delete set null,  -- provenance only
  media_url        text not null,
  media_type       text not null default 'image' check (media_type in ('image', 'video')),
  thumbnail_url    text,
  caption          text,
  aspect_ratio     text,
  duration_seconds integer,
  position         integer not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists storybook_items_chapter_idx
  on public.storybook_items(chapter_id, position);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.storybooks         enable row level security;
alter table public.storybook_chapters enable row level security;
alter table public.storybook_items    enable row level security;

-- Books: a PUBLIC book is readable by any signed-in user; the owner does everything.
-- (Hidden-owner filtering stays the client's job — RLS does not cover profiles.hidden;
--  every profile surface already filters it. See public-surface-rls-gaps.)
drop policy if exists "read storybooks" on public.storybooks;
create policy "read storybooks" on public.storybooks for select to authenticated
  using (is_public or user_id = auth.uid());
drop policy if exists "write own storybooks" on public.storybooks;
create policy "write own storybooks" on public.storybooks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Chapters / items: readable iff the parent book is readable; writable iff you own it.
drop policy if exists "read chapters" on public.storybook_chapters;
create policy "read chapters" on public.storybook_chapters for select to authenticated
  using (exists (select 1 from public.storybooks b
                 where b.id = storybook_id and (b.is_public or b.user_id = auth.uid())));
drop policy if exists "write own chapters" on public.storybook_chapters;
create policy "write own chapters" on public.storybook_chapters for all to authenticated
  using     (exists (select 1 from public.storybooks b where b.id = storybook_id and b.user_id = auth.uid()))
  with check (exists (select 1 from public.storybooks b where b.id = storybook_id and b.user_id = auth.uid()));

drop policy if exists "read items" on public.storybook_items;
create policy "read items" on public.storybook_items for select to authenticated
  using (exists (select 1 from public.storybook_chapters c
                   join public.storybooks b on b.id = c.storybook_id
                 where c.id = chapter_id and (b.is_public or b.user_id = auth.uid())));
drop policy if exists "write own items" on public.storybook_items;
create policy "write own items" on public.storybook_items for all to authenticated
  using     (exists (select 1 from public.storybook_chapters c
                       join public.storybooks b on b.id = c.storybook_id
                     where c.id = chapter_id and b.user_id = auth.uid()))
  with check (exists (select 1 from public.storybook_chapters c
                       join public.storybooks b on b.id = c.storybook_id
                     where c.id = chapter_id and b.user_id = auth.uid()));

-- updated_at bump so the profile shelf can sort by "recently updated".
create or replace function public.storybooks_touch() returns trigger
  language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists storybooks_touch on public.storybooks;
create trigger storybooks_touch before update on public.storybooks
  for each row execute function public.storybooks_touch();
