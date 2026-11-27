-- ============================================================================
-- 20261127220000_untagged_fine_cells
--
-- Saj, 27 Nov (on PR #50): posts WITHOUT a place tag move from the ~5km cell
-- to the ~300m square too — as the original plan said. Those posts now come
-- from picking a city or area in the composer.
--
-- Guards:
--   * The app writes the square at insert, from the photo's GPS (only the
--     square leaves the phone), and only for posts without a place tag. Posts
--     tagged to a venue still get theirs from the `places` function, which
--     checks it lies inside the venue.
--   * The square must lie within 8km of the post's coarse cell (the area the
--     poster picked), so a home photo tagged "Mexico" never publishes the
--     home's square — it just keeps the ~5km area. Minors never get one.
--   * Builds before this keep working: 'cell' rows are unchanged (they still
--     count every post in the coarse cell); the 300m breakdown comes as new
--     'cell_part' rows that older builds ignore.
-- ============================================================================

-- 1 ─ the app may write the square when creating a post; the trigger decides.
grant insert (location_fine) on public.posts to authenticated;

-- Centre of a fine cell. Same maths as lib/location.ts fineCell/decodeCell.
create or replace function public.fine_cell_centre(_cell text)
returns extensions.geography language sql immutable
set search_path = ''
as $fn$
  select case when _cell ~ '^f300:-?[0-9]{1,6}:-?[0-9]{1,6}$' then
    extensions.st_setsrid(extensions.st_makepoint(
      (split_part(_cell, ':', 3)::integer + 0.5)
        * (0.0027 / cos(radians((split_part(_cell, ':', 2)::integer + 0.5) * 0.0027))),
      (split_part(_cell, ':', 2)::integer + 0.5) * 0.0027), 4326)::extensions.geography
  end;
$fn$;

create or replace function public.tg_posts_fine_cell_gate()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  _service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if new.location_fine is null then
    return new;
  end if;
  if new.location_cell is null
     or (select age_band from public.profiles where id = new.user_id) = 'minor' then
    new.location_fine := null;
    return new;
  end if;
  if not _service then
    -- From the app: only an untagged post's square, near the area it picked.
    -- (Venue-tagged squares come from the places function, checked there.)
    if new.venue_id is not null
       or left(new.location_cell, 4) <> 'gh5:'
       or extensions.st_distance(
            public.fine_cell_centre(new.location_fine),
            extensions.st_pointfromgeohash(substr(new.location_cell, 5))::extensions.geography) > 8000 then
      new.location_fine := null;
      return new;
    end if;
    -- The venue changed without a new square: the old square no longer applies.
    if tg_op = 'UPDATE' and new.venue_id is distinct from old.venue_id then
      new.location_fine := null;
    end if;
  end if;
  return new;
end;
$fn$;

-- 2 ─ get_map_pins + 'cell_part' rows: untagged posts with a square, grouped by
--     square (`id` = their coarse cell, `cell` = the square). Same columns, so
--     CREATE OR REPLACE keeps the grants. Body otherwise identical to
--     20261127210000.
create or replace function public.get_map_pins(_q text default null, _category text default null)
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
  from local_untagged m
  group by m.location_cell
  union all
  select 'cell_part', m.location_cell, (array_agg(m.location_label) filter (where m.location_label is not null))[1],
         null, null, null, count(m.id)::integer, false,
         case when sum(m.swipes) > 0 then (sum(m.likes)::numeric / sum(m.swipes))::double precision end,
         null, m.location_fine,
         max(m.created_at)
  from local_untagged m
  where m.location_fine is not null
  group by m.location_cell, m.location_fine
  order by 7 desc
  limit 500;
$fn$;

-- 3 ─ get_cell_posts: a fine cell ('f300:…') gives the posts in that square;
--     a coarse cell behaves as before, or with _exclude_fine only the posts
--     that have no square (the leftover bubble at the coarse centre). New
--     optional parameter, so drop + recreate and re-grant (default
--     privileges would hand EXECUTE to anon; the revoke is load-bearing).
drop function if exists public.get_cell_posts(text, text, text, integer);
create function public.get_cell_posts(
  _cell text, _q text default null, _category text default null, _limit integer default 12,
  _exclude_fine boolean default false)
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
  where (case when _cell like 'f300:%' then p.location_fine = _cell
              else p.location_cell = _cell and (not _exclude_fine or p.location_fine is null) end)
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
revoke all on function public.get_cell_posts(text, text, text, integer, boolean) from public, anon;
grant execute on function public.get_cell_posts(text, text, text, integer, boolean) to authenticated, service_role;
