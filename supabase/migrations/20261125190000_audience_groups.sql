-- Part 4A: private audience groups.
--
-- An owner sorts followers into named groups (Friends, Family, …) and can post
-- or story to one or more groups. MEMBERSHIP IS SECRET (brief absolute): the
-- group tables are owner-only under RLS, members can never query names or
-- membership, and the only thing a member can observe is that a post exists —
-- rendered exactly like a followers post, no badge.
--
-- Access model, one place: the posts SELECT policy gains a 'groups' branch —
--   owner, OR (not blocked AND accepted follower AND in one of the post's
--   groups, checked by the definer helper `viewer_in_post_groups`).
-- Comments inherit automatically (their policy checks `exists posts`, which
-- runs under the caller's posts RLS). Deck/search/explore/tag pages already
-- demand visibility = 'public', so group posts can never surface there.
--
-- Group posts and analytics/points (brief): they never enter the deck, so no
-- deck swipes, view events (ingest refuses non-public) or roll-ups exist for
-- them; record_swipe refuses them outright, and comments on them award no
-- points. Feed hearts never earned points anywhere.
--
-- Removing a member / unfollow / block => next read loses access (RLS is
-- evaluated per query). Deleting a group asks what happens to posts that
-- targeted ONLY that group: 'followers' flips them to followers-only,
-- 'delete' removes them.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
create table public.audience_groups (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table public.audience_group_members (
  group_id  uuid not null references public.audience_groups (id) on delete cascade,
  member_id uuid not null references public.profiles (id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (group_id, member_id)
);
create index audience_group_members_member on public.audience_group_members (member_id);

create table public.post_audience_groups (
  post_id  uuid not null references public.posts (id) on delete cascade,
  group_id uuid not null references public.audience_groups (id) on delete cascade,
  primary key (post_id, group_id)
);
create index post_audience_groups_group on public.post_audience_groups (group_id);

alter table public.stories
  add column audience text not null default 'default'
    check (audience in ('default', 'groups'));

create table public.story_audience_groups (
  story_id uuid not null references public.stories (id) on delete cascade,
  group_id uuid not null references public.audience_groups (id) on delete cascade,
  primary key (story_id, group_id)
);
create index story_audience_groups_group on public.story_audience_groups (group_id);

-- ---------------------------------------------------------------------------
-- 2. RLS — OWNER-ONLY on every group table. There is deliberately no policy
--    that lets a member see any row: that is the secrecy guarantee the brief
--    demands be provable. (service_role bypasses RLS for moderation.)
-- ---------------------------------------------------------------------------
alter table public.audience_groups       enable row level security;
alter table public.audience_group_members enable row level security;
alter table public.post_audience_groups  enable row level security;
alter table public.story_audience_groups enable row level security;

create policy audience_groups_owner on public.audience_groups
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy agm_owner_select on public.audience_group_members
  for select to authenticated
  using (exists (select 1 from public.audience_groups g
                 where g.id = group_id and g.owner_id = auth.uid()));
create policy agm_owner_insert on public.audience_group_members
  for insert to authenticated
  with check (
    exists (select 1 from public.audience_groups g
            where g.id = group_id and g.owner_id = auth.uid())
    and member_id <> auth.uid()
    -- Only ACCEPTED followers can be in a group (unfollow already drops
    -- access via the visibility check; this keeps the roster honest too).
    and exists (select 1 from public.follows f
                where f.follower_id = member_id and f.followee_id = auth.uid()
                  and f.status = 'accepted')
  );
create policy agm_owner_delete on public.audience_group_members
  for delete to authenticated
  using (exists (select 1 from public.audience_groups g
                 where g.id = group_id and g.owner_id = auth.uid()));

create policy pag_owner_select on public.post_audience_groups
  for select to authenticated
  using (exists (select 1 from public.posts p
                 where p.id = post_id and p.user_id = auth.uid()));
create policy pag_owner_insert on public.post_audience_groups
  for insert to authenticated
  with check (
    exists (select 1 from public.posts p
            where p.id = post_id and p.user_id = auth.uid())
    and exists (select 1 from public.audience_groups g
                where g.id = group_id and g.owner_id = auth.uid())
  );
create policy pag_owner_delete on public.post_audience_groups
  for delete to authenticated
  using (exists (select 1 from public.posts p
                 where p.id = post_id and p.user_id = auth.uid()));

create policy sag_owner_select on public.story_audience_groups
  for select to authenticated
  using (exists (select 1 from public.stories s
                 where s.id = story_id and s.user_id = auth.uid()));
create policy sag_owner_delete on public.story_audience_groups
  for delete to authenticated
  using (exists (select 1 from public.stories s
                 where s.id = story_id and s.user_id = auth.uid()));
-- (story_audience_groups rows are inserted by create_story, definer.)

revoke all on public.audience_groups, public.audience_group_members,
              public.post_audience_groups, public.story_audience_groups
  from public, anon, authenticated;
grant select, insert, delete on public.audience_groups to authenticated;
grant update (name) on public.audience_groups to authenticated;
grant select, insert, delete on public.audience_group_members to authenticated;
grant select, insert, delete on public.post_audience_groups to authenticated;
grant select, delete on public.story_audience_groups to authenticated;

-- ---------------------------------------------------------------------------
-- 3. posts.visibility gains 'groups'.
-- ---------------------------------------------------------------------------
alter table public.posts drop constraint posts_visibility_check;
alter table public.posts add constraint posts_visibility_check
  check (visibility in ('public', 'private', 'groups'));

-- ---------------------------------------------------------------------------
-- 4. Membership helpers (SECURITY DEFINER so the posts policy can check
--    membership WITHOUT the member being able to read the group tables).
--    They answer only yes/no for one post/story — no enumeration beyond what
--    seeing the post already reveals.
-- ---------------------------------------------------------------------------
create or replace function public.viewer_in_post_groups(_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.post_audience_groups pg
    join public.audience_group_members m on m.group_id = pg.group_id
    where pg.post_id = _post_id and m.member_id = auth.uid()
  );
$fn$;
revoke all on function public.viewer_in_post_groups(uuid) from public, anon;
grant execute on function public.viewer_in_post_groups(uuid) to authenticated;

create or replace function public.viewer_in_story_groups(_story_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.story_audience_groups sg
    join public.audience_group_members m on m.group_id = sg.group_id
    where sg.story_id = _story_id and m.member_id = auth.uid()
  );
$fn$;
revoke all on function public.viewer_in_story_groups(uuid) from public, anon;
grant execute on function public.viewer_in_story_groups(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The posts SELECT policy — the single source of truth for who sees what.
--    (Comments, bookmarks etc. that check `exists posts` inherit this.)
-- ---------------------------------------------------------------------------
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
        or (visibility = 'groups'
            and public.is_accepted_follower_of(user_id)
            and public.viewer_in_post_groups(id))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Stories: audience-aware visibility.
-- ---------------------------------------------------------------------------
drop policy stories_select on public.stories;
create policy stories_select on public.stories
  for select to authenticated
  using (
    expires_at > now()
    and public.can_see_stories(auth.uid(), user_id)
    and (user_id = auth.uid()
         or audience = 'default'
         or public.viewer_in_story_groups(id))
  );

create or replace function public.get_stories_rail()
returns table(user_id uuid, handle text, display_name text, avatar_url text,
              has_story boolean, has_unviewed boolean, latest_at timestamptz, is_self boolean)
language sql
stable
security definer
set search_path = ''
as $fn$
  with owners as (
    select auth.uid() as uid
    union
    select f.followee_id from public.follows f
    where f.follower_id = auth.uid() and f.status = 'accepted'
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
      -- Group stories exist for members only; everyone else must see NOTHING
      -- (no ring, no count — the brief's "no indirect leak" rule).
      and (s.user_id = auth.uid() or s.audience = 'default'
           or public.viewer_in_story_groups(s.id))
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
  order by (p.id = auth.uid()) desc, coalesce(a.has_unviewed, false) desc,
           a.latest_at desc nulls last;
$fn$;

create or replace function public.get_user_stories(_user_id uuid)
returns table(id uuid, media_url text, thumbnail_url text, media_type text,
              overlay_text text, created_at timestamptz, expires_at timestamptz,
              viewed boolean, is_self boolean)
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.id, s.media_url, s.thumbnail_url, s.media_type, s.overlay_text,
         s.created_at, s.expires_at,
    (sv.viewer_id is not null) as viewed,
    (s.user_id = auth.uid()) as is_self
  from public.stories s
  left join public.story_views sv on sv.story_id = s.id and sv.viewer_id = auth.uid()
  where s.user_id = _user_id and s.expires_at > now()
    and public.can_see_stories(auth.uid(), s.user_id)
    and (s.user_id = auth.uid() or s.audience = 'default'
         or public.viewer_in_story_groups(s.id))
  order by s.created_at asc;
$fn$;

-- create_story learns the audience picker (old 5-arg signature replaced; old
-- clients still resolve via the defaults).
drop function if exists public.create_story(text, text, text, double precision, text);
create function public.create_story(
  _media_url text,
  _thumbnail_url text,
  _media_type text,
  _duration_seconds double precision default null,
  _overlay text default null,
  _audience text default 'default',
  _group_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare _me uuid := auth.uid(); _id uuid; _n integer;
begin
  if _me is null then raise exception 'unauthorized'; end if;
  if _media_type not in ('image', 'video') then raise exception 'bad_media_type'; end if;
  if _media_type = 'video' and coalesce(_duration_seconds, 0) > 15.5 then
    raise exception 'video_too_long';
  end if;
  if _audience not in ('default', 'groups') then raise exception 'bad_audience'; end if;
  if _audience = 'groups' then
    select count(*) into _n
    from public.audience_groups g
    where g.id = any(coalesce(_group_ids, array[]::uuid[])) and g.owner_id = _me;
    if _n = 0 or _n <> coalesce(array_length(_group_ids, 1), 0) then
      raise exception 'bad_groups';  -- empty, or a group that is not yours
    end if;
  end if;

  insert into public.stories (user_id, media_url, thumbnail_url, media_type, overlay_text, audience)
    values (_me, _media_url, _thumbnail_url, _media_type,
            nullif(btrim(coalesce(_overlay, '')), ''), _audience)
    returning id into _id;

  if _audience = 'groups' then
    insert into public.story_audience_groups (story_id, group_id)
    select _id, g from unnest(_group_ids) as g;
  end if;
  return _id;
end $fn$;
revoke all on function public.create_story(text, text, text, double precision, text, text, uuid[])
  from public, anon;
grant execute on function public.create_story(text, text, text, double precision, text, text, uuid[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Friends feed: members see group posts inline (no badge — they render
--    exactly like followers posts).
-- ---------------------------------------------------------------------------
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
      and (p.visibility in ('public', 'private')
           or (p.visibility = 'groups' and public.viewer_in_post_groups(p.id)))
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

-- ---------------------------------------------------------------------------
-- 8. Hearts on group posts (members may heart; still no points anywhere).
-- ---------------------------------------------------------------------------
create or replace function public.toggle_feed_like(_post_id uuid)
returns table (liked boolean, feed_like_count integer)
language plpgsql
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
        or (p.visibility in ('private', 'groups') and exists (
          select 1 from public.follows f
          where f.follower_id = _uid and f.followee_id = p.user_id and f.status = 'accepted'
        ) and (p.visibility = 'private' or public.viewer_in_post_groups(p.id)))
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

-- ---------------------------------------------------------------------------
-- 9. Comments on group posts: visible to viewers only (inherited via posts
--    RLS); allowed for viewers; NO POINTS (brief: group posts earn nothing).
-- ---------------------------------------------------------------------------
create or replace function public.add_comment(_post_id uuid, _body text, _parent_id uuid default null)
returns public.comments
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid    uuid := auth.uid();
  _clean  text := btrim(_body);
  _vis    text;
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

  -- The post must be visible to this user (mirrors the posts SELECT policy).
  select p.visibility into _vis
  from public.posts p
  where p.id = _post_id
    and p.moderation_status <> 'removed'
    and not public.is_blocked_with(p.user_id)
    and (
      p.user_id = _uid
      or (p.visibility = 'public' and p.moderation_status = 'approved')
      or (p.visibility = 'private' and public.is_accepted_follower_of(p.user_id))
      or (p.visibility = 'groups' and public.is_accepted_follower_of(p.user_id)
          and public.viewer_in_post_groups(p.id))
    );
  if _vis is null then
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

  -- Group posts never feed the points economy (brief 4A).
  if char_length(_clean) >= 2 and _vis <> 'groups' then
    perform public.award_points(
      case when _parent_id is null then 'comment' else 'comment_reply' end,
      'comment',
      _row.id
    );
  end if;

  return _row;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. record_swipe refuses group posts entirely: they are never dealt into
--     the deck, so a swipe on one can only be a forged API call angling for
--     points or affinity (re-emit of the Part 2 body + the one gate).
-- ---------------------------------------------------------------------------
create or replace function public.record_swipe(_post_id uuid, _direction text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
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

  -- Part 4A gate: group posts are not deck material, full stop.
  if exists (select 1 from public.posts p
             where p.id = _post_id and p.visibility = 'groups') then
    raise exception 'record_swipe: post not available';
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

-- ---------------------------------------------------------------------------
-- 11. Profile post count must not leak hidden group posts: count only what
--     the CALLER could open (self sees everything).
-- ---------------------------------------------------------------------------
create or replace function public.get_profile_overview(_handle text)
returns table(id uuid, handle text, display_name text, bio text, avatar_url text,
              is_private boolean, follower_count integer, following_count integer,
              post_count integer, is_self boolean, follow_status text,
              is_blocked boolean, is_muting boolean, locked boolean)
language sql
stable
security definer
set search_path = ''
as $fn$
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
    (select count(*)::int from public.posts po
     where po.user_id = p.id and po.moderation_status <> 'removed'
       and (p.id = auth.uid()
            or po.visibility in ('public', 'private')
            or (po.visibility = 'groups' and public.viewer_in_post_groups(po.id)))),
    (p.id = auth.uid()) as is_self,
    (select f.status from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id) as follow_status,
    public.is_blocked_with(p.id) as is_blocked,
    public.is_muting(p.id) as is_muting,
    (p.is_private and p.id <> auth.uid()
       and not exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id and f.status = 'accepted')) as locked
  from p;
$fn$;

-- ---------------------------------------------------------------------------
-- 12. Deleting a group: the owner chooses what happens to posts/stories that
--     targeted ONLY this group — 'followers' makes them followers-only,
--     'delete' removes them. Posts also in other groups just lose this one.
-- ---------------------------------------------------------------------------
create or replace function public.delete_audience_group(_group_id uuid, _mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _me uuid := auth.uid();
  _orphan_posts   uuid[];
  _orphan_stories uuid[];
begin
  if _mode not in ('followers', 'delete') then
    raise exception 'delete_audience_group: mode must be followers or delete';
  end if;
  if not exists (select 1 from public.audience_groups g
                 where g.id = _group_id and g.owner_id = _me) then
    raise exception 'delete_audience_group: not your group';
  end if;

  -- Posts/stories whose ONLY audience group is this one.
  select coalesce(array_agg(p.id), '{}') into _orphan_posts
  from public.posts p
  join public.post_audience_groups pg on pg.post_id = p.id and pg.group_id = _group_id
  where p.user_id = _me and p.visibility = 'groups'
    and not exists (select 1 from public.post_audience_groups pg2
                    where pg2.post_id = p.id and pg2.group_id <> _group_id);

  select coalesce(array_agg(s.id), '{}') into _orphan_stories
  from public.stories s
  join public.story_audience_groups sg on sg.story_id = s.id and sg.group_id = _group_id
  where s.user_id = _me and s.audience = 'groups'
    and not exists (select 1 from public.story_audience_groups sg2
                    where sg2.story_id = s.id and sg2.group_id <> _group_id);

  if _mode = 'followers' then
    update public.posts set visibility = 'private', updated_at = now()
    where id = any(_orphan_posts);
    update public.stories set audience = 'default'
    where id = any(_orphan_stories);
  else
    delete from public.posts   where id = any(_orphan_posts);
    delete from public.stories where id = any(_orphan_stories);
  end if;

  delete from public.audience_groups where id = _group_id;  -- cascades joins
end;
$fn$;
revoke all on function public.delete_audience_group(uuid, text) from public, anon;
grant execute on function public.delete_audience_group(uuid, text) to authenticated;
