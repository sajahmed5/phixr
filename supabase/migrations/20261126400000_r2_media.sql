-- ============================================================================
-- 20261126400000_r2_media — serve media from Cloudflare R2 (media.phixrcdn.com)
--
-- Supabase Storage stays the source of truth during the move; every serving
-- object is also copied to the R2 bucket `phixr-media` under the SAME key
-- ({owner}/{id}.ext). Downloads then come from Cloudflare (no egress fees)
-- through the `phixr-media` Worker, which only serves a key with a valid,
-- unexpired HMAC signature made here.
--
--   r2_objects            which keys are already in R2 (service role only)
--   can_read_media(key)   the full "may this viewer open this file?" rule —
--                         the same rules as the storage.objects read policies
--   sign_media(keys[])    signed R2 links for the keys the caller may open
--                         AND that are already in R2; the app signs any
--                         others with Supabase as before (dual read)
--   media_cdn_enabled     client-visible switch (0/1) so R2 can be turned
--                         off instantly without an app update
--
-- Secrets live in Supabase Vault, never in this file:
--   media_signing_secret  shared with the Worker (SIGNING_SECRET)
--   media_upload_secret   shared with the Worker (UPLOAD_SECRET); edge
--                         functions read it via get_media_upload_secret()
-- ============================================================================

create table if not exists public.r2_objects (
  key          text primary key,
  bytes        bigint,
  content_type text,
  synced_at    timestamptz not null default now()
);
alter table public.r2_objects enable row level security; -- no policies: service role only
revoke all on public.r2_objects from anon, authenticated;

