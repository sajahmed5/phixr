-- Rollback for 20261125590000_notification_polish.
-- DROPS DATA (flagged per Part 0): daily push counts are discarded and any
-- creator_digest notifications are deleted. Redeploy send-push v10 FIRST —
-- v11 calls _bump_push_count. Tri-state pref strings stored in
-- notification_prefs.prefs are left in place (v10 treats any non-false value
-- as on, so behaviour degrades safely).

select cron.unschedule('creator-digest');
drop function if exists public.send_creator_digests();
drop function if exists public._bump_push_count(uuid);
drop table if exists public.push_log;

delete from public.notifications where type = 'creator_digest';
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update','team_invite',
    'new_login'));

delete from public.platform_settings where key in ('push_daily_cap', 'digest_min_views');
