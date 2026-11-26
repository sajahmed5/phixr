-- ============================================================================
-- 20261126500000_daily_orphan_cleanup — delete photos/videos nothing uses.
--
-- Uploads go to storage before a post exists (the composer uploads while you
-- write the caption). If the post is never published — cancelled, app closed,
-- upload replaced — the file used to stay forever, in Supabase and in R2.
--
-- Once a day, anything in the `media` bucket that is over 3 days old and that no
-- post, carousel item, story, highlight, message or draft references is queued
-- in media_trash. The existing r2-sync job (every 10 minutes) then deletes it
-- from Supabase Storage and R2, re-checking first that nothing uses it.
--
-- Drafts protect their media whoever saved them: media_key_in_use no longer
-- limits the draft check to the uploader's own drafts, because a business
-- account's draft can use a photo uploaded by a team member.
-- ============================================================================

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
      or exists (select 1 from public.post_drafts d where d.payload::text like '%"' || _key || '"%');
$fn$;
revoke all on function public.media_key_in_use(text) from public, anon, authenticated;
grant execute on function public.media_key_in_use(text) to service_role;

create or replace function public.queue_orphaned_media(_min_age interval default interval '3 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare _n integer;
begin
  insert into public.media_trash (key)
  select o.name
  from storage.objects o
  where o.bucket_id = 'media'
    and o.created_at < now() - greatest(_min_age, interval '1 hour')
    and not public.media_key_in_use(o.name)
  on conflict (key) do nothing;
  get diagnostics _n = row_count;
  return _n;
end $fn$;
revoke all on function public.queue_orphaned_media(interval) from public, anon, authenticated;

select cron.schedule('media-orphan-sweep', '30 3 * * *', $$select public.queue_orphaned_media();$$)
where not exists (select 1 from cron.job where jobname = 'media-orphan-sweep');
