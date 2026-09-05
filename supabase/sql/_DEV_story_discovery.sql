-- READ ONLY. What the Home tray's discovery rail would surface right now.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_story_discovery.sql
--
-- Mirrors fetchDiscoveryGroups in lib/stories.ts: active stories only, ranked
-- 0.6 popularity (a like counts double a view, normalised to the top author) and
-- 0.4 recency over the 24h window, hidden accounts dropped. Blocks are per-viewer
-- so they are NOT applied here — this is the pool before any one person's
-- filtering, which is why an author can appear below and still not be shown.

with active as (
  select s.id, s.user_id, s.created_at
    from public.stories s
    join public.profiles p on p.id = s.user_id
   where s.expires_at > now()
     and coalesce(p.hidden, false) = false
),
pop as (
  select a.user_id,
         count(distinct v.story_id) filter (where v.story_id is not null)
           + 2 * count(distinct l.story_id) filter (where l.story_id is not null) as raw
    from active a
    left join public.story_views v on v.story_id = a.id
    left join public.story_likes l on l.story_id = a.id
   group by a.user_id
),
newest as (
  select user_id, max(created_at) as newest_at, count(*) as stories
    from active group by user_id
)
select
  p.username,
  n.stories,
  coalesce(pop.raw, 0)                                   as popularity_points,
  to_char(n.newest_at, 'YYYY-MM-DD HH24:MI')             as newest_story,
  round((
    0.6 * (coalesce(pop.raw, 0)::numeric
           / greatest(1, (select max(raw) from pop)))
    + 0.4 * greatest(0, least(1,
        1 - extract(epoch from (now() - n.newest_at)) / 86400.0))
  )::numeric, 4)                                          as score
  from newest n
  join public.profiles p on p.id = n.user_id
  left join pop on pop.user_id = n.user_id
 order by score desc, n.newest_at desc
 limit 10;
