-- Rollback for 20261126400000_r2_media.sql (the app falls back to Supabase signing).
drop function if exists public.get_media_upload_secret();
drop function if exists public.sign_media(text[]);
drop function if exists public.can_read_media(text);
delete from public.platform_settings where key = 'media_cdn_enabled';
drop table if exists public.r2_objects;
-- Vault secrets (media_signing_secret, media_upload_secret) are left in place;
-- remove them by hand with vault.secrets if the R2 move is abandoned.
select cron.unschedule('r2-sync') where exists (select 1 from cron.job where jobname = 'r2-sync');
drop function if exists public.dispatch_r2_sync();
drop function if exists public.r2_pending_keys(int);
drop function if exists public.media_trash_due(int);
drop function if exists public.media_key_in_use(text);
drop trigger if exists posts_queue_media_trash on public.posts;
drop trigger if exists post_media_queue_media_trash on public.post_media;
drop function if exists public.tg_queue_media_trash();
drop table if exists public.media_trash;
