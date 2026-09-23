-- Per-post view/play time series for the POST OWNER's analytics screen.
--
-- Why an RPC: the `views` and `streams` tables are readable only by the user who
-- CREATED each row ("Users read own views"), so a post owner cannot read the
-- individual view/stream rows on their own post. This SECURITY DEFINER function
-- bypasses that RLS but hands back ONLY aggregate counts, and ONLY to the post's
-- owner — no per-viewer identity, timestamps of individuals, or device ids ever
-- leave the server. It is read-only and additive; nothing in shipped builds
-- calls it, so deploying it early is harmless.
--
-- p_unit picks the bucket size ('hour' | 'day' | 'week'); the client chooses it
-- from the post's age and builds the continuous (zero-filled) axis itself, so the
-- server only returns the non-empty buckets.

create or replace function public.post_view_series(p_post_id uuid, p_unit text default 'day')
returns table(bucket timestamptz, views bigint, plays bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  u text;
begin
  select user_id into v_owner from public.posts where id = p_post_id;
  -- Owner only. Anonymous callers (auth.uid() null) fail this and get nothing.
  if v_owner is null or v_owner is distinct from auth.uid() then
    return;
  end if;

  u := case when p_unit in ('hour', 'day', 'week') then p_unit else 'day' end;

  return query
    with v as (
      select date_trunc(u, created_at) as b, count(*)::bigint as c
      from public.views where post_id = p_post_id group by 1
    ),
    s as (
      select date_trunc(u, created_at) as b, count(*)::bigint as c
      from public.streams where post_id = p_post_id group by 1
    )
    select coalesce(v.b, s.b) as bucket,
           coalesce(v.c, 0)   as views,
           coalesce(s.c, 0)   as plays
    from v
    full outer join s on v.b = s.b
    order by 1;
end;
$$;

-- Lock it to signed-in users; revoke anon BY NAME (revoking from public alone
-- does not remove anon's default execute grant).
revoke all on function public.post_view_series(uuid, text) from public;
revoke all on function public.post_view_series(uuid, text) from anon;
grant execute on function public.post_view_series(uuid, text) to authenticated;
