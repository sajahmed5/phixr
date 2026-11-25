-- Part 10 (security review): function-grant hardening.
--
-- The pre-Part-1 migrations (Aug 2026) predate the grants discipline, so
-- Supabase's default privileges left ~117 SECURITY DEFINER functions
-- executable by `anon` and a handful of INTERNAL helpers executable by any
-- authenticated user — including _award_to, the raw points writer, which a
-- signed-in user could have called via /rest/v1/rpc to mint points.
--
-- Three layers of fix, all verified live afterwards:
--   1. anon keeps EXECUTE only on the deliberate pre-auth surface
--      (anonymous feedback, signup handle check, the public share pages).
--   2. Internal helpers and trigger functions lose EXECUTE for both client
--      roles. Definer-to-definer calls run as the owner, so nothing
--      server-side needs client grants. (Trigger functions were never
--      RPC-callable — returns trigger — but hygiene is free.)
--   3. Default privileges stop granting EXECUTE to client roles on FUTURE
--      functions, so the grants trap cannot recur.

-- 1. anon: revoke everywhere, then re-grant the allowlist.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    join pg_roles r on r.oid = a.grantee
    where p.pronamespace = 'public'::regnamespace
      and r.rolname = 'anon' and a.privilege_type = 'EXECUTE'
  loop
    execute format('revoke execute on function %s from anon', f.sig);
  end loop;
end $$;

grant execute on function public.submit_anon_feedback(text, text, text, text, text) to anon;
grant execute on function public.is_handle_available(text) to anon;
-- The joinphixr.com share pages read public posts/profiles without a session.
grant execute on function public.get_public_post(uuid) to anon;
grant execute on function public.get_public_profile(text) to anon;
grant execute on function public.get_public_profile_posts(text, integer) to anon;
grant execute on function public.resolve_handle(text) to anon;

-- 2. Internals: no client role may call these. The app calls award_active_day
--    / award_share / award_message_activity (self-capped) and the edge
--    functions call claim_*_slot with the user's JWT — those keep their
--    grants; _award_to is the uncapped primitive they all funnel into.
revoke execute on function public._award_to(uuid, integer, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.apply_pipeline_verdict() from public, anon, authenticated;
revoke execute on function public.apply_pipeline_verdict_extra() from public, anon, authenticated;
revoke execute on function public.prune_media_upload_events(integer) from public, anon, authenticated;
revoke execute on function public.prune_pipeline_verdicts(integer) from public, anon, authenticated;
revoke execute on function public.prune_places_events(integer) from public, anon, authenticated;
revoke execute on function public.dispatch_story_reaper() from public, anon, authenticated;
revoke execute on function public.reports_autohide() from public, anon, authenticated;
revoke execute on function public.check_reach_milestones() from public, anon, authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname like 'tg\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- 3. Pin the three mutable search_paths the linter flagged.
alter function public.tg_set_updated_at() set search_path = '';
alter function public.admin_audit_log_immutable() set search_path = '';
alter function public.platform_settings_history_immutable() set search_path = '';

-- 4. Kill the grants trap for every future function.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
