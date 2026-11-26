-- ============================================================================
-- 20261126600000_behaviour_affinity
--
-- Interests are invisible to users; the feed learns only from behaviour.
-- Swipes already move user_tags (record_swipe). This adds the other two
-- signals, approved by Saj 2026-11-26:
--
--   FOLLOW  When a follow becomes ACCEPTED (straight away for an open
--           profile, or when a request is approved) the follower's weight for
--           the followee's top tags rises by affinity_follow_delta. "Top tags"
--           = the followee's most frequent tags across their last
--           affinity_follow_recent_posts approved public/private posts, at
--           least affinity_follow_min_posts posts each, at most
--           affinity_follow_tag_count tags. One-off at follow time (not
--           re-applied as they keep posting). Exactly what was added is kept
--           in follow_affinity_grants, so an unfollow (or a block, which
--           deletes the follow) subtracts exactly that, even if the creator
--           has since changed what they post. Existing accepted follows are
--           backfilled once at the end of this migration.
--
--   WATCH   record_view_events (body from 20261125330000_ads_serving, re-
--           emitted unchanged apart from the affinity block) gives a post's
--           tags a nudge smaller than a like, at most once per viewer per
--           post (watch_affinity_grants):
--             * video watched to the end  -> +affinity_watch_complete_delta
--             * otherwise on screen >= affinity_long_dwell_ms and
--               <= affinity_long_dwell_max_ms -> +affinity_long_dwell_delta
--               (longer than the max is a card left open, not attention)
--             * swiped left -> no watch bonus (the -0.15 skip stands alone);
--               a left swipe under quick_skip_ms additionally loses
--               affinity_fast_skip_delta, which ships as 0 (off) so it can be
--               turned on later without a release.
--           Like + watch stack: a fully watched, liked video = +0.15.
--
-- Both blocks are best-effort subtransactions, like the swipe affinity
-- block: an affinity error can never fail a follow or a view batch. Bot-
-- flagged viewers are treated like their swipes: their OWN feed moves, no
-- one else's.
-- ============================================================================

set search_path = public, extensions;

insert into public.platform_settings (key, value, description, client_visible) values
  ('affinity_follow_delta',         '0.2'::jsonb,    'Weight added to each of a followee''s top tags when a follow is accepted (reversed exactly on unfollow).', false),
  ('affinity_follow_tag_count',     '3'::jsonb,      'How many of the followee''s top tags a follow nudges.', false),
  ('affinity_follow_recent_posts',  '30'::jsonb,     'How many of the followee''s most recent posts are scanned for their top tags.', false),
  ('affinity_follow_min_posts',     '2'::jsonb,      'A tag must appear on at least this many of those posts to count (ignores one-off tags).', false),
  ('affinity_watch_complete_delta', '0.05'::jsonb,   'Weight added to a post''s tags when the viewer watches the video to the end (once per post; not on a left swipe).', false),
  ('affinity_long_dwell_delta',     '0.03'::jsonb,   'Weight added to a post''s tags after a long look at it (once per post; not on a left swipe).', false),
  ('affinity_long_dwell_ms',        '10000'::jsonb,  'On-screen time (ms) that counts as a long look.', false),
  ('affinity_long_dwell_max_ms',    '300000'::jsonb, 'On-screen time (ms) above which a view is treated as a card left open and earns no watch nudge.', false),
  ('affinity_fast_skip_delta',      '0'::jsonb,      'Extra weight removed from a post''s tags on a left swipe under quick_skip_ms (0 = off; the swipe''s own skip delta still applies).', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Ledgers (server-only: RLS on, no policies, no client grants).
-- ---------------------------------------------------------------------------
-- No FK to follows on purpose: an ON DELETE CASCADE from follows would fire
-- before the AFTER DELETE trigger below and erase what it needs to reverse.
create table if not exists public.follow_affinity_grants (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  tag_id      uuid not null references public.tags (id) on delete cascade,
  applied     real not null,              -- weight actually added (after the ceiling)
  created_row boolean not null,           -- true when the follow created the user_tags row
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id, tag_id)
);
comment on table public.follow_affinity_grants is
  'What each accepted follow added to the follower''s user_tags, so unfollow reverses it exactly. Server-only.';

