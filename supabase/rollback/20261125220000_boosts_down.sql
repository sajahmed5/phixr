-- Rollback for 20261125220000_boosts.
-- NOTE: roll back 20261125230000_deck_boost_slot FIRST (its get_deck /
-- record_view_events reference the boosts table). Points already spent or
-- refunded stay in the ledger (data, not schema).

set search_path = public, extensions;

select cron.unschedule('boosts-expire')
where exists (select 1 from cron.job where jobname = 'boosts-expire');

drop function if exists public.end_expired_boosts();
drop function if exists public.get_my_boosts(integer);
drop function if exists public.cancel_boost(uuid);
drop function if exists public.create_boost(uuid, integer, text[], text, uuid[]);
drop function if exists public.estimate_boost_reach(text[], text, uuid[]);
drop table if exists public.boosts;

delete from public.platform_settings where key in (
  'boost_points_per_day', 'boost_max_days', 'boost_slot_one_in', 'boost_est_reach_share');
