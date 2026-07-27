-- ════════════════════════════════════════════════════════════════════════════
-- ORIGINALITY DEMOTION  ·  Community Guidelines §7 "Originality and reposting"
--
-- The Guidelines deliberately make originality a DISTRIBUTION question, not a
-- removal one: "our normal response is to limit reach, which means the post
-- stays up but is not recommended as widely." This file is that mechanism.
--
-- Run AFTER admin_console.sql + admin_console_rpcs.sql (it uses has_admin_role
-- and admin_log from those). Idempotent and additive: with no post flagged, the
-- multiplier is 1.0 everywhere and ranking is bit-for-bit unchanged.
--
-- WHY THE FLAG IS CLIENT-READABLE (a deliberate choice, unlike shadow-bans):
-- feed ranking runs in the APP (lib/feedScorer.ts), so the client must be able
-- to read the flag to apply it. Shadow-ban state is hidden behind private.*
-- helpers precisely so clients can't probe it; this is the opposite case on
-- purpose. A limited post is a published, appealable moderation decision under
-- §12/§13 of the Guidelines, not a secret one — so being able to see it is
-- consistent, not a leak. Do NOT "fix" this by hiding it without also moving
-- ranking server-side.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.posts
  add column if not exists originality_limited boolean not null default false,
  add column if not exists originality_reason  text,
  add column if not exists originality_note    text,
  add column if not exists originality_by      uuid,
  add column if not exists originality_at      timestamptz;

comment on column public.posts.originality_limited is
  'Moderator-set. Post stays visible; lib/feedScorer applies ORIGINALITY_LIMIT_MUL so it is recommended less. Client-readable on purpose (ranking runs in the app).';
comment on column public.posts.originality_reason is
  'One of the three enforceable tiers in Guidelines §7: watermark | duplicate | reupload | other.';

-- Partial index: the console lists currently-limited posts, and the set is small.
create index if not exists posts_originality_limited_idx
  on public.posts (originality_at desc) where originality_limited;


