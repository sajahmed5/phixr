-- Rollback for 20261125300000_sponsored_map.

set search_path = public, extensions;

drop function if exists public.get_venue_posts(uuid, integer);
drop function if exists public.get_map_venues(integer);
drop function if exists public.record_sponsored_click(uuid);
drop function if exists public.get_sponsored_results(text);
drop table if exists public.sponsored_search;
delete from public.platform_settings where key = 'sponsored_radius_extra_miles';
