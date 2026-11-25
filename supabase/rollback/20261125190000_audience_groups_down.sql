-- Rollback for 20261125190000_audience_groups.
-- Restores the pre-groups posts/stories policies and the pre-Part-4 function
-- bodies. Any existing 'groups' posts are flipped to followers-only FIRST so
-- the narrower constraint and policies never orphan them.
-- NOTE: roll back 20261125200000_likes_privacy first (its triggers reference
-- nothing here, but its flush job assumes the Part 4 world).

set search_path = public, extensions;

-- 1. No 'groups' rows may survive the constraint narrowing.
update public.posts set visibility = 'private', updated_at = now()
where visibility = 'groups';
update public.stories set audience = 'default' where audience = 'groups';

-- 2. Policies back to the pre-groups shape.
drop policy posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      not public.is_blocked_with(user_id)
      and moderation_status <> 'removed'
      and (
        (visibility = 'public' and moderation_status = 'approved')
        or (visibility = 'private' and public.is_accepted_follower_of(user_id))
      )
    )
  );

drop policy stories_select on public.stories;
create policy stories_select on public.stories for select to authenticated
  using (expires_at > now() and public.can_see_stories(auth.uid(), user_id));

-- 3. Constraint back to two values.
alter table public.posts drop constraint posts_visibility_check;
alter table public.posts add constraint posts_visibility_check
  check (visibility in ('public', 'private'));

-- 4. Functions back to their pre-Part-4 bodies.
create or replace function public.get_stories_rail()
returns table(user_id uuid, handle text, display_name text, avatar_url text,
              has_story boolean, has_unviewed boolean, latest_at timestamptz, is_self boolean)
language sql stable security definer set search_path = '' as $fn$
  with owners as (
    select auth.uid() as uid
    union
    select f.followee_id from public.follows f where f.follower_id = auth.uid() and f.status = 'accepted'
  ),
  active as (
    select s.user_id,
           max(s.created_at) as latest_at,
           bool_or(sv.viewer_id is null and s.user_id <> auth.uid()) as has_unviewed,
           count(*) as n
    from public.stories s
    join owners o on o.uid = s.user_id
    left join public.story_views sv on sv.story_id = s.id and sv.viewer_id = auth.uid()
    where s.expires_at > now() and public.can_see_stories(auth.uid(), s.user_id)
    group by s.user_id
  )
  select p.id, p.handle, p.display_name, p.avatar_url,
    (a.n is not null and a.n > 0) as has_story,
    coalesce(a.has_unviewed, false) as has_unviewed,
    a.latest_at,
    (p.id = auth.uid()) as is_self
  from owners o
  join public.profiles p on p.id = o.uid
  left join active a on a.user_id = o.uid
  where p.id = auth.uid() or a.n > 0
  order by (p.id = auth.uid()) desc, coalesce(a.has_unviewed, false) desc, a.latest_at desc nulls last;
$fn$;

create or replace function public.get_user_stories(_user_id uuid)
returns table(id uuid, media_url text, thumbnail_url text, media_type text,
              overlay_text text, created_at timestamptz, expires_at timestamptz,
              viewed boolean, is_self boolean)
language sql stable security definer set search_path = '' as $fn$
  select s.id, s.media_url, s.thumbnail_url, s.media_type, s.overlay_text, s.created_at, s.expires_at,
    (sv.viewer_id is not null) as viewed,
    (s.user_id = auth.uid()) as is_self
  from public.stories s
  left join public.story_views sv on sv.story_id = s.id and sv.viewer_id = auth.uid()
  where s.user_id = _user_id and s.expires_at > now()
    and public.can_see_stories(auth.uid(), s.user_id)
  order by s.created_at asc;
$fn$;

