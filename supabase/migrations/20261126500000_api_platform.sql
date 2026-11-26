-- Phixr Publishing API, stage 1 (2026-11-26): "Connect your Phixr account" (OAuth 2.0)
-- and posting for outside tools such as Metricool, Buffer and our own Zapier app.
-- Plan + decisions: docs/scheduler-integrations.md.
--
-- Shape:
--   api_clients      — an outside app registered by a developer (any adult account).
--                      Starts in TEST; Phixr approves it to LIVE (decided by Saj).
--   api_auth_codes   — one-time codes from the consent screen (10 min, single use, PKCE).
--   api_grants       — "Connected apps": app X may act for business Y with scopes Z.
--   api_tokens       — access (1 h) and rotating refresh (60 days) tokens, stored HASHED.
--   api_media        — uploads made through the API (processed by the media pipeline).
--   api_activity_log — every action an app takes (who, for which business, what).
--
-- Rules that carry over unchanged from the app:
--   * business accounts only (_require_business); only an owner/admin can connect an app;
--   * API posts are ordinary post_drafts rows scheduled through the SAME scheduler core
--     (limits, caption moderation, held-for-review) and published by the SAME
--     every-minute publisher, whose server verdict still applies;
--   * media goes through the media-pipeline (EXIF strip, adult scan, CSAM hook, R2).
--
-- TEST-mode apps can only connect the developer's own account and named testers, and
-- their posts are never published for real: the publisher marks them published
-- without creating a post, so partners can test the whole lifecycle safely.
--
-- Every table is closed to clients; access is only through the functions below.
-- Functions named api_* are for the `api` edge function (service role only).

insert into public.platform_settings (key, value, description, client_visible) values
  ('api_requests_per_minute', to_jsonb(120), 'Publishing API: requests per minute per connected app.', false),
  ('api_access_token_seconds', to_jsonb(3600), 'Publishing API: access token lifetime (seconds).', false),
  ('api_refresh_token_days', to_jsonb(60), 'Publishing API: refresh token lifetime (days).', false),
  ('api_media_ttl_hours', to_jsonb(24), 'Publishing API: how long an uploaded media item can be used in a post.', false),
  ('api_max_clients_per_owner', to_jsonb(5), 'Publishing API: apps one developer account can register.', false),
  ('api_max_testers', to_jsonb(10), 'Publishing API: tester accounts per test-mode app.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.api_clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null unique,
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 2 and 60),
  description   text check (description is null or char_length(description) <= 300),
  website_url   text check (website_url is null or website_url ~ '^https://'),
  privacy_url   text check (privacy_url is null or privacy_url ~ '^https://'),
  logo_url      text check (logo_url is null or logo_url ~ '^https://'),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  secret_hash   text not null,
  status        text not null default 'test' check (status in ('test', 'in_review', 'live', 'suspended')),
  testers       uuid[] not null default '{}',
  review_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index api_clients_owner on public.api_clients (owner_id);
create trigger set_updated_at before update on public.api_clients
  for each row execute function public.tg_set_updated_at();

