-- Timed video captions — the 1.0.3 video editor.
--
-- A caption can now appear and leave on cue: the same sticker object as
-- posts.captions plus optional `start` / `end`, in seconds on the published
-- video's clock (lib/stickerTiming.ts).
--
-- A NEW column rather than timing fields inside posts.captions, because every
-- app before 1.0.3 draws posts.captions whole: a timed caption stored there would
-- show on those apps for the entire video, stacked over every other caption. The
-- composer splits on publish (splitForPublish): captions that cover the whole
-- video still go to posts.captions, which every version draws, and only the timed
-- ones come here — an older app shows the video without them.
--
-- Additive and nullable. Live apps neither read nor write it, so this is safe to
-- run at any time. If PostgREST has not seen the column yet, the upload queue
-- drops the field and inserts again (contexts/UploadQueueContext.tsx), so a post
-- is never lost to the order things were deployed in.

alter table public.posts add column if not exists timed_captions jsonb;

-- Shape guard. The editor caps a post at 20 captions of up to 200 characters,
-- far inside these limits; the check is for writes that do not come from it.
-- CASE, not AND: Postgres does not promise to evaluate AND left to right, and
-- jsonb_array_length raises on a non-array instead of returning false.
alter table public.posts drop constraint if exists posts_timed_captions_shape;
alter table public.posts add constraint posts_timed_captions_shape check (
  timed_captions is null
  or case
       when jsonb_typeof(timed_captions) = 'array'
         then jsonb_array_length(timed_captions) <= 30 and pg_column_size(timed_captions) <= 65536
       else false
     end
);

notify pgrst, 'reload schema';

-- Verify (expect one row, jsonb):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'posts' and column_name = 'timed_captions';
