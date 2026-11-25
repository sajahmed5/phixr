-- Part 9D/9E: creator earnings — ledger, payout accounts and payout requests,
-- ALL behind the creator_earnings_enabled flag (0 until the business rules
-- and Stripe Connect keys exist). Under-18s can never earn. Every row keeps
-- what tax/accounting needs: pence amounts, VAT, timestamps, source refs.
--
-- Nothing accrues automatically yet: entries are written by fame-admin
-- (service role, audited) or by future revenue-share jobs. Clients only read
-- their own ledger and request payouts when the flag is on.

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible)
values
  ('creator_earnings_enabled', to_jsonb(0),
   'Master switch for creator earnings and payouts (0 = off).', true),
  ('creator_min_payout_pence', to_jsonb(2000),
   'Smallest payout a creator can request, in pence.', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The ledger (append-only; amounts in pence, VAT recorded alongside).
-- ---------------------------------------------------------------------------
create table public.creator_earnings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in
                ('partnership', 'ad_revenue_share', 'adjustment')),
  amount_pence integer not null,          -- positive = earned, negative = correction
  vat_pence    integer not null default 0,
  currency     text not null default 'GBP',
  post_id      uuid references public.posts (id) on delete set null,
  ad_id        uuid references public.ads (id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);
create index creator_earnings_user on public.creator_earnings (user_id, created_at desc);

alter table public.creator_earnings enable row level security;
revoke all on table public.creator_earnings from public, anon, authenticated;
grant select on table public.creator_earnings to authenticated;
create policy creator_earnings_select on public.creator_earnings
  for select to authenticated using (user_id = auth.uid());
-- No client writes: entries come from the service role only.

-- ---------------------------------------------------------------------------
-- 3. Payout accounts (Stripe Connect onboarding lands here later) + payouts.
-- ---------------------------------------------------------------------------
create table public.payout_accounts (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  provider            text not null default 'stripe_connect',
  provider_account_id text,
  status              text not null default 'onboarding'
                      check (status in ('onboarding', 'active', 'disabled')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;
revoke all on table public.payout_accounts from public, anon, authenticated;
grant select on table public.payout_accounts to authenticated;
create policy payout_accounts_select on public.payout_accounts
  for select to authenticated using (user_id = auth.uid());

create table public.creator_payouts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  amount_pence integer not null check (amount_pence > 0),
  status       text not null default 'requested'
               check (status in ('requested', 'paid', 'failed', 'cancelled')),
  provider_ref text,
  requested_at timestamptz not null default now(),
  settled_at   timestamptz
);
create index creator_payouts_user on public.creator_payouts (user_id, requested_at desc);
alter table public.creator_payouts enable row level security;
revoke all on table public.creator_payouts from public, anon, authenticated;
grant select on table public.creator_payouts to authenticated;
create policy creator_payouts_select on public.creator_payouts
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Client functions (flag-gated, 18+).
-- ---------------------------------------------------------------------------
create or replace function public.get_my_earnings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _enabled  boolean := public.setting_numeric('creator_earnings_enabled', 0) >= 1;
  _earned   bigint;
  _paid     bigint;
  _pending  bigint;
  _entries  jsonb;
begin
  if public.is_minor(auth.uid()) then
    raise exception 'Earnings are for over-18s.';
  end if;

  select coalesce(sum(e.amount_pence), 0) into _earned
  from public.creator_earnings e where e.user_id = auth.uid();

  select coalesce(sum(p.amount_pence) filter (where p.status = 'paid'), 0),
         coalesce(sum(p.amount_pence) filter (where p.status = 'requested'), 0)
    into _paid, _pending
  from public.creator_payouts p where p.user_id = auth.uid();

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'kind', e.kind, 'amount_pence', e.amount_pence,
           'vat_pence', e.vat_pence, 'note', e.note,
           'created_at', e.created_at) order by e.created_at desc), '[]'::jsonb)
    into _entries
  from (select * from public.creator_earnings e2
        where e2.user_id = auth.uid()
        order by e2.created_at desc limit 100) e;

  return jsonb_build_object(
    'enabled', _enabled,
    'balance_pence', _earned - _paid - _pending,
    'lifetime_pence', _earned,
    'pending_payout_pence', _pending,
    'min_payout_pence', public.setting_numeric('creator_min_payout_pence', 2000)::integer,
    'payouts_live', false,   -- flips when Stripe Connect keys arrive
    'entries', _entries);
end;
$$;

create or replace function public.request_payout(_amount_pence integer)
returns uuid
language plpgsql
volatile
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

  -- Serialise per-user payout requests so two can't both pass the balance
  -- check: take a per-user advisory lock for this transaction.
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
-- 5. Admin: record an earning (service role only — fame-admin, audited there).
--    The single writer keeps the ledger append-only and attributable.
-- ---------------------------------------------------------------------------
create or replace function public.admin_record_earning(
  _user_id uuid,
  _kind text,
  _amount_pence integer,
  _vat_pence integer default 0,
  _post_id uuid default null,
  _note text default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _id uuid;
begin
  if public.is_minor(_user_id) then
    raise exception 'under-18s cannot earn';
  end if;
  if _amount_pence = 0 then
    raise exception 'amount must be non-zero';
  end if;
  insert into public.creator_earnings
    (user_id, kind, amount_pence, vat_pence, post_id, note)
  values (_user_id, _kind, _amount_pence, _vat_pence, _post_id, _note)
  returning id into _id;
  return _id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.get_my_earnings() from public, anon, authenticated;
revoke all on function public.request_payout(integer) from public, anon, authenticated;
revoke all on function public.admin_record_earning(uuid, text, integer, integer, uuid, text)
  from public, anon, authenticated;

grant execute on function public.get_my_earnings() to authenticated;
grant execute on function public.request_payout(integer) to authenticated;
grant execute on function public.admin_record_earning(uuid, text, integer, integer, uuid, text)
  to service_role;