create table public.api_auth_codes (
  code_hash      text primary key,
  client         uuid not null references public.api_clients (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  business_id    uuid not null references public.profiles (id) on delete cascade,
  scopes         text[] not null,
  redirect_uri   text not null,
  code_challenge text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index api_auth_codes_expiry on public.api_auth_codes (expires_at);

create table public.api_grants (
  id           uuid primary key default gen_random_uuid(),
  client       uuid not null references public.api_clients (id) on delete cascade,
  business_id  uuid not null references public.profiles (id) on delete cascade,
  granted_by   uuid not null references public.profiles (id) on delete cascade,
  scopes       text[] not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create unique index api_grants_active on public.api_grants (client, business_id) where revoked_at is null;
create index api_grants_business on public.api_grants (business_id) where revoked_at is null;

create table public.api_tokens (
  token_hash  text primary key,
  grant_id    uuid not null references public.api_grants (id) on delete cascade,
  kind        text not null check (kind in ('access', 'refresh')),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index api_tokens_grant on public.api_tokens (grant_id, kind) where revoked_at is null;
create index api_tokens_expiry on public.api_tokens (expires_at);

create table public.api_media (
  id                uuid primary key default gen_random_uuid(),
  grant_id          uuid not null references public.api_grants (id) on delete cascade,
  business_id       uuid not null references public.profiles (id) on delete cascade,
  media_url         text not null,
  thumbnail_url     text,
  media_type        text not null check (media_type in ('image', 'video')),
  moderation_status text not null check (moderation_status in ('approved', 'flagged', 'pending')),
  width             integer,
  height            integer,
  duration_seconds  numeric,
  created_at        timestamptz not null default now()
);
create index api_media_grant on public.api_media (grant_id, created_at desc);

create table public.api_request_events (
  grant_id   uuid not null references public.api_grants (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index api_request_events_grant on public.api_request_events (grant_id, created_at);

create table public.api_activity_log (
  id          bigint generated always as identity primary key,
  client      uuid references public.api_clients (id) on delete set null,
  grant_id    uuid references public.api_grants (id) on delete set null,
  business_id uuid references public.profiles (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  object_id   uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index api_activity_business on public.api_activity_log (business_id, created_at desc);
create index api_activity_grant on public.api_activity_log (grant_id, created_at desc);

alter table public.post_drafts
  add column api_grant_id uuid references public.api_grants (id) on delete set null,
  add column api_test boolean not null default false,
  add column api_idempotency_key text;
create unique index post_drafts_api_idem on public.post_drafts (api_grant_id, api_idempotency_key)
  where api_idempotency_key is not null;
create index post_drafts_api_grant on public.post_drafts (api_grant_id, created_at desc)
  where api_grant_id is not null;

do $$
declare t text;
begin
  foreach t in array array['api_clients', 'api_auth_codes', 'api_grants', 'api_tokens',
                           'api_media', 'api_request_events', 'api_activity_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._api_hash(_t text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(_t, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public._api_random(_prefix text)
returns text language sql volatile set search_path = '' as $$
  select _prefix || encode(extensions.gen_random_bytes(32), 'hex');
$$;

-- RFC 7636 S256: BASE64URL(SHA256(verifier)) without padding.
create or replace function public._api_pkce_s256(_verifier text)
returns text language sql immutable set search_path = '' as $$
  select rtrim(translate(encode(extensions.digest(convert_to(_verifier, 'UTF8'), 'sha256'), 'base64'),
                         E'+/\n', '-_'), '=');
$$;

create or replace function public._api_valid_scopes(_scopes text[])
returns boolean language sql immutable set search_path = '' as $$
  select cardinality(_scopes) > 0
     and _scopes <@ array['account:read', 'posts:read', 'posts:write', 'insights:read'];
$$;

create or replace function public._api_valid_redirect(_uri text)
returns boolean language sql immutable set search_path = '' as $$
  select _uri ~ '^(https://[^\s#*]+|http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[^\s#*]*)?)$'
     and char_length(_uri) <= 500;
$$;

-- Can this account be connected to this app right now? Test/in-review apps only
-- reach the developer's own account and named testers.
create or replace function public._api_account_allowed(c public.api_clients, _business uuid)
returns boolean language sql stable set search_path = '' as $$
  select c.status = 'live'
      or (c.status in ('test', 'in_review')
          and (_business = c.owner_id or _business = any (c.testers)));
$$;

create or replace function public._api_log(
  _client uuid, _grant uuid, _business uuid, _actor uuid, _action text,
  _object uuid default null, _detail jsonb default '{}'::jsonb)
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.api_activity_log (client, grant_id, business_id, actor_id, action, object_id, detail)
  values (_client, _grant, _business, _actor, _action, _object, coalesce(_detail, '{}'::jsonb));
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public._api_hash(text)', 'public._api_random(text)', 'public._api_pkce_s256(text)',
    'public._api_valid_scopes(text[])', 'public._api_valid_redirect(text)',
    'public._api_account_allowed(public.api_clients, uuid)',
    'public._api_log(uuid, uuid, uuid, uuid, text, uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scheduler core: schedule_draft's checks, for an explicit account. The app's
-- schedule_draft now calls this with auth.uid() (behaviour unchanged); the API
-- calls it with the connected business. Notification on "held" as before.
-- ---------------------------------------------------------------------------
create or replace function public._schedule_draft_core(_uid uuid, _draft_id uuid, _when timestamptz)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.post_drafts;
  _max_days  integer := public.setting_numeric('schedule_max_days', 90)::integer;
  _max_posts integer := public.setting_numeric('schedule_max_posts', 100)::integer;
  _caption   text;
  _verdict   text;
begin
  perform public._require_business(_uid, 'Scheduled posts');
  select * into d from public.post_drafts
  where id = _draft_id and user_id = _uid for update;
  if not found then raise exception 'not authorised'; end if;
  if d.status not in ('draft', 'scheduled', 'held', 'failed') then
    raise exception 'This draft cannot be scheduled.';
  end if;
  if _when < now() - interval '1 minute' then
    raise exception 'Pick a time in the future.';
  end if;
  if _when > now() + make_interval(days => _max_days) then
    raise exception 'You can schedule up to % days ahead.', _max_days;
  end if;
  if (select count(*) from public.post_drafts
      where user_id = _uid and status = 'scheduled' and id <> _draft_id) >= _max_posts then
    raise exception 'You can have up to % scheduled posts.', _max_posts;
  end if;
  if coalesce(jsonb_array_length(d.payload->'media'), 0) = 0 then
    raise exception 'This draft has no media yet.';
  end if;
  if d.media_status = 'removed' then
    raise exception 'This media was rejected and cannot be posted.';
  end if;

  _caption := coalesce(d.payload->>'caption', '');
  _verdict := case when _caption = '' then 'approved'
                   else public.moderate_text(_caption) end;
  if d.media_status = 'flagged' or _verdict in ('flagged', 'removed') then
    update public.post_drafts
       set status = 'held', scheduled_at = _when,
           failure_reason = 'Held for review before publishing'
     where id = _draft_id;
    insert into public.notifications (user_id, type, payload)
    values (_uid, 'schedule_update',
            jsonb_build_object('outcome', 'held', 'draft_id', _draft_id,
                               'scheduled_at', _when));
    return 'held';
  end if;

  update public.post_drafts
     set status = 'scheduled', scheduled_at = _when, failure_reason = null, attempts = 0
   where id = _draft_id;
  return 'scheduled';
end;
$$;
revoke all on function public._schedule_draft_core(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public._schedule_draft_core(uuid, uuid, timestamptz) to service_role;

create or replace function public.schedule_draft(_draft_id uuid, _when timestamptz)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not authorised'; end if;
  perform public._schedule_draft_core(auth.uid(), _draft_id, _when);
end;
$$;

-- ---------------------------------------------------------------------------
-- Publisher: unchanged except that TEST-mode API drafts are marked published
-- without creating a real post (and without notifying anyone).
-- ---------------------------------------------------------------------------
create or replace function public.publish_due_drafts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.post_drafts;
  _id uuid;
  _max_attempts integer := public.setting_numeric('schedule_max_attempts', 3)::integer;
begin
  for d in
    select * from public.post_drafts
    where status = 'scheduled' and scheduled_at <= now()
    order by scheduled_at
    limit 50
    for update skip locked
  loop
    begin
      -- Part 17: server-side verdict first — held drafts never publish.
      if public._draft_server_verdict(d) = 'held' then
        update public.post_drafts
           set status = 'held', failure_reason = 'Held for review before publishing'
         where id = d.id;
        insert into public.notifications (user_id, type, payload)
        values (d.user_id, 'schedule_update',
                jsonb_build_object('outcome', 'held', 'kind', d.kind, 'draft_id', d.id));
        continue;
      end if;

      -- Publishing API test mode: simulate the publish, never create a real post.
      if d.api_test then
        update public.post_drafts
           set status = 'published', published_post_id = null, failure_reason = null
         where id = d.id;
        continue;
      end if;

      update public.post_drafts set status = 'publishing' where id = d.id;
      _id := public._publish_one_draft(d);
      update public.post_drafts
         set status = 'published',
             published_post_id = case when d.kind = 'post' then _id end
       where id = d.id;
      insert into public.notifications (user_id, type, post_id, payload)
      values (d.user_id, 'schedule_update',
              case when d.kind = 'post' then _id end,
              jsonb_build_object('outcome', 'published', 'kind', d.kind));
    exception when others then
      if d.attempts + 1 >= _max_attempts then
        update public.post_drafts
           set status = 'failed', attempts = d.attempts + 1, failure_reason = sqlerrm
         where id = d.id;
        insert into public.notifications (user_id, type, payload)
        values (d.user_id, 'schedule_update',
                jsonb_build_object('outcome', 'failed', 'kind', d.kind,
                                   'reason', sqlerrm, 'draft_id', d.id));
      else
        update public.post_drafts
           set status = 'scheduled', attempts = d.attempts + 1, failure_reason = sqlerrm
         where id = d.id;
      end if;
    end;
  end loop;
end;
$$;

-- ===========================================================================
-- Developer side (signed-in users): register and manage apps.
-- ===========================================================================
create or replace function public.register_api_client(
  _name text, _redirect_uris text[], _website_url text default null,
  _description text default null, _privacy_url text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _cid text;
  _secret text;
  _u text;
  _max integer := public.setting_numeric('api_max_clients_per_owner', 5)::integer;
begin
  if _uid is null then raise exception 'not authorised'; end if;
  if public.is_minor(_uid) then raise exception 'You must be 18 or over to register an app.'; end if;
  if (select count(*) from public.api_clients where owner_id = _uid) >= _max then
    raise exception 'You can register up to % apps.', _max;
  end if;
  if _redirect_uris is null or cardinality(_redirect_uris) = 0 then
    raise exception 'Add at least one redirect URL.';
  end if;
  foreach _u in array _redirect_uris loop
    if not public._api_valid_redirect(_u) then
      raise exception 'Redirect URL must be https:// (or http://localhost for testing): %', _u;
    end if;
  end loop;

  _cid := 'phx_' || encode(extensions.gen_random_bytes(12), 'hex');
  _secret := public._api_random('phx_cs_');
  insert into public.api_clients (client_id, owner_id, name, description, website_url,
                                  privacy_url, redirect_uris, secret_hash)
  values (_cid, _uid, btrim(_name), nullif(btrim(_description), ''), nullif(btrim(_website_url), ''),
          nullif(btrim(_privacy_url), ''), _redirect_uris, public._api_hash(_secret));
  perform public._api_log((select id from public.api_clients where client_id = _cid),
                          null, null, _uid, 'client_register');
  -- The secret is shown ONCE; only its hash is stored.
  return jsonb_build_object('client_id', _cid, 'client_secret', _secret, 'status', 'test');
end;
$$;

create or replace function public.rotate_api_client_secret(_client_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _secret text := public._api_random('phx_cs_');
  _id uuid;
begin
  update public.api_clients set secret_hash = public._api_hash(_secret)
   where client_id = _client_id and owner_id = auth.uid()
  returning id into _id;
  if _id is null then raise exception 'not authorised'; end if;
  perform public._api_log(_id, null, null, auth.uid(), 'client_rotate_secret');
  return jsonb_build_object('client_id', _client_id, 'client_secret', _secret);
end;
$$;

create or replace function public.update_api_client(
  _client_id text, _name text default null, _redirect_uris text[] default null,
  _website_url text default null, _description text default null, _privacy_url text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare _u text;
begin
  if _redirect_uris is not null then
    if cardinality(_redirect_uris) = 0 then raise exception 'Add at least one redirect URL.'; end if;
    foreach _u in array _redirect_uris loop
      if not public._api_valid_redirect(_u) then
        raise exception 'Redirect URL must be https:// (or http://localhost for testing): %', _u;
      end if;
    end loop;
  end if;
  update public.api_clients
     set name          = coalesce(nullif(btrim(_name), ''), name),
         redirect_uris = coalesce(_redirect_uris, redirect_uris),
         website_url   = coalesce(nullif(btrim(_website_url), ''), website_url),
         description   = coalesce(nullif(btrim(_description), ''), description),
         privacy_url   = coalesce(nullif(btrim(_privacy_url), ''), privacy_url)
   where client_id = _client_id and owner_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
end;
$$;

-- Testers are given by handle; they must exist and be business accounts to connect.
create or replace function public.set_api_client_testers(_client_id text, _handles text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _ids uuid[];
  _max integer := public.setting_numeric('api_max_testers', 10)::integer;
begin
  select coalesce(array_agg(distinct p.id), '{}') into _ids
  from public.profiles p
  where lower(p.handle) in (select lower(ltrim(btrim(h), '@')) from unnest(coalesce(_handles, '{}')) h);
  if cardinality(_ids) < cardinality(array(select distinct lower(ltrim(btrim(h), '@'))
                                           from unnest(coalesce(_handles, '{}')) h)) then
    raise exception 'One or more handles were not found.';
  end if;
  if cardinality(_ids) > _max then raise exception 'Up to % testers.', _max; end if;
  update public.api_clients set testers = _ids
   where client_id = _client_id and owner_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
end;
$$;

create or replace function public.request_api_client_review(_client_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare _id uuid;
begin
  update public.api_clients set status = 'in_review'
   where client_id = _client_id and owner_id = auth.uid() and status = 'test'
  returning id into _id;
  if _id is null then raise exception 'This app is not in test mode.'; end if;
  perform public._api_log(_id, null, null, auth.uid(), 'client_request_review');
end;
$$;

create or replace function public.my_api_clients()
returns table (client_id text, name text, description text, website_url text, privacy_url text,
               redirect_uris text[], status text, testers text[], review_note text,
               connections bigint, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.client_id, c.name, c.description, c.website_url, c.privacy_url, c.redirect_uris,
         c.status,
         array(select p.handle from public.profiles p where p.id = any (c.testers) order by p.handle),
         c.review_note,
         (select count(*) from public.api_grants g where g.client = c.id and g.revoked_at is null),
         c.created_at
  from public.api_clients c
  where c.owner_id = auth.uid()
  order by c.created_at desc;
$$;

-- Phixr staff (admin portal, service role): approve / suspend apps.
create or replace function public.admin_set_api_client_status(_client_id text, _status text, _note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare _id uuid;
begin
  if _status not in ('test', 'in_review', 'live', 'suspended') then raise exception 'bad status'; end if;
  update public.api_clients set status = _status, review_note = _note
   where client_id = _client_id returning id into _id;
  if _id is null then raise exception 'no such app'; end if;
  if _status = 'suspended' then
    update public.api_tokens t set revoked_at = now()
      from public.api_grants g
     where t.grant_id = g.id and g.client = _id and t.revoked_at is null;
  end if;
  perform public._api_log(_id, null, null, null, 'admin_status',
                          null, jsonb_build_object('status', _status, 'note', _note));
end;
$$;

-- ===========================================================================
-- Consent screen (signed-in users): describe the request, then approve it.
-- ===========================================================================
create or replace function public.oauth_describe(_client_id text, _redirect_uri text, _scopes text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.api_clients;
  _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'not authorised'; end if;
  select * into c from public.api_clients where client_id = _client_id;
  if not found or c.status = 'suspended' then raise exception 'unknown_app'; end if;
  if not (_redirect_uri = any (c.redirect_uris)) then raise exception 'bad_redirect_uri'; end if;
  if not public._api_valid_scopes(_scopes) then raise exception 'invalid_scope'; end if;

  return jsonb_build_object(
    'app', jsonb_build_object('name', c.name, 'description', c.description,
                              'website_url', c.website_url, 'privacy_url', c.privacy_url,
                              'logo_url', c.logo_url, 'status', c.status),
    'scopes', to_jsonb(_scopes),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'handle', p.handle, 'display_name', p.display_name,
               'avatar_url', p.avatar_url,
               'eligible', p.account_type = 'business' and public._api_account_allowed(c, p.id),
               'reason', case
                 when p.account_type <> 'business' then 'not_business'
                 when not public._api_account_allowed(c, p.id) then 'app_in_test_mode'
               end,
               'connected', exists (select 1 from public.api_grants g
                                    where g.client = c.id and g.business_id = p.id
                                      and g.revoked_at is null))
             order by (p.id = _uid) desc, p.handle)
      from public.profiles p
      where p.id = _uid
         or p.id in (select t.business_id from public.team_members t
                     where t.member_id = _uid and t.status = 'accepted' and t.role = 'admin')
    ), '[]'::jsonb),
    'adult', not public.is_minor(_uid));
end;
$$;

create or replace function public.oauth_approve(
  _client_id text, _redirect_uri text, _scopes text[], _business uuid,
  _code_challenge text default null, _code_challenge_method text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.api_clients;
  _uid uuid := auth.uid();
  _code text;
begin
  if _uid is null then raise exception 'not authorised'; end if;
  select * into c from public.api_clients where client_id = _client_id;
  if not found or c.status = 'suspended' then raise exception 'unknown_app'; end if;
  if not (_redirect_uri = any (c.redirect_uris)) then raise exception 'bad_redirect_uri'; end if;
  if not public._api_valid_scopes(_scopes) then raise exception 'invalid_scope'; end if;
  if public.is_minor(_uid) then raise exception 'You must be 18 or over to connect apps.'; end if;
  if not public.has_team_role(_business, array['admin']) then raise exception 'not authorised'; end if;
  perform public._require_business(_business, 'Connected apps');
  if not public._api_account_allowed(c, _business) then
    raise exception 'This app is still in testing and can only connect its developer''s test accounts.';
  end if;
  if _code_challenge is not null then
    if coalesce(_code_challenge_method, 'S256') <> 'S256' then
      raise exception 'Only S256 code challenges are supported.';
    end if;
    if _code_challenge !~ '^[A-Za-z0-9_-]{43,128}$' then raise exception 'bad code_challenge'; end if;
  end if;

  _code := public._api_random('phx_ac_');
  insert into public.api_auth_codes (code_hash, client, user_id, business_id, scopes,
                                     redirect_uri, code_challenge, expires_at)
  values (public._api_hash(_code), c.id, _uid, _business,
          array(select distinct s from unnest(_scopes) s order by s),
          _redirect_uri, _code_challenge, now() + interval '10 minutes');
  -- Tidy old codes opportunistically.
  delete from public.api_auth_codes where expires_at < now() - interval '1 day';
  perform public._api_log(c.id, null, _business, _uid, 'consent_approve',
                          null, jsonb_build_object('scopes', _scopes));
  return _code;
end;
$$;

-- ===========================================================================
-- Connected apps (business owner/admin): list and remove.
-- ===========================================================================
create or replace function public.my_connected_apps(_business uuid default null)
returns table (grant_id uuid, app_name text, app_website text, app_status text, scopes text[],
               connected_by text, created_at timestamptz, last_used_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare _b uuid := coalesce(_business, auth.uid());
begin
  if not public.has_team_role(_b, array['admin']) then raise exception 'not authorised'; end if;
  return query
    select g.id, c.name, c.website_url, c.status, g.scopes, p.handle, g.created_at, g.last_used_at
    from public.api_grants g
    join public.api_clients c on c.id = g.client
    left join public.profiles p on p.id = g.granted_by
    where g.business_id = _b and g.revoked_at is null
    order by g.created_at desc;
end;
$$;

create or replace function public.revoke_connected_app(_grant_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare g public.api_grants;
begin
  select * into g from public.api_grants where id = _grant_id and revoked_at is null for update;
  if not found or not public.has_team_role(g.business_id, array['admin']) then
    raise exception 'not authorised';
  end if;
  update public.api_grants set revoked_at = now() where id = _grant_id;
  update public.api_tokens set revoked_at = now() where grant_id = _grant_id and revoked_at is null;
  -- Nothing this app queued goes out after the business removes it: back to drafts.
  update public.post_drafts
     set status = 'draft', scheduled_at = null, failure_reason = null, attempts = 0
   where api_grant_id = _grant_id and status in ('scheduled', 'held', 'failed');
  -- Test-mode practice posts have no value once the app is gone.
  delete from public.post_drafts where api_grant_id = _grant_id and api_test;
  perform public._api_log(g.client, g.id, g.business_id, auth.uid(), 'grant_revoke');
end;
$$;

-- ===========================================================================
-- Token endpoint (service role, called by the `api` edge function).
-- ===========================================================================
create or replace function public._api_issue_tokens(_grant uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _at text := public._api_random('phx_at_');
  _rt text := public._api_random('phx_rt_');
  _ttl integer := public.setting_numeric('api_access_token_seconds', 3600)::integer;
  _rdays integer := public.setting_numeric('api_refresh_token_days', 60)::integer;
  g public.api_grants;
  p public.profiles;
begin
  select * into g from public.api_grants where id = _grant;
  select * into p from public.profiles where id = g.business_id;
  insert into public.api_tokens (token_hash, grant_id, kind, expires_at)
  values (public._api_hash(_at), _grant, 'access', now() + make_interval(secs => _ttl)),
         (public._api_hash(_rt), _grant, 'refresh', now() + make_interval(days => _rdays));
  -- Housekeeping for this grant.
  delete from public.api_tokens where grant_id = _grant and expires_at < now() - interval '7 days';
  return jsonb_build_object(
    'access_token', _at, 'token_type', 'Bearer', 'expires_in', _ttl,
    'refresh_token', _rt, 'scope', array_to_string(g.scopes, ' '),
    'account', jsonb_build_object('id', p.id, 'handle', p.handle, 'display_name', p.display_name));
end;
$$;
revoke all on function public._api_issue_tokens(uuid) from public, anon, authenticated;
grant execute on function public._api_issue_tokens(uuid) to service_role;

-- Client authentication: the secret if sent; otherwise PKCE must be used (public client).
create or replace function public._api_client_auth(_client_id text, _client_secret text)
returns public.api_clients
language plpgsql
stable
security definer
set search_path = ''
as $$
declare c public.api_clients;
begin
  select * into c from public.api_clients where client_id = _client_id;
  if not found then raise exception 'invalid_client'; end if;
  if c.status = 'suspended' then raise exception 'invalid_client'; end if;
  if _client_secret is not null and public._api_hash(_client_secret) <> c.secret_hash then
    raise exception 'invalid_client';
  end if;
  return c;
end;
$$;
revoke all on function public._api_client_auth(text, text) from public, anon, authenticated;
grant execute on function public._api_client_auth(text, text) to service_role;

create or replace function public.api_exchange_code(
  _client_id text, _client_secret text, _code text, _redirect_uri text, _code_verifier text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.api_clients := public._api_client_auth(_client_id, _client_secret);
  a public.api_auth_codes;
  _grant uuid;
begin
  select * into a from public.api_auth_codes
  where code_hash = public._api_hash(coalesce(_code, '')) and client = c.id for update;
  if not found or a.expires_at < now() then raise exception 'invalid_grant'; end if;
  if a.used_at is not null then
    -- Code replay: kill anything issued from the first use (RFC 6749 §4.1.2).
    update public.api_tokens t set revoked_at = now()
      from public.api_grants g
     where t.grant_id = g.id and g.client = c.id and g.business_id = a.business_id
       and t.created_at >= a.used_at and t.revoked_at is null;
    perform public._api_log(c.id, null, a.business_id, null, 'code_replay_detected');
    -- Returned, not raised: raising would roll the revocation back.
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  if a.redirect_uri <> coalesce(_redirect_uri, '') then raise exception 'invalid_grant'; end if;
  if a.code_challenge is not null then
    if _code_verifier is null or public._api_pkce_s256(_code_verifier) <> a.code_challenge then
      raise exception 'invalid_grant';
    end if;
  elsif _client_secret is null then
    raise exception 'invalid_client';  -- no secret and no PKCE
  end if;
  update public.api_auth_codes set used_at = now() where code_hash = a.code_hash;

  -- One live connection per app per business; reconnecting replaces its scopes.
  select id into _grant from public.api_grants
  where client = c.id and business_id = a.business_id and revoked_at is null for update;
  if _grant is null then
    insert into public.api_grants (client, business_id, granted_by, scopes)
    values (c.id, a.business_id, a.user_id, a.scopes) returning id into _grant;
  else
    update public.api_grants set scopes = a.scopes, granted_by = a.user_id, updated_at = now()
     where id = _grant;
  end if;
  perform public._api_log(c.id, _grant, a.business_id, a.user_id, 'token_issue');
  return public._api_issue_tokens(_grant);
end;
$$;

create or replace function public.api_refresh(_client_id text, _client_secret text, _refresh_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.api_clients := public._api_client_auth(_client_id, _client_secret);
  t public.api_tokens;
  g public.api_grants;
begin
  select * into t from public.api_tokens
  where token_hash = public._api_hash(coalesce(_refresh_token, '')) and kind = 'refresh' for update;
  if not found then raise exception 'invalid_grant'; end if;
  select * into g from public.api_grants where id = t.grant_id;
  if g.client <> c.id or g.revoked_at is not null then raise exception 'invalid_grant'; end if;
  if t.revoked_at is not null then
    -- A rotated refresh token was used again: assume it leaked; end every session.
    update public.api_tokens set revoked_at = now() where grant_id = g.id and revoked_at is null;
    perform public._api_log(c.id, g.id, g.business_id, null, 'refresh_reuse_detected');
    -- Returned, not raised: raising would roll the revocation back.
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  if t.expires_at < now() then raise exception 'invalid_grant'; end if;
  update public.api_tokens set revoked_at = now() where token_hash = t.token_hash;
  return public._api_issue_tokens(g.id);
end;
$$;

create or replace function public.api_revoke_token(_client_id text, _client_secret text, _token text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.api_clients := public._api_client_auth(_client_id, _client_secret);
  t public.api_tokens;
  g public.api_grants;
begin
  select * into t from public.api_tokens where token_hash = public._api_hash(coalesce(_token, ''));
  if not found then return; end if;  -- RFC 7009: unknown tokens are not an error
  select * into g from public.api_grants where id = t.grant_id;
  if g.client <> c.id then return; end if;
  -- Revoking either token ends this connection's sessions (the business stays connected
  -- only if the app signs in again).
  update public.api_tokens set revoked_at = now() where grant_id = g.id and revoked_at is null;
  perform public._api_log(c.id, g.id, g.business_id, null, 'token_revoke');
end;
$$;

-- ===========================================================================
-- Request authentication (service role): token → connection, with every live
-- check: app status, business still a business, connector still an admin,
-- scope, test-mode tester list, rate limit. Failures come back as {"error": code}
-- (the edge function maps them to HTTP statuses); functions that must keep a
-- side effect on failure (revocations) return the error instead of raising.
-- ===========================================================================
create or replace function public.api_authenticate(_access_token text, _scope text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t public.api_tokens;
  g public.api_grants;
  c public.api_clients;
  _limit integer := public.setting_numeric('api_requests_per_minute', 120)::integer;
  _n integer;
begin
  select * into t from public.api_tokens
  where token_hash = public._api_hash(coalesce(_access_token, '')) and kind = 'access';
  if not found or t.revoked_at is not null or t.expires_at < now() then
    raise exception 'invalid_token';
  end if;
  select * into g from public.api_grants where id = t.grant_id;
  if g.revoked_at is not null then raise exception 'invalid_token'; end if;
  select * into c from public.api_clients where id = g.client;
  if c.status = 'suspended' then raise exception 'app_suspended'; end if;
  if not public._api_account_allowed(c, g.business_id) then raise exception 'app_in_test_mode'; end if;
  if not exists (select 1 from public.profiles p
                 where p.id = g.business_id and p.account_type = 'business') then
    raise exception 'not_business';
  end if;
  -- The person who connected the app must still be the owner or an admin.
  if g.granted_by <> g.business_id and not exists (
       select 1 from public.team_members tm
       where tm.business_id = g.business_id and tm.member_id = g.granted_by
         and tm.status = 'accepted' and tm.role = 'admin') then
    update public.api_grants set revoked_at = now() where id = g.id;
    update public.api_tokens set revoked_at = now() where grant_id = g.id and revoked_at is null;
    perform public._api_log(c.id, g.id, g.business_id, null, 'grant_auto_revoke',
                            null, jsonb_build_object('reason', 'connector no longer admin'));
    -- Returned, not raised: raising would roll the revocation back.
    return jsonb_build_object('error', 'invalid_token');
  end if;
  if _scope is not null and not (_scope = any (g.scopes)) then raise exception 'insufficient_scope'; end if;

  insert into public.api_request_events (grant_id) values (g.id);
  select count(*) into _n from public.api_request_events
  where grant_id = g.id and created_at > now() - interval '1 minute';
  if _n > _limit then raise exception 'rate_limited'; end if;
  if random() < 0.02 then
    delete from public.api_request_events where grant_id = g.id and created_at < now() - interval '10 minutes';
  end if;
  if g.last_used_at is null or g.last_used_at < now() - interval '5 minutes' then
    update public.api_grants set last_used_at = now() where id = g.id;
  end if;

  return jsonb_build_object('grant_id', g.id, 'client', c.id, 'client_name', c.name,
                            'business_id', g.business_id, 'scopes', to_jsonb(g.scopes),
                            'test', c.status <> 'live');
end;
$$;

-- Resolve a grant for the data functions below (re-checks it is still live).
create or replace function public._api_grant(_grant uuid)
returns public.api_grants
language plpgsql
stable
security definer
set search_path = ''
as $$
declare g public.api_grants;
begin
  select * into g from public.api_grants where id = _grant and revoked_at is null;
  if not found then raise exception 'invalid_token'; end if;
  return g;
end;
$$;
revoke all on function public._api_grant(uuid) from public, anon, authenticated;
grant execute on function public._api_grant(uuid) to service_role;

-- ===========================================================================
-- Data functions (service role).
-- ===========================================================================
create or replace function public.api_me(_grant uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'handle', p.handle, 'display_name', p.display_name,
    'avatar_url', p.avatar_url, 'account_type', p.account_type,
    'profile_url', 'https://joinphixr.com/u/' || p.handle)
  from public.profiles p
  where p.id = (public._api_grant(_grant)).business_id;
$$;

-- Same hourly upload budget as the app (media_upload_events), for the business.
create or replace function public.api_claim_upload_slot(_grant uuid, _max integer, _window_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.api_grants := public._api_grant(_grant);
  _count integer;
begin
  insert into public.media_upload_events (user_id) values (g.business_id);
  select count(*) into _count from public.media_upload_events
  where user_id = g.business_id and created_at > now() - make_interval(secs => _window_seconds);
  return _count <= _max;
end;
$$;

create or replace function public.api_record_media(
  _grant uuid, _media_url text, _thumbnail_url text, _media_type text,
  _moderation_status text, _width integer, _height integer, _duration numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.api_grants := public._api_grant(_grant);
  _id uuid;
  _ttl integer := public.setting_numeric('api_media_ttl_hours', 24)::integer;
begin
  -- The key must be in the business's own folder (written by the pipeline for it).
  if split_part(_media_url, '/', 1) <> g.business_id::text then raise exception 'bad media key'; end if;
  insert into public.api_media (grant_id, business_id, media_url, thumbnail_url, media_type,
                                moderation_status, width, height, duration_seconds)
  values (g.id, g.business_id, _media_url, _thumbnail_url, _media_type,
          _moderation_status, _width, _height, _duration)
  returning id into _id;
  perform public._api_log(g.client, g.id, g.business_id, null, 'media_upload', _id,
                          jsonb_build_object('type', _media_type, 'moderation', _moderation_status));
  return jsonb_build_object('id', _id, 'type', _media_type,
                            'moderation_status', _moderation_status,
                            'width', _width, 'height', _height, 'duration_seconds', _duration,
                            'expires_at', now() + make_interval(hours => _ttl));
end;
$$;

-- The public shape of an API post.
create or replace function public._api_post_json(d public.post_drafts)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'kind', d.kind,
    'status', d.status,
    'caption', d.payload->>'caption',
    'alt_text', d.payload->>'alt_text',
    'visibility', coalesce(d.payload->>'visibility', 'public'),
    'media_count', coalesce(jsonb_array_length(d.payload->'media'), 0),
    'publish_at', d.scheduled_at,
    'published_post_id', d.published_post_id,
    'url', case when d.published_post_id is not null
                then 'https://joinphixr.com/post/' || d.published_post_id end,
    'reason', case when d.status in ('held', 'failed') then d.failure_reason end,
    'test', d.api_test,
    'created_at', d.created_at,
    'updated_at', d.updated_at);
$$;
revoke all on function public._api_post_json(public.post_drafts) from public, anon, authenticated;
grant execute on function public._api_post_json(public.post_drafts) to service_role;

create or replace function public.api_create_post(
  _grant uuid, _media_ids uuid[], _kind text default 'post', _caption text default null,
  _alt_text text default null, _visibility text default 'public',
  _publish_at timestamptz default null, _as_draft boolean default false,
  _idempotency_key text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.api_grants := public._api_grant(_grant);
  c public.api_clients;
  d public.post_drafts;
  _media jsonb := '[]'::jsonb;
  _worst text := 'approved';
  _ttl integer := public.setting_numeric('api_media_ttl_hours', 24)::integer;
  _m public.api_media;
  _id uuid;
  _i integer;
  _test boolean;
begin
  select * into c from public.api_clients where id = g.client;
  -- Anything not yet approved by Phixr is test mode: posts are simulated, never real.
  _test := c.status <> 'live';
  perform public._require_business(g.business_id, 'Scheduled posts');

  if _idempotency_key is not null then
    select * into d from public.post_drafts
    where api_grant_id = g.id and api_idempotency_key = _idempotency_key;
    if found then return public._api_post_json(d) || jsonb_build_object('idempotent_replay', true); end if;
  end if;

  if _kind not in ('post', 'story') then raise exception 'kind must be post or story'; end if;
  if _visibility not in ('public', 'private') then raise exception 'visibility must be public or private'; end if;
  if char_length(coalesce(_caption, '')) > 2200 then raise exception 'caption is longer than 2200 characters'; end if;
  if char_length(coalesce(_alt_text, '')) > 1000 then raise exception 'alt_text is longer than 1000 characters'; end if;
  if _media_ids is null or cardinality(_media_ids) = 0 then raise exception 'media_ids is required'; end if;
  if _kind = 'post' and cardinality(_media_ids) > 10 then raise exception 'a post can have up to 10 media items'; end if;
  if _kind = 'story' and cardinality(_media_ids) <> 1 then raise exception 'a story has exactly one media item'; end if;

  for _i in 1 .. cardinality(_media_ids) loop
    select * into _m from public.api_media
    where id = _media_ids[_i] and business_id = g.business_id;
    if not found then raise exception 'media % not found', _media_ids[_i]; end if;
    if _m.created_at < now() - make_interval(hours => _ttl) then
      raise exception 'media % has expired; upload it again', _media_ids[_i];
    end if;
    _media := _media || jsonb_build_array(jsonb_build_object(
      'media_url', _m.media_url, 'thumbnail_url', _m.thumbnail_url,
      'media_type', _m.media_type, 'moderation_status', _m.moderation_status));
    if _m.moderation_status = 'flagged' then _worst := 'flagged';
    elsif _m.moderation_status = 'pending' and _worst = 'approved' then _worst := 'pending';
    end if;
  end loop;

  insert into public.post_drafts (user_id, kind, payload, media_status, api_grant_id, api_test,
                                  api_idempotency_key)
  values (g.business_id, _kind,
          jsonb_build_object('caption', coalesce(_caption, ''), 'alt_text', coalesce(_alt_text, ''),
                             'visibility', _visibility, 'media', _media,
                             'source', 'api', 'api_app', c.name),
          _worst, g.id, _test, _idempotency_key)
  returning id into _id;

  if not _as_draft then
    perform public._schedule_draft_core(g.business_id, _id, coalesce(_publish_at, now()));
  end if;

  select * into d from public.post_drafts where id = _id;
  perform public._api_log(g.client, g.id, g.business_id, null,
                          case when _as_draft then 'post_draft' else 'post_schedule' end, _id,
                          jsonb_build_object('status', d.status, 'publish_at', d.scheduled_at,
                                             'test', _test));
  return public._api_post_json(d);
end;
$$;

create or replace function public.api_get_post(_grant uuid, _id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  g public.api_grants := public._api_grant(_grant);
  d public.post_drafts;
begin
  select * into d from public.post_drafts
  where id = _id and user_id = g.business_id
    and api_grant_id in (select id from public.api_grants where client = g.client);
  if not found then raise exception 'not_found'; end if;
  return public._api_post_json(d);
end;
$$;

create or replace function public.api_list_posts(
  _grant uuid, _status text default null, _limit integer default 20, _before timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare g public.api_grants := public._api_grant(_grant);
begin
  return coalesce((
    select jsonb_agg(public._api_post_json(d) order by d.created_at desc)
    from public.post_drafts d
    where d.id in (
      select x.id from public.post_drafts x
      where x.user_id = g.business_id
        and x.api_grant_id in (select id from public.api_grants where client = g.client)
        and (_status is null or x.status = _status)
        and (_before is null or x.created_at < _before)
      order by x.created_at desc
      limit least(greatest(coalesce(_limit, 20), 1), 100))
  ), '[]'::jsonb);
end;
$$;

-- Change caption / alt text / time of a post that hasn't been published yet.
create or replace function public.api_update_post(
  _grant uuid, _id uuid, _caption text default null, _alt_text text default null,
  _publish_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.api_grants := public._api_grant(_grant);
  d public.post_drafts;
begin
  select * into d from public.post_drafts
  where id = _id and user_id = g.business_id
    and api_grant_id in (select id from public.api_grants where client = g.client)
  for update;
  if not found then raise exception 'not_found'; end if;
  if d.status in ('publishing', 'published') then
    raise exception 'This post has already been published; delete it and create a new one.';
  end if;
  if char_length(coalesce(_caption, '')) > 2200 then raise exception 'caption is longer than 2200 characters'; end if;
  if char_length(coalesce(_alt_text, '')) > 1000 then raise exception 'alt_text is longer than 1000 characters'; end if;

  update public.post_drafts
     set payload = payload
                   || case when _caption is not null then jsonb_build_object('caption', _caption) else '{}'::jsonb end
                   || case when _alt_text is not null then jsonb_build_object('alt_text', _alt_text) else '{}'::jsonb end
   where id = _id;

  -- Anything already queued (or given a new time) goes back through the scheduler,
  -- which re-checks the caption.
  if _publish_at is not null or d.status in ('scheduled', 'held', 'failed') then
    perform public._schedule_draft_core(g.business_id, _id, coalesce(_publish_at, d.scheduled_at, now()));
  end if;

  select * into d from public.post_drafts where id = _id;
  perform public._api_log(g.client, g.id, g.business_id, null, 'post_update', _id,
                          jsonb_build_object('status', d.status, 'publish_at', d.scheduled_at));
  return public._api_post_json(d);
end;
$$;

-- Cancel a queued post, or take down a published one.
create or replace function public.api_delete_post(_grant uuid, _id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.api_grants := public._api_grant(_grant);
  d public.post_drafts;
begin
  select * into d from public.post_drafts
  where id = _id and user_id = g.business_id
    and api_grant_id in (select id from public.api_grants where client = g.client)
  for update;
  if not found then raise exception 'not_found'; end if;
  if d.status = 'publishing' then raise exception 'This post is publishing right now; try again in a minute.'; end if;
  if d.published_post_id is not null then
    delete from public.posts where id = d.published_post_id and user_id = g.business_id;
  end if;
  delete from public.post_drafts where id = _id;
  perform public._api_log(g.client, g.id, g.business_id, null, 'post_delete', _id,
                          jsonb_build_object('was', d.status, 'post_id', d.published_post_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  -- Signed-in users (developers, consent screen, connected apps).
  foreach f in array array[
    'public.register_api_client(text, text[], text, text, text)',
    'public.rotate_api_client_secret(text)',
    'public.update_api_client(text, text, text[], text, text, text)',
    'public.set_api_client_testers(text, text[])',
    'public.request_api_client_review(text)',
    'public.my_api_clients()',
    'public.oauth_describe(text, text, text[])',
    'public.oauth_approve(text, text, text[], uuid, text, text)',
    'public.my_connected_apps(uuid)',
    'public.revoke_connected_app(uuid)',
    'public.schedule_draft(uuid, timestamptz)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- The api edge function and Phixr staff only.
  foreach f in array array[
    'public.admin_set_api_client_status(text, text, text)',
    'public.api_exchange_code(text, text, text, text, text)',
    'public.api_refresh(text, text, text)',
    'public.api_revoke_token(text, text, text)',
    'public.api_authenticate(text, text)',
    'public.api_me(uuid)',
    'public.api_claim_upload_slot(uuid, integer, integer)',
    'public.api_record_media(uuid, text, text, text, text, integer, integer, numeric)',
    'public.api_create_post(uuid, uuid[], text, text, text, text, timestamptz, boolean, text)',
    'public.api_get_post(uuid, uuid)',
    'public.api_list_posts(uuid, text, integer, timestamptz)',
    'public.api_update_post(uuid, uuid, text, text, timestamptz)',
    'public.api_delete_post(uuid, uuid)',
    'public.publish_due_drafts()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