drop function if exists public.create_story(text, text, text, double precision, text, text, uuid[]);
create function public.create_story(
  _media_url text, _thumbnail_url text, _media_type text,
  _duration_seconds double precision default null, _overlay text default null
)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare _me uuid := auth.uid(); _id uuid;
begin
  if _me is null then raise exception 'unauthorized'; end if;
  if _media_type not in ('image', 'video') then raise exception 'bad_media_type'; end if;
  if _media_type = 'video' and coalesce(_duration_seconds, 0) > 15.5 then raise exception 'video_too_long'; end if;
  insert into public.stories (user_id, media_url, thumbnail_url, media_type, overlay_text)
    values (_me, _media_url, _thumbnail_url, _media_type, nullif(btrim(coalesce(_overlay, '')), ''))
    returning id into _id;
  return _id;
end $fn$;
revoke all on function public.create_story(text, text, text, double precision, text) from public, anon;
grant execute on function public.create_story(text, text, text, double precision, text) to authenticated;

-- get_following_feed / toggle_feed_like back to the 20261125090000 bodies.
create or replace function public.get_following_feed(
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

create or replace function public.toggle_feed_like(_post_id uuid)
returns table (liked boolean, feed_like_count integer)
language plpgsql security definer set search_path = '' as $fn$
declare
  _uid     uuid := auth.uid();
  _deleted integer;
begin
  if _uid is null then
    raise exception 'toggle_feed_like: not authenticated';
  end if;
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

-- add_comment back to the pre-Part-4 body (groups branch + points gate out).
create or replace function public.add_comment(_post_id uuid, _body text, _parent_id uuid default null)
returns public.comments
language plpgsql security definer set search_path = '' as $fn$
declare
  _uid    uuid := auth.uid();
  _clean  text := btrim(_body);
  _row    public.comments;
begin
  if _uid is null then
    raise exception 'add_comment: not authenticated';
  end if;
  if char_length(_clean) = 0 then
    raise exception 'add_comment: comment is empty';
  end if;
  if char_length(_clean) > 1000 then
    raise exception 'add_comment: comment is too long';
  end if;

  if not exists (
    select 1 from public.posts p
    where p.id = _post_id
      and p.moderation_status <> 'removed'
      and not public.is_blocked_with(p.user_id)
      and (
        p.user_id = _uid
        or (p.visibility = 'public' and p.moderation_status = 'approved')
        or (p.visibility = 'private' and public.is_accepted_follower_of(p.user_id))
      )
  ) then
    raise exception 'add_comment: post not available';
  end if;

  if _parent_id is not null then
    if not exists (
      select 1 from public.comments c
      where c.id = _parent_id and c.post_id = _post_id and c.parent_comment_id is null
    ) then
      raise exception 'add_comment: invalid parent comment';
    end if;
  end if;

  insert into public.comments (post_id, user_id, parent_comment_id, body)
  values (_post_id, _uid, _parent_id, _clean)
  returning * into _row;

  if char_length(_clean) >= 2 then
    perform public.award_points(
      case when _parent_id is null then 'comment' else 'comment_reply' end,
      'comment',
      _row.id
    );
  end if;

  return _row;
end;
$fn$;

-- record_swipe: drop the groups gate (Part 2 affinity body remains).
create or replace function public.record_swipe(_post_id uuid, _direction text)
returns bigint
language plpgsql security definer set search_path = '' as $fn$
declare
  _inserted integer;
  _balance  bigint;
  _last     timestamptz;
  _dwell_ok boolean;
  _trusted  boolean;
  _lc       integer;
  _upto     integer;
  _owner    uuid;
  _buckets  integer;
begin
  if _direction not in ('left', 'right') then
    raise exception 'record_swipe: direction must be left or right';
  end if;

  select max(created_at) into _last from public.swipes where user_id = auth.uid();
  _dwell_ok := (_last is null or now() - _last >= make_interval(
    secs => public.setting_numeric('points_swipe_min_gap_ms', 1000) / 1000.0));

  select not exists (
    select 1 from public.user_trust t
    where t.user_id = auth.uid()
      and (t.score < public.setting_numeric('trust_review_threshold', 40)
           or t.review_status = 'queued')
  ) into _trusted;

  insert into public.swipes (user_id, post_id, direction)
  values (auth.uid(), _post_id, _direction)
  on conflict (user_id, post_id) do nothing;
  get diagnostics _inserted = row_count;

  if _inserted > 0 then
    begin
      if _dwell_ok and _trusted then
        _balance := public.award_points('swipe', 'swipe', _post_id);
      else
        select points_balance into _balance from public.profiles where id = auth.uid();
      end if;

      if _direction = 'right' then
        select p.like_count, p.likes_rewarded_upto, p.user_id
          into _lc, _upto, _owner
        from public.posts p where p.id = _post_id;
        _buckets := (_lc / 10) - (_upto / 10);
        if _buckets > 0 and _owner is not null and _owner <> auth.uid() then
          perform public._award_to(_owner, _buckets * 3, 'like_milestone', 'post', _post_id);
          update public.posts set likes_rewarded_upto = _lc where id = _post_id;
        end if;
      end if;
    exception when others then
      select points_balance into _balance from public.profiles where id = auth.uid();
    end;

    begin
      if _direction = 'right' then
        update public.user_tags ut
        set weight = least(
          ut.weight + public.setting_numeric('affinity_like_delta', 0.1),
          public.setting_numeric('affinity_weight_max', 5))
        where ut.user_id = auth.uid()
          and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);

        insert into public.user_tags (user_id, tag_id, weight)
        select auth.uid(), pt.tag_id, public.setting_numeric('affinity_new_tag_delta', 0.05)
        from public.post_tags pt
        where pt.post_id = _post_id
        on conflict (user_id, tag_id) do nothing;
      else
        update public.user_tags ut
        set weight = greatest(
          ut.weight - public.setting_numeric('affinity_skip_delta', 0.15),
          public.setting_numeric('affinity_weight_min', -2))
        where ut.user_id = auth.uid()
          and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);

        insert into public.user_tags (user_id, tag_id, weight)
        select auth.uid(), pt.tag_id, -public.setting_numeric('affinity_skip_delta', 0.15)
        from public.post_tags pt
        where pt.post_id = _post_id
        on conflict (user_id, tag_id) do nothing;
      end if;
    exception when others then
      null;
    end;
  else
    select points_balance into _balance from public.profiles where id = auth.uid();
  end if;

  return _balance;
