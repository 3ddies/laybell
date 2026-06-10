-- Approximate location for account recommendations — Supabase columns + RPC
-- Run in the Supabase Dashboard → SQL Editor (the anon key cannot alter tables).
-- Until applied, the location toggle/onboarding step read/write nothing (columns
-- absent → writes ignored, reads null) and suggestions fall back to genre/affinity,
-- so the app keeps working either way.
--
-- Only COARSE location is stored: the client rounds lat/lng to 1 decimal (~11 km)
-- before saving, so this is an approximate area, never a precise position.

alter table public.profiles
  add column if not exists latitude         double precision,
  add column if not exists longitude        double precision,
  add column if not exists city             text,
  add column if not exists location_enabled boolean default false;

-- Nearby accounts ordered by great-circle (haversine) distance. SECURITY DEFINER so
-- the function can compute distance without exposing every user's coords through a
-- plain `select`. Only opted-in profiles (location_enabled) are considered; the
-- caller filters out already-followed / blocked accounts client-side.
create or replace function public.nearby_profiles(
  p_lat   double precision,
  p_lng   double precision,
  p_limit int default 30
)
returns table (
  id           uuid,
  username     text,
  display_name text,
  avatar_url   text,
  badge_tier   text,
  badge_show   boolean,
  city         text,
  distance_km  double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.username, p.display_name, p.avatar_url, p.badge_tier, p.badge_show, p.city,
    6371 * acos(greatest(-1, least(1,
      cos(radians(p_lat)) * cos(radians(p.latitude)) *
        cos(radians(p.longitude) - radians(p_lng))
      + sin(radians(p_lat)) * sin(radians(p.latitude))
    ))) as distance_km
  from public.profiles p
  where p.location_enabled = true
    and p.latitude is not null
    and p.longitude is not null
    and p.id <> auth.uid()
  order by distance_km asc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.nearby_profiles(double precision, double precision, int) to authenticated;
