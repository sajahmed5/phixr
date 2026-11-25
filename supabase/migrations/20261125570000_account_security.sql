-- Part 14C: account security — 2FA (Supabase TOTP) with one-time backup
-- codes, MFA required for team admins and accounts with earnings, and
-- login alerts on a new device with "This wasn't me".

-- Has this user a VERIFIED authenticator factor?
create or replace function public.mfa_enrolled(_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.mfa_factors f
                 where f.user_id = _uid and f.status = 'verified');
$$;

-- ---------------------------------------------------------------------------
-- Backup codes: shown ONCE in plain text, stored only as SHA-256. No client
-- role can read the table; the mfa-recover edge function (service role)
-- consumes a code and removes the lost authenticator.
-- ---------------------------------------------------------------------------
create table public.backup_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  code_hash  text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index backup_codes_user on public.backup_codes (user_id) where used_at is null;
alter table public.backup_codes enable row level security;
revoke all on table public.backup_codes from public, anon, authenticated;
-- no policies: definer fn + service role only

-- My own 2FA status for the settings screen (enrolled + backup codes left).
create or replace function public.get_my_security()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'mfa_enrolled', public.mfa_enrolled(auth.uid()),
    'backup_codes_left', (select count(*) from public.backup_codes
                          where user_id = auth.uid() and used_at is null),
    'mfa_required',
      exists (select 1 from public.team_members t
              where t.member_id = auth.uid() and t.status = 'accepted' and t.role = 'admin')
      or exists (select 1 from public.creator_earnings e where e.user_id = auth.uid()));
$$;


create or replace function public.generate_backup_codes()
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _codes text[] := '{}';
  _code text;
  i integer;
begin
  if not public.mfa_enrolled(auth.uid()) then
    raise exception 'Set up your authenticator app first.';
  end if;
  -- New set replaces any unused codes.
  delete from public.backup_codes where user_id = auth.uid() and used_at is null;
  for i in 1..10 loop
    _code := encode(extensions.gen_random_bytes(5), 'hex');  -- 10 hex chars
    _code := upper(left(_code, 5) || '-' || right(_code, 5));
    _codes := _codes || _code;
    insert into public.backup_codes (user_id, code_hash)
    values (auth.uid(), encode(extensions.digest(_code, 'sha256'), 'hex'));
  end loop;
  return _codes;  -- the only time the plain codes exist outside the user's hands
end;
$$;

-- ---------------------------------------------------------------------------
-- MFA required where the blast radius is big: accepting ADMIN on a team,
-- and taking money out of an earnings balance.
-- ---------------------------------------------------------------------------
create or replace function public.respond_team_invite(_business uuid, _accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if _accept then
    -- Part 14C: an admin can act on billing and the team itself, so an
    -- admin seat requires two-step login before it goes live.
    if exists (select 1 from public.team_members
               where business_id = _business and member_id = auth.uid()
                 and status = 'pending' and role = 'admin')
       and not public.mfa_enrolled(auth.uid()) then
      raise exception 'Admin seats need two-step login. Turn it on in Settings → Security first.';
    end if;
    update public.team_members
       set status = 'accepted', decided_at = now()
     where business_id = _business and member_id = auth.uid() and status = 'pending';
    if not found then raise exception 'not authorised'; end if;
  else
    delete from public.team_members
     where business_id = _business and member_id = auth.uid() and status = 'pending';
    if not found then raise exception 'not authorised'; end if;
  end if;
end;
$$;

create or replace function public.request_payout(_amount_pence integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _enabled boolean := public.setting_numeric('creator_earnings_enabled', 0) >= 1;
  _min     integer := public.setting_numeric('creator_min_payout_pence', 2000)::integer;
  _balance bigint;
  _id      uuid;
begin
  if not _enabled then
    raise exception 'Payouts are not available yet.';
  end if;
  if public.is_minor(auth.uid()) then
    raise exception 'Earnings are for over-18s.';
  end if;
  -- Part 14C: money leaves the account only behind two-step login.
  if not public.mfa_enrolled(auth.uid()) then
    raise exception 'Payouts need two-step login. Turn it on in Settings → Security first.';
  end if;
  if _amount_pence < _min then
    raise exception 'The minimum payout is % pence.', _min;
  end if;
  if not exists (select 1 from public.payout_accounts a
                 where a.user_id = auth.uid() and a.status = 'active') then
    raise exception 'Set up your payout account first.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 9));

  select coalesce((select sum(e.amount_pence) from public.creator_earnings e
                   where e.user_id = auth.uid()), 0)
       - coalesce((select sum(p.amount_pence) from public.creator_payouts p
                   where p.user_id = auth.uid()
                     and p.status in ('requested', 'paid')), 0)
    into _balance;
  if _amount_pence > _balance then
    raise exception 'That is more than your balance.';
  end if;

  insert into public.creator_payouts (user_id, amount_pence)
  values (auth.uid(), _amount_pence)
  returning id into _id;
  return _id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Login alerts: the Part 11 device registry already knows every (device,
-- account) pair. A sign-in from a device this account has never used — when
-- the account already has at least one known device — raises a 'new_login'
-- notification (pushed even in quiet hours; security never sleeps).
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update','team_invite',
    'new_login'));

create or replace function public.record_device_presence(_device_hash text, _platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _known boolean;
  _others integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if _platform not in ('ios', 'android', 'web') then
    raise exception 'bad platform';
  end if;

  select exists (select 1 from public.account_devices d
                 where d.device_hash = lower(_device_hash) and d.user_id = auth.uid()),
         (select count(*) from public.account_devices d2
          where d2.user_id = auth.uid() and d2.device_hash <> lower(_device_hash))
    into _known, _others;

  insert into public.account_devices (device_hash, user_id, platform)
  values (lower(_device_hash), auth.uid(), _platform)
  on conflict (device_hash, user_id)
  do update set last_seen = now(), platform = excluded.platform;

  if not _known and _others > 0 then
    insert into public.notifications (user_id, type, payload)
    values (auth.uid(), 'new_login',
            jsonb_build_object('platform', _platform,
                               'device_hash_prefix', left(lower(_device_hash), 8)));
  end if;
end;
$$;

revoke all on function public.mfa_enrolled(uuid) from public, anon, authenticated;
revoke all on function public.get_my_security() from public, anon, authenticated;
revoke all on function public.generate_backup_codes() from public, anon, authenticated;
grant execute on function public.get_my_security() to authenticated;
grant execute on function public.generate_backup_codes() to authenticated;
