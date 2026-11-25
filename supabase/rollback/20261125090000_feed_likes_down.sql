-- Rollback for 20261125090000_feed_likes.
-- Restores get_following_feed to the 20260808390000 version (my_direction,
-- no feed-like columns, no account_status filter — faithful restore), then
-- removes the feed-like function, trigger, column and table.

set search_path = public, extensions;

drop function if exists public.get_following_feed(integer, timestamptz);
create function public.get_following_feed(
  _limit  integer default 15,
  _before timestamptz default null
)
returns table (
  id uuid, user_id uuid, media_url text, thumbnail_url text, media_type text, caption text,
  alt_text text, like_count integer, skip_count integer, comment_count integer, created_at timestamptz,
  poster_handle text, poster_display_name text, poster_avatar_url text, tags text[],
  my_direction text, overlays jsonb
) language sql stable security definer set search_path = '' as $fn$
  with base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.comment_count, p.created_at,
           p.overlays
    from public.posts p
    join public.follows f
      on f.followee_id = p.user_id and f.follower_id = auth.uid() and f.status = 'accepted'
    where p.moderation_status = 'approved'
      and p.visibility in ('public', 'private')
      and p.user_id <> auth.uid()
      and (_before is null or p.created_at < _before)
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
    b.like_count, b.skip_count, b.comment_count, b.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags,
    sw.direction as my_direction,
    b.overlays
  from base b
  join public.profiles pr on pr.id = b.user_id
  left join public.swipes sw on sw.post_id = b.id and sw.user_id = auth.uid()
  left join public.post_tags pt on pt.post_id = b.id
  left join public.tags t on t.id = pt.tag_id
  group by b.id, b.user_id, b.media_url, b.thumbnail_url, b.media_type, b.caption, b.alt_text,
    b.like_count, b.skip_count, b.comment_count, b.created_at, b.overlays,
    pr.handle, pr.display_name, pr.avatar_url, sw.direction
  order by b.created_at desc
  limit greatest(_limit, 0);
$fn$;
revoke all on function public.get_following_feed(integer, timestamptz) from public, anon;
grant execute on function public.get_following_feed(integer, timestamptz) to authenticated;

drop function if exists public.toggle_feed_like(uuid);
drop trigger if exists tg_post_likes_count on public.post_likes;
drop function if exists public.tg_post_likes_count();
alter table public.posts drop column if exists feed_like_count;
drop table if exists public.post_likes;