end;
$fn$;

-- get_profile_overview back to the simple count.
create or replace function public.get_profile_overview(_handle text)
returns table(id uuid, handle text, display_name text, bio text, avatar_url text,
              is_private boolean, follower_count integer, following_count integer,
              post_count integer, is_self boolean, follow_status text,
              is_blocked boolean, is_muting boolean, locked boolean)
language sql stable security definer set search_path = '' as $fn$
  with resolved as (
    select coalesce(
      (select pr.id from public.profiles pr where pr.handle = _handle),
      (select h.user_id from public.handle_history h where h.handle = _handle)
    ) as id
  ),
  p as (select * from public.profiles where id = (select id from resolved))
  select p.id, p.handle, p.display_name, p.bio, p.avatar_url, p.is_private,
    (select count(*)::int from public.follows f where f.followee_id = p.id and f.status = 'accepted'),
    (select count(*)::int from public.follows f where f.follower_id = p.id and f.status = 'accepted'),
    (select count(*)::int from public.posts po where po.user_id = p.id and po.moderation_status <> 'removed'),
    (p.id = auth.uid()) as is_self,
    (select f.status from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id) as follow_status,
    public.is_blocked_with(p.id) as is_blocked,
    public.is_muting(p.id) as is_muting,
    (p.is_private and p.id <> auth.uid()
       and not exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id and f.status = 'accepted')) as locked
  from p;
$fn$;

-- 5. Drop the Part 4A objects.
drop function if exists public.delete_audience_group(uuid, text);
drop function if exists public.viewer_in_post_groups(uuid);
drop function if exists public.viewer_in_story_groups(uuid);
drop table if exists public.story_audience_groups;
drop table if exists public.post_audience_groups;
drop table if exists public.audience_group_members;
drop table if exists public.audience_groups;
alter table public.stories drop column if exists audience;
