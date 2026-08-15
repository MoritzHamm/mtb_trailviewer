-- Projects & Tracks: a planning/staging layer that sits *before* something exists in
-- OSM. A project is a shareable container (its own uuid doubles as the share-link
-- capability token -- same "unguessable id is the credential" idea already used for
-- signed image URLs elsewhere in this schema, see mtb-editor/CLAUDE.md) holding
-- tracks imported from a .fit file (cut into chunks, cleaned up, simplified) or drawn
-- manually. OSM stays authoritative for real/published trails -- this table does not
-- feed OSM automatically; "export" just produces a GPX for manual upload via JOSM/iD.
--
-- Supersedes the unfinished trails.is_draft/draft_geometry flow as the intended path
-- for planning new trails going forward (those columns are left alone, unused).
--
-- Unlike trails/trail_history, share-link visitors are NOT required to log in -- they
-- can view a project and comment on its tracks anonymously (giving a display name
-- instead of an account). To avoid handing anon a blanket SELECT on every project via
-- the REST API, anon access goes only through the security-definer get_public_*/
-- add_track_comment functions below, never direct table grants.

create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) default auth.uid()
);

comment on table public.projects is
  'A shareable planning container for tracks. The id itself is the share-link '
  'capability token -- knowing it is what grants read/comment access, see the '
  'get_public_* functions below.';

create table public.tracks (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id) on delete cascade,

  name                  text,
  source                text not null check (source in ('fit_upload', 'manual')),

  -- Current/working geometry -- what gets edited and simplified in the editor.
  geom                  geography(LineString, 4326) not null,

  -- Immutable original points as imported from the FIT file (the selected chunk's
  -- slice, not the whole ride), [{lat,lng,ele,time}, ...]. Null for manually-drawn
  -- tracks. Kept untouched regardless of edits/simplification applied to `geom` --
  -- this is the "keep the track data" requirement.
  raw_points            jsonb,

  -- Last-applied simplify tolerance, informational only (geom already reflects it).
  simplify_tolerance_m  double precision,

  is_exported           boolean not null default false,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users(id) default auth.uid()
);

create index tracks_project_id_idx on public.tracks (project_id);
create index tracks_geom_idx       on public.tracks using gist (geom);

create table public.track_history (
  id           uuid primary key default gen_random_uuid(),
  track_id     uuid not null references public.tracks(id) on delete cascade,

  entry_type   text not null,
  value        jsonb not null,

  -- Filled when a comment comes from an anonymous share-link visitor (no account);
  -- null when created_by is set. Mirrors trail_history's free-form type/value model.
  author_name  text,
  created_by   uuid references auth.users(id) default auth.uid(),

  created_at   timestamptz not null default now(),

  constraint track_history_has_an_author
    check (created_by is not null or author_name is not null),

  constraint track_history_known_value_shapes check (
    (entry_type = 'comment' and value ? 'text')
    or (entry_type = 'image' and value ? 'path')
    or entry_type not in ('comment', 'image')
  )
);

create index track_history_track_id_idx   on public.track_history (track_id);
create index track_history_created_at_idx on public.track_history (created_at desc);

-- Row Level Security -- same v1 shape as trails/trail_history/locations: any
-- authenticated user has full access (small trusted group). Anonymous access is
-- deliberately NOT granted here -- it goes only through the functions below.
alter table public.projects      enable row level security;
alter table public.tracks        enable row level security;
alter table public.track_history enable row level security;

create policy "projects: authenticated full access" on public.projects
  for all to authenticated using (true) with check (true);

create policy "tracks: authenticated full access" on public.tracks
  for all to authenticated using (true) with check (true);

create policy "track_history: authenticated full access" on public.track_history
  for all to authenticated using (true) with check (true);

-- An authenticated user can't post a track_history entry as someone else (mirrors
-- 0002's trail_history_created_by_is_caller) -- null is still allowed, which lets a
-- logged-in user post "anonymously" too, not a real gap since they'd need their own
-- account to do it either way.
alter table public.track_history
  add constraint track_history_created_by_is_caller
  check (created_by is null or created_by = auth.uid());

-- ---------------------------------------------------------------------------------
-- Public (anon-callable) read/comment functions. security definer so they can read/
-- write past RLS for exactly the id the caller already has -- never a blanket table
-- grant. set search_path defensively since, unlike the rest of this schema's
-- functions, these are reachable by untrusted (anon) callers.
-- ---------------------------------------------------------------------------------

create or replace function public.get_public_project(p_id uuid)
returns table (id uuid, name text, description text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select id, name, description, created_at
  from public.projects
  where id = p_id;
$$;

create or replace function public.get_public_tracks(p_project_id uuid)
returns table (
  id uuid, name text, source text, geojson jsonb, raw_points jsonb,
  simplify_tolerance_m double precision, is_exported boolean, created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select id, name, source, ST_AsGeoJSON(geom)::jsonb, raw_points,
         simplify_tolerance_m, is_exported, created_at
  from public.tracks
  where project_id = p_project_id
  order by created_at;
$$;

create or replace function public.get_public_track_history(p_track_id uuid)
returns table (id uuid, entry_type text, value jsonb, author_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select id, entry_type, value, author_name, created_at
  from public.track_history
  where track_id = p_track_id
  order by created_at;
$$;

-- The only anonymous write path that exists anywhere in this schema. Requires a
-- display name when called with no session; logged-in callers get their own
-- created_by instead and author_name stays null.
create or replace function public.add_track_comment(
  p_track_id uuid,
  p_text text,
  p_author_name text default null
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

  insert into public.track_history (track_id, entry_type, value, author_name, created_by)
  values (
    p_track_id, 'comment', jsonb_build_object('text', p_text),
    case when auth.uid() is null then clean_name else null end,
    auth.uid()
  )
  returning id into new_id;

  return new_id;
end;
$$;

grant execute on function public.get_public_project(uuid)                 to anon, authenticated;
grant execute on function public.get_public_tracks(uuid)                  to anon, authenticated;
grant execute on function public.get_public_track_history(uuid)           to anon, authenticated;
grant execute on function public.add_track_comment(uuid, text, text)      to anon, authenticated;

-- Storage bucket for track photos. Public (unlike trail-images) -- these are planning
-- photos, not sensitive, so anon share-link visitors can view them via a plain public
-- URL with no signed-URL round trip needed. Upload/manage stays authenticated-only.
insert into storage.buckets (id, name, public)
  values ('track-images', 'track-images', true)
  on conflict (id) do nothing;

create policy "track-images: authenticated full access" on storage.objects
  for all to authenticated
  using (bucket_id = 'track-images')
  with check (bucket_id = 'track-images');
