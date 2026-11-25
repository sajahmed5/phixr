-- Rollback for 20261125400000_profiles_column_privacy.
-- Restores the pre-Part-10 table-wide SELECT (the leak!) only because a
-- rollback must restore the old app's behaviour; re-apply the migration as
-- soon as the old client is retired.
grant select on table public.profiles to authenticated;
