-- ============================================================================
-- 20261125090000_feed_likes  (Build brief Part 2A)
--
-- Friends-feed hearts stop being deck swipes. Until now the feed's heart
-- called record_swipe(post, 'right'), which (a) consumed the post from the
-- user's discovery deck, (b) polluted the deck's like-rate quality signal,
-- and (c) earned swipe points for a tap the brief says is NOT a swipe.
--
-- New model: `post_likes` rows + a trigger-maintained posts.feed_like_count,
-- toggled through toggle_feed_like (like AND unlike). Feed likes count as
-- likes on the post but live in their own counter, so creators see deck
-- likes and feed likes separately (Part 3) while the feed UI shows the
-- combined total. No points for feed likes (points are deck/comment/share
-- actions only). No backfill: pre-split hearts were real swipe rows and
-- remain deck likes (TestFlight-era data).
--
-- get_following_feed is re-emitted (signature change, hence DROP):
--   + feed_like_count and my_feed_like (drives the heart)
--   − my_direction (the heart no longer reflects deck swipes)
--   + account_status = 'active' filter — the gap noted in Part 1: suspended/
--     banned authors stayed visible in the friends feed.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Table + counter
-- ---------------------------------------------------------------------------
create table public.post_likes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
comment on table public.post_likes is
  'Friends-feed heart likes (Part 2A). NOT deck swipes: separate counter, no points, no effect on deck ranking. Likers list surfaces in Part 4.';
create index post_likes_user on public.post_likes (user_id, created_at desc);
alter table public.post_likes enable row level security;
revoke all on public.post_likes from anon, authenticated;

alter table public.posts add column if not exists feed_like_count integer not null default 0;
comment on column public.posts.feed_like_count is
  'Friends-feed heart likes. Maintained by trigger from post_likes; separate from like_count (deck right-swipes) by design (brief 2A).';

create or replace function public.tg_post_likes_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    update public.posts set feed_like_count = feed_like_count + 1, updated_at = now()
    where id = new.post_id;
    return new;
  end if;
  update public.posts set feed_like_count = greatest(feed_like_count - 1, 0), updated_at = now()
  where id = old.post_id;
  return old;
end;
$fn$;
drop trigger if exists tg_post_likes_count on public.post_likes;
create trigger tg_post_likes_count
  after insert or delete on public.post_likes
  for each row execute function public.tg_post_likes_count();

-- ---------------------------------------------------------------------------
-- 2. toggle_feed_like — the only write path (like + unlike).
-- ---------------------------------------------------------------------------
create or replace function public.toggle_feed_like(_post_id uuid)
returns table (liked boolean, feed_like_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  _uid     uuid := auth.uid();
  _deleted integer;
begin
  if _uid is null then
    raise exception 'toggle_feed_like: not authenticated';
  end if;

  -- The post must be one this user may see and interact with: approved, not
  -- their own, visible (public, or private from an accepted follow), poster
  -- active, no block either way.
  if not exists (
    select 1
    from public.posts p
    join public.profiles pr on pr.id = p.user_id
    where p.id = _post_id
      and p.moderation_status = 'approved'
      and p.user_id <> _uid
      and pr.account_status = 'active'
      and (
        p.visibility = 'public'
        or (p.visibility = 'private' and exists (
          select 1 from public.follows f
          where f.follower_id = _uid and f.followee_id = p.user_id and f.status = 'accepted'
        ))
      )
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = _uid and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = _uid)
      )
  ) then
    raise exception 'toggle_feed_like: post not available';
  end if;

  delete from public.post_likes pl where pl.post_id = _post_id and pl.user_id = _uid;
  get diagnostics _deleted = row_count;
  if _deleted = 0 then
    insert into public.post_likes (post_id, user_id) values (_post_id, _uid)
    on conflict (post_id, user_id) do nothing;
  end if;

  return query
    select (_deleted = 0) as liked, p.feed_like_count
    from public.posts p where p.id = _post_id;
end;
$fn$;
revoke all on function public.toggle_feed_like(uuid) from public, anon;
grant execute on function public.toggle_feed_like(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. get_following_feed re-emit (body from 20260808390000_post_overlays).
-- Changes: feed_like_count + my_feed_like out, my_direction gone, and the
-- account_status filter added. Signature changes, hence the DROP.
-- ---------------------------------------------------------------------------
drop function if exists public.get_following_feed(integer, timestamptz);
create function public.get_following_feed(
  _limit  integer default 15,
  _before timestamptz default null
)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count integer, skip_count integer, feed_like_count integer,
  comment_count integer, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[],
  my_feed_like boolean, overlays jsonb
) language sql stable security definer set search_path = '' as $fn$
  with base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.feed_like_count, p.comment_count,
           p.created_at, p.overlays
    from public.posts p
    join public.follows f
      on f.followee_id = p.user_id and f.follower_id = auth.uid() and f.status = 'accepted'
    where p.moderation_status = 'approved'
      and p.visibility in ('public', 'private')
      and p.user_id <> auth.uid()
      and (_before is null or p.created_at < _before)
      -- ADDED: suspended/banned/frozen authors leave the friends feed too.
      and exists (
        select 1 from public.profiles pra
        where pra.id = p.user_id and pra.account_status = 'active'
      )
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
      )
      and not exists (
        select 1 from public.mutes m where m.muter_id = auth.uid() and m.muted_id = p.user_id
      )
  )
  select b.id, b.user_id, b.media_url, b.thumbnail_url, b.media_type, b.caption, b.alt_text,
    b.like_count, b.skip_count, b.feed_like_count, b.comment_count, b.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags,
    (pl.user_id is not null) as my_feed_like,
    b.overlays
  from base b
  join public.profiles pr on pr.id = b.user_id
  left join public.post_likes pl on pl.post_id = b.id and pl.user_id = auth.uid()
  left join public.post_tags pt on pt.post_id = b.id
  left join public.tags t on t.id = pt.tag_id
  group by b.id, b.user_id, b.media_url, b.thumbnail_url, b.media_type, b.caption, b.alt_text,
    b.like_count, b.skip_count, b.feed_like_count, b.comment_count, b.created_at, b.overlays,
    pr.handle, pr.display_name, pr.avatar_url, pl.user_id
  order by b.created_at desc
  limit greatest(_limit, 0);
$fn$;
revoke all on function public.get_following_feed(integer, timestamptz) from public, anon;
grant execute on function public.get_following_feed(integer, timestamptz) to authenticated;
