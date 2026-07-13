-- PostgREST returns PostGIS geography columns as raw WKB hex text by default,
-- not GeoJSON -- reading trail_history.location back as { coordinates: [...] }
-- (as the frontend does) silently gets nothing usable without this. A
-- "computed column" function (PostgREST convention: a function taking the
-- table's row type as its only argument gets exposed as a selectable field
-- named after the function) gives an explicit, always-available GeoJSON field
-- instead of relying on content-negotiation headers supabase-js doesn't set.

create or replace function public.location_geojson(rec public.trail_history)
returns jsonb
language sql
stable
as $$
  select case when rec.location is null then null
              else ST_AsGeoJSON(rec.location)::jsonb end;
$$;

grant execute on function public.location_geojson(public.trail_history) to authenticated;