insert into public.platform_settings (key, value, description, client_visible)
values ('media_cdn_enabled', to_jsonb(0),
        'Serve photos/videos from Cloudflare R2 (media.phixrcdn.com). 0 = Supabase Storage only.', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Who may open a media key. Mirrors the storage.objects SELECT policies
-- (media_read, media_read_message, media_read_shared) and posts_select.
-- ---------------------------------------------------------------------------
create or replace function public.can_read_media(_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    -- The owner's own folder.
    split_part(_key, '/', 1) = auth.uid()::text
    -- Posts and carousel items (public/ad approved, private to accepted followers).
    or exists (
      select 1 from public.posts p
      where (
          p.media_url = _key or p.thumbnail_url = _key
          or exists (
            select 1 from public.post_media pm
            where pm.post_id = p.id and (pm.media_url = _key or pm.thumbnail_url = _key))
        )
        and not public.is_blocked_with(p.user_id)
        and p.moderation_status <> 'removed'
        and ((not p.sensitive) or (not public.is_minor(auth.uid())))
        and (
          (p.visibility in ('public', 'ad') and p.moderation_status = 'approved')
          or (p.visibility = 'private' and public.is_accepted_follower_of(p.user_id))
        )
    )
    -- Direct messages: members of the conversation.
    or exists (
      select 1 from public.messages msg
      where msg.media_url = _key and public.is_conversation_member(msg.conversation_id, auth.uid())
    )
    -- Stories, highlights, audience-group posts.
    or public.can_read_shared_media(_key);
$fn$;
revoke all on function public.can_read_media(text) from public, anon;
grant execute on function public.can_read_media(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Signed links. Expiry is rounded to the hour (+24h) so the same key gets the
-- same URL for an hour: the phone's image cache and Cloudflare reuse it.
-- Signature = base64url(HMAC-SHA256(secret, key || ':' || expiry)).
-- ---------------------------------------------------------------------------
create or replace function public.sign_media(_keys text[])
returns table (key text, url text)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _secret text;
  _exp bigint := (floor(extract(epoch from now()) / 3600)::bigint + 25) * 3600;
begin
  if auth.uid() is null or coalesce(array_length(_keys, 1), 0) = 0 then
    return;
  end if;
  if array_length(_keys, 1) > 300 then
    raise exception 'too many keys';
  end if;
  select ds.decrypted_secret into _secret
  from vault.decrypted_secrets ds where ds.name = 'media_signing_secret';
  if _secret is null then
    return; -- not configured: the app falls back to Supabase signing
  end if;

  return query
  select k,
         'https://media.phixrcdn.com/m/' || k || '?e=' || _exp || '&s=' ||
         rtrim(translate(encode(extensions.hmac(k || ':' || _exp, _secret, 'sha256'), 'base64'), '+/', '-_'), '=')
  from (select distinct unnest(_keys) as k) ks
  where exists (select 1 from public.r2_objects o where o.key = ks.k)
    and public.can_read_media(ks.k);
end;
$fn$;
revoke all on function public.sign_media(text[]) from public, anon;
grant execute on function public.sign_media(text[]) to authenticated;

-- Edge functions (service role) read the Worker upload secret from Vault.
create or replace function public.get_media_upload_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'media_upload_secret';
$fn$;
revoke all on function public.get_media_upload_secret() from public, anon, authenticated;
grant execute on function public.get_media_upload_secret() to service_role;

-- ============================================================================
-- Deleting files that nothing uses any more.
--
-- Until now deleting a post only deleted the row: its photo/video stayed in
-- storage for good. Deleted posts (and their carousel items) now queue their
-- keys in media_trash; the r2-sync job deletes a queued key from Supabase
-- Storage AND R2 once nothing references it (10-minute grace, and keys a story,
-- highlight, message, draft or other post still uses are never deleted).
-- ============================================================================
create table if not exists public.media_trash (
  key        text primary key,
  queued_at  timestamptz not null default now()
);
alter table public.media_trash enable row level security; -- service role only
revoke all on public.media_trash from anon, authenticated;

create or replace function public.tg_queue_media_trash()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.media_trash (key)
  select k from unnest(array[old.media_url, old.thumbnail_url]) k
  where k is not null and k !~* '^(https?:|data:)'
  on conflict (key) do nothing;
  return old;
end $fn$;
revoke all on function public.tg_queue_media_trash() from public, anon, authenticated;

drop trigger if exists posts_queue_media_trash on public.posts;
create trigger posts_queue_media_trash after delete on public.posts
  for each row execute function public.tg_queue_media_trash();
drop trigger if exists post_media_queue_media_trash on public.post_media;
create trigger post_media_queue_media_trash after delete on public.post_media
  for each row execute function public.tg_queue_media_trash();

-- Is a key still used anywhere?
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
revoke all on function public.media_key_in_use(text) from public, anon, authenticated;
grant execute on function public.media_key_in_use(text) to service_role;

-- Trash keys that are due: drops re-used keys from the queue and returns the rest.
create or replace function public.media_trash_due(_limit int default 200)
returns setof text
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  delete from public.media_trash t
  where t.queued_at < now() - interval '10 minutes' and public.media_key_in_use(t.key);
  return query
  select t.key from public.media_trash t
  where t.queued_at < now() - interval '10 minutes'
  order by t.queued_at
  limit greatest(1, least(_limit, 1000));
end $fn$;
revoke all on function public.media_trash_due(int) from public, anon, authenticated;
grant execute on function public.media_trash_due(int) to service_role;

-- Serving objects still to copy to R2 (only ones something uses).
create or replace function public.r2_pending_keys(_limit int default 50)
returns table (key text, content_type text, bytes bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select o.name, o.metadata->>'mimetype', nullif(o.metadata->>'size', '')::bigint
  from storage.objects o
  where o.bucket_id = 'media'
    and not exists (select 1 from public.r2_objects r where r.key = o.name)
    and not exists (select 1 from public.media_trash t where t.key = o.name)
    and public.media_key_in_use(o.name)
  order by o.created_at desc
  limit greatest(1, least(_limit, 500));
$fn$;
revoke all on function public.r2_pending_keys(int) from public, anon, authenticated;
grant execute on function public.r2_pending_keys(int) to service_role;

-- Files already orphaned before this migration (deleted posts, abandoned uploads)
-- are NOT queued here: that is a one-off permanent deletion of existing user files
-- and needs an explicit go-ahead. Only deletions from now on are cleaned up.

-- Every 10 minutes: copy new files to R2 and empty the trash (r2-sync).
create or replace function public.dispatch_r2_sync()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare _base text; _anon text; _secret text;
begin
  select value into _base   from private.config where key = 'edge_base_url';
  select value into _anon   from private.config where key = 'anon_key';
  select value into _secret from private.config where key = 'push_webhook_secret';
  if _base is null then return; end if;
  perform net.http_post(
    url     := _base || '/functions/v1/r2-sync',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', coalesce(_anon, ''),
      'Authorization', 'Bearer ' || coalesce(_anon, ''),
      'x-webhook-secret', coalesce(_secret, '')),
    timeout_milliseconds := 120000
  );
end $fn$;
revoke all on function public.dispatch_r2_sync() from public, anon, authenticated;

select cron.schedule('r2-sync', '*/10 * * * *', $$select public.dispatch_r2_sync();$$)
where not exists (select 1 from cron.job where jobname = 'r2-sync');
