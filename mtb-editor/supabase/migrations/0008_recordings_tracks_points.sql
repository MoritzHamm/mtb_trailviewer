-- Projects rework: recordings -> tracks -> project-level points/comments.
--
-- Replaces 0005-0007's track model. A project now holds three kinds of thing:
--
--   recordings      raw uploaded .fit/.gpx files (full parsed point list). Raw
--                   material only -- never shown to share-link visitors.
--   tracks          the actual content of a project: lines extracted from a
--                   recording (start/end index range), drawn manually, or
--                   copied from an OSM way, then edited.
--   project_points  comment/photo locations, owned by the PROJECT rather than a
--                   track -- bulk photos are matched against a recording's
--                   timestamps before any track covering them necessarily
--                   exists. Which track a point is "on" is computed client-side
--                   (nearest track), never stored, so it can't go stale as
--                   tracks are edited/split/deleted.
--   project_history comment/image entries. A thread is one of: a point
--                   (point_id set), a whole track (track_id set, point_id null),
--                   or the project as a whole (both null).
--
-- WIPES all existing tracks/track_locations/track_history rows (agreed: test data
-- only). Projects themselves are kept. Photos already in the track-images bucket
-- become orphaned -- delete them from the Storage UI if you care about the space.
--
-- Anonymous (share-link) access model is unchanged from 0005: no table grants,
-- only the security-definer get_public_* / find_or_create_project_point /
-- add_project_comment functions below.

-- ---------------------------------------------------------------------------------
-- Drop the old model
-- ---------------------------------------------------------------------------------
drop function if exists public.get_public_tracks(uuid);
drop function if exists public.get_public_track_history(uuid);
drop function if exists public.get_public_track_locations(uuid);
drop function if exists public.get_public_project_locations(uuid);
drop function if exists public.find_or_create_track_location(uuid, double precision, double precision, double precision);
drop function if exists public.add_track_comment(uuid, text, text, uuid);
drop function if exists public.add_track_comment(uuid, text, text);

drop table if exists public.track_history;
drop table if exists public.track_locations;
drop table if exists public.tracks;

-- ---------------------------------------------------------------------------------
-- Recordings
-- ---------------------------------------------------------------------------------
create table public.recordings (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  file_name   text,
  format      text not null check (format in ('fit', 'gpx')),
  -- Full parsed point list, [{lat,lng,ele,time}, ...] (time = epoch ms or null).
  -- A 3h ride at 1Hz is ~10k points / ~600KB -- fine as jsonb. Immutable.
  points      jsonb not null,
  point_count integer not null,
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) default auth.uid()
);
create index recordings_project_id_idx on public.recordings (project_id);

-- ---------------------------------------------------------------------------------
-- Tracks
-- ---------------------------------------------------------------------------------
create table public.tracks (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id) on delete cascade,
  name                  text,
  source                text not null check (source in ('recording', 'manual', 'osm_way')),

  -- Current/working geometry -- what the Tracks-mode editor edits.
  geom                  geography(LineString, 4326) not null,

  -- source = 'recording': which recording and which inclusive index range of its
  -- points this track was cut from. recording_id is nulled (not cascaded) when the
  -- recording is deleted -- the track lives on via raw_points below.
  recording_id          uuid references public.recordings(id) on delete set null,
  recording_start_idx   integer,
  recording_end_idx     integer,

  -- Frozen copy of the original points ([{lat,lng,ele,time}, ...]) -- the slice of
  -- the recording for 'recording' tracks, null otherwise. Drives "Reset to raw"
  -- and elevation lookup on GPX export. Never touched by edits.
  raw_points            jsonb,

  -- Move-clamp baseline, [[lng,lat], ...] index-aligned with geom (see
  -- VERTEX_MOVE_CLAMP_M in tracks.js). Kept in sync through every edit.
  vertex_origin         jsonb,

  is_exported           boolean not null default false,

  -- source = 'osm_way' provenance + which base-map OSM ways to hide while this
  -- copy exists (same meaning as 0007's columns).
  source_osm_type       text check (source_osm_type in ('way', 'relation')),
  source_osm_id         bigint,
  source_osm_way_ids    jsonb not null default '[]',

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users(id) default auth.uid()
);
create index tracks_project_id_idx   on public.tracks (project_id);
create index tracks_recording_id_idx on public.tracks (recording_id);
create index tracks_geom_idx         on public.tracks using gist (geom);

-- ---------------------------------------------------------------------------------
-- Project points + history (comments/photos)
-- ---------------------------------------------------------------------------------
create table public.project_points (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  geog        geography(Point, 4326) not null,
  label       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) default auth.uid()
);
create index project_points_project_id_idx on public.project_points (project_id);
create index project_points_geog_idx       on public.project_points using gist (geog);

