-- TEMPORARY: hold @laybell and @3ddie at Diamond until 1.0.1 ships.  2026-08-21.
--
--   npx supabase db query --linked -f supabase/sql/_OWNER_diamond_bridge_6mo.sql
--
-- ⏳ **THIS EXPIRES ~2027-02-22.** It is a bridge, not a solution. The real fix is
-- one line in 1.0.1 — see the bottom of this file.
--
-- ─── WHY A BRIDGE IS NEEDED AT ALL ──────────────────────────────────────────
-- The emblem needs 16 points (computeEmblemTier, lib/badges.ts:169), scored as the
-- MAX TIER WEIGHT PER CATEGORY, summed. Only TWO badges in the whole catalogue are
-- permanent:
--     login_diamond_perm  diamond  8
--     app_sharing_gold    gold     4
-- That is 12 — gold. Every other badge counts only WHILE it qualifies, so an
-- account with no daily activity cannot hold Diamond, and setting profiles.badge_tier
-- by hand is undone the moment the app recomputes on open.
--
-- ⚠️ The Premium+ "badge freeze" does NOT close this gap, though its own comment
-- claims it does. lib/badges.ts:687 skips lapse-driven DELETES while frozen, but the
-- point rollup at :707 counts only `isPerm(r) || qKeys.has(r.badge_key)` — so frozen
-- rows survive in the table and still score zero. **That is a real bug affecting
-- paying Premium+ subscribers**, not just these accounts: they are promised their
-- tier survives without maintenance, and it does not. Logged as backlog item 3c.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
-- Writes daily activity rows that make several categories qualify every day:
--     likes 12          → daily_like gold   (needs a 7-day streak of >= 10)   4
--     music_seconds 2000→ music_streaming gold (needs >= 1800 today)          4
--     comments 3        → comments silver   (needs >= 2 today)                2
--     ad_engagements 2  → ads silver        (needs >= 2 today)                2
--   plus the two permanent badges                                            12
--                                                                       ----------
--                                                                        24 points
-- 24 >= 16, so the emblem computes as diamond with margin — it stays there even if
-- one category stops qualifying.
--
-- Rows run from 90 days back to ~6 months forward. The forward rows matter: streaks
-- are measured backwards from *today*, so tomorrow needs its own row or the streak
-- breaks. Backfilling the future is what makes this hold without daily maintenance.

do $$
declare
  v_ids uuid[];
  v_from date := current_date - 90;
  v_to   date := current_date + 185;   -- ~6 months
  v_rows int;
begin
  select array_agg(id) into v_ids
    from public.profiles
   where lower(username) in ('laybell', '3ddie');

  if v_ids is null or array_length(v_ids, 1) <> 2 then
    raise exception 'ABORT: expected exactly 2 official accounts, found %',
      coalesce(array_length(v_ids, 1), 0);
  end if;

  insert into public.user_activity_daily
    (user_id, day, likes, comments, music_seconds, posts_created, ad_engagements)
  select u.id, d::date, 12, 3, 2000, 0, 2
    from unnest(v_ids) as u(id)
    cross join generate_series(v_from, v_to, interval '1 day') as d
  on conflict (user_id, day) do update
    set likes          = greatest(public.user_activity_daily.likes, excluded.likes),
        comments       = greatest(public.user_activity_daily.comments, excluded.comments),
        music_seconds  = greatest(public.user_activity_daily.music_seconds, excluded.music_seconds),
        ad_engagements = greatest(public.user_activity_daily.ad_engagements, excluded.ad_engagements);

  get diagnostics v_rows = row_count;
  raise notice 'wrote % activity rows (% .. %)', v_rows, v_from, v_to;

  -- Set the emblem now so it is right before the next recompute, which will agree.
  update public.profiles
     set badge_tier = 'diamond', profile_theme = 'diamond'
   where id = any(v_ids);
end $$;

-- ─── Verify ─────────────────────────────────────────────────────────────────
select
  p.username,
  p.badge_tier,
  (select count(*) from public.user_activity_daily a
    where a.user_id = p.id and a.day >= current_date)          as future_days_covered,
  (select max(day) from public.user_activity_daily a
    where a.user_id = p.id)                                    as covered_until
from public.profiles p
where lower(p.username) in ('laybell', '3ddie')
order by p.username;

-- ─── THE REAL FIX, FOR 1.0.1 ────────────────────────────────────────────────
-- lib/badges.ts:628 already has the mechanism: TEST_FORCE_TIER, a username→tier map
-- that skips recompute entirely. Rename it to a staff list, drop the 'observer' and
-- 'rachaelhall' entries (which are a live privilege exploit — see
-- reserved_usernames.sql), and add 'laybell' and '3ddie'. One change fixes three
-- things: the exploit, the owner's tier, and the need for this file.
--
-- Then revert this bridge:
--   delete from public.user_activity_daily
--    where user_id in (select id from public.profiles
--                       where lower(username) in ('laybell','3ddie'));
