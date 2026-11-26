-- Rollback for 20261126500000_daily_orphan_cleanup.sql
select cron.unschedule('media-orphan-sweep') where exists (select 1 from cron.job where jobname = 'media-orphan-sweep');
drop function if exists public.queue_orphaned_media(interval);
-- Restore the draft check as it was in 20261126400000_r2_media (uploader's own drafts only).
create or replace function public.media_key_in_use(_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (select 1 from public.posts where media_url = _key or thumbnail_url = _key)
      or exists (select 1 from public.post_media where media_url = _key or thumbnail_url = _key)
      or exists (select 1 from public.stories where media_url = _key or thumbnail_url = _key)
      or exists (select 1 from public.story_highlight_items where media_url = _key or thumbnail_url = _key)
      or exists (select 1 from public.story_highlights where cover_url = _key)
      or exists (select 1 from public.messages where media_url = _key)
      or exists (select 1 from public.post_drafts d
                 where d.user_id::text = split_part(_key, '/', 1)
                   and d.payload::text like '%"' || _key || '"%');
$fn$;
