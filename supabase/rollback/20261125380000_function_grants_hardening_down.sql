-- Rollback for 20261125380000_function_grants_hardening.
-- Deliberately DOES NOT restore the broad anon grants or client EXECUTE on
-- internals: those were the vulnerability. It only undoes the pieces that
-- change future behaviour, so a rollback never re-opens the hole.
alter default privileges for role postgres in schema public
  grant execute on functions to public;
-- (The per-function revokes stand; re-grant explicitly if a function was
--  revoked in error — see the migration's allowlist for the anon surface.)
