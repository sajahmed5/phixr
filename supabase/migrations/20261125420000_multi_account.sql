-- Part 11: multiple accounts on one device.
--
-- Server-side there is deliberately almost nothing: accounts are linked ON
-- THE DEVICE ONLY (secure-store session slots) and other users can never see
-- that two accounts share a person. The three server pieces:
--   1. push_tokens gains a (token, user_id) key so every signed-in account
--      on a device receives its pushes (was: one token = one account).
--   2. account_devices: the ban-evasion signal (hashed device install id per
--      account). Clients can only WRITE their own presence via a function;
--      NOBODY but the service role (fame-admin, moderators) can read it.
--   3. The account limit as a client-visible setting.

insert into public.platform_settings (key, value, description, client_visible)
values ('max_linked_accounts', to_jsonb(5),
        'How many accounts can be signed in on one device at once.', true)
on conflict (key) do nothing;

-- 1. One push token may now belong to several accounts (one row per account).
alter table public.push_tokens drop constraint push_tokens_pkey;
alter table public.push_tokens add primary key (token, user_id);

-- 2. Ban-evasion device signal. device_hash = SHA-256 of a random install id
--    kept in the device keychain — never the raw id, never a hardware id.
create table public.account_devices (
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  platform    text not null check (platform in ('ios', 'android', 'web')),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  primary key (device_hash, user_id)
);
create index account_devices_user on public.account_devices (user_id);
alter table public.account_devices enable row level security;
revoke all on table public.account_devices from public, anon, authenticated;
-- No client read path AT ALL: the linkage is moderator-only (fame-admin via
-- service role). Writes go through the function below.

create or replace function public.record_device_presence(_device_hash text, _platform text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if _platform not in ('ios', 'android', 'web') then
    raise exception 'bad platform';
  end if;
  insert into public.account_devices (device_hash, user_id, platform)
  values (lower(_device_hash), auth.uid(), _platform)
  on conflict (device_hash, user_id)
  do update set last_seen = now(), platform = excluded.platform;
end;
$$;
revoke all on function public.record_device_presence(text, text) from public, anon, authenticated;
grant execute on function public.record_device_presence(text, text) to authenticated;
