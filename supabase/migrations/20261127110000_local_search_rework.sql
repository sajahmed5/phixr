-- ============================================================================
-- 20261127110000_local_search_rework
--
-- Feedback #69/#71/#72/#73 (approved 2026-11-27): Local search is about real
-- people's located pictures — customers' photos of a place matter as much as
-- the business's own, and places not on Instagram/Google ("hidden gems") are
-- discovered because someone tagged them in an image.
--
-- 1. venue_category_group learns Google Places (New) types — coffee_shop fell
--    through to 'other', so Aunty Ji's café was invisible to every chip (#69).
-- 2. The category chips now also match POST TAGS: a #food photo at an
--    uncategorised venue (or no venue at all) still counts as Food.
-- 3. get_map_pins replaces the venues-only map feed: venue pins count only
--    posts matching the live query/chip (#71 — and its inverse: Aunty Ji's no
--    longer pins on a "dog" search), plus coarse CELL cluster pins for located
--    posts with no venue. Cells are ~1km, so nobody's exact position leaks.
-- 4. get_cell_posts backs the tap-a-cluster photo sheet.
-- 5. search_posts_local gains venue_id + venue_is_business for the
--    venue-grouped results (#73) and adopts the tag-aware category match.
--
-- Map surfaces stay PUBLIC-posts-only: follower-only posts never pin.
-- ============================================================================

-- 1 ─ category groups, extended. Order matters: drink before the '%shop%'
--     fallback so coffee_shop lands in drink, and parking must not match the
--     '_park' suffix rule.
create or replace function public.venue_category_group(_category text)
returns text language sql immutable
set search_path = ''
as $fn$
  select case
    when _category in ('cafe','coffee_shop','tea_house','bar','pub','night_club','wine_bar',
                       'juice_shop','bubble_tea_store','brewery','winery') then 'drink'
    when _category in ('restaurant','meal_takeaway','meal_delivery','bakery','food','deli',
                       'food_court','ice_cream_shop','dessert_shop','sandwich_shop',
                       'fast_food_restaurant','catering_service')
         or _category like '%restaurant%' then 'food'
    when _category in ('store','shopping_mall','supermarket','convenience_store','market',
                       'grocery_store','florist','pet_store')
         or _category like '%#_store' escape '#'
         or _category like '%#_shop' escape '#' then 'shops'
    when _category in ('park','museum','art_gallery','gym','movie_theater','bowling_alley',
                       'amusement_park','zoo','aquarium','stadium','tourist_attraction','spa',
                       'hiking_area','event_venue','playground','botanical_garden')
         or _category like '%#_park' escape '#'
         or _category like '%attraction%' then 'todo'
    else 'other'
  end;
$fn$;

-- 2 ─ tags that place a post in a chip group even without a categorised venue.
create or replace function public.category_group_tags(_group text)
returns text[] language sql immutable
set search_path = ''
as $fn$
  select case _group
    when 'food' then array['food','foodie','brunch','breakfast','lunch','dinner','dessert',
                           'cake','baking','curry','pizza','burger','streetfood','snack',
                           'snacks','eggs','fried food','cooking']
    when 'drink' then array['drink','drinks','coffee','latte','tea','cocktail','cocktails',
                            'beer','wine','juice','smoothie','boba','matcha']
    when 'shops' then array['shopping','shop','shops','fashion','clothes','thrift','market','retail']
    when 'todo' then array['thingstodo','park','museum','gallery','gym','hike','hiking',
                           'walk','event','events','festival','attraction','daysout']
    else array[]::text[]
  end;
$fn$;

/** Does this post belong under the chip? Venue category OR its own tags. */
create or replace function public.post_in_category(_post_id uuid, _category text)
returns boolean language sql stable
set search_path = ''
as $fn$
  select _category is null
    or exists (select 1 from public.posts p
               join public.venues v on v.id = p.venue_id
               where p.id = _post_id
                 and public.venue_category_group(v.category) = _category)
    or exists (select 1 from public.post_tags pt
               join public.tags t on t.id = pt.tag_id
               where pt.post_id = _post_id
                 and t.name = any(public.category_group_tags(_category)));
$fn$;

revoke all on function public.category_group_tags(text) from public, anon;
revoke all on function public.post_in_category(uuid, text) from public, anon;
grant execute on function public.category_group_tags(text) to authenticated, service_role;
grant execute on function public.post_in_category(uuid, text) to authenticated, service_role;

-- 3 ─ the map feed. One call per (query, chip): labelled venue pins with
--     MATCHING-post counts, and venueless matches as coarse cell clusters.
--     The client decodes the cell's geohash to place the cluster.
create or replace function public.get_map_pins(_q text default null, _category text default null)
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
  cell text
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
    select p.id, p.venue_id, p.location_cell, p.location_label,
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
         null::text
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
         null, m.location_cell
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

-- 4 ─ photos behind a cluster pin, same gates, venueless by construction.
create or replace function public.get_cell_posts(
  _cell text, _q text default null, _category text default null, _limit integer default 12)
returns table(id uuid, thumbnail_url text, media_type text, like_count integer, location_label text)
language sql stable security definer
set search_path = ''
as $fn$
  with q as (
    select case when coalesce(btrim(_q), '') = '' then null
                else websearch_to_tsquery('english', _q) end as tsq
  )
  select p.id, p.thumbnail_url, p.media_type,
         greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)::integer,
         p.location_label
  from public.posts p
  left join public.post_bot_counts bc on bc.post_id = p.id
  where p.location_cell = _cell
    and p.venue_id is null
    and p.visibility = 'public'
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
  order by greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) desc, p.created_at desc
  limit greatest(_limit, 0);