create table if not exists public.watch_affinity_grants (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  kind       text not null check (kind in ('complete', 'long_dwell', 'fast_skip')),
  delta      real not null,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
comment on table public.watch_affinity_grants is
  'One watch-time interest nudge per viewer per post (record_view_events). Server-only.';

alter table public.follow_affinity_grants enable row level security;
alter table public.watch_affinity_grants  enable row level security;
revoke all on public.follow_affinity_grants from public, anon, authenticated;
revoke all on public.watch_affinity_grants  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Follow: apply / revert helpers + trigger.
-- ---------------------------------------------------------------------------
create or replace function public._apply_follow_affinity(_follower uuid, _followee uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _delta numeric := public.setting_numeric('affinity_follow_delta', 0.2);
  _max   numeric := public.setting_numeric('affinity_weight_max', 5);
  _n     integer := 0;
  _t     record;
  _old   real;
  _new   real;
begin
  if _delta <= 0 then
    return 0;
  end if;
  -- Already granted for this pair (e.g. a re-run backfill): never double up.
  if exists (select 1 from public.follow_affinity_grants g
             where g.follower_id = _follower and g.followee_id = _followee) then
    return 0;
  end if;

  for _t in
    select pt.tag_id
    from (
      select p.id
      from public.posts p
      where p.user_id = _followee
        and p.visibility in ('public', 'private')
        and p.moderation_status = 'approved'
      order by p.created_at desc
      limit greatest(public.setting_numeric('affinity_follow_recent_posts', 30)::integer, 1)
    ) rp
    join public.post_tags pt on pt.post_id = rp.id
    group by pt.tag_id
    having count(*) >= public.setting_numeric('affinity_follow_min_posts', 2)
    order by count(*) desc, pt.tag_id
    limit greatest(public.setting_numeric('affinity_follow_tag_count', 3)::integer, 0)
  loop
    select ut.weight into _old
    from public.user_tags ut
    where ut.user_id = _follower and ut.tag_id = _t.tag_id
    for update;

    if found then
      _new := least(_old + _delta, _max);
      update public.user_tags set weight = _new
      where user_id = _follower and tag_id = _t.tag_id;
      insert into public.follow_affinity_grants (follower_id, followee_id, tag_id, applied, created_row)
      values (_follower, _followee, _t.tag_id, greatest(_new - _old, 0), false);
    else
      _new := least(_delta, _max);
      insert into public.user_tags (user_id, tag_id, weight)
      values (_follower, _t.tag_id, _new);
      insert into public.follow_affinity_grants (follower_id, followee_id, tag_id, applied, created_row)
      values (_follower, _followee, _t.tag_id, _new, true);
    end if;
    _n := _n + 1;
  end loop;
  return _n;
end;
$fn$;

create or replace function public._revert_follow_affinity(_follower uuid, _followee uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _min numeric := public.setting_numeric('affinity_weight_min', -2);
  _n   integer := 0;
  _g   record;
begin
  for _g in
    delete from public.follow_affinity_grants g
    where g.follower_id = _follower and g.followee_id = _followee
    returning g.tag_id, g.applied, g.created_row
  loop
    update public.user_tags ut
    set weight = greatest(ut.weight - _g.applied, _min)
    where ut.user_id = _follower and ut.tag_id = _g.tag_id;

    -- A row the follow created and nothing else has moved since: remove it
    -- rather than leave a zero-weight interest behind.
    if _g.created_row then
      delete from public.user_tags ut
      where ut.user_id = _follower and ut.tag_id = _g.tag_id
        and abs(ut.weight) < 1e-6
        and not ut.is_followed;
    end if;
    _n := _n + 1;
  end loop;
  return _n;
end;
$fn$;

revoke all on function public._apply_follow_affinity(uuid, uuid)  from public, anon, authenticated;
revoke all on function public._revert_follow_affinity(uuid, uuid) from public, anon, authenticated;

create or replace function public.tg_follow_affinity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  begin
    if tg_op = 'INSERT' then
      if new.status = 'accepted' then
        perform public._apply_follow_affinity(new.follower_id, new.followee_id);
      end if;
    elsif tg_op = 'UPDATE' then
      if new.status = 'accepted' and old.status is distinct from 'accepted' then
        perform public._apply_follow_affinity(new.follower_id, new.followee_id);
      elsif old.status = 'accepted' and new.status is distinct from 'accepted' then
        perform public._revert_follow_affinity(old.follower_id, old.followee_id);
      end if;
    elsif tg_op = 'DELETE' then
      perform public._revert_follow_affinity(old.follower_id, old.followee_id);
    end if;
  exception when others then
    null; -- affinity is a nudge, never a failure
  end;
  return null;
end;
$fn$;
revoke all on function public.tg_follow_affinity() from public, anon, authenticated;

drop trigger if exists follow_affinity on public.follows;
create trigger follow_affinity
  after insert or update of status or delete on public.follows
  for each row execute function public.tg_follow_affinity();

-- ---------------------------------------------------------------------------
-- 3. record_view_events v5 = ads_serving body + watch affinity block.
-- ---------------------------------------------------------------------------
create or replace function public.record_view_events(_events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid   uuid := auth.uid();
  _quick numeric := public.setting_numeric('quick_skip_ms', 2000);
  _n     integer := 0;
  _seen  jsonb := '[]'::jsonb;  -- per inserted event: post_id, dwell_ms, direction, video_completed
begin
  if _uid is null then
    raise exception 'record_view_events: not authenticated';
  end if;
  if _events is null or jsonb_typeof(_events) <> 'array' then
    raise exception 'record_view_events: expected a json array of events';
  end if;
  if jsonb_array_length(_events) > 200 then
    raise exception 'record_view_events: batch too large (max 200)';
  end if;

  with parsed as (
    select
      (e ->> 'id')::uuid                                   as id,
      (e ->> 'post_id')::uuid                              as post_id,
      coalesce((e ->> 'shown_at')::timestamptz, now())     as shown_at,
      least(greatest(coalesce((e ->> 'dwell_ms')::integer, 0), 0), 3600000) as dwell_ms,
      e ->> 'direction'                                    as direction,
      case when (e ->> 'video_position_ms') is not null
           then greatest((e ->> 'video_position_ms')::integer, 0) end as video_position_ms,
      (e ->> 'video_completed')::boolean                   as video_completed
    from jsonb_array_elements(_events) e
  ),
  inserted as (
    insert into public.post_view_events
      (id, viewer_id, post_id, shown_at, dwell_ms, direction, video_position_ms, video_completed)
    select p.id, _uid, p.post_id, p.shown_at, p.dwell_ms, p.direction,
           p.video_position_ms, p.video_completed
    from parsed p
    join public.posts po on po.id = p.post_id
    where p.id is not null
      and p.direction in ('left', 'right', 'none')
      and po.visibility in ('public', 'ad')   -- ads are tracked like posts (8C/8E)
      and po.moderation_status = 'approved'
      and po.user_id <> _uid
    on conflict (id) do nothing
    returning post_id, shown_at, dwell_ms, direction, video_position_ms, video_completed
  ),
  bumped as (
    insert into public.post_quality as pq
      (post_id, views, likes, skips, fast_skips, video_views, completions, watch_ms, updated_at)
    select
      i.post_id,
      count(*),
      count(*) filter (where i.direction = 'right'),
      count(*) filter (where i.direction = 'left'),
      count(*) filter (where i.direction = 'left' and i.dwell_ms < _quick),
      count(*) filter (where i.video_position_ms is not null or i.video_completed is not null),
      count(*) filter (where i.video_completed),
      coalesce(sum(i.dwell_ms), 0),
      now()
    from inserted i
    group by i.post_id
    on conflict (post_id) do update set
      views       = pq.views       + excluded.views,
      likes       = pq.likes       + excluded.likes,
      skips       = pq.skips       + excluded.skips,
      fast_skips  = pq.fast_skips  + excluded.fast_skips,
      video_views = pq.video_views + excluded.video_views,
      completions = pq.completions + excluded.completions,
      watch_ms    = pq.watch_ms    + excluded.watch_ms,
      updated_at  = now()
    returning 1
  ),
  ad_bump as (
    -- Frequency-cap bookkeeping (8C): count real views per ad per viewer per
    -- UK day. Internal only; never exposed to any client.
    insert into public.ad_impressions as ai (ad_id, user_id, day, views)
    select a.id, _uid, (i.shown_at at time zone 'Europe/London')::date, count(*)
    from inserted i
    join public.ads a on a.post_id = i.post_id
    group by a.id, (i.shown_at at time zone 'Europe/London')::date
    on conflict (ad_id, user_id, day) do update
      set views = ai.views + excluded.views
    returning 1
  ),
  boost_bump as (
    update public.boosts bo
       set served_impressions = bo.served_impressions + bi.n
      from (
        select b2.id as boost_id, count(*)::integer as n
        from inserted i
        join public.boosts b2 on b2.post_id = i.post_id
        where b2.status = 'active'
          and i.shown_at >= b2.starts_at and i.shown_at < b2.ends_at
        group by b2.id
      ) bi
     where bo.id = bi.boost_id
     returning 1
  )
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
           'post_id', i.post_id, 'dwell_ms', i.dwell_ms,
           'direction', i.direction, 'video_completed', coalesce(i.video_completed, false))), '[]'::jsonb)
    into _n, _seen
  from inserted i;

  -- Watch-time affinity — best-effort, never blocks the batch. At most one
  -- nudge per viewer per post (watch_affinity_grants), sized by the
  -- strongest signal among this batch's events for that post. Ads are
  -- excluded: an ad view says nothing about the viewer's interests.
  if _n > 0 then
    begin
      with ev as (
        select (x ->> 'post_id')::uuid            as post_id,
               (x ->> 'dwell_ms')::integer        as dwell_ms,
               x ->> 'direction'                  as direction,
               (x ->> 'video_completed')::boolean as completed
        from jsonb_array_elements(_seen) x
      ),
      per_post as (
        select ev.post_id,
               bool_or(ev.direction = 'left')                         as any_left,
               bool_or(ev.direction = 'left' and ev.dwell_ms < _quick) as fast_left,
               bool_or(ev.completed)                                  as completed,
               bool_or(ev.dwell_ms >= public.setting_numeric('affinity_long_dwell_ms', 10000)
                       and ev.dwell_ms <= public.setting_numeric('affinity_long_dwell_max_ms', 300000)) as long_look
        from ev
        join public.posts po on po.id = ev.post_id and po.visibility <> 'ad'
        group by ev.post_id
      ),
      nudge as (
        select pp.post_id,
               case
                 when pp.any_left and pp.fast_left then 'fast_skip'
                 when pp.any_left then null
                 when pp.completed then 'complete'
                 when pp.long_look then 'long_dwell'
               end as kind
        from per_post pp
      ),
      sized as (
        select n.post_id, n.kind,
               case n.kind
                 when 'complete'   then  public.setting_numeric('affinity_watch_complete_delta', 0.05)
                 when 'long_dwell' then  public.setting_numeric('affinity_long_dwell_delta', 0.03)
                 when 'fast_skip'  then -public.setting_numeric('affinity_fast_skip_delta', 0)
               end as delta
        from nudge n
        where n.kind is not null
      ),
      granted as (
        insert into public.watch_affinity_grants (user_id, post_id, kind, delta)
        select _uid, s.post_id, s.kind, s.delta
        from sized s
        where s.delta <> 0
        on conflict (user_id, post_id) do nothing
        returning post_id, delta
      ),
      tag_moves as (
        select pt.tag_id, sum(g.delta)::numeric as d
        from granted g
        join public.post_tags pt on pt.post_id = g.post_id
        group by pt.tag_id
      )
      insert into public.user_tags as ut (user_id, tag_id, weight)
      select _uid, tm.tag_id,
             least(greatest(tm.d,
               public.setting_numeric('affinity_weight_min', -2)),
               public.setting_numeric('affinity_weight_max', 5))
      from tag_moves tm
      on conflict (user_id, tag_id) do update
        set weight = least(greatest(ut.weight + excluded.weight,
              public.setting_numeric('affinity_weight_min', -2)),
              public.setting_numeric('affinity_weight_max', 5));
    exception when others then
      null; -- affinity is a nudge, never a failure
    end;
  end if;

  perform public._flag_bot_patterns(_uid);
  return _n;
end;
$fn$;
revoke all on function public.record_view_events(jsonb) from public, anon;
grant execute on function public.record_view_events(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. One-off backfill for follows that were accepted before this migration.
-- ---------------------------------------------------------------------------
do $$
declare
  _f record;
begin
  for _f in select follower_id, followee_id from public.follows where status = 'accepted' loop
    perform public._apply_follow_affinity(_f.follower_id, _f.followee_id);
  end loop;
end $$;
