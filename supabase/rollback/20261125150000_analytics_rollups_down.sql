-- Rollback for 20261125150000_analytics_rollups.
-- Removes the roll-up job, function, table and its settings. Raw
-- post_view_events are untouched, so re-applying the migration rebuilds the
-- lookback window (older days are lost once raw events purge at 90 days).

set search_path = public, extensions;

select cron.unschedule('post-daily-rollup')
where exists (select 1 from cron.job where jobname = 'post-daily-rollup');

drop function if exists public.refresh_post_daily_stats();
drop table if exists public.post_daily_stats;

delete from public.platform_settings
where key in ('analytics_rollup_lookback_days', 'analytics_min_views_for_insights');
