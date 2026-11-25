-- Rollback for 20261125490000_business_extras.
-- DROPS DATA (flagged per Part 0): offers, insight events, and any saved
-- business hours / menu / booking links are discarded.

drop function if exists public.get_business_insights(uuid, integer);
drop function if exists public.record_business_insight(uuid, text);
drop table if exists public.business_insight_events;

drop function if exists public.get_business_extras(uuid);
drop function if exists public.get_venue_business(uuid);
drop function if exists public.get_business_offers(uuid);
drop function if exists public.end_offer(uuid);
drop function if exists public.create_offer(uuid, text, text, timestamptz);
drop table if exists public.offers;

drop function if exists public.set_business_details(uuid, jsonb, text, text);
drop function if exists public._check_business_link(text);

alter table public.profiles
  drop column if exists booking_url,
  drop column if exists menu_url,
  drop column if exists business_hours;

delete from public.platform_settings where key = 'business_offers_max_active';
