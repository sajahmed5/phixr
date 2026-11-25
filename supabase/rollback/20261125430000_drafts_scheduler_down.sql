-- Rollback for 20261125430000_drafts_scheduler.
select cron.unschedule('publish-scheduled')
where exists (select 1 from cron.job where jobname = 'publish-scheduled');
drop function if exists public.publish_due_drafts();
drop function if exists public._publish_one_draft(public.post_drafts);
drop function if exists public.cancel_schedule(uuid);
drop function if exists public.schedule_draft(uuid, timestamptz);
drop table if exists public.post_drafts;
alter table public.notifications drop constraint notifications_type_check;
delete from public.notifications where type in ('schedule_update', 'collab_invite', 'collab_update');
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update'));
delete from public.platform_settings
 where key in ('schedule_max_days', 'schedule_max_posts', 'schedule_max_attempts');
