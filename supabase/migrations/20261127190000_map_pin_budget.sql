-- ============================================================================
-- 20261127190000_map_pin_budget
--
-- Local map Stage 1 (plan agreed 2026-11-27): the map gets a strict per-
-- viewport pin budget (~20), ranked by a PURELY USER-DRIVEN popularity blend —
-- post count, like rate, and recency of the venue's newest matching post.
-- Explicitly no bonus for the venue owner's own app activity.
--
-- The budget itself is allocated CLIENT-side (it re-allocates every pan/zoom,
-- so the server can't pick the 20). This migration only adds the two signals
-- the client is missing:
--
-- 1. get_map_pins gains last_post_at — when the venue's newest matching post
--    was made (the recency input). Appended as the last column, so the shipped
--    app keeps working.
-- 2. get_sponsored_results gains venue_lat/venue_lon — a sponsored placement
--    is the map's only guaranteed slot (max 2, always labelled), and a venue
--    with no posts matching the query has no organic pin to borrow coords
--    from. Venue coordinates are public business locations, never a person's.
--
-- Both return shapes change, so drop + recreate — and re-grant (default
-- privileges would hand EXECUTE to anon; the revokes are load-bearing).
-- ============================================================================

-- 1 ─ get_map_pins + last_post_at. Body otherwise identical to
--     20261127110000_local_search_rework.
drop function if exists public.get_map_pins(text, text);
create function public.get_map_pins(_q text default null, _category text default null)
returns table(
  kind text,                 -- 'venue' | 'cell'
  id text,                   -- venue uuid, or the cell string
  name text,                 -- venue name, or the commonest location_label in the cell
  category_group text,       -- venues only
  lat double precision,      -- venues only; cells are decoded client-side
  lon double precision,
  post_count integer,
  is_business boolean,       -- a business has claimed the venue (#72 styling)
  like_rate double precision,
  distance_m double precision,
  cell text,
  last_post_at timestamptz   -- newest matching post (Stage 1 recency signal)
) language sql stable security definer
set search_path = ''
as $fn$
  with me as (
    select coalesce(pr.search_center_location, pr.search_location) as centre,
           pr.search_radius_miles as radius
    from public.profiles pr where pr.id = auth.uid()
  ),
  cells as (
    select public.local_cells(
      extensions.st_y(centre::extensions.geometry),
      extensions.st_x(centre::extensions.geometry),
      radius * 1609.34) as arr
    from me where centre is not null
  ),
  q as (
    select case when coalesce(btrim(_q), '') = '' then null
                else websearch_to_tsquery('english', _q) end as tsq
  ),
  matched as (
    select p.id, p.venue_id, p.location_cell, p.location_label, p.created_at,
           greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) as likes,
           greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)
             + greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0) as swipes
    from public.posts p
    left join public.post_bot_counts bc on bc.post_id = p.id
    where p.visibility = 'public'
      and p.moderation_status = 'approved'
      and not p.sensitive
      and ((select tsq from q) is null or p.search_vector @@ (select tsq from q))
      and public.post_in_category(p.id, _category)
      and exists (select 1 from public.profiles pra
                  where pra.id = p.user_id and pra.account_status = 'active'
                    and (pra.age_band = 'adult' or public.is_minor(auth.uid())
                         or public.setting_numeric('teen_posts_in_adult_deck', 0) = 1))
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                         or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
  )
  select 'venue', v.id::text, v.name, public.venue_category_group(v.category),
         v.lat, v.lon, count(m.id)::integer,
         exists (select 1 from public.business_venues bv where bv.venue_id = v.id),
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         extensions.st_distance(
           extensions.st_setsrid(extensions.st_makepoint(v.lon, v.lat), 4326)::extensions.geography,
           (select centre from me)),
         null::text,
         max(m.created_at)
  from matched m
  join public.venues v on v.id = m.venue_id
  where v.lat is not null and v.lon is not null
    and (select centre from me) is not null
    and extensions.st_distance(
          extensions.st_setsrid(extensions.st_makepoint(v.lon, v.lat), 4326)::extensions.geography,
          (select centre from me)) <= (select radius from me) * 1609.34
  group by v.id, v.name, v.category, v.lat, v.lon
  union all
  select 'cell', m.location_cell, (array_agg(m.location_label) filter (where m.location_label is not null))[1],
         null, null, null, count(m.id)::integer, false,
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         null, m.location_cell,
         max(m.created_at)
  from matched m
  where m.venue_id is null
    and m.location_cell is not null
    and m.location_cell = any(coalesce((select arr from cells), array[]::text[]))
  group by m.location_cell
  order by 7 desc
  limit 300;
