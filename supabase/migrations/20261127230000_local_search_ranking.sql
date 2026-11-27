-- ============================================================================
-- 20261127230000_local_search_ranking
--
-- Local search Stage 4 (plan agreed with Saj 2026-11-27): the grid finds what
-- it should, and Local results are "near AND good", not just "best words".
--
-- 1. Search-index bug: the post_tags trigger (20260802090000) rebuilt
--    posts.search_vector with the ORIGINAL formula — caption, tags, alt text —
--    dropping the venue name and category added in search_v2. The app inserts
--    a post's tags after the post, so every tagged post at a venue lost its
--    venue words. Measured live before this: "aunty" found 1 of the 23 Aunty
--    Ji's posts; "drink" found 1 of 24. Both triggers now share one builder.
-- 2. The index also learns the picked place name (posts.location_label, e.g.
--    "Didsbury", shown on posts since #46), at the same weight as tags.
-- 3. search_posts_local ranked by text relevance first, so quality, distance
--    and freshness only broke exact ties (ts_rank floats almost never tie) —
--    i.e. never. Now one blended score:
--        relevance (rank / best rank in the results)
--      + quality   (bot-cleaned like rate, Bayesian (likes+1)/(swipes+2))
--      + popularity(log likes / log best likes in the results)
--      + nearness  (exp(-distance / scale); untagged posts use their ~300m
--                   square or ~5km cell centre — ranking only, never shown)
--      + freshness (exp(-age / 30 days))
--    each with a platform_settings weight, tunable without a release.
--    Same signature and columns, so CREATE OR REPLACE keeps the grants.
-- ============================================================================

-- 1+2 ─ one index builder, used by every trigger.
create or replace function public._post_search_vector(
  _caption text, _alt text, _post_id uuid, _venue_id uuid, _label text
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
    || setweight(to_tsvector('english', coalesce(_label, '')), 'B')
    || setweight(to_tsvector('english', coalesce((
         select v.category || ' ' || public.venue_category_group(v.category)
         from public.venues v where v.id = _venue_id), '')), 'C')
    || setweight(to_tsvector('english', coalesce(_alt, '')), 'C');
$fn$;
revoke all on function public._post_search_vector(text, text, uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.tg_posts_search_vector()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  new.search_vector := public._post_search_vector(
    new.caption, new.alt_text, new.id, new.venue_id, new.location_label);
  return new;
end $fn$;

drop trigger if exists tg_posts_search_vector on public.posts;
create trigger tg_posts_search_vector
  before insert or update of caption, alt_text, venue_id, location_label on public.posts
  for each row execute function public.tg_posts_search_vector();

create or replace function public.tg_post_tags_search_vector()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare _pid uuid := coalesce(new.post_id, old.post_id);
begin
  update public.posts p
     set search_vector = public._post_search_vector(p.caption, p.alt_text, p.id, p.venue_id, p.location_label)
   where p.id = _pid;
  return null;
end $fn$;

create or replace function public.tg_venues_reindex_posts()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if new.name is distinct from old.name or new.category is distinct from old.category then
    update public.posts p
       set search_vector = public._post_search_vector(p.caption, p.alt_text, p.id, p.venue_id, p.location_label)
     where p.venue_id = new.id;
  end if;
  return new;
end $fn$;

drop function if exists public._post_search_vector(text, text, uuid, uuid);

-- One-off re-index: repairs every post the old tag trigger left stale.
update public.posts p
   set search_vector = public._post_search_vector(p.caption, p.alt_text, p.id, p.venue_id, p.location_label);

-- 3 ─ ranking weights (admin-tunable).
insert into public.platform_settings (key, value, description, client_visible) values
  ('local_rank_w_relevance',  '1.0'::jsonb, 'Local search: weight of text relevance (relative to the best match in the results).', false),
  ('local_rank_w_quality',    '1.0'::jsonb, 'Local search: weight of like rate (bot-cleaned, Bayesian).', false),
  ('local_rank_w_popularity', '0.5'::jsonb, 'Local search: weight of like volume (log, relative to the most-liked result).', false),
  ('local_rank_w_distance',   '1.0'::jsonb, 'Local search: weight of nearness to the search centre.', false),
  ('local_rank_w_freshness',  '0.5'::jsonb, 'Local search: weight of recency (fades over ~a month).', false),
  ('local_rank_distance_km',  '2.0'::jsonb, 'Local search: nearness scale in km (a result this far away keeps ~37% of the nearness score).', false)
on conflict (key) do nothing;

create or replace function public.search_posts_local(
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
  w as (
    select public.setting_numeric('local_rank_w_relevance', 1.0)::double precision as rel,
           public.setting_numeric('local_rank_w_quality', 1.0)::double precision as qual,
           public.setting_numeric('local_rank_w_popularity', 0.5)::double precision as pop,
           public.setting_numeric('local_rank_w_distance', 1.0)::double precision as dist,
           public.setting_numeric('local_rank_w_freshness', 0.5)::double precision as fresh,
           greatest(public.setting_numeric('local_rank_distance_km', 2.0), 0.1)::double precision * 1000 as scale_m
  ),
  matched as (
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at,
           greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0) as likes,
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
           -- Ranking only: where an untagged post is, roughly (its ~300m
           -- square, else its ~5km cell centre). Never returned.
           extensions.st_distance(
             coalesce(public.fine_cell_centre(p.location_fine),
                      case when left(p.location_cell, 4) = 'gh5:'
                           then extensions.st_pointfromgeohash(substr(p.location_cell, 5))::extensions.geography end),
             (select centre from me)) as area_distance_m,
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
  ),
  scored as (
    -- Each term falls back to a neutral value, so one missing signal (no
    -- likes anywhere yet, no location) never blanks the whole score.
    select m.*,
             (select rel from w) * coalesce(m.rank / nullif(max(m.rank) over (), 0), 0)
           + (select qual from w) * m.quality
           + (select pop from w) * coalesce(ln(1 + m.likes) / nullif(ln(1 + max(m.likes) over ()), 0), 0)
           + (select dist from w) * coalesce(
               exp(-coalesce(m.distance_m, m.area_distance_m) / (select scale_m from w)), 0.3)
           + (select fresh from w) * exp(-extract(epoch from (now() - m.created_at)) / 86400.0 / 30.0)
             as score
    from matched m
  )
  select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption, p.alt_text,
    p.like_count, p.skip_count, p.comment_count, p.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}'),
    m.distance_m, m.venue_name,
    p.venue_id,
    exists (select 1 from public.business_venues bv where bv.venue_id = p.venue_id),
    p.location_label
  from scored m
  join public.posts p on p.id = m.id
  join public.profiles pr on pr.id = p.user_id
  left join public.post_tags pt on pt.post_id = p.id
  left join public.tags t on t.id = pt.tag_id
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, m.score, m.distance_m, m.venue_name
  order by m.score desc, p.created_at desc, p.id
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
