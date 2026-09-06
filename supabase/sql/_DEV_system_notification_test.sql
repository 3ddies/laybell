-- Put three Laybell system notifications on ONE account so the new row can be
-- looked at on a device before 1.0.2 ships.
--
--   npx supabase db query --linked -f supabase/sql/_DEV_system_notification_test.sql
--
-- Runs against PRODUCTION, but everything it writes is removed by the cleanup at
-- the bottom of this file, and re-running it replaces its own rows rather than
-- stacking more up.
--
-- THIS SENDS NO PUSH. A notifications row is just a row; push comes from
-- send_reengagement_nudges() or the send-push function, neither of which is
-- involved here. Nobody's phone lights up — the rows are waiting in the app.
--
-- The three cover the shapes the renderer has to handle:
--   followers  — carries a NUMBER, so it exercises system_n and the plural form
--   earnings   — no number, and the one that routes somewhere else (/wallet)
--   back       — the generic fallback, and what an OLD build shows for a key it
--                does not recognise
-- They also prove system rows do NOT group together, since they share a null
-- actor_id and would collapse into one if the grouping key were wrong.

do $$
declare
  v_id uuid;
begin
  select id into v_id from public.profiles where username = '3ddie';
  if v_id is null then
    raise exception 'No account with username 3ddie - nothing to test against.';
  end if;

  -- Idempotent: clear this file's previous rows before writing new ones.
  delete from public.notifications
   where user_id = v_id and type = 'system' and system_key in ('followers','earnings','back');

  -- Staggered timestamps so they sort predictably and land in the "Today"
  -- section, newest first, exactly as real ones would.
  insert into public.notifications (user_id, actor_id, type, system_key, system_n, read, created_at)
  values
    (v_id, null, 'system', 'followers', 3, false, now() - interval '2 minutes'),
    (v_id, null, 'system', 'earnings',  null, false, now() - interval '9 minutes'),
    (v_id, null, 'system', 'back',      null, false, now() - interval '25 minutes');

  raise notice 'Inserted 3 system notifications for 3ddie (%).', v_id;
end $$;

-- ─── What to look for on the device ─────────────────────────────────────────
--   • The Laybell app icon in the avatar slot, a rounded SQUARE, not a circle,
--     and with no story ring around it.
--   • NO type emblem on the corner, and no badge emblem either — a Laybell
--     message has no actor, so neither belongs.
--   • "Laybell" bold on its own line, the sentence beneath it. Not run together.
--   • Three SEPARATE rows. If they collapsed into one, grouping is wrong.
--   • "3 people followed you while you were away." — the number came from
--     system_n, so if it reads "0 people" the interpolation is broken.
--   • Tapping: followers -> your profile, earnings -> /wallet, back -> the feed.
--   • Leaving the screen and coming back drops the unread highlight (the screen
--     marks everything read on load) but the rows stay.

select id, system_key, system_n, read, to_char(created_at, 'HH24:MI:SS') as at
  from public.notifications
 where user_id = (select id from public.profiles where username = '3ddie')
   and type = 'system'
 order by created_at desc;

-- ─── CLEANUP — run this when the check is done ──────────────────────────────
-- delete from public.notifications
--  where user_id = (select id from public.profiles where username = '3ddie')
--    and type = 'system'
--    and system_key in ('followers','earnings','back');
