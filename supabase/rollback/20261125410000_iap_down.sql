-- Rollback for 20261125410000_iap.
drop function if exists public.create_boost_from_iap(uuid, uuid, integer, text[], text, uuid[], text, text, text, integer, text, jsonb);
drop table if exists public.iap_receipts;
delete from public.platform_settings where key = 'iap_enabled';
