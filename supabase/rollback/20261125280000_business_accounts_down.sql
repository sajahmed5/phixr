-- Rollback for 20261125280000_business_accounts.
-- Roll back 20261125290000 FIRST (its search fns reference business_venues).

set search_path = public, extensions;

drop trigger if exists aa_posts_business_venue on public.posts;
drop function if exists public.tg_posts_business_venue();
drop function if exists public.unclaim_venue(uuid);
drop function if exists public.claim_venue(uuid);
drop table if exists public.business_venues;
drop function if exists public.set_account_type(text);
alter table public.profiles drop column if exists account_type;
