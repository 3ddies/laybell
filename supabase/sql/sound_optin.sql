-- "Use this sound" — per-track consent + a global kill switch.
-- Run in the Supabase Dashboard → SQL Editor. Idempotent; safe to re-run.
-- Requires post_song.sql (posts.song_id and the song_* attribution columns).
--
-- WHY THIS EXISTS
-- Attaching someone else's audio to a video is SYNCHRONISATION. No performing-
-- rights licence covers sync — not the BMI agreement, not ASCAP, not any PRO
-- licence that will ever be issued. The only basis Laybell has for the feature is
-- the licence users grant in the Terms, which creates two problems:
--
--   1. A blanket clause buried in the Terms is the weakest form of that grant. A
--      specific, per-track choice the uploader actively made is materially more
--      defensible, and costs one toggle.
--
--   2. Without a withdrawal mechanism there is no way to undo a sound that has
--      already spread. Terms §8 promises removal reaches "any Attributed Uses
--      that incorporate it" — unachievable at scale by hand.
--
-- WHY WITHDRAWAL WORKS CLEANLY HERE
-- The attached song is NOT baked into the video file. Playback mutes the video and
-- plays the song alongside it (app/(tabs)/index.tsx: `muted={item.song_id ? true
-- : videoMuted}`). So clearing the attribution is enough — the video reverts to
-- its own audio, nothing needs re-encoding, and no one's video is destroyed.

-- ─── 1) Columns ─────────────────────────────────────────────────────────────
alter table public.posts
  -- The affirmative grant. See DEFAULT_SOUND_OPT_IN in lib/sounds.ts for the
  -- product/legal tradeoff on what this should default to — that is a policy
  -- decision, not a technical one.
  add column if not exists sound_opt_in       boolean not null default true,
  -- The kill switch. Set = the sound is withdrawn from the picker and stripped
  -- from every post that used it.
  add column if not exists sound_withdrawn_at timestamptz,
  -- Records WHEN consent was given, so the grant has a timestamp rather than
  -- being inferred from a column's current value.
  add column if not exists sound_opt_in_at    timestamptz;

-- The picker only ever wants opted-in, non-withdrawn audio.
create index if not exists posts_sound_available_idx
  on public.posts (type, created_at desc)
  where sound_opt_in = true and sound_withdrawn_at is null;

-- Finding derivatives fast matters — withdrawal has to be expeditious.
create index if not exists posts_song_id_idx on public.posts (song_id) where song_id is not null;


-- ─── 2) Withdraw a sound ────────────────────────────────────────────────────
-- Owner-only. Pulls the sound from the picker AND strips it from every post and
-- story that attached it, in one transaction. Returns how many were affected so
-- the UI can tell the user what just happened.
create or replace function public.withdraw_sound(p_post_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_posts  int := 0;
  v_stories int := 0;
begin
  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then raise exception 'post not found'; end if;
  if v_owner <> auth.uid() then raise exception 'not_owner'; end if;

  update public.posts
     set sound_withdrawn_at = now(), sound_opt_in = false
   where id = p_post_id;

  -- Strip the attribution from every derivative. Clearing song_id is what makes
  -- the borrowed audio actually stop playing: the player mutes a video only while
  -- a song is attached, so removing it hands the video back its own sound. The
  -- other user's post survives intact — this withdraws the audio, not their work.
  update public.posts
     set song_id = null, song_title = null, song_artist = null, song_artist_id = null
   where song_id = p_post_id;
  get diagnostics v_posts = row_count;

  begin
    update public.stories
       set song_id = null, song_title = null, song_artist = null, song_artist_id = null
     where song_id = p_post_id;
    get diagnostics v_stories = row_count;
  exception when undefined_table or undefined_column then
    v_stories := 0;   -- stories or its song columns not migrated; nothing to strip
  end;

  return jsonb_build_object('ok', true, 'posts_updated', v_posts, 'stories_updated', v_stories);
end $$;

grant execute on function public.withdraw_sound(uuid) to authenticated;


-- ─── 3) Re-allow ────────────────────────────────────────────────────────────
-- Withdrawal does not restore the posts that already lost the attribution —
-- that would mean silently re-attaching audio to other people's content without
-- asking them. It only puts the sound back in the picker for future use.
create or replace function public.allow_sound(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then
    raise exception 'not_owner';
  end if;
  update public.posts
     set sound_opt_in = true, sound_withdrawn_at = null, sound_opt_in_at = now()
   where id = p_post_id;
end $$;

grant execute on function public.allow_sound(uuid) to authenticated;


-- ─── 4) Backfill ────────────────────────────────────────────────────────────
-- Existing audio predates the toggle, so it has no recorded consent. The column
-- default makes it available; stamping the timestamp records that this was a
-- migration default rather than a choice anyone actually made. If you would
-- rather require existing creators to opt in explicitly, run this instead:
--
--   update public.posts set sound_opt_in = false
--    where type in ('audio','podcast','audiobook') and sound_opt_in_at is null;
--
update public.posts
   set sound_opt_in_at = coalesce(sound_opt_in_at, created_at)
 where type in ('audio', 'podcast', 'audiobook') and sound_opt_in_at is null;


-- Verify:
--   select id, caption, sound_opt_in, sound_withdrawn_at from public.posts
--    where type = 'audio' order by created_at desc limit 10;
--
-- Withdraw (as the owner):
--   select public.withdraw_sound('<audio post uuid>');
