-- Rollback for 20261125110000_deck_quality_explore.
-- Unschedules the creator-quality job, restores record_view_events,
-- _flag_bot_patterns and get_deck to their 20261124100000 (Part 1) versions
-- verbatim, then drops the Part 2 functions, tables and settings.

set search_path = public, extensions;

select cron.unschedule('creator-quality')
  where exists (select 1 from cron.job where jobname = 'creator-quality');

-- --- _flag_bot_patterns: Part 1 version (no post_quality decrement) ---------
create or replace function public._flag_bot_patterns(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _min_watch numeric := public.setting_numeric('bot_min_watch_ms', 400);
  _fast_len  integer := greatest(public.setting_numeric('bot_fast_run_len', 10)::integer, 2);
  _reg_len   integer := greatest(public.setting_numeric('bot_regular_run_len', 20)::integer, 3);
  _reg_cv    numeric := public.setting_numeric('bot_regular_cv', 0.12);
  _mono_len  integer := greatest(public.setting_numeric('bot_monotone_run_len', 50)::integer, 5);
  _penalty   numeric := public.setting_numeric('trust_flag_penalty', 1);
  _threshold numeric := public.setting_numeric('trust_review_threshold', 40);
  _fast_ids  uuid[] := '{}';
  _reg_ids   uuid[] := '{}';
  _mono_ids  uuid[] := '{}';
  _newly     integer := 0;
begin
  -- fast_run: the last _fast_len swiped events, every one under the minimum watch time.
  select coalesce(case when count(*) = _fast_len and bool_and(t.dwell_ms < _min_watch)
                       then array_agg(t.id) end, '{}')
  into _fast_ids
  from (
    select e.id, e.dwell_ms
    from public.post_view_events e
    where e.viewer_id = _user_id and e.direction <> 'none'
    order by e.shown_at desc
    limit _fast_len
  ) t;

  -- regular_timing: gaps between the last _reg_len swiped events are machine-regular
  -- (coefficient of variation below _reg_cv). Humans are never that even.
  select coalesce(case when count(*) = _reg_len - 1
                       and avg(g.gap) > 0
                       and coalesce(stddev_samp(g.gap) / nullif(avg(g.gap), 0), 1) < _reg_cv
                  then (
                    select array_agg(w.id) from (
                      select e2.id
                      from public.post_view_events e2
                      where e2.viewer_id = _user_id and e2.direction <> 'none'
                      order by e2.shown_at desc
                      limit _reg_len
                    ) w
                  ) end, '{}')
  into _reg_ids
  from (
    select extract(epoch from (w.shown_at - lag(w.shown_at) over (order by w.shown_at))) as gap
    from (
      select e.id, e.shown_at
      from public.post_view_events e
      where e.viewer_id = _user_id and e.direction <> 'none'
      order by e.shown_at desc
      limit _reg_len
    ) w
  ) g
  where g.gap is not null;

  -- monotone_run: the last _mono_len swipes were all the same direction.
  select coalesce(case when count(*) = _mono_len and min(t.direction) = max(t.direction)
                       then array_agg(t.id) end, '{}')
  into _mono_ids
  from (
    select e.id, e.direction
    from public.post_view_events e
    where e.viewer_id = _user_id and e.direction <> 'none'
    order by e.shown_at desc
    limit _mono_len
  ) t;

  if coalesce(array_length(_fast_ids, 1), 0) = 0
     and coalesce(array_length(_reg_ids, 1), 0) = 0
     and coalesce(array_length(_mono_ids, 1), 0) = 0 then
    return;
  end if;

  -- Flag (first time only — trust is charged once per event) and move the
  -- flagged like/skip totals out of the rankable counts.
  with flagged_now as (
    update public.post_view_events e
    set flagged = true,
        flag_reasons = (
          select array(
            select distinct r from unnest(
              array_remove(array[
                case when e.id = any(_fast_ids) then 'fast_run' end,
                case when e.id = any(_reg_ids)  then 'regular_timing' end,
                case when e.id = any(_mono_ids) then 'monotone_run' end
              ], null)
            ) r
          )
        )
    where e.viewer_id = _user_id
      and e.flagged = false
      and e.id = any(_fast_ids || _reg_ids || _mono_ids)
    returning e.post_id, e.direction
  ),
  bumped as (
    insert into public.post_bot_counts as pbc (post_id, bot_like_count, bot_skip_count, updated_at)
    select f.post_id,
           count(*) filter (where f.direction = 'right'),
           count(*) filter (where f.direction = 'left'),
           now()
    from flagged_now f
    group by f.post_id
    on conflict (post_id) do update
      set bot_like_count = pbc.bot_like_count + excluded.bot_like_count,
          bot_skip_count = pbc.bot_skip_count + excluded.bot_skip_count,
          updated_at = now()
    returning 1
  )
  select count(*) into _newly from flagged_now;

  if _newly > 0 then
    insert into public.user_trust as ut (user_id, score, flagged_count, last_flag_at)
    values (_user_id, greatest(0, 100 - _penalty * _newly), _newly, now())
    on conflict (user_id) do update
      set score = greatest(0, ut.score - _penalty * _newly),
          flagged_count = ut.flagged_count + _newly,
          last_flag_at = now(),
          updated_at = now();

    update public.user_trust ut
    set review_status = 'queued', updated_at = now()
    where ut.user_id = _user_id and ut.score < _threshold and ut.review_status = 'none';
  end if;
end;
$fn$;
revoke all on function public._flag_bot_patterns(uuid) from public, anon, authenticated;
grant execute on function public._flag_bot_patterns(uuid) to service_role;

-- --- record_view_events: Part 1 version (no post_quality increment) ---------
create or replace function public.record_view_events(_events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _n   integer := 0;
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
      -- Public, approved posts only; never the creator's own views (brief 1B).
      and po.visibility = 'public'
      and po.moderation_status = 'approved'
      and po.user_id <> _uid
    on conflict (id) do nothing
    returning 1
  )
  select count(*) into _n from inserted;

  perform public._flag_bot_patterns(_uid);
  return _n;
end;
$fn$;
revoke all on function public.record_view_events(jsonb) from public, anon;
grant execute on function public.record_view_events(jsonb) to authenticated;

-- --- get_deck: Part 1 version (bot-cleaned Laplace quality, soft explore) ---
create or replace function public.get_deck(_limit integer default 20, _exclude uuid[] default '{}')
returns table (
  id                  uuid,
  user_id             uuid,
  media_url           text,
  thumbnail_url       text,
  media_type          text,
  caption             text,
  alt_text            text,
  like_count          integer,
  skip_count          integer,
  comment_count       integer,
  created_at          timestamptz,
  poster_handle       text,
  poster_display_name text,
  poster_avatar_url   text,
  tags                text[],
  overlays            jsonb
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with base as (
    select p.id, p.user_id, p.media_url, p.thumbnail_url, p.media_type, p.caption,
           p.alt_text, p.like_count, p.skip_count, p.comment_count, p.created_at,
           p.overlays
    from public.posts p
    where p.visibility = 'public'
      and p.moderation_status = 'approved'
      and p.user_id <> auth.uid()
      and p.id <> all(_exclude)
      -- RESTORED: suspended/banned/frozen authors leave the public deck.
      and exists (
        select 1 from public.profiles pr
        where pr.id = p.user_id and pr.account_status = 'active'
      )
      and not exists (
        select 1 from public.swipes s where s.user_id = auth.uid() and s.post_id = p.id
      )
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
      )
      -- RESTORED: muted authors stay out of the viewer's deck.
      and not exists (
        select 1 from public.mutes m
        where m.muter_id = auth.uid() and m.muted_id = p.user_id
      )
  ),
  ranked as (
    select b.*,
      coalesce((
        select sum(ut.weight)
        from public.post_tags pt
        join public.user_tags ut on ut.tag_id = pt.tag_id and ut.user_id = auth.uid()
        where pt.post_id = b.id
      ), 0)::double precision as affinity,
      exp(-extract(epoch from (now() - b.created_at)) / (72.0 * 3600.0)) as freshness,
      ln(2 + coalesce(pr.points_balance, 0)) as points_boost,
      -- Laplace-smoothed like-rate on BOT-CLEANED counts: flagged engagement
      -- neither lifts nor sinks a post's ranking quality (Part 1C).
      (greatest(b.like_count - coalesce(bc.bot_like_count, 0), 0) + 1.0)
        / (greatest(b.like_count - coalesce(bc.bot_like_count, 0), 0)
           + greatest(b.skip_count - coalesce(bc.bot_skip_count, 0), 0) + 2.0) as quality,
      case
        when now() - pr.created_at < interval '14 days'
        then 2.0 * (1.0 - extract(epoch from (now() - pr.created_at)) / (14.0 * 86400.0))
        else 0.0
      end as newcomer_boost
    from base b
    join public.profiles pr on pr.id = b.user_id
    left join public.post_bot_counts bc on bc.post_id = b.id
  ),
  ranked2 as (
    select r.*,
      (r.affinity * 3.0
        + r.freshness * 2.0
        + r.quality * 2.0
        + r.points_boost * 0.5
        + r.newcomer_boost) as score
    from ranked r
  ),
  capped as (
    select r2.*, row_number() over (partition by r2.user_id order by r2.score desc) as creator_rn
    from ranked2 r2
  ),
  diverse as (
    select * from capped where creator_rn <= 2
  ),
  matched as (
    select * from diverse where affinity > 0
    order by score desc
    limit ceil(_limit * 0.9)
  ),
  explore as (
    select * from diverse
    where affinity = 0 and id not in (select id from matched)
    order by (freshness * 2.0 + quality * 2.0 + points_boost * 0.5 + newcomer_boost) desc, random()
    limit greatest(_limit - (select count(*) from matched), 0)
  ),
  combined as (
    select * from matched
    union all
    select * from explore
  )
  select
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at,
    pr.handle, pr.display_name, pr.avatar_url,
    coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags,
    c.overlays
  from combined c
  join public.profiles pr on pr.id = c.user_id
  left join public.post_tags pt on pt.post_id = c.id
  left join public.tags t on t.id = pt.tag_id
  group by
    c.id, c.user_id, c.media_url, c.thumbnail_url, c.media_type, c.caption,
    c.alt_text, c.like_count, c.skip_count, c.comment_count, c.created_at, c.score,
    c.overlays, pr.handle, pr.display_name, pr.avatar_url
  order by c.score desc
  limit _limit;
$fn$;

revoke all on function public.get_deck(integer, uuid[]) from public, anon;
grant execute on function public.get_deck(integer, uuid[]) to authenticated;

-- --- Part 2 objects --------------------------------------------------------
drop function if exists public.my_ad_frequency();
drop function if exists public.refresh_creator_quality();
drop table if exists public.post_quality;
drop table if exists public.creator_quality;

delete from public.platform_settings
where key in ('creator_fast_skip_threshold', 'creator_penalty_scale');
