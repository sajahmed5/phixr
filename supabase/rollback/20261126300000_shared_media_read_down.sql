-- Rollback for 20261126300000_shared_media_read.sql
drop policy if exists media_read_shared on storage.objects;
drop function if exists public.can_read_shared_media(text);
