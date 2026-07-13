-- Give point-located history entries a stable identity ("locations"), instead of
-- each row carrying its own disconnected lat/lng. Without this, "add entry here"
-- on an existing marker created a brand-new, unrelated marker at (nearly) the same
-- spot instead of adding to that spot's history -- there was no way to see e.g. "a
-- tree fell here" followed later by "cleared" as one continuous story.
--
-- Written defensively (if-exists/if-not-exists/or-replace throughout) so it's safe
-- to re-run after a partial failure without knowing exactly what did or didn't
-- commit from the earlier attempt.

create table if not exists public.locations (
  id          uuid primary key default gen_random_uuid(),
  geog        geography(Point, 4326) not null,
  label       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) default auth.uid()
);

create index if not exists locations_geog_idx on public.locations using gist (geog);

comment on table public.locations is
  'Point identity for history entries not (only) tied to a trail_id -- e.g. a '
  'windfall that gets logged, then later logged again as cleared. Distinct from '
  'trails: a location has no OSM reference, it only exists because someone placed '
  'a marker.';

alter table public.locations enable row level security;
drop policy if exists "locations: authenticated full access" on public.locations;
create policy "locations: authenticated full access" on public.locations
  for all to authenticated using (true) with check (true);

-- Computed column (same pattern as 0003's location_geojson) -- PostgREST returns
-- geography columns as WKB hex text by default, not GeoJSON.
create or replace function public.geojson(rec public.locations)
returns jsonb
language sql
stable
as $$
  select ST_AsGeoJSON(rec.geog)::jsonb;
$$;

grant execute on function public.geojson(public.locations) to authenticated;

-- trail_history now points at a locations row instead of carrying its own point.
alter table public.trail_history add column if not exists location_id uuid references public.locations(id);

-- Superseded by location_id -> locations.geog: drop the per-row point and the
-- computed-column function that read it (0003), together, since the function's
-- signature references the trail_history row type directly.
drop function if exists public.location_geojson(public.trail_history);
alter table public.trail_history drop column if exists location;

alter table public.trail_history drop constraint if exists trail_history_needs_a_target;
alter table public.trail_history add constraint trail_history_needs_a_target
  check (trail_id is not null or location_id is not null);

create index if not exists trail_history_location_id_idx on public.trail_history (location_id);

-- Finds an existing location within snap_meters of (lng, lat), or creates one.
-- Used only when placing a *new* point (the "add entry at this point" flow,
-- starting from a trail's popup) -- "add entry here" on an existing marker
-- already has that marker's location_id and skips this entirely, so it can
-- never end up snapping to the wrong nearby spot.
create or replace function public.find_or_create_location(
  p_lng double precision,
  p_lat double precision,
  snap_meters double precision default 15
) returns uuid
language plpgsql
security invoker
as $$
declare
  found_id uuid;
  new_point geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
begin
  select id into found_id
    from public.locations
    where ST_DWithin(geog, new_point, snap_meters)
    order by ST_Distance(geog, new_point)
    limit 1;

  if found_id is not null then
    return found_id;
  end if;

  insert into public.locations (geog) values (new_point) returning id into found_id;
  return found_id;
end;
$$;

grant execute on function public.find_or_create_location(double precision, double precision, double precision)
  to authenticated;