$fn$;

revoke all on function public.get_map_pins(text, text) from public, anon;
grant execute on function public.get_map_pins(text, text) to authenticated, service_role;

-- 2 ─ get_sponsored_results + venue_lat/venue_lon. Body otherwise identical to
--     20261125300000_sponsored_map (impression counting included).
drop function if exists public.get_sponsored_results(text);
create function public.get_sponsored_results(_q text)
returns table (
  id uuid, business_id uuid, business_handle text, venue_id uuid,
  venue_name text, venue_category text, distance_m double precision,
  venue_lat double precision, venue_lon double precision
)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  _max integer := public.setting_numeric('max_sponsored_search_results', 2)::integer;
  _extra numeric := public.setting_numeric('sponsored_radius_extra_miles', 10);
begin
  return query
  with me as (
    select coalesce(pr.search_center_location, pr.search_location) as centre,
           pr.search_radius_miles as radius
    from public.profiles pr where pr.id = auth.uid()
  ),
  hits as (
    select s.id, s.business_id, s.venue_id, v.name, v.category, v.lat, v.lon,
           extensions.st_distance(
             extensions.st_setsrid(extensions.st_makepoint(v.lon, v.lat), 4326)::extensions.geography,
             (select centre from me)) as dist
    from public.sponsored_search s
    join public.venues v on v.id = s.venue_id
    where s.status = 'active'
      and now() >= s.starts_at and now() < s.ends_at
      and (select centre from me) is not null
      and coalesce(btrim(_q), '') <> ''
      and (
        exists (select 1 from unnest(s.keywords) kw where _q ilike '%' || kw || '%')
        or v.name ilike '%' || btrim(_q) || '%'
        or public.venue_category_group(v.category) = lower(btrim(_q))
        or coalesce(v.category, '') ilike '%' || btrim(_q) || '%'
      )
  ),
  chosen as (
    select h.* from hits h
    where h.dist <= ((select radius from me) + _extra) * 1609.34
    order by h.dist asc
    limit _max
  )
  select c.id, c.business_id, pr.handle, c.venue_id, c.name, c.category, c.dist,
         c.lat, c.lon
  from chosen c
  join public.profiles pr on pr.id = c.business_id;

  -- Count what was just served (same selection, same limits).
  update public.sponsored_search s
     set impressions = s.impressions + 1
   where s.id in (
     with me as (
       select coalesce(pr.search_center_location, pr.search_location) as centre,
              pr.search_radius_miles as radius
       from public.profiles pr where pr.id = auth.uid()
     ),
     hits as (
       select s2.id,
              extensions.st_distance(
                extensions.st_setsrid(extensions.st_makepoint(v.lon, v.lat), 4326)::extensions.geography,
                (select centre from me)) as dist
       from public.sponsored_search s2
       join public.venues v on v.id = s2.venue_id
       where s2.status = 'active'
         and now() >= s2.starts_at and now() < s2.ends_at
         and (select centre from me) is not null
         and coalesce(btrim(_q), '') <> ''
         and (
           exists (select 1 from unnest(s2.keywords) kw where _q ilike '%' || kw || '%')
           or v.name ilike '%' || btrim(_q) || '%'
           or public.venue_category_group(v.category) = lower(btrim(_q))
           or coalesce(v.category, '') ilike '%' || btrim(_q) || '%'
         )
     )
     select h.id from hits h
     where h.dist <= ((select radius from me) + _extra) * 1609.34
     order by h.dist asc
     limit _max
   );
end;
$fn$;
revoke all on function public.get_sponsored_results(text) from public, anon;
grant execute on function public.get_sponsored_results(text) to authenticated;
