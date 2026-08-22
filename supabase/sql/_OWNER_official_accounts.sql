-- Official Laybell accounts: Premium+ and a permanent Diamond emblem.  2026-08-21.
--
--   npx supabase db query --linked -f supabase/sql/_OWNER_official_accounts.sql
--
-- Grants @laybell and @3ddie the entitlements an operator's own accounts are
-- expected to have. Diamond is a CAPABILITY tier here — it gates creating
-- communities (communities.sql:380) and raises public-playlist slots.
--
-- ─── HOW THE EMBLEM IS ACTUALLY COMPUTED (read this before changing anything) ─
-- ⚠️ The comment at lib/badges.ts:13-14 is WRONG. It claims ">=8 diamond, 4-7
-- gold". The code at :169 is:
--
--     >= 16 diamond | >= 8 gold | >= 4 silver | >= 2 bronze
--
-- Points are the MAX TIER WEIGHT PER CATEGORY, summed (bronze 1 / silver 2 /
-- gold 4 / diamond 8). The catalog has exactly ONE diamond category — `login` —
-- so a single diamond badge is 8 points, which is GOLD, not diamond. That stale
-- comment is why the first attempt at this file produced a gold emblem.
--
-- Reaching 16 therefore needs several categories. This grants nine, totalling 32,
-- so the tier is diamond with a wide margin and stays there even if some rows are
-- later dropped.
--
-- ─── WHY THE NON-PERMANENT ONES SURVIVE ─────────────────────────────────────
-- evaluateBadges() drops a non-permanent badge only when
-- `!frozen && !isPerm && !qualifying` (lib/badges.ts:687). `frozen` comes from
-- badgeFreezeActive(), which is true whenever Premium+ is active
-- (lib/entitlements.ts:69). These accounts hold Premium+ until 2126, so the freeze
-- is permanently on and nothing here decays. Only `login_diamond_perm` and
-- `app_sharing_gold` are permanent in their own right (12 points — still gold),
-- so the freeze is doing real work.

do $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids
    from public.profiles
   where lower(username) in ('laybell', '3ddie');

  if v_ids is null or array_length(v_ids, 1) <> 2 then
    raise exception 'ABORT: expected exactly 2 official accounts, found %',
      coalesce(array_length(v_ids, 1), 0);
  end if;

  -- Entitlements. auth.uid() is null here, so protect_premium_until() lets this
  -- through — that guard stops a CLIENT self-granting, not the operator.
  update public.profiles
     set premium_until      = now() + interval '100 years',
         premium_plus_until = now() + interval '100 years',
         badge_tier         = 'diamond',
         profile_theme      = 'diamond'
   where id = any(v_ids);

  -- One badge per category, highest tier the catalog offers in each.
  -- 8 + 4 + 4 + 4 + 4 + 2 + 2 + 2 + 2 = 32 points.
  insert into public.user_badges (user_id, badge_key, category, tier, is_permanent)
  select u.id, b.badge_key, b.category, b.tier, b.is_permanent
    from unnest(v_ids) as u(id)
    cross join (values
      ('login_diamond_perm',   'login',           'diamond', true ),
      ('app_sharing_gold',     'app_sharing',     'gold',    true ),
      ('curator_gold',         'curator',         'gold',    false),
      ('daily_like_gold',      'daily_like',      'gold',    false),
      ('music_streaming_gold', 'music_streaming', 'gold',    false),
      ('posts_silver',         'posts',           'silver',  false),
      ('comments_silver',      'comments',        'silver',  false),
      ('community_silver',     'community',       'silver',  false),
      ('ads_silver',           'ads',             'silver',  false)
    ) as b(badge_key, category, tier, is_permanent)
  on conflict (user_id, badge_key) do nothing;
end $$;

-- ─── Verify: points must be >= 16 for the emblem to compute as diamond ───────
with per_category as (
  select p.username,
         b.category,
         max(case b.tier when 'diamond' then 8 when 'gold' then 4
                         when 'silver' then 2 else 1 end) as weight
    from public.profiles p
    join public.user_badges b on b.user_id = p.id
   where lower(p.username) in ('laybell', '3ddie')
   group by p.username, b.category
)
select username,
       sum(weight)                                as points_must_be_16_plus,
       case when sum(weight) >= 16 then 'diamond'
            when sum(weight) >= 8  then 'gold'
            when sum(weight) >= 4  then 'silver'
            else 'bronze' end                     as emblem_will_compute_as
  from per_category
 group by username
 order by username;

-- ─── To revert ──────────────────────────────────────────────────────────────
--   update public.profiles
--      set premium_until = null, premium_plus_until = null,
--          badge_tier = null, profile_theme = 'default'
--    where lower(username) in ('laybell','3ddie');
--   delete from public.user_badges
--    where user_id in (select id from public.profiles
--                       where lower(username) in ('laybell','3ddie'));
