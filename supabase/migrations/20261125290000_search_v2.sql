-- Part 7A: search v2 — venue-aware vector, category filter, fairer ranking,
-- radius bug fixed.
--
-- The brief's four known gaps, closed:
--   1. VENUE NAMES/CATEGORIES weren't searched: the post search vector now
--      includes the tagged venue's name (weight B) and category (weight C),
--      existing posts are re-indexed, and a venue rename/recategorise
--      re-indexes its posts by trigger.
--   2. NO CATEGORY FILTER: search_posts/search_posts_local take `_category`
--      ('food' | 'drink' | 'shops' | 'todo'), mapped from provider categories
--      by venue_category_group().
--   3. RANKING FAVOURED BIG ACCOUNTS: ordering was rank → poster points →
--      recency. Now rank → bot-cleaned Laplace-smoothed like quality →
--      venue distance (Local only; via the business's nearest claimed branch
--      for chain posts) → recency. Points are OUT of the ordering entirely
--      ("a small factor at most" — zero is the smallest honest factor).
--   4. RADIUS BUG: set_search_radius accepted 100 miles while local_cells
--      silently capped at 50. The agreed limit is 50 everywhere (the app's
--      radius picker already stops at 50).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Radius: one limit, 50 miles.
-- ---------------------------------------------------------------------------
create or replace function public.set_search_radius(_miles int)
returns void language sql security definer set search_path = '' as $fn$
  update public.profiles
     set search_radius_miles = greatest(1, least(_miles, 50))
   where id = auth.uid();
$fn$;
-- Anyone previously over the real cap comes down to it.
update public.profiles set search_radius_miles = 50 where search_radius_miles > 50;

-- ---------------------------------------------------------------------------
-- 2. Category groups for the filter chips.
-- ---------------------------------------------------------------------------
create or replace function public.venue_category_group(_category text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when _category in ('restaurant','meal_takeaway','meal_delivery','bakery','food') then 'food'
    when _category in ('cafe','bar','pub','night_club') then 'drink'
    when _category in ('store','shopping_mall','clothing_store','supermarket','convenience_store',
                       'book_store','electronics_store','furniture_store','jewelry_store',
                       'shoe_store','florist','pet_store') then 'shops'
    when _category in ('park','museum','art_gallery','gym','movie_theater','bowling_alley',
                       'amusement_park','zoo','aquarium','stadium','tourist_attraction','spa') then 'todo'
    else 'other'
  end;
$fn$;
revoke all on function public.venue_category_group(text) from public, anon;
grant execute on function public.venue_category_group(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The vector learns venues; re-index; venue edits propagate.
-- ---------------------------------------------------------------------------
create or replace function public._post_search_vector(
  _caption text, _alt text, _post_id uuid, _venue_id uuid
)
returns tsvector
language sql
stable
security definer
set search_path = ''
as $fn$
  select
       setweight(to_tsvector('english', coalesce(_caption, '')), 'A')
    || setweight(to_tsvector('english', coalesce((
         select string_agg(t.name, ' ')
         from public.post_tags pt join public.tags t on t.id = pt.tag_id
         where pt.post_id = _post_id), '')), 'B')
    || setweight(to_tsvector('english', coalesce((
         select v.name from public.venues v where v.id = _venue_id), '')), 'B')
    || setweight(to_tsvector('english', coalesce((
         select v.category || ' ' || public.venue_category_group(v.category)
         from public.venues v where v.id = _venue_id), '')), 'C')
    || setweight(to_tsvector('english', coalesce(_alt, '')), 'C');
$fn$;
revoke all on function public._post_search_vector(text, text, uuid, uuid)
  from public, anon, authenticated;

create or replace function public.tg_posts_search_vector()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  new.search_vector := public._post_search_vector(new.caption, new.alt_text, new.id, new.venue_id);
  return new;
end $fn$;

-- The old trigger fired on insert/update already; make sure venue_id changes
-- re-fire it too (re-create with an explicit full definition).
drop trigger if exists tg_posts_search_vector on public.posts;
create trigger tg_posts_search_vector
  before insert or update of caption, alt_text, venue_id on public.posts
  for each row execute function public.tg_posts_search_vector();

-- A venue rename/recategorise re-indexes its posts.
create or replace function public.tg_venues_reindex_posts()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if new.name is distinct from old.name or new.category is distinct from old.category then
    update public.posts p
       set search_vector = public._post_search_vector(p.caption, p.alt_text, p.id, p.venue_id)
     where p.venue_id = new.id;
  end if;
  return new;
end $fn$;
revoke all on function public.tg_venues_reindex_posts() from public, anon, authenticated;
drop trigger if exists venues_reindex_posts on public.venues;
create trigger venues_reindex_posts
  after update on public.venues
  for each row execute function public.tg_venues_reindex_posts();

-- One-off re-index so venue names are searchable immediately.
update public.posts p
   set search_vector = public._post_search_vector(p.caption, p.alt_text, p.id, p.venue_id);

-- ---------------------------------------------------------------------------
-- 4. search_posts v2 (worldwide): fair ranking + category filter.
--    (Signature changes — drop old 3-arg forms.)
-- ---------------------------------------------------------------------------
drop function if exists public.search_posts(text, int, int);
create function public.search_posts(
  _q text, _limit int default 24, _offset int default 0, _category text default null
)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[]
) language sql stable security definer set search_path = '' as $fn$
  with q as (select websearch_to_tsquery('english', coalesce(_q, '')) as tsq),
  matched as (
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at, p.user_id,
           -- Laplace-smoothed, bot-cleaned like quality (the fairness fix).
           (greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) + 1.0)
             / (greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)
              + greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0) + 2.0) as quality
    from public.posts p
    left join public.post_bot_counts bc on bc.post_id = p.id
    where (select tsq from q) is not null
      and p.search_vector @@ (select tsq from q)
      and p.moderation_status = 'approved'
      and not p.sensitive
      and (_category is null or exists (
            select 1 from public.venues v
            where v.id = p.venue_id and public.venue_category_group(v.category) = _category))
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
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}')
  from matched m
  join public.posts p on p.id = m.id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags t on t.id = pt.tag_id
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, m.rank, m.quality
  order by m.rank desc, m.quality desc, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
revoke all on function public.search_posts(text, int, int, text) from public, anon;
grant execute on function public.search_posts(text, int, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. search_posts_local v2: fair ranking + category + DISTANCE (venue's real
--    location, or the business author's nearest claimed branch for chain
--    posts without a tagged venue), returned so the UI can show it.
-- ---------------------------------------------------------------------------
drop function if exists public.search_posts_local(text, int, int);
create function public.search_posts_local(
  _q text, _limit int default 24, _offset int default 0, _category text default null
)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[],
  distance_m double precision, venue_name text
) language sql stable security definer set search_path = '' as $fn$
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
           -- Distance: the tagged venue, else the business author's nearest
           -- claimed branch (chain-wide posts surface at the closest branch).
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
      and (_category is null or exists (
            select 1 from public.venues v
            where v.id = p.venue_id and public.venue_category_group(v.category) = _category))
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
    m.distance_m, m.venue_name
  from matched m
  join public.posts p on p.id = m.id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags t on t.id = pt.tag_id
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, m.rank, m.quality, m.distance_m, m.venue_name
  order by m.rank desc, m.quality desc, m.distance_m asc nulls last, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
revoke all on function public.search_posts_local(text, int, int, text) from public, anon;
grant execute on function public.search_posts_local(text, int, int, text) to authenticated;
