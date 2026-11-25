-- Part 7D + 7B (server side): sponsored search results + map venue data.
--
-- SPONSORED SEARCH (7D): businesses can appear at the top of relevant local
-- searches, slightly beyond the searcher's radius (capped by a setting).
-- Entries are managed in fame-admin until Stripe billing arrives (Part 8) —
-- the table already carries the fields billing will need. Hard rules, all
-- server-enforced: at most max_sponsored_search_results per search (seeded 2
-- in Part 1); REAL distance always returned (the app must label "Sponsored");
-- organic results are untouched (the app renders sponsored in their own
-- strip above the grid, never replacing organic rows); nothing personal is
-- used — matching is query + place only, so nothing here targets an under-18
-- personally (brief 7D).
--
-- MAP (7B): pins only ever sit at VENUES (public business locations from the
-- places provider) — never where a person was. Posts without a venue never
-- reach the map.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  ('sponsored_radius_extra_miles', '10'::jsonb,
   'How far beyond the searcher''s radius a sponsored result may sit (brief 7D: "a setting caps how far").', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Sponsored entries (fame-admin managed until Part 8 billing).
-- ---------------------------------------------------------------------------
create table public.sponsored_search (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.profiles (id) on delete cascade,
  venue_id    uuid not null references public.venues (id) on delete cascade,
  keywords    text[] not null default '{}',   -- empty = match the venue name/category only
  status      text not null default 'active' check (status in ('active', 'paused', 'ended')),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz not null,
  impressions integer not null default 0,
  clicks      integer not null default 0,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now()
);
create index sponsored_search_active on public.sponsored_search (status, ends_at);
alter table public.sponsored_search enable row level security;
-- The sponsoring business may read its own entries (results reporting).
create policy sponsored_own_select on public.sponsored_search
  for select to authenticated using (business_id = auth.uid());
revoke all on table public.sponsored_search from public, anon, authenticated;
grant select on public.sponsored_search to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Serving: top-N relevant sponsored placements for a local search.
--    Volatile on purpose — it counts the impressions it serves.
-- ---------------------------------------------------------------------------
create or replace function public.get_sponsored_results(_q text)
returns table (
  id uuid, business_id uuid, business_handle text, venue_id uuid,
  venue_name text, venue_category text, distance_m double precision
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
    select s.id, s.business_id, s.venue_id, v.name, v.category,
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
  select c.id, c.business_id, pr.handle, c.venue_id, c.name, c.category, c.dist
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

create or replace function public.record_sponsored_click(_id uuid)
returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.sponsored_search set clicks = clicks + 1
  where id = _id and status = 'active';
$fn$;
revoke all on function public.record_sponsored_click(uuid) from public, anon;
grant execute on function public.record_sponsored_click(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Map data (7B): venues inside the caller's radius that have at least one
--    public approved post, with bot-cleaned like rate. Venue locations are
--    PUBLIC business locations — no person's position is ever returned.
-- ---------------------------------------------------------------------------
create or replace function public.get_map_venues(_limit integer default 200)
returns table (
  id uuid, name text, category text, category_group text,
  lat double precision, lon double precision,
  post_count integer, like_rate double precision, distance_m double precision
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with me as (
    select coalesce(pr.search_center_location, pr.search_location) as centre,
           pr.search_radius_miles as radius
    from public.profiles pr where pr.id = auth.uid()
  ),
  venue_stats as (
    select v.id, v.name, v.category, v.lat, v.lon,
           count(p.id)::integer as post_count,
           sum(greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0))::numeric as likes,
           sum(greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)
             + greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0))::numeric as swipes
    from public.venues v
    join public.posts p on p.venue_id = v.id
    left join public.post_bot_counts bc on bc.post_id = p.id
    where p.visibility = 'public'
      and p.moderation_status = 'approved'
      and not p.sensitive
      and v.lat is not null and v.lon is not null
      and exists (select 1 from public.profiles pra
                  where pra.id = p.user_id and pra.account_status = 'active'
                    and (pra.age_band = 'adult' or public.is_minor(auth.uid())
                         or public.setting_numeric('teen_posts_in_adult_deck', 0) = 1))
    group by v.id, v.name, v.category, v.lat, v.lon
  )
  select vs.id, vs.name, vs.category, public.venue_category_group(vs.category),
         vs.lat, vs.lon, vs.post_count,
         case when vs.swipes > 0 then (vs.likes / vs.swipes)::double precision end,
         extensions.st_distance(
           extensions.st_setsrid(extensions.st_makepoint(vs.lon, vs.lat), 4326)::extensions.geography,
           (select centre from me)) as distance_m
  from venue_stats vs
  where (select centre from me) is not null
    and extensions.st_distance(
          extensions.st_setsrid(extensions.st_makepoint(vs.lon, vs.lat), 4326)::extensions.geography,
          (select centre from me)) <= (select radius from me) * 1609.34
  order by vs.post_count desc
  limit greatest(_limit, 0);
$fn$;
revoke all on function public.get_map_venues(integer) from public, anon;
grant execute on function public.get_map_venues(integer) to authenticated;

-- The place card: a venue's best-liked public posts.
create or replace function public.get_venue_posts(_venue_id uuid, _limit integer default 6)
returns table (
  id uuid, thumbnail_url text, media_type text, like_count integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.id, p.thumbnail_url, p.media_type,
         greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0)::integer
  from public.posts p
  left join public.post_bot_counts bc on bc.post_id = p.id
  where p.venue_id = _venue_id
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
  limit greatest(_limit, 0);
$fn$;
revoke all on function public.get_venue_posts(uuid, integer) from public, anon;
grant execute on function public.get_venue_posts(uuid, integer) to authenticated;
