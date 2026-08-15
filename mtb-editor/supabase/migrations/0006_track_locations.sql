-- Point identity for track comments/photos, so a comment or bulk-matched photo can
-- be attached to a specific spot along a track rather than only the track as a
-- whole -- mirrors trails' locations/trail_history.location_id design (see
-- 0004_locations.sql). Deliberately a SEPARATE table from the trail-side
-- `locations`, not a shared one: that table's RLS is authenticated-only by
-- design, and track comments need to support anonymous share-link authors (see
-- 0005's design comment). Retrofitting anon access onto `locations` would widen
-- what the trail-annotation feature exposes; a dedicated table keeps the two
-- features' access models independent.

create table public.track_locations (
  id          uuid primary key default gen_random_uuid(),
  track_id    uuid not null references public.tracks(id) on delete cascade,
  geog        geography(Point, 4326) not null,
  label       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) default auth.uid()
);

create index track_locations_track_id_idx on public.track_locations (track_id);
create index track_locations_geog_idx     on public.track_locations using gist (geog);

alter table public.track_locations enable row level security;
create policy "track_locations: authenticated full access" on public.track_locations
  for all to authenticated using (true) with check (true);

-- track_history entries with location_id null are the "whole track" bucket
-- (same convention as trail_history: no location = trail/track-level entry).
alter table public.track_history
  add column if not exists location_id uuid references public.track_locations(id) on delete set null;
create index if not exists track_history_location_id_idx on public.track_history (location_id);

-- get_public_track_history's return shape is changing (new location_id column) --
-- CREATE OR REPLACE can't change a function's return type, so drop first.
drop function if exists public.get_public_track_history(uuid);
create function public.get_public_track_history(p_track_id uuid)
returns table (id uuid, entry_type text, value jsonb, author_name text, location_id uuid, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select id, entry_type, value, author_name, location_id, created_at
  from public.track_history
  where track_id = p_track_id
  order by created_at;
$$;

create or replace function public.get_public_track_locations(p_track_id uuid)
returns table (id uuid, geojson jsonb, label text)
language sql
stable
security definer
set search_path = public
as $$
  select id, ST_AsGeoJSON(geog)::jsonb, label
  from public.track_locations
  where track_id = p_track_id;
$$;

-- All locations across every track in a project in one call, so the map's point
-- markers can be populated on project-open without one RPC round trip per track.
create or replace function public.get_public_project_locations(p_project_id uuid)
returns table (id uuid, track_id uuid, geojson jsonb, label text)
language sql
stable
security definer
set search_path = public
as $$
  select tl.id, tl.track_id, ST_AsGeoJSON(tl.geog)::jsonb, tl.label
  from public.track_locations tl
  join public.tracks t on t.id = tl.track_id
  where t.project_id = p_project_id;
$$;

-- Finds an existing track_location within snap_meters of (lng,lat) on this
-- track, or creates one. Mirrors find_or_create_location (0004) but scoped to a
-- track and, unlike that one, granted to anon too -- clicking a track to leave a
-- comment is exactly the anonymous-visitor flow this whole feature exists for.
create or replace function public.find_or_create_track_location(
  p_track_id uuid,
  p_lng double precision,
  p_lat double precision,
  snap_meters double precision default 15
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  found_id uuid;
  new_point geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
begin
  select id into found_id
    from public.track_locations
    where track_id = p_track_id and ST_DWithin(geog, new_point, snap_meters)
    order by ST_Distance(geog, new_point)
    limit 1;

  if found_id is not null then
    return found_id;
  end if;

  insert into public.track_locations (track_id, geog) values (p_track_id, new_point) returning id into found_id;
  return found_id;
end;
$$;

-- add_track_comment gains an optional location -- return type is unchanged (still
-- `uuid`) but the parameter list is, so this creates a new overload unless the old
-- one is dropped first; drop it explicitly rather than leaving both versions live.
drop function if exists public.add_track_comment(uuid, text, text);
create function public.add_track_comment(
  p_track_id uuid,
  p_text text,
  p_author_name text default null,
  p_location_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  clean_name text := nullif(trim(coalesce(p_author_name, '')), '');
begin
  if p_text is null or length(trim(p_text)) = 0 then
    raise exception 'comment text is required';
  end if;
  if length(p_text) > 2000 then
    raise exception 'comment text too long (max 2000 characters)';
  end if;
  if auth.uid() is null and clean_name is null then
    raise exception 'a name is required to comment without an account';
  end if;

  insert into public.track_history (track_id, entry_type, value, author_name, created_by, location_id)
  values (
    p_track_id, 'comment', jsonb_build_object('text', p_text),
    case when auth.uid() is null then clean_name else null end,
    auth.uid(), p_location_id
  )
  returning id into new_id;

  return new_id;
end;
$$;

grant execute on function public.get_public_track_history(uuid)                              to anon, authenticated;
grant execute on function public.get_public_track_locations(uuid)                             to anon, authenticated;
grant execute on function public.get_public_project_locations(uuid)                           to anon, authenticated;
grant execute on function public.find_or_create_track_location(uuid, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.add_track_comment(uuid, text, text, uuid)                    to anon, authenticated;
