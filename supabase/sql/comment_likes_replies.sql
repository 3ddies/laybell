-- Comment likes + replies — Supabase. Run in the SQL Editor.

-- Replies: a comment can point at a parent comment (null = top-level).
alter table public.comments
  add column if not exists parent_id uuid references public.comments(id) on delete cascade;
create index if not exists comments_parent_idx on public.comments (parent_id);

-- Comment likes (one row per user per comment).
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

alter table public.comment_likes enable row level security;

create policy "Anyone can read comment likes" on public.comment_likes
  for select using (true);
create policy "Users can like comments" on public.comment_likes
  for insert with check (auth.uid() = user_id);
create policy "Users can unlike comments" on public.comment_likes
  for delete using (auth.uid() = user_id);
