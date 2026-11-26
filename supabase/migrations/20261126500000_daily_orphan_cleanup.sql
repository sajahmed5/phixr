-- ============================================================================
-- 20261126500000_daily_orphan_cleanup — delete photos/videos nothing uses.
--
-- Uploads go to storage before a post exists (the composer uploads while you
-- write the caption). If the post is never published — cancelled, app closed,
-- upload replaced — the file used to stay forever, in Supabase and in R2.
--
-- Once a day, anything in the `media` bucket that is over a day old and that no
-- post, carousel item, story, highlight, message or draft references is queued
-- in media_trash. The existing r2-sync job (every 10 minutes) then deletes it
-- from Supabase Storage and R2, re-checking first that nothing uses it.
-- ============================================================================

create or replace function public.queue_orphaned_media(_min_age interval default interval '1 day')
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