$fn$;

revoke all on function public.get_cell_posts(text, text, text, integer) from public, anon;
grant execute on function public.get_cell_posts(text, text, text, integer) to authenticated, service_role;

-- 5 ─ search_posts_local: + venue_id / venue_is_business (for venue-grouped
--     results) and the tag-aware category clause. Return shape changes, so
--     drop + recreate — and re-grant (default privileges would hand EXECUTE
--     to anon; the revoke below is load-bearing, verify live).
drop function if exists public.search_posts_local(text, integer, integer, text);
create function public.search_posts_local(
  _q text, _limit integer default 24, _offset integer default 0, _category text default null)
returns table(
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text,
  caption text, alt_text text, like_count integer, skip_count integer,
  comment_count integer, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text,
  tags text[], distance_m double precision, venue_name text,
  venue_id uuid, venue_is_business boolean, location_label text
) language sql stable security definer
set search_path = ''
as $fn$
  with me as (
    select coalesce(search_center_location, search_location) as centre, search_radius_miles as radius
    from public.profiles where id = auth.uid()
  ),
  cells as (
    select public.local_cells(
      extensions.st_y(centre::extensions.geometry),
      extensions.st_x(centre::extensions.geometry),
      radius * 1609.34) as arr
    from me where centre is not null
  ),
  q as (select websearch_to_tsquery('english', coalesce(_q, '')) as tsq),
  matched as (
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at,
           (greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) + 1.0)
             / (greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)
              + greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0) + 2.0) as quality,
           coalesce(
             (select extensions.st_distance(
                       extensions.st_setsrid(extensions.st_makepoint(v.lon, v.lat), 4326)::extensions.geography,
                       (select centre from me))
              from public.venues v where v.id = p.venue_id),
             (select min(extensions.st_distance(
                       extensions.st_setsrid(extensions.st_makepoint(v2.lon, v2.lat), 4326)::extensions.geography,
                       (select centre from me)))
              from public.business_venues bv
              join public.venues v2 on v2.id = bv.venue_id
              where bv.business_id = p.user_id)
           ) as distance_m,
           coalesce(
             (select v.name from public.venues v where v.id = p.venue_id),
             (select v2.name from public.business_venues bv
              join public.venues v2 on v2.id = bv.venue_id
              where bv.business_id = p.user_id
              order by extensions.st_distance(
                extensions.st_setsrid(extensions.st_makepoint(v2.lon, v2.lat), 4326)::extensions.geography,
                (select centre from me)) asc
              limit 1)
           ) as venue_name
    from public.posts p
    left join public.post_bot_counts bc on bc.post_id = p.id
    where (select tsq from q) is not null
      and p.search_vector @@ (select tsq from q)
      and p.location_cell is not null
      and p.location_cell = any(coalesce((select arr from cells), array[]::text[]))
      and p.moderation_status = 'approved'
      and not p.sensitive
      and public.post_in_category(p.id, _category)
      and (
        p.visibility = 'public'
        or p.user_id = auth.uid()
        or exists (select 1 from public.follows f
                   where f.follower_id = auth.uid() and f.followee_id = p.user_id and f.status = 'accepted')
      )
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                         or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
      and exists (select 1 from public.profiles pr where pr.id = p.user_id and pr.account_status = 'active')
  )
  select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption, p.alt_text,
    p.like_count, p.skip_count, p.comment_count, p.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}'),
    m.distance_m, m.venue_name,
    p.venue_id,
    exists (select 1 from public.business_venues bv where bv.venue_id = p.venue_id),
    p.location_label
  from matched m
  join public.posts p on p.id = m.id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags t on t.id = pt.tag_id
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, m.rank, m.quality, m.distance_m, m.venue_name
  order by m.rank desc, m.quality desc, m.distance_m asc nulls last, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;

revoke all on function public.search_posts_local(text, integer, integer, text) from public, anon;
grant execute on function public.search_posts_local(text, integer, integer, text) to authenticated, service_role;
