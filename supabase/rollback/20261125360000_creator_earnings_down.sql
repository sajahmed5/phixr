-- Rollback for 20261125360000_creator_earnings.
drop function if exists public.admin_record_earning(uuid, text, integer, integer, uuid, text);
drop function if exists public.request_payout(integer);
drop function if exists public.get_my_earnings();
drop table if exists public.creator_payouts;
drop table if exists public.payout_accounts;
drop table if exists public.creator_earnings;
delete from public.platform_settings
 where key in ('creator_earnings_enabled', 'creator_min_payout_pence');
