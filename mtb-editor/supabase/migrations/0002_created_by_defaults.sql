-- created_by should default to the calling user rather than requiring every insert
-- to pass it explicitly, and trail_history should not let an authenticated user set
-- someone else's id as the author (RLS as written otherwise permits it, since v1's
-- policies are "any authenticated user, any row").

alter table public.trails         alter column created_by set default auth.uid();
alter table public.trail_history  alter column created_by set default auth.uid();

alter table public.trail_history
  add constraint trail_history_created_by_is_caller
  check (created_by = auth.uid());
