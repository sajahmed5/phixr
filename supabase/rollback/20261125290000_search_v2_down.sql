-- Rollback for 20261125290000_search_v2.
-- Restores the Part 6 search fns (3-arg, sensitive-aware), the original
-- search-vector trigger (no venues) and the 100-mile set_search_radius cap
-- (the pre-Part-7 behaviour, bug included — a rollback restores, it doesn't
-- improve). Roll back 20261125300000 FIRST.

set search_path = public, extensions;

drop function if exists public.search_posts(text, int, int, text);
drop function if exists public.search_posts_local(text, int, int, text);

create or replace function public.search_posts(_q text, _limit int default 24, _offset int default 0)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[]
) language sql stable security definer set search_path = '' as $fn$
  with q as (select websearch_to_tsquery('english', coalesce(_q, '')) as tsq),
  matched as (
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at, p.user_id
    from public.posts p
    where (select tsq from q) is not null
      and p.search_vector @@ (select tsq from q)
      and p.moderation_status = 'approved'
      and not p.sensitive  -- 6B: sensitive stays out of search grids
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
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, pr.points_balance, m.rank
  order by m.rank desc, pr.points_balance desc, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
revoke all on function public.search_posts(text, int, int) from public, anon;
grant execute on function public.search_posts(text, int, int) to authenticated;

create or replace function public.search_posts_local(_q text, _limit int default 24, _offset int default 0)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count int, skip_count int, comment_count int, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[]
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
    select p.id, ts_rank(p.search_vector, (select tsq from q)) as rank, p.created_at
    from public.posts p
    where (select tsq from q) is not null
      and p.search_vector @@ (select tsq from q)
      and p.location_cell is not null
      and p.location_cell = any(coalesce((select arr from cells), array[]::text[]))
      and p.moderation_status = 'approved'
      and not p.sensitive  -- 6B: sensitive stays out of search grids
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
  group by p.id, pr.handle, pr.display_name, pr.avatar_url, pr.points_balance, m.rank
  order by m.rank desc, pr.points_balance desc, p.created_at desc
  limit greatest(_limit, 0) offset greatest(_offset, 0);
$fn$;
revoke all on function public.search_posts_local(text, int, int) from public, anon;
grant execute on function public.search_posts_local(text, int, int) to authenticated;

create or replace function public.tg_posts_search_vector()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  new.search_vector :=
       setweight(to_tsvector('english', coalesce(new.caption, '')), 'A')
    || setweight(to_tsvector('english', coalesce((
         select string_agg(t.name, ' ')
         from public.post_tags pt join public.tags t on t.id = pt.tag_id
         where pt.post_id = new.id), '')), 'B')
    || setweight(to_tsvector('english', coalesce(new.alt_text, '')), 'C');
  return new;
end $fn$;
drop trigger if exists tg_posts_search_vector on public.posts;
create trigger tg_posts_search_vector
  before insert or update of caption, alt_text on public.posts
  for each row execute function public.tg_posts_search_vector();

drop trigger if exists venues_reindex_posts on public.venues;
drop function if exists public.tg_venues_reindex_posts();

-- Re-index without venue terms.
update public.posts p
   set search_vector =
       setweight(to_tsvector('english', coalesce(p.caption, '')), 'A')
    || setweight(to_tsvector('english', coalesce((
         select string_agg(t.name, ' ')
         from public.post_tags pt join public.tags t on t.id = pt.tag_id
         where pt.post_id = p.id), '')), 'B')
    || setweight(to_tsvector('english', coalesce(p.alt_text, '')), 'C');

drop function if exists public._post_search_vector(text, text, uuid, uuid);
drop function if exists public.venue_category_group(text);

create or replace function public.set_search_radius(_miles int)
returns void language sql security definer set search_path = '' as $fn$
  update public.profiles set search_radius_miles = greatest(1, least(_miles, 100)) where id = auth.uid();
$fn$;
