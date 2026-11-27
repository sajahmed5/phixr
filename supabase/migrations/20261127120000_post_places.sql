-- ============================================================================
-- 20261127120000_post_places
--
-- Saj, 27 Nov: "if I have a dog, I see this image, I think this looks nice, I
-- click on the location, and I think let me take my dog there." Every post
-- with location data should SAY where it is, and the name should open a place
-- page. Approved design: location + posted date on the post view and feed
-- cards, tap-through to the place.
--
-- Display name, in priority order:
--   1. posts.location_label (the place the poster picked);
--   2. the tagged venue's name;
--   3. the photo's own place tags (source 'geo', from reverse-geocoding its
--      GPS before the pipeline strips it). post_tags has no order, so the two
--      MOST SPECIFIC are taken by global usage: a town is rarer than its
--      county, which is rarer than its country — "Lymm, England", not
--      "England, United Kingdom". This is what lights up seeded/older posts
--      that never went through the picker, with no data backfill.
--
-- A place page is either a VENUE (exact: Directions goes to the door) or an
-- AREA = the post's coarse location cell (~5km). Areas never resolve to a
-- point finer than the cell — no one's exact position is ever exposed.
-- ============================================================================

-- RLS-gated (INVOKER): posts/post_tags/venues policies decide what the caller
-- may see, so this can only label posts the caller can already read.
create or replace function public.get_post_places(_ids uuid[])
returns table(post_id uuid, label text, venue_id uuid, cell text, is_business boolean)
language sql stable
set search_path = ''
as $fn$
  select p.id,
         coalesce(
           nullif(btrim(p.location_label), ''),
           v.name,
           (select string_agg(initcap(g.name), ', ' order by g.rank)
              from (select t.name,
                           row_number() over (order by t.usage_count asc, t.name) as rank
                      from public.post_tags pt
                      join public.tags t on t.id = pt.tag_id
                     where pt.post_id = p.id and pt.source = 'geo') g
             where g.rank <= 2)
         ),
         p.venue_id,
         p.location_cell,
         coalesce(exists (select 1 from public.business_venues bv where bv.venue_id = p.venue_id), false)
  from public.posts p
  left join public.venues v on v.id = p.venue_id
  where p.id = any(_ids);
$fn$;

revoke all on function public.get_post_places(uuid[]) from public, anon;
grant execute on function public.get_post_places(uuid[]) to authenticated, service_role;

-- The posts at a place: a venue's tagged posts, or every located post in an
-- area cell. Same gates as the Local map (public, approved, not sensitive,
-- active adult authors unless the viewer is a minor, blocks both ways).
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
  where ((_venue_id is not null and p.venue_id = _venue_id)
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

revoke all on function public.get_place_posts(uuid, text, integer, integer) from public, anon;
grant execute on function public.get_place_posts(uuid, text, integer, integer) to authenticated, service_role;
