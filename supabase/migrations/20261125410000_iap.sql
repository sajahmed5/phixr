-- Part 10 (store readiness): in-app purchases for boosts.
--
-- The Part 5 boosts schema carried money_pence/provider from day one; this
-- adds the receipt ledger and the money-paid boost creator. The CLIENT never
-- creates a paid boost: the iap-validate edge function verifies the receipt
-- with Apple/Google (keys via env; the function refuses cleanly until they
-- are set) and then calls create_boost_from_iap with the SERVICE role.
-- `iap_enabled` (client-visible, 0) hides the purchase UI until Saj has
-- created the products in App Store Connect / Play Console and set the keys.
--
-- Product IDs (consumables, created by Saj in both stores):
--   phixr.boost.1day / phixr.boost.3day / phixr.boost.7day

insert into public.platform_settings (key, value, description, client_visible)
values ('iap_enabled', to_jsonb(0),
        'Show in-app purchase options for boosts (0 until store products + validation keys exist).', true)
on conflict (key) do nothing;

-- 9E/tax: every store transaction kept verbatim — amounts, provider,
-- timestamps — alongside the boost it bought.
create table public.iap_receipts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  provider       text not null check (provider in ('apple', 'google')),
  product_id     text not null,
  transaction_id text not null unique,     -- replay protection
  amount_pence   integer,                  -- as reported by the store, if known
  currency       text,
  boost_id       uuid references public.boosts (id) on delete set null,
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index iap_receipts_user on public.iap_receipts (user_id, created_at desc);
alter table public.iap_receipts enable row level security;
revoke all on table public.iap_receipts from public, anon, authenticated;
grant select on table public.iap_receipts to authenticated;
create policy iap_receipts_select on public.iap_receipts
  for select to authenticated using (user_id = auth.uid());

-- The money-paid twin of create_boost: identical eligibility rules, no
-- points charge. SERVICE ROLE ONLY — reached exclusively through the
-- receipt-validated edge function.
create or replace function public.create_boost_from_iap(
  _user_id uuid,
  _post_id uuid,
  _days integer,
  _age_bands text[],
  _region_label text,
  _tag_ids uuid[],
  _provider text,
  _transaction_id text,
  _product_id text,
  _amount_pence integer default null,
  _currency text default null,
  _raw jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  _max_days integer := public.setting_numeric('boost_max_days', 7)::integer;
  _id uuid;
begin
  if _provider not in ('apple', 'google') then
    raise exception 'create_boost_from_iap: bad provider';
  end if;
  if _days < 1 or _days > _max_days then
    raise exception 'create_boost_from_iap: days must be between 1 and %', _max_days;
  end if;
  if exists (select 1 from public.profiles pr where pr.id = _user_id and pr.age_band = 'minor') then
    raise exception 'create_boost_from_iap: not available for under-18 accounts';
  end if;
  if not exists (
    select 1 from public.posts p
    where p.id = _post_id and p.user_id = _user_id
      and p.visibility = 'public' and p.moderation_status = 'approved'
  ) then
    raise exception 'create_boost_from_iap: post not eligible';
  end if;
  if exists (select 1 from public.boosts b
             where b.post_id = _post_id and b.status = 'active' and b.ends_at > now()) then
    raise exception 'create_boost_from_iap: post already boosted';
  end if;
  if exists (select 1 from unnest(_age_bands) ab
             where ab not in ('18-24','25-34','35-44','45-54','55+')) then
    raise exception 'create_boost_from_iap: bad age band';
  end if;

  -- Replay protection: one boost per store transaction, atomically.
  begin
    insert into public.iap_receipts (user_id, provider, product_id, transaction_id,
                                     amount_pence, currency, raw)
    values (_user_id, _provider, _product_id, _transaction_id, _amount_pence, _currency, _raw);
  exception when unique_violation then
    raise exception 'create_boost_from_iap: transaction already redeemed';
  end;

  insert into public.boosts (post_id, owner_id, age_bands, region_label, tag_ids,
                             ends_at, days, points_cost, money_pence, provider)
  values (_post_id, _user_id, coalesce(_age_bands, '{}'),
          nullif(btrim(coalesce(_region_label, '')), ''),
          coalesce(_tag_ids, '{}'), now() + make_interval(days => _days), _days,
          0, coalesce(_amount_pence, 0), _provider)
  returning id into _id;

  update public.iap_receipts set boost_id = _id where transaction_id = _transaction_id;
  return _id;
end;
$fn$;

revoke all on function public.create_boost_from_iap(uuid, uuid, integer, text[], text, uuid[], text, text, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_boost_from_iap(uuid, uuid, integer, text[], text, uuid[], text, text, text, integer, text, jsonb)
  to service_role;
