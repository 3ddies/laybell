-- Story likes — viewers can heart a story; the owner sees who liked it at the
-- top of their viewers list. Run manually in the Supabase SQL editor.

create table if not exists public.story_likes (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

alter table public.story_likes enable row level security;

drop policy if exists "Users can like stories" on public.story_likes;
create policy "Users can like stories"
  on public.story_likes for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can remove their story likes" on public.story_likes;
create policy "Users can remove their story likes"
  on public.story_likes for delete
  using (auth.uid() = user_id);

-- A liker can see their own like (drives the heart state); the story's owner
-- can see everyone's (drives the viewers-list emblems).
drop policy if exists "Likers and story owners can view story likes" on public.story_likes;
create policy "Likers and story owners can view story likes"
  on public.story_likes for select
  using (
    auth.uid() = user_id
    or exists (select 1 from public.stories s where s.id = story_id and s.user_id = auth.uid())
  );
