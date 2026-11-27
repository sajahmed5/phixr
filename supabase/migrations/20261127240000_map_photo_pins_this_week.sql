-- ============================================================================
-- 20261127240000_map_photo_pins_this_week
--
-- Local map extras (Saj said build them, 2026-11-27):
--   * Photo pins: at street zoom a venue pin shows its best photo, so the map
--     reads like a gallery. get_map_pins returns `thumb_path` for venue rows —
--     the best-liked matching post's thumbnail (a storage path; the app signs
--     it like every other thumbnail). Only public, approved, non-sensitive
--     posts reach `matched`, so nothing hidden can surface as a pin photo.
--   * "This week": `_since` limits every pin to posts made after it, so a park
--     shows this season, not last summer.
-- New parameter and column, so drop + recreate. Builds before this call with
-- (_q, _category) and get the default _since (everything); the extra column
-- is ignored. Re-grant: default privileges would hand EXECUTE to anon, and
-- the revoke is load-bearing. Body otherwise identical to 20261127220000.
-- ============================================================================

drop function if exists public.get_map_pins(text, text);
create function public.get_map_pins(
  _q text default null, _category text default null, _since timestamptz default null)
returns table(
  kind text,                 -- 'venue' | 'cell' | 'venue_part' | 'cell_part'
  id text,                   -- venue uuid (venue, venue_part), or the coarse cell (cell, cell_part)
  name text,                 -- venue name, or the commonest location_label in the cell
  category_group text,       -- venues only
  lat double precision,      -- the venue's point; cells are decoded client-side
  lon double precision,
  post_count integer,
  is_business boolean,       -- a business has claimed the venue (#72 styling)
  like_rate double precision,
  distance_m double precision,
  cell text,                 -- cell: the coarse cell; venue_part / cell_part: the fine cell
  last_post_at timestamptz,  -- newest matching post (Stage 1 recency signal)
  thumb_path text            -- venue rows: the best-liked matching post's thumbnail
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
    select p.id, p.venue_id, p.location_cell, p.location_fine, p.location_label, p.created_at,
           p.thumbnail_url,
           greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) as likes,
           greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)
             + greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0) as swipes
    from public.posts p
    left join public.post_bot_counts bc on bc.post_id = p.id
    where p.visibility = 'public'
      and p.moderation_status = 'approved'
      and not p.sensitive
      and (_since is null or p.created_at >= _since)
      and ((select tsq from q) is null or p.search_vector @@ (select tsq from q))
      and public.post_in_category(p.id, _category)
      and exists (select 1 from public.profiles pra
                  where pra.id = p.user_id and pra.account_status = 'active'
                    and (pra.age_band = 'adult' or public.is_minor(auth.uid())
                         or public.setting_numeric('teen_posts_in_adult_deck', 0) = 1))
      and not exists (select 1 from public.blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                         or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
  ),
  in_range as (
    select v.id, v.name, v.category, v.lat, v.lon,
           extensions.st_distance(
             extensions.st_setsrid(extensions.st_makepoint(v.lon, v.lat), 4326)::extensions.geography,
             (select centre from me)) as dist
    from public.venues v
    where v.lat is not null and v.lon is not null
      and (select centre from me) is not null
      and v.id in (select m.venue_id from matched m where m.venue_id is not null)
  ),
  local_untagged as (
    select m.* from matched m
    where m.venue_id is null
      and m.location_cell is not null
      and m.location_cell = any(coalesce((select arr from cells), array[]::text[]))
  )
  select 'venue', v.id::text, v.name, public.venue_category_group(v.category),
         v.lat, v.lon, count(m.id)::integer,
         exists (select 1 from public.business_venues bv where bv.venue_id = v.id),
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         v.dist,
         null::text,
         max(m.created_at),
         (array_agg(m.thumbnail_url order by m.likes desc, m.created_at desc)
            filter (where m.thumbnail_url is not null))[1]
  from matched m
  join in_range v on v.id = m.venue_id
  where v.dist <= (select radius from me) * 1609.34
  group by v.id, v.name, v.category, v.lat, v.lon, v.dist
  union all
  select 'venue_part', v.id::text, v.name, public.venue_category_group(v.category),
         v.lat, v.lon, count(m.id)::integer,
         exists (select 1 from public.business_venues bv where bv.venue_id = v.id),
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         v.dist,
         m.location_fine,
         max(m.created_at),
         null::text
  from matched m
  join in_range v on v.id = m.venue_id
  where v.dist <= (select radius from me) * 1609.34
    and m.location_fine is not null
  group by v.id, v.name, v.category, v.lat, v.lon, v.dist, m.location_fine
  union all
  select 'cell', m.location_cell, (array_agg(m.location_label) filter (where m.location_label is not null))[1],
         null, null, null, count(m.id)::integer, false,
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         null, m.location_cell,
         max(m.created_at),
         null::text
  from local_untagged m
  group by m.location_cell
  union all
  select 'cell_part', m.location_cell, (array_agg(m.location_label) filter (where m.location_label is not null))[1],
         null, null, null, count(m.id)::integer, false,
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         null, m.location_fine,
         max(m.created_at),
         null::text
  from local_untagged m
  where m.location_fine is not null
  group by m.location_cell, m.location_fine
  order by 7 desc
  limit 500;
$fn$;

revoke all on function public.get_map_pins(text, text, timestamptz) from public, anon;
grant execute on function public.get_map_pins(text, text, timestamptz) to authenticated, service_role;