create table public.project_history (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  point_id     uuid references public.project_points(id) on delete cascade,
  track_id     uuid references public.tracks(id) on delete cascade,

  entry_type   text not null,
  value        jsonb not null,

  -- Set for anonymous share-link authors (no account); null when created_by is set.
  author_name  text,
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now(),

  constraint project_history_one_thread
    check (point_id is null or track_id is null),
  constraint project_history_has_an_author
    check (created_by is not null or author_name is not null),
  constraint project_history_created_by_is_caller
    check (created_by is null or created_by = auth.uid()),
  constraint project_history_known_value_shapes check (
    (entry_type = 'comment' and value ? 'text')
    or (entry_type = 'image' and value ? 'path')
    or entry_type not in ('comment', 'image')
  )
);
create index project_history_project_id_idx on public.project_history (project_id);
create index project_history_point_id_idx   on public.project_history (point_id);
create index project_history_track_id_idx   on public.project_history (track_id);

-- ---------------------------------------------------------------------------------
-- RLS -- same "small trusted group" v1 shape as everything else: authenticated
-- users get full access, anon gets nothing direct.
-- ---------------------------------------------------------------------------------
alter table public.recordings      enable row level security;
alter table public.tracks          enable row level security;
alter table public.project_points  enable row level security;
alter table public.project_history enable row level security;

create policy "recordings: authenticated full access" on public.recordings
  for all to authenticated using (true) with check (true);
create policy "tracks: authenticated full access" on public.tracks
  for all to authenticated using (true) with check (true);
create policy "project_points: authenticated full access" on public.project_points
  for all to authenticated using (true) with check (true);
create policy "project_history: authenticated full access" on public.project_history
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------------
-- Public (anon-callable) functions. Recordings are deliberately NOT exposed --
-- share-link visitors only ever see tracks and points.
-- ---------------------------------------------------------------------------------
create function public.get_public_tracks(p_project_id uuid)
returns table (
  id uuid, name text, source text, geojson jsonb,
  recording_id uuid, recording_start_idx integer, recording_end_idx integer,
  raw_points jsonb, vertex_origin jsonb, is_exported boolean,
  source_osm_type text, source_osm_id bigint, source_osm_way_ids jsonb,
  created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select id, name, source, ST_AsGeoJSON(geom)::jsonb,
         recording_id, recording_start_idx, recording_end_idx,
         raw_points, vertex_origin, is_exported,
         source_osm_type, source_osm_id, source_osm_way_ids, created_at
  from public.tracks
  where project_id = p_project_id
  order by created_at;
$$;

create function public.get_public_project_points(p_project_id uuid)
returns table (id uuid, geojson jsonb, label text)
language sql stable security definer set search_path = public
as $$
  select id, ST_AsGeoJSON(geog)::jsonb, label
  from public.project_points
  where project_id = p_project_id;
$$;

-- Everything for a project in one call; which thread is showing is a client-side
-- filter (comment volume per project is small).
create function public.get_public_project_history(p_project_id uuid)
returns table (
  id uuid, point_id uuid, track_id uuid, entry_type text, value jsonb,
  author_name text, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select id, point_id, track_id, entry_type, value, author_name, created_at
  from public.project_history
  where project_id = p_project_id
  order by created_at;
$$;

-- Finds an existing point within snap_meters of (lng,lat) in this project, or
-- creates one. Granted to anon: clicking a track to comment there is the core
-- share-link visitor flow.
create function public.find_or_create_project_point(
  p_project_id uuid,
  p_lng double precision,
  p_lat double precision,
  snap_meters double precision default 15
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  found_id uuid;
  new_point geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
begin
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'unknown project';
  end if;

  select id into found_id
    from public.project_points
    where project_id = p_project_id and ST_DWithin(geog, new_point, snap_meters)
    order by ST_Distance(geog, new_point)
    limit 1;
  if found_id is not null then
    return found_id;
  end if;

  insert into public.project_points (project_id, geog) values (p_project_id, new_point)
    returning id into found_id;
  return found_id;
end;
$$;

-- The only anonymous write path. Validates that the point/track (if given) belong
-- to the same project, so a visitor holding one project's link can't write into
-- another project's threads.
create function public.add_project_comment(
  p_project_id uuid,
  p_text text,
  p_author_name text default null,
  p_point_id uuid default null,
  p_track_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
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
  if p_point_id is not null and p_track_id is not null then
    raise exception 'a comment belongs to a point or a track, not both';
  end if;
  if p_point_id is not null and not exists (
    select 1 from public.project_points where id = p_point_id and project_id = p_project_id
  ) then
    raise exception 'point does not belong to this project';
  end if;
  if p_track_id is not null and not exists (
    select 1 from public.tracks where id = p_track_id and project_id = p_project_id
  ) then
    raise exception 'track does not belong to this project';
  end if;

  insert into public.project_history
    (project_id, point_id, track_id, entry_type, value, author_name, created_by)
  values (
    p_project_id, p_point_id, p_track_id, 'comment', jsonb_build_object('text', p_text),
    case when auth.uid() is null then clean_name else null end,
    auth.uid()
  )
  returning id into new_id;
  return new_id;
end;
$$;

grant execute on function public.get_public_tracks(uuid)               to anon, authenticated;
grant execute on function public.get_public_project_points(uuid)       to anon, authenticated;
grant execute on function public.get_public_project_history(uuid)      to anon, authenticated;
grant execute on function public.find_or_create_project_point(uuid, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.add_project_comment(uuid, text, text, uuid, uuid) to anon, authenticated;

-- track-images bucket + its policy (0005) are reused as-is; new uploads are keyed
-- by project id instead of track id.
