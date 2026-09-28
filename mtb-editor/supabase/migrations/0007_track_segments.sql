-- Trail segment editor: extends `tracks` (0005) rather than forking a new table --
-- a trail segment IS a track, just one that can additionally originate from an
-- existing OSM way/relation, carry a move-clamp baseline for vertex editing, and be
-- split into adjacent segments. See mtb-editor/CLAUDE.md for the full feature writeup.
--
-- track_group_id/segment_order are a deliberately separate concept from the older,
-- deprecated trails.osm_type/osm_id (0001) -- that table's `unique(osm_type, osm_id)`
-- constraint means it can't represent "this OSM way, copied into an editable segment,
-- possibly split into several segments later" at all. trails stays untouched.

alter table public.tracks
  drop constraint if exists tracks_source_check,
  add constraint tracks_source_check check (source in ('fit_upload', 'manual', 'osm_way'));

alter table public.tracks
  -- Provenance when source = 'osm_way'. Distinct from trails.osm_type/osm_id: no
  -- uniqueness here, since a split segment's two halves both carry the same source.
  add column source_osm_type text check (source_osm_type in ('way', 'relation')),
  add column source_osm_id bigint,

  -- Every way-level OSM id that should be hidden from the base OSM line layers while
  -- this segment exists (see mtb-editor/index.html's hidden-osm-id filter). For a
  -- relation import this is every member way's own id, never the relation id itself --
  -- line features never carry a relation id as `osm_id`.
  add column source_osm_way_ids jsonb not null default '[]',

  -- Move-clamp baseline: [[lng,lat], ...] index-aligned with geom's points, the
  -- position each vertex is clamped relative to (a few hundred metres max). Null until
  -- the first point-edit sets it from the segment's coords at that time.
  add column vertex_origin jsonb,

  -- Groups a segment together with any segments it was later split into. A brand new
  -- segment gets its own fresh group id; splitting copies the parent's group id onto
  -- both halves. segment_order is fractional (Trello-style) so inserting a new segment
  -- between two existing ones needs no renumbering.
  add column track_group_id uuid not null default gen_random_uuid(),
  add column segment_order double precision not null default 0;

create index tracks_track_group_id_idx on public.tracks (track_group_id);

-- get_public_tracks' return shape is changing -- create or replace can't change a
-- function's return type, so drop first (mirrors how 0005 originally created it).
drop function if exists public.get_public_tracks(uuid);

create function public.get_public_tracks(p_project_id uuid)
returns table (
  id uuid, name text, source text, geojson jsonb, raw_points jsonb,
  simplify_tolerance_m double precision, is_exported boolean, created_at timestamptz,
  source_osm_type text, source_osm_id bigint, source_osm_way_ids jsonb,
  vertex_origin jsonb, track_group_id uuid, segment_order double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select id, name, source, ST_AsGeoJSON(geom)::jsonb, raw_points,
         simplify_tolerance_m, is_exported, created_at,
         source_osm_type, source_osm_id, source_osm_way_ids,
         vertex_origin, track_group_id, segment_order
  from public.tracks
  where project_id = p_project_id
  order by track_group_id, segment_order;
$$;

grant execute on function public.get_public_tracks(uuid) to anon, authenticated;

-- No RLS changes needed -- "tracks: authenticated full access" (0005) already covers
-- these new columns; the RPC's security-definer/search_path already matches 0005.
