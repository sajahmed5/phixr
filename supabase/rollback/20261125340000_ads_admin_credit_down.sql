-- Rollback for 20261125340000_ads_admin_credit.
drop function if exists public.admin_credit_ad_account(uuid, integer, text);
