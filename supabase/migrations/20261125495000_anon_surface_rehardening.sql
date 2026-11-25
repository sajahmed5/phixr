-- Part 13 security follow-up: close the PUBLIC-execute regression.
--
-- ROOT CAUSE: the Part 10 hardening ran
--   alter default privileges for role postgres IN SCHEMA PUBLIC revoke ...
-- but per-schema default-privilege entries are ADDITIVE to the global
-- built-in default (which grants EXECUTE to PUBLIC on every new function).
-- The global entry was never altered, so every function created or
-- re-created since Part 10 silently regained PUBLIC execute unless its own
-- migration revoked it (advisor: 41 anon-executable fns vs the sanctioned 6).
--
-- Fix 1: alter the GLOBAL default privileges (no schema qualifier).
alter default privileges for role postgres revoke execute on functions from public;

-- Fix 2: sweep every existing public-schema function — strip PUBLIC execute
-- everywhere, strip anon everywhere except the six sanctioned anon RPCs.
-- authenticated/service_role grants are left exactly as they are.
do $$
declare
  r record;
  _anon_ok constant text[] := array[
    'submit_anon_feedback', 'is_handle_available', 'get_public_post',
    'get_public_profile', 'get_public_profile_posts', 'resolve_handle'];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0  -- PUBLIC
                     or a.grantee = 'anon'::regrole::oid)
  loop
    execute format('revoke execute on function %s from public', r.sig);
    if not (r.proname = any (_anon_ok)) then
      execute format('revoke execute on function %s from anon', r.sig);
    end if;
  end loop;
end;
$$;
