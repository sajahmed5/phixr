-- ============================================================================
-- 20261127210000_location_precision_tiers
--
-- Local map Stage 3 (plan agreed with Saj 2026-11-27): "zoom into the park
-- and see photos from different parts of it". A post tagged to a venue can
-- carry a ~300m FINE cell from the photo's own GPS, so a big venue (a park)
-- splits into areas when you zoom in, the Apple Photos way.
--
-- Guardrails, stricter than the plan's first draft on purpose:
--   * Only venue-tagged posts get a fine cell, and only when the photo's GPS
--     falls INSIDE that venue's area. Otherwise a photo taken at home and
--     tagged "Heaton Park" would publish the home's 300m area. Untagged posts
--     keep the ~5km cell (they now only come from picking a city/area, where
--     the poster chose vagueness).
--   * Written only by the `places` Edge Function (service role), which checks
--     the cell against the venue's stored extent. No client grant on the
--     column; the trigger below also clears it for minors, for posts without
--     a venue or location, and when the venue changes without a new cell.
--   * The cell is a fixed ~300m grid square ('f300:<row>:<col>'), never a
--     coordinate; the photo's raw GPS never leaves the phone.
-- ============================================================================

-- 1 ─ the fine cell on posts (no grant: service role only).
alter table public.posts add column if not exists location_fine text
  check (location_fine is null or location_fine ~ '^f300:-?[0-9]{1,6}:-?[0-9]{1,6}$');
create index if not exists posts_venue_fine on public.posts (venue_id, location_fine)
  where location_fine is not null;

create or replace function public.tg_posts_fine_cell_gate()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if new.location_fine is not null and (
       new.venue_id is null
       or new.location_cell is null
       or (select age_band from public.profiles where id = new.user_id) = 'minor'
       or (tg_op = 'UPDATE'
           and new.venue_id is distinct from old.venue_id
           and new.location_fine is not distinct from old.location_fine)
     ) then
    new.location_fine := null;
  end if;
  return new;
end;
$fn$;
drop trigger if exists posts_fine_cell_gate on public.posts;
create trigger posts_fine_cell_gate
  before insert or update of venue_id, location_cell, location_fine on public.posts
  for each row execute function public.tg_posts_fine_cell_gate();

-- 2 ─ a venue's real area (Apple's displayMapRegion), for the inside-the-venue
--     check. Public place geometry, like the venue's point.
alter table public.venues
  add column if not exists extent_north double precision,
  add column if not exists extent_south double precision,
  add column if not exists extent_east  double precision,
  add column if not exists extent_west  double precision;

-- 3 ─ get_map_pins + 'venue_part' rows: a venue's matching posts grouped by
--     fine cell (`cell` = the f300 cell; the client places it). Same columns,
--     so CREATE OR REPLACE keeps the grants, and builds before Stage 3 simply
--     ignore the new kind. Body otherwise identical to 20261127190000.
create or replace function public.get_map_pins(_q text default null, _category text default null)
returns table(
  kind text,                 -- 'venue' | 'cell' | 'venue_part'
  id text,                   -- venue uuid (venue, venue_part), or the cell string
  name text,                 -- venue name, or the commonest location_label in the cell
  category_group text,       -- venues only
  lat double precision,      -- the venue's point; cells are decoded client-side
  lon double precision,
  post_count integer,
  is_business boolean,       -- a business has claimed the venue (#72 styling)
  like_rate double precision,
  distance_m double precision,
  cell text,                 -- cell pins: the coarse cell; venue_part: the fine cell
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
    select p.id, p.venue_id, p.location_cell, p.location_fine, p.location_label, p.created_at,
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
  )
  select 'venue', v.id::text, v.name, public.venue_category_group(v.category),
         v.lat, v.lon, count(m.id)::integer,
         exists (select 1 from public.business_venues bv where bv.venue_id = v.id),
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         v.dist,
         null::text,
         max(m.created_at)
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
         max(m.created_at)
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
         max(m.created_at)
  from matched m
  where m.venue_id is null
    and m.location_cell is not null
    and m.location_cell = any(coalesce((select arr from cells), array[]::text[]))
  group by m.location_cell
  order by 7 desc
  limit 400;
$fn$;

-- 4 ─ get_place_posts: with BOTH a venue and a cell, the posts in that part of
--     the venue (the cell is then a fine cell). Venue-only and cell-only calls
--     behave exactly as before (20261127120000).
create or replace function public.get_place_posts(
  _venue_id uuid default null, _cell text default null,
  _limit integer default 60, _offset integer default 0)
returns table(id uuid, user_id uuid, thumbnail_url text, media_type text, like_count integer, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $fn$
  select p.id, p.user_id, p.thumbnail_url, p.media_type,
         greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)::integer,
         p.created_at
  from public.posts p
  left join public.post_bot_counts bc on bc.post_id = p.id
  where ((_venue_id is not null and p.venue_id = _venue_id
          and (_cell is null or p.location_fine = _cell))
      or (_venue_id is null and _cell is not null and p.location_cell = _cell))
    and p.visibility = 'public'
    and p.moderation_status = 'approved'
    and not p.sensitive
    and exists (select 1 from public.profiles pra
                where pra.id = p.user_id and pra.account_status = 'active'
                  and (pra.age_band = 'adult' or public.is_minor(auth.uid())
                       or public.setting_numeric('teen_posts_in_adult_deck', 0) = 1))
    and not exists (select 1 from public.blocks b
                    where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
                       or (b.blocker_id = p.user_id and b.blocked_id = auth.uid()))
  order by greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) desc, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
