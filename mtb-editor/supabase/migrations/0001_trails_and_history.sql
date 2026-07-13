-- Trails + history schema for the MTB editor.
--
-- Design (see mtb-editor/CLAUDE.md for the full rationale):
--   - OSM stays authoritative for trail location, name, and mtb:scale. This table
--     does NOT bulk-mirror every mtb-tagged way/relation in OSM -- rows are created
--     lazily, only once a trail is actually worked on in the editor (a status update,
--     comment, or image attached to it).
--   - Trails can also be drafted directly in the editor before they exist in OSM at
--     all (is_draft = true, osm_type/osm_id null until reconciled later once the
--     trail has been created in OSM and shown up in a refreshed extract).
--   - History entries are free-form type/value pairs, and can attach to a trail, a
--     point location, or both (e.g. "windfall at this spot on trail X") -- kept loose
--     on purpose rather than modelling every possible target up front.

create extension if not exists pgcrypto;
create extension if not exists postgis;

create table public.trails (
  id                 uuid primary key default gen_random_uuid(),

  -- OSM reference. Null while is_draft = true.
  osm_type           text check (osm_type in ('way', 'relation')),
  osm_id             bigint,

  is_draft           boolean not null default false,

  -- Cached display snapshot (name / mtb:scale / rough point), refreshed by the
  -- foundation pipeline whenever OSM data is re-extracted. Also doubles as the
  -- primary name/scale source for draft trails not yet in OSM at all.
  display_name       text,
  display_mtb_scale  text,
  display_lon        double precision,
  display_lat        double precision,
  osm_synced_at      timestamptz,

  -- Only meaningful while is_draft = true: a trail sketched in the editor before
  -- it exists in OSM.
  draft_geometry     geography(LineString, 4326),

  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),

  constraint trails_osm_ref_required_unless_draft
    check (is_draft or (osm_type is not null and osm_id is not null)),
  constraint trails_osm_ref_unique unique (osm_type, osm_id)
);

comment on table public.trails is
  'One row per OSM way/relation (or editor-drafted trail not yet in OSM) that has '
  'been worked on in the editor -- not a bulk mirror of all OSM trails.';

create table public.trail_history (
  id           uuid primary key default gen_random_uuid(),

  trail_id     uuid references public.trails(id) on delete cascade,
  location     geography(Point, 4326),

  entry_type   text not null,
  value        jsonb not null,

  created_at   timestamptz not null default now(),
  created_by   uuid not null references auth.users(id),

  constraint trail_history_needs_a_target
    check (trail_id is not null or location is not null),

  -- Known entry types get their value shape checked; unrecognised types pass
  -- through unchecked so new kinds of entries can be added without a migration.
  constraint trail_history_known_value_shapes check (
    (entry_type = 'status'  and (value ->> 'status') in
       ('clear', 'overgrown', 'partially_blocked', 'fully_blocked'))
    or (entry_type = 'comment' and value ? 'text')
    or (entry_type = 'image'   and value ? 'path')
    or entry_type not in ('status', 'comment', 'image')
  )
);

comment on table public.trail_history is
  'Type/value history entries. entry_type=''status'' -> value={"status": "..."}; '
  '''comment'' -> value={"text": "..."}; ''image'' -> value={"path": "...", ...}.';

create index trail_history_trail_id_idx   on public.trail_history (trail_id);
create index trail_history_location_idx   on public.trail_history using gist (location);
create index trail_history_created_at_idx on public.trail_history (created_at desc);

-- Row Level Security -- v1: any authenticated user can read/write everything.
-- Small trusted trail-maintainer group; tighten with role/ownership checks later
-- if the group grows or abuse becomes a concern.
alter table public.trails enable row level security;
alter table public.trail_history enable row level security;

create policy "trails: authenticated full access" on public.trails
  for all to authenticated using (true) with check (true);

create policy "trail_history: authenticated full access" on public.trail_history
  for all to authenticated using (true) with check (true);

-- Storage bucket for image history entries. Private bucket -- access goes through
-- RLS-checked signed URLs / authenticated requests, not a public URL.
insert into storage.buckets (id, name, public)
  values ('trail-images', 'trail-images', false)
  on conflict (id) do nothing;

create policy "trail-images: authenticated full access" on storage.objects
  for all to authenticated
  using (bucket_id = 'trail-images')
  with check (bucket_id = 'trail-images');
