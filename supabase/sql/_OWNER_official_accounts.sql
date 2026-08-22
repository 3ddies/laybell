-- Official Laybell accounts: Premium+ and a permanent Diamond emblem.  2026-08-21.
--
--   npx supabase db query --linked -f supabase/sql/_OWNER_official_accounts.sql
--
-- Grants @laybell and @3ddie the entitlements an operator's own accounts are
-- expected to have. Nobody is defrauded: no money moves, no subscription is
-- misrepresented, and Diamond is a CAPABILITY tier here — it gates creating
-- communities (communities.sql:380) and raises public-playlist slots, both of
-- which official accounts legitimately need.
--
-- ─── WHY THE BADGE IS GRANTED THIS WAY ──────────────────────────────────────
-- Setting profiles.badge_tier alone does NOT stick: lib/badges.ts:737 recomputes
-- the emblem from held badges on every app open and writes the earned value back,
-- so a manual tier is overwritten the next time the owner opens the app.
--
-- What DOES survive is a permanent badge row. evaluateBadges() keeps any row whose
-- catalog entry is `permanent: true` (`isPerm`), and the rollup takes the max tier
-- weight per category — diamond weighs 8, and 8 points is exactly the diamond
-- emblem threshold. So one permanent diamond badge produces a durable Diamond.
--
-- ⚠️ HONESTY NOTE: the only permanent diamond in the catalog is
-- `login_diamond_perm`, titled "Permanent Diamond Login — Log in 90 days in a
-- row". Granting it therefore asserts a streak that was not run. That is the
-- available mechanism in shipped build 4, not the right one.
-- **The clean fix in 1.0.1** is to repurpose the TEST_FORCE_TIER map in
-- lib/badges.ts into a staff list containing 'laybell' and '3ddie' — which also
-- removes the 'observer'/'rachaelhall' entries that are currently an exploit (see
-- reserved_usernames.sql). Then this grant can be reverted with the block at the
-- bottom of this file.

do $$
declare
  v_ids uuid[];
  v_n   int;
begin
  select array_agg(id) into v_ids
    from public.profiles
   where lower(username) in ('laybell', '3ddie');

  if v_ids is null or array_length(v_ids, 1) <> 2 then
    raise exception 'ABORT: expected exactly 2 official accounts, found %',
      coalesce(array_length(v_ids, 1), 0);
  end if;

  -- Entitlements. auth.uid() is null here, so protect_premium_until() lets this
  -- through — that guard exists to stop a CLIENT self-granting, not the operator.
  update public.profiles
     set premium_until      = now() + interval '100 years',
         premium_plus_until = now() + interval '100 years',
         badge_tier         = 'diamond',
         profile_theme      = 'diamond'
   where id = any(v_ids);

  -- The durable half: a permanent diamond badge the recompute will preserve.
  insert into public.user_badges (user_id, badge_key, category, tier, is_permanent)
  select unnest(v_ids), 'login_diamond_perm', 'login', 'diamond', true
  on conflict (user_id, badge_key) do nothing;

  get diagnostics v_n = row_count;
  raise notice 'granted % badge row(s) across % accounts', v_n, array_length(v_ids,1);
end $$;

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  p.username,
  (p.premium_until      > now()) as premium,
  (p.premium_plus_until > now()) as premium_plus,
  p.badge_tier,
  (select count(*) from public.user_badges b
    where b.user_id = p.id and b.is_permanent)      as permanent_badges
from public.profiles p
where lower(p.username) in ('laybell', '3ddie', 'laybellreview')
order by p.username;

-- ─── To revert (after 1.0.1 adds a proper staff tier) ───────────────────────
--   update public.profiles
--      set premium_until = null, premium_plus_until = null,
--          badge_tier = null, profile_theme = 'default'
--    where lower(username) in ('laybell','3ddie');
--   delete from public.user_badges
--    where badge_key = 'login_diamond_perm'
--      and user_id in (select id from public.profiles
--                       where lower(username) in ('laybell','3ddie'));
