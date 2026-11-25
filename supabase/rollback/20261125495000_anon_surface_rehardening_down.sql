-- Rollback for 20261125495000_anon_surface_rehardening.
-- Deliberately does NOT re-grant PUBLIC/anon execute on functions: that
-- state was a vulnerability, not a feature. Only the default-privileges
-- change is reverted (new functions would again get PUBLIC execute).
alter default privileges for role postgres grant execute on functions to public;
