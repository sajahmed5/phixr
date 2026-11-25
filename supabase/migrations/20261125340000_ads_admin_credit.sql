-- Part 8 (admin): manual advertiser credit, until Stripe top-ups arrive.
--
-- fame-admin (service role) is the ONLY caller. A single function keeps the
-- two writes atomic — the balance increment and the ledger row — so a credit
-- can never race the ads-billing cron into a lost update. Clients never see
-- it: EXECUTE is revoked from public/anon/authenticated (Supabase default
-- privileges would otherwise grant it — the grants trap).

create or replace function public.admin_credit_ad_account(
  _user_id uuid,
  _pence   integer,
  _note    text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if _pence is null or _pence <= 0 then
    raise exception 'credit must be a positive number of pence';
  end if;

  update public.ad_accounts
     set balance_pence = balance_pence + _pence
   where user_id = _user_id;
  if not found then
    raise exception 'no ad account for that user';
  end if;

  insert into public.ad_charges (account_id, kind, qty, amount_pence, note)
  values (_user_id, 'credit', 1, _pence, _note);
end;
$$;

revoke execute on function public.admin_credit_ad_account(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.admin_credit_ad_account(uuid, integer, text)
  to service_role;
