-- Rollback for 20261126500000_daily_orphan_cleanup.sql
select cron.unschedule('media-orphan-sweep') where exists (select 1 from cron.job where jobname = 'media-orphan-sweep');
drop function if exists public.queue_orphaned_media(interval);
