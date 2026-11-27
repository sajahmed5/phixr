-- ============================================================================
-- 20261127200000_places_apple_backfill
--
-- Local map Stage 2 (plan agreed with Saj 2026-11-27): searching "restaurants"
-- shows the restaurants that exist, not only the ones with Phixr photos.
-- Place data is Apple-only from here (Maps Server API, called server-side by
-- the `places` Edge Function). Empty places render as hollow "be the first"
-- pins in the map budget's leftover slots.
--
-- 1. place_search_cache — the Edge Function's cache of raw Apple results per
--    (query, snapped viewport), so panning back and forth costs no API calls.
--    Service-only: RLS on, no policies.
-- 2. match_place_suggestions — links each suggested place to an existing
--    venue: exact (provider, place id) first, else same normalised name within
--    ~100m (the legacy Google-sourced venues have different ids). Returns the
--    venue's public post count and the place's category group, so the function
--    can filter by chip and the client can hide places already shown as photo
--    pins. Places are public business locations — no person's position here.
-- ============================================================================

create table if not exists public.place_search_cache (
  key        text primary key,
  results    jsonb not null,
  fetched_at timestamptz not null default now()
);
create index if not exists place_search_cache_fetched_at on public.place_search_cache (fetched_at);
alter table public.place_search_cache enable row level security;  -- no policies → service only

create or replace function public.match_place_suggestions(_cands jsonb)
returns table(idx integer, venue_id uuid, post_count integer, category_group text)
language sql stable security definer
set search_path = ''
as $fn$
  with c as (
    select (e.ord - 1)::integer as idx,
           e.val->>'provider' as provider,
           e.val->>'provider_place_id' as pid,
           lower(regexp_replace(coalesce(e.val->>'name', ''), '[^[:alnum:]]', '', 'g')) as norm,
           (e.val->>'lat')::double precision as lat,
           (e.val->>'lon')::double precision as lon,
           e.val->>'category' as category
    from jsonb_array_elements(_cands) with ordinality as e(val, ord)
  ),
  m as (
    select c.idx, c.category,
           (select v.id
              from public.venues v
             where (v.provider = c.provider and v.provider_place_id = c.pid)
                or (v.lat is not null and v.lon is not null
                    and abs(v.lat - c.lat) < 0.0009        -- ~100m north/south
                    and abs(v.lon - c.lon) < 0.0015        -- ~100m east/west at UK latitudes
                    and c.norm <> ''
                    and lower(regexp_replace(v.name, '[^[:alnum:]]', '', 'g')) = c.norm)
             order by (v.provider = c.provider and v.provider_place_id = c.pid) desc
             limit 1) as venue_id
    from c
  )
  select m.idx,
         m.venue_id,
         case when m.venue_id is null then 0
              else (select count(*)::integer from public.posts p
                     where p.venue_id = m.venue_id
                       and p.visibility = 'public'
                       and p.moderation_status = 'approved'
                       and not p.sensitive)
         end,
         public.venue_category_group(m.category)
  from m;
$fn$;

revoke all on function public.match_place_suggestions(jsonb) from public, anon, authenticated;
grant execute on function public.match_place_suggestions(jsonb) to service_role;

-- 3. get_my_search_centre — the caller's OWN Local search centre, so a search
--    with no photo pins yet can still open the map there (at street zoom,
--    where suggested places load) instead of a dead-end message. Only ever
--    returns the signed-in user's own row.
create or replace function public.get_my_search_centre()
returns table(lat double precision, lon double precision)
language sql stable security definer
set search_path = ''
as $fn$
  select extensions.st_y(x.c::extensions.geometry), extensions.st_x(x.c::extensions.geometry)
  from public.profiles pr
  cross join lateral (select coalesce(pr.search_center_location, pr.search_location) as c) x
  where pr.id = auth.uid() and x.c is not null;
$fn$;

revoke all on function public.get_my_search_centre() from public, anon;
grant execute on function public.get_my_search_centre() to authenticated;
