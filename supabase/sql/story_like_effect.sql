-- Powers the fun like effect EVERY viewer sees on a liked story: floating hearts
-- that grow with the like count, likers' profile pics flashing by, and — new — an
-- optional PUBLIC "like comment" a liker can attach, shown in a speech bubble while
-- their pic pauses on screen. Run manually in the Supabase SQL editor / db query.

-- Optional public comment on a like (nullable; a plain like has none). Short public
-- message shown to everyone in the effect, never a private DM (that's the reply pill).
alter table public.story_likes add column if not exists comment text;

-- The liker may UPDATE their own row, to set / edit / clear the comment. (insert +
-- delete policies already live in story_likes.sql.)
drop policy if exists "Users can update their story likes" on public.story_likes;
create policy "Users can update their story likes"
  on public.story_likes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The story OWNER can pin ONE liker's comment: it shows FIRST in the effect with a
-- gold pin. Stored as that liker's user_id on the story; the owner sets it under the
-- existing stories UPDATE policy (auth.uid() = user_id). Null = nothing pinned; if the
-- pinned liker later unlikes, it simply stops matching (no FK needed).
alter table public.stories add column if not exists pinned_like_by uuid;

-- Effect payload: { count, likers:[{id, avatar, username, comment}] } — the FULL like
-- total (so the effect can scale) and up to p_limit (1..12) likers, commented ones
-- surfaced first then newest. Each liker is their id + avatar URL + username + optional
-- PUBLIC comment. It is NOT a scrollable list — just the ambient effect — and the
-- owner's viewers sheet remains the detailed roster. Hidden accounts excluded; anon
-- denied. (2026-10-07, iteratively on owner request: the effect started name-less &
-- un-clickable, then gained usernames, then the id so a viewer can tap a liker's pic
-- to open their profile. Deliberate product choice — likes are public here.)
--
-- SECURITY DEFINER because a non-owner can't read story_likes under RLS at all.
drop function if exists public.story_has_likes(uuid);

create or replace function public.story_like_effect(p_story_id uuid, p_limit int default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then jsonb_build_object('count', 0, 'likers', '[]'::jsonb)
    else jsonb_build_object(
      'count', (select count(*) from public.story_likes where story_id = p_story_id),
      'likers', coalesce((
        select jsonb_agg(
          jsonb_build_object('id', x.id, 'avatar', x.avatar_url, 'username', x.username, 'comment', x.comment, 'pinned', x.pinned)
          order by x.pinned desc, (x.comment is not null) desc, x.created_at desc  -- pinned first in the array
        )
        from (
          select sl.user_id as id, p.avatar_url, p.username, sl.created_at,
                 nullif(btrim(sl.comment), '') as comment,
                 coalesce(sl.user_id = (select pinned_like_by from public.stories where id = p_story_id), false) as pinned
          from public.story_likes sl
          join public.profiles p on p.id = sl.user_id
          where sl.story_id = p_story_id
            and coalesce(p.hidden, false) = false
            -- skip a liker who'd show nothing (no pic AND no comment)
            and (p.avatar_url is not null or nullif(btrim(sl.comment), '') is not null)
          order by pinned desc, (nullif(btrim(sl.comment), '') is not null) desc, sl.created_at desc
          limit greatest(1, least(coalesce(p_limit, 6), 12))
        ) x
      ), '[]'::jsonb)
    )
  end;
$$;

-- Authenticated users only. `revoke from public` does NOT block the anon role on
-- this project — it must be revoked BY NAME (verify with pg_proc.proacl).
revoke all on function public.story_like_effect(uuid, int) from public;
revoke all on function public.story_like_effect(uuid, int) from anon;
grant execute on function public.story_like_effect(uuid, int) to authenticated;
