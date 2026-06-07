-- Video trim window (metadata) — Supabase
-- Run in the Supabase Dashboard → SQL Editor.
--
-- Lets a user post a 90s window out of a longer video without re-encoding: the
-- full (size-capped) source is uploaded and players loop [trim_start, trim_end].
-- Both null  => play the whole video normally.

alter table public.posts
  add column if not exists trim_start double precision,
  add column if not exists trim_end   double precision;
