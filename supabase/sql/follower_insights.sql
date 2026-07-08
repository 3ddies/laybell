-- Follower insights — powers the Premium "who unfollowed you" view.
-- Run in the Supabase Dashboard → SQL Editor.
--
-- "Doesn't follow you back" is derived live from the follows graph (no history
-- needed — see lib/followerInsights). "Who unfollowed you" DOES need history,
-- because a deleted follow leaves no trace. This adds a lightweight append-only
-- log written by triggers on public.follows: every follow INSERT and unfollow
-- DELETE is recorded, so unfollows become queryable from the moment this runs
-- (it can't back-fill unfollows that happened before it was applied).
--
-- Degrades gracefully: until this is applied, the unfollowers query just returns
-- empty and the "doesn't follow back" tab still works (it needs no history).

create table if not exists public.follow_events (
  id           uuid primary key default gen_random_uuid(),
  follower_id  uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  action       text not null check (action in ('follow', 'unfollow')),
  created_at   timestamptz not null default now()
);

-- The hot path: "events ABOUT me" (who followed/unfollowed following_id), newest first.
create index if not exists follow_events_target_idx on public.follow_events (following_id, action, created_at desc);

alter table public.follow_events enable row level security;

-- Only the person the event is ABOUT can read it (who followed/unfollowed them).
-- The other party never sees that you track this.
drop policy if exists "See your own follow events" on public.follow_events;
create policy "See your own follow events" on public.follow_events for select
  using (auth.uid() = following_id);

-- No client INSERT/UPDATE/DELETE — the log is written ONLY by the triggers below
-- (security definer), so it can't be forged or tampered with.

create or replace function public.log_follow_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.follow_events (follower_id, following_id, action)
      values (new.follower_id, new.following_id, 'follow');
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.follow_events (follower_id, following_id, action)
      values (old.follower_id, old.following_id, 'unfollow');
    return old;
  end if;
  return null;
end; $$;

drop trigger if exists follows_log_insert on public.follows;
create trigger follows_log_insert
  after insert on public.follows
  for each row execute function public.log_follow_event();

drop trigger if exists follows_log_delete on public.follows;
create trigger follows_log_delete
  after delete on public.follows
  for each row execute function public.log_follow_event();
