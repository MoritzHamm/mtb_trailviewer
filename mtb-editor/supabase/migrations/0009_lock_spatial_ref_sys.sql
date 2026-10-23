-- Lock down PostGIS's spatial_ref_sys table against writes via the REST API.
--
-- 0001 created the postgis extension in `public` (no schema specified), so its
-- spatial_ref_sys lookup table (SRID -> proj4/WKT definitions) sits in an
-- API-exposed schema with RLS off, which Supabase's linter flags. RLS can't be
-- enabled on it: the table is owned by supabase_admin, not postgres. Moving
-- PostGIS to the `extensions` schema would require DROP EXTENSION ... CASCADE,
-- which drops every geography column -- not worth it.
--
-- The contents are public reference data, so reads are harmless. The real risk
-- is anon/authenticated deleting or altering rows (e.g. SRID 4326) and breaking
-- every geography function. Revoke writes, keep SELECT.
--
-- The linter warning will likely persist (it checks RLS, not grants) -- dismiss
-- it once the verification query below shows only SELECT for anon/authenticated.

revoke insert, update, delete, truncate, references, trigger
  on public.spatial_ref_sys
  from anon, authenticated;

-- Verify (run separately; expect only SELECT rows for anon/authenticated):
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'spatial_ref_sys'
--  order by grantee, privilege_type;