-- ════════════════════════════════════════════════════════════════════════════
-- WRITE · flag / unflag a post for originality
-- moderator+ (same bar as hide_content). A reason is REQUIRED when limiting and
-- constrained to the published tiers, so the audit log stays consistent enough
-- to review decisions against each other later.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_set_originality(
  p_post_id uuid, p_limited boolean, p_reason text, p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_owner uuid;
begin
  if not public.has_admin_role(v_uid, 'moderator') then raise exception 'not_admin'; end if;

  select user_id into v_owner from public.posts where id = p_post_id;
  if v_owner is null then raise exception 'post_not_found'; end if;

  if p_limited and coalesce(p_reason, '') not in ('watermark', 'duplicate', 'reupload', 'other') then
    raise exception 'reason must be one of: watermark, duplicate, reupload, other';
  end if;

  update public.posts
     set originality_limited = p_limited,
         originality_reason  = case when p_limited then p_reason else null end,
         originality_note    = case when p_limited then nullif(btrim(coalesce(p_note, '')), '') else null end,
         originality_by      = case when p_limited then v_uid else null end,
         originality_at      = case when p_limited then now()  else null end
   where id = p_post_id;

  perform public.admin_log(
    v_uid,
    case when p_limited then 'originality_limit' else 'originality_clear' end,
    'post', p_post_id::text, v_owner, null, p_reason,
    case when p_note is null then null else jsonb_build_object('note', p_note) end);
end $$;
revoke execute on function public.admin_set_originality(uuid, boolean, text, text) from public;
grant  execute on function public.admin_set_originality(uuid, boolean, text, text) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ · one post, everything a moderator needs to decide, in ONE round-trip
--
-- Returns the post itself, its author, live engagement counts, every moderation
-- state that applies to it, and the RANKING COMPONENTS.
--
-- On ranking: there is NO single "score" for a post. lib/feedScorer.scorePost is
-- VIEWER-SPECIFIC — creator/type/genre affinity, whether the viewer follows the
-- author, and whether they've already seen it all multiply in. So this returns
-- the viewer-INDEPENDENT components only (engagement, age, badge tier,
-- originality). The console renders those plus a "base score" and labels the
-- per-viewer multipliers as varying. Anything presented as one absolute score
-- would be a fiction.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_post_detail(p_post_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then raise exception 'not_admin'; end if;

  select jsonb_build_object(
    'post', (select jsonb_build_object(
        'id', p.id, 'user_id', p.user_id, 'type', p.type, 'caption', p.caption,
        'media_url', p.media_url, 'thumbnail_url', p.thumbnail_url, 'cover_url', p.cover_url,
        'genre', p.genre, 'is_public', p.is_public, 'created_at', p.created_at,
        'aspect_ratio', p.aspect_ratio, 'duration_seconds', p.duration_seconds,
        'video_status', p.video_status, 'legal_hold', coalesce(p.legal_hold, false),
        'song_title', p.song_title, 'song_artist', p.song_artist)
      from public.posts p where p.id = p_post_id),

    'author', (select jsonb_build_object(
        'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
        'avatar_url', pr.avatar_url, 'badge_tier', pr.badge_tier,
        'hidden', pr.hidden, 'is_minor', pr.is_minor)
      from public.profiles pr
      join public.posts p2 on p2.user_id = pr.id
      where p2.id = p_post_id),

    'originality', (select jsonb_build_object(
        'limited', coalesce(p.originality_limited, false),
        'reason',  p.originality_reason,
        'note',    p.originality_note,
        'at',      p.originality_at,
        'by',      (select a.username from public.profiles a where a.id = p.originality_by))
      from public.posts p where p.id = p_post_id),

    'taken_down', (select jsonb_build_object('active', t.active, 'reason', t.reason, 'at', t.created_at)
      from public.content_takedowns t
      where t.content_type = 'post' and t.content_id = p_post_id),

    'open_reports', (select count(*) from public.post_reports r
      where r.post_id = p_post_id and r.resolved_at is null),

    -- Viewer-INDEPENDENT ranking inputs. Names mirror lib/feedScorer.ScoredPost
    -- so the console can feed them straight into its mirrored formula.
    'ranking', (select jsonb_build_object(
        'likes',        (select count(*) from public.likes    l where l.post_id = p.id),
        'comments',     (select count(*) from public.comments c where c.post_id = p.id),
        'saves',        coalesce(p.save_count, 0),
        'reposts',      coalesce(p.repost_count, 0),
        'streams',      coalesce(p.stream_count, 0),
        'hours_old',    round(extract(epoch from (now() - p.created_at)) / 3600.0, 2),
        'badge_tier',   (select pr.badge_tier from public.profiles pr where pr.id = p.user_id),
        'originality_limited', coalesce(p.originality_limited, false))
      from public.posts p where p.id = p_post_id)
  ) into v_out;

  if v_out->'post' is null or v_out->'post' = 'null'::jsonb then raise exception 'post_not_found'; end if;
  return v_out;
end $$;
revoke execute on function public.admin_post_detail(uuid) from public;
grant  execute on function public.admin_post_detail(uuid) to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- READ · currently-limited posts, newest decision first (the review-your-own-
-- work list: originality calls are judgment calls, so they need to be re-readable
-- side by side).
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_list_originality(p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.has_admin_role(auth.uid(), 'reviewer') then raise exception 'not_admin'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'at' desc)
    from (
      select jsonb_build_object(
        'post_id', p.id, 'caption', left(coalesce(p.caption, ''), 120), 'type', p.type,
        'thumbnail_url', coalesce(p.thumbnail_url, p.cover_url),
        'reason', p.originality_reason, 'note', p.originality_note, 'at', p.originality_at,
        'username', pr.username,
        'by', (select a.username from public.profiles a where a.id = p.originality_by)) as x
      from public.posts p
      join public.profiles pr on pr.id = p.user_id
      where p.originality_limited
      order by p.originality_at desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) s
  ), '[]'::jsonb);
end $$;
revoke execute on function public.admin_list_originality(int) from public;
grant  execute on function public.admin_list_originality(int) to authenticated;
