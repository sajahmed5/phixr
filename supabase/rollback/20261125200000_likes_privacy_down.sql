-- Rollback for 20261125200000_likes_privacy.
-- Removes the likers RPC, the like-notification queue/triggers/job, the
-- 'like' notification type (existing like notifications are deleted so the
-- narrower constraint holds) and the profile flags.

set search_path = public, extensions;

select cron.unschedule('like-notifications')
where exists (select 1 from cron.job where jobname = 'like-notifications');

drop function if exists public.get_post_likers(uuid, timestamptz, integer);
drop function if exists public.flush_like_notifications();
drop trigger if exists like_queue_swipe on public.swipes;
drop trigger if exists like_queue_heart on public.post_likes;
drop function if exists public.tg_like_queue_swipe();
drop function if exists public.tg_like_queue_heart();
drop table if exists public.like_notification_queue;

delete from public.notifications where type = 'like';
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation','message','mention'));

alter table public.profiles drop column if exists hide_likes,
                            drop column if exists verified;

delete from public.platform_settings where key = 'like_notification_min_age_minutes';
