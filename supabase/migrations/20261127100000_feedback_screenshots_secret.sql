-- ============================================================================
-- 20261127100000_feedback_screenshots_secret
--
-- Support for the feedback-screenshots edge function: triage tooling presents
-- a shared admin secret and gets short-lived signed URLs for a report's
-- screenshots. The secret lives in private.config (server-side only); this
-- RPC hands it ONLY to the service role — PostgREST does not expose the
-- private schema, and clients get no execute grant. Remember the recurring
-- trap: default privileges grant EXECUTE to anon/authenticated on new
-- functions, so the revoke below is load-bearing — verify in the live DB.
-- ============================================================================

create or replace function public.feedback_screenshots_secret()
returns text language sql stable
set search_path = ''
as $fn$
  select value from private.config where key = 'feedback_screenshots_secret';
$fn$;

revoke all on function public.feedback_screenshots_secret() from public, anon, authenticated;
grant execute on function public.feedback_screenshots_secret() to service_role;
