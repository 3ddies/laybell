-- Story poll stickers — votes (1.0.9).
--
-- The 'poll' story sticker (question + 2–4 options). A poll is identified by a stable
-- text id baked into the sticker at compose time (pollId), so votes survive even
-- though the sticker itself lives in the story's `stickers` jsonb (no row to FK to).
-- ONE vote per user per poll (changeable). Raw per-user rows stay private — clients
-- only ever vote or read aggregate counts through the definer RPCs below.

create table if not exists public.story_poll_votes (
  poll_id text not null,
  story_id uuid not null references public.stories(id) on delete cascade, -- votes auto-clean with the story
  user_id uuid not null references auth.users(id) on delete cascade,
  option_index int not null check (option_index >= 0 and option_index < 4),
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);

alter table public.story_poll_votes enable row level security;

-- No direct client access — RLS has no policies (deny-all) AND grants are revoked, so
-- the rows are reachable only through the security-definer RPCs.
revoke all on table public.story_poll_votes from public;
revoke all on table public.story_poll_votes from anon;
revoke all on table public.story_poll_votes from authenticated;

-- Cast or change my vote.
create or replace function public.vote_story_poll(p_poll_id text, p_story_id uuid, p_option int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_option < 0 or p_option > 3 then raise exception 'bad option'; end if;
  insert into public.story_poll_votes (poll_id, story_id, user_id, option_index)
  values (p_poll_id, p_story_id, auth.uid(), p_option)
  on conflict (poll_id, user_id)
    do update set option_index = excluded.option_index, created_at = now();
end;
$$;

-- Aggregate counts per option (only options that have at least one vote; the client
-- fills zeros for the rest and computes the total).
create or replace function public.story_poll_results(p_poll_id text)
returns table(option_index int, votes int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select v.option_index, count(*)::int as votes
      from public.story_poll_votes v
     where v.poll_id = p_poll_id
     group by v.option_index;
end;
$$;

-- My own choice for a poll, or -1 if I haven't voted (drives the initial "show
-- options vs show results" state in the viewer).
create or replace function public.my_story_poll_vote(p_poll_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare opt int;
begin
  select option_index into opt
    from public.story_poll_votes
   where poll_id = p_poll_id and user_id = auth.uid();
  return coalesce(opt, -1);
end;
$$;

-- Author-only: who voted on this story's polls and which option they chose. Feeds
-- the owner's story-viewers list (voters sorted to the top alongside likers). Gated
-- to the story's author so a voter's individual choice stays private to the author.
create or replace function public.story_poll_voters(p_story_id uuid)
returns table(user_id uuid, poll_id text, option_index int)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.stories s where s.id = p_story_id and s.user_id = auth.uid()) then
    return;
  end if;
  return query
    select v.user_id, v.poll_id, v.option_index
      from public.story_poll_votes v
     where v.story_id = p_story_id;
end;
$$;

-- Lockdown (mirror profile_views.sql): no public, no anon; authenticated only.
revoke all on function public.vote_story_poll(text, uuid, int) from public;
revoke all on function public.vote_story_poll(text, uuid, int) from anon;
grant execute on function public.vote_story_poll(text, uuid, int) to authenticated;

revoke all on function public.story_poll_results(text) from public;
revoke all on function public.story_poll_results(text) from anon;
grant execute on function public.story_poll_results(text) to authenticated;

revoke all on function public.my_story_poll_vote(text) from public;
revoke all on function public.my_story_poll_vote(text) from anon;
grant execute on function public.my_story_poll_vote(text) to authenticated;

revoke all on function public.story_poll_voters(uuid) from public;
revoke all on function public.story_poll_voters(uuid) from anon;
grant execute on function public.story_poll_voters(uuid) to authenticated;
