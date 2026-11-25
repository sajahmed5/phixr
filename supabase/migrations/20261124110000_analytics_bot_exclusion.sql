-- ============================================================================
-- 20261124110000_analytics_bot_exclusion  (Build brief Part 1C, last piece)
--
-- Flagged engagement must not count towards CREATOR ANALYTICS either. The
-- legacy per-post analytics RPC (20260729090000) still aggregated raw swipe
-- counters; until Part 3 rebuilds analytics on view-event roll-ups, subtract
-- the flagged totals here so creators never see botted likes/skips.
--
-- Also moves the RPC's hard-coded suppression floor (5) into settings
-- (rule 5: no hard-coded tuning numbers). This floor protects the CREATOR's
-- own rates at tiny samples; it is unrelated to the 50-person minimum for
-- audience-group breakdowns (min_aggregate_group_size), which applies from
-- Part 3 onward.
-- ============================================================================

set search_path = public, extensions;

insert into public.platform_settings (key, value, description, client_visible) values
  ('analytics_min_sample', '5'::jsonb,
   'Minimum (bot-cleaned) swipes before a post''s own like/skip rates are shown to its creator; below this the UI says "not enough views yet".', false)
on conflict (key) do nothing;

-- Re-emit of 20260729090000's get_post_analytics. Changes: bot-cleaned likes/
-- skips via post_bot_counts (greatest(…,0) because undone swipes decrement the
-- raw counters but flagged history remains), and the settings-driven floor.
create or replace function public.get_post_analytics(_post_id uuid)
returns table (
  reach integer, likes integer, skips integer, comments integer, shares integer,
  like_rate double precision, skip_rate double precision, sample_suppressed boolean
) language plpgsql stable security definer set search_path = '' as $fn$
declare
  min_bucket integer := public.setting_numeric('analytics_min_sample', 5)::integer;
  p public.posts;
  _bot_likes integer := 0;
  _bot_skips integer := 0;
  _likes integer;
  _skips integer;
  total integer;
begin
  select * into p from public.posts where id = _post_id;
  if not found or p.user_id <> auth.uid() then
    raise exception 'not authorised';  -- own posts only
  end if;
  select bc.bot_like_count, bc.bot_skip_count into _bot_likes, _bot_skips
  from public.post_bot_counts bc where bc.post_id = _post_id;
  _likes := greatest(p.like_count - coalesce(_bot_likes, 0), 0);
  _skips := greatest(p.skip_count - coalesce(_bot_skips, 0), 0);
  total := _likes + _skips;
  return query select
    p.reach_count, _likes, _skips, p.comment_count, p.share_count,
    case when total >= min_bucket then _likes::double precision / total else null end,
    case when total >= min_bucket then _skips::double precision / total else null end,
    (total < min_bucket);
end;
$fn$;
revoke all on function public.get_post_analytics(uuid) from public, anon;
grant execute on function public.get_post_analytics(uuid) to authenticated;
