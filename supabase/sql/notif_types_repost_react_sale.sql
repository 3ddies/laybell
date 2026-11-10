-- Allow three new notification types: 'repost', 'react', 'sale'.
--
--   npx supabase db query --remote --yes -f supabase/sql/notif_types_repost_react_sale.sql
--
-- Purely additive — it widens the notifications.type CHECK to accept the new
-- kinds. Existing rows and inserts are unaffected. Deploy this BEFORE the app
-- build that starts creating repost/react rows, or those inserts are rejected by
-- the constraint (createNotification swallows the error, so they'd just fail
-- silently).
--
--   • repost — someone reposted your post            (client: lib/reposts.ts)
--   • react  — someone reacted to / remixed your post (client: UploadQueueContext)
--   • sale   — someone bought your beat               (server trigger: sale_notification.sql)
--
-- The full list is the live constraint (13 types) plus the three new ones; keep
-- it in sync if a later migration adds a type.

alter table public.notifications drop constraint if exists notifications_type_check;

alter table public.notifications add constraint notifications_type_check
  check (type in (
    'like', 'comment', 'follow', 'friend', 'message', 'mention',
    'song_used', 'song_story', 'tag', 'offer', 'studio_invite',
    'system', 'live_started',
    'repost', 'react', 'sale'
  ));

-- Confirm.
select pg_get_constraintdef(oid) as def
  from pg_constraint
 where conrelid = 'public.notifications'::regclass
   and conname = 'notifications_type_check';
