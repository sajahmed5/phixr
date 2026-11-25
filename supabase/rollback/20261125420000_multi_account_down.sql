-- Rollback for 20261125420000_multi_account.
drop function if exists public.record_device_presence(text, text);
drop table if exists public.account_devices;
-- Restore the one-account-per-token key (keeps the newest row per token).
delete from public.push_tokens pt
 where exists (select 1 from public.push_tokens pt2
               where pt2.token = pt.token and pt2.updated_at > pt.updated_at);
alter table public.push_tokens drop constraint push_tokens_pkey;
alter table public.push_tokens add primary key (token);
delete from public.platform_settings where key = 'max_linked_accounts';
