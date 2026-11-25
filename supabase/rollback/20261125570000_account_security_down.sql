-- Rollback for 20261125570000_account_security.
-- DROPS DATA (flagged per Part 0): backup codes are discarded. Restores the
-- pre-14C respond_team_invite / request_payout / record_device_presence
-- (no MFA gates, no login alerts) and removes the new_login type.

drop function if exists public.generate_backup_codes();
drop function if exists public.get_my_security();
drop table if exists public.backup_codes;

create or replace function public.respond_team_invite(_business uuid, _accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if _accept then
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

create or replace function public.record_device_presence(_device_hash text, _platform text)
returns void
language plpgsql
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

drop function if exists public.mfa_enrolled(uuid);

delete from public.notifications where type = 'new_login';
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update','team_invite'));
